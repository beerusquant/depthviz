/**
 * Bitunix is absent from ccxt (103 exchanges, not one of them), so
 * tools/crosscheck-ccxt.mjs reports it as "not judged" and never as a pass.
 * This is the substitute: three checks built only from sources that are
 * independent of the code path being checked.
 *
 *   node tools/verify-bitunix.mjs      (the depthviz server must be running)
 */
import WebSocket from 'ws';

const SPOT = 'https://openapi.bitunix.com';
const FUT = 'https://fapi.bitunix.com';
const SERVER = process.env.DEPTHVIZ_URL || 'ws://localhost:8787/ws';
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

console.log(`\n${fails === 0 ? 'all Bitunix checks pass' : fails + ' check(s) failed'} — none of these is an external second implementation, so they bound the error rather than confirm the data.`);
process.exit(fails ? 1 : 0);
