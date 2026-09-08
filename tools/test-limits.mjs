/**
 * Deterministic tests for the two things that stand between this server and one
 * client taking all of it. No network, no waiting: the token bucket takes its
 * clock as an argument for exactly this reason.
 *
 *   node tools/test-limits.mjs
 *
 * Why they are separate modules at all: constructing a real Feed opens sockets
 * to an exchange, so a rule that lives inside the hub can only be tested
 * against the live internet. Keeping the accounting out of the thing that
 * opens sockets is what makes it provable here.
 */
import { Quota, Counter } from '../server/quota.js';
import { tokenBucket } from '../server/util.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

console.log('Quota — feeds per client');
{
  const q = new Quota(3);
  q.acquire('a', 'k1'); q.acquire('a', 'k2'); q.acquire('a', 'k3');
  ok('a client may hold up to the cap', q.count('a') === 3);

  const e = throws(() => q.acquire('a', 'k4'));
  ok('and is refused past it, with a message that says what to do',
     e && /max 3 per client/.test(e.message), e?.message);
  ok('a refusal changes nothing', q.count('a') === 3);

  // Two viewers on BTCUSDT cost ONE upstream connection. Charging the second
  // one for it would refuse the cheapest request the server can serve.
  ok('joining a feed the client already holds is free',
     q.acquire('a', 'k1') === 3 && q.count('a') === 3);

  // ...and it is refcounted, so the first release must not free the key.
  q.release('a', 'k1');
  ok('and released one reference at a time', q.count('a') === 3);
  q.release('a', 'k1');
  ok('the key is freed only when the last reference goes', q.count('a') === 2);
  ok('which makes room again', q.acquire('a', 'k4') === 3);
}
{
  const q = new Quota(1);
  q.acquire('a', 'k1');
  ok('one client at its cap does not block another', q.acquire('b', 'k9') === 1);
  ok('and the two are accounted separately', q.count('a') === 1 && q.count('b') === 1 && q.owners === 2);
  q.release('a', 'k1');
  ok('an owner holding nothing is forgotten, so the map cannot grow forever',
     q.owners === 1 && q.count('a') === 0);
  q.release('a', 'k1');
  ok('releasing what was never held is harmless', q.count('a') === 0 && q.owners === 1);
}

console.log('\nCounter — sockets per address');
{
  const c = new Counter(2);
  ok('under the cap it admits', c.add('ip') === true && c.add('ip') === true);
  ok('at the cap it refuses instead of throwing', c.add('ip') === false && c.count('ip') === 2);
  c.sub('ip');
  ok('and admits again once one goes', c.add('ip') === true);
  c.sub('ip'); c.sub('ip');
  ok('an address holding nothing is forgotten', c.owners === 0);
}

console.log('\ntokenBucket — the sustained rate on the routes that reach an exchange');
{
  const b = tokenBucket(3, 1);   // burst 3, one per second
  const t0 = 1_000_000;
  ok('the burst is spendable at once',
     b.take('ip', t0) === null && b.take('ip', t0) === null && b.take('ip', t0) === null);

  const wait = b.take('ip', t0);
  ok('the next call is refused', wait !== null);
  // The point of returning the wait: Retry-After has to be a number the caller
  // can trust, not a guess. At 1/s an empty bucket is one second from a token.
  ok('and it says how long to wait, in seconds', Math.abs(wait - 1) < 1e-9, String(wait));

  ok('a second later exactly one call is allowed',
     b.take('ip', t0 + 1000) === null && b.take('ip', t0 + 1000) !== null);

  // Capacity is a ceiling, not a bank: idling for an hour must not buy 3600
  // calls in one burst.
  const c = tokenBucket(3, 1);
  c.take('ip', t0);
  for (let i = 0; i < 3; i++) ok(`refill is capped at the burst (${i + 1}/3)`, c.take('ip', t0 + 3600_000) === null);
  ok('and no further', c.take('ip', t0 + 3600_000) !== null);

  ok('two addresses do not share a budget',
     tokenBucket(1, 1).take('a', t0) === null && b.take('other', t0) === null);
}
{
  // The bucket map is keyed by remote address, so it grows with whoever calls.
  // An entry that has refilled to full is indistinguishable from a new one.
  const b = tokenBucket(2, 1);
  const t0 = 1_000_000;
  b.take('a', t0); b.take('b', t0);
  ok('busy entries are kept', b.sweep(t0 + 1000) === 2);
  ok('idle ones are forgotten', b.sweep(t0 + 60_000) === 0);
  ok('and forgetting one gives it a full bucket, which is what it had',
     b.take('a', t0 + 60_000) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
