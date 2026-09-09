import { fetchJson, ttlCache, reconnectingWs, BookSide, coalesce, PUBLISH_MS } from '../util.js';

const REST = 'https://www.okx.com';
const WS = 'wss://ws.okx.com:8443/ws/v5/public';
const instType = (m) => (m === 'perp' ? 'SWAP' : 'SPOT');

// Set from the measured distribution, not from a guess. Sampled once a second
// for ~3 minutes on BTC-USDT spot, BTC-USDT-SWAP and ETH-USDT-SWAP (n=169 each):
//
//     median  0.000%    p95 <= 0.093%    p99 0.84-6.24%    max 6.24%
//
// So the healthy state is exact agreement, with rare single spikes when the two
// reads land either side of a busy tick. The old 15% was a number nobody had
// measured, and combined with the run requirement below it could not fire on
// anything short of a catastrophe. 3% is thirty times the p95 and still five
// times tighter, and three CONSECUTIVE readings past it is a state no spike in
// that sample ever produced.
// Exported so tools/measure-drift.mjs judges the number that is actually in
// force rather than a copy of it that can rot: a threshold quoted in one file
// and used in another is a threshold nobody is checking.
export const DRIFT_TOLERANCE = 0.03;   // cumulative-size disagreement over the overlap
export const DRIFT_BREACHES = 3;       // consecutive breaches before forcing a resync
// What the sample above has to keep being true for the tolerance to stand: 3%
// was chosen as ~32x the measured p95. Anything under 20x means the venue has
// moved and the number needs re-deriving, not widening.
export const DRIFT_P95_FACTOR = 20;

/**
 * A SWAP instrument's contract spec, and the function that applies it.
 *
 * Exported because this is the single most dangerous arithmetic in the repo: a
 * forgotten multiplier is a 100x error on BTC-USDT-SWAP and ~780x on the inverse
 * BTC-USD-SWAP, and the chart stays beautiful either way. It is pinned by
 * tools/test-adapters.mjs against the venue's own published ctVal/ctMult/ctType.
 */
export const specOf = (i) => ({
  mult: (+i.ctVal || 1) * (+i.ctMult || 1),
  inverse: i.ctType === 'inverse',
});

export const contractsToBase = (spec) => (spec.inverse
  // ctVal is quoted in USD on an inverse contract, so the base amount a
  // contract represents depends on the price of the level it sits at.
  ? (px, sz) => (sz * spec.mult) / px
  : (px, sz) => sz * spec.mult);

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
    m.set(i.instId, specOf(i));
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

    const toBase = contractsToBase(spec);
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
    let driftTs = null;      // and when that measurement was actually taken
    let breaches = 0;
    // Held so close() can clear it. A flag alone stops the NEXT poll but leaves
    // the pending one holding the event loop, which is a second of shutdown per
    // feed for a response that will be thrown away.
    let pollTimer = null;

    const tailOf = (rows, ascending) => {
      const out = [];
      for (const r of rows) out.push([+r[0], toBase(+r[0], +r[1])]);
      out.sort((x, y) => (ascending ? x[0] - y[0] : y[0] - x[0]));
      return out;
    };

    // Cumulative size from the top of book out to `edge`, on either side.
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

    // Splice the polled tail onto the live ws book, keeping each side sorted
    // outward from mid and dropping any tail level the ws already covers.
    const merge = (wsRows, tail, deeper) => {
      if (!wsRows.length || !tail.length) return wsRows.length ? wsRows : tail;
      const edge = wsRows[wsRows.length - 1][0];
      const out = wsRows.slice();
      for (const lv of tail) if (deeper(lv[0], edge)) out.push(lv);
      return out;
    };

    // Every update is applied immediately; the merge with the polled tail and
    // the two sorts it needs run only on the frames that are shipped.
    const publish = coalesce((ts) => stopped || emit({
      bids: merge(bids.toArray(), tailBids, (p, e) => p < e),
      asks: merge(asks.toArray(), tailAsks, (p, e) => p > e),
      ts, source: 'ws', drift, driftTs,
    }), PUBLISH_MS);

  // The one seam here: tests drive this adapter through a fake transport
  // instead of a socket, so the decoding and the sequencing are deterministic
  // and need no network. The hub only ever builds `opts` as { range }, so
  // nothing in production reaches it. Nothing else may be injected.
    const conn = (opts?.connect || reconnectingWs)(WS, {
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
            resubscribe('OKX book sequence gap, resyncing');
            return;
          }
          apply(bids, d.bids || []);
          apply(asks, d.asks || []);
          seq = +d.seqId;
          publish(Number.isFinite(+d.ts) ? +d.ts : null);
        }
      },
      onStatus: status,
    }, { pingMs: 20_000, pingPayload: 'ping' });

    /**
     * Drop the channel and take it again: the only way this venue offers to get
     * a fresh snapshot. Both callers below want exactly this, and it used to be
     * written out twice.
     *
     * A `function` declaration on purpose, and it is the reason both of these
     * live BELOW `conn` now. They reach for it, and as `const` arrows above it
     * they sat in its temporal dead zone — safe only because the first `await`
     * in pollFull landed after the rest of open() had run. That is a bug
     * waiting for someone to add an early return, and it is the same shape as
     * the one that silently killed a whole page's scripts in dashboard-mm.
     * Hoisted declarations here cannot be reached before `conn` exists, because
     * nothing calls them until a socket that does not yet exist says something.
     */
    function resubscribe(why) {
      status('reconnecting', why);
      conn.send({ op: 'unsubscribe', args: [{ channel: 'books', instId: s }] });
      conn.send({ op: 'subscribe', args: [{ channel: 'books', instId: s }] });
      // Deliberately on BOTH paths, which the two copies this replaces were not
      // agreed on: the sequence-gap one cleared `seq`, the drift one did not.
      // Frames from the old subscription keep arriving through the unsubscribe
      // handshake, and with `seq` still set the first of them fails the
      // contiguity test and triggers a second resubscribe — the asymmetry was
      // an omission, not an intent. `seq` picks up again from the snapshot the
      // venue sends on resubscribing, and gap detection resumes with it.
      seq = null;
    }

    async function pollFull() {
      if (stopped) return;
      try {
        const j = await fetchJson(`${REST}/api/v5/market/books-full?instId=${encodeURIComponent(s)}&sz=5000`);
        const d = j.code === '0' ? j.data?.[0] : null;
        if (d) {
          tailBids = tailOf(d.bids || [], false);
          tailAsks = tailOf(d.asks || [], true);
          // The two transports overlap on the socket's own 400 levels and are
          // never otherwise compared. Cumulative size over that overlap is a
          // free check that the incremental book has not drifted from the
          // venue's own view — the failure a seq counter cannot catch.
          //
          // Only a real reading moves the pair: the catch below keeps the
          // previous value on purpose — the ws book is unaffected by a failed
          // REST read — and without a stamp beside it, a ten-minute-old
          // measurement was indistinguishable from one taken a second ago.
          const measured = measureDrift();
          if (measured !== null) { drift = measured; driftTs = Date.now(); }
          if (drift !== null && drift > DRIFT_TOLERANCE) {
            // One breach is the two reads landing either side of a busy tick;
            // a run of them is the socket book actually being wrong.
            if (++breaches >= DRIFT_BREACHES) {
              breaches = 0;
              resubscribe(`OKX ws/REST books disagree by ${(drift * 100).toFixed(1)}% over the overlap, resyncing`);
            }
          } else breaches = 0;
        }
      } catch { /* keep the previous tail; the ws book is unaffected */ }
      if (!stopped) pollTimer = setTimeout(pollFull, 1000);
    }

    pollFull();

    return { close() { stopped = true; clearTimeout(pollTimer); publish.cancel(); conn.close(); } };
  },
};
