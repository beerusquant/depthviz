import { fetchJson, ttlCache, poller, pbFields, watchdogFallback } from '../util.js';
import { openDiffBook } from './diff-book.js';

const SPOT = 'https://api.mexc.com';
const FUT = 'https://contract.mexc.com';
const SPOT_WS = 'wss://wbs-api.mexc.com/ws';
const FUT_WS = 'wss://contract.mexc.com/edge';

const spotInfo = ttlCache(async () => {
  const j = await fetchJson(`${SPOT}/api/v3/exchangeInfo`);
  return j.symbols.filter((x) => x.status === '1' && x.isSpotTradingAllowed);
}, 5 * 60_000);

const futInfo = ttlCache(async () => {
  const j = await fetchJson(`${FUT}/api/v1/contract/detail`);
  return (j.data || []).filter((x) => x.state === 0 && x.apiAllowed !== false);
}, 5 * 60_000);

const futSizes = ttlCache(async () => {
  const m = new Map();
  for (const c of await futInfo()) m.set(c.symbol, +c.contractSize || 1);
  return m;
}, 5 * 60_000);

const spotTickers = ttlCache(async () => {
  const rows = await fetchJson(`${SPOT}/api/v3/ticker/24hr`);
  return new Map(rows.map((t) => [t.symbol, +t.quoteVolume]));
}, 45_000);

const futTickers = ttlCache(async () => {
  const j = await fetchJson(`${FUT}/api/v1/contract/ticker`);
  return new Map((j.data || []).map((t) => [t.symbol, +t.amount24]));
}, 45_000);

/**
 * MEXC spot v3 pushes protobuf frames. The schema is stable and small; these
 * are the only field numbers we need, mapped from the live wire format:
 *   1 = channel, 3 = symbol, 6 = send time (epoch ms), 313 = PublicAggreDepths body
 *   313.1 = asks[], 313.2 = bids[]  (each: 1 = price str, 2 = qty str)
 *   313.4 = fromVersion, 313.5 = toVersion
 *
 * Field 6 was found the same way as the rest — walking live frames — and was
 * being dropped, so this feed reported no venue clock at all while the venue
 * was stamping every frame. It is MEXC's *send* time, not the moment the book
 * changed, which is the honest thing to compare our receive time against.
 */
const DEPTH_BODY_FIELD = 313;
export function decodeSpotDepth(buf) {
  const top = pbFields(buf);
  const body = top.get(DEPTH_BODY_FIELD)?.[0];
  if (!body) return null;
  const f = pbFields(body);
  const levels = (arr) => (arr || []).map((b) => {
    const g = pbFields(b);
    return [+g.get(1)?.[0].toString('utf8'), +g.get(2)?.[0].toString('utf8')];
  });
  const str = (n) => f.get(n)?.[0]?.toString('utf8');
  const sent = top.get(6)?.[0];
  return {
    asks: levels(f.get(1)),
    bids: levels(f.get(2)),
    from: +str(4),
    to: +str(5),
    ts: typeof sent === 'bigint' ? Number(sent) : null,
  };
}

/**
 * The perp `push.depth` payload. Sizes are in CONTRACTS, so `cs` is applied
 * here and the engine never learns that contracts exist. Exported because a
 * forgotten multiplier is an invisible order-of-magnitude error, and because
 * both timestamps were once dropped on this exact path.
 */
export function decodePerpDepth(raw, cs) {
  const msg = JSON.parse(raw.toString());
  if (msg.channel !== 'push.depth' || !msg.data) return null;
  const d = msg.data;
  return {
    bids: (d.bids || []).map((r) => [+r[0], +r[1] * cs]),
    asks: (d.asks || []).map((r) => [+r[0], +r[1] * cs]),
    from: d.begin, to: d.end ?? d.version,
    // `cts` is when the book changed, `ts` when the frame was sent; prefer the
    // former. Both were being ignored, so this feed claimed no clock.
    ts: d.cts ?? msg.ts ?? null,
  };
}

/**
 * Both MEXC markets are snapshot + versioned-diff books, so they are two
 * configs for the shared engine rather than two implementations. They differ in
 * transport (protobuf frames on spot, JSON on perp), in what the sequence
 * fields are called, and in the fact that perp quotes contracts — all of which
 * a decode/snapshot pair absorbs.
 */
const spotBook = (s) => ({
  label: 'MEXC spot',
  ws: SPOT_WS,
  subscribe: (send) => send({ method: 'SUBSCRIPTION', params: [`spot@public.aggre.depth.v3.api.pb@100ms@${s}`] }),
  pingMs: 20_000,
  pingPayload: JSON.stringify({ method: 'PING' }),
  style: 'from',
  decode: (raw) => {
    if (!Buffer.isBuffer(raw) || raw[0] === 0x7b) return null; // '{' -> control JSON
    return decodeSpotDepth(raw);
  },
  snapshot: async () => {
    const snap = await fetchJson(`${SPOT}/api/v3/depth?symbol=${encodeURIComponent(s)}&limit=5000`);
    return {
      bids: snap.bids.map((r) => [+r[0], +r[1]]),
      asks: snap.asks.map((r) => [+r[0], +r[1]]),
      version: snap.lastUpdateId,
    };
  },
});

const perpBook = (s, cs) => ({
  label: 'MEXC perp',
  ws: FUT_WS,
  subscribe: (send) => send({ method: 'sub.depth', param: { symbol: s } }),
  pingMs: 15_000,
  pingPayload: JSON.stringify({ method: 'ping' }),
  style: 'from',
  decode: (raw) => decodePerpDepth(raw, cs),
  snapshot: async () => {
    const j = await fetchJson(`${FUT}/api/v1/contract/depth/${encodeURIComponent(s)}`);
    const d = j.data || {};
    return {
      bids: (d.bids || []).map((r) => [+r[0], +r[1] * cs]),
      asks: (d.asks || []).map((r) => [+r[0], +r[1] * cs]),
      version: +d.version,
      ts: d.timestamp,
    };
  },
});

/** REST polling, kept as the safety net behind both websockets. */
function pollBook(market, s, cs, emit, status) {
  return poller(async () => {
    if (market === 'spot') {
      const j = await fetchJson(`${SPOT}/api/v3/depth?symbol=${encodeURIComponent(s)}&limit=5000`);
      emit({ bids: j.bids.map((r) => [+r[0], +r[1]]), asks: j.asks.map((r) => [+r[0], +r[1]]), ts: null, source: 'poll' });
    } else {
      const j = await fetchJson(`${FUT}/api/v1/contract/depth/${encodeURIComponent(s)}`);
      const d = j.data || {};
      emit({
        bids: (d.bids || []).map((r) => [+r[0], +r[1] * cs]),
        asks: (d.asks || []).map((r) => [+r[0], +r[1] * cs]),
        ts: d.timestamp ?? null, source: 'poll',
      });
    }
  }, 1000, (e) => status('error', `MEXC poll: ${e.message}`));
}

export default {
  id: 'mexc',
  name: 'MEXC',
  markets: ['spot', 'perp'],
  transport: { spot: 'ws', perp: 'ws' },

  async listSymbols(market) {
    if (market === 'spot') {
      return (await spotInfo()).map((x) => ({
        s: x.symbol, d: `${x.baseAsset}/${x.quoteAsset}`, base: x.baseAsset, quote: x.quoteAsset,
      })).sort((a, b) => a.d.localeCompare(b.d));
    }
    return (await futInfo()).map((x) => ({
      s: x.symbol, d: `${x.baseCoin}/${x.quoteCoin}`, base: x.baseCoin, quote: x.quoteCoin,
    })).sort((a, b) => a.d.localeCompare(b.d));
  },

  async vol24h(market, s) {
    const m = market === 'spot' ? await spotTickers() : await futTickers();
    return m.get(s) ?? null;
  },

  async open(market, s, opts, emit, status) {
    const cs = market === 'perp' ? ((await futSizes()).get(s) || 1) : 1;
    // If the websocket has not produced a book in 8s, poll until it recovers.
    const wd = watchdogFallback(8000, () => pollBook(market, s, cs, emit, status));
    const wrapped = (book) => { wd.ok(); emit(book); };
    const conn = openDiffBook(market === 'spot' ? spotBook(s) : perpBook(s, cs), wrapped, status);
    return { close() { wd.close(); conn.close(); } };
  },
};
