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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ATTEMPTS = 3;

/**
 * One measurement of a coin: fetch every layer, stitch, and reconcile.
 *
 * The six layers are fetched together but they are not one atomic snapshot, so
 * the book can move between the first response and the last. That shows up as a
 * reconciliation off by a percent or so — seen once on the hourly timer, BTC at
 * the {5,m:5} edge, 1.0153, with the other nineteen exactly 1.0000.
 *
 * A stitch bug is deterministic: it is wrong on every read, of every coin. Skew
 * is not. So a coin that fails is measured again, and only a layer that fails
 * every attempt is reported — which is the difference between a check that
 * finds bugs and a check that reports the weather.
 */
async function measure(coin) {
  const [now, old] = await Promise.all([fetchLayers(coin, LAYERS), fetchLayers(coin, OLD)]);
  if (!now[0]) return { lines: [`${coin}: no book`], bad: ['no book'] };
  const nb = stitch(now.map((x) => x?.bids), true), na = stitch(now.map((x) => x?.asks), false);
  const ob = stitchOld(old.map((x) => x?.bids), true), oa = stitchOld(old.map((x) => x?.asks), false);
  const mid = (nb[0][0] + na[0][0]) / 2;

  const lines = [
    `${coin}  mid ${mid.toPrecision(7)}`,
    `  levels/side        ${ob.length}/${oa.length}  ->  ${nb.length}/${na.length}`,
    ...[0.5, 2, 10].map((pct) =>
      `  widest hole ±${String(pct).padStart(4)}%   ${worstGap(ob, mid, pct).toFixed(4)}%  ->  ${worstGap(nb, mid, pct).toFixed(4)}%`),
  ];
  const bad = [];
  let n = 0;
  for (let i = 1; i < LAYERS.length; i++) {
    const L = now[i];
    if (!L) continue;
    const cutB = L.bids.at(-1)[0], cutA = L.asks.at(-1)[0];
    const truth = total(L.bids) + total(L.asks);
    const ours = cumToPrice(nb, cutB, true) + cumToPrice(na, cutA, false);
    const before = cumToPrice(ob, cutB, true) + cumToPrice(oa, cutA, false);
    const rNew = ours / truth, rOld = before / truth;
    const ok = Math.abs(rNew - 1) < 0.002;
    n++;
    const tag = JSON.stringify(LAYERS[i]).replace(/["{}]/g, '').replace(/,/g, ' ');
    if (!ok) bad.push(tag);
    const dist = Math.abs(cutB / mid - 1) * 100;
    lines.push(`  ${ok ? 'ok  ' : 'FAIL'} to the [${tag}] edge (±${dist < 100 ? dist.toFixed(2) : '99+'}%):` +
      ` before ${rOld.toFixed(4)}  ->  after ${rNew.toFixed(4)}`);
  }
  return { lines, bad, n };
}

for (const coin of coins) {
  let r = null, attempt = 0;
  while (attempt < ATTEMPTS) {
    attempt++;
    r = await measure(coin);
    if (!r.bad.length) break;
    if (attempt < ATTEMPTS) await sleep(2500);
  }
  console.log(r.lines.join('\n'));
  if (attempt > 1) {
    console.log(r.bad.length
      ? `  (still off after ${attempt} independent reads — that is not sampling skew)`
      : `  (a layer disagreed on read ${attempt - 1}, agreed on read ${attempt}: the layers are fetched together but not atomically)`);
  }
  checks += r.n || 0;
  fails += r.bad.length;
  console.log('');
}

console.log(fails === 0
  ? `all ${checks} layer reconciliations exact — the stitched book loses no depth at any seam`
  : `${fails}/${checks} reconciliations failed`);
process.exit(fails ? 1 : 0);
