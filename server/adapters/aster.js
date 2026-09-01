import { fetchJson, ttlCache } from '../util.js';
import { openDiffBook } from './diff-book.js';

/**
 * Aster (asterdex.com) — perp DEX serving a Binance-futures-shaped API:
 * same `depthUpdate` payload, same `U`/`u`/`pu` sequencing, sizes already in
 * base units (no contract multiplier — checked against ccxt's own
 * `contractSize`, which is 1, and against the venue's REST book).
 *
 * Only the perp market is exposed: Aster does list spot pairs on a separate
 * `sapi` host, but this is a perp venue and its spot book is a different
 * (much thinner) product.
 */
const CFG = {
  rest: 'https://fapi.asterdex.com',
  info: '/fapi/v1/exchangeInfo',
  // 1000 is the venue's ceiling — limit=5000 is rejected with -1130. That is
  // about +-2.7% of mid on BTC, so anything past that is accumulated from
  // diffs, exactly like Binance perp.
  depth: (s) => `/fapi/v1/depth?symbol=${s}&limit=1000`,
  ticker: '/fapi/v1/ticker/24hr',
  ws: 'wss://fstream.asterdex.com/ws',
  stream: (s) => `/${s.toLowerCase()}@depth@100ms`,
  style: 'futures',
  label: 'Aster',
};

const info = ttlCache(async () => {
  const j = await fetchJson(CFG.rest + CFG.info);
  return j.symbols.filter((x) => x.status === 'TRADING' && x.contractType === 'PERPETUAL');
}, 5 * 60_000);

const tickers = ttlCache(async () => {
  const rows = await fetchJson(CFG.rest + CFG.ticker);
  const m = new Map();
  for (const t of rows) m.set(t.symbol, +t.quoteVolume);
  return m;
}, 45_000);

export default {
  id: 'aster',
  name: 'Aster',
  markets: ['perp'],
  transport: { perp: 'ws' },
  notes: {
    perp: 'Aster caps its REST book at 1000 levels/side (±2.7% on BTC); depth further out is accumulated from the diff stream, so it is a lower bound that grows with uptime, never an overstatement.',
  },

  async listSymbols() {
    return (await info()).map((x) => ({
      s: x.symbol,
      d: `${x.baseAsset}/${x.quoteAsset}`,
      base: x.baseAsset,
      quote: x.quoteAsset,
    })).sort((a, b) => a.d.localeCompare(b.d));
  },

  async vol24h(market, s) {
    return (await tickers()).get(s) ?? null;
  },

  open(market, s, opts, emit, status) {
    return openDiffBook(CFG, s, emit, status);
  },
};
