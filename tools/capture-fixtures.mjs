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
import { decodeSpotDepth } from '../server/adapters/mexc.js';
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
    // Truncated per SIDE, not by taking the first six rows: the first rows of a
    // Coinbase snapshot are all bids, so cutting the array left a one-sided
    // book in the fixture and nothing could test a book that has two sides.
    const bothSides = [...ev.updates.filter((u) => u.side === 'bid').slice(0, 4),
                       ...ev.updates.filter((u) => u.side !== 'bid').slice(0, 4)];
    const trimmed = { channel: m.channel, timestamp: m.timestamp, sequence_num: m.sequence_num, events: [{ type: ev.type, updates: bothSides }] };
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

// --- Hyperliquid: two of the six layers, the finest and a coarse one.
// The adapter is the only ASSEMBLED book here — no venue endpoint will ever say
// it is wrong — so the conformance suite has to be able to drive it, and that
// needs real frames from two different subscriptions.
const hlLayer = (sub) => grab('wss://api.hyperliquid.xyz/ws',
  { method: 'subscribe', subscription: { type: 'l2Book', coin: 'BTC', ...sub } },
  (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.channel !== 'l2Book' || !m.data) return null;
    return { channel: m.channel, data: { coin: m.data.coin, time: m.data.time, levels: [cut(m.data.levels[0], 6), cut(m.data.levels[1], 6)] } };
  });
out.hyperliquid = { fine: await hlLayer({}), coarse: await hlLayer({ nSigFigs: 3 }) };

/**
 * A snapshot and the diff frame that anchors to it, captured together.
 *
 * Recording the two separately and renumbering one onto the other produces a
 * book that CROSSES: the snapshot and the frame were taken minutes apart, so
 * applying the later diffs to the earlier book puts a bid above an ask. That
 * looks exactly like an adapter bug and is not one — it is a fixture that was
 * assembled instead of recorded.
 *
 * So the pair is taken the way the adapter takes it: subscribe first, buffer
 * the frames, then fetch the snapshot, then keep the first frame that satisfies
 * the venue's own anchoring rule. What lands in the file is a coherent instant.
 */
const grabPair = (wsUrl, sub, restUrl, style, decode, ms = 20000) => new Promise((res) => {
  const ws = new WebSocket(wsUrl);
  const buf = [];
  let snap = null;
  let done = false;
  const anchors = (e, v) => (style === 'prev' ? e.from <= v && e.to >= v : e.from <= v + 1 && e.to >= v + 1);
  const fin = (v) => { if (!done) { done = true; try { ws.close(); } catch {} res(v); } };
  const tryMatch = () => {
    if (!snap) return;
    for (const { raw, e } of buf) {
      if (anchors(e, snap.version)) fin({ snapshot: snap.body, frame: raw });
    }
  };
  ws.on('open', async () => {
    if (sub) ws.send(typeof sub === 'string' ? sub : JSON.stringify(sub));
    // The snapshot is fetched only after the subscription is live, so the frames
    // that straddle it are already buffered — the adapter's own ordering.
    setTimeout(async () => {
      try {
        const body = await (await fetch(restUrl)).json();
        snap = decode.snapshot(body);
        tryMatch();
      } catch (err) { fin({ error: String(err.message) }); }
    }, 800);
  });
  ws.on('message', (raw) => {
    const e = decode.frame(raw);
    if (!e || !Number.isFinite(e.to)) return;
    buf.push({ raw: decode.keep(raw), e });
    if (buf.length > 400) buf.shift();
    tryMatch();
  });
  ws.on('error', (e) => fin({ error: String(e.message) }));
  setTimeout(() => fin({ error: 'timeout' }), ms);
});

const binanceLike = {
  frame: (raw) => { const e = JSON.parse(raw.toString()); return e.u ? { from: e.U, to: e.u } : null; },
  keep: (raw) => { const e = JSON.parse(raw.toString()); return { e: e.e, E: e.E, s: e.s, U: e.U, u: e.u, pu: e.pu, b: cut(e.b), a: cut(e.a) }; },
  snapshot: (j) => ({ version: j.lastUpdateId, body: { lastUpdateId: j.lastUpdateId, E: j.E, bids: cut(j.bids), asks: cut(j.asks) } }),
};

out.anchored = {};
out.anchored.binanceSpot = await grabPair('wss://stream.binance.com:9443/ws/btcusdt@depth@100ms', null,
  'https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=100', 'from', binanceLike);
out.anchored.binancePerp = await grabPair('wss://fstream.binance.com/ws/btcusdt@depth@100ms', null,
  'https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=100', 'prev', binanceLike);
out.anchored.aster = await grabPair('wss://fstream.asterdex.com/ws/btcusdt@depth@100ms', null,
  'https://fapi.asterdex.com/fapi/v1/depth?symbol=BTCUSDT&limit=100', 'prev', binanceLike);
out.anchored.mexcPerp = await grabPair('wss://contract.mexc.com/edge', { method: 'sub.depth', param: { symbol: 'BTC_USDT' } },
  'https://contract.mexc.com/api/v1/contract/depth/BTC_USDT', 'from', {
    frame: (raw) => { const m = JSON.parse(raw.toString()); return m.channel === 'push.depth' && m.data ? { from: m.data.begin, to: m.data.end ?? m.data.version } : null; },
    keep: (raw) => { const m = JSON.parse(raw.toString()); return { channel: m.channel, ts: m.ts, data: { bids: cut(m.data.bids), asks: cut(m.data.asks), version: m.data.version, begin: m.data.begin, end: m.data.end, cts: m.data.cts } }; },
    snapshot: (j) => ({ version: +j.data.version, body: { ...j, data: { ...j.data, bids: cut(j.data.bids), asks: cut(j.data.asks) } } }),
  });
// MEXC spot speaks protobuf, so its frame is kept as raw bytes and the repo's
// own decoder picks which one anchors — choosing a recording is not writing one.
out.anchored.mexcSpot = await grabPair('wss://wbs-api.mexc.com/ws', { method: 'SUBSCRIPTION', params: ['spot@public.aggre.depth.v3.api.pb@100ms@BTCUSDT'] },
  'https://api.mexc.com/api/v3/depth?symbol=BTCUSDT&limit=100', 'from', {
    frame: (raw) => (Buffer.isBuffer(raw) && raw[0] !== 0x7b ? decodeSpotDepth(raw) : null),
    keep: (raw) => raw.toString('base64'),
    snapshot: (j) => ({ version: j.lastUpdateId, body: { lastUpdateId: j.lastUpdateId, bids: cut(j.bids, 40), asks: cut(j.asks, 40) } }),
  });

// --- The REST half of every venue that has one.
//
// The websocket frames above prove the decoders. They prove nothing about what
// happens when an adapter is OPENED: the snapshot it fetches, the contract
// sizes it needs first, the market list it resolves an id through. Those paths
// only ever ran against the live internet, so tools/test-conformance.mjs could
// not exist without these. Truncated the same way, and never hand-written.
const get = async (u) => (await fetch(u)).json();
out.rest = {};
{
  const d = await get('https://contract.mexc.com/api/v1/contract/detail');
  const btc = (d.data || []).find((x) => x.symbol === 'BTC_USDT');
  // contractSize is the multiplier a dropped conversion turns into a 100x error.
  out.rest.mexcContractDetail = { success: true, code: 0, data: [{ symbol: btc.symbol, contractSize: btc.contractSize, state: btc.state, baseCoin: btc.baseCoin, quoteCoin: btc.quoteCoin }] };
}
{
  const j = await get('https://www.okx.com/api/v5/market/books-full?instId=BTC-USDT-SWAP&sz=100');
  out.rest.okxBooksFull = { code: j.code, data: [{ bids: cut(j.data[0].bids), asks: cut(j.data[0].asks), ts: j.data[0].ts }] };
  out.rest.okxInstruments = { code: '0', data: inst.data.filter((x) => ['BTC-USDT-SWAP', 'BTC-USD-SWAP', 'ETH-USDT-SWAP'].includes(x.instId)).map((i) => ({ instId: i.instId, ctVal: i.ctVal, ctMult: i.ctMult, ctType: i.ctType, state: i.state })) };
}
out.rest.bitunixSpotDepth = await (async () => {
  const j = await get('https://openapi.bitunix.com/api/spot/v1/market/depth?symbol=BTCUSDT&limit=200');
  return { ...j, data: { bids: cut(j.data.bids), asks: cut(j.data.asks) } };
})();
out.rest.lighterMarkets = { order_book_details: (mkts.order_book_details || []).filter((x) => x.symbol === 'BTC').map((x) => ({ symbol: x.symbol, market_id: x.market_id, status: x.status, market_type: x.market_type, daily_quote_token_volume: x.daily_quote_token_volume })) };

out._capturedAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(22)} ${v?.error ? 'ERREUR ' + v.error : 'ok'}`);
process.exit(0);
