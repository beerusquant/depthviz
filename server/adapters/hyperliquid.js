import { postJson, ttlCache, reconnectingWs } from '../util.js';

const INFO = 'https://api.hyperliquid.xyz/info';
const WS = 'wss://api.hyperliquid.xyz/ws';

const perpMeta = ttlCache(() => postJson(INFO, { type: 'meta' }), 5 * 60_000);
const spotMeta = ttlCache(() => postJson(INFO, { type: 'spotMeta' }), 5 * 60_000);

const perpCtx = ttlCache(async () => {
  const [meta, ctxs] = await postJson(INFO, { type: 'metaAndAssetCtxs' });
  const m = new Map();
  meta.universe.forEach((u, i) => m.set(u.name, +ctxs[i]?.dayNtlVlm || null));
  return m;
}, 45_000);

const spotCtx = ttlCache(async () => {
  const [, ctxs] = await postJson(INFO, { type: 'spotMetaAndAssetCtxs' });
  // Spot contexts are NOT positionally aligned with spotMeta.universe — each
  // one names its own pair in `coin`, so key off that.
  const m = new Map();
  for (const c of ctxs) m.set(c.coin, +c.dayNtlVlm || null);
  return m;
}, 45_000);

/**
 * Hyperliquid returns exactly 20 aggregated levels per side, whatever you ask
 * for; `nSigFigs` only chooses how coarse each level is, and therefore how far
 * the 20 of them reach. One subscription can be either precise or wide, never
 * both — so we run three in parallel and stitch them:
 *
 *   null -> finest ticks, ~±0.03% on BTC   (owns mid / spread / near book)
 *   3    -> ~±2.5%                         (fills the mid range)
 *   2    -> ~±25%                          (fills the tail)
 *
 * A coarse bucket is only accepted once it clears the next-finer layer's
 * outermost level by a full bucket width, so nothing is ever counted twice.
 * The cost is a one-bucket seam between layers.
 */
const LAYERS = [null, 3, 2];

function stitch(sides, isBid) {
  // sides: fine -> coarse, each [[price, size], ...] already sorted outward
  const out = [];
  let edge = null;
  for (const rows of sides) {
    if (!rows?.length) continue;
    if (edge === null) {
      out.push(...rows);
      edge = rows[rows.length - 1][0];
      continue;
    }
    const step = rows.length > 1 ? Math.abs(rows[0][0] - rows[1][0]) : 0;
    for (const [p, q] of rows) {
      if (isBid ? p <= edge - step : p >= edge + step) out.push([p, q]);
    }
    edge = out[out.length - 1][0];
  }
  return out;
}

export default {
  id: 'hyperliquid',
  name: 'Hyperliquid',
  markets: ['spot', 'perp'],
  transport: { spot: 'ws', perp: 'ws' },
  notes: {
    spot: 'Hyperliquid serves 20 aggregated levels per subscription; the book here is stitched from three parallel l2Book feeds (finest + ~±2.5% + ~±25%), so mid and spread come from the finest ticks at every range. Expect a one-bucket gap where two layers meet.',
    perp: 'Hyperliquid serves 20 aggregated levels per subscription; the book here is stitched from three parallel l2Book feeds (finest + ~±2.5% + ~±25%), so mid and spread come from the finest ticks at every range. Expect a one-bucket gap where two layers meet.',
  },

  async listSymbols(market) {
    if (market === 'perp') {
      const meta = await perpMeta();
      return meta.universe
        .filter((u) => !u.isDelisted)
        .map((u) => ({ s: u.name, d: `${u.name}/USD`, base: u.name, quote: 'USD' }))
        .sort((a, b) => a.d.localeCompare(b.d));
    }
    const meta = await spotMeta();
    // `tokens` is sparse: entries carry their own `index`, which is what
    // universe[].tokens refers to — positional lookup silently misses.
    const tok = new Map(meta.tokens.map((t) => [t.index, t]));
    return meta.universe.map((u) => {
      const b = tok.get(u.tokens[0])?.name ?? `#${u.tokens[0]}`;
      const q = tok.get(u.tokens[1])?.name ?? `#${u.tokens[1]}`;
      return { s: u.name, d: `${b}/${q}`, base: b, quote: q };
    }).sort((a, b) => a.d.localeCompare(b.d));
  },

  async vol24h(market, s) {
    const m = market === 'perp' ? await perpCtx() : await spotCtx();
    return m.get(s) ?? null;
  },

  open(market, s, opts, emit, status) {
    const snaps = LAYERS.map(() => null);

    const publish = () => {
      if (!snaps[0]) return; // the finest layer owns mid/spread; wait for it
      const bids = stitch(snaps.map((x) => x?.bids), true);
      const asks = stitch(snaps.map((x) => x?.asks), false);
      if (!bids.length || !asks.length) return;
      emit({ bids, asks, ts: Math.max(...snaps.filter(Boolean).map((x) => x.ts)), source: 'ws' });
    };

    const conns = LAYERS.map((nSigFigs, i) => reconnectingWs(WS, {
      onOpen: (send) => send({ method: 'subscribe', subscription: { type: 'l2Book', coin: s, nSigFigs } }),
      onMessage: (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.channel === 'error') { status('error', `Hyperliquid: ${msg.data}`); return; }
        if (msg.channel !== 'l2Book' || !msg.data) return;
        const [b, a] = msg.data.levels;
        snaps[i] = {
          bids: b.map((l) => [+l.px, +l.sz]),
          asks: a.map((l) => [+l.px, +l.sz]),
          ts: msg.data.time || Date.now(),
        };
        publish();
      },
      onStatus: (st, d) => {
        // Only the finest layer drives the visible connection state; a coarse
        // layer reconnecting must not make the app claim it is offline.
        if (i === 0) status(st, d);
      },
    }, { pingMs: 30_000, pingPayload: JSON.stringify({ method: 'ping' }) }));

    return { close() { for (const c of conns) { try { c.close(); } catch {} } } };
  },
};
