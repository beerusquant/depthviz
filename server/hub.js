import { adapters } from './adapters/index.js';
import { PUBLISH_MS, okSymbol } from './util.js';

export const CLIP_PCT = 12;    // never ship levels further than this from mid
export const EXACT_PCT = 0.6;  // levels this close to mid are shipped verbatim
export const EXACT_MAX = 2000; // hard cap on verbatim levels per side
export const BUCKET_BPS = 5;   // geometric bucket width beyond the exact zone
// Distances from mid at which a figure is reported as fact — the fixed ±2%/±5%
// depths, and the widest range the UI offers. A bucket is never allowed to
// straddle one of these: whichever side of the boundary its VWAP price landed
// on, the whole bucket would be counted or dropped, so a published depth would
// be wrong by up to one bucket for no reason. Splitting there makes every
// reported number exact rather than nearly right.
export const REPORT_EDGES = [2, 5, 10];
const THROTTLE_MS = PUBLISH_MS;
// A viewer flipping between venues used to tear down the upstream connection
// and rebuild it a second later, and every REST /api/depth call would do the
// same. A feed with no viewers is kept for this long before it is closed.
const LINGER_MS = 30_000;
// A book is a snapshot, not a log: when a client cannot keep up, the right
// thing is to drop the frame it has not read yet, never to queue it. Without
// this, one stalled viewer on a slow link grows a server-side buffer without
// bound.
const MAX_BUFFERED_BYTES = 1 << 20;
// Every distinct symbol a viewer touches opens upstream connections to an
// exchange from this host's IP, and they linger. With no ceiling, one visitor
// cycling a symbol list can have this process holding thousands of sockets and
// spending someone else's rate-limit budget — the reason the server binds to
// loopback by default. Past the cap a subscription is refused with a message
// rather than quietly served from a feed that is starving the others.
const MAX_FEEDS = +process.env.DEPTHVIZ_MAX_FEEDS || 48;

const feeds = new Map(); // key -> Feed

// Reduce a side to a bounded number of levels WITHOUT losing reach.
// Near mid every level is kept as-is; further out, levels are merged into
// geometric buckets emitted as [vwapPrice, summedQty] — a form that preserves
// the side's cumulative notional, cumulative base quantity and VWAP exactly,
// because vwapPrice * summedQty === sum(price * qty) by construction.
// The old "keep the 2500 nearest levels" rule silently truncated the curve:
// on Binance spot BTC it shipped +-0.62% of a book that reached +-11%, hiding
// 64% of the depth inside +-10%.
export function trim(rows, mid) {
  const out = [];
  const step = Math.log(1 + BUCKET_BPS / 10_000);
  let bucket = null;   // current bucket index, null while still verbatim
  let edge = 0;        // how many report boundaries this level sits beyond
  let notional = 0;
  let qty = 0;
  const flush = () => {
    if (qty > 0) out.push([notional / qty, qty]);
    notional = 0; qty = 0;
  };
  for (const [p, q] of rows) {
    if (!(q > 0)) continue;
    const d = Math.abs(p - mid) / mid * 100;
    if (d > CLIP_PCT) break; // sides are sorted outward from mid
    if (bucket === null && d <= EXACT_PCT && out.length < EXACT_MAX) {
      out.push([p, q]);
      continue;
    }
    const idx = Math.floor(Math.log1p(d / 100) / step);
    let e = 0;
    while (e < REPORT_EDGES.length && d > REPORT_EDGES[e]) e++;
    if (idx !== bucket || e !== edge) { flush(); bucket = idx; edge = e; }
    notional += p * q;
    qty += q;
  }
  flush();
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
    this.lingerTimer = null;
    // Health counters, surfaced by /api/feeds. A feed that quietly reconnects
    // forty times an hour looks identical to a healthy one from the outside.
    this.reconnects = 0;
    this.errors = 0;
    this.dropped = 0;
    this.books = 0;
    this.openedAt = Date.now();

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
    if (next === 'reconnecting') this.reconnects++;
    if (next === 'error') this.errors++;
    if (next === 'error' && this.state === 'live') return this.broadcast({ op: 'status', state: 'live', detail });
    this.state = next;
    this.detail = detail || '';
    this.broadcast({ op: 'status', state: next, detail: this.detail });
  }

  onBook({ bids, asks, ts, source, accum, drift }) {
    if (!bids.length || !asks.length) return;
    const mid = (bids[0][0] + asks[0][0]) / 2;
    if (!(mid > 0)) return;
    this.books++;
    // Two clocks, never conflated. `tsVenue` is the exchange's own event time
    // and is null on the feeds that do not stamp their frames (Bitunix polling,
    // every REST snapshot, Coinbase's opening frame) — filling it with our own
    // clock would make the two indistinguishable, and a book age of "0 ms" is
    // exactly the kind of number nobody questions. `tsRecv` is when the frame
    // reached this process, so `tsRecv - tsVenue` is upstream latency and
    // `now - tsRecv` is staleness. Neither is inferable from one field.
    this.last = {
      op: 'book',
      exchange: this.exchange,
      market: this.market,
      symbol: this.symbol,
      bids: trim(bids, mid),
      asks: trim(asks, mid),
      tsVenue: Number.isFinite(ts) ? ts : null,
      tsRecv: Date.now(),
      source,
      levels: [bids.length, asks.length],
      accum: accum || null,
      drift: drift ?? null,
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
    for (const c of this.clients) {
      // bufferedAmount is what the socket has accepted but not yet flushed to
      // the network. Past the cap the client is behind: skip this frame and let
      // it catch up on the next one, which is strictly fresher anyway.
      if (c.bufferedAmount > MAX_BUFFERED_BYTES) { this.dropped++; continue; }
      try { c.send(s); } catch {}
    }
  }

  add(client) {
    clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
    this.clients.add(client);
    client.send(JSON.stringify({ op: 'status', state: this.state, detail: this.detail }));
    if (this.last) client.send(JSON.stringify({ ...this.last, vol24h: this.vol }));
  }

  remove(client) {
    this.clients.delete(client);
    if (this.clients.size === 0 && !this.lingerTimer) {
      this.lingerTimer = setTimeout(() => {
        if (this.clients.size === 0) this.destroy();
      }, LINGER_MS);
    }
  }

  destroy() {
    this.closed = true;
    clearInterval(this.volTimer);
    clearTimeout(this.lingerTimer);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    try { this.conn?.close(); } catch {}
    feeds.delete(this.key);
  }
}

export function subscribe(client, { exchange, market, symbol, range }, currentFeed = null) {
  const ad = adapters[exchange];
  if (!ad) throw new Error(`unknown exchange ${exchange}`);
  if (!ad.markets.includes(market)) throw new Error(`${ad.name} has no ${market} market`);
  if (!okSymbol(symbol)) throw new Error('invalid symbol');
  // The range only ever selects a view of a book that is clipped at ±12%
  // anyway, so a caller cannot widen the work this server does by asking for
  // ±1e9 — but it also must not reach the arithmetic as NaN or a negative.
  const opts = { range: Math.min(50, Math.max(0.01, +range || 2)) };
  const extra = ad.subKey ? ad.subKey(market, symbol, opts) : '';
  const key = `${exchange}:${market}:${symbol}:${extra}`;
  // A range change that does not alter the upstream subscription must not
  // tear the feed down and rebuild it.
  if (currentFeed && currentFeed.key === key) return currentFeed;
  if (currentFeed) currentFeed.remove(client);
  let feed = feeds.get(key);
  if (!feed) {
    if (feeds.size >= MAX_FEEDS) {
      throw new Error(`this server already holds ${feeds.size} live feeds (max ${MAX_FEEDS}); try again in a moment`);
    }
    feed = new Feed(key, exchange, market, symbol, opts);
    feeds.set(key, feed);
  }
  feed.add(client);
  return feed;
}

/**
 * What each live feed is actually doing, for /api/feeds.
 *
 * `state` alone is not health: it is set by the last status event, so a feed
 * that reconnects constantly still reads `live` between drops, and one whose
 * socket went quiet without closing reads `live` forever. `ageMs` is the
 * measurement that cannot lie — how long since a book last arrived.
 */
export function stats() {
  const now = Date.now();
  return [...feeds.values()].map((f) => ({
    key: f.key,
    clients: f.clients.size,
    state: f.state,
    source: f.last?.source ?? null,
    ageMs: f.last ? now - f.last.tsRecv : null,
    venueLatencyMs: f.last?.tsVenue != null ? f.last.tsRecv - f.last.tsVenue : null,
    levels: f.last?.levels ?? null,
    books: f.books,
    reconnects: f.reconnects,
    errors: f.errors,
    droppedFrames: f.dropped,
    upMs: now - f.openedAt,
  }));
}

/**
 * One book, for callers that are not a browser (`GET /api/depth`).
 *
 * It joins the same Feed a viewer would, so a symbol somebody is already
 * watching costs nothing, and `LINGER_MS` keeps the upstream connection warm
 * between polls instead of reopening it on every call.
 */
export async function snapshot({ exchange, market, symbol, range }, timeoutMs = 10_000) {
  const client = { send() {}, bufferedAmount: 0 }; // a listener without a socket
  const feed = subscribe(client, { exchange, market, symbol, range });
  try {
    const deadline = Date.now() + timeoutMs;
    while (!feed.last && Date.now() < deadline) {
      if (feed.state === 'error') throw new Error(feed.detail || `${exchange} feed error`);
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!feed.last) throw new Error(`no book from ${exchange} ${market} ${symbol} within ${timeoutMs}ms`);
    return { ...feed.last, vol24h: feed.vol };
  } finally {
    feed.remove(client);
  }
}
