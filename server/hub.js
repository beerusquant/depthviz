import { adapters } from './adapters/index.js';
import { PUBLISH_MS, okSymbol } from './util.js';
import { Quota } from './quota.js';
import { Ring, summarize } from './health.js';

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
// And the same ceiling, per client. The global cap protects the host; it does
// nothing about one client taking all 48 slots and refusing everybody else from
// a server behaving exactly as designed. See server/quota.js.
const MAX_FEEDS_PER_CLIENT = +process.env.DEPTHVIZ_MAX_FEEDS_PER_CLIENT || 12;
// How often each feed's counters are copied into its ring, and how many samples
// are kept: 10 s x 360 is the last hour, per feed, for about 30 KB.
const SAMPLE_MS = +process.env.DEPTHVIZ_SAMPLE_MS || 10_000;
const SAMPLES = +process.env.DEPTHVIZ_SAMPLES || 360;

const feeds = new Map(); // key -> Feed
const quota = new Quota(MAX_FEEDS_PER_CLIENT);

// Reduce a side to a bounded number of levels WITHOUT losing reach.
// Near mid every level is kept as-is; further out, levels are merged into
// geometric buckets emitted as [vwapPrice, summedQty] — a form that preserves
// the side's cumulative notional, cumulative base quantity and VWAP exactly,
// because vwapPrice * summedQty === sum(price * qty) by construction.
// The old "keep the 2500 nearest levels" rule silently truncated the curve:
// on Binance spot BTC it shipped +-0.62% of a book that reached +-11%, hiding
// 64% of the depth inside +-10%.
//
// What it does NOT preserve is the inverse function — the price a given size
// walks to INSIDE a bucket. Cumulative notional, cumulative quantity and VWAP
// are exact at every bucket edge, and between two edges the curve is a straight
// line where the real book is a staircase. For a chart that is invisible; for
// anyone sizing an order it is the number they came for, which is why the raw
// book is reachable through /api/depth?levels=raw and why the reduction happens
// on the way OUT to a browser rather than on the way in.
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

/** The levels of one side that fall within ±pct of mid, untouched. */
export function clipRaw(rows, mid, pct) {
  const out = [];
  for (const [p, q] of rows) {
    if (!(q > 0)) continue;
    if (Math.abs(p - mid) / mid * 100 > pct) break; // sides are sorted outward
    out.push([p, q]);
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
    this.ownerOf = new Map();  // client -> owner, so a release charges the right one
    this.state = 'connecting';
    this.detail = '';
    // The book as the venue gave it, and the payload a browser gets. They are
    // kept apart on purpose: the reduction is a property of the transport, not
    // of the book, and anything that needs the real thing (/api/depth?levels=raw,
    // tools/record.mjs) must not be handed a bucketed curve.
    this.raw = null;
    this.rawSeq = 0;
    this.payloadSeq = -1;
    this.cached = null;
    this.vol = null;
    this.volTs = null;         // when vol24h was last actually read, not asked for
    this.lastSent = 0;
    // Resolved by the next accepted book. `/api/depth` used to poll this feed
    // every 50 ms waiting for one, which is up to 50 ms of latency added to
    // every REST call for a value the feed already had.
    this.waiters = [];
    this.pendingTimer = null;
    this.lingerTimer = null;
    // Health counters, surfaced by /api/feeds. A feed that quietly reconnects
    // forty times an hour looks identical to a healthy one from the outside —
    // in ONE reading. The ring is what makes two readings unnecessary.
    this.reconnects = 0;
    this.errors = 0;
    this.dropped = 0;
    this.books = 0;
    // Books an adapter published and this feed refused. A refused book is not a
    // book that never came: one leaves `ageMs` growing with an explanation, the
    // other leaves it growing with none, and they need different fixes.
    this.rejected = { empty: 0, crossed: 0, badMid: 0 };
    this.openedAt = Date.now();
    this.history = new Ring(SAMPLES);

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

  /**
   * Volume is decoration: a failure here must never kill a feed whose book is
   * healthy. But a swallowed failure leaves the LAST value standing, and a
   * figure that has not moved in an hour looked exactly like one read a second
   * ago. The stamp is what tells them apart, and it moves only on a success.
   */
  async refreshVol() {
    try {
      this.vol = await adapters[this.exchange].vol24h(this.market, this.symbol);
      this.volTs = Date.now();
    } catch { /* keep the previous reading, and let volTs age */ }
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

  /**
   * The one gate every book passes through, and the only place a bad one dies.
   *
   * Three refusals, each counted rather than silent. A one-sided book has no
   * mid; a non-positive mid has no arithmetic; and a CROSSED book — best bid at
   * or above best ask — is what a mis-sequenced diff stream looks like from the
   * outside. Nothing downstream would have noticed the last one: a mid computed
   * inside a negative spread is a plausible number, the spread renders as
   * -2.00%, and both depth curves are drawn over a price range they share. The
   * chart stays beautiful, which is this repo's definition of the worst kind of
   * bug.
   *
   * Refusing it freezes the feed rather than advancing it with a wrong book,
   * and that is the intended trade: `ageMs` then grows where anybody looking
   * can see it, and `rejected` says which of the three it was.
   */
  onBook({ bids, asks, ts, source, accum, drift, driftTs }) {
    if (!bids.length || !asks.length) { this.rejected.empty++; return; }
    const mid = (bids[0][0] + asks[0][0]) / 2;
    if (!(mid > 0)) { this.rejected.badMid++; return; }
    if (!(bids[0][0] < asks[0][0])) { this.rejected.crossed++; return; }
    this.books++;
    // Two clocks, never conflated. `tsVenue` is the exchange's own event time
    // and is null on the feeds that do not stamp their frames (Bitunix's spot
    // poll, Binance spot's REST snapshot) — filling it with our own
    // clock would make the two indistinguishable, and a book age of "0 ms" is
    // exactly the kind of number nobody questions. `tsRecv` is when the frame
    // reached this process, so `tsRecv - tsVenue` is upstream latency and
    // `now - tsRecv` is staleness. Neither is inferable from one field.
    //
    // Nothing is reduced here. Bucketing a book the throttle is about to drop
    // is work done for nobody: the adapters coalesce their sorting at
    // PUBLISH_MS and the hub throttles its fan-out at the same period, but the
    // two run on independent phases, so a frame trimmed on arrival could still
    // be superseded before it was ever sent. It is done in `payload()` instead,
    // once per book that is actually shipped.
    this.raw = {
      bids,
      asks,
      mid,
      tsVenue: Number.isFinite(ts) ? ts : null,
      tsRecv: Date.now(),
      source,
      levels: [bids.length, asks.length],
      accum: accum || null,
      // An integrity measurement and the instant it was taken. OKX and Bitunix
      // compare their stream against the venue's own REST book, and both
      // swallow a failed read to protect the stream — so the previous value
      // stands, and a ten-minute-old disagreement of 0.1% was indistinguishable
      // from one measured a second ago. The stamp is the difference; it is the
      // adapter's clock, so it is never null while `drift` is a number.
      drift: drift ?? null,
      driftTs: drift == null ? null : (driftTs ?? null),
    };
    this.rawSeq++;
    if (this.state !== 'live') { this.state = 'live'; this.broadcast({ op: 'status', state: 'live', detail: '' }); }
    for (const r of this.waiters.splice(0)) r();
    this.schedule();
  }

  /**
   * The book as it is shipped: reduced once, then reused.
   *
   * Memoized on the raw book's sequence, so a viewer joining between two frames
   * gets the last shipped payload without the reduction running again, and a
   * book superseded before its turn to be sent is never reduced at all.
   */
  payload() {
    const r = this.raw;
    if (!r) return null;
    if (this.payloadSeq !== this.rawSeq) {
      this.payloadSeq = this.rawSeq;
      this.cached = {
        op: 'book',
        exchange: this.exchange,
        market: this.market,
        symbol: this.symbol,
        bids: trim(r.bids, r.mid),
        asks: trim(r.asks, r.mid),
        tsVenue: r.tsVenue,
        tsRecv: r.tsRecv,
        source: r.source,
        levels: r.levels,
        accum: r.accum,
        drift: r.drift,
        driftTs: r.driftTs,
      };
    }
    return this.cached;
  }

  schedule() {
    const now = Date.now();
    const wait = Math.max(0, THROTTLE_MS - (now - this.lastSent));
    if (this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.lastSent = Date.now();
      // Nobody attached: the feed is in its linger window, so keep the book
      // fresh but do not pay to reduce it for an audience of zero.
      if (!this.clients.size) return;
      const p = this.payload();
      if (p) this.broadcast({ ...p, vol24h: this.vol, volTs: this.volTs });
    }, wait);
  }

  broadcast(msg) {
    if (!this.clients.size) return;
    const s = JSON.stringify(msg);
    for (const c of this.clients) {
      // bufferedAmount is what the socket has accepted but not yet flushed to
      // the network. Past the cap the client is behind: skip this frame and let
      // it catch up on the next one, which is strictly fresher anyway.
      if (c.bufferedAmount > MAX_BUFFERED_BYTES) { this.dropped++; continue; }
      try { c.send(s); } catch {}
    }
  }

  add(client, owner) {
    clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
    this.clients.add(client);
    this.ownerOf.set(client, owner);
    client.send(JSON.stringify({ op: 'status', state: this.state, detail: this.detail }));
    const p = this.payload();
    if (p) client.send(JSON.stringify({ ...p, vol24h: this.vol, volTs: this.volTs }));
  }

  remove(client) {
    if (!this.clients.delete(client)) return;
    const owner = this.ownerOf.get(client);
    this.ownerOf.delete(client);
    if (owner !== undefined) quota.release(owner, this.key);
    // destroy() detaches its remaining clients so their quota is given back, and
    // that must not arm a fresh 30 s linger on a feed that is already gone —
    // one dangling timer per feed is 30 s of a shutdown that has nothing left
    // to do.
    if (this.closed) return;
    if (this.clients.size === 0 && !this.lingerTimer) {
      this.lingerTimer = setTimeout(() => {
        if (this.clients.size === 0) this.destroy();
      }, LINGER_MS);
    }
  }

  /** One row for the ring: cumulative counters plus the two facts that decay. */
  sample(now = Date.now()) {
    return {
      t: now,
      state: this.state,
      books: this.books,
      reconnects: this.reconnects,
      errors: this.errors,
      droppedFrames: this.dropped,
      rejectedBooks: this.rejected.empty + this.rejected.crossed + this.rejected.badMid,
      clients: this.clients.size,
      ageMs: this.raw ? now - this.raw.tsRecv : null,
      venueLatencyMs: this.raw?.tsVenue != null ? this.raw.tsRecv - this.raw.tsVenue : null,
    };
  }

  destroy() {
    this.closed = true;
    // Anything blocked on the next book has to be let go, or a /api/depth call
    // outlives the feed it was waiting for and only ends on its own timeout.
    for (const r of this.waiters.splice(0)) r();
    clearInterval(this.volTimer);
    clearTimeout(this.lingerTimer);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    for (const c of [...this.clients]) this.remove(c);
    try { this.conn?.close(); } catch {}
    feeds.delete(this.key);
  }
}

// Sampling runs on one timer for the whole process rather than one per feed,
// and it is unref'd: importing the hub (tools/test-trim.mjs does, for `trim`)
// must never be the reason a script refuses to exit.
const sampler = setInterval(() => {
  const now = Date.now();
  for (const f of feeds.values()) f.history.push(f.sample(now));
}, SAMPLE_MS);
sampler.unref?.();

export function subscribe(client, { exchange, market, symbol, range }, currentFeed = null) {
  const ad = adapters[exchange];
  if (!ad) throw new Error(`unknown exchange ${exchange}`);
  if (!ad.markets.includes(market)) throw new Error(`${ad.name} has no ${market} market`);
  if (!okSymbol(symbol)) throw new Error('invalid symbol');
  // The range only ever selects a view of a book that is clipped at ±12%
  // anyway, so a caller cannot widen the work this server does by asking for
  // ±1e9 — but it also must not reach the arithmetic as NaN or a negative.
  const opts = { range: Math.min(50, Math.max(0.01, +range || 2)) };
  const key = `${exchange}:${market}:${symbol}`;
  // A range change that does not alter the upstream subscription must not
  // tear the feed down and rebuild it.
  if (currentFeed && currentFeed.key === key) return currentFeed;
  const owner = client.owner ?? 'local';
  // The per-client cap is charged BEFORE the old feed is released, so a client
  // at its limit cannot be pushed over by its own switch between two symbols
  // and cannot dodge the cap by holding the release until after the grant.
  quota.acquire(owner, key);
  try {
    if (currentFeed) currentFeed.remove(client);
    let feed = feeds.get(key);
    if (!feed) {
      if (feeds.size >= MAX_FEEDS) {
        const e = new Error(`this server already holds ${feeds.size} live feeds (max ${MAX_FEEDS}); try again in a moment`);
        e.code = 'QUOTA';
        throw e;
      }
      feed = new Feed(key, exchange, market, symbol, opts);
      feeds.set(key, feed);
    }
    feed.add(client, owner);
    return feed;
  } catch (e) {
    quota.release(owner, key);
    throw e;
  }
}

export function closeAll() {
  for (const f of [...feeds.values()]) f.destroy();
}

/**
 * What each live feed is actually doing, for /api/feeds.
 *
 * `state` alone is not health: it is set by the last status event, so a feed
 * that reconnects constantly still reads `live` between drops, and one whose
 * socket went quiet without closing reads `live` forever. `ageMs` is the
 * measurement that cannot lie — how long since a book last arrived — and
 * `window` is the same question asked of the last hour instead of this instant.
 */
export function stats({ history = false } = {}) {
  const now = Date.now();
  return [...feeds.values()].map((f) => {
    const samples = f.history.toArray();
    return {
      key: f.key,
      clients: f.clients.size,
      state: f.state,
      source: f.raw?.source ?? null,
      ageMs: f.raw ? now - f.raw.tsRecv : null,
      venueLatencyMs: f.raw?.tsVenue != null ? f.raw.tsRecv - f.raw.tsVenue : null,
      levels: f.raw?.levels ?? null,
      books: f.books,
      reconnects: f.reconnects,
      errors: f.errors,
      droppedFrames: f.dropped,
      rejected: { ...f.rejected },
      volAgeMs: f.volTs == null ? null : now - f.volTs,
      driftAgeMs: f.raw?.driftTs == null ? null : now - f.raw.driftTs,
      upMs: now - f.openedAt,
      window: summarize(samples),
      ...(history ? { history: samples } : {}),
    };
  });
}

export function feedCount() { return feeds.size; }

/**
 * One book, for callers that are not a browser (`GET /api/depth`).
 *
 * It joins the same Feed a viewer would, so a symbol somebody is already
 * watching costs nothing, and `LINGER_MS` keeps the upstream connection warm
 * between polls instead of reopening it on every call.
 *
 * `raw` decides which book comes back. The reduced one is what the screen is
 * looking at, so a figure computed from it cannot disagree with the panel; the
 * raw one is the venue's own levels, which is what anyone sizing an order needs
 * and what the bucketed curve cannot answer between two of its edges.
 */
export async function snapshot({ exchange, market, symbol, range, owner = 'local' }, timeoutMs = 10_000) {
  const client = { send() {}, bufferedAmount: 0, owner }; // a listener without a socket
  const feed = subscribe(client, { exchange, market, symbol, range });
  try {
    // Woken by onBook rather than polled. The old loop slept 50 ms at a time,
    // so a feed that already had a book still answered up to 50 ms late and one
    // that was opening answered up to 50 ms after it was ready — latency this
    // route invented for itself, on every call, on top of the exchange's.
    if (!feed.raw) {
      let timer;
      await Promise.race([
        new Promise((r) => feed.waiters.push(r)),
        new Promise((r) => { timer = setTimeout(r, timeoutMs); }),
      ]).finally(() => clearTimeout(timer));
    }
    if (!feed.raw) {
      // A feed that failed says why; one that is merely slow cannot, and the
      // two must not share a message.
      throw new Error(feed.state === 'error' && feed.detail
        ? feed.detail
        : `no book from ${exchange} ${market} ${symbol} within ${timeoutMs}ms`);
    }
    return { ...feed.payload(), vol24h: feed.vol, volTs: feed.volTs, raw: feed.raw };
  } finally {
    feed.remove(client);
  }
}
