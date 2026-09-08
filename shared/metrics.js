// Pure computation: order book -> everything the panel and the chart need.

/**
 * Above this, one side of the book is called heavy.
 *
 * The quantity below used to be published as "OFI". Order-flow imbalance, as
 * the term is used in market making (Cont-Kukanov-Stoikov), is built from
 * CHANGES in the book between two instants — arrivals, cancellations and trades
 * at the touch. What this computes is the resting depth on one side against the
 * other at a single instant, which is a book imbalance and says nothing about
 * flow. The number was right; the name promised a different quantity, and to
 * the audience most likely to act on it. It is called what it is.
 */
export const IMBALANCE_THRESHOLD = 0.15;
const NBINS = 60;
// A level sitting exactly on a boundary belongs inside it. Without this, mid
// 100 and a level at 95 gives |95/100 - 1| * 100 = 5.000000000000004, and the
// "-5% depth" figure silently drops the very level that defines it — round
// numbers are exactly where real books put their size.
const EDGE = 1e-9;

function walk(rows, mid, range) {
  const pts = [[0, 0]];
  const bins = new Float64Array(NBINS);
  let cum = 0, sumQ = 0, sumPQ = 0, d2 = 0, d5 = 0, far = 0, inRange = 0;

  for (const [p, q] of rows) {
    const pct = (p / mid - 1) * 100;
    const a = Math.abs(pct);
    const n = p * q;
    cum += n;
    if (a <= 2 + EDGE) d2 = cum;
    if (a <= 5 + EDGE) d5 = cum;
    if (a <= range + EDGE) {
      pts.push([pct, cum]);
      sumQ += q;
      sumPQ += n;
      bins[Math.min(NBINS - 1, Math.floor((a / range) * NBINS))] += n;
      inRange = cum;
    }
    far = a;
    if (a > Math.max(range, 5)) break;
  }
  return {
    pts,
    bins,
    depth: inRange,
    d2, d5,
    vwap: sumQ > 0 ? sumPQ / sumQ : null,
    reach: far, // how far from mid the book actually extends
  };
}

export function computeMetrics(book, range) {
  const { bids, asks } = book;
  if (!bids?.length || !asks?.length) return null;
  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];
  const mid = (bestBid + bestAsk) / 2;
  if (!(mid > 0)) return null;

  const b = walk(bids, mid, range);
  const a = walk(asks, mid, range);
  // true when the exchange's book stops before the requested range
  const shortBid = b.reach < range * 0.98;
  const shortAsk = a.reach < range * 0.98;

  // Where the book DOES reach past the range, cumulative depth at the edge is
  // known — it is the last level's, because there is nothing in between — so
  // the curve is carried out to the edge. Without this the chart stopped at the
  // last level below the edge and drew a book that looked truncated when it was
  // not: on Binance BTC the deepest ask inside ±2% sits at +1.85%, and the curve
  // ended there under a note that (correctly) never fired. Where the book is
  // genuinely short, nothing is drawn past the data and the note says so.
  const carry = (w, edge) => {
    if (w.pts.length > 1 && Math.abs(w.pts.at(-1)[0]) < Math.abs(edge)) w.pts.push([edge, w.depth]);
  };
  if (!shortBid) carry(b, -range);
  if (!shortAsk) carry(a, range);

  const total = b.depth + a.depth;
  const imbalance = total > 0 ? (b.depth - a.depth) / total : 0;

  return {
    // Every band-scoped figure below is scoped to THIS range, so it travels
    // with them: a depth without its band is not a depth.
    range,
    mid,
    bestBid,
    bestAsk,
    spread: bestAsk - bestBid,
    spreadPct: ((bestAsk - bestBid) / mid) * 100,
    bid: b,
    ask: a,
    bidDepth: b.depth,
    askDepth: a.depth,
    totalDepth: total,
    bidVwap: b.vwap,
    bidVwapPct: b.vwap ? (b.vwap / mid - 1) * 100 : null,
    askVwap: a.vwap,
    askVwapPct: a.vwap ? (a.vwap / mid - 1) * 100 : null,
    depthMinus2: b.d2, depthPlus2: a.d2,
    depthMinus5: b.d5, depthPlus5: a.d5,
    imbalance,
    imbalanceLabel: imbalance > IMBALANCE_THRESHOLD ? 'BID-heavy'
      : imbalance < -IMBALANCE_THRESHOLD ? 'ASK-heavy' : 'NEUTRAL',
    shortBid,
    shortAsk,
    nbins: NBINS,
  };
}

export function fmtUsd(v) {
  if (v == null || !isFinite(v)) return 'n/a';
  const s = v < 0 ? '-' : '';
  const x = Math.abs(v);
  if (x >= 1e9) return `${s}$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `${s}$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `${s}$${(x / 1e3).toFixed(2)}K`;
  return `${s}$${x.toFixed(2)}`;
}

export function fmtPrice(p) {
  if (p == null || !isFinite(p)) return 'n/a';
  const x = Math.abs(p);
  const d = x >= 1000 ? 2 : x >= 1 ? 4 : x >= 0.01 ? 5 : x >= 0.0001 ? 7 : 9;
  return `$${p.toFixed(d)}`;
}

export function fmtPct(v, d = 3) {
  return v == null || !isFinite(v) ? 'n/a' : `${v.toFixed(d)}%`;
}

/**
 * The spread, in the unit the people reading it quote in.
 *
 * As a percentage it was unreadable at exactly the instrument where it matters
 * most: BTC/USDT at a one-cent touch is 0.0000127%, and the panel printed
 * `0.0000%` — the single most important number on screen rendered as zero. Basis
 * points are how a spread is quoted, are scale-free across a $78 000 instrument
 * and a $0.0004 one, and put the interesting digits in front. The precision
 * follows the magnitude so a tight book keeps its resolution and a wide one does
 * not print noise.
 */
export function fmtBps(pct) {
  if (pct == null || !isFinite(pct)) return 'n/a';
  const b = pct * 100;
  const a = Math.abs(b);
  if (a === 0) return '0 bps';
  // Below 1 bp the interesting digits are all after the leading zeros — a
  // one-tick BTC spot spread is 0.0013 bps — so significant figures, not
  // decimal places.
  return `${a < 1 ? Number(b.toPrecision(2)) : b.toFixed(a < 10 ? 2 : a < 100 ? 1 : 0)} bps`;
}

/**
 * How old the book on screen is, and how long it took to get here.
 *
 * Two separate facts, and the second one is often missing: several feeds carry
 * no exchange timestamp at all (a REST poll, Binance spot's snapshot), and the
 * honest answer there is to say so rather than print a latency of zero. The
 * venue delta is shown raw, negative included — a negative one is clock skew
 * between us and the exchange, which is worth seeing, not hiding.
 */
export function fmtAge({ tsRecv, tsVenue, now = Date.now() }) {
  if (!tsRecv) return 'n/a';
  const age = Math.max(0, now - tsRecv);
  const s = age < 1000 ? `${age}ms` : `${(age / 1000).toFixed(1)}s`;
  return tsVenue != null ? `${s} \u00b7 venue\u2192us ${tsRecv - tsVenue}ms` : `${s} \u00b7 no venue clock`;
}

/**
 * Panel rows, in the order they are rendered and copied.
 *
 * Each row is `[label, value, colour, key]`. The key is what callers filter on
 * (the phone panel keeps a subset), so labels stay free to carry the band a
 * figure was measured over — five of these numbers mean nothing without it, and
 * this repo's first rule is that a depth is stated with its venue, its band and
 * its instant. The venue is the first row, the instant is the last.
 */
export function panelRows(m, meta) {
  const r = +m.range.toFixed(3);
  return [
    ['Exchange', `${meta.exchangeName} [${meta.market.toUpperCase()}]`, 'fg', 'exchange'],
    ['Symbol', meta.display, 'fg', 'symbol'],
    ['Mid Price', fmtPrice(m.mid), 'fg', 'mid'],
    ['Spread', fmtBps(m.spreadPct), 'fg', 'spread'],
    ['24H Volume', fmtUsd(meta.vol24h), 'fg', 'vol'],
    [`Bid VWAP (±${r}%)`, `${fmtPrice(m.bidVwap)} (${fmtPct(m.bidVwapPct)})`, 'cyan', 'bidVwap'],
    [`Ask VWAP (±${r}%)`, `${fmtPrice(m.askVwap)} (${fmtPct(m.askVwapPct)})`, 'orange', 'askVwap'],
    [`Bid Depth (±${r}%)`, fmtUsd(m.bidDepth), 'bid', 'bidDepth'],
    [`Ask Depth (±${r}%)`, fmtUsd(m.askDepth), 'ask', 'askDepth'],
    // The fixed thresholds are dropped when the selected range IS that
    // threshold: at ±2% those two rows repeat `Bid Depth`/`Ask Depth` digit for
    // digit, and four rows carrying two numbers is noise on the default view.
    ...(r === 2 ? [] : [
      ['-2% Depth', fmtUsd(m.depthMinus2), 'fg', 'depthMinus2'],
      ['+2% Depth', fmtUsd(m.depthPlus2), 'fg', 'depthPlus2'],
    ]),
    ...(r === 5 ? [] : [
      ['-5% Depth', fmtUsd(m.depthMinus5), 'fg', 'depthMinus5'],
      ['+5% Depth', fmtUsd(m.depthPlus5), 'fg', 'depthPlus5'],
    ]),
    [`Total Depth (±${r}%)`, fmtUsd(m.totalDepth), 'fg', 'totalDepth'],
    [`Imbalance (±${r}%)`, `${m.imbalance.toFixed(3)} ${m.imbalanceLabel}`,
      m.imbalance > IMBALANCE_THRESHOLD ? 'bid' : m.imbalance < -IMBALANCE_THRESHOLD ? 'ask' : 'fg', 'imbalance'],
    ['Book Age', fmtAge(meta), 'fg', 'age'],
  ];
}
