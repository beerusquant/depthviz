/**
 * Deterministic tests for the snapshot + versioned-diff engine — the code five
 * of the thirteen feeds share, and the only place a book can silently stop
 * advancing. No network: the transport is a fake the test drives frame by frame.
 *
 *   node tools/test-diff-book.mjs
 *
 * The sequences below are not invented. They are the update ids captured live
 * from `btcusdt@depth@100ms` on Binance futures on 2026-09-08, at the moment the
 * bug they cover was found: the REST snapshot's `lastUpdateId` landed in the gap
 * BETWEEN two events, so the event that resumes the chain arrived after the
 * snapshot rather than during it — and the engine only ever looked for it among
 * the frames buffered while the snapshot was in flight.
 */
import { openDiffBook } from '../server/adapters/diff-book.js';
import { PUBLISH_MS } from '../server/util.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};

/** A transport the test drives: nothing opens, nothing retries, no timers. */
function fakeTransport() {
  const t = { handlers: null, closed: false };
  t.factory = (_url, handlers) => {
    t.handlers = handlers;
    queueMicrotask(() => handlers.onOpen?.(() => {}));
    return { send() {}, close() { t.closed = true; } };
  };
  t.feed = (e) => t.handlers.onMessage(JSON.stringify(e), () => {});
  return t;
}

const evt = (U, u, pu, bids = [], asks = []) => ({ U, u, pu, bids, asks });
const decode = (raw) => {
  const e = JSON.parse(raw.toString());
  return { bids: e.bids, asks: e.asks, from: e.U, to: e.u, prev: e.pu, ts: e.E ?? null };
};
const settle = () => new Promise((r) => setTimeout(r, 0));
// Publishes are coalesced at PUBLISH_MS, so the last book of a burst lands on a
// trailing timer rather than on the frame that produced it.
const flush = () => new Promise((r) => setTimeout(r, PUBLISH_MS + 60));

// ---------------------------------------------------------------------------
// The captured Binance-futures ids. v sits between event 6 (u=…552319) and the
// next one (U=…552441, u=…562562): the anchor is the LIVE event, not a buffered
// one.
const V = 11503673555511;
const BUFFERED = [
  evt(11503673448530, 11503673458620, 11503673448367),
  evt(11503673538329, 11503673552319, 11503673538220),
];
const LIVE = [
  evt(11503673552441, 11503673562562, 11503673552319, [[100, 1]], [[101, 1]]),
  evt(11503673562588, 11503673570878, 11503673562562, [[99, 2]], [[102, 2]]),
];

async function runPrev({ feedBufferedFirst }) {
  const t = fakeTransport();
  const books = [];
  const conn = openDiffBook({
    label: 'test', ws: 'x', style: 'prev', connect: t.factory, decode,
    snapshot: async () => ({
      bids: [[100, 5], [99.9, 5]], asks: [[100.1, 5], [100.2, 5]], version: V,
    }),
  }, (b) => books.push(b), () => {});
  await settle();
  if (feedBufferedFirst) for (const e of BUFFERED) t.feed(e);
  await settle(); await settle();          // let the snapshot resolve
  for (const e of LIVE) t.feed(e);
  await flush();
  return { books, conn };
}

console.log('openDiffBook — the anchor after a snapshot');

{
  // The failure as it happened in production: nothing useful was buffered, so
  // the anchoring event arrived live and was rejected as a gap forever.
  const { books, conn } = await runPrev({ feedBufferedFirst: true });
  const last = books.at(-1);
  const bidAt = (p) => last.bids.find((r) => r[0] === p)?.[1];
  ok('the anchoring event is accepted when it arrives after the snapshot',
     bidAt(100) === 1, `book was ${JSON.stringify(last.bids)}`);
  ok('and the chain continues from it', bidAt(99) === 2,
     `book was ${JSON.stringify(last.bids)}`);
  ok('a level the diffs never touched survives', bidAt(99.9) === 5);
  conn.close();
}

{
  // Same, with an empty buffer: the snapshot fetch simply beat the stream.
  const { books, conn } = await runPrev({ feedBufferedFirst: false });
  const last = books.at(-1);
  ok('an empty buffer does not prevent anchoring',
     last.bids.find((r) => r[0] === 100)?.[1] === 1);
  conn.close();
}

{
  // An event entirely past the anchor is a genuine miss and must resync, not be
  // quietly applied on top of a book that is missing updates.
  const t = fakeTransport();
  let snapshots = 0;
  const conn = openDiffBook({
    label: 'test', ws: 'x', style: 'prev', connect: t.factory, decode,
    snapshot: async () => { snapshots++; return { bids: [[100, 5]], asks: [[101, 5]], version: V }; },
  }, () => {}, () => {});
  await settle(); await settle();
  t.feed(evt(V + 5000, V + 9000, V + 4999, [[100, 9]], []));
  await settle(); await settle();
  ok('an event past the anchor forces a fresh snapshot', snapshots === 2, `snapshots=${snapshots}`);
  conn.close();
}

{
  // 'from' venues chain one-past, and their snapshot version is the id of the
  // last applied update: the anchor must satisfy U <= v+1 <= u.
  const t = fakeTransport();
  const books = [];
  const conn = openDiffBook({
    label: 'test', ws: 'x', style: 'from', connect: t.factory, decode,
    snapshot: async () => ({ bids: [[100, 5]], asks: [[101, 5]], version: 1000 }),
  }, (b) => books.push(b), () => {});
  await settle(); await settle();
  t.feed(evt(998, 1004, undefined, [[100, 7]], []));   // straddles v+1
  t.feed(evt(1005, 1009, undefined, [[100, 8]], []));  // contiguous
  await flush();
  ok("'from' venues anchor on U <= v+1 <= u", books.at(-1).bids[0][1] === 8,
     `book was ${JSON.stringify(books.at(-1).bids)}`);
  conn.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
