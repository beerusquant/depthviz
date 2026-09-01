import { fetchJson, ttlCache, reconnectingWs, BookSide } from '../util.js';

const REST = 'https://www.okx.com';
const WS = 'wss://ws.okx.com:8443/ws/v5/public';
const instType = (m) => (m === 'perp' ? 'SWAP' : 'SPOT');

const DRIFT_TOLERANCE = 0.15;   // cumulative-size disagreement over the overlap
const DRIFT_BREACHES = 3;       // consecutive breaches before forcing a resync

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

    // The `books` channel is capped at 400 levels — on BTC that is only ~+-0.3%
    // of mid, far short of the +-10% the chart offers. REST `books-full` returns
    // 5000 levels (~+-1.3% on BTC) but is not streamed. So: the websocket stays
    // authoritative for everything inside its own 400-level span (tick-accurate
    // near mid, where it matters), and a 1s poll supplies only the tail beyond
    // that span. No level is ever served by both, so the merge cannot double-count.
    let tailBids = [];
    let tailAsks = [];
    let stopped = false;
    let drift = null;        // last measured ws-vs-rest disagreement over the overlap
    let breaches = 0;

    const tailOf = (rows, ascending) => {
      const out = [];
      for (const r of rows) out.push([+r[0], toBase(+r[0], +r[1])]);
      out.sort((x, y) => (ascending ? x[0] - y[0] : y[0] - x[0]));
      return out;
    };

    const pollFull = async () => {
      if (stopped) return;
      try {
        const j = await fetchJson(`${REST}/api/v5/market/books-full?instId=${s}&sz=5000`);
        const d = j.code === '0' ? j.data?.[0] : null;
        if (d) {
          tailBids = tailOf(d.bids || [], false);
          tailAsks = tailOf(d.asks || [], true);
          // The two transports overlap on the socket's own 400 levels and are
          // never otherwise compared. Cumulative size over that overlap is a
          // free check that the incremental book has not drifted from the
          // venue's own view — the failure a seq counter cannot catch.
          drift = measureDrift();
          if (drift !== null && drift > DRIFT_TOLERANCE) {
            // One breach is the two reads landing either side of a busy tick;
            // a run of them is the socket book actually being wrong.
            if (++breaches >= DRIFT_BREACHES) {
              breaches = 0;
              status('reconnecting', `OKX ws/REST books disagree by ${(drift * 100).toFixed(1)}% over the overlap, resyncing`);
              conn.send({ op: 'unsubscribe', args: [{ channel: 'books', instId: s }] });
              conn.send({ op: 'subscribe', args: [{ channel: 'books', instId: s }] });
            }
          } else breaches = 0;
        }
      } catch { /* keep the previous tail; the ws book is unaffected */ }
      if (!stopped) setTimeout(pollFull, 1000);
    };
    pollFull();

    // Splice the polled tail onto the live ws book, keeping each side sorted
    // outward from mid and dropping any tail level the ws already covers.
    // Cumulative size on both sides of the socket's span, ws vs REST.
    const cumTo = (rows, edge, deeper) => {
      let q = 0;
      for (const [p, sz] of rows) { if (deeper(p, edge)) break; q += sz; }
      return q;
    };
    const measureDrift = () => {
      const wb = bids.toArray(), wa = asks.toArray();
      if (!wb.length || !wa.length || !tailBids.length || !tailAsks.length) return null;
      const ws = cumTo(wb, wb[wb.length - 1][0], (p, e) => p < e)
               + cumTo(wa, wa[wa.length - 1][0], (p, e) => p > e);
      const rest = cumTo(tailBids, wb[wb.length - 1][0], (p, e) => p < e)
                 + cumTo(tailAsks, wa[wa.length - 1][0], (p, e) => p > e);
      return rest > 0 ? Math.abs(ws - rest) / rest : null;
    };

    const merge = (wsRows, tail, deeper) => {
      if (!wsRows.length || !tail.length) return wsRows.length ? wsRows : tail;
      const edge = wsRows[wsRows.length - 1][0];
      const out = wsRows.slice();
      for (const lv of tail) if (deeper(lv[0], edge)) out.push(lv);
      return out;
    };

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
          emit({
            bids: merge(bids.toArray(), tailBids, (p, e) => p < e),
            asks: merge(asks.toArray(), tailAsks, (p, e) => p > e),
            ts: +d.ts,
            source: 'ws',
            drift,
          });
        }
      },
      onStatus: status,
    }, { pingMs: 20_000, pingPayload: 'ping' });

    return { close() { stopped = true; conn.close(); } };
  },
};
