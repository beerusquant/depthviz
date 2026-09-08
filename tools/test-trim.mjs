/**
 * Deterministic tests for hub.trim — the reduction every browser payload goes
 * through. No network.
 *
 * The rule it exists to keep: reducing the payload must not reduce the REACH or
 * the totals. The version before it kept the 2500 levels nearest mid, which cut
 * the tail instead of the weight — Binance spot shipped ±0.62% of a book that
 * reached ±11%, hiding 64% of the depth inside ±10%. The replacement emits
 * [vwapPrice, summedQty] buckets, a form that preserves cumulative notional,
 * cumulative quantity and VWAP exactly, because vwapPrice * summedQty is
 * sum(price * qty) by construction.
 *
 * These tests pin that identity. Any future reduction that breaks them is
 * lying about the book.
 *   node tools/test-trim.mjs
 */
import { trim, CLIP_PCT, EXACT_PCT, EXACT_MAX, BUCKET_BPS } from '../server/hub.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};
const near = (a, b, rel = 1e-12) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
const qty = (rows) => rows.reduce((s, [, q]) => s + q, 0);
const ntl = (rows) => rows.reduce((s, [p, q]) => s + p * q, 0);

console.log('hub.trim');

const MID = 100;
// A book reaching ±11%: dense near mid, sparse in the tail.
const bids = [];
for (let i = 1; i <= 3000; i++) bids.push([MID * (1 - i * 0.00002), 1]);   // out to -6%
for (let i = 1; i <= 200; i++) bids.push([MID * (0.94 - i * 0.00025), 5]); // -6% to -11%, inside the clip

{
  const out = trim(bids, MID);
  const kept = bids.filter(([p]) => Math.abs(p - MID) / MID * 100 <= CLIP_PCT);
  ok('cumulative quantity is preserved exactly', near(qty(out), qty(kept)),
     `${qty(out)} vs ${qty(kept)}`);
  ok('cumulative notional is preserved exactly', near(ntl(out), ntl(kept)),
     `${ntl(out)} vs ${ntl(kept)}`);
}
{
  // The failure this replaced: reach must survive the reduction.
  const out = trim(bids, MID);
  const reachIn = (1 - bids.at(-1)[0] / MID) * 100;
  const reachOut = (1 - out.at(-1)[0] / MID) * 100;
  ok('reach survives the reduction', reachIn < CLIP_PCT && reachOut > reachIn - 0.05,
     `in ±${reachIn.toFixed(2)}%, out ±${reachOut.toFixed(2)}%`);
  ok('the payload is bounded', out.length < bids.length / 2,
     `${bids.length} levels in, ${out.length} out`);
}
{
  // Every emitted bucket must itself satisfy vwap * qty === sum(price * qty),
  // which is what makes a bucket honest rather than merely small.
  const out = trim(bids, MID);
  const bad = out.filter(([p, q]) => !(p > 0 && q > 0));
  ok('every emitted row is a positive [price, qty]', bad.length === 0, JSON.stringify(bad.slice(0, 3)));
}
{
  const inside = [[MID, 1], [MID * 0.999, 2], [MID * 0.998, 3]];
  ok('levels inside the exact zone are shipped verbatim',
     JSON.stringify(trim(inside, MID)) === JSON.stringify(inside));
}
{
  const far = [[MID, 1], [MID * (1 - (CLIP_PCT + 1) / 100), 99]];
  const out = trim(far, MID);
  ok('levels beyond the clip are dropped', out.length === 1 && out[0][1] === 1);
}
{
  const withZero = [[MID, 1], [MID * 0.999, 0], [MID * 0.998, 2]];
  ok('zero-size levels are ignored', qty(trim(withZero, MID)) === 3);
}
{
  // Past EXACT_MAX verbatim levels, bucketing must start even inside the exact
  // zone — otherwise the cap does nothing and the payload is unbounded.
  const many = [];
  for (let i = 0; i < EXACT_MAX + 500; i++) many.push([MID * (1 - i * 0.0000001), 1]);
  const out = trim(many, MID);
  ok('the verbatim cap is enforced', out.length <= EXACT_MAX + 5, `${out.length} rows`);
  ok('and nothing is lost when it kicks in', near(qty(out), qty(many)));
}
{
  // Bucket width: two levels a hair apart, well outside the exact zone, must
  // merge into one row; two levels several bucket-widths apart must not.
  const step = Math.log(1 + BUCKET_BPS / 10_000);
  const d = EXACT_PCT + 1;
  const near1 = MID * (1 - d / 100);
  const near2 = near1 * (1 - 0.1 * step);
  const farAway = MID * (1 - (d + 1) / 100);
  ok('adjacent levels beyond the exact zone merge',
     trim([[MID, 1], [near1, 2], [near2, 3]], MID).length === 2);
  ok('distant levels stay separate',
     trim([[MID, 1], [near1, 2], [farAway, 3]], MID).length === 3);
}
{
  // A merged bucket's price is the VWAP of what went into it — not the first
  // price, not the midpoint. That is the whole reason the identity holds.
  const d = EXACT_PCT + 1;
  const p1 = MID * (1 - d / 100), p2 = p1 * 0.999999;
  const out = trim([[MID, 1], [p1, 1], [p2, 3]], MID);
  const bucket = out.at(-1);
  ok('a bucket carries the VWAP of its levels',
     near(bucket[0], (p1 * 1 + p2 * 3) / 4) && bucket[1] === 4,
     JSON.stringify(bucket));
}
{
  ok('an empty side stays empty', trim([], MID).length === 0);
}

// ------------------------------------------------------- report boundaries
// A bucket that straddles ±2% (or ±5%, or ±10%) is counted whole or dropped
// whole, depending on which side of the line its VWAP price fell — so a figure
// published as fact was wrong by up to one bucket. On a book decaying at a
// realistic rate that overstated the ±2% depth by 0.51%.
{
  const mid = 78_000;
  const rows = [];
  for (let i = 1; i <= 400_000; i++) {
    const p = mid + i * 0.05;
    const d = (p / mid - 1) * 100;
    if (d > 12) break;
    rows.push([p, 0.02 * Math.exp(-d * 0.6)]);
  }
  const cum = (t, lim) => t.filter(([p]) => (p / mid - 1) * 100 <= lim + 1e-12)
    .reduce((s, [p, q]) => s + p * q, 0);
  const t = trim(rows, mid);
  for (const lim of [2, 5, 10]) {
    const truth = cum(rows, lim);
    const got = cum(t, lim);
    ok(`cumulative notional at +${lim}% survives the reduction exactly`,
       Math.abs(got / truth - 1) < 1e-12,
       `truth ${truth.toFixed(2)} got ${got.toFixed(2)} (${((got / truth - 1) * 100).toFixed(4)}%)`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
