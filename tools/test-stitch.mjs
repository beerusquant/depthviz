/**
 * Deterministic tests for the Hyperliquid layer stitch. No network.
 *
 * The property that matters: cumulative quantity at any price must be the
 * cumulative quantity the coarsest layer covering that price reports. The old
 * rule dropped every bucket that straddled a seam, so it lost depth silently —
 * these tests pin that it cannot come back.
 *   node tools/test-stitch.mjs
 */
import { stitch } from '../server/adapters/hyperliquid.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};
const cum = (rows) => rows.reduce((s, [, q]) => s + q, 0);

console.log('stitch (Hyperliquid layer reconciliation)');

// Bids run downward. Fine layer covers 100..98 (3 units); the coarse bucket at
// 97 aggregates 96..100 and reports 5, so 2 of them are past the fine edge.
{
  const fine = [[100, 1], [99, 1], [98, 1]];
  const coarse = [[99, 4], [97, 5]];   // cumulative 4 then 9
  eq('the straddling bucket contributes only what the fine layer could not see',
     stitch([fine, coarse], true), [[100, 1], [99, 1], [98, 1], [97, 6]]);
}
// Same shape on asks.
{
  const fine = [[100, 1], [101, 1], [102, 1]];
  const coarse = [[101, 4], [103, 5]];
  eq('asks mirror bids', stitch([fine, coarse], false),
     [[100, 1], [101, 1], [102, 1], [103, 6]]);
}
// Cumulative preservation is the whole point: the stitched total out to the
// coarse layer's edge must equal the coarse layer's own total.
{
  const fine = [[100, 1], [99, 2], [98, 3]];
  const coarse = [[99, 5], [97, 9], [95, 4]];
  const out = stitch([fine, coarse], true);
  eq('cumulative total matches the coarse layer exactly', cum(out), cum(coarse));
}
// Three layers chain the same way.
{
  const a = [[100, 1], [99, 1]];
  const b = [[99, 3], [97, 2]];
  const c = [[97, 6], [90, 4]];
  const out = stitch([a, b, c], true);
  eq('three layers still total the coarsest', cum(out), cum(c));
}
// A coarse layer entirely inside the fine one adds nothing rather than double
// counting it.
{
  const fine = [[100, 1], [99, 1], [98, 1], [97, 1]];
  const coarse = [[99, 2]];
  eq('a fully covered coarse layer adds nothing', stitch([fine, coarse], true), fine);
}
// Layers are sampled a moment apart, so a coarse layer can report a smaller
// cumulative than the fine one already holds. The seam bucket is then dropped
// rather than added whole: taking it would double count the overlap, and
// over-declaring depth is the worse error of the two (repo rule 6). The next
// update repairs it, so the cost is one stale bucket for one tick.
{
  const fine = [[100, 5], [99, 5]];
  const coarse = [[99, 3], [97, 4]];   // cumulative 3 < fine's 10
  eq('a coarse layer reporting less than the fine one never subtracts depth',
     stitch([fine, coarse], true), [[100, 5], [99, 5]]);
}
// ...but only the seam bucket is affected: everything unambiguously past it is
// still taken, so a skew cannot truncate the tail.
{
  const fine = [[100, 5], [99, 5]];
  const coarse = [[99, 3], [97, 4], [95, 6]];
  eq('a skew costs the seam bucket, not the tail',
     stitch([fine, coarse], true), [[100, 5], [99, 5], [95, 6]]);
}
// Identical layers (what a cheap coin like PUMP produces) must be idempotent.
{
  const rows = [[0.0044, 10], [0.0043, 20]];
  eq('identical layers add nothing', stitch([rows, rows, rows], true), rows);
}
// Missing layers are skipped, not treated as empty books.
{
  const fine = [[100, 1]];
  const coarse = [[100, 1], [98, 3]];
  eq('a layer that has not arrived yet is skipped',
     stitch([fine, undefined, coarse], true), [[100, 1], [98, 3]]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
