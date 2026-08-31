import { adapters } from './adapters/index.js';

const MAX_LEVELS = 2500;   // per side, nearest to mid
const CLIP_PCT = 12;       // never ship levels further than this from mid
const THROTTLE_MS = 200;

const feeds = new Map(); // key -> Feed

function trim(rows, mid) {
  const lo = mid * (1 - CLIP_PCT / 100);
  const hi = mid * (1 + CLIP_PCT / 100);
  const out = [];
  for (const [p, q] of rows) {
    if (p < lo || p > hi) break; // sides are sorted outward from mid
    if (q > 0) out.push([p, q]);
    if (out.length >= MAX_LEVELS) break;
  }
  return out;
}

class Feed {
  constructor(key, exchange, market, symbol, opts) {
    this.key = key;
    this.exchange = exchange;
    this.market = market;
    this.symbol = symbol;
    this.opts = opts;
    this.clients = new Set();
    this.state = 'connecting';
    this.detail = '';
    this.last = null;
    this.vol = null;
    this.lastSent = 0;
    this.pendingTimer = null;

    this.closed = false;
    const ad = adapters[exchange];
    // Adapters may open asynchronously (e.g. OKX needs contract sizes first).
    this.conn = null;
    Promise.resolve(
      ad.open(market, symbol, opts, (book) => this.onBook(book), (st, detail) => this.onStatus(st, detail)),
    ).then((c) => {
      this.conn = c;
      if (this.closed) { try { c.close(); } catch {} }
    }).catch((e) => this.onStatus('error', e.message));

    this.refreshVol();
    this.volTimer = setInterval(() => this.refreshVol(), 30_000);
  }

  async refreshVol() {
    try { this.vol = await adapters[this.exchange].vol24h(this.market, this.symbol); }
    catch { /* volume is decoration; a failure must not kill the feed */ }
  }

  onStatus(st, detail) {
    const map = { open: 'live', connecting: 'connecting', reconnecting: 'reconnecting', error: 'error' };
    const next = map[st] || st;
    if (next === 'error' && this.state === 'live') return this.broadcast({ op: 'status', state: 'live', detail });
    this.state = next;
    this.detail = detail || '';
    this.broadcast({ op: 'status', state: next, detail: this.detail });
  }

  onBook({ bids, asks, ts, source }) {
    if (!bids.length || !asks.length) return;
    const mid = (bids[0][0] + asks[0][0]) / 2;
    if (!(mid > 0)) return;
    this.last = {
      op: 'book',
      exchange: this.exchange,
      market: this.market,
      symbol: this.symbol,
      bids: trim(bids, mid),
      asks: trim(asks, mid),
      ts: ts || Date.now(),
      source,
      levels: [bids.length, asks.length],
    };
    if (this.state !== 'live') { this.state = 'live'; this.broadcast({ op: 'status', state: 'live', detail: '' }); }
    this.schedule();
  }

  schedule() {
    const now = Date.now();
    const wait = Math.max(0, THROTTLE_MS - (now - this.lastSent));
    if (this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.lastSent = Date.now();
      if (this.last) this.broadcast({ ...this.last, vol24h: this.vol });
    }, wait);
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const c of this.clients) { try { c.send(s); } catch {} }
  }

  add(client) {
    this.clients.add(client);
    client.send(JSON.stringify({ op: 'status', state: this.state, detail: this.detail }));
    if (this.last) client.send(JSON.stringify({ ...this.last, vol24h: this.vol }));
  }

  remove(client) {
    this.clients.delete(client);
    if (this.clients.size === 0) this.destroy();
  }

  destroy() {
    this.closed = true;
    clearInterval(this.volTimer);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    try { this.conn?.close(); } catch {}
    feeds.delete(this.key);
  }
}

export function subscribe(client, { exchange, market, symbol, range }, currentFeed = null) {
  const ad = adapters[exchange];
  if (!ad) throw new Error(`unknown exchange ${exchange}`);
  if (!ad.markets.includes(market)) throw new Error(`${ad.name} has no ${market} market`);
  const opts = { range: +range || 2 };
  const extra = ad.subKey ? ad.subKey(market, symbol, opts) : '';
  const key = `${exchange}:${market}:${symbol}:${extra}`;
  // A range change that does not alter the upstream subscription must not
  // tear the feed down and rebuild it.
  if (currentFeed && currentFeed.key === key) return currentFeed;
  if (currentFeed) currentFeed.remove(client);
  let feed = feeds.get(key);
  if (!feed) { feed = new Feed(key, exchange, market, symbol, opts); feeds.set(key, feed); }
  feed.add(client);
  return feed;
}

export function stats() {
  return [...feeds.values()].map((f) => ({ key: f.key, clients: f.clients.size, state: f.state }));
}
