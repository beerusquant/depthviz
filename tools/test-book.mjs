/**
 * Deterministic tests for BookSide.applySnapshot — the resync path that decides
 * whether the accumulated deep tail survives. No network.
 *   node tools/test-book.mjs
 */
import { BookSide, coalesce } from '../server/util.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};
const side = (isBid, levels, at = Date.now()) => {
  const b = new BookSide(isBid);
  for (const [p, q] of levels) b.set(p, q, at);
  return b;
};

console.log('BookSide.applySnapshot');

// A capped snapshot must not erase depth it simply could not reach.
{
  const b = side(true, [[100, 1], [99, 1], [98, 1], [90, 5], [80, 7]]);
  const kept = b.applySnapshot([[100, 2], [99, 2], [98, 2]]);
  eq('keeps levels beyond the snapshot span', [kept, b.toArray()],
     [2, [[100, 2], [99, 2], [98, 2], [90, 5], [80, 7]]]);
}
// Inside the span the snapshot is the whole truth: a level it omits is gone.
{
  const b = side(true, [[100, 1], [99, 1], [98, 1]]);
  const kept = b.applySnapshot([[100, 2], [98, 2]]);
  eq('drops in-span levels the snapshot omits', [kept, b.toArray()], [0, [[100, 2], [98, 2]]]);
}
// Asks mirror bids: the span runs upward, the tail sits above it.
{
  const a = side(false, [[100, 1], [101, 1], [110, 5]]);
  const kept = a.applySnapshot([[100, 2], [101, 2]]);
  eq('asks keep the tail above the span', [kept, a.toArray()], [1, [[100, 2], [101, 2], [110, 5]]]);
}
// A long outage must not leave phantom depth standing.
{
  const b = side(true, [[100, 1], [90, 5]]);
  eq('keepTail:false discards the tail', [b.applySnapshot([[100, 2]], { keepTail: false }), b.toArray()],
     [0, [[100, 2]]]);
}
{
  const old = Date.now() - 10 * 60_000;
  const b = new BookSide(true);
  b.set(90, 5, old); b.set(100, 1, old);
  eq('a tail older than maxAgeMs is pruned', [b.applySnapshot([[100, 2]]), b.toArray()], [0, [[100, 2]]]);
}
{
  const b = new BookSide(true);
  b.set(90, 5, Date.now() - 60_000);          // 1 min old, inside the 5 min cap
  b.set(100, 1, Date.now());
  eq('a tail inside maxAgeMs survives', [b.applySnapshot([[100, 2]]), b.toArray()],
     [1, [[100, 2], [90, 5]]]);
}
// An empty snapshot carries no span, so nothing can be judged in or out of it.
{
  const b = side(true, [[100, 1], [90, 5]]);
  eq('an empty snapshot clears rather than guesses', [b.applySnapshot([]), b.toArray()], [0, []]);
}
// Keeping a stale price alive would be worse than dropping it: a kept level
// must carry its original timestamp so the age cap can still retire it.
{
  const t0 = Date.now() - 4 * 60_000;
  const b = new BookSide(true);
  b.set(90, 5, t0); b.set(100, 1, t0);
  b.applySnapshot([[100, 2]]);                                  // 90 survives at t0
  eq('a kept level does not have its age reset', b.applySnapshot([[100, 3]], { maxAgeMs: 3 * 60_000 }), 0);
}

// ---------------------------------------------------------------- coalesce
console.log('\ncoalesce');
{
  const seen = [];
  const c = coalesce((x) => seen.push(x), 40);
  c('a');                       // leading edge runs at once
  c('b'); c('c'); c('d');       // collapsed into one trailing call
  eq('the first call is not delayed', seen, ['a']);
  await new Promise((r) => setTimeout(r, 90));
  // The trailing call must carry the LAST arguments, not the first ones it
  // queued: a book frame's venue timestamp travels with it, and pairing a fresh
  // book with an older clock would report a latency the feed never had.
  eq('the trailing call carries the newest arguments', seen, ['a', 'd']);
  c.cancel();
}
{
  const seen = [];
  const c = coalesce((x) => seen.push(x), 40);
  c('a'); c('b');
  c.cancel();
  await new Promise((r) => setTimeout(r, 90));
  eq('cancel drops the pending call', seen, ['a']);
}
{
  const seen = [];
  const c = coalesce((x) => seen.push(x), 40);
  c('a');
  await new Promise((r) => setTimeout(r, 90));
  c('b');
  eq('a call after the window is immediate again', seen, ['a', 'b']);
  c.cancel();
}

console.log('\nstaleFraction — how much of the depth nobody has confirmed');
{
  // The venues that stream diffs reach past their capped snapshot only by
  // accumulating updates. `accum.since` says how long that has been going on;
  // this says how much of what is on screen is resting on it.
  const T = 1_000_000;
  const b = new BookSide(true);
  b.set(99, 10, T);           // 990 notional, fresh
  b.set(98, 10, T - 300_000); // 980 notional, five minutes old
  b.set(50, 10, T - 300_000); // outside a ±10% band around a mid of 100
  const near6 = (x) => (x === null ? null : +x.toFixed(6));

  eq('it weighs notional, not levels',
     near6(b.staleFraction(100, 10, 120_000, T)), near6(980 / (990 + 980)));
  eq('and it only weighs what is inside the band it was asked about',
     near6(b.staleFraction(100, 60, 120_000, T)), near6((980 + 500) / (990 + 980 + 500)));

  eq('a cutoff nothing has crossed reports none of it stale',
     b.staleFraction(100, 10, 600_000, T), 0);
  // Read a moment later, so every level has a non-zero age to compare: a level
  // set at exactly `now` is 0 ms old and is not past a 1 ms cutoff.
  eq('a cutoff everything has crossed reports all of it',
     b.staleFraction(100, 10, 1, T + 10), 1);

  // Re-touching a level makes it fresh again, which is the whole point: the
  // question is corroboration, not age of first sight.
  b.set(98, 10, T);
  eq('touching a level again makes it fresh', b.staleFraction(100, 10, 120_000, T), 0);

  // A fraction of nothing is not zero staleness: a 0 there would read as "all
  // of it confirmed" on a book that has no depth in the band at all.
  eq('an empty book reports null, not a reassuring zero',
     new BookSide(true).staleFraction(100, 10, 120_000, T), null);
  eq('and so does a band with nothing inside it',
     b.staleFraction(100, 0.001, 120_000, T), null);

  // A level a diff removed must not keep aging in the shadows.
  b.set(99, 0, T);
  eq('a cancelled level is not counted at all',
     [b.size, b.staleFraction(100, 10, 1, T + 10)], [2, 1]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
