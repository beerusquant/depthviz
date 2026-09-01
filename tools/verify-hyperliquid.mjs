/**
 * Hyperliquid's book is the only one here that is ASSEMBLED rather than read,
 * so it gets its own proof. Nothing external can judge it — ccxt and the REST
 * endpoint serve the same 20 aggregated levels the adapter already consumes —
 * so the check is internal and differential.
 *
 * The test that means something: each coarse subscription is, on its own, a
 * COMPLETE measurement of cumulative quantity out to its own edge. So for every
 * layer, cumulative quantity in the stitched book taken to that layer's own
 * edge price must equal that layer's own total. Comparing on the layer's price
 * grid is what makes it exact — cutting at an arbitrary ±x% instead would
 * penalise the stitch for resolving the band more finely than the coarse layer
 * can, which is the entire point of stitching.
 *
 *   node tools/verify-hyperliquid.mjs [COIN...]
 */
import { LAYERS, stitch } from '../server/adapters/hyperliquid.js';

const post = (b) => fetch('https://api.hyperliquid.xyz/info', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then((r) => r.json());

const OLD = [{}, { nSigFigs: 3 }, { nSigFigs: 2 }];  // the ladder shipped before this change

// The rule this replaces: drop any coarse bucket that does not clear the edge
// by a full bucket width — and the depth inside it with it.
function stitchOld(sides, isBid) {
  const out = [];
  let edge = null;
  for (const rows of sides) {
    if (!rows?.length) continue;
    if (edge === null) { out.push(...rows); edge = rows[rows.length - 1][0]; continue; }
    const step = rows.length > 1 ? Math.abs(rows[0][0] - rows[1][0]) : 0;
    for (const [p, q] of rows) if (isBid ? p <= edge - step : p >= edge + step) out.push([p, q]);
    edge = out[out.length - 1][0];
  }
  return out;
}

const fetchLayers = (coin, ladder) => Promise.all(ladder.map(async (sub) => {
  const d = await post({ type: 'l2Book', coin, ...sub });
  if (!d?.levels?.[0]?.length) return null;
  return {
    bids: d.levels[0].map((l) => [+l.px, +l.sz]),
    asks: d.levels[1].map((l) => [+l.px, +l.sz]),
  };
}));

const cumToPrice = (rows, cut, isBid) =>
  rows.reduce((s, [p, q]) => ((isBid ? p >= cut : p <= cut) ? s + q : s), 0);
const total = (rows) => rows.reduce((s, [, q]) => s + q, 0);

// Widest hole between consecutive levels inside ±pct. The step that crosses the
// boundary counts: a ladder whose next level after the fine edge lands outside
// the window has the biggest hole of all, and must not be scored as flawless.
const worstGap = (rows, mid, pct) => {
  let w = 0;
  for (let i = 1; i < rows.length; i++) {
    w = Math.max(w, Math.abs(rows[i][0] - rows[i - 1][0]) / mid * 100);
    if (Math.abs(rows[i][0] / mid - 1) * 100 > pct) break;
  }
  return w;
};

let fails = 0, checks = 0;
const coins = process.argv.slice(2).length ? process.argv.slice(2) : ['BTC', 'ETH', 'PUMP', 'HYPE'];
console.log('Hyperliquid stitch — cumulative quantity vs each layer\'s own measurement\n');

for (const coin of coins) {
  const [now, old] = await Promise.all([fetchLayers(coin, LAYERS), fetchLayers(coin, OLD)]);
  if (!now[0]) { console.log(`${coin}: no book`); fails++; continue; }
  const nb = stitch(now.map((x) => x?.bids), true), na = stitch(now.map((x) => x?.asks), false);
  const ob = stitchOld(old.map((x) => x?.bids), true), oa = stitchOld(old.map((x) => x?.asks), false);
  const mid = (nb[0][0] + na[0][0]) / 2;

  console.log(`${coin}  mid ${mid.toPrecision(7)}`);
  console.log(`  levels/side        ${ob.length}/${oa.length}  ->  ${nb.length}/${na.length}`);
  for (const pct of [0.5, 2, 10]) {
    console.log(`  widest hole ±${String(pct).padStart(4)}%   ${worstGap(ob, mid, pct).toFixed(4)}%  ->  ${worstGap(nb, mid, pct).toFixed(4)}%`);
  }

  for (let i = 1; i < LAYERS.length; i++) {
    const L = now[i];
    if (!L) continue;
    const cutB = L.bids.at(-1)[0], cutA = L.asks.at(-1)[0];
    const truth = total(L.bids) + total(L.asks);
    const ours = cumToPrice(nb, cutB, true) + cumToPrice(na, cutA, false);
    const before = cumToPrice(ob, cutB, true) + cumToPrice(oa, cutA, false);
    const rNew = ours / truth, rOld = before / truth;
    const ok = Math.abs(rNew - 1) < 0.002;
    checks++; if (!ok) fails++;
    const tag = JSON.stringify(LAYERS[i]).replace(/["{}]/g, '').replace(/,/g, ' ');
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} to the [${tag}] edge (±${Math.abs(cutB / mid - 1) * 100 < 100 ? (Math.abs(cutB / mid - 1) * 100).toFixed(2) : '99+'}%):` +
      ` before ${rOld.toFixed(4)}  ->  after ${rNew.toFixed(4)}`);
  }
  console.log('');
}
console.log(fails === 0
  ? `all ${checks} layer reconciliations exact — the stitched book loses no depth at any seam`
  : `${fails}/${checks} reconciliations failed`);
process.exit(fails ? 1 : 0);
