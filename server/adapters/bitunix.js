import { fetchJson, ttlCache, poller, reconnectingWs, coalesce, PUBLISH_MS } from '../util.js';

const SPOT = 'https://openapi.bitunix.com';
const FUT = 'https://fapi.bitunix.com';
const FUT_WS = 'wss://fapi.bitunix.com/public/';

const spotPairs = ttlCache(async () => {
  const j = await fetchJson(`${SPOT}/api/spot/v1/common/coin_pair/list`);
  return j.data || [];
}, 5 * 60_000);

const futPairs = ttlCache(async () => {
  const j = await fetchJson(`${FUT}/api/v1/futures/market/trading_pairs`);
  return (j.data || []).filter((x) => x.symbolStatus === 'OPEN');
}, 5 * 60_000);

const futTickers = ttlCache(async () => {
  const j = await fetchJson(`${FUT}/api/v1/futures/market/tickers`);
  return new Map((j.data || []).map((t) => [t.symbol, +t.quoteVol]));
}, 45_000);

/**
 * Bitunix publishes no spot ticker (every /market/ticker* path 404s), so the
 * rolling 24h notional is summed from hourly candles instead: volume is in base
 * units, valued at each candle's own close. The oldest candle only partly
 * overlaps the window, so it is weighted by its overlapping fraction.
 */
const spotVol = ttlCache(async (symbol) => {
  const j = await fetchJson(`${SPOT}/api/spot/v1/market/kline?symbol=${encodeURIComponent(symbol)}&interval=60`);
  const rows = j.data;
  if (!Array.isArray(rows) || !rows.length) return null;
  const HOUR = 3600_000;
  const cutoff = Date.now() - 24 * HOUR;
  let total = 0;
  for (const k of rows) {
    const start = Date.parse(k.ts);
    if (!isFinite(start)) continue;
    const end = start + HOUR;
    if (end <= cutoff) break; // rows come newest-first
    const overlap = Math.min(1, (end - Math.max(start, cutoff)) / HOUR);
    total += +k.volume * +k.close * overlap;
  }
  return isFinite(total) && total > 0 ? total : null;
}, 60_000);

export default {
  id: 'bitunix',
  name: 'Bitunix',
  markets: ['spot', 'perp'],
  transport: { spot: 'poll', perp: 'ws' },
  notes: {
    spot: 'Bitunix caps its public spot book at 50 levels/side (server-side; every limit/precision value returns 50 and there is no spot websocket) — on a liquid pair that is only about ±0.05% around mid, so wider ranges cannot be filled. 24h volume is summed from hourly candles, not a ticker.',
  },

  async listSymbols(market) {
    const rows = market === 'spot' ? await spotPairs() : await futPairs();
    return rows.map((x) => ({
      s: x.symbol, d: `${x.base}/${x.quote}`, base: x.base, quote: x.quote,
    })).sort((a, b) => a.d.localeCompare(b.d));
  },

  async vol24h(market, s) {
    if (market === 'spot') {
      try { return await spotVol(s); } catch { return null; }
    }
    return (await futTickers()).get(s) ?? null;
  },

  open(market, s, opts, emit, status) {
    if (market === 'spot') {
      let first = true;
      return poller(async () => {
        const j = await fetchJson(`${SPOT}/api/spot/v1/market/depth?symbol=${encodeURIComponent(s)}&limit=200`);
        const d = j.data || {};
        const conv = (rows) => (rows || []).map((r) => [+r.price, +r.volume]);
        emit({ bids: conv(d.bids), asks: conv(d.asks), ts: null, source: 'poll' });
        if (first) { first = false; status('open'); }
      }, 1000, (e) => status('error', `Bitunix: ${e.message}`));
    }

    // Futures: the public websocket streams the whole book (15k+ levels) as a
    // full snapshot several times a second — no diff bookkeeping needed.
    // The raw arrays are handed to the coalescer untouched: on BTC this book
    // carries 25 000 levels and mapping them is the expensive half, so it must
    // happen on the frame that is actually shipped, not on every frame received.
    const publish = coalesce((b, a, ts) => emit({
      bids: b.map((r) => [+r[0], +r[1]]),
      asks: a.map((r) => [+r[0], +r[1]]),
      ts, source: 'ws',
    }), PUBLISH_MS);
    const conn = reconnectingWs(FUT_WS, {
      onOpen: (send) => send({ op: 'subscribe', args: [{ symbol: s, ch: 'depth_books' }] }),
      onMessage: (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.op === 'ping' || m.ping) return;
        if (m.ch !== 'depth_books' || !m.data) return;
        publish(m.data.b || [], m.data.a || [], m.ts ?? null);
      },
      onStatus: status,
    }, { pingMs: 20_000, pingPayload: JSON.stringify({ op: 'ping', ping: Math.floor(Date.now() / 1000) }) });
    return { close() { publish.cancel(); conn.close(); } };
  },
};
