import { reconnectingWs, BookSide, coalesce, PUBLISH_MS } from '../util.js';

const TAIL_MAX_GAP_MS = 30_000;   // longer outage => distrust the deep tail

/**
 * The snapshot + versioned-diff order book, shared by every venue that speaks
 * that dialect: Binance spot and perp, Aster, and both MEXC markets. Five of
 * the thirteen feeds run this one implementation.
 *
 * They differ only in details a config can carry:
 *
 *   ws, subscribe, pingMs, pingPayload   how to open the stream
 *   connect                              transport factory, for tests only
 *   decode(raw)                          bytes -> { bids, asks, from, to, prev?, ts? }
 *   snapshot()                           -> { bids, asks, version, ts? }
 *   style                                how events chain (see below)
 *   label                                what to call the venue in a status line
 *
 * Sizes are whatever the decode/snapshot pair produces, so a venue quoting in
 * contracts converts there and the engine never has to know about it.
 *
 * The two chaining styles are the only real divergence:
 *   'from' — an event follows when `from === version + 1`, and the first event
 *            after a snapshot must satisfy `from <= v+1 <= to`. Binance spot,
 *            both MEXC markets.
 *   'prev' — the event names its own predecessor: `prev === version`, and the
 *            first one after a snapshot satisfies `from <= v <= to`. Binance
 *            futures and Aster, which is a Binance-futures API clone.
 */
export function openDiffBook(cfg, emit, status) {
  const bids = new BookSide(true);
  const asks = new BookSide(false);
  let version = null;        // null => not synced yet
  let anchored = false;      // has the first event after the snapshot been accepted?
  let buffer = [];
  let syncing = false;
  let closed = false;
  let lastGoodAt = 0;        // last diff successfully applied
  let tailSince = 0;         // when the deep tail last started from nothing

  // Does this event straddle the snapshot version, i.e. is it the one that
  // resumes the chain? A REST snapshot is a point in the stream, not an event
  // boundary, so the version it reports can land inside an event's range or in
  // the gap between two of them; the venue's own rule is a range test, not an
  // equality.
  const anchors = (e, v) => (cfg.style === 'prev'
    ? e.from <= v && e.to >= v
    : e.from <= v + 1 && e.to >= v + 1);

  const applyEvt = (e) => {
    const now = Date.now();
    for (const [p, q] of e.bids) bids.set(p, q, now);
    for (const [p, q] of e.asks) asks.set(p, q, now);
    version = e.to;
    anchored = true;
    lastGoodAt = now;
  };

  // Coalesced: every diff is applied the instant it lands, but the book is only
  // sorted, bucketed and serialised at the rate anyone can actually consume it.
  const publish = coalesce((ts) => emit({
    bids: bids.toArray(), asks: asks.toArray(), ts, source: 'ws',
    // The book reaches past a capped snapshot only because diffs for every
    // price level are applied on top of it, so depth outside the snapshot's
    // span is a lower bound that grows with uptime.
    accum: { since: tailSince },
  }), PUBLISH_MS);

  // Fetch a snapshot, then replay the diffs buffered while it was in flight.
  const resync = async () => {
    if (syncing || closed) return;
    syncing = true;
    version = null;
    try {
      const snap = await cfg.snapshot();
      if (closed) return;
      // Keep the accumulated deep tail across a resync, but only if the gap was
      // short: over TAIL_MAX_GAP_MS, levels out there may have been cancelled
      // unseen and would stand as phantom depth.
      const keepTail = lastGoodAt > 0 && Date.now() - lastGoodAt < TAIL_MAX_GAP_MS;
      const kept = bids.applySnapshot(snap.bids, { keepTail })
                 + asks.applySnapshot(snap.asks, { keepTail });
      if (!keepTail || !kept || !tailSince) tailSince = Date.now();
      const v = snap.version;
      // An event already entirely behind the snapshot is spent. On 'prev'
      // venues the anchoring event may end exactly ON the snapshot version, so
      // it is `>= v` there and `> v` where the chain is one-past ('from').
      const pending = buffer.filter((e) => (cfg.style === 'prev' ? e.to >= v : e.to > v));
      buffer = [];
      version = v;
      anchored = false;
      for (const e of pending) {
        if (!anchored && !anchors(e, v)) continue; // still short of the anchor
        applyEvt(e);
      }
      status('open');
      // A REST snapshot carries no event time on these venues: null, not now().
      publish(snap.ts ?? null);
    } catch (err) {
      status('error', `${cfg.label} snapshot: ${err.message}`);
      if (!closed) setTimeout(() => { syncing = false; resync(); }, 1500);
      return;
    }
    syncing = false;
  };

  // The one seam in this file: tests drive the sequencing engine through a fake
  // transport instead of a socket. Everything that decides whether a book is
  // correct — the anchor, the gap detection, the resync — is then deterministic
  // and needs no network. Nothing else may be injected here.
  const open = cfg.connect || reconnectingWs;
  const conn = open(cfg.ws, {
    onOpen: (send) => {
      buffer = []; version = null; syncing = false;
      cfg.subscribe?.(send);
      resync();
    },
    onMessage: (raw) => {
      const e = cfg.decode(raw);
      if (!e || !isFinite(e.to)) return;
      if (version === null) { buffer.push(e); if (buffer.length > 3000) buffer.shift(); return; }
      const contiguous = cfg.style === 'prev' ? e.prev === version : e.from === version + 1;
      if (!contiguous) {
        if (e.to <= version) return; // already applied
        // Not yet chained to the snapshot: this may simply be the event that
        // straddles it. The buffer only ever holds what arrived WHILE the
        // snapshot was in flight, so on a venue whose update ids are not
        // contiguous the anchoring event routinely arrives after it — and
        // checking the anchor only against the buffer left the book pinned to
        // the snapshot forever, resyncing several times a second. Measured on
        // Binance perp: reach ±0.18% instead of ±3%, no venue clock, and a REST
        // depth call (weight 20) every ~400 ms for as long as the feed was up.
        if (!anchored && anchors(e, version)) { applyEvt(e); publish(e.ts ?? null); return; }
        // Past the anchor without ever hitting it: updates were genuinely
        // missed, which is the case a resync is for.
        status('reconnecting', `${cfg.label} diff gap, resyncing`);
        buffer = [e];
        resync();
        return;
      }
      applyEvt(e);
      publish(e.ts ?? null);
    },
    onStatus: (st, detail) => { if (st !== 'open') status(st, detail); },
    // Every venue here answers an RFC6455 ping with a pong (verified against
    // all six hosts), so a socket can be proven alive even on a book too quiet
    // to send a frame — which is what lets the idle watchdog fire only on a
    // path that is genuinely dead.
  }, { pingMs: cfg.pingMs ?? 20_000, pingPayload: cfg.pingPayload });

  return {
    close() { closed = true; publish.cancel(); conn.close(); },
  };
}
