import { fetchJson, ttlCache, reconnectingWs, BookSide } from '../util.js';

const REST = 'https://www.okx.com';
const WS = 'wss://ws.okx.com:8443/ws/v5/public';
const instType = (m) => (m === 'perp' ? 'SWAP' : 'SPOT');

const instruments = ttlCache(async (market) => {
  const j = await fetchJson(`${REST}/api/v5/public/instruments?instType=${instType(market)}`);
  if (j.code !== '0') throw new Error(`OKX instruments: ${j.msg}`);
  return j.data.filter((i) => i.state === 'live');
}, 5 * 60_000);

/**
 * SWAP books are denominated in contracts.
 *  - linear  (BTC-USDT-SWAP): ctVal is in the BASE coin -> base = contracts * ctVal * ctMult
 *  - inverse (BTC-USD-SWAP):  ctVal is in USD           -> base = contracts * ctVal * ctMult / price
 * Verified against each ticker's own volCcy24h/vol24h ratio in
 * tools/verify-conversions.mjs.
 */
const contractSpec = ttlCache(async (market) => {
  if (market !== 'perp') return new Map();
  const m = new Map();
  for (const i of await instruments(market)) {
    m.set(i.instId, {
      mult: (+i.ctVal || 1) * (+i.ctMult || 1),
      inverse: i.ctType === 'inverse',
    });
  }
  return m;
}, 5 * 60_000);

const tickers = ttlCache(async (market) => {
  const j = await fetchJson(`${REST}/api/v5/market/tickers?instType=${instType(market)}`);
  const map = new Map();
  for (const t of j.data || []) {
    // spot: volCcy24h is already quote-denominated. swap: it is base-denominated.
    const v = market === 'perp' ? +t.volCcy24h * +t.last : +t.volCcy24h;
    map.set(t.instId, isFinite(v) ? v : null);
  }
  return map;
}, 30_000);

export default {
  id: 'okx',
  name: 'OKX',
  markets: ['spot', 'perp'],
  transport: { spot: 'ws', perp: 'ws' },

  async listSymbols(market) {
    const rows = await instruments(market);
    return rows.map((i) => {
      const [base, quote] = i.instId.split('-');
      return { s: i.instId, d: `${base}/${quote}`, base, quote };
    }).sort((a, b) => a.d.localeCompare(b.d));
  },

  async vol24h(market, s) {
    return (await tickers(market)).get(s) ?? null;
  },

  async open(market, s, opts, emit, status) {
    const spec = market === 'perp' ? ((await contractSpec(market)).get(s) || { mult: 1, inverse: false }) : { mult: 1, inverse: false };
    const bids = new BookSide(true);
    const asks = new BookSide(false);
    let seq = null;

    const toBase = spec.inverse
      ? (px, sz) => (sz * spec.mult) / px   // contracts are USD-denominated
      : (px, sz) => sz * spec.mult;
    const apply = (side, rows) => { for (const r of rows) side.set(r[0], toBase(+r[0], +r[1])); };

    const conn = reconnectingWs(WS, {
      onOpen: (send) => {
        seq = null; bids.clear(); asks.clear();
        send({ op: 'subscribe', args: [{ channel: 'books', instId: s }] });
      },
      onMessage: (raw) => {
        const txt = raw.toString();
        if (txt === 'pong') return;
        const msg = JSON.parse(txt);
        if (msg.event === 'error') { status('error', `OKX: ${msg.msg}`); return; }
        if (msg.event || !msg.data) return;
        for (const d of msg.data) {
          if (msg.action === 'snapshot') {
            bids.clear(); asks.clear();
          } else if (seq !== null && d.prevSeqId !== undefined && +d.prevSeqId !== seq) {
            // sequence gap -> force a fresh snapshot
            status('reconnecting', 'OKX book sequence gap, resyncing');
            conn.send({ op: 'unsubscribe', args: [{ channel: 'books', instId: s }] });
            conn.send({ op: 'subscribe', args: [{ channel: 'books', instId: s }] });
            seq = null;
            return;
          }
          apply(bids, d.bids || []);
          apply(asks, d.asks || []);
          seq = +d.seqId;
          emit({ bids: bids.toArray(), asks: asks.toArray(), ts: +d.ts, source: 'ws' });
        }
      },
      onStatus: status,
    }, { pingMs: 20_000, pingPayload: 'ping' });

    return conn;
  },
};
