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
  // ccxt's futures book stops at 1000 levels — about ±0.16% on BTC — so that is
  // the whole band available, and one large level near its edge moves the ratio
  // 10%. Hourly medians: 0.949, 0.973, 0.987, 0.991, 0.997, and one 0.895 at
  // n=3 that a direct comparison against Binance's own REST endpoint could not
  // reproduce (1.000 / 1.004 / 0.997 at ±0.05 / ±0.1 / ±0.156%, eight samples).
  { ours: ['binance','perp','BTCUSDT'],         ccxt: ['binanceusdm','BTC/USDT:USDT',1000], reps: 15, tol: [0.85, 1.18] },
  // MEXC spot is judged on ±0.25%, not ±0.5%, because that is the widest band
  // on which the venue is a reference at all.
  //
  // Measured directly against MEXC's own REST endpoint — no ccxt, no depthviz —
  // twenty pairs of reads one second apart, cumulative base size, p95/p05 of the
  // ratio of a read to the read that followed it:
  //
  //     ±0.05%  1.59x    ±0.5%  3.06x
  //     ±0.1%   1.53x    ±1%    5.13x
  //     ±0.25%  1.51x    ±2%    8.89x
  //
  // The median sits at ~1.00 at every band, so there is no bias — past ±0.25%
  // a handful of large orders flicker in and out and the venue simply does not
  // hold still. Judging there was never a measurement of us; it was a
  // measurement of MEXC's own variance, and the wide tolerance it needed made
  // the check blind to anything short of a 2x error.
  //
  // Our book is not the problem, and that was measured too: against MEXC's REST
  // book read at the same instant, twelve samples at ±0.5%, our feed came in at
  // median 0.982 — closer to MEXC's book than MEXC's book is to itself one
  // second later.
  { ours: ['mexc','spot','BTCUSDT'],            ccxt: ['mexc','BTC/USDT',5000],       reps: 15, band: 0.25 },
  { ours: ['mexc','perp','BTC_USDT'],           ccxt: ['mexc','BTC/USDT:USDT',null],  contracts: true },
  // Coinbase serves its whole book, so the band is the full ±0.5% — but three
  // samples straddled agreement once (median 1.106, p05 0.995), reported
  // INCONCLUSIVE and exited non-zero. Nothing was wrong; three samples were
  // simply not a median.
  { ours: ['coinbase','spot','BTC-USD'],        ccxt: ['coinbaseexchange','BTC/USD',null], reps: 15 },
  // The narrowest band of all: ccxt sees the same 20 aggregated levels the venue
  // serves, ~±0.025% of mid, while our stitched book reaches ±11%. Fifteen
  // samples give a median that still wanders — 1.000, 1.008, 1.005, 0.965,
  // 0.893, 1.001 across hourly runs — because at that width a couple of orders
  // are the entire measurement. The tolerance states what the check can prove
  // here; a missed unit conversion would be 100x and still scream.
  { ours: ['hyperliquid','perp','BTC'],         ccxt: ['hyperliquid','BTC/USDC:USDC',null], reps: 15, tol: [0.80, 1.25] },
  { ours: ['aster','perp','BTCUSDT'],           ccxt: ['aster','BTC/USDT:USDT',1000] },
  // Lighter's ccxt book is 100 levels (~±0.02% on BTC) against our whole-book
  // stream, so the overlap band is thin and one read moves a lot: sample more.
  { ours: ['lighter','perp','BTC'],             ccxt: ['lighter','BTC/USDC:USDC',null], reps: 15 },
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
  // Our socket book is continuous, ccxt's is a point-in-time REST read, so the
  // pair is only comparable at one instant. Sampling ours BEFORE the fetch put
  // the whole request latency into the skew; taking the live book the moment
  // the response lands puts our read as close to theirs as this can get.
  const before = live;
  try { ob = await client.fetchOrderBook(csym, clim); }
  catch (e) { if (!samples.length) { console.log(JSON.stringify({ err: e.constructor.name + ': ' + String(e.message).slice(0, 90) })); process.exit(0); } break; }
  ours = live || before;
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

const argv = process.argv.slice(2);
// A single sample is not a verdict: on a thin book, or where the overlap band
// is only the ~0.02% Hyperliquid's 20 levels span, one read can be 1.7x off
// purely from the book moving. Three is the cheapest useful median; --repeat
// buys a real distribution.
const ri = argv.indexOf('--repeat');
const REPS = ri >= 0 ? Math.max(1, +argv[ri + 1] || 1) : 3;
const GAP_MS = ri >= 0 ? 8000 : 4000;

// A child with no bound can hang the entire run, and this one did: on
// 2026-09-08 a single venue's child sat for over an hour while the twelve
// behind it waited, and the run produced no verdict at all. The worst case a
// venue legitimately needs is reps x gap plus a fetch each — 15 x 8s is two
// minutes — so five is generous and still finite. A killed child is reported as
// "not judged", which already exits non-zero: an absent measurement was never a
// passing one.
const CHILD_TIMEOUT_MS = +process.env.DEPTHVIZ_CROSSCHECK_TIMEOUT_MS || 5 * 60_000;

const run = (v) => new Promise((res) => {
  const reps = ri >= 0 ? REPS : Math.max(REPS, v.reps || 0);
  const args = [...v.ours, ...v.ccxt.map(String), String(!!v.contracts), SERVER, String(v.band ?? BAND), String(SETTLE_MS), String(reps), String(GAP_MS)];
  const p = spawn(process.execPath, ['--input-type=module', '-e', CHILD, '--', ...args],
    { cwd: process.env.CCXT_DIR || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', errOut = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill('SIGTERM');
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 3000).unref();
  }, CHILD_TIMEOUT_MS);
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { errOut += d; });
  p.on('close', () => {
    clearTimeout(timer);
    if (timedOut) {
      const t = CHILD_TIMEOUT_MS >= 60_000 ? `${(CHILD_TIMEOUT_MS / 60_000).toFixed(0)} min` : `${(CHILD_TIMEOUT_MS / 1000).toFixed(0)}s`;
      return res({ err: `no result after ${t} — child killed` });
    }
    try { res(JSON.parse(out.trim().split('\n').pop())); }
    catch { res({ err: `child produced no result: ${(errOut.trim().split('\n').pop() || 'no stderr').slice(0, 110)}` }); }
  });
});

/**
 * A venue that could not be reached is reported as "not judged" and exits
 * non-zero, because an absent measurement is not a passing one. That is right,
 * but one transient — a rate limit, a dropped connection — should not spend the
 * whole run's credibility: an hourly run reported two Binance markets unjudged
 * and nothing was wrong with either. A failure to measure is retried once
 * before it is believed, and the retry is named in the output so a venue that
 * needs it every time stays visible.
 */
const runWithRetry = async (v) => {
  const first = await run(v);
  if (!first.err) return first;
  await new Promise((r) => setTimeout(r, 5000));
  const second = await run(v);
  if (!second.err) return { ...second, retried: true };
  return { ...second, err: `${second.err} (twice; first: ${first.err})` };
};

const only = argv.find((a) => !a.startsWith('--') && a !== String(REPS));
const list = only ? VENUES.filter((v) => v.ours[0] === only) : VENUES;
console.log(`ccxt cross-check — band ±${BAND}% of mid, our live ws vs a ccxt REST snapshot\n`);
let bad = 0, ok = 0, skipped = 0, inconclusive = 0;
for (const v of list) {
  const tag = `${v.ours[0]}/${v.ours[1]} ${v.ours[2]}`.padEnd(29);
  const r = await runWithRetry(v);
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
  // Tolerance is per venue because venues differ in how still their book holds,
  // not because some deserve to be graded gently: see the MEXC spot note above
  // for the measurement behind its own band.
  const [tlo, thi] = v.tol || (r.n > 1 ? [0.93, 1.08] : [0.85, 1.18]);
  const okQty = rel > tlo && rel < thi;
  // A wide sample whose own p05..p95 straddles agreement has not found a
  // disagreement — it has failed to measure one. Saying FAIL there trains the
  // reader to ignore the tool, so that case is reported as its own outcome.
  const straddles = r.n > 1 && r.lo / expect <= 1 && r.hi / expect >= 1;
  const verdict = okMid && okQty ? 'OK  ' : straddles ? 'INCONC' : 'FAIL';
  if (verdict === 'OK  ') ok++; else if (verdict === 'FAIL') bad++; else inconclusive++;
  const note = (r.contracts ? `  [ccxt ships raw contracts; contractSize=${r.size}${r.inverse ? ' USD, inverse' : ''}]` : '')
    + (r.retried ? '  [measured on the retry]' : '');
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
