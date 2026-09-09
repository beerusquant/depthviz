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

/**
 * How far from mid this side actually extends, in percent.
 *
 * O(1) and exact, because a side is sorted outward from mid: the answer is the
 * last level, and nothing before it can be further away. It used to be read off
 * the walk below, which stops at `max(range, 5)` for cost — so a book reaching
 * ±12% reported a reach of exactly 5.000 at any range under 5, and a field
 * documented as "how far the book extends" was silently the loop's own bound.
 */
function reachOf(rows, mid) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][1] > 0) return Math.abs(rows[i][0] / mid - 1) * 100;
  }
  return 0;
}

function walk(rows, mid, range) {
  const pts = [[0, 0]];
  const bins = new Float64Array(NBINS);
  let cum = 0, sumQ = 0, sumPQ = 0, d2 = 0, d5 = 0, inRange = 0;

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
    // Everything past this point is already counted in `reach` and contributes
    // to none of the figures above, so walking it would be pure cost.
    if (a > Math.max(range, 5)) break;
  }
  return {
    pts,
    bins,
    depth: inRange,
    d2, d5,
    vwap: sumQ > 0 ? sumPQ / sumQ : null,
    reach: reachOf(rows, mid),
  };
}

/**
 * Cumulative notional on one side between two ABSOLUTE prices.
 *
 * Aggregating venues is where this is needed and where its absence would be
 * invisible. Every venue has its own mid, so "±2% of mid" is a different band
 * of prices on each of them — summing those gives a total that is not the depth
 * inside any single price range, and it looks exactly like a correct number.
 * Measured against one reference band instead, the sum means something.
 *
 * `rows` is sorted outward from that venue's own mid, so both ends are handled:
 * levels beyond the far edge end the walk, and levels on the near side of the
 * band — a venue whose touch sits outside the reference band entirely — are
 * skipped rather than counted.
 */
export function notionalWithin(rows, isBid, lo, hi) {
  let sum = 0;
  for (const [p, q] of rows) {
    if (!(q > 0)) continue;
    if (isBid) {
      if (p > hi + EDGE) continue;      // above the band; the walk moves down into it
      if (p < lo - EDGE) break;         // past the far edge
    } else {
      if (p < lo - EDGE) continue;      // below the band; the walk moves up into it
      if (p > hi + EDGE) break;
    }
    sum += p * q;
  }
  return sum;
}

export function computeMetrics(book, range) {
  const { bids, asks } = book;
  if (!bids?.length || !asks?.length) return null;
  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];
  const mid = (bestBid + bestAsk) / 2;
  if (!(mid > 0)) return null;
  // A crossed book is not a book. It is what a mis-sequenced diff stream looks
  // like from the outside, and every figure below would still compute: a mid
  // inside a negative spread, a spread quoted as -2%, and two depth curves that
  // overlap. The hub refuses one before it is ever published, and this is the
  // same refusal stated where the arithmetic lives, so no caller of this
  // function can be handed numbers derived from one.
  if (!(bestBid < bestAsk)) return null;

  // The size-weighted touch price, and how far it sits from the arithmetic mid.
  //
  // A resting book is not symmetric around (bid+ask)/2: when the bid carries ten
  // times the ask's size, the next trade is far likelier to lift the ask, and
  // the microprice — each side weighted by the OPPOSITE side's quantity — is
  // where the touch actually is. It is the number a market maker skews around,
  // and this tool never showed it.
  //
  // The depth bands below are still anchored on `mid`, deliberately. Anchoring
  // them on the microprice would make every depth figure here incomparable with
  // ccxt, with every other venue's own reporting, and with this repo's own
  // recorded measurements — a definition change dressed as an improvement. What
  // the reader needs instead is how much that choice costs them on this book,
  // which is exactly `micropricePct`: at 0.0001% it changes nothing, at 0.05%
  // the ±2% band is shifted by a fortieth of its width and they should know.
  const bidSize = bids[0][1];
  const askSize = asks[0][1];
  const touchSize = bidSize + askSize;
  const microprice = touchSize > 0 ? (bestBid * askSize + bestAsk * bidSize) / touchSize : null;

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

  // Which of the depth figures below are FLOORS rather than measurements.
  //
  // A cumulative depth is only a fact if the book reaches the distance it is
  // quoted at. It does not always: Bitunix caps its spot book at 50 levels,
  // about ±0.05% of mid, and `-2% Depth` and `-5% Depth` there were the same
  // number as `Total Depth` — the whole book, printed three times as three
  // different measurements. Nothing said so, because `shortBid`/`shortAsk` are
  // judged against the SELECTED range and these two thresholds are fixed.
  //
  // The value is kept rather than nulled — a book reaching 1.9% is a useful
  // floor for its ±2% depth — and it is the caller's job to render it as one.
  // This is only about the book ending early; depth that is a lower bound
  // because it was accumulated from a capped snapshot is a different fact,
  // carried by `accum` alongside the book.
  // `EDGE` for the same reason it exists above: a book whose deepest level sits
  // exactly at -5% has a reach of 5.000000000000004 in binary floating point,
  // and would be accused of not reaching the figure it exactly defines.
  const short = (reach, at) => reach + EDGE < at;
  const lowerBound = {
    depthMinus2: short(b.reach, 2), depthPlus2: short(a.reach, 2),
    depthMinus5: short(b.reach, 5), depthPlus5: short(a.reach, 5),
    bidDepth: shortBid, askDepth: shortAsk,
    totalDepth: shortBid || shortAsk,
  };

  return {
    // Every band-scoped figure below is scoped to THIS range, so it travels
    // with them: a depth without its band is not a depth.
    range,
    mid,
    bestBid,
    bestAsk,
    spread: bestAsk - bestBid,
    spreadPct: ((bestAsk - bestBid) / mid) * 100,
    // The touch, in the two forms that answer different questions: how much is
    // resting there, and where the weight of it sits.
    bidSize,
    askSize,
    microprice,
    micropricePct: microprice == null ? null : (microprice / mid - 1) * 100,
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
    lowerBound,
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
 * 24h volume, and whether anyone still believes it.
 *
 * It is refreshed every 30 s behind a 45 s cache, and the refresh swallows its
 * own failures on purpose — a venue's ticker endpoint having a bad minute must
 * not kill a feed whose book is perfectly healthy. The cost of that was a
 * figure that could sit unchanged for hours next to fifteen rows carrying their
 * own instant, with nothing to distinguish it from one read a second ago. Ten
 * consecutive failed refreshes is five minutes, so past that it says so.
 */
export const VOL_STALE_MS = 5 * 60_000;

export function fmtVol(v, ts, now = Date.now()) {
  const s = fmtUsd(v);
  if (v == null || ts == null) return s;
  return now - ts > VOL_STALE_MS ? `${s} \u00b7 stale` : s;
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
  // A figure the book does not reach far enough to support is printed as the
  // floor it is. One character, in front of the number, wherever it applies.
  const d = (key) => (m.lowerBound?.[key] ? `≥ ${fmtUsd(m[key])}` : fmtUsd(m[key]));
  return [
    ['Exchange', `${meta.exchangeName} [${meta.market.toUpperCase()}]`, 'fg', 'exchange'],
    ['Symbol', meta.display, 'fg', 'symbol'],
    ['Mid Price', fmtPrice(m.mid), 'fg', 'mid'],
    ['Spread', fmtBps(m.spreadPct), 'fg', 'spread'],
    // Shown as an offset from mid, not as a price: the price is `mid` one row
    // up to four decimals, and what carries information is the skew.
    ['Microprice', m.microprice == null ? 'n/a'
      : `${fmtPrice(m.microprice)} (${fmtBps(m.micropricePct)} vs mid)`, 'fg', 'microprice'],
    ['24H Volume', fmtVol(meta.vol24h, meta.volTs, meta.now), 'fg', 'vol'],
    [`Bid VWAP (±${r}%)`, `${fmtPrice(m.bidVwap)} (${fmtPct(m.bidVwapPct)})`, 'cyan', 'bidVwap'],
    [`Ask VWAP (±${r}%)`, `${fmtPrice(m.askVwap)} (${fmtPct(m.askVwapPct)})`, 'orange', 'askVwap'],
    [`Bid Depth (±${r}%)`, d('bidDepth'), 'bid', 'bidDepth'],
    [`Ask Depth (±${r}%)`, d('askDepth'), 'ask', 'askDepth'],
    // The fixed thresholds are dropped when the selected range IS that
    // threshold: at ±2% those two rows repeat `Bid Depth`/`Ask Depth` digit for
    // digit, and four rows carrying two numbers is noise on the default view.
    ...(r === 2 ? [] : [
      ['-2% Depth', d('depthMinus2'), 'fg', 'depthMinus2'],
      ['+2% Depth', d('depthPlus2'), 'fg', 'depthPlus2'],
    ]),
    ...(r === 5 ? [] : [
      ['-5% Depth', d('depthMinus5'), 'fg', 'depthMinus5'],
      ['+5% Depth', d('depthPlus5'), 'fg', 'depthPlus5'],
    ]),
    [`Total Depth (±${r}%)`, d('totalDepth'), 'fg', 'totalDepth'],
    [`Imbalance (±${r}%)`, `${m.imbalance.toFixed(3)} ${m.imbalanceLabel}`,
      m.imbalance > IMBALANCE_THRESHOLD ? 'bid' : m.imbalance < -IMBALANCE_THRESHOLD ? 'ask' : 'fg', 'imbalance'],
    ['Book Age', fmtAge(meta), 'fg', 'age'],
  ];
}
