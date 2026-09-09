/**
 * Deterministic tests for the seven adapters the crosscheck was the only thing
 * watching. No network.
 *
 *   node tools/test-adapters.mjs
 *
 * Why this file exists: until it did, `diff-book` and Hyperliquid's `stitch`
 * were the only adapter code with a test, and every unit conversion, every
 * decoder and every sequence rule rested entirely on the hourly ccxt
 * cross-check. That check is live — it cannot run in CI, and on a day when a
 * venue has a bad minute it SKIPs. A renamed field or a changed contract size
 * would then sail through until somebody read the log.
 *
 * Every frame below is a real capture from the venue, in tools/fixtures/
 * venues.json, taken the way the screenshots are taken: recorded, never
 * invented. Re-record it when a venue changes its payload — that is the point.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeDepthUpdate, mapDepthSnapshot } from '../server/adapters/binance.js';
import { specOf, contractsToBase } from '../server/adapters/okx.js';
import { decodeSpotDepth, decodePerpDepth } from '../server/adapters/mexc.js';
import { sumCandleVolume } from '../server/adapters/bitunix.js';
import coinbase from '../server/adapters/coinbase.js';
import lighter from '../server/adapters/lighter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(readFileSync(path.join(here, 'fixtures', 'venues.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const settle = () => new Promise((r) => setTimeout(r, 0));
const flush = () => new Promise((r) => setTimeout(r, 260));   // past PUBLISH_MS

/** A transport the test drives: nothing opens, nothing retries, no timers. */
function fakeTransport() {
  const t = { sent: [], handlers: null };
  t.factory = (_url, handlers) => {
    t.handlers = handlers;
    const send = (o) => t.sent.push(typeof o === 'string' ? o : JSON.stringify(o));
    queueMicrotask(() => handlers.onOpen?.(send));
    return { send, close() { t.closed = true; } };
  };
  t.feed = (o) => t.handlers.onMessage(typeof o === 'string' ? o : JSON.stringify(o),
    (x) => t.sent.push(typeof x === 'string' ? x : JSON.stringify(x)));
  t.status = (st, d) => t.handlers.onStatus?.(st, d);
  return t;
}

// ===================================================================== OKX
console.log('OKX — the contract conversion, where a missed multiplier is 100x');
{
  const byId = Object.fromEntries(F.okxInstruments.map((i) => [i.instId, i]));

  const lin = specOf(byId['BTC-USDT-SWAP']);
  ok('a linear swap takes ctVal * ctMult from the venue',
     lin.mult === 0.01 && lin.inverse === false, JSON.stringify(lin));
  ok('and one contract is that many coins, whatever the price',
     contractsToBase(lin)(78_000, 1) === 0.01 && contractsToBase(lin)(1, 1) === 0.01);

  const inv = specOf(byId['BTC-USD-SWAP']);
  ok('an inverse swap is flagged, and its ctVal is USD',
     inv.mult === 100 && inv.inverse === true, JSON.stringify(inv));
  // $100 of BTC at 78 000 is 0.001282 BTC. Reading it as 100 coins is the ~780x
  // error the README quotes; reading it as 100 USD-of-BTC is the right answer.
  ok('so an inverse contract converts through the level price',
     near(contractsToBase(inv)(78_000, 1), 100 / 78_000),
     String(contractsToBase(inv)(78_000, 1)));
  ok('and it is price-dependent, unlike a linear one',
     contractsToBase(inv)(39_000, 1) === 2 * contractsToBase(inv)(78_000, 1));

  const eth = specOf(byId['ETH-USDT-SWAP']);
  ok('a second linear instrument carries its own multiplier', eth.mult === 0.1);

  // A missing field must fall back to 1, never to NaN: NaN sizes would empty
  // the book silently instead of loudly.
  const bare = specOf({ instId: 'X', ctType: 'linear' });
  ok('a missing ctVal degrades to 1, not to NaN',
     bare.mult === 1 && contractsToBase(bare)(10, 3) === 3);
}

// ================================================================= Binance
console.log('\nBinance / Aster — the depthUpdate both venues share');
{
  const spot = decodeDepthUpdate(JSON.stringify(F.binanceSpot));
  ok('spot: U/u become from/to and E is the venue clock',
     spot.from === F.binanceSpot.U && spot.to === F.binanceSpot.u && spot.ts === F.binanceSpot.E);
  ok('spot: levels are parsed to numbers, in order',
     spot.bids.every(([p, q]) => typeof p === 'number' && typeof q === 'number')
     && spot.bids[0][0] === +F.binanceSpot.b[0][0]);

  const perp = decodeDepthUpdate(JSON.stringify(F.binancePerp));
  ok('perp carries `pu`, which is what chains it', perp.prev === F.binancePerp.pu);
  ok('spot carries no `pu` — the reason the two styles exist', spot.prev === undefined);

  const aster = decodeDepthUpdate(JSON.stringify(F.aster));
  ok('Aster decodes with the same function, and chains like Binance futures',
     Number.isFinite(aster.to) && aster.prev === F.aster.pu);

  ok('a frame with no update id is refused', decodeDepthUpdate(JSON.stringify({ e: 'x' })) === null);

  // The snapshot mapping, and the clock that was being thrown away.
  const s1 = mapDepthSnapshot({ lastUpdateId: 7, bids: [['1', '2']], asks: [['3', '4']] });
  ok('a spot snapshot has no venue clock and says so', s1.ts === null && s1.version === 7);
  const s2 = mapDepthSnapshot({ lastUpdateId: 7, E: 1788861095736, bids: [], asks: [] });
  ok('a futures snapshot keeps the clock the venue sent', s2.ts === 1788861095736);
}

// ==================================================================== MEXC
console.log('\nMEXC — a hand-written protobuf reader and a contract multiplier');
{
  const buf = Buffer.from(F.mexcSpotProtobufB64, 'base64');
  const d = decodeSpotDepth(buf);
  ok('the protobuf frame decodes at all', !!d && Array.isArray(d.bids) && Array.isArray(d.asks),
     JSON.stringify(d)?.slice(0, 120));
  ok('prices and sizes come out as finite numbers',
     [...d.bids, ...d.asks].every(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0),
     JSON.stringify([...d.bids, ...d.asks].slice(0, 3)));
  ok('the version pair is read (fields 4 and 5)',
     Number.isFinite(d.from) && Number.isFinite(d.to) && d.to >= d.from, `${d.from} -> ${d.to}`);
  // Field 6 was dropped for months, so this feed reported no venue clock while
  // the venue was stamping every frame.
  ok('field 6 is read, so the feed has a venue clock',
     Number.isFinite(d.ts) && d.ts > 1.7e12, String(d.ts));
  // Side mapping is the catastrophic one to get wrong, but this is a DIFF
  // frame: a removal carries quantity 0 and can sit anywhere, including across
  // the touch. Among the levels that still hold size, the two sides must not
  // overlap.
  const liveB = d.bids.filter(([, q]) => q > 0).map((r) => r[0]);
  const liveA = d.asks.filter(([, q]) => q > 0).map((r) => r[0]);
  ok('field 2 is bids and field 1 is asks — the live levels do not overlap',
     liveB.length && liveA.length && Math.max(...liveB) < Math.min(...liveA),
     `max bid ${Math.max(...liveB)} vs min ask ${Math.min(...liveA)}`);
  ok('and a zero-quantity level is carried through as a removal',
     d.bids.some(([, q]) => q === 0) || d.asks.some(([, q]) => q === 0));
  ok('a control JSON frame is not mistaken for a book',
     decodeSpotDepth(Buffer.from('{"id":0}')) === null);

  const raw = JSON.stringify(F.mexcPerp);
  const one = decodePerpDepth(raw, 1);
  const real = decodePerpDepth(raw, 0.0001);
  ok('perp sizes are multiplied by the contract size, nothing else is',
     real.bids.every(([p, q], i) => p === one.bids[i][0] && near(q, one.bids[i][1] * 0.0001)),
     `${one.bids[0]} -> ${real.bids[0]}`);
  ok('perp chains on begin/end', real.from === F.mexcPerp.data.begin && real.to === F.mexcPerp.data.end);
  ok('perp prefers `cts`, the moment the book changed', real.ts === (F.mexcPerp.data.cts ?? F.mexcPerp.ts));
  ok('a frame from another channel is refused',
     decodePerpDepth(JSON.stringify({ channel: 'push.kline', data: {} }), 1) === null);
}

// ================================================================= Bitunix
console.log('\nBitunix — the 24h volume nobody else publishes');
{
  const HOUR = 3600_000;
  const at = (h) => new Date(Date.UTC(2026, 0, 2, h)).toISOString();
  // Newest first, as the venue serves them. 25 rows for a 24h window: the
  // oldest one only partly overlaps it.
  const rows = [];
  for (let h = 24; h >= 0; h--) rows.push({ ts: at(h), close: '100', volume: '1' });
  const now = Date.parse(at(24)) + HOUR;      // the newest candle has just closed

  const v = sumCandleVolume(rows, now);
  ok('a full day of identical candles sums to exactly 24 of them', near(v, 24 * 100));

  // The oldest candle straddles the cutoff and must be weighted, not counted
  // whole and not dropped: half of it is inside the window.
  const half = sumCandleVolume(rows, now + HOUR / 2);
  ok('the candle straddling the cutoff is weighted by its overlap',
     near(half, 24 * 100 - 0.5 * 100), String(half));

  ok('volume is valued at each candle\'s own close, not the last one',
     near(sumCandleVolume([{ ts: at(24), close: '200', volume: '3' }], now), 600));
  ok('an empty or broken listing yields null, never 0',
     sumCandleVolume([]) === null && sumCandleVolume(null) === null
     && sumCandleVolume([{ ts: 'nope', close: '1', volume: '1' }], now) === null);

  // And the live frame the perp feed is built from.
  ok('the perp websocket frame carries both sides',
     F.bitunixPerp.data.b.length > 0 && F.bitunixPerp.data.a.length > 0
     && +F.bitunixPerp.data.b[0][0] < +F.bitunixPerp.data.a[0][0]);
}

// ================================================================ Coinbase
// The venue's frames are real; the `updates` arrays are truncated to keep the
// fixture small, so the snapshot below carries bids only. What is asserted is
// the sequencing and the level bookkeeping, both of which are side-agnostic.
console.log('\nCoinbase — the sequence numbers this feed did not used to have');
{
  const t = fakeTransport();
  const books = [];
  const states = [];
  const conn = coinbase.open('spot', 'BTC-USD', { connect: t.factory },
    (b) => books.push(b), (st, d) => states.push(`${st}${d ? `:${d}` : ''}`));
  await settle();

  // Expectations are read out of the fixture, never written into the test: a
  // re-recorded frame carries different prices, and a test that hardcodes them
  // fails for the one reason that means nothing.
  const snapUpd = F.coinbase.snapshot.events[0].updates;
  const updUpd = F.coinbase.update.events[0].updates;
  const touched = new Set(updUpd.map((u) => +u.price_level));

  t.feed(F.coinbase.snapshot);
  await flush();
  const first = books.at(-1);
  const at = (book, side, p) => book[side].find((r) => r[0] === p)?.[1];
  const untouched = snapUpd.find((u) => +u.new_quantity > 0 && !touched.has(+u.price_level));
  ok('the snapshot builds the book',
     !untouched || at(first, untouched.side === 'bid' ? 'bids' : 'asks', +untouched.price_level) === +untouched.new_quantity,
     `${untouched?.price_level} expected ${untouched?.new_quantity}`);
  ok('and the snapshot frame carries the venue clock',
     first.ts === Date.parse(F.coinbase.snapshot.timestamp), String(first.ts));

  t.feed(F.coinbase.update);
  await flush();
  const after = books.at(-1);
  const set = updUpd.find((u) => +u.new_quantity > 0);
  ok('an update applies new sizes',
     !set || at(after, set.side === 'bid' ? 'bids' : 'asks', +set.price_level) === +set.new_quantity,
     `${set?.price_level} expected ${set?.new_quantity}`);
  // `new_quantity: "0"` is a removal, not a level of size zero. A book that
  // keeps them prices a wall that is not there.
  const gone = updUpd.find((u) => +u.new_quantity === 0);
  ok('and a zero quantity removes the level, it does not keep it at zero',
     !gone || at(after, gone.side === 'bid' ? 'bids' : 'asks', +gone.price_level) === undefined,
     `${gone?.price_level} should be absent`);

  // The counter runs per CONNECTION, so a frame on another channel advances it.
  // Missing that would make every subscription acknowledgement look like a gap:
  // the frame numbered after it must still be accepted.
  // The fixture supplies the SHAPE of a control frame; the numbering is what is
  // under test here, so the test sets it. A recording's own sequence_num is an
  // accident of when it was taken.
  const n0 = F.coinbase.update.sequence_num;
  const beforeCtrl = t.sent.length;
  t.feed({ ...F.coinbase.ctrl, sequence_num: n0 + 1 });
  t.feed({ ...F.coinbase.update, sequence_num: n0 + 2 });
  await flush();
  ok('a control frame advances the counter without being a book',
     t.sent.length === beforeCtrl && books.length > 1,
     `sent ${t.sent.slice(beforeCtrl).join(' | ')}, books ${books.length}`);

  // Now the path that had never run anywhere: a hole in the numbering.
  const settled = books.length;
  t.feed({ ...F.coinbase.update, sequence_num: n0 + 99 });
  await flush();
  const sent = t.sent.join(' ');
  ok('a gap in the sequence forces a fresh snapshot',
     states.some((x) => x.includes('sequence gap')) && sent.includes('"unsubscribe"'),
     `${states.join(' | ')} :: ${sent}`);
  ok('and nothing is published from a book known to be incomplete',
     books.length === settled, `${books.length - settled} book(s) shipped after the gap`);
  conn.close();
}

// ================================================================= Lighter
console.log('\nLighter — a book chained by nonce');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ order_book_details: [{ symbol: 'BTC', market_id: F.lighterMarketId, status: 'active', market_type: 'perp' }] }),
  });
  try {
    const t = fakeTransport();
    const books = [];
    const states = [];
    const conn = await lighter.open('perp', 'BTC', { connect: t.factory },
      (b) => books.push(b), (st, d) => states.push(`${st}${d ? `:${d}` : ''}`));
    await settle();

    t.feed(F.lighter.snapshot);
    await flush();
    const px = +F.lighter.snapshot.order_book.bids[0].price;
    const sz = +F.lighter.snapshot.order_book.bids[0].size;
    ok('the snapshot loads price/size objects, not arrays',
       books.at(-1)?.bids?.[0]?.[0] === px && books.at(-1).bids[0][1] === sz,
       JSON.stringify(books.at(-1)?.bids?.slice(0, 2)));
    ok('a whole-book snapshot carries no venue clock, and says so', books.at(-1).ts === null);

    t.feed(F.lighter.update);
    await flush();
    ok('an update whose begin_nonce matches is applied, and stamps the book',
       books.at(-1).ts === Math.round(F.lighter.update.last_updated_at / 1000),
       String(books.at(-1).ts));

    const before = t.sent.length;
    t.feed({ ...F.lighter.update, order_book: { ...F.lighter.update.order_book, begin_nonce: '999' } });
    await settle();
    ok('a nonce gap drops the channel and asks for it again',
       states.some((x) => x.includes('nonce gap'))
       && t.sent.slice(before).join(' ').includes('"unsubscribe"'),
       `${states.join(' | ')} :: ${t.sent.slice(before).join(' | ')}`);
    conn.close();
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
