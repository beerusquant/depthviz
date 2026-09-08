/**
 * Deterministic tests for the recording format. No network.
 *
 *   node tools/test-recording.mjs
 *
 * The format carries two claims that are easy to break and impossible to notice
 * afterwards: that levels are stored raw in base units, and that a file is only
 * a finished recording when it says so. A partial JSONL is byte-for-byte
 * plausible — same header, same book lines, nothing missing except the end —
 * and a run that concluded from its size that a capture had finished has
 * already cost this repo half an hour once.
 */
import { header, bookRow, endRow, encode, parse, summarize, distribution, quantile, FORMAT } from './lib/recording.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};

const MID = 100;
const book = (t, tsVenue = null) => ({
  tsRecv: t, ts: tsVenue, tsVenue, source: 'ws', mid: MID,
  bids: [[99.9, 1], [99, 2], [80, 3]],
  asks: [[100.1, 1], [101, 2], [120, 3]],
  levels: [3, 3],
});

console.log('recording — round trip');
{
  const lines = [
    encode(header({ startedAt: 1000, exchange: 'binance', market: 'spot', symbol: 'BTCUSDT', intervalMs: 1000, clipPct: 12 })),
    encode(bookRow(book(2000), null)),
    encode(bookRow(book(3000), null)),
    encode(endRow({ books: 2, written: 2 })),
  ].join('');
  const rec = parse(lines);
  ok('the header survives', rec.header?.exchange === 'binance' && rec.header.v === FORMAT);
  ok('every book comes back', rec.books.length === 2 && rec.books[0].tsRecv === 2000);
  ok('and the levels come back as numbers, not strings',
     rec.books[0].bids.every(([p, q]) => typeof p === 'number' && typeof q === 'number'));
  ok('a finished run is marked complete', rec.complete === true && rec.end.written === 2);
}
{
  // The failure the end marker exists for.
  const partial = [
    encode(header({ startedAt: 1000, exchange: 'okx', market: 'perp', symbol: 'BTC-USDT-SWAP', intervalMs: 1000, clipPct: 12 })),
    encode(bookRow(book(2000), null)),
  ].join('');
  const rec = parse(partial);
  ok('a crashed capture is readable', rec.books.length === 1 && rec.header?.exchange === 'okx');
  ok('but it is NOT complete, whatever its size says', rec.complete === false && rec.end === null);
  ok('and summarize carries that through', summarize(rec).complete === false);
}
{
  // A line torn in half by a kill -9 must cost that line and nothing else.
  const torn = `${encode(header({ startedAt: 1, exchange: 'a', market: 'spot', symbol: 'S', intervalMs: 1000, clipPct: null }))}${encode(bookRow(book(2000), null))}{"k":"b","tsRecv":30`;
  const rec = parse(torn);
  ok('a half-written last line is dropped, not fatal', rec.books.length === 1 && rec.bad === 1);
}

console.log('\nbookRow — what is kept and what is refused');
{
  const full = bookRow(book(1), null);
  ok('with no clip, every level is kept', full.bids.length === 3 && full.asks.length === 3);
  // ±2% of 100 keeps 99.9/99 and 100.1/101, drops 80 and 120.
  const clipped = bookRow(book(1), 2);
  ok('a clip drops what is outside it, from both sides',
     clipped.bids.length === 2 && clipped.asks.length === 2,
     JSON.stringify([clipped.bids, clipped.asks]));
  ok('and the reported level count is the book\'s, not the clipped copy\'s',
     clipped.levels[0] === 3 && clipped.levels[1] === 3);
  // The reduction the socket applies must never reach the archive: these are
  // the venue's own prices, not [vwapPrice, summedQty] buckets.
  ok('levels are stored exactly as the adapter produced them',
     JSON.stringify(full.bids) === JSON.stringify(book(1).bids));
}
{
  // A venue clock is recorded or it is null. Never Date.now().
  const stamped = bookRow(book(5000, 4950), null);
  ok('a venue clock is kept as the venue sent it', stamped.tsVenue === 4950);
  const bare = bookRow(book(5000), null);
  ok('and a venue that stamps nothing is recorded as having no clock, not as instant',
     bare.tsVenue === null && bare.tsRecv === 5000);
}

console.log('\nsummarize — the gaps that would ruin a distribution');
{
  const mk = (times, opts = {}) => parse(
    encode(header({ startedAt: times[0], exchange: 'x', market: 'spot', symbol: 'S', intervalMs: 1000, clipPct: null }))
    + times.map((t) => encode(bookRow(book(t, opts.clock ? t - 40 : null), null))).join(''),
  );
  const even = mk([0, 1000, 2000, 3000, 4000]);
  ok('a clean capture reports no gap', summarize(even).gaps.length === 0);
  ok('and full coverage of its own span', Math.abs(summarize(even).coverage - 1) < 1e-9);

  const holed = mk([0, 1000, 2000, 60_000, 61_000]);
  const s = summarize(holed);
  ok('a hole longer than three sample intervals is reported',
     s.gaps.length === 1 && s.gaps[0].ms === 58_000, JSON.stringify(s.gaps));
  ok('and the coverage says how much of the span is actually there',
     s.coverage < 0.1, String(s.coverage));

  ok('a feed with no venue clock is counted, not hidden',
     summarize(mk([0, 1000])).clockless === 2 && summarize(mk([0, 1000], { clock: true })).clockless === 0);
  ok('an empty recording summarizes to zero, never to null fields',
     summarize({ books: [], header: null, complete: false }).books === 0);
}

console.log('\ndistribution — the four numbers a threshold must be quoted with');
{
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const d = distribution(xs);
  ok('median is the middle, interpolated on an even sample', d.median === 5.5);
  ok('p95 is interpolated too, not the nearest sample', Math.abs(d.p95 - 9.55) < 1e-9, String(d.p95));
  ok('n travels with the figures — a quantile without one is not a measurement', d.n === 10);
  ok('min and max are the real ends', d.min === 1 && d.max === 10);
  ok('a NaN in the sample is dropped, not propagated',
     distribution([1, NaN, 3, null, 5]).n === 3 && distribution([1, NaN, 3, null, 5]).median === 3);
  ok('an empty sample is null, not a zeroed distribution that looks measured',
     distribution([]) === null && quantile([], 0.5) === null);
  ok('a single sample is its own every quantile', distribution([7]).median === 7 && distribution([7]).p95 === 7);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
