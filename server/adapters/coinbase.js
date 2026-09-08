import { fetchJson, ttlCache, reconnectingWs, BookSide, coalesce, PUBLISH_MS } from '../util.js';

const REST = 'https://api.exchange.coinbase.com';
const WS = 'wss://ws-feed.exchange.coinbase.com';

const products = ttlCache(async () => {
  const rows = await fetchJson(`${REST}/products`);
  return rows.filter((p) => p.status === 'online' && !p.trading_disabled);
}, 5 * 60_000);

const stats = ttlCache(async (id) => {
  const [s, t] = await Promise.all([
    fetchJson(`${REST}/products/${encodeURIComponent(id)}/stats`),
    fetchJson(`${REST}/products/${encodeURIComponent(id)}/ticker`),
  ]);
  const v = +s.volume * +t.price;
  return isFinite(v) ? v : null;
}, 45_000);

export default {
  id: 'coinbase',
  name: 'Coinbase',
  markets: ['spot'], // Coinbase Exchange lists no perpetuals for public market data
  transport: { spot: 'ws' },

  async listSymbols() {
    return (await products()).map((p) => ({
      s: p.id, d: `${p.base_currency}/${p.quote_currency}`,
      base: p.base_currency, quote: p.quote_currency,
    })).sort((a, b) => a.d.localeCompare(b.d));
  },

  async vol24h(market, s) {
    try { return await stats(s); } catch { return null; }
  },

  open(market, s, opts, emit, status) {
    const bids = new BookSide(true);
    const asks = new BookSide(false);
    let ready = false;

    const publish = coalesce((ts) => emit({ bids: bids.toArray(), asks: asks.toArray(), ts, source: 'ws' }), PUBLISH_MS);

    const conn = reconnectingWs(WS, {
      onOpen: (send) => {
        ready = false; bids.clear(); asks.clear();
        send({ type: 'subscribe', product_ids: [s], channels: ['level2_batch'] });
      },
      onMessage: (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error') { status('error', `Coinbase: ${m.message}`); return; }
        if (m.type === 'snapshot') {
          bids.clear(); asks.clear();
          for (const r of m.bids) bids.set(r[0], r[1]);
          for (const r of m.asks) asks.set(r[0], r[1]);
          ready = true;
          publish(null); // the snapshot frame carries no venue time
        } else if (m.type === 'l2update' && ready) {
          for (const [side, px, sz] of m.changes) (side === 'buy' ? bids : asks).set(px, sz);
          publish(m.time ? Date.parse(m.time) : null);
        }
      },
      onStatus: status,
    }, { pingMs: 20_000 });
    return { close() { publish.cancel(); conn.close(); } };
  },
};
