import { fetchJson, ttlCache, poller, reconnectingWs, BookSide, pbFields, watchdogFallback } from '../util.js';

const TAIL_MAX_GAP_MS = 30_000;   // longer outage => distrust the deep tail

const SPOT = 'https://api.mexc.com';
const FUT = 'https://contract.mexc.com';
const SPOT_WS = 'wss://wbs-api.mexc.com/ws';
const FUT_WS = 'wss://contract.mexc.com/edge';

const spotInfo = ttlCache(async () => {
  const j = await fetchJson(`${SPOT}/api/v3/exchangeInfo`);
  return j.symbols.filter((x) => x.status === '1' && x.isSpotTradingAllowed);
}, 5 * 60_000);

const futInfo = ttlCache(async () => {
  const j = await fetchJson(`${FUT}/api/v1/contract/detail`);
  return (j.data || []).filter((x) => x.state === 0 && x.apiAllowed !== false);
}, 5 * 60_000);

const futSizes = ttlCache(async () => {
  const m = new Map();
  for (const c of await futInfo()) m.set(c.symbol, +c.contractSize || 1);
  return m;
}, 5 * 60_000);

const spotTickers = ttlCache(async () => {
  const rows = await fetchJson(`${SPOT}/api/v3/ticker/24hr`);
  return new Map(rows.map((t) => [t.symbol, +t.quoteVolume]));
}, 45_000);

const futTickers = ttlCache(async () => {
  const j = await fetchJson(`${FUT}/api/v1/contract/ticker`);
  return new Map((j.data || []).map((t) => [t.symbol, +t.amount24]));
}, 45_000);

/**
 * MEXC spot v3 pushes protobuf frames. The schema is stable and small; these
 * are the only field numbers we need, mapped from the live wire format:
 *   1 = channel, 3 = symbol, 313 = PublicAggreDepths body
 *   313.1 = asks[], 313.2 = bids[]  (each: 1 = price str, 2 = qty str)
 *   313.4 = fromVersion, 313.5 = toVersion
 */
const DEPTH_BODY_FIELD = 313;
function decodeSpotDepth(buf) {
  const top = pbFields(buf);
  const body = top.get(DEPTH_BODY_FIELD)?.[0];
  if (!body) return null;
  const f = pbFields(body);
  const levels = (arr) => (arr || []).map((b) => {
    const g = pbFields(b);
    return [+g.get(1)?.[0].toString('utf8'), +g.get(2)?.[0].toString('utf8')];
  });
  const str = (n) => f.get(n)?.[0]?.toString('utf8');
  return {
    asks: levels(f.get(1)),
    bids: levels(f.get(2)),
    from: +str(4),
    to: +str(5),
  };
}

function openSpot(s, emit, status) {
  const bids = new BookSide(true);
  const asks = new BookSide(false);
  let version = null, buffer = [], syncing = false, closed = false;
  let lastGoodAt = 0, tailSince = 0;

  const publish = (ts, source = 'ws') => emit({
    bids: bids.toArray(), asks: asks.toArray(), ts, source,
    accum: { since: tailSince },
  });
  const applyEvt = (e) => {
    const now = Date.now();
    for (const [p, q] of e.bids) bids.set(p, q, now);
    for (const [p, q] of e.asks) asks.set(p, q, now);
    version = e.to;
    lastGoodAt = now;
  };

  const resync = async () => {
    if (syncing || closed) return;
    syncing = true;
    version = null;
    try {
      const snap = await fetchJson(`${SPOT}/api/v3/depth?symbol=${s}&limit=5000`);
      if (closed) return;
      const keepTail = lastGoodAt > 0 && Date.now() - lastGoodAt < TAIL_MAX_GAP_MS;
      const kept = bids.applySnapshot(snap.bids, { keepTail })
                 + asks.applySnapshot(snap.asks, { keepTail });
      if (!keepTail || !kept || !tailSince) tailSince = Date.now();
      const uid = snap.lastUpdateId;
      const pending = buffer.filter((e) => e.to > uid);
      buffer = [];
      version = uid;
      let first = true;
      for (const e of pending) {
        if (first) {
          if (!(e.from <= uid + 1 && e.to >= uid + 1)) { syncing = false; setTimeout(resync, 400); return; }
          first = false;
        }
        applyEvt(e);
      }
      publish(Date.now());
    } catch (err) {
      status('error', `MEXC spot snapshot: ${err.message}`);
      if (!closed) setTimeout(() => { syncing = false; resync(); }, 1500);
      return;
    }
    syncing = false;
  };

  const conn = reconnectingWs(SPOT_WS, {
    onOpen: (send) => {
      buffer = []; version = null; syncing = false;
      send({ method: 'SUBSCRIPTION', params: [`spot@public.aggre.depth.v3.api.pb@100ms@${s}`] });
      resync();
    },
    onMessage: (raw) => {
      if (!Buffer.isBuffer(raw) || raw[0] === 0x7b) return; // '{' -> control JSON
      const e = decodeSpotDepth(raw);
      if (!e || !isFinite(e.to)) return;
      if (version === null) { buffer.push(e); if (buffer.length > 3000) buffer.shift(); return; }
      if (e.from !== version + 1) {
        if (e.to <= version) return;
        status('reconnecting', 'MEXC spot diff gap, resyncing');
        buffer = [e];
        resync();
        return;
      }
      applyEvt(e);
      publish(Date.now());
    },
    onStatus: (st, d) => { if (st !== 'open') status(st, d); },
  }, { pingMs: 20_000, pingPayload: JSON.stringify({ method: 'PING' }) });

  return { close() { closed = true; conn.close(); } };
}

function openPerp(s, cs, emit, status) {
  const bids = new BookSide(true);
  const asks = new BookSide(false);
  let version = null, buffer = [], syncing = false, closed = false;
  let lastGoodAt = 0, tailSince = 0;

  const publish = (ts, source = 'ws') => emit({
    bids: bids.toArray(), asks: asks.toArray(), ts, source,
    accum: { since: tailSince },
  });
  const applyEvt = (d) => {
    const now = Date.now();
    for (const r of d.bids || []) bids.set(r[0], +r[1] * cs, now);
    for (const r of d.asks || []) asks.set(r[0], +r[1] * cs, now);
    version = d.end ?? d.version;
    lastGoodAt = now;
  };

  const resync = async () => {
    if (syncing || closed) return;
    syncing = true;
    version = null;
    try {
      const j = await fetchJson(`${FUT}/api/v1/contract/depth/${s}`);
      if (closed) return;
      const d = j.data || {};
      const keepTail = lastGoodAt > 0 && Date.now() - lastGoodAt < TAIL_MAX_GAP_MS;
      const kept = bids.applySnapshot((d.bids || []).map((r) => [+r[0], +r[1] * cs]), { keepTail })
                 + asks.applySnapshot((d.asks || []).map((r) => [+r[0], +r[1] * cs]), { keepTail });
      if (!keepTail || !kept || !tailSince) tailSince = Date.now();
      const v = +d.version;
      const pending = buffer.filter((e) => (e.end ?? e.version) > v);
      buffer = [];
      version = v;
      let first = true;
      for (const e of pending) {
        if (first) {
          if (!(e.begin <= v + 1 && (e.end ?? e.version) >= v + 1)) { syncing = false; setTimeout(resync, 400); return; }
          first = false;
        }
        applyEvt(e);
      }
      publish(d.timestamp || Date.now());
    } catch (err) {
      status('error', `MEXC perp snapshot: ${err.message}`);
      if (!closed) setTimeout(() => { syncing = false; resync(); }, 1500);
      return;
    }
    syncing = false;
  };

  const conn = reconnectingWs(FUT_WS, {
    onOpen: (send) => {
      buffer = []; version = null; syncing = false;
      send({ method: 'sub.depth', param: { symbol: s } });
      resync();
    },
    onMessage: (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.channel !== 'push.depth' || !msg.data) return;
      const d = msg.data;
      if (version === null) { buffer.push(d); if (buffer.length > 3000) buffer.shift(); return; }
      if (d.begin !== version + 1) {
        if ((d.end ?? d.version) <= version) return;
        status('reconnecting', 'MEXC perp diff gap, resyncing');
        buffer = [d];
        resync();
        return;
      }
      applyEvt(d);
      publish(Date.now());
    },
    onStatus: (st, dd) => { if (st !== 'open') status(st, dd); },
  }, { pingMs: 15_000, pingPayload: JSON.stringify({ method: 'ping' }) });

  return { close() { closed = true; conn.close(); } };
}

/** REST polling, kept as the safety net behind both websockets. */
function pollBook(market, s, cs, emit, status) {
  return poller(async () => {
    if (market === 'spot') {
      const j = await fetchJson(`${SPOT}/api/v3/depth?symbol=${s}&limit=5000`);
      emit({ bids: j.bids.map((r) => [+r[0], +r[1]]), asks: j.asks.map((r) => [+r[0], +r[1]]), ts: Date.now(), source: 'poll' });
    } else {
      const j = await fetchJson(`${FUT}/api/v1/contract/depth/${s}`);
      const d = j.data || {};
      emit({
        bids: (d.bids || []).map((r) => [+r[0], +r[1] * cs]),
        asks: (d.asks || []).map((r) => [+r[0], +r[1] * cs]),
        ts: d.timestamp || Date.now(), source: 'poll',
      });
    }
  }, 1000, (e) => status('error', `MEXC poll: ${e.message}`));
}

export default {
  id: 'mexc',
  name: 'MEXC',
  markets: ['spot', 'perp'],
  transport: { spot: 'ws', perp: 'ws' },

  async listSymbols(market) {
    if (market === 'spot') {
      return (await spotInfo()).map((x) => ({
        s: x.symbol, d: `${x.baseAsset}/${x.quoteAsset}`, base: x.baseAsset, quote: x.quoteAsset,
      })).sort((a, b) => a.d.localeCompare(b.d));
    }
    return (await futInfo()).map((x) => ({
      s: x.symbol, d: `${x.baseCoin}/${x.quoteCoin}`, base: x.baseCoin, quote: x.quoteCoin,
    })).sort((a, b) => a.d.localeCompare(b.d));
  },

  async vol24h(market, s) {
    const m = market === 'spot' ? await spotTickers() : await futTickers();
    return m.get(s) ?? null;
  },

  async open(market, s, opts, emit, status) {
    const cs = market === 'perp' ? ((await futSizes()).get(s) || 1) : 1;
    // If the websocket has not produced a book in 8s, poll until it recovers.
    const wd = watchdogFallback(8000, () => pollBook(market, s, cs, emit, status));
    const wrapped = (book) => { wd.ok(); emit(book); };
    const conn = market === 'spot' ? openSpot(s, wrapped, status) : openPerp(s, cs, wrapped, status);
    return { close() { wd.close(); conn.close(); } };
  },
};
