/**
 * ccxt as an independent judge of our own adapters — not as the data source.
 *
 * Why not just read the books from ccxt: it is capped at each venue's shallow
 * public endpoint (Hyperliquid 20 levels vs our stitched ~56, no Bitunix at
 * all) and, critically, `fetchOrderBook` returns OKX/MEXC contract-denominated
 * sizes RAW — it exposes `market.contractSize` but never applies it. Reading
 * the book straight from ccxt is a silent 100x error on BTC-USDT-SWAP.
 *
 * So ccxt is used here for the one thing it is genuinely better at: being a
 * second, independently-maintained implementation to disagree with us.
 *
 * Each venue is run in isolation so one venue's failure cannot end the run.
 *   node tools/crosscheck-ccxt.mjs           # all venues (needs the server up)
 *   node tools/crosscheck-ccxt.mjs okx       # one venue
 */
import { spawn } from 'node:child_process';

// +-0.5%: wide enough that the ~0.04% mid drift between our live socket and a
// REST snapshot taken a moment later cannot dominate the comparison, and still
// inside every judged venue's reach.
const BAND = 0.5;
const SETTLE_MS = 20_000;   // let the live feed sync before sampling
const SERVER = process.env.DEPTHVIZ_URL || 'ws://localhost:8787/ws';

// ours -> ccxt. `contracts` marks books ccxt reports in raw contracts, where a
// ratio of exactly contractSize (not 1.0) is the CORRECT answer.
const VENUES = [
  { ours: ['okx','spot','BTC-USDT'],           ccxt: ['okx','BTC/USDT',5000] },
  { ours: ['okx','perp','BTC-USDT-SWAP'],       ccxt: ['okx','BTC/USDT:USDT',5000],   contracts: true },
  { ours: ['okx','perp','BTC-USD-SWAP'],        ccxt: ['okx','BTC/USD:BTC',5000],      contracts: true },
  { ours: ['binance','spot','BTCUSDT'],         ccxt: ['binance','BTC/USDT',5000] },
  { ours: ['binance','perp','BTCUSDT'],         ccxt: ['binanceusdm','BTC/USDT:USDT',1000] },
  // MEXC spot's book inside ±0.5% is thin enough that a single read swings ~2x;
  // three samples cannot find its median, so it gets more.
  { ours: ['mexc','spot','BTCUSDT'],            ccxt: ['mexc','BTC/USDT',5000],       reps: 15 },
  { ours: ['mexc','perp','BTC_USDT'],           ccxt: ['mexc','BTC/USDT:USDT',null],  contracts: true },
  { ours: ['coinbase','spot','BTC-USD'],        ccxt: ['coinbaseexchange','BTC/USD',null] },
  { ours: ['hyperliquid','perp','BTC'],         ccxt: ['hyperliquid','BTC/USDC:USDC',null] },
  // bitunix: absent from ccxt (103 exchanges, not one of them) — no judge available.
];

const CHILD = `
import ccxt from 'ccxt';
import WebSocket from 'ws';
process.on('unhandledRejection', e => { console.log(JSON.stringify({ err: 'unhandledRejection: ' + e })); process.exit(0); });
const [ex, mk, sym, cid, csym, climRaw, contracts, server, band, settle, repsRaw, gapRaw] = process.argv.slice(1);
const reps = Math.max(1, +repsRaw || 1), gapMs = +gapRaw || 8000;
const clim = climRaw === 'null' ? undefined : +climRaw;
const cum = (rows, mid, sign, w) => { let q = 0, n = 0;
  for (const [p, s] of rows) { if (sign * (p - mid) / mid * 100 > w) break; q += s; n += p * s; } return [q, n]; };
const reach = (rows, mid, sign) => sign * (rows.at(-1)[0] - mid) / mid * 100;
// One socket held open for the whole run: reconnecting per sample would make
// every sample pay the resync cost and measure a differently-converged book.
const sock = new WebSocket(server);
let live = null;
sock.on('open', () => sock.send(JSON.stringify({ op: 'subscribe', exchange: ex, market: mk, symbol: sym })));
sock.on('message', m => { try { const d = JSON.parse(m.toString()); if (d.bids?.length && d.asks?.length) live = d; } catch {} });
sock.on('error', () => {});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(+settle);
if (!live) { console.log(JSON.stringify({ err: 'our feed produced no book' })); process.exit(0); }

let client;
let size = null, inverse = false;
try { client = new ccxt[cid]({ enableRateLimit: true });
  if (contracts === 'true') { await client.loadMarkets(); const mkt = client.market(csym); size = mkt.contractSize; inverse = !!mkt.inverse; } }
catch (e) { console.log(JSON.stringify({ err: e.constructor.name + ': ' + String(e.message).slice(0, 90) })); process.exit(0); }

const samples = [];
let ob = null, ours = null;
for (let i = 0; i < reps; i++) {
  if (i) await sleep(gapMs);
  ours = live;
  try { ob = await client.fetchOrderBook(csym, clim); }
  catch (e) { if (!samples.length) { console.log(JSON.stringify({ err: e.constructor.name + ': ' + String(e.message).slice(0, 90) })); process.exit(0); } break; }
  samples.push(sample(ours, ob));
}
try { sock.close(); } catch {}
const rs = samples.map(x => x.qty).sort((a, b) => a - b);
const pick = (f) => rs[Math.min(rs.length - 1, Math.floor(f * rs.length))];
const out = samples[samples.length - 1];
console.log(JSON.stringify({ ...out, n: rs.length, med: pick(0.5), lo: pick(0.05), hi: pick(0.95) }));
process.exit(0);

function sample(ours, ob) {
const m1 = (ours.bids[0][0] + ours.asks[0][0]) / 2, m2 = (ob.bids[0][0] + ob.asks[0][0]) / 2;
// Compare only over the band BOTH books actually reach: charging us for depth
// ccxt never fetched would make our deeper feed look like an error.
const r1 = Math.min(reach(ours.bids, m1, -1), reach(ours.asks, m1, 1));
const r2 = Math.min(reach(ob.bids, m2, -1), reach(ob.asks, m2, 1));
const w = Math.min(+band, r1, r2);
const [qb1, nb1] = cum(ours.bids, m1, -1, w), [qa1, na1] = cum(ours.asks, m1, 1, w);
const [qb2, nb2] = cum(ob.bids, m2, -1, w),   [qa2, na2] = cum(ob.asks, m2, 1, w);
return { m1, m2, size, inverse, contracts: contracts === 'true', w,
  qty: (qb1 + qa1) / (qb2 + qa2), ntl: (nb1 + na1) / (nb2 + na2), reach1: r1, reach2: r2 };
}
process.exit(0);
`;

const run = (v) => new Promise((res) => {
  const reps = ri >= 0 ? REPS : Math.max(REPS, v.reps || 0);
  const args = [...v.ours, ...v.ccxt.map(String), String(!!v.contracts), SERVER, String(BAND), String(SETTLE_MS), String(reps), String(GAP_MS)];
  const p = spawn(process.execPath, ['--input-type=module', '-e', CHILD, '--', ...args],
    { cwd: process.env.CCXT_DIR || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', errOut = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { errOut += d; });
  p.on('close', () => {
    try { res(JSON.parse(out.trim().split('\n').pop())); }
    catch { res({ err: `child produced no result: ${(errOut.trim().split('\n').pop() || 'no stderr').slice(0, 110)}` }); }
  });
});

const argv = process.argv.slice(2);
// A single sample is not a verdict: on a thin book, or where the overlap band
// is only the ~0.02% Hyperliquid's 20 levels span, one read can be 1.7x off
// purely from the book moving. Three is the cheapest useful median; --repeat
// buys a real distribution.
const ri = argv.indexOf('--repeat');
const REPS = ri >= 0 ? Math.max(1, +argv[ri + 1] || 1) : 3;
const GAP_MS = ri >= 0 ? 8000 : 4000;
const only = argv.find((a) => !a.startsWith('--') && a !== String(REPS));
const list = only ? VENUES.filter((v) => v.ours[0] === only) : VENUES;
console.log(`ccxt cross-check — band ±${BAND}% of mid, our live ws vs a ccxt REST snapshot\n`);
let bad = 0, ok = 0, skipped = 0, inconclusive = 0;
for (const v of list) {
  const tag = `${v.ours[0]}/${v.ours[1]} ${v.ours[2]}`.padEnd(29);
  const r = await run(v);
  if (r.err) { skipped++; console.log(`${tag} SKIP  ${r.err}`); continue; }
  const midOff = (r.m1 / r.m2 - 1) * 100;
  // For contract-denominated books the CORRECT qty ratio is the contract
  // multiplier, not 1 — and on an INVERSE contract ctVal is quoted in USD, so
  // the multiplier is ctVal/price, not ctVal.
  const expect = !r.contracts ? 1 : r.inverse ? r.size / r.m1 : r.size;
  // With repeated sampling the median is the statistic to judge: a single
  // sample of a thin book can be 2x off from the book simply moving between
  // the two reads, which says nothing about whether our sizes are right.
  const rel = (r.n > 1 ? r.med : r.qty) / expect;
  const okMid = Math.abs(midOff) < 0.05;
  const okQty = r.n > 1 ? rel > 0.93 && rel < 1.08 : rel > 0.85 && rel < 1.18;
  // A wide sample whose own p05..p95 straddles agreement has not found a
  // disagreement — it has failed to measure one. Saying FAIL there trains the
  // reader to ignore the tool, so that case is reported as its own outcome.
  const straddles = r.n > 1 && r.lo / expect <= 1 && r.hi / expect >= 1;
  const verdict = okMid && okQty ? 'OK  ' : straddles ? 'INCONC' : 'FAIL';
  if (verdict === 'OK  ') ok++; else if (verdict === 'FAIL') bad++; else inconclusive++;
  const note = r.contracts ? `  [ccxt ships raw contracts; contractSize=${r.size}${r.inverse ? ' USD, inverse' : ''}]` : '';
  const dist = r.n > 1
    ? ` | n=${r.n} median ${(r.med / expect).toFixed(3)} p05 ${(r.lo / expect).toFixed(3)} p95 ${(r.hi / expect).toFixed(3)}`
    : '';
  console.log(`${tag} ${verdict}  mid ${midOff >= 0 ? '+' : ''}${midOff.toFixed(4)}%` +
    ` | ${r.n > 1 ? 'median' : 'qty'} ratio ${rel.toFixed(3)}${dist}` +
    ` | judged on ±${r.w.toFixed(3)}% (our reach ±${r.reach1.toFixed(2)}%, ccxt ±${r.reach2.toFixed(2)}%)${note}`);
}
console.log(`\n${ok} agree, ${bad} disagree, ${inconclusive} inconclusive, ${skipped} not judged` +
  ` (bitunix is absent from ccxt entirely, so it never has a judge).` +
  (inconclusive ? `\nInconclusive means the samples straddle agreement, not that we differ — re-run with --repeat 20.` : ''));
// Neither a skip nor an inconclusive result is a pass: both are missing evidence.
process.exit(bad === 0 && skipped === 0 && inconclusive === 0 ? 0 : 1);
