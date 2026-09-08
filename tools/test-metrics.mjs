/**
 * Deterministic tests for computeMetrics — the function behind every number in
 * the panel and every pixel of the curve. No network, no DOM.
 *
 * It had no coverage at all, which is backwards: the adapters are checked
 * against ccxt hourly, while the arithmetic that turns their books into "$3.19M
 * of bid depth" was never checked against anything.
 *   node tools/test-metrics.mjs
 */
import { computeMetrics, fmtUsd, fmtPct, fmtBps, fmtAge, panelRows, IMBALANCE_THRESHOLD } from '../shared/metrics.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

console.log('computeMetrics');

// A symmetric book around a mid of 100: bids at 99.9/99.5/95, asks mirrored.
const book = {
  bids: [[99.9, 1], [99.5, 2], [95, 10]],
  asks: [[100.1, 1], [100.5, 2], [105, 10]],
};

{
  const m = computeMetrics(book, 10);
  ok('mid is the midpoint of the touch', near(m.mid, 100));
  ok('best bid and ask are the touch', m.bestBid === 99.9 && m.bestAsk === 100.1);
  ok('spread is quoted in percent of mid', near(m.spreadPct, 0.2), `${m.spreadPct}`);
}
{
  // Depth is cumulative NOTIONAL, not quantity: the difference is the whole
  // point of a depth chart, and getting it backwards would be invisible.
  const m = computeMetrics(book, 10);
  const expectBid = 99.9 * 1 + 99.5 * 2 + 95 * 10;
  ok('bid depth is cumulative notional inside the range', near(m.bidDepth, expectBid),
     `${m.bidDepth} vs ${expectBid}`);
  ok('total depth is both sides', near(m.totalDepth, m.bidDepth + m.askDepth));
}
{
  // The range must actually bound what is counted.
  const m = computeMetrics(book, 1);
  ok('a level outside the range is excluded', near(m.bidDepth, 99.9 * 1 + 99.5 * 2),
     `${m.bidDepth}`);
  ok('but the ±2% and ±5% figures are independent of the range',
     near(m.depthMinus5, 99.9 + 99.5 * 2 + 95 * 10), `${m.depthMinus5}`);
}
{
  // The boundary itself. |95/100 - 1| * 100 is 5.000000000000004 in binary
  // floating point, so a level exactly at -5% used to fall out of the "-5%
  // depth" figure — and round numbers are exactly where real books put size.
  const m = computeMetrics(book, 5);
  ok('a level exactly on the boundary counts as inside it',
     near(m.depthMinus5, 99.9 + 99.5 * 2 + 95 * 10) && near(m.bidDepth, m.depthMinus5),
     `d5=${m.depthMinus5} inRange=${m.bidDepth}`);
}
{
  const m = computeMetrics(book, 10);
  const vwap = (99.9 * 1 + 99.5 * 2 + 95 * 10) / 13;
  ok('bid VWAP is notional over quantity', near(m.bidVwap, vwap), `${m.bidVwap} vs ${vwap}`);
  ok('VWAP is also reported as a distance from mid', near(m.bidVwapPct, (vwap / 100 - 1) * 100));
}
{
  const m = computeMetrics(book, 10);
  // Symmetric in QUANTITY, not in notional — the asks sit at higher prices, so
  // a perfectly mirrored book still carries a small positive ask imbalance.
  // That is the measure doing its job, not a flaw.
  ok('a mirrored book is neutral', Math.abs(m.imbalance) < IMBALANCE_THRESHOLD && m.imbalanceLabel === 'NEUTRAL',
     `imbalance=${m.imbalance} ${m.imbalanceLabel}`);
}
{
  const heavy = { bids: [[99.9, 100], [99, 100]], asks: [[100.1, 1], [101, 1]] };
  const m = computeMetrics(heavy, 10);
  ok('a bid-heavy book reports BID-heavy', m.imbalance > IMBALANCE_THRESHOLD && m.imbalanceLabel === 'BID-heavy',
     `imbalance=${m.imbalance}`);
  const thin = { bids: [[99.9, 1], [99, 1]], asks: [[100.1, 100], [101, 100]] };
  ok('and the mirror image reports ASK-heavy', computeMetrics(thin, 10).imbalanceLabel === 'ASK-heavy');
  ok('imbalance is bounded to [-1, 1]', Math.abs(m.imbalance) <= 1);
}
{
  // The truncation flags drive the note under the chart: they must fire when
  // the venue's book stops short of the requested range, and only then.
  const short = { bids: [[99.9, 1], [99.8, 1]], asks: [[100.1, 1], [100.2, 1]] };
  const m = computeMetrics(short, 5);
  ok('a book that stops short flags both sides', m.shortBid && m.shortAsk);
  ok('a book that fills the range flags neither',
     !computeMetrics(book, 1).shortBid && !computeMetrics(book, 1).shortAsk);
  const lopsided = { bids: [[99.9, 1], [90, 1]], asks: [[100.1, 1], [100.2, 1]] };
  const l = computeMetrics(lopsided, 5);
  ok('and it distinguishes the two sides', !l.shortBid && l.shortAsk,
     `shortBid=${l.shortBid} shortAsk=${l.shortAsk}`);
}
{
  ok('an empty book yields no metrics', computeMetrics({ bids: [], asks: [] }, 2) === null);
  ok('a one-sided book yields no metrics', computeMetrics({ bids: [[1, 1]], asks: [] }, 2) === null);
}
{
  // The histogram bins are what the raw-level bars draw; their total must be
  // the same notional the curve reports, or the two disagree on screen.
  const m = computeMetrics(book, 10);
  const binned = m.bid.bins.reduce((s, v) => s + v, 0);
  ok('the histogram bins sum to the same depth as the curve', near(binned, m.bidDepth),
     `${binned} vs ${m.bidDepth}`);
}
{
  ok('formatting is human and unit-safe',
     fmtUsd(1234) === '$1.23K' && fmtUsd(1.5e6) === '$1.50M' && fmtUsd(null) === 'n/a'
     && fmtPct(0.12345) === '0.123%');
}

{
  // Book age is the panel's only claim about time, and the two clocks behind it
  // mean different things: a feed with no exchange timestamp must say so rather
  // than report a latency it never measured.
  const t = 1_700_000_000_000;
  ok('a venue clock gives both the age and the upstream latency',
     fmtAge({ tsRecv: t, tsVenue: t - 40, now: t + 120 }) === '120ms \u00b7 venue\u2192us 40ms',
     fmtAge({ tsRecv: t, tsVenue: t - 40, now: t + 120 }));
  ok('a feed without a venue clock says so instead of reporting zero latency',
     fmtAge({ tsRecv: t, tsVenue: null, now: t + 2500 }) === '2.5s \u00b7 no venue clock',
     fmtAge({ tsRecv: t, tsVenue: null, now: t + 2500 }));
  ok('clock skew is shown, not clamped away',
     fmtAge({ tsRecv: t, tsVenue: t + 30, now: t }) === '0ms \u00b7 venue\u2192us -30ms',
     fmtAge({ tsRecv: t, tsVenue: t + 30, now: t }));
  ok('no book means no age', fmtAge({ tsRecv: null, tsVenue: null, now: t }) === 'n/a');
}

// The spread is the number a market maker reads first, and as a percentage it
// rendered as exactly `0.0000%` on the instrument where it matters most: one
// tick on Binance BTC/USDT is 0.0000127%.
{
  ok('a one-tick BTC spread keeps its digits', fmtBps(0.01 / 78744.52 * 100) === '0.0013 bps',
     fmtBps(0.01 / 78744.52 * 100));
  ok('a wide book reads in whole basis points', fmtBps(0.05) === '5.00 bps' && fmtBps(3) === '300 bps',
     `${fmtBps(0.05)} / ${fmtBps(3)}`);
  ok('no spread is not a rounding artefact', fmtBps(0) === '0 bps' && fmtBps(null) === 'n/a');
}

// Every band-scoped row states the band it was measured over, and the fixed
// thresholds are not repeated when the range already is that threshold.
{
  const meta = { exchangeName: 'X', market: 'spot', display: 'A/B', vol24h: 1, tsRecv: 1, tsVenue: 1 };
  const labels = (r) => panelRows(computeMetrics(book, r), meta).map(([l]) => l);
  ok('band-scoped labels carry their band', labels(0.5).includes('Bid Depth (±0.5%)'),
     labels(0.5).join(' | '));
  ok('±2% is not printed twice at range 2', !labels(2).some((l) => l === '+2% Depth'));
  ok('but it is still there at range 5', labels(5).includes('+2% Depth'));
}

// A book that reaches past the range has a KNOWN cumulative depth at the edge;
// one that stops short does not, and must not be drawn there.
{
  const m = computeMetrics(book, 2);        // deepest ask inside ±2% is at +0.5%
  ok('the curve is carried to the edge when the book reaches past it',
     m.ask.pts.at(-1)[0] === 2 && m.ask.pts.at(-1)[1] === m.askDepth,
     JSON.stringify(m.ask.pts));
  ok('and the depth it reports is unchanged by that',
     m.askDepth === 100.1 * 1 + 100.5 * 2, `${m.askDepth}`);

  const short = computeMetrics({ bids: [[99.99, 1]], asks: [[100.01, 1]] }, 2);
  ok('a book that stops short is not extended', short.ask.pts.at(-1)[0] < 2 && short.shortAsk,
     JSON.stringify(short.ask.pts));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
