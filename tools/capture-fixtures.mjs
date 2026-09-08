/**
 * Record one real frame from each venue into tools/fixtures/venues.json.
 *
 *   node tools/capture-fixtures.mjs
 *
 * tools/test-adapters.mjs runs against these bytes, so the fixtures are the
 * only thing standing between a venue silently renaming a field and a chart
 * that keeps rendering beautifully with the wrong numbers. They are recordings,
 * never hand-written — the same rule the README screenshots follow. Re-record
 * when a venue changes its payload, read the diff, and only then update the
 * adapter: a fixture edited to match new code proves nothing.
 *
 * Books are truncated to a few levels a side to keep the file small; the
 * sequence fields, the timestamps and the units are kept exactly as sent.
 */
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'venues.json');

const out = {};
const cut = (a, n = 4) => (Array.isArray(a) ? a.slice(0, n) : a);
const grab = (url, sub, pick, ms = 12000) => new Promise((res) => {
  const ws = new WebSocket(url);
  let done = false;
  const fin = (v) => { if (!done) { done = true; try { ws.close(); } catch {} res(v); } };
  ws.on('open', () => { if (sub) ws.send(typeof sub === 'string' ? sub : JSON.stringify(sub)); });
  ws.on('message', (raw) => { const v = pick(raw); if (v !== undefined && v !== null) fin(v); });
  ws.on('error', (e) => fin({ error: String(e.message) }));
  setTimeout(() => fin({ error: 'timeout' }), ms);
});

// --- Binance spot + perp depthUpdate
for (const [k, host] of [['binanceSpot', 'wss://stream.binance.com:9443/ws'], ['binancePerp', 'wss://fstream.binance.com/ws']]) {
  out[k] = await grab(`${host}/btcusdt@depth@100ms`, null, (raw) => {
    const e = JSON.parse(raw.toString());
    if (!e.u) return null;
    return { e: e.e, E: e.E, s: e.s, U: e.U, u: e.u, pu: e.pu, b: cut(e.b), a: cut(e.a) };
  });
}
// --- Aster (Binance-futures clone)
out.aster = await grab('wss://fstream.asterdex.com/ws/btcusdt@depth@100ms', null, (raw) => {
  const e = JSON.parse(raw.toString());
  if (!e.u) return null;
  return { E: e.E, U: e.U, u: e.u, pu: e.pu, b: cut(e.b), a: cut(e.a) };
});
// --- MEXC spot: the protobuf frame, kept as raw bytes
out.mexcSpotProtobufB64 = await grab('wss://wbs-api.mexc.com/ws',
  { method: 'SUBSCRIPTION', params: ['spot@public.aggre.depth.v3.api.pb@100ms@BTCUSDT'] },
  (raw) => (Buffer.isBuffer(raw) && raw[0] !== 0x7b ? raw.toString('base64') : null));
// --- MEXC perp push.depth
out.mexcPerp = await grab('wss://contract.mexc.com/edge', { method: 'sub.depth', param: { symbol: 'BTC_USDT' } }, (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.channel !== 'push.depth' || !m.data) return null;
  return { channel: m.channel, ts: m.ts, data: { bids: cut(m.data.bids), asks: cut(m.data.asks), version: m.data.version, begin: m.data.begin, end: m.data.end, cts: m.data.cts } };
});
// --- OKX books frame + the contract specs the conversion depends on
out.okxBooks = await grab('wss://ws.okx.com:8443/ws/v5/public', { op: 'subscribe', args: [{ channel: 'books', instId: 'BTC-USDT-SWAP' }] }, (raw) => {
  const t = raw.toString(); if (t === 'pong') return null;
  const m = JSON.parse(t);
  if (!m.data || m.action !== 'update') return null;
  return { action: m.action, data: [{ bids: cut(m.data[0].bids), asks: cut(m.data[0].asks), ts: m.data[0].ts, seqId: m.data[0].seqId, prevSeqId: m.data[0].prevSeqId }] };
});
const inst = await (await fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP')).json();
out.okxInstruments = ['BTC-USDT-SWAP', 'BTC-USD-SWAP', 'ETH-USDT-SWAP'].map((id) => {
  const i = inst.data.find((x) => x.instId === id);
  return { instId: i.instId, ctVal: i.ctVal, ctMult: i.ctMult, ctType: i.ctType, ctValCcy: i.ctValCcy };
});
// --- Coinbase Advanced Trade: the snapshot and the update that follows it
out.coinbase = await new Promise((res) => {
  const ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');
  const got = {};
  ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channel: 'level2' })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.channel === 'subscriptions' && !got.ctrl) got.ctrl = { channel: m.channel, sequence_num: m.sequence_num };
    if (m.channel !== 'l2_data') return;
    const ev = m.events[0];
    const trimmed = { channel: m.channel, timestamp: m.timestamp, sequence_num: m.sequence_num, events: [{ type: ev.type, updates: cut(ev.updates, 6) }] };
    if (ev.type === 'snapshot' && !got.snapshot) got.snapshot = trimmed;
    else if (ev.type === 'update' && got.snapshot && !got.update) got.update = trimmed;
    if (got.snapshot && got.update) { try { ws.close(); } catch {} res(got); }
  });
  setTimeout(() => { try { ws.close(); } catch {} res(got); }, 15000);
});
// --- Lighter: the snapshot and a nonce-chained update
const mkts = await (await fetch('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails')).json();
const btc = (mkts.order_book_details || []).find((x) => x.symbol === 'BTC');
out.lighterMarketId = btc?.market_id;
out.lighter = await new Promise((res) => {
  const ws = new WebSocket('wss://mainnet.zklighter.elliot.ai/stream');
  const got = {};
  ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', channel: `order_book/${btc.market_id}` })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'subscribed/order_book' && !got.snapshot) {
      got.snapshot = { type: m.type, order_book: { nonce: m.order_book.nonce, bids: cut(m.order_book.bids), asks: cut(m.order_book.asks) } };
    } else if (m.type === 'update/order_book' && got.snapshot && !got.update) {
      got.update = { type: m.type, last_updated_at: m.last_updated_at, order_book: { nonce: m.order_book.nonce, begin_nonce: m.order_book.begin_nonce, bids: cut(m.order_book.bids), asks: cut(m.order_book.asks) } };
    }
    if (got.snapshot && got.update) { try { ws.close(); } catch {} res(got); }
  });
  setTimeout(() => { try { ws.close(); } catch {} res(got); }, 15000);
});
// --- Bitunix: the perp full-book frame and the spot candles the volume is summed from
out.bitunixPerp = await grab('wss://fapi.bitunix.com/public/', { op: 'subscribe', args: [{ symbol: 'BTCUSDT', ch: 'depth_books' }] }, (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.ch !== 'depth_books' || !m.data) return null;
  return { ch: m.ch, ts: m.ts, data: { b: cut(m.data.b), a: cut(m.data.a) } };
});
const kl = await (await fetch('https://openapi.bitunix.com/api/spot/v1/market/kline?symbol=BTCUSDT&interval=60')).json();
out.bitunixKlines = (kl.data || []).slice(0, 26).map((k) => ({ ts: k.ts, close: k.close, volume: k.volume }));

out._capturedAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(22)} ${v?.error ? 'ERREUR ' + v.error : 'ok'}`);
process.exit(0);
