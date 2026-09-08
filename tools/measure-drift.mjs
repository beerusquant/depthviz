/**
 * Re-derive the distributions the drift thresholds were set from.
 *
 *   node tools/measure-drift.mjs                       # 3 minutes, prints and saves
 *   node tools/measure-drift.mjs --minutes 20 --check  # and fails if a threshold no longer holds
 *
 * Every threshold in this repo is supposed to come from a distribution somebody
 * sampled, with the sample written next to it. Two of them are — OKX's 3% and
 * Bitunix's refusal of a threshold at all — and both were measured once, by a
 * script that no longer exists. A number derived from a sample nobody can
 * reproduce is a guess with a good story: an exchange changes its cadence, the
 * distribution moves under it, and the constant keeps looking measured.
 *
 * So this reads `drift` off /api/depth — the same figure the adapters compute
 * and the panel shows, not a second implementation — builds the distribution,
 * writes it to logs/measurements/, and (with --check) asserts the two claims
 * the code actually rests on:
 *
 *   OKX      DRIFT_TOLERANCE must stay at least DRIFT_P95_FACTOR times the p95.
 *            Measured 2026-09-08 over 15 min at 1 Hz, n=895/896: spot p95
 *            0.023%, BTC perp 0.008%, ETH perp 0.007% — so 3% is 130x the
 *            widest of them, comfortably past the 20x the rule asks for. (The
 *            source's own note records p95 <= 0.093% at n=169.)
 *   Bitunix  no threshold was adopted, because the venue's own spread of
 *            behaviour across instruments is an order of magnitude wide
 *            (BTC p95 1.84%, SOL 11.45%). What IS claimed is that the median of
 *            the default instrument sits under 2%. That claim is checkable.
 *
 * Neither a SKIP nor an INCONC counts as a pass here: an unreachable server or
 * a venue with no drift to report exits non-zero, like every other check.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distribution } from './lib/recording.mjs';
import { DRIFT_TOLERANCE, DRIFT_P95_FACTOR } from '../server/adapters/okx.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTTP = process.env.DEPTHVIZ_HTTP || 'http://127.0.0.1:8787';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const minutes = +arg('minutes', '15');
const intervalMs = +arg('interval', '1000');
const check = process.argv.includes('--check');

const BITUNIX_MEDIAN_MAX = 0.02;   // the claim in CLAUDE.md §2 bis, made checkable

/**
 * How many readings before a p95 is allowed to judge anything.
 *
 * Measured, like everything else here. The same instruments, the same cadence,
 * an hour apart on 2026-09-08:
 *
 *   3 min,  n=177    OKX spot p95 0.163%   perp 0.182%
 *   15 min, n=895    OKX spot p95 0.023%   perp 0.008%
 *
 * A p95 over 177 points is the ninth-largest value, so two transient spikes set
 * it; over 895 it is the forty-fifth and they do not. The short sample failed
 * the tolerance and the long one passed it comfortably — the venue had not
 * moved at all, the statistic was simply being asked a question it could not
 * answer. So a short run still records its distribution, and refuses to gate on
 * it: INCONC, which already exits non-zero.
 */
const MIN_N_FOR_P95 = 500;

const TARGETS = [
  { id: 'okx spot BTC-USDT', q: 'exchange=okx&market=spot&symbol=BTC-USDT', judge: 'okx' },
  { id: 'okx perp BTC-USDT-SWAP', q: 'exchange=okx&market=perp&symbol=BTC-USDT-SWAP', judge: 'okx' },
  { id: 'okx perp ETH-USDT-SWAP', q: 'exchange=okx&market=perp&symbol=ETH-USDT-SWAP', judge: 'okx' },
  { id: 'bitunix perp BTCUSDT', q: 'exchange=bitunix&market=perp&symbol=BTCUSDT', judge: 'bitunix' },
];

const samples = new Map(TARGETS.map((t) => [t.id, []]));
const errors = new Map(TARGETS.map((t) => [t.id, 0]));

const read = async (t) => {
  // The URL is named in every failure: a check that reports "connection
  // refused" without saying where turns a configuration mistake into what
  // reads as an outage.
  const url = `${HTTP}/api/depth?${t.q}&range=0.5`;
  // Bounded, because the rule this file exists to enforce applies to this file:
  // a `fetch` with no timeout turns one unresponsive read into a measurement
  // that never reports, and a sampler that hangs at minute two of twenty has
  // taken twenty minutes and produced nothing.
  //
  // Five seconds, not two: the first read of a heavy book pays for opening the
  // feed, and Bitunix perp is 25 000 levels. A 2 s bound aborted that read and
  // counted it as an error, which is a measurement of the timeout rather than
  // of the venue.
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), Math.max(5000, intervalMs * 2));
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (typeof j.drift === 'number') samples.get(t.id).push(j.drift);
  } catch (e) {
    errors.set(t.id, errors.get(t.id) + 1);
    if (errors.get(t.id) === 1) console.error(`  ${t.id}: ${e.message} (${url})`);
  } finally {
    clearTimeout(kill);
  }
};

const endAt = Date.now() + minutes * 60_000;
console.error(`measuring ws-vs-REST drift against ${HTTP} for ${minutes} min, every ${intervalMs}ms`);
// The first reads open the feeds; the adapters only measure drift once their
// own REST poll has landed, so the first few seconds legitimately carry none.
while (Date.now() < endAt) {
  const tick = Date.now() + intervalMs;
  await Promise.all(TARGETS.map(read));
  const wait = tick - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(3)}%`);
const out = { measuredAt: new Date().toISOString(), minutes, intervalMs, http: HTTP, targets: {} };
let failed = 0;
let inconclusive = 0;

console.log('');
for (const t of TARGETS) {
  const d = distribution(samples.get(t.id));
  out.targets[t.id] = { n: d?.n ?? 0, errors: errors.get(t.id), distribution: d };
  const need = t.judge === 'okx' ? MIN_N_FOR_P95 : 10;   // a median settles far sooner than a p95
  if (!d || d.n < need) {
    // Not a pass. A distribution of three readings is not a distribution, and a
    // p95 over 177 of them is two spikes wearing a quantile's clothes.
    console.log(`INCONC ${t.id.padEnd(26)} n=${d?.n ?? 0} (need >= ${need}; ${errors.get(t.id)} request errors)`);
    inconclusive++;
    continue;
  }
  console.log(`       ${t.id.padEnd(26)} median ${pct(d.median).padStart(8)}  p95 ${pct(d.p95).padStart(8)}  max ${pct(d.max).padStart(8)}  n=${d.n}`);
}

console.log('');
for (const t of TARGETS) {
  const r = out.targets[t.id];
  if (!r.distribution || r.n < (t.judge === 'okx' ? MIN_N_FOR_P95 : 10)) continue;
  if (t.judge === 'okx') {
    const need = r.distribution.p95 * DRIFT_P95_FACTOR;
    const ok = need <= DRIFT_TOLERANCE;
    r.verdict = { rule: `DRIFT_TOLERANCE >= ${DRIFT_P95_FACTOR} x p95`, need, have: DRIFT_TOLERANCE, pass: ok };
    console.log(`${ok ? 'PASS  ' : 'FAIL  '} ${t.id.padEnd(26)} tolerance ${pct(DRIFT_TOLERANCE)} vs ${DRIFT_P95_FACTOR}x p95 = ${pct(need)}`);
    if (!ok) failed++;
  } else {
    const ok = r.distribution.median <= BITUNIX_MEDIAN_MAX;
    r.verdict = { rule: `median <= ${pct(BITUNIX_MEDIAN_MAX)}`, have: r.distribution.median, pass: ok };
    console.log(`${ok ? 'PASS  ' : 'FAIL  '} ${t.id.padEnd(26)} median ${pct(r.distribution.median)} vs the ${pct(BITUNIX_MEDIAN_MAX)} claimed in CLAUDE.md §2 bis`);
    if (!ok) failed++;
  }
}

mkdirSync(path.join(root, 'logs', 'measurements'), { recursive: true });
const file = path.join(root, 'logs', 'measurements', `drift-${out.measuredAt.replace(/[:.]/g, '-').slice(0, 19)}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nwritten to ${path.relative(root, file)}`);

if (!check) process.exit(0);
if (inconclusive) console.log(`${inconclusive} target(s) inconclusive — an absence of proof, not a pass`);
console.log(failed || inconclusive ? 'VERDICT: NOT PROVEN' : 'VERDICT: every threshold still holds against a fresh sample');
process.exit(failed || inconclusive ? 1 : 0);
