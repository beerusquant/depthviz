import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters, catalog } from './adapters/index.js';
import { subscribe, stats, snapshot, closeAll, clipRaw, feedCount } from './hub.js';
import { computeMetrics } from '../shared/metrics.js';
import { renderPrometheus } from './health.js';
import { Counter } from './quota.js';
import { tokenBucket } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
// Loopback by default: depthviz has no authentication, and every viewer makes
// this host open upstream connections to eight exchanges from its own IP — on a
// box that also runs trading bots, that is someone else's rate-limit budget.
// Exposing it is therefore opt-in: set HOST=0.0.0.0 deliberately.
const HOST = process.env.HOST || '127.0.0.1';
// Behind a reverse proxy every request arrives from the proxy, so every caller
// shares one bucket and one quota — the limits then either throttle everybody
// at once or nobody. Reading X-Forwarded-For is only safe when something in
// front is guaranteed to set it, so it is opt-in and never inferred.
const TRUST_PROXY = process.env.DEPTHVIZ_TRUST_PROXY === '1';
const MAX_SOCKETS_PER_IP = +process.env.DEPTHVIZ_MAX_SOCKETS_PER_IP || 24;
const STARTED = Date.now();

/** Who is asking. One address is one budget, for the buckets and for the quota. */
const ownerOf = (req) => {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
};

// Two buckets, because the two kinds of route cost different things upstream.
// `/api/depth` joins (and may open) a feed to an exchange; `/api/symbols`
// fetches a listing, cached for five minutes but a megabyte when it misses.
//
// What the bucket is for, and what it is not: the thing that actually bounds
// what a client costs an exchange is the per-client feed quota (twelve), since
// a feed is one upstream connection however often it is asked for. The bucket
// only stops a tight loop from making this process do that work over and over.
// So the sustained rate is set where a legitimate poller lives rather than as
// low as it will go — tools/measure-drift.mjs watches four instruments once a
// second, and a limit that throttles this repo's own measurements is a limit
// that will be raised in anger rather than reasoned about.
const depthBucket = tokenBucket(+process.env.DEPTHVIZ_DEPTH_BURST || 20, +process.env.DEPTHVIZ_DEPTH_RATE || 5);
const listBucket = tokenBucket(+process.env.DEPTHVIZ_LIST_BURST || 30, +process.env.DEPTHVIZ_LIST_RATE || 2);
const limit = (bucket) => (req, res, next) => {
  const wait = bucket.take(ownerOf(req));
  if (wait == null) return next();
  res.set('Retry-After', String(Math.max(1, Math.ceil(wait))));
  res.status(429).json({ error: `rate limit: retry in ${wait.toFixed(1)}s` });
};
// The bucket maps are keyed by remote address, so they grow with whoever calls.
// Idle entries are full by definition and forgetting them changes nothing.
setInterval(() => { depthBucket.sweep(); listBucket.sweep(); }, 60_000).unref();

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, '..', 'public')));
// The metrics module is shared, not duplicated: the browser imports the same
// file this process does, so `/api/depth` and the on-screen panel cannot drift
// apart. It is served from its own mount because the browser cannot reach above
// the static root.
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));

app.get('/api/catalog', (_req, res) => res.json(catalog));

/**
 * What every feed is doing. `?history=1` adds the raw sample ring behind the
 * `window` summary — the last hour, per feed, at ten-second resolution.
 *
 * Bucketed, unlike `/metrics`: 48 feeds x 360 samples is a couple of megabytes,
 * which is cheap amplification for anyone who can reach this. `/metrics` stays
 * open because it is small, bounded, and the thing that is supposed to poll it
 * every fifteen seconds must never be the thing that gets throttled.
 */
app.get('/api/feeds', limit(listBucket), (req, res) => res.json(stats({ history: req.query.history === '1' })));

/**
 * The same facts, for something that never sleeps.
 *
 * A counter nobody scrapes is a counter nobody reads: `/api/feeds` can only
 * tell you what is true at the instant you ask, and the failure this tool must
 * never have — a feed that quietly stops advancing — is invisible in a single
 * reading. Alert on depthviz_feed_book_age_ms.
 */
app.get('/metrics', (_req, res) => {
  res.type('text/plain; version=0.0.4');
  res.send(renderPrometheus(stats(), {
    clients: wss.clients.size,
    uptimeMs: Date.now() - STARTED,
    memory: process.memoryUsage(),
  }));
});

app.get('/api/symbols', limit(listBucket), async (req, res) => {
  const { exchange, market } = req.query;
  const ad = adapters[exchange];
  if (!ad) return res.status(404).json({ error: `unknown exchange ${exchange}` });
  if (!ad.markets.includes(market)) return res.status(400).json({ error: `${ad.name} has no ${market} market` });
  try {
    const symbols = await ad.listSymbols(market);
    res.json({ exchange, market, count: symbols.length, symbols, note: ad.notes?.[market] || null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/**
 * One depth reading, as JSON, for anything that is not a browser.
 *
 * Every number the UI shows was computed in the page and died there: getting a
 * depth figure out of this tool meant opening Chrome and pressing COPY. This
 * route runs the same `computeMetrics` the page does, so a script and the
 * screen cannot disagree.
 *
 *   curl '.../api/depth?exchange=binance&market=spot&symbol=BTCUSDT&range=0.5'
 *
 * `levels` decides what comes back, and which book the figures were computed
 * from:
 *
 *   (absent)  the reduced book's figures, no levels — what the screen shows.
 *   trimmed   the same figures, plus the [vwapPrice, summedQty] rows shipped
 *             to a browser.
 *   raw       the venue's own levels inside ±range, and the figures computed
 *             from THEM.
 *
 * The last one is not a nicety. The reduction preserves cumulative notional,
 * cumulative quantity and VWAP exactly at every bucket edge, and interpolates
 * between two edges — so "what price does 40 BTC walk to" is answerable only
 * from the raw book, and that is the question anyone sizing an order is asking.
 * The two answers agree at ±2%, ±5% and ±10%, which the reduction splits on
 * purpose, and can differ by up to one 5 bps bucket at any other range. Which
 * book the figures came from is reported in `metricsFrom` rather than left for
 * the caller to work out.
 */
app.get('/api/depth', limit(depthBucket), async (req, res) => {
  const { exchange, market, symbol } = req.query;
  const range = Math.min(50, Math.max(0.01, +req.query.range || 2));
  const want = req.query.levels === 'raw' ? 'raw' : req.query.levels === 'trimmed' ? 'trimmed' : 'none';
  const ad = adapters[exchange];
  if (!ad) return res.status(404).json({ error: `unknown exchange ${exchange}` });
  if (!ad.markets.includes(market)) return res.status(400).json({ error: `${ad.name} has no ${market} market` });
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });
  try {
    const book = await snapshot({ exchange, market, symbol, range, owner: ownerOf(req) });
    // The raw book is the venue's levels; asking for them and then being handed
    // figures derived from the reduced curve would be the worst of both. The
    // figures are computed over the WHOLE raw book, never the clipped copy:
    // `depthPlus5` and `reach` are answers about the book, and a caller asking
    // for ±0.5% of levels must not silently be told the book ends at ±0.5%.
    const source = want === 'raw' ? { bids: book.raw.bids, asks: book.raw.asks } : book;
    const m = computeMetrics(source, range);
    if (!m) return res.status(503).json({ error: 'book has no usable top of book yet' });
    const now = Date.now();
    res.json({
      exchange, market, symbol, range,
      transport: book.source,
      metricsFrom: want === 'raw' ? 'raw' : 'shipped',
      // Two clocks, kept apart on purpose: tsVenue is the exchange's own event
      // time and is null where the venue stamps nothing, so a caller can always
      // tell a measured latency from a missing one.
      tsVenue: book.tsVenue,
      tsRecv: book.tsRecv,
      ageMs: now - book.tsRecv,
      venueLatencyMs: book.tsVenue != null ? book.tsRecv - book.tsVenue : null,
      levels: book.levels,
      accumulating: book.accum ? { since: book.accum.since } : null,
      drift: book.drift,
      vol24h: book.vol24h ?? null,
      mid: m.mid, bestBid: m.bestBid, bestAsk: m.bestAsk,
      spread: m.spread, spreadPct: m.spreadPct,
      bidVwap: m.bidVwap, bidVwapPct: m.bidVwapPct,
      askVwap: m.askVwap, askVwapPct: m.askVwapPct,
      bidDepth: m.bidDepth, askDepth: m.askDepth, totalDepth: m.totalDepth,
      depthPlus2: m.depthPlus2, depthMinus2: m.depthMinus2,
      depthPlus5: m.depthPlus5, depthMinus5: m.depthMinus5,
      // Resting-depth imbalance over ±range. Named for what it measures: it is
      // not order-flow imbalance, which is built from changes in the book.
      imbalance: m.imbalance, imbalanceLabel: m.imbalanceLabel,
      // The book stopping inside the requested range is a property of the
      // venue, not an error, but a caller integrating this must be able to see
      // it without reading the chart.
      reach: { bid: m.bid.reach, ask: m.ask.reach, shortBid: m.shortBid, shortAsk: m.shortAsk },
      ...(want === 'none' ? {} : {
        book: {
          form: want,
          bids: want === 'raw' ? clipRaw(book.raw.bids, book.raw.mid, range) : book.bids,
          asks: want === 'raw' ? clipRaw(book.raw.asks, book.raw.mid, range) : book.asks,
          note: want === 'raw'
            ? 'The venue\'s own levels inside ±range, in base units.'
            : '[vwapPrice, summedQty] rows: exact in cumulative notional, quantity and VWAP, interpolated between bucket edges.',
        },
      }),
    });
  } catch (e) {
    // A quota refusal is not a gateway timeout: it is this server saying no,
    // and it is retryable in a second. Everything else here is the venue.
    if (e.code === 'QUOTA') { res.set('Retry-After', '5'); return res.status(429).json({ error: e.message }); }
    res.status(504).json({ error: e.message });
  }
});

// One venue answering with malformed JSON at three in the morning must not take
// the other twelve feeds down with it. Node's default is to kill the process on
// an unhandled rejection, and under systemd that becomes a restart loop in which
// every feed reconnects and re-fetches — the exchanges get hit hardest exactly
// when something is already wrong. Log it and keep serving; the feed that raised
// it will show up in /api/feeds with a stale `ageMs` either way.
process.on('unhandledRejection', (err) => {
  console.error(`[unhandled] ${err?.stack || err}`);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// A socket is not a feed: a client can hold one subscription and open two
// hundred connections, and each of those is memory and event-loop cost before
// it has asked for anything at all.
const sockets = new Counter(MAX_SOCKETS_PER_IP);

wss.on('connection', (ws, req) => {
  const owner = ownerOf(req);
  if (!sockets.add(owner)) {
    ws.send(JSON.stringify({ op: 'status', state: 'error', detail: `too many connections from ${owner} (max ${MAX_SOCKETS_PER_IP})` }));
    ws.close(1013, 'too many connections');
    return;
  }
  // The hub charges the per-client feed quota against this.
  ws.owner = owner;
  let feed = null;
  let released = false;
  const detach = () => { if (feed) { feed.remove(ws); feed = null; } };
  const gone = () => { detach(); if (!released) { released = true; sockets.sub(owner); } };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.op === 'subscribe') {
      try {
        feed = subscribe(ws, msg, feed);
      } catch (e) {
        feed = null;
        ws.send(JSON.stringify({ op: 'status', state: 'error', detail: e.message }));
      }
    } else if (msg.op === 'unsubscribe') {
      detach();
      ws.send(JSON.stringify({ op: 'status', state: 'idle', detail: '' }));
    } else if (msg.op === 'ping') {
      ws.send(JSON.stringify({ op: 'pong', t: msg.t }));
    }
  });

  ws.on('close', gone);
  ws.on('error', gone);
});

server.listen(PORT, HOST, () => console.log(`depthviz listening on http://${HOST}:${PORT}`));

// systemd sends SIGTERM on restart and SIGKILLs what is left 90 s later. Exiting
// without closing the upstream sockets leaves eight exchanges holding half-open
// connections from this IP until they time them out — and a restart loop then
// stacks them. Close the feeds, stop accepting, and let the process end on its
// own; if anything is still holding the loop after 5 s, leave anyway.
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    console.log(`${sig}: closing ${feedCount()} feeds`);
    closeAll();
    for (const c of wss.clients) { try { c.close(1001, 'server shutting down'); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
