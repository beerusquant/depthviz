import { postJson, ttlCache, reconnectingWs, coalesce, PUBLISH_MS } from '../util.js';

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
 * for; `nSigFigs` and `mantissa` only choose how coarse each level is, and
 * therefore how far the 20 of them reach. One subscription can be precise or
 * wide, never both — so several run in parallel and are stitched.
 *
 * Measured bucket width / reach on BTC (2026-09-01):
 *
 *   {}                        0.0013%   ±0.025%   <- owns mid / spread
 *   { nSigFigs:5, mantissa:2} 0.0026%   ±0.050%
 *   { nSigFigs:5, mantissa:5} 0.0064%   ±0.125%
 *   { nSigFigs:4 }            0.0128%   ±0.249%
 *   { nSigFigs:3 }            0.1278%   ±2.492%
 *   { nSigFigs:2 }            1.2739%   ±24.84%
 *
 * The first version of this ran only {}, 3 and 2, which jumped straight from
 * 0.0013% buckets to 0.128% ones: everything between ±0.025% and ±2.5% was
 * drawn as a five-step staircase. The four intermediate layers are what the
 * venue was already willing to serve.
 *
 * Cheap coins collapse the ladder — on PUMP the top four layers are byte
 * identical because the price carries too few significant digits. Nothing is
 * lost when that happens: identical layers simply add no levels.
 */
export const LAYERS = [
  {},
  { nSigFigs: 5, mantissa: 2 },
  { nSigFigs: 5, mantissa: 5 },
  { nSigFigs: 4 },
  { nSigFigs: 3 },
  { nSigFigs: 2 },
];

/**
 * Stitch layers fine -> coarse without a seam and without double counting.
 *
 * Every layer is complete from the top of book out to its own edge, so the two
 * are reconciled on CUMULATIVE quantity rather than on price boundaries: the
 * first coarse bucket reaching past the fine edge contributes
 * `cumulative_coarse - cumulative_fine`, i.e. exactly the part of that bucket
 * the finer layer could not see. Buckets fully inside the fine region add
 * nothing, buckets fully outside are taken as they are.
 *
 * This is what removes the one-bucket hole the old rule left at every seam: it
 * dropped any coarse bucket that straddled the edge, and the depth inside it
 * with it. Cumulative depth at any price is now preserved exactly, which is the
 * only property the chart actually reads.
 *
 * A negative residual means the two subscriptions were sampled a moment apart
 * and the coarse one is now smaller; it is clamped to zero rather than allowed
 * to subtract depth that exists.
 */
export function stitch(sides, isBid) {
  const out = [];
  let edge = null;      // outermost price accepted so far
  let cumFine = 0;      // cumulative quantity already accounted for
  for (const rows of sides) {
    if (!rows?.length) continue;
    if (edge === null) {
      for (const [p, q] of rows) { out.push([p, q]); cumFine += q; }
      edge = out[out.length - 1][0];
      continue;
    }
    const beyond = (p) => (isBid ? p < edge : p > edge);
    let cum = 0;          // cumulative of THIS layer, from the top of book
    let bridged = false;
    for (const [p, q] of rows) {
      cum += q;
      if (!beyond(p)) continue;               // still inside the finer layer
      if (!bridged) {
        bridged = true;
        const residual = cum - cumFine;       // what this bucket adds past the edge
        if (residual > 0) { out.push([p, residual]); cumFine += residual; }
        continue;
      }
      out.push([p, q]);
      cumFine += q;
    }
    if (out.length) edge = out[out.length - 1][0];
  }
  return out;
}

const NOTE = 'Assembled from six parallel l2Book feeds (Hyperliquid serves 20 aggregated levels per subscription), reconciled on cumulative quantity — depth is exact at every price, resolution coarsens with distance from mid.';

export default {
  id: 'hyperliquid',
  name: 'Hyperliquid',
  markets: ['spot', 'perp'],
  transport: { spot: 'ws', perp: 'ws' },
  notes: { spot: NOTE, perp: NOTE },

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
    let closed = false;

    const publish = coalesce(() => {
      // Six sockets close with six handshakes, so frames already in flight keep
      // arriving after close(): a closed adapter must publish nothing.
      if (closed) return;
      if (!snaps[0]) return; // the finest layer owns mid/spread; wait for it
      const bids = stitch(snaps.map((x) => x?.bids), true);
      const asks = stitch(snaps.map((x) => x?.asks), false);
      if (!bids.length || !asks.length) return;
      // The stitched book is as recent as its freshest layer. `null` coerces to
      // 0 through Math.max, which would silently date the book to 1970 if the
      // venue ever stopped stamping its frames, so the layers are filtered.
      const stamps = snaps.filter(Boolean).map((x) => x.ts).filter(Number.isFinite);
      emit({ bids, asks, ts: stamps.length ? Math.max(...stamps) : null, source: 'ws' });
    }, PUBLISH_MS);

    // One socket per layer: the l2Book payload carries only `coin`, `time` and
    // `levels` — it does not echo nSigFigs — so several layers multiplexed on
    // one connection could not be told apart.
    // The one seam here: tests drive this adapter through a fake transport
    // instead of a socket. The hub only ever builds `opts` as { range }, so
    // nothing in production reaches it.
    const conns = LAYERS.map((sub, i) => (opts?.connect || reconnectingWs)(WS, {
      onOpen: (send) => send({ method: 'subscribe', subscription: { type: 'l2Book', coin: s, ...sub } }),
      onMessage: (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.channel === 'error') { status('error', `Hyperliquid: ${msg.data}`); return; }
        if (msg.channel !== 'l2Book' || !msg.data) return;
        const [b, a] = msg.data.levels;
        snaps[i] = {
          bids: b.map((l) => [+l.px, +l.sz]),
          asks: a.map((l) => [+l.px, +l.sz]),
          ts: msg.data.time ?? null,
        };
        publish();
      },
      onStatus: (st, d) => {
        // A layer that is no longer connected knows nothing about the book. Its
        // last snapshot used to stay in the stitch forever, so one coarse socket
        // dropping out left frozen depth being served as live — invisible,
        // because the finest layer kept the mid and the spread moving. Dropping
        // the layer instead shortens the reported reach until it resubscribes,
        // which is the honest answer: we cannot see out there right now.
        if (st !== 'open') { snaps[i] = null; publish(); }
        // Only the finest layer drives the visible connection state; a coarse
        // layer reconnecting must not make the app claim it is offline.
        if (i === 0) status(st, d);
      },
    }, { pingMs: 30_000, pingPayload: JSON.stringify({ method: 'ping' }) }));

    return { close() { closed = true; publish.cancel(); for (const c of conns) { try { c.close(); } catch {} } } };
  },
};
