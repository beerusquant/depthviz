import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters, catalog } from './adapters/index.js';
import { subscribe, stats, snapshot, closeAll } from './hub.js';
import { computeMetrics } from '../shared/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
// Loopback by default: depthviz has no authentication, and every viewer makes
// this host open upstream connections to eight exchanges from its own IP — on a
// box that also runs trading bots, that is someone else's rate-limit budget.
// Exposing it is therefore opt-in: set HOST=0.0.0.0 deliberately.
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
// The metrics module is shared, not duplicated: the browser imports the same
// file this process does, so `/api/depth` and the on-screen panel cannot drift
// apart. It is served from its own mount because the browser cannot reach above
// the static root.
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));

app.get('/api/catalog', (_req, res) => res.json(catalog));
app.get('/api/feeds', (_req, res) => res.json(stats()));

app.get('/api/symbols', async (req, res) => {
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
 * route runs the same `computeMetrics` over the same trimmed book the socket
 * ships, so a script and the screen cannot disagree.
 *
 *   curl '.../api/depth?exchange=binance&market=spot&symbol=BTCUSDT&range=0.5'
 */
app.get('/api/depth', async (req, res) => {
  const { exchange, market, symbol } = req.query;
  const range = Math.min(50, Math.max(0.01, +req.query.range || 2));
  const ad = adapters[exchange];
  if (!ad) return res.status(404).json({ error: `unknown exchange ${exchange}` });
  if (!ad.markets.includes(market)) return res.status(400).json({ error: `${ad.name} has no ${market} market` });
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });
  try {
    const book = await snapshot({ exchange, market, symbol, range });
    const m = computeMetrics(book, range);
    if (!m) return res.status(503).json({ error: 'book has no usable top of book yet' });
    const now = Date.now();
    res.json({
      exchange, market, symbol, range,
      transport: book.source,
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
    });
  } catch (e) {
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

wss.on('connection', (ws) => {
  let feed = null;
  const detach = () => { if (feed) { feed.remove(ws); feed = null; } };

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

  ws.on('close', detach);
  ws.on('error', detach);
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
    console.log(`${sig}: closing ${stats().length} feeds`);
    closeAll();
    for (const c of wss.clients) { try { c.close(1001, 'server shutting down'); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
