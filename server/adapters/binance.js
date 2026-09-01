import { fetchJson, ttlCache, reconnectingWs, BookSide } from '../util.js';

const TAIL_MAX_GAP_MS = 30_000;   // longer outage => distrust the deep tail

const CFG = {
  spot: {
    rest: 'https://api.binance.com',
    info: '/api/v3/exchangeInfo',
    depth: (s) => `/api/v3/depth?symbol=${s}&limit=5000`,
    ticker: '/api/v3/ticker/24hr',
    ws: 'wss://stream.binance.com:9443/ws',
  },
  perp: {
    rest: 'https://fapi.binance.com',
    info: '/fapi/v1/exchangeInfo',
    depth: (s) => `/fapi/v1/depth?symbol=${s}&limit=1000`,
    ticker: '/fapi/v1/ticker/24hr',
    ws: 'wss://fstream.binance.com/ws',
  },
};

const info = ttlCache(async (market) => {
  const c = CFG[market];
  const j = await fetchJson(c.rest + c.info);
  return j.symbols.filter((x) =>
    x.status === 'TRADING' && (market === 'spot' || x.contractType === 'PERPETUAL'));
}, 5 * 60_000);

const tickers = ttlCache(async (market) => {
  const c = CFG[market];
  const rows = await fetchJson(c.rest + c.ticker);
  const m = new Map();
  for (const t of rows) m.set(t.symbol, +t.quoteVolume);
  return m;
}, 45_000);

export default {
  id: 'binance',
  name: 'Binance',
  markets: ['spot', 'perp'],
  transport: { spot: 'ws', perp: 'ws' },

  async listSymbols(market) {
    const rows = await info(market);
    return rows.map((x) => ({
      s: x.symbol,
      d: `${x.baseAsset}/${x.quoteAsset}`,
      base: x.baseAsset,
      quote: x.quoteAsset,
    })).sort((a, b) => a.d.localeCompare(b.d));
  },

  async vol24h(market, s) {
    return (await tickers(market)).get(s) ?? null;
  },

  open(market, s, opts, emit, status) {
    const c = CFG[market];
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
      // The book reaches far past the 5000-level snapshot only because diffs
      // for every price level are applied on top of it, so depth outside the
      // snapshot's span is a lower bound that grows with uptime.
      accum: { since: tailSince },
    });

    // Fetch a REST snapshot, then replay buffered diffs on top of it.
    const resync = async () => {
      if (syncing || closed) return;
      syncing = true;
      lastUpdateId = null;
      try {
        const snap = await fetchJson(c.rest + c.depth(s));
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
            const ok = market === 'spot'
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
        status('error', `Binance snapshot: ${err.message}`);
        if (!closed) setTimeout(() => { syncing = false; resync(); }, 1500);
        return;
      }
      syncing = false;
    };

    const conn = reconnectingWs(`${c.ws}/${s.toLowerCase()}@depth@100ms`, {
      onOpen: () => { buffer = []; lastUpdateId = null; syncing = false; resync(); },
      onMessage: (raw) => {
        const e = JSON.parse(raw.toString());
        if (!e.u) return;
        if (lastUpdateId === null) { buffer.push(e); if (buffer.length > 3000) buffer.shift(); return; }
        const contiguous = market === 'spot' ? e.U === lastUpdateId + 1 : e.pu === lastUpdateId;
        if (!contiguous) {
          if (e.u <= lastUpdateId) return; // already applied
          status('reconnecting', 'Binance diff gap, resyncing');
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
  },
};
