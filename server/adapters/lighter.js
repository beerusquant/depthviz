import { fetchJson, ttlCache, reconnectingWs, BookSide, coalesce, PUBLISH_MS } from '../util.js';

const REST = 'https://mainnet.zklighter.elliot.ai/api/v1';
const WS = 'wss://mainnet.zklighter.elliot.ai/stream';

/**
 * Lighter (zkLighter) — perp DEX on its own zk rollup. Two things make it
 * unlike the CEX adapters here:
 *
 *  - Markets are addressed by a numeric `market_id`, not by a symbol string.
 *    The UI keeps using the symbol; the id is resolved from the venue's own
 *    market list at subscribe time.
 *  - The websocket opens with the WHOLE book (~1800 bids / ~1100 asks on BTC,
 *    reaching -74% / +211% of mid), then streams absolute-size diffs. There is
 *    no capped REST snapshot to accumulate past, so — unlike Binance, Aster or
 *    MEXC — its far depth is a settled figure, not a lower bound.
 *
 * Sizes are in base units: `multiplier` is 1.0 on every market (checked across
 * all 242), and ccxt reports contractSize 1 for the same instruments.
 */
const details = ttlCache(async () => {
  const j = await fetchJson(`${REST}/orderBookDetails`);
  return (j.order_book_details || []).filter((x) => x.status === 'active' && x.market_type === 'perp');
}, 5 * 60_000);

const bySymbol = async () => new Map((await details()).map((x) => [x.symbol, x]));

export default {
  id: 'lighter',
  name: 'Lighter',
  markets: ['perp'],
  transport: { perp: 'ws' },
  notes: {
    perp: 'Lighter streams its entire book as one websocket snapshot (~2900 levels, reaching well past ±50% of mid) and then absolute-size diffs chained by nonce, so its far depth is complete rather than accumulated.',
  },

  async listSymbols() {
    return (await details()).map((x) => ({
      s: x.symbol, d: `${x.symbol}/USD`, base: x.symbol, quote: 'USD',
    })).sort((a, b) => a.d.localeCompare(b.d));
  },

  async vol24h(market, s) {
    const v = +(await bySymbol()).get(s)?.daily_quote_token_volume;
    return isFinite(v) && v > 0 ? v : null;
  },

  async open(market, s, opts, emit, status) {
    const mkt = (await bySymbol()).get(s);
    if (!mkt) throw new Error(`Lighter has no active perp market ${s}`);
    const chan = `order_book/${mkt.market_id}`;

    const bids = new BookSide(true);
    const asks = new BookSide(false);
    let nonce = null;          // null => waiting for a snapshot
    let resubTimer = null;
    let closed = false;

    const load = (ob) => {
      const now = Date.now();
      for (const r of ob.bids || []) bids.set(r.price, r.size, now);
      for (const r of ob.asks || []) asks.set(r.price, r.size, now);
    };
    const publish = coalesce((ts) => {
      const b = bids.toArray(), a = asks.toArray();
      if (b.length && a.length) emit({ bids: b, asks: a, ts, source: 'ws' });
    }, PUBLISH_MS);

    // A nonce gap means levels changed unseen; the only cure the venue offers
    // is a fresh snapshot, and it refuses a second subscribe on a live channel
    // ("Already Subscribed", code 30003), so the channel is dropped first.
    const resubscribe = (send, why) => {
      if (closed || resubTimer) return;
      nonce = null;
      status('reconnecting', `Lighter ${why}, resyncing`);
      send({ type: 'unsubscribe', channel: chan });
      resubTimer = setTimeout(() => { resubTimer = null; if (!closed) send({ type: 'subscribe', channel: chan }); }, 500);
    };

    const conn = reconnectingWs(WS, {
      onOpen: (send) => {
        nonce = null;
        bids.clear(); asks.clear();
        send({ type: 'subscribe', channel: chan });
      },
      onMessage: (raw, send) => {
        const m = JSON.parse(raw.toString());
        if (m.error) { status('error', `Lighter: ${m.error.message || JSON.stringify(m.error)}`); return; }
        if (m.type === 'subscribed/order_book') {
          // The snapshot is the whole book, so it replaces it outright — there
          // is no out-of-span tail to preserve here.
          bids.clear(); asks.clear();
          load(m.order_book);
          nonce = String(m.order_book.nonce);
          status('open');
          publish(null); // the snapshot frame carries no venue time
          return;
        }
        if (m.type !== 'update/order_book' || !m.order_book) return;
        if (nonce === null) return; // waiting on the snapshot that follows a resub
        if (String(m.order_book.begin_nonce) !== nonce) { resubscribe(send, 'nonce gap'); return; }
        load(m.order_book);
        nonce = String(m.order_book.nonce);
        // last_updated_at is microseconds since epoch.
        publish(m.last_updated_at ? Math.round(m.last_updated_at / 1000) : null);
      },
      onStatus: (st, detail) => { if (st !== 'open') status(st, detail); },
    }, { pingMs: 20_000, pingPayload: JSON.stringify({ type: 'ping' }) });

    return { close() { closed = true; publish.cancel(); clearTimeout(resubTimer); conn.close(); } };
  },
};
