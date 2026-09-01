import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters, catalog } from './adapters/index.js';
import { subscribe, stats } from './hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
// Loopback by default: depthviz has no authentication, and every viewer makes
// this host open upstream connections to six exchanges from its own IP — on a
// box that also runs trading bots, that is someone else's rate-limit budget.
// Exposing it is therefore opt-in: set HOST=0.0.0.0 deliberately.
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

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
