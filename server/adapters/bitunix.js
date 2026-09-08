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
export function sumCandleVolume(rows, now = Date.now(), hours = 24, bucketMs = 3600_000) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const cutoff = now - hours * bucketMs;
  let total = 0;
  for (const k of rows) {
    const start = Date.parse(k.ts);
    if (!isFinite(start)) continue;
    const end = start + bucketMs;
    if (end <= cutoff) break; // rows come newest-first
    const overlap = Math.min(1, (end - Math.max(start, cutoff)) / bucketMs);
    total += +k.volume * +k.close * overlap;
  }
  return isFinite(total) && total > 0 ? total : null;
}

const spotVol = ttlCache(async (symbol) => {
  const j = await fetchJson(`${SPOT}/api/spot/v1/market/kline?symbol=${encodeURIComponent(symbol)}&interval=60`);
  return sumCandleVolume(j.data);
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
    //
    // Bitunix is the one venue with no external judge: it is absent from all
    // 103 ccxt exchanges, so nothing outside this repo ever reads its book. The
    // venue does publish a second, independent view of the same book over REST,
    // and comparing the two is the only continuous integrity check available
    // here — the same shape as OKX's, for the same reason. `drift` is the
    // cumulative-size disagreement over ±0.5% of mid; the panel and /api/depth
    // carry it, so a stream that starts lying stops being invisible.
    let drift = null;
    let stopped = false;
    let lastBook = null;
    // Held so close() can clear it: a flag alone stops the NEXT measurement and
    // leaves the pending one holding the event loop for five seconds.
    let measureTimer = null;

    const cumTo = (rows, mid, sign, band) => {
      let q = 0;
      for (const [p, sz] of rows) { if (sign * (p - mid) / mid * 100 > band) break; q += sz; }
      return q;
    };
    const measure = async () => {
      if (stopped) return;
      try {
        const r = await fetchJson(`${FUT}/api/v1/futures/market/depth?symbol=${encodeURIComponent(s)}&limit=max`);
        // The ws book is read AFTER the response lands, not before it is sent.
        // Our stream is continuous and theirs is a point-in-time read, so the
        // pair is only comparable at one instant; taking ours first puts the
        // whole request round-trip into the skew and turns a measurement of the
        // book into a measurement of the network. The crosscheck learned this
        // the same way.
        const b = lastBook;
        const d = r.data || {};
        const rb = (d.bids || []).map((x) => [+x[0], +x[1]]);
        const ra = (d.asks || []).map((x) => [+x[0], +x[1]]);
        if (b && rb.length && ra.length) {
          const mw = (b.bids[0][0] + b.asks[0][0]) / 2;
          const mr = (rb[0][0] + ra[0][0]) / 2;
          const ws = cumTo(b.bids, mw, -1, 0.5) + cumTo(b.asks, mw, 1, 0.5);
          const rest = cumTo(rb, mr, -1, 0.5) + cumTo(ra, mr, 1, 0.5);
          drift = rest > 0 ? Math.abs(ws - rest) / rest : null;
        }
      } catch { /* the ws book is unaffected by a failed REST read */ }
      if (!stopped) measureTimer = setTimeout(measure, 5000);
    };
    // The raw arrays are handed to the coalescer untouched: on BTC this book
    // carries 25 000 levels and mapping them is the expensive half, so it must
    // happen on the frame that is actually shipped, not on every frame received.
    const publish = coalesce((b, a, ts) => {
      // A socket closes with a handshake, so a frame already in flight still
      // reaches onMessage after close(): a closed adapter must publish nothing.
      if (stopped) return;
      const bids = b.map((r) => [+r[0], +r[1]]);
      const asks = a.map((r) => [+r[0], +r[1]]);
      if (bids.length && asks.length) lastBook = { bids, asks };
      emit({ bids, asks, ts, source: 'ws', drift });
    }, PUBLISH_MS);
    // The one seam here: tests drive this adapter through a fake transport
    // instead of a socket. The hub only ever builds `opts` as { range }, so
    // nothing in production reaches it.
    const conn = (opts?.connect || reconnectingWs)(FUT_WS, {
      onOpen: (send) => send({ op: 'subscribe', args: [{ symbol: s, ch: 'depth_books' }] }),
      onMessage: (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.op === 'ping' || m.ping) return;
        if (m.ch !== 'depth_books' || !m.data) return;
        publish(m.data.b || [], m.data.a || [], m.ts ?? null);
      },
      onStatus: status,
    }, { pingMs: 20_000, pingPayload: JSON.stringify({ op: 'ping', ping: Math.floor(Date.now() / 1000) }) });
    measureTimer = setTimeout(measure, 5000);
    return { close() { stopped = true; clearTimeout(measureTimer); publish.cancel(); conn.close(); } };
  },
};
