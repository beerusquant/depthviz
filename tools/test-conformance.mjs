/**
 * One contract, applied to all thirteen feeds. No network.
 *
 *   node tools/test-conformance.mjs
 *
 * Why it exists: tools/test-adapters.mjs proves the DECODERS — that a field is
 * read, that a multiplier is applied, that a side is not swapped. It says
 * nothing about the LIFECYCLE, and every lifecycle bug this repo has had was
 * found in production on one venue and then fixed on that venue alone:
 *
 *   - a Hyperliquid layer that dropped out kept its last snapshot in the stitch
 *     forever, serving frozen depth as live;
 *   - MEXC published `Date.now()` where the venue's clock belonged, so a feed
 *     with no clock and one with a perfect one looked identical;
 *   - Binance perp stayed pinned to its REST snapshot from the day it was
 *     written, and the chart was a plausible book the whole time.
 *
 * Each of those is now tested — on the adapter it happened to. This file asks
 * the same questions of all thirteen, because the next one will land somewhere
 * else. Every frame and every REST body below is a real capture in
 * tools/fixtures/venues.json.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters } from '../server/adapters/index.js';
import { assertAdapter, feedsOf } from '../server/adapters/contract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(readFileSync(path.join(here, 'fixtures', 'venues.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};
const flush = (ms = 320) => new Promise((r) => setTimeout(r, ms));

// The moment this run began. Every recorded venue timestamp is older than it,
// and `Date.now()` is never older than it — which is what makes "the venue's
// clock, or null" checkable without knowing each venue's field.
const T0 = Date.now();

/** A fleet of fake transports: adapters that open six sockets get six. */
function fakeFleet() {
  const conns = [];
  const factory = (url, handlers) => {
    const c = { url, handlers, sent: [], closed: 0 };
    c.send = (o) => c.sent.push(typeof o === 'string' ? o : JSON.stringify(o));
    conns.push(c);
    queueMicrotask(() => handlers.onOpen?.(c.send));
    return { send: c.send, close() { c.closed++; } };
  };
  return {
    conns,
    factory,
    feed(i, o) { conns[i]?.handlers.onMessage?.(Buffer.isBuffer(o) || typeof o === 'string' ? o : JSON.stringify(o), conns[i].send); },
    status(i, st, d) { conns[i]?.handlers.onStatus?.(st, d); },
    all(st, d) { for (const c of conns) c.handlers.onStatus?.(st, d); },
  };
}

/**
 * Route a REST call to a recorded body, or fail loudly rather than reach out.
 *
 * Held shut until the test opens it, which is what makes "publishes nothing
 * before the venue has said anything" a real question. With an instant stub
 * every adapter that fetches a snapshot at open — five of them — answers itself
 * before the test can look, and the poller answers itself twice.
 */
function stubFetch(routes) {
  const real = globalThis.fetch;
  const misses = [];
  let open = false;
  const waiting = [];
  const gate = () => (open ? Promise.resolve() : new Promise((r) => waiting.push(r)));
  globalThis.fetch = async (url) => {
    await gate();
    const u = String(url);
    for (const [needle, body] of routes) {
      if (u.includes(needle)) return { ok: true, status: 200, json: async () => body };
    }
    misses.push(u);
    return { ok: false, status: 599, json: async () => ({}) };
  };
  return {
    misses,
    release() { open = true; for (const r of waiting.splice(0)) r(); },
    restore() { globalThis.fetch = real; },
  };
}

// The five diff venues carry a snapshot and the frame that anchors to it,
// captured in the same instant (see grabPair in tools/capture-fixtures.mjs).
// Splicing two captures taken minutes apart instead produced a CROSSED book —
// a bid above an ask — which looks exactly like an adapter bug and is a fixture
// that was assembled rather than recorded.
const A = F.anchored;

const VENUES = [
  {
    id: 'binance spot', exchange: 'binance', market: 'spot', symbol: 'BTCUSDT', conns: 1,
    routes: [['api.binance.com/api/v3/depth', A.binanceSpot.snapshot]],
    drive: (t) => t.feed(0, A.binanceSpot.frame),
  },
  {
    id: 'binance perp', exchange: 'binance', market: 'perp', symbol: 'BTCUSDT', conns: 1,
    routes: [['fapi.binance.com/fapi/v1/depth', A.binancePerp.snapshot]],
    drive: (t) => t.feed(0, A.binancePerp.frame),
  },
  {
    id: 'aster perp', exchange: 'aster', market: 'perp', symbol: 'BTCUSDT', conns: 1,
    routes: [['fapi.asterdex.com/fapi/v1/depth', A.aster.snapshot]],
    drive: (t) => t.feed(0, A.aster.frame),
  },
  {
    id: 'mexc spot', exchange: 'mexc', market: 'spot', symbol: 'BTCUSDT', conns: 1,
    routes: [['api.mexc.com/api/v3/depth', A.mexcSpot.snapshot]],
    drive: (t) => t.feed(0, Buffer.from(A.mexcSpot.frame, 'base64')),
  },
  {
    id: 'mexc perp', exchange: 'mexc', market: 'perp', symbol: 'BTC_USDT', conns: 1,
    routes: [['contract/detail', F.rest.mexcContractDetail], ['contract/depth', A.mexcPerp.snapshot]],
    drive: (t) => t.feed(0, A.mexcPerp.frame),
  },
  {
    id: 'okx spot', exchange: 'okx', market: 'spot', symbol: 'BTC-USDT', conns: 1,
    routes: [['public/instruments', F.rest.okxInstruments], ['books-full', F.rest.okxBooksFull]],
    drive: (t) => t.feed(0, F.okxBooks),
  },
  {
    id: 'okx perp', exchange: 'okx', market: 'perp', symbol: 'BTC-USDT-SWAP', conns: 1,
    routes: [['public/instruments', F.rest.okxInstruments], ['books-full', F.rest.okxBooksFull]],
    drive: (t) => t.feed(0, F.okxBooks),
  },
  {
    id: 'coinbase spot', exchange: 'coinbase', market: 'spot', symbol: 'BTC-USD', conns: 1,
    routes: [],
    drive: (t) => { t.feed(0, F.coinbase.snapshot); t.feed(0, F.coinbase.update); },
  },
  {
    id: 'lighter perp', exchange: 'lighter', market: 'perp', symbol: 'BTC', conns: 1,
    routes: [['orderBookDetails', F.rest.lighterMarkets]],
    drive: (t) => { t.feed(0, F.lighter.snapshot); t.feed(0, F.lighter.update); },
  },
  {
    id: 'bitunix perp', exchange: 'bitunix', market: 'perp', symbol: 'BTCUSDT', conns: 1,
    routes: [['futures/market/depth', { data: { bids: [], asks: [] } }]],
    drive: (t) => t.feed(0, F.bitunixPerp),
  },
  {
    // The one feed with no websocket at all: a REST poller. It has to satisfy
    // the same contract, and its books arrive from the fetch stub instead.
    id: 'bitunix spot', exchange: 'bitunix', market: 'spot', symbol: 'BTCUSDT', conns: 0,
    routes: [['spot/v1/market/depth', F.rest.bitunixSpotDepth]],
    drive: () => {},
    polls: true,
  },
  {
    id: 'hyperliquid perp', exchange: 'hyperliquid', market: 'perp', symbol: 'BTC', conns: 6,
    routes: [],
    // The finest layer owns mid and spread and the stitch waits for it.
    drive: (t) => { t.feed(0, F.hyperliquid.fine); t.feed(4, F.hyperliquid.coarse); },
    assembled: true,
  },
  {
    id: 'hyperliquid spot', exchange: 'hyperliquid', market: 'spot', symbol: 'PURR/USDC', conns: 6,
    routes: [],
    drive: (t) => { t.feed(0, F.hyperliquid.fine); t.feed(4, F.hyperliquid.coarse); },
    assembled: true,
  },
];

// Before driving anything: does this table still describe the adapters that
// exist? It is written by hand, and a contract that covers twelve of thirteen
// feeds is a contract about nothing — the venue nobody remembered to add is
// exactly the one with no lifecycle coverage. Derived from the registry rather
// than counted, so adding an adapter fails here until it is driven too.
console.log('coverage — the table describes every feed that exists');
{
  const declared = feedsOf(adapters).map((f) => `${f.exchange}:${f.market}`);
  const covered = new Set(VENUES.map((v) => `${v.exchange}:${v.market}`));
  const missing = declared.filter((f) => !covered.has(f));
  ok(`every (exchange, market) an adapter serves is driven here (${declared.length})`,
     missing.length === 0, `not covered: ${missing.join(', ')}`);

  const stray = [...covered].filter((f) => !declared.includes(f));
  ok('and the table names no feed that does not exist', stray.length === 0, stray.join(', '));
  ok('no venue is driven twice', covered.size === VENUES.length,
     `${VENUES.length} rows, ${covered.size} distinct`);

  // The structural contract itself, on the registry as it stands.
  let shapeErr = null;
  try { for (const [k, a] of Object.entries(adapters)) assertAdapter(a, k); }
  catch (e) { shapeErr = e; }
  ok('every adapter satisfies the structural contract', shapeErr === null, shapeErr?.message);

  // A check is worth what it catches. Six deliberate breaks, one at a time,
  // each the shape of a real typo — and each has to name the field it is about,
  // because "invalid adapter" sends someone reading eight files.
  const good = { id: 'x', name: 'X', markets: ['spot'], transport: { spot: 'ws' },
                 listSymbols() {}, vol24h() {}, open() {} };
  const refuses = (label, mutate, needle) => {
    const a = { ...good, ...mutate };
    let e = null;
    try { assertAdapter(a, 'x'); } catch (err) { e = err; }
    ok(`it refuses ${label}, and says which field`, e !== null && needle.test(e.message),
       e ? e.message : 'accepted it');
  };
  ok('the reference adapter is accepted', assertAdapter(good, 'x') === good);
  refuses('a market no route serves', { markets: ['futures'] }, /markets names "futures"/);
  refuses('a market with no transport', { markets: ['spot', 'perp'] }, /transport\.perp/);
  refuses('a transport that is neither ws nor poll', { transport: { spot: 'rest' } }, /transport\.spot/);
  refuses('a note filed under a market it does not serve', { notes: { perp: 'hi' } }, /notes has a "perp"/);
  refuses('a missing entry point', { open: undefined }, /open must be a function/);
  refuses('an id that disagrees with its registry key', { id: 'y' }, /registered as "x"/);
}

const twoSided = (b) => b.bids?.length > 0 && b.asks?.length > 0;
const reachOf = (book) => {
  if (!twoSided(book)) return 0;
  const mid = (book.bids[0][0] + book.asks[0][0]) / 2;
  const far = (rows) => Math.abs(rows[rows.length - 1][0] - mid) / mid * 100;
  return Math.max(far(book.bids), far(book.asks));
};

const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

for (const v of VENUES) {
  console.log(`\n${v.id}`);
  const t = fakeFleet();
  const books = [];
  const states = [];
  const stub = stubFetch(v.routes);
  const timersBefore = timers();
  let conn = null;
  let threw = null;

  // Not awaited yet: three adapters cannot even be constructed without a REST
  // call (OKX needs contract sizes, MEXC perp a contract size, Lighter a market
  // id), and the gate is still shut.
  const opening = Promise.resolve()
    .then(() => adapters[v.exchange].open(
      v.market, v.symbol, { connect: t.factory },
      (b) => books.push(b), (st, d) => states.push(`${st}${d ? `:${d}` : ''}`),
    ))
    .catch((e) => { threw = e; return null; });

  await flush(60);
  // A book invented before any venue data is the worst possible failure: it is
  // a chart with no source, and nothing on screen would say so. Nothing has
  // been fed and no REST call has been answered, so there is nothing a correct
  // adapter could have published.
  ok('publishes nothing before the venue has said anything', books.length === 0,
     `${books.length} book(s) out of thin air`);

  stub.release();
  conn = await opening;
  ok('open() resolves to something closeable', !threw && typeof conn?.close === 'function',
     threw?.message);
  if (!conn) { stub.restore(); continue; }

  await flush(v.polls ? 400 : 200);
  ok(`it opens the transports it says it does (${v.conns})`, t.conns.length === v.conns,
     `${t.conns.length} opened`);

  v.drive(t);
  await flush(v.polls ? 1400 : 320);

  ok('a recorded frame produces a book', books.length > 0, states.join(' | ') || 'no status');
  if (!books.length) {
    if (stub.misses.length) console.log(`       unrouted REST: ${[...new Set(stub.misses)].slice(0, 3).join(', ')}`);
    try { conn.close(); } catch {}
    stub.restore();
    continue;
  }

  const bad = [];
  for (const b of books) {
    for (const [side, rows, cmp] of [['bids', b.bids, (a, c) => a > c], ['asks', b.asks, (a, c) => a < c]]) {
      // A one-sided book is legal on the way out of an adapter — the hub drops
      // it — so it is not an error here; what must hold is that whatever IS
      // there is ordered, positive and does not cross the other side.
      if (!rows.length) continue;
      for (let i = 0; i < rows.length; i++) {
        const [p, q] = rows[i];
        if (!(Number.isFinite(p) && p > 0 && Number.isFinite(q) && q > 0)) { bad.push(`${side}[${i}]=${p},${q}`); break; }
        if (i && !cmp(rows[i - 1][0], p)) { bad.push(`${side} out of order at ${i}: ${rows[i - 1][0]} then ${p}`); break; }
      }
    }
    if (b.bids[0] && b.asks[0] && !(b.bids[0][0] < b.asks[0][0])) bad.push(`crossed: ${b.bids[0][0]} >= ${b.asks[0][0]}`);
  }
  ok('every book is sorted outward from mid, positive, and uncrossed',
     bad.length === 0, bad.slice(0, 3).join(' | '));
  ok('and the assembled book has both sides',
     twoSided(books[books.length - 1]),
     `${books[books.length - 1].bids.length} bids / ${books[books.length - 1].asks.length} asks`);

  // The rule that has no other guard: an adapter reports the venue's clock or
  // null, never its own. A locally filled clock is older than nothing, so it
  // cannot predate this run; a recorded one always does.
  const clocks = books.map((b) => b.ts);
  const invented = clocks.filter((ts) => ts != null && ts >= T0);
  ok('the clock is the venue\'s or it is null — never this process\'s',
     invented.length === 0, `${invented.length} book(s) stamped at or after this run started`);
  ok('and when it is null it stays null, rather than becoming a zero latency',
     clocks.every((ts) => ts === null || Number.isFinite(ts)), JSON.stringify(clocks.slice(0, 4)));

  // A source is claimed on every book: `ws` and `poll` are not interchangeable
  // and a reader has to be able to tell which one it is looking at.
  ok('every book says which transport it came from',
     books.every((b) => b.source === 'ws' || b.source === 'poll'),
     JSON.stringify([...new Set(books.map((b) => b.source))]));

  // A connection reported down cannot keep contributing depth. On a single-
  // socket venue that means no book at all until data returns; on Hyperliquid,
  // whose six layers are stitched, the honest answer is a book that reaches
  // less far — which is exactly the bug that shipped frozen depth as live.
  const before = books.length;
  const reachBefore = reachOf(books[books.length - 1]);
  t.all('reconnecting', 'conformance');
  await flush();
  if (v.conns === 0) {
    ok('(a poller has no socket to drop)', true);
  } else if (v.assembled) {
    const after = books.slice(before);
    ok('a layer that is down stops contributing depth instead of freezing it',
       after.length === 0 || reachOf(after[after.length - 1]) <= reachBefore + 1e-9,
       `reach ${reachBefore} -> ${after.length ? reachOf(after[after.length - 1]) : 'no new book'}`);
  } else {
    ok('a socket that is down publishes nothing until data returns',
       books.length === before, `${books.length - before} book(s) after the drop`);
  }

  const publishedBefore = books.length;
  conn.close();
  conn.close();               // idempotent: shutdown paths call it more than once
  ok('close() is idempotent', true);
  ok('and it closes every transport it opened',
     t.conns.every((c) => c.closed >= 1), t.conns.map((c) => c.closed).join(','));

  v.drive(t);
  await flush(v.polls ? 1200 : 320);
  ok('a closed adapter publishes nothing, whatever arrives afterwards',
     books.length === publishedBefore, `${books.length - publishedBefore} book(s) after close()`);

  // A pending timer after close is not a leak, but it holds the event loop —
  // and a shutdown that waits five seconds per feed for a poll it will discard
  // is how a restart loop starts stacking connections.
  ok('and leaves no timer of its own behind', timers() <= timersBefore,
     `${timersBefore} timers before, ${timers()} after`);

  if (stub.misses.length) console.log(`       (unrouted REST, ignored: ${[...new Set(stub.misses)].length})`);
  stub.restore();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
