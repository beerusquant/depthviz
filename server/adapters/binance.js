import { fetchJson, ttlCache } from '../util.js';
import { openDiffBook } from './diff-book.js';

const CFG = {
  spot: {
    rest: 'https://api.binance.com',
    info: '/api/v3/exchangeInfo',
    depth: (s) => `/api/v3/depth?symbol=${encodeURIComponent(s)}&limit=5000`,
    ticker: '/api/v3/ticker/24hr',
    ws: 'wss://stream.binance.com:9443/ws',
    style: 'from',      // events chain by U === lastUpdateId + 1
  },
  perp: {
    rest: 'https://fapi.binance.com',
    info: '/fapi/v1/exchangeInfo',
    depth: (s) => `/fapi/v1/depth?symbol=${encodeURIComponent(s)}&limit=1000`,
    ticker: '/fapi/v1/ticker/24hr',
    ws: 'wss://fstream.binance.com/ws',
    style: 'prev',      // events name their predecessor in `pu`
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

/** The `depthUpdate` payload, shared with every Binance-API clone. */
export const decodeDepthUpdate = (raw) => {
  const e = JSON.parse(raw.toString());
  if (!e.u) return null;
  return {
    bids: (e.b || []).map((r) => [+r[0], +r[1]]),
    asks: (e.a || []).map((r) => [+r[0], +r[1]]),
    from: e.U, to: e.u, prev: e.pu, ts: e.E,
  };
};

/** The REST depth snapshot payload -> the engine's shape. Pure, so it is tested. */
export const mapDepthSnapshot = (snap) => ({
  bids: snap.bids.map((r) => [+r[0], +r[1]]),
  asks: snap.asks.map((r) => [+r[0], +r[1]]),
  version: snap.lastUpdateId,
  // The futures REST book is stamped (`E`), the spot one is not. Taking it
  // where it exists is the difference between a snapshot frame that reports its
  // upstream latency and one that claims to have no clock at all.
  ts: Number.isFinite(+snap.E) ? +snap.E : null,
});

/** The same snapshot, fetched. */
export const fetchDepthSnapshot = async (rest, path) => mapDepthSnapshot(await fetchJson(rest + path));

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
    return openDiffBook({
      label: 'Binance',
      ws: `${c.ws}/${encodeURIComponent(s.toLowerCase())}@depth@100ms`,
      style: c.style,
      decode: decodeDepthUpdate,
      snapshot: () => fetchDepthSnapshot(c.rest, c.depth(s)),
      // The transport seam the tests drive. Production never sets it: the hub
      // only ever builds `opts` as { range }.
      connect: opts?.connect,
    }, emit, status);
  },
};
