import { fetchJson, ttlCache } from '../util.js';
import { openDiffBook } from './diff-book.js';
import { decodeDepthUpdate, fetchDepthSnapshot } from './binance.js';

/**
 * Aster (asterdex.com) — perp DEX serving a Binance-futures-shaped API: the
 * same `depthUpdate` payload, the same U/u/pu sequencing, and sizes already in
 * base units (no contract multiplier — ccxt reports contractSize 1, and the
 * cross-venue check in tools/verify-conversions.mjs agrees). So it is the
 * Binance decode and snapshot verbatim, pointed at another host.
 *
 * Perp only: Aster does list spot pairs on a separate `sapi` host, but this is
 * a perp venue and that book is a different, much thinner product.
 */
const REST = 'https://fapi.asterdex.com';
// 1000 is the venue's ceiling — limit=5000 is rejected with -1130. That is
// about ±2.7% of mid on BTC, so anything past it is accumulated from diffs,
// exactly like Binance perp.
const DEPTH = (s) => `/fapi/v1/depth?symbol=${encodeURIComponent(s)}&limit=1000`;

const info = ttlCache(async () => {
  const j = await fetchJson(`${REST}/fapi/v1/exchangeInfo`);
  return j.symbols.filter((x) => x.status === 'TRADING' && x.contractType === 'PERPETUAL');
}, 5 * 60_000);

const tickers = ttlCache(async () => {
  const rows = await fetchJson(`${REST}/fapi/v1/ticker/24hr`);
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
    return openDiffBook({
      label: 'Aster',
      ws: `wss://fstream.asterdex.com/ws/${encodeURIComponent(s.toLowerCase())}@depth@100ms`,
      style: 'prev',
      decode: decodeDepthUpdate,
      snapshot: () => fetchDepthSnapshot(REST, DEPTH(s)),
      // The transport seam the tests drive. Production never sets it: the hub
      // only ever builds `opts` as { range }.
      connect: opts?.connect,
    }, emit, status);
  },
};
