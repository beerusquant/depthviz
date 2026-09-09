/**
 * What an adapter is, stated once, and checked before the process serves.
 *
 * There are eight of them and the shape they share was written down nowhere:
 * every venue was a fresh reading of the seven others, and the only thing
 * standing between a typo and production was remembering to add a row to
 * tools/test-conformance.mjs by hand. A contract that lives in a test somebody
 * has to remember to extend is a contract about the venues that were already
 * working.
 *
 * So it is asserted at import time in ./index.js. The cost is microseconds once
 * per process; what it buys is that a missing `transport` entry or a `markets`
 * list naming something no route accepts fails at startup with the field named,
 * rather than as a 500 on the first viewer who picks that venue.
 *
 * Deliberately structural only. Whether an adapter's book is CORRECT is a
 * different question, answered by test-adapters (decoders and unit conversions,
 * from recorded frames), test-conformance (the lifecycle, all thirteen feeds)
 * and the hourly live checks. This file only guarantees that the hub can talk
 * to it at all.
 */

/** The markets a route, a UI control and a feed key are allowed to name. */
export const MARKETS = ['spot', 'perp'];

/** How a feed gets its books. Reported per market, and shown to the viewer. */
export const TRANSPORTS = ['ws', 'poll'];

const isFn = (x) => typeof x === 'function';
const isStr = (x) => typeof x === 'string' && x.length > 0;

/**
 * Throw unless `a` can be used as an adapter, naming the field that is wrong.
 *
 * `key` is the name it is registered under: it has to match `a.id`, because the
 * id is what a feed key, a Prometheus label and an /api/depth query all carry,
 * and a registry whose key and id disagree produces rows nobody can join.
 */
export function assertAdapter(a, key) {
  const bad = (msg) => { throw new Error(`adapter ${key}: ${msg}`); };

  if (!a || typeof a !== 'object') bad('is not an object');
  if (!isStr(a.id)) bad('id must be a non-empty string');
  if (a.id !== key) bad(`id is "${a.id}" but it is registered as "${key}"`);
  if (!isStr(a.name)) bad('name must be a non-empty string');

  if (!Array.isArray(a.markets) || a.markets.length === 0) bad('markets must be a non-empty array');
  for (const m of a.markets) if (!MARKETS.includes(m)) bad(`markets names "${m}", not one of ${MARKETS.join('/')}`);
  if (new Set(a.markets).size !== a.markets.length) bad('markets lists a duplicate');

  if (!a.transport || typeof a.transport !== 'object') bad('transport must be an object keyed by market');
  for (const m of a.markets) {
    if (!TRANSPORTS.includes(a.transport[m])) {
      bad(`transport.${m} is ${JSON.stringify(a.transport[m])}, not one of ${TRANSPORTS.join('/')}`);
    }
  }

  // `notes` is what the UI shows when a book does not reach the range asked
  // for, so a note filed under a market the adapter does not serve is a caveat
  // that can never be displayed — a silent typo, which is the only kind here.
  if (a.notes !== undefined) {
    if (typeof a.notes !== 'object' || a.notes === null) bad('notes must be an object keyed by market');
    for (const m of Object.keys(a.notes)) {
      if (!a.markets.includes(m)) bad(`notes has a "${m}" entry but that market is not served`);
      if (!isStr(a.notes[m])) bad(`notes.${m} must be a non-empty string`);
    }
  }

  for (const fn of ['listSymbols', 'vol24h', 'open']) {
    if (!isFn(a[fn])) bad(`${fn} must be a function`);
  }
  return a;
}

/**
 * Every (exchange, market) pair this process can serve.
 *
 * The hub, the routes and the conformance suite all need to enumerate the same
 * thing, and each of them used to do it its own way — which is how a suite
 * asserting a contract over "all thirteen feeds" can quietly cover twelve.
 */
export function feedsOf(adapters) {
  return Object.values(adapters).flatMap((a) => a.markets.map((market) => ({ exchange: a.id, market })));
}
