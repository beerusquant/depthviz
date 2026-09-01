import { fetchJson, ttlCache } from '../util.js';
import { openDiffBook } from './diff-book.js';

const CFG = {
  spot: {
    rest: 'https://api.binance.com',
    info: '/api/v3/exchangeInfo',
    depth: (s) => `/api/v3/depth?symbol=${s}&limit=5000`,
    ticker: '/api/v3/ticker/24hr',
    ws: 'wss://stream.binance.com:9443/ws',
    stream: (s) => `/${s.toLowerCase()}@depth@100ms`,
    style: 'spot',
    label: 'Binance',
  },
  perp: {
    rest: 'https://fapi.binance.com',
    info: '/fapi/v1/exchangeInfo',
    depth: (s) => `/fapi/v1/depth?symbol=${s}&limit=1000`,
    ticker: '/fapi/v1/ticker/24hr',
    ws: 'wss://fstream.binance.com/ws',
    stream: (s) => `/${s.toLowerCase()}@depth@100ms`,
    style: 'futures',
    label: 'Binance',
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
    return openDiffBook(CFG[market], s, emit, status);
  },
};
