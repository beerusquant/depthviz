import { fetchJson, reconnectingWs, BookSide } from '../util.js';

const TAIL_MAX_GAP_MS = 30_000;   // longer outage => distrust the deep tail

/**
 * The Binance snapshot+diff book, shared by every venue that speaks that
 * dialect. Aster is a Binance-futures API clone down to the `U`/`u`/`pu`
 * sequence fields, so it runs this engine rather than a second copy of it.
 *
 * cfg: { rest, depth(symbol) -> path, ws, stream(symbol) -> path,
 *        style: 'spot' | 'futures', label }
 *
 * The two dialects differ in exactly two places, both about sequencing:
 *   spot     — events chain by `U === lastUpdateId + 1`, and the first event
 *              after a snapshot must satisfy `U <= uid + 1 <= u`.
 *   futures  — events chain by `pu === lastUpdateId`, and the first event
 *              after a snapshot must satisfy `U <= uid <= u`.
 */
export function openDiffBook(cfg, s, emit, status) {
  const bids = new BookSide(true);
  const asks = new BookSide(false);
  let lastUpdateId = null;   // null => not synced yet
  let buffer = [];
  let syncing = false;
  let closed = false;
  let lastGoodAt = 0;        // last diff successfully applied
  let tailSince = 0;         // when the deep tail last started from nothing

  const applyEvt = (e) => {
    const now = Date.now();
    for (const r of e.b || []) bids.set(r[0], r[1], now);
    for (const r of e.a || []) asks.set(r[0], r[1], now);
    lastUpdateId = e.u;
    lastGoodAt = now;
  };

  const publish = (ts) => emit({
    bids: bids.toArray(), asks: asks.toArray(), ts, source: 'ws',
    // The book reaches far past the capped snapshot only because diffs for
    // every price level are applied on top of it, so depth outside the
    // snapshot's span is a lower bound that grows with uptime.
    accum: { since: tailSince },
  });

  // Fetch a REST snapshot, then replay buffered diffs on top of it.
  const resync = async () => {
    if (syncing || closed) return;
    syncing = true;
    lastUpdateId = null;
    try {
      const snap = await fetchJson(cfg.rest + cfg.depth(s));
      if (closed) return;
      // Keep the accumulated deep tail across a resync, but only if the gap
      // was short: over TAIL_MAX_GAP_MS, levels out there may have been
      // cancelled unseen and would show as phantom depth.
      const keepTail = lastGoodAt > 0 && Date.now() - lastGoodAt < TAIL_MAX_GAP_MS;
      const kept = bids.applySnapshot(snap.bids, { keepTail })
                 + asks.applySnapshot(snap.asks, { keepTail });
      if (!keepTail || !tailSince) tailSince = Date.now();
      if (keepTail && kept === 0) tailSince = Date.now();
      const uid = snap.lastUpdateId;
      // Drop stale events, then validate the first one bridges the snapshot.
      const pending = buffer.filter((e) => e.u > uid);
      buffer = [];
      lastUpdateId = uid;
      let first = true;
      for (const e of pending) {
        if (first) {
          const ok = cfg.style === 'spot'
            ? e.U <= uid + 1 && e.u >= uid + 1
            : e.U <= uid && e.u >= uid;
          if (!ok) { syncing = false; setTimeout(resync, 400); return; }
          first = false;
        }
        applyEvt(e);
      }
      status('open');
      publish(Date.now());
    } catch (err) {
      status('error', `${cfg.label} snapshot: ${err.message}`);
      if (!closed) setTimeout(() => { syncing = false; resync(); }, 1500);
      return;
    }
    syncing = false;
  };

  const conn = reconnectingWs(cfg.ws + cfg.stream(s), {
    onOpen: () => { buffer = []; lastUpdateId = null; syncing = false; resync(); },
    onMessage: (raw) => {
      const e = JSON.parse(raw.toString());
      if (!e.u) return;
      if (lastUpdateId === null) { buffer.push(e); if (buffer.length > 3000) buffer.shift(); return; }
      const contiguous = cfg.style === 'spot' ? e.U === lastUpdateId + 1 : e.pu === lastUpdateId;
      if (!contiguous) {
        if (e.u <= lastUpdateId) return; // already applied
        status('reconnecting', `${cfg.label} diff gap, resyncing`);
        buffer = [e];
        resync();
        return;
      }
      applyEvt(e);
      publish(e.E);
    },
    onStatus: (st, detail) => { if (st !== 'open') status(st, detail); },
  });

  return {
    close() { closed = true; conn.close(); },
  };
}
