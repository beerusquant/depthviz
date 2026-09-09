/**
 * Deterministic tests for the cross-venue sum. No network, no clock of its own.
 *
 *   node tools/test-aggregate.mjs
 *
 * What they exist to pin: adding depth across venues by hand is wrong in four
 * ways that all produce a plausible total — each venue measured on its own mid,
 * books that were not simultaneous, a leg that failed and simply is not there,
 * and a venue whose book stops inside the band contributing a floor to a sum
 * presented as a measurement. Each of those has a test below, because each of
 * them is invisible in the answer.
 */
import { aggregate } from '../server/aggregate.js';
import { notionalWithin } from '../shared/metrics.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

const T = 1_000_000;
/** A flat book of `n` levels a tick apart, `qty` on each, around `mid`. */
const book = (mid, n = 200, qty = 1, tick = 0.01) => ({
  bids: Array.from({ length: n }, (_, i) => [mid - tick * (i + 1), qty]),
  asks: Array.from({ length: n }, (_, i) => [mid + tick * (i + 1), qty]),
});
const reading = (exchange, mid, opts = {}) => {
  const b = opts.book || book(mid);
  const far = (rows) => Math.abs(rows[rows.length - 1][0] / mid - 1) * 100;
  return {
    exchange, market: 'spot', symbol: 'X', quote: opts.quote ?? 'USDT',
    bids: b.bids, asks: b.asks, mid,
    tsVenue: opts.tsVenue ?? null, tsRecv: opts.tsRecv ?? T,
    reach: { bid: far(b.bids), ask: far(b.asks) },
  };
};

console.log('notionalWithin — one band of prices, not one band per venue');
{
  const bids = [[100, 1], [99, 2], [98, 3], [90, 4]];
  ok('it sums the levels inside the band', near(notionalWithin(bids, true, 98, 100), 100 + 198 + 294));
  ok('a level above the band is skipped, not counted', near(notionalWithin(bids, true, 98, 99), 198 + 294));
  ok('and the walk stops at the far edge', near(notionalWithin(bids, true, 99, 100), 100 + 198));

  const asks = [[101, 1], [102, 2], [110, 3]];
  ok('the ask side is the mirror', near(notionalWithin(asks, false, 101, 102), 101 + 204));
  ok('a level below the band is skipped there too', near(notionalWithin(asks, false, 102, 110), 204 + 330));

  // Round numbers are where real books put their size, and 98/100 - 1 is not
  // exactly -2% in binary floating point.
  ok('a level exactly on an edge is inside it', near(notionalWithin(bids, true, 98, 98), 294));
  ok('an empty band is zero, not the whole book', notionalWithin(bids, true, 101, 102) === 0);
}

console.log('\naggregate — one reference band');
{
  // Two venues 20 bps apart. Measured each on its OWN ±2%, both would report
  // their whole book; measured on one reference band they cannot both.
  const a = aggregate([reading('a', 100), reading('b', 100.2)], [], 2, T);
  ok('the reference mid is the median of the venue mids', near(a.reference.mid, 100.1));
  ok('and the band is absolute prices, stated', near(a.reference.lo, 100.1 * 0.98) && near(a.reference.hi, 100.1 * 1.02));
  ok('every venue reports how far its own touch sits from that reference',
     near(a.venues.find((v) => v.exchange === 'a').midOffsetBps, (100 / 100.1 - 1) * 10_000),
     JSON.stringify(a.venues.map((v) => [v.exchange, +v.midOffsetBps.toFixed(2)])));
  ok('the total is the sum of what each venue has inside that one band',
     near(a.total.totalDepth, a.venues.reduce((s, v) => s + v.totalDepth, 0)));
  ok('and each venue carries its share of it',
     near(a.venues.reduce((s, v) => s + v.share, 0), 1), JSON.stringify(a.venues.map((v) => v.share)));

  // The offset is the whole point: venue `a`'s bids run from 99.99 downward, so
  // everything between the reference mid 100.1 and 99.99 is depth it does not
  // have, while `b` does. Summing two ±2% bands would have hidden that.
  const va = a.venues.find((v) => v.exchange === 'a');
  const vb = a.venues.find((v) => v.exchange === 'b');
  ok('a venue quoting below the reference contributes less bid depth than one at it',
     va.bidDepth < vb.bidDepth, `${va.bidDepth} vs ${vb.bidDepth}`);
  ok('and correspondingly more ask depth', va.askDepth > vb.askDepth, `${va.askDepth} vs ${vb.askDepth}`);

  // The median is what keeps one dislocated or stale venue from dragging the
  // band it is measured against.
  const withOutlier = aggregate([reading('a', 100), reading('b', 100.2), reading('c', 130)], [], 2, T);
  ok('one dislocated venue does not move the reference', near(withOutlier.reference.mid, 100.2),
     `${withOutlier.reference.mid}`);
  ok('it is still counted, and its offset says how far out it is',
     withOutlier.venues.some((v) => v.exchange === 'c' && v.midOffsetBps > 2000));
}

console.log('\naggregate — the four things that make a plausible total wrong');
{
  // 1. A leg that failed must not simply be absent.
  const partial = aggregate([reading('a', 100)], [{ exchange: 'b', reason: 'HTTP 429' }], 2, T);
  ok('a sum with a leg missing is not reported as complete', partial.complete === false);
  ok('and the failure is named with its reason',
     partial.missing[0].exchange === 'b' && /429/.test(partial.missing[0].reason));
  ok('a sum with nothing missing is complete', aggregate([reading('a', 100)], [], 2, T).complete === true);

  // 2. The books were not simultaneous.
  const skewed = aggregate([
    reading('a', 100, { tsRecv: T - 2000 }),
    reading('b', 100, { tsRecv: T - 40 }),
  ], [], 2, T);
  ok('the spread between the two reads is reported', skewed.asOf.spanMs === 1960, JSON.stringify(skewed.asOf));
  ok('with the oldest and newest ages beside it',
     skewed.asOf.oldestAgeMs === 2000 && skewed.asOf.newestAgeMs === 40);
  ok('a simultaneous pair reports a zero span, which is a fact and not a default',
     aggregate([reading('a', 100), reading('b', 100)], [], 2, T).asOf.spanMs === 0);

  // 3. A venue whose book stops inside the band contributes a floor, and a
  //    total containing a floor is a floor.
  const shallow = aggregate([reading('a', 100), reading('b', 100, { book: book(100, 2) })], [], 2, T);
  ok('a venue that cannot fill the band is marked a floor',
     shallow.venues.find((v) => v.exchange === 'b').lowerBound.bidDepth === true);
  ok('and that propagates to the total', shallow.total.lowerBound.bidDepth === true);
  const deep = aggregate([reading('a', 100, { book: book(100, 5000) })], [], 2, T);
  ok('a venue that fills it and is not accumulating is not marked',
     deep.total.lowerBound.bidDepth === false, JSON.stringify(deep.total.lowerBound));
  ok('and it carries no reasons at all', deep.venues[0].lowerBound.reasons.length === 0);

  // 3b. ...and so does a venue that is still rebuilding its depth from a capped
  //     snapshot, which is the same claim for a different reason. Measured live:
  //     a Binance feed two seconds old showed $75M against MEXC's $721M on the
  //     same band — the age of the feed, not the liquidity of the venue.
  const young = aggregate([
    reading('a', 100, { book: book(100, 5000) }),
    { ...reading('b', 100, { book: book(100, 5000) }), accum: { since: T - 3000 } },
  ], [], 2, T);
  const vb2 = young.venues.find((v) => v.exchange === 'b');
  ok('a venue still accumulating contributes a floor even with a book that fills the band',
     vb2.lowerBound.bidDepth === true && vb2.lowerBound.askDepth === true,
     JSON.stringify(vb2.lowerBound));
  ok('and the reason says which of the two it is',
     /accumulating for 3s/.test(vb2.lowerBound.reasons.join('|')), JSON.stringify(vb2.lowerBound.reasons));
  ok('the age of that accumulation travels with it', vb2.accumulating.sinceMs === 3000);
  ok('a venue that is not accumulating says so with null, not a zero age',
     young.venues.find((v) => v.exchange === 'a').accumulating === null);
  ok('and it does not inherit the other venue\'s caveat',
     young.venues.find((v) => v.exchange === 'a').lowerBound.reasons.length === 0);
  ok('but the total does, because one floor makes the sum a floor',
     young.total.lowerBound.bidDepth === true);

  // 4. Different settlement currencies are being added as one unit.
  const mixed = aggregate([reading('a', 100), reading('b', 100, { quote: 'USD' })], [], 2, T);
  ok('mixing quote currencies is stated, never silently corrected',
     mixed.mixedQuotes === true && mixed.quotes.length === 2, JSON.stringify(mixed.quotes));
  ok('a single quote currency is not flagged',
     aggregate([reading('a', 100), reading('b', 100)], [], 2, T).mixedQuotes === false);
}

console.log('\naggregate — the degenerate cases');
{
  const none = aggregate([], [{ exchange: 'a', reason: 'timeout' }], 2, T);
  ok('no readings yields no reference rather than a mid of zero', none.reference === null);
  ok('and no total rather than a total of zero', none.total === null);
  ok('and it is certainly not complete', none.complete === false);

  const oneSided = aggregate([{ ...reading('a', 100), asks: [] }], [], 2, T);
  ok('a one-sided book is not usable and is dropped from the sum', oneSided.reference === null);

  const single = aggregate([reading('a', 100)], [], 2, T);
  ok('one venue is its own reference', near(single.reference.mid, 100));
  ok('and holds the whole share', near(single.venues[0].share, 1));

  // Two venues have no middle value; their midpoint is the only defensible one.
  ok('two venues resolve to their midpoint',
     near(aggregate([reading('a', 100), reading('b', 102)], [], 2, T).reference.mid, 101));

  // The venues are ordered by what they contribute, because that is the
  // question being asked.
  const ranked = aggregate([
    reading('a', 100, { book: book(100, 10) }),
    reading('b', 100, { book: book(100, 400) }),
  ], [], 2, T);
  ok('venues come back ordered by the depth they contribute',
     ranked.venues[0].exchange === 'b', JSON.stringify(ranked.venues.map((v) => v.exchange)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
