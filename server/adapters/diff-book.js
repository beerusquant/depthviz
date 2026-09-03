import { reconnectingWs, BookSide } from '../util.js';

const TAIL_MAX_GAP_MS = 30_000;   // longer outage => distrust the deep tail

/**
 * The snapshot + versioned-diff order book, shared by every venue that speaks
 * that dialect: Binance spot and perp, Aster, and both MEXC markets. Five of
 * the thirteen feeds run this one implementation.
 *
 * They differ only in details a config can carry:
 *
 *   ws, subscribe, pingMs, pingPayload   how to open the stream
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
  let buffer = [];
  let syncing = false;
  let closed = false;
  let lastGoodAt = 0;        // last diff successfully applied
  let tailSince = 0;         // when the deep tail last started from nothing

  const applyEvt = (e) => {
    const now = Date.now();
    for (const [p, q] of e.bids) bids.set(p, q, now);
    for (const [p, q] of e.asks) asks.set(p, q, now);
    version = e.to;
    lastGoodAt = now;
  };

  const publish = (ts) => emit({
    bids: bids.toArray(), asks: asks.toArray(), ts, source: 'ws',
    // The book reaches past a capped snapshot only because diffs for every
    // price level are applied on top of it, so depth outside the snapshot's
    // span is a lower bound that grows with uptime.
    accum: { since: tailSince },
  });

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
      const pending = buffer.filter((e) => e.to > v);
      buffer = [];
      version = v;
      let first = true;
      for (const e of pending) {
        if (first) {
          const ok = cfg.style === 'prev'
            ? e.from <= v && e.to >= v
            : e.from <= v + 1 && e.to >= v + 1;
          if (!ok) { syncing = false; setTimeout(resync, 400); return; }
          first = false;
        }
        applyEvt(e);
      }
      status('open');
      publish(snap.ts || Date.now());
    } catch (err) {
      status('error', `${cfg.label} snapshot: ${err.message}`);
      if (!closed) setTimeout(() => { syncing = false; resync(); }, 1500);
      return;
    }
    syncing = false;
  };

  const conn = reconnectingWs(cfg.ws, {
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
        status('reconnecting', `${cfg.label} diff gap, resyncing`);
        buffer = [e];
        resync();
        return;
      }
      applyEvt(e);
      publish(e.ts || Date.now());
    },
    onStatus: (st, detail) => { if (st !== 'open') status(st, detail); },
  }, { pingMs: cfg.pingMs, pingPayload: cfg.pingPayload });

  return {
    close() { closed = true; conn.close(); },
  };
}
