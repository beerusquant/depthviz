/**
 * Read a recording back: what is in it, and what the metrics did over it.
 *
 *   node tools/replay.mjs data/binance-spot-BTCUSDT-2026-09-08T18-00-00.jsonl
 *   node tools/replay.mjs <file> --csv --range 2 > depth.csv
 *
 * The point is not to look at a chart again. It is that a figure this tool
 * printed a month ago can be recomputed today, on the same bytes, with the same
 * `shared/metrics.js` the panel and /api/depth use — so "median depth at ±2% was
 * $70M" becomes a claim somebody can check instead of a number in a comment.
 *
 * It reports gaps before it reports anything else. A capture that lost four
 * minutes to a reconnect has a perfectly plausible book on either side of the
 * hole, and a distribution computed straight across it quietly mixes two
 * regimes.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parse, summarize, distribution } from './lib/recording.mjs';
import { computeMetrics, fmtUsd } from '../shared/metrics.js';

const file = process.argv[2];
if (!file) { console.error('usage: node tools/replay.mjs <recording.jsonl> [--csv] [--range 2]'); process.exit(2); }
const csv = process.argv.includes('--csv');
const ri = process.argv.indexOf('--range');
const range = ri > 0 ? +process.argv[ri + 1] : 2;

const bytes = readFileSync(file);
// Recordings are large enough that --gzip is the normal case, so both are read
// without the caller having to say which this is.
const rec = parse((file.endsWith('.gz') || (bytes[0] === 0x1f && bytes[1] === 0x8b) ? gunzipSync(bytes) : bytes).toString('utf8'));
if (!rec.header) { console.error('replay: no header line — this is not a depthviz recording'); process.exit(2); }
const s = summarize(rec);

if (!csv) {
  const h = rec.header;
  console.log(`${h.exchange} ${h.market} ${h.symbol}`);
  console.log(`  started        ${new Date(h.startedAt).toISOString()}`);
  console.log(`  samples        ${s.books} over ${(s.spanMs / 60_000).toFixed(1)} min, every ${h.intervalMs}ms`);
  console.log(`  levels         ${s.levels?.min}..${s.levels?.max} (both sides, before reduction)`);
  console.log(`  clipped at     ${h.clipPct == null ? 'nothing' : `±${h.clipPct}%`}`);
  console.log(`  venue clock    ${s.clockless === 0 ? 'every sample' : s.clockless === s.books ? 'never (this venue stamps nothing)' : `missing on ${s.clockless}/${s.books} samples`}`);
  // A recording with no end marker is a crashed run. Saying so is the whole
  // reason the marker exists.
  console.log(`  complete       ${rec.complete ? 'yes' : 'NO — no end marker, this run did not finish'}`);
  if (s.gaps.length) {
    console.log(`  gaps           ${s.gaps.length}: ${s.gaps.slice(0, 5).map((g) => `${(g.ms / 1000).toFixed(1)}s`).join(', ')}${s.gaps.length > 5 ? ' …' : ''}`);
    console.log('                 a distribution across these mixes two regimes — filter or split first');
  } else {
    console.log('  gaps           none');
  }
  if (rec.bad) console.log(`  unreadable     ${rec.bad} line(s)`);
}

const rows = [];
for (const b of rec.books) {
  const m = computeMetrics(b, range);
  if (!m) continue;
  rows.push({ t: b.tsRecv, tsVenue: b.tsVenue, m });
}
if (!rows.length) { console.error('replay: no usable book in this recording'); process.exit(1); }

if (csv) {
  console.log('tsRecv,tsVenue,venueLatencyMs,mid,spreadBps,bidDepth,askDepth,totalDepth,depthMinus2,depthPlus2,imbalance,bidReach,askReach');
  for (const r of rows) {
    const m = r.m;
    console.log([
      r.t, r.tsVenue ?? '', r.tsVenue != null ? r.t - r.tsVenue : '',
      m.mid, (m.spreadPct * 100).toFixed(6),
      m.bidDepth.toFixed(2), m.askDepth.toFixed(2), m.totalDepth.toFixed(2),
      m.depthMinus2.toFixed(2), m.depthPlus2.toFixed(2),
      m.imbalance.toFixed(6), m.bid.reach.toFixed(4), m.ask.reach.toFixed(4),
    ].join(','));
  }
  process.exit(0);
}

// Distributions, not a single reading: one sample on a thin book can be twice
// the next one with nothing broken, which is why this repo judges on medians.
const show = (label, xs, fmt) => {
  const d = distribution(xs);
  if (!d) return;
  console.log(`  ${label.padEnd(22)} median ${fmt(d.median).padStart(12)}   p95 ${fmt(d.p95).padStart(12)}   min ${fmt(d.min).padStart(12)}   max ${fmt(d.max).padStart(12)}   n=${d.n}`);
};
const bps = (x) => `${(x * 100).toFixed(3)} bps`;
console.log(`\nover ±${range}%, n=${rows.length}`);
show('total depth', rows.map((r) => r.m.totalDepth), fmtUsd);
show('bid depth', rows.map((r) => r.m.bidDepth), fmtUsd);
show('ask depth', rows.map((r) => r.m.askDepth), fmtUsd);
show('spread', rows.map((r) => r.m.spreadPct), bps);
show('imbalance', rows.map((r) => r.m.imbalance), (x) => x.toFixed(4));
show('bid reach %', rows.map((r) => r.m.bid.reach), (x) => `${x.toFixed(3)}%`);
const lat = rows.filter((r) => r.tsVenue != null).map((r) => r.t - r.tsVenue);
if (lat.length) show('venue→us ms', lat, (x) => `${x.toFixed(0)} ms`);
else console.log('  venue→us               no venue clock on this feed — nothing to report, and nothing invented');
