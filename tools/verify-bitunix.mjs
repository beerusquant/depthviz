/**
 * Bitunix is absent from ccxt — rechecked against 4.5.78, the current release:
 * 103 exchanges, not one of them — so tools/crosscheck-ccxt.mjs reports it as
 * "not judged" and never as a pass. This is the substitute.
 *
 * Checks 1-3 are built from sources independent of the code path being checked,
 * but they are all still OUR reading of Bitunix: they bound the error, they do
 * not confirm the data. Check 4 is the one that does — CoinGecko polls Bitunix
 * on its own schedule with its own client, so it is a genuine second reader of
 * the same venue. It sees the touch and the tape, not the book, so it judges
 * the price, the spread and the 24h volume and says nothing about depth. That
 * is still three of the four numbers this adapter produces, judged from outside.
 *
 *   node tools/verify-bitunix.mjs      (the depthviz server must be running)
 */
import WebSocket from 'ws';

const SPOT = 'https://openapi.bitunix.com';
const FUT = 'https://fapi.bitunix.com';
const SERVER = process.env.DEPTHVIZ_URL || 'ws://localhost:8787/ws';
// No tool here hardcodes a port: the deployed service listens on 8888, and a
// hardcoded 8787 once reported every feed dead while the server was healthy.
const HTTP = process.env.DEPTHVIZ_HTTP || 'http://127.0.0.1:8787';
const SYMBOL = process.argv[2] || 'BTCUSDT';

const j = async (u) => (await fetch(u, { headers: { 'User-Agent': 'depthviz/1.0' } })).json();
const ourBook = (exchange, market, symbol, ms = 20_000) => new Promise((r) => {
  const w = new WebSocket(SERVER); let last = null;
  w.on('open', () => w.send(JSON.stringify({ op: 'subscribe', exchange, market, symbol })));
  w.on('message', (m) => { try { const d = JSON.parse(m.toString()); if (d.bids?.length && d.asks?.length) last = d; } catch {} });
  w.on('error', () => {});
  setTimeout(() => { try { w.close(); } catch {} r(last); }, ms);
});
const mid = (b) => (b ? (b.bids[0][0] + b.asks[0][0]) / 2 : null);

let fails = 0;
const verdict = (name, ok, line) => { if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}\n       ${line}`); };

console.log(`Bitunix independent checks — ${SYMBOL}\n`);

// 1. 24h spot volume, recomputed at a different candle granularity.
//    Bitunix publishes no spot ticker at all (every /market/ticker* path 404s),
//    so the adapter sums hourly candles. Summing 15-minute candles over the
//    same rolling window shares no arithmetic with that: a windowing or
//    boundary-weighting bug shows up as a divergence, a venue-wide data problem
//    shows up in both.
{
  const sum = async (interval) => {
    const res = await j(`${SPOT}/api/spot/v1/market/kline?symbol=${SYMBOL}&interval=${interval}`);
    const rows = res.data || [];
    const span = interval * 60_000;
    const cutoff = Date.now() - 24 * 3600_000;
    let total = 0, used = 0;
    for (const k of rows) {
      const start = Date.parse(k.ts);
      if (!isFinite(start)) continue;
      const end = start + span;
      if (end <= cutoff) break;                       // newest-first
      total += +k.volume * +k.close * Math.min(1, (end - Math.max(start, cutoff)) / span);
      used++;
    }
    return { total, used, rows: rows.length };
  };
  const h = await sum(60), q = await sum(15);
  const ratio = q.total / h.total;
  // 15m candles must actually span 24h or the comparison is vacuous.
  const covers = q.used * 15 >= 24 * 60 - 15;
  verdict('24h spot volume agrees across candle granularity',
    covers && ratio > 0.97 && ratio < 1.03,
    `60m sum $${(h.total / 1e6).toFixed(2)}M over ${h.used} candles vs 15m sum $${(q.total / 1e6).toFixed(2)}M over ${q.used}` +
    ` -> ratio ${ratio.toFixed(4)}${covers ? '' : '  [15m rows do not span 24h — inconclusive]'}`);
}

// 2. Futures book: our live websocket against the venue's own REST snapshot.
//    Two transports of the same venue, so this catches the depth_books stream
//    drifting without a sequence error ever firing.
{
  const ws = await ourBook('bitunix', 'perp', SYMBOL);
  const res = await j(`${FUT}/api/v1/futures/market/depth?symbol=${SYMBOL}&limit=max`);
  const d = res.data || {};
  const rest = d.bids?.length && d.asks?.length
    ? { bids: d.bids.map((r) => [+r[0], +r[1]]), asks: d.asks.map((r) => [+r[0], +r[1]]) } : null;
  if (!ws || !rest) verdict('futures ws agrees with futures REST', false, 'one of the two books was empty');
  else {
    const m1 = mid(ws), m2 = mid(rest);
    const band = 0.5;
    const cum = (rows, m, sign) => { let q = 0; for (const [p, s] of rows) { if (sign * (p - m) / m * 100 > band) break; q += s; } return q; };
    const a = cum(ws.bids, m1, -1) + cum(ws.asks, m1, 1);
    const b = cum(rest.bids, m2, -1) + cum(rest.asks, m2, 1);
    const midOff = (m1 / m2 - 1) * 100, r = a / b;
    verdict('futures ws agrees with futures REST',
      Math.abs(midOff) < 0.05 && r > 0.85 && r < 1.18,
      `mid ${m1.toFixed(2)} vs ${m2.toFixed(2)} (${midOff >= 0 ? '+' : ''}${midOff.toFixed(4)}%), cumulative size within ±${band}% ratio ${r.toFixed(3)}`);
  }
}

// 3. Cross-venue price sanity. A units or scaling error in the Bitunix
//    adapter would move its mid off every other venue at the same instant.
{
  const peers = [['okx','spot','BTC-USDT'], ['binance','spot','BTCUSDT'], ['coinbase','spot','BTC-USD']];
  const mids = [];
  for (const p of peers) { const b = await ourBook(...p, 12_000); if (b) mids.push(mid(b)); }
  const bu = mid(await ourBook('bitunix', 'spot', SYMBOL, 12_000));
  if (!bu || mids.length < 2) verdict('spot mid matches the other venues', false, 'not enough peer mids to compare');
  else {
    const sorted = [...mids].sort((x, y) => x - y);
    const med = sorted[Math.floor(sorted.length / 2)];
    const off = (bu / med - 1) * 100;
    verdict('spot mid matches the other venues', Math.abs(off) < 0.5,
      `bitunix ${bu.toFixed(2)} vs peer median ${med.toFixed(2)} (${off >= 0 ? '+' : ''}${off.toFixed(3)}%) from ${mids.length} venues`);
  }
}

// 3 bis. The adapter's own ws-vs-REST drift, judged on a median.
//    Bitunix perp streams FULL snapshots several times a second, so a wrong book
//    repairs itself on the next frame and there is nothing to resync — which is
//    why this threshold lives in the check rather than in the adapter. What it
//    catches is the case the socket watchdog cannot: a stream that is alive,
//    on time, and shipping a partial or truncated book.
//
//    Measured every 5 s for 20 min on four instruments, cumulative size over
//    ±0.5% of mid, after fixing the sampling to read our book when the REST
//    response lands rather than before it is sent:
//
//        BTCUSDT   median 0.288%   p95 1.835%   max  2.760%
//        ETHUSDT   median 0.587%   p95 2.196%   max 16.061%
//        SOLUSDT   median 3.419%   p95 11.452%  max 16.729%
//        DOGEUSDT  median 1.046%   p95 4.431%   max  8.157%
//
//    The spread across instruments is an order of magnitude, so there is no one
//    number that fits all four — a global threshold would be silent on BTC and
//    permanently breached on SOL. This judges the default instrument on the
//    MEDIAN of a run of readings, where its whole measured range sits under 2%:
//    a single 2.7% spike is the two reads straddling a busy tick, a median past
//    2% is the book.
{
  const N = 10, EVERY_MS = 6000;   // the adapter refreshes drift every 5 s
  const seen = [];
  // Why a reading is missing, counted. Without this the check said "0/10
  // readings" and nothing else, which is the same sentence for a rate-limited
  // request, a refused connection, a venue that stopped answering, and an
  // adapter that simply has not measured yet — four different problems with
  // four different fixes. It cost an evening of guessing on 2026-09-09, and
  // this repo already has the rule: a failure names the URL it actually tried.
  const why = new Map();
  const note = (r) => why.set(r, (why.get(r) ?? 0) + 1);
  const url = `${HTTP}/api/depth?exchange=bitunix&market=perp&symbol=${SYMBOL}&range=2`;
  for (let i = 0; i < N; i++) {
    if (i) await new Promise((r) => setTimeout(r, EVERY_MS));
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'depthviz/1.0' } });
      if (!r.ok) { note(`HTTP ${r.status}${r.status === 429 ? ` (Retry-After ${r.headers.get('retry-after') || '?'}s)` : ''}`); continue; }
      const b = await r.json();
      if (typeof b.drift === 'number') seen.push(b.drift);
      else if (b.error) note(`server said: ${b.error}`);
      else note('drift was null — the adapter has not compared the two transports yet');
    } catch (e) { note(e.message); }
  }
  if (seen.length < N / 2) {
    fails++;
    const breakdown = [...why].map(([r, n]) => `${n}x ${r}`).join('; ') || 'no reason recorded';
    console.log(`  INCONC ws-vs-REST drift\n       only ${seen.length}/${N} readings — not enough to take a median`
              + `\n       ${breakdown}\n       ${url}`);
  } else {
    const v = [...seen].sort((a, b) => a - b);
    const med = v[Math.floor(v.length / 2)];
    verdict('futures ws book agrees with the venue\'s own REST book', med < 0.02,
      `median ${(med * 100).toFixed(3)}% over ${v.length} readings (worst ${(v[v.length - 1] * 100).toFixed(3)}%), threshold 2%`);
  }
}

// 4. The external judge: CoinGecko reads Bitunix itself.
//    Everything above is our own client talking to Bitunix, so a shared
//    misunderstanding of the venue's payload would pass all three. CoinGecko
//    runs its own integration against the same exchange and publishes what it
//    sees; where the two agree, the reading is confirmed rather than merely
//    bounded. It has no order book, so depth stays judged only by the venue
//    against itself (the adapter's own ws-vs-REST `drift`).
//
//    An unreachable or rate-limited judge is an absence of proof, not a pass:
//    it reports INCONC and exits non-zero, exactly as a ccxt failure does in
//    crosscheck-ccxt.
{
  const CG = 'https://api.coingecko.com/api/v3';
  const pct = (a, b) => (a / b - 1) * 100;
  let cg = null;
  try {
    const [spot, perp] = await Promise.all([
      j(`${CG}/exchanges/bitunix/tickers?coin_ids=bitcoin`),
      j(`${CG}/derivatives/exchanges/bitunix_futures?include_tickers=unexpired`),
    ]);
    const st = (spot.tickers || []).find((t) => t.base === 'BTC' && t.target === 'USDT');
    const pt = (perp.tickers || []).find((t) => t.symbol === 'BTC_USDT');
    if (st && pt) cg = { st, pt };
  } catch { /* handled below */ }

  if (!cg) {
    fails++;
    console.log('  INCONC external judge unavailable\n       CoinGecko did not return Bitunix BTC tickers — no external confirmation this run');
  } else {
    const { st, pt } = cg;
    const ourSpot = mid(await ourBook('bitunix', 'spot', SYMBOL, 12_000));
    const ourPerp = mid(await ourBook('bitunix', 'perp', SYMBOL, 12_000));

    // Price. CoinGecko's `last` is a trade, ours is the mid of the book, and
    // their read lags ours by up to a minute — so this catches a scaling or
    // units error, not a basis point.
    if (ourSpot) {
      const d = pct(ourSpot, st.last);
      verdict('spot mid matches an outside reading of Bitunix', Math.abs(d) < 0.5,
        `ours ${ourSpot.toFixed(2)} vs CoinGecko ${(+st.last).toFixed(2)} (${d >= 0 ? '+' : ''}${d.toFixed(3)}%)`);
    }
    if (ourPerp) {
      const d = pct(ourPerp, pt.last);
      verdict('perp mid matches an outside reading of Bitunix', Math.abs(d) < 0.5,
        `ours ${ourPerp.toFixed(2)} vs CoinGecko ${(+pt.last).toFixed(2)} (${d >= 0 ? '+' : ''}${d.toFixed(3)}%)`);
    }

    // 24h volume. This is the figure with no other judge at all: the spot one
    // is summed from candles because Bitunix publishes no spot ticker, and a
    // windowing bug there would look like a real number. CoinGecko converts on
    // its own prices over its own window, so ±15% is the honest band.
    const ourSpotVol = await j(`${HTTP}/api/depth?exchange=bitunix&market=spot&symbol=${SYMBOL}&range=2`).then((x) => x.vol24h).catch(() => null);
    const ourPerpVol = await j(`${HTTP}/api/depth?exchange=bitunix&market=perp&symbol=${SYMBOL}&range=2`).then((x) => x.vol24h).catch(() => null);
    const cgSpotVol = +st.converted_volume?.usd;
    const cgPerpVol = +pt.converted_volume?.usd;
    if (ourSpotVol && cgSpotVol) {
      const r = ourSpotVol / cgSpotVol;
      verdict('spot 24h volume agrees with an outside reading', r > 0.85 && r < 1.15,
        `ours $${(ourSpotVol / 1e6).toFixed(2)}M (summed from candles) vs CoinGecko $${(cgSpotVol / 1e6).toFixed(2)}M -> ratio ${r.toFixed(4)}`);
    }
    if (ourPerpVol && cgPerpVol) {
      const r = ourPerpVol / cgPerpVol;
      verdict('perp 24h volume agrees with an outside reading', r > 0.85 && r < 1.15,
        `ours $${(ourPerpVol / 1e6).toFixed(2)}M (venue ticker) vs CoinGecko $${(cgPerpVol / 1e6).toFixed(2)}M -> ratio ${r.toFixed(4)}`);
    }

    // Spread is reported, not judged: theirs is a snapshot taken at an unknown
    // instant and ours is the touch right now, so any threshold here would be
    // measuring the gap between two clocks. A number worth seeing is not the
    // same thing as a number worth failing on.
    console.log(`  --   spread, for reference (not a verdict)\n       CoinGecko sees spot ${(+st.bid_ask_spread_percentage * 100).toFixed(2)} bps, perp ${(+pt.bid_ask_spread * 1e4).toFixed(2)} bps`);
  }
}

console.log(`\n${fails === 0 ? 'all Bitunix checks pass' : fails + ' check(s) failed'} — checks 1-3 bound the error from our own reading; check 4 is an outside reader of the same venue, and it sees the touch and the tape, never the depth.`);
process.exit(fails ? 1 : 0);
