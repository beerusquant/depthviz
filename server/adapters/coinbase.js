import { fetchJson, ttlCache, reconnectingWs, BookSide, coalesce, PUBLISH_MS } from '../util.js';

const REST = 'https://api.exchange.coinbase.com';
// Advanced Trade's `level2` channel, not Exchange's `level2_batch`.
//
// Both are public and both stream the whole book, but only this one numbers its
// frames. Exchange's feed carries no sequence at all: every other streaming
// venue here chains its updates (U/u/pu, seqId/prevSeqId, begin_nonce) so a
// dropped frame forces a resync, and on Coinbase a lost update simply left a
// wrong level standing with nothing to say so — the one venue where the book
// could be silently wrong forever. `sequence_num` closes that.
//
// It counts frames per CONNECTION, not per channel, so the subscription
// acknowledgement consumes one too and it has to be tracked on every message.
// Measured on 2026-09-08: BTC-USD opens with a 43 892-level snapshot, ETH-USDC
// with 20 700, side labels are `bid`/`offer`, and the host answers an RFC6455
// ping — so the idle watchdog can prove this socket alive.
const WS = 'wss://advanced-trade-ws.coinbase.com';

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
    let seq = null;          // null => waiting for the snapshot
    let resubTimer = null;
    let closed = false;

    const publish = coalesce((ts) => emit({
      bids: bids.toArray(), asks: asks.toArray(), ts, source: 'ws',
    }), PUBLISH_MS);

    const sub = (send, type) => send({ type, product_ids: [s], channel: 'level2' });
    // A gap means levels changed unseen, and the only cure the venue offers is a
    // fresh snapshot: drop the channel, then take it again.
    const resubscribe = (send) => {
      if (closed || resubTimer) return;
      seq = null;
      status('reconnecting', 'Coinbase l2 sequence gap, resyncing');
      sub(send, 'unsubscribe');
      resubTimer = setTimeout(() => {
        resubTimer = null;
        if (!closed) sub(send, 'subscribe');
      }, 500);
    };

    // The one seam here: tests drive this adapter through a fake transport
    // instead of a socket. The hub only ever builds `opts` as { range }, so
    // nothing in production reaches it.
    const conn = (opts?.connect || reconnectingWs)(WS, {
      onOpen: (send) => {
        seq = null; bids.clear(); asks.clear();
        sub(send, 'subscribe');
      },
      onMessage: (raw, send) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error') { status('error', `Coinbase: ${m.message}`); return; }
        const n = m.sequence_num;
        if (Number.isFinite(n)) {
          // Every frame is numbered, including the ones on other channels, so
          // the counter advances on control frames too.
          if (seq !== null && n !== seq + 1) { resubscribe(send); return; }
          if (seq !== null || m.channel !== 'l2_data') seq = n;
        }
        if (m.channel !== 'l2_data') return;
        // The venue stamps every frame, snapshot included.
        const ts = m.timestamp ? Date.parse(m.timestamp) : null;
        let touched = false;
        for (const ev of m.events || []) {
          if (ev.type === 'snapshot') { bids.clear(); asks.clear(); seq = n; }
          else if (seq === null) continue;   // update before any snapshot
          for (const u of ev.updates || []) {
            (u.side === 'bid' ? bids : asks).set(u.price_level, u.new_quantity);
          }
          touched = true;
        }
        if (touched && seq !== null) publish(Number.isFinite(ts) ? ts : null);
      },
      onStatus: (st, detail) => { if (st !== 'open') status(st, detail); },
    }, { pingMs: 20_000 });

    return { close() { closed = true; publish.cancel(); clearTimeout(resubTimer); conn.close(); } };
  },
};
