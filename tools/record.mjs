/**
 * Record a venue's raw book to JSONL, so a measurement can be made twice.
 *
 *   node tools/record.mjs --exchange binance --market spot --symbol BTCUSDT --minutes 20
 *   node tools/record.mjs --exchange okx --market perp --symbol BTC-USDT-SWAP \
 *        --minutes 60 --interval 1000 --clip 12 --out data/ --gzip
 *
 * It opens the venue itself rather than reading this server's websocket, for
 * one reason: the socket ships a REDUCED book, and a reduction that is exact in
 * cumulative notional and wrong about the price a given size walks to is
 * exactly the wrong thing to keep forever. What lands on disk is what the
 * adapter produced, in base units.
 *
 * The cost of that choice is stated plainly: this opens its own connections to
 * the exchange, so it spends the same IP's rate-limit budget as the server. Run
 * it deliberately, not in a loop.
 *
 * Two habits from previous incidents are baked in and not optional:
 *  - every dependency is asserted BEFORE any collecting starts, because a
 *    30-minute capture that discovers a missing method at write time has cost
 *    30 minutes;
 *  - the file is written as `.part` and renamed only after the end marker, so a
 *    crashed run cannot be mistaken for a finished one by a waiting loop.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters } from '../server/adapters/index.js';
import { header, bookRow, endRow, encode } from './lib/recording.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d = null) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const die = (msg) => { console.error(`record: ${msg}`); process.exit(2); };

const exchange = arg('exchange') || die('--exchange is required');
const market = arg('market', 'spot');
const symbol = arg('symbol') || die('--symbol is required');
const minutes = +arg('minutes', '10');
const intervalMs = +arg('interval', '1000');
const clipPct = arg('clip') === 'none' ? null : +arg('clip', '12');
// A full Binance spot book is ~10 000 levels, i.e. ~185 KB a sample: an hour at
// 1 Hz is 650 MB raw and about a tenth of that gzipped. Measured, not guessed.
const gzip = process.argv.includes('--gzip');
const outDir = path.resolve(root, arg('out', 'data'));

// ---------------------------------------------------------- assert, then work
const ad = adapters[exchange];
if (!ad) die(`unknown exchange ${exchange} (have: ${Object.keys(adapters).join(', ')})`);
if (!ad.markets.includes(market)) die(`${ad.name} has no ${market} market (has: ${ad.markets.join(', ')})`);
if (!(minutes > 0) || !(intervalMs >= 100)) die('--minutes must be > 0 and --interval >= 100');
if (typeof ad.open !== 'function') die(`${exchange} adapter has no open()`);
mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const base = `${exchange}-${market}-${symbol.replace(/[^\w.-]/g, '_')}-${stamp}.jsonl${gzip ? '.gz' : ''}`;
const partPath = path.join(outDir, `${base}.part`);
const finalPath = path.join(outDir, base);
if (existsSync(finalPath)) die(`${finalPath} already exists`);

const file = createWriteStream(partPath, { flags: 'wx' });
const out = gzip ? createGzip() : file;
if (gzip) out.pipe(file);
const write = (o) => out.write(encode(o));

let last = null;         // the most recent book the adapter produced
let books = 0;           // books received
let written = 0;         // books sampled to disk
let statuses = 0;
let firstAt = 0;

write(header({
  startedAt: Date.now(), exchange, market, symbol, intervalMs, clipPct,
  accumulates: /binance|mexc|aster/.test(exchange) || null,
  note: ad.notes?.[market] || null,
}));

const conn = await Promise.resolve(ad.open(market, symbol, { range: 2 },
  (book) => {
    if (!book.bids?.length || !book.asks?.length) return;
    const mid = (book.bids[0][0] + book.asks[0][0]) / 2;
    if (!(mid > 0)) return;
    books++;
    if (!firstAt) firstAt = Date.now();
    last = { ...book, mid, tsRecv: Date.now(), tsVenue: Number.isFinite(book.ts) ? book.ts : null };
  },
  (st, detail) => {
    statuses++;
    if (st !== 'open') console.error(`  [${new Date().toISOString()}] ${st}${detail ? `: ${detail}` : ''}`);
  }));

// A book has to actually arrive before this is a capture rather than a wait.
const deadline = Date.now() + 30_000;
while (!last && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
if (!last) { try { conn.close(); } catch {} ; die(`no book from ${exchange} ${market} ${symbol} within 30s`); }

const endAt = Date.now() + minutes * 60_000;
console.error(`recording ${exchange} ${market} ${symbol} -> ${path.relative(root, finalPath)}`);
console.error(`  every ${intervalMs}ms for ${minutes} min, clipped at ${clipPct == null ? 'nothing' : `±${clipPct}%`}`);

let stopped = false;
const stop = () => { stopped = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

while (!stopped && Date.now() < endAt) {
  const tick = Date.now() + intervalMs;
  // One sample is the LAST book seen in the interval, never an average of
  // several: an averaged book is not a book any venue ever showed.
  write(bookRow(last, clipPct));
  written++;
  if (written % 60 === 0) {
    process.stderr.write(`  ${written} samples, ${books} books, ${last.bids.length + last.asks.length} levels\r`);
  }
  const wait = tick - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

try { conn.close(); } catch {}
write(endRow({ books, written, statuses, stoppedEarly: stopped }));
out.end();
// Wait on the FILE, not on the compressor: gzip's 'close' fires when it has
// finished deflating, which is before the last block has reached the disk.
await new Promise((r) => file.on('close', r));
// Only now is it a finished recording, and only now does it get the name a
// reader will trust.
renameSync(partPath, finalPath);
console.error(`\n${written} samples over ${((Date.now() - firstAt) / 60_000).toFixed(1)} min -> ${path.relative(root, finalPath)}`);
process.exit(0);
