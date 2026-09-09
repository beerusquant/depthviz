import { notionalWithin } from '../shared/metrics.js';

/**
 * The liquidity across several venues at one instant — the question this tool
 * could not be asked.
 *
 * Every number here was already available one venue at a time, and adding them
 * up by hand is where it goes wrong, in four ways that all produce a plausible
 * total:
 *
 *  - **Each venue has its own mid**, so "±2% of mid" is a different band of
 *    prices on each. Summing those is not the depth inside any price range. One
 *    reference mid is derived and every venue is measured on the same ABSOLUTE
 *    band around it.
 *  - **The books are not simultaneous.** They arrive on independent feeds, so a
 *    sum is a mosaic of photographs taken at different moments. `asOf` reports
 *    the spread of those moments; a total whose legs are two seconds apart is
 *    not a total of anything that ever existed at once.
 *  - **A venue that fails must not simply be absent.** A sum with a leg missing
 *    looks exactly like a complete one, so failures are named in `missing` with
 *    the reason, and `complete` is false.
 *  - **A venue whose book stops inside the band contributes a floor**, and a
 *    total containing one is a floor. That propagates rather than being lost.
 *
 * Pure, and kept out of the route for the same reason `quota.js` is kept out of
 * the hub: joining feeds opens sockets, so a rule that lives with them can only
 * be tested against the live internet. `tools/test-aggregate.mjs` pins all of
 * this with no network.
 */

/** Middle value of a sorted-by-value copy. Robust to one venue being wrong. */
function median(xs) {
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  if (!n) return null;
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

/**
 * @param readings  one per venue that answered:
 *   { exchange, market, symbol, quote, bids, asks, mid, tsVenue, tsRecv,
 *     reach: { bid, ask } }
 * @param missing   one per venue that did not: { exchange, symbol?, reason }
 * @param range     percent either side of the reference mid
 * @param now       injected, so the ages in the result are testable
 */
export function aggregate(readings, missing, range, now = Date.now()) {
  const usable = readings.filter((r) => r && r.bids?.length && r.asks?.length && r.mid > 0);

  if (!usable.length) {
    return {
      range,
      complete: false,
      reference: null,
      asOf: null,
      total: null,
      venues: [],
      missing,
    };
  }

  // The median, not the mean: one venue quoting a stale or dislocated mid moves
  // a mean by half its error and a median not at all. With two venues it is
  // their midpoint, which is the only defensible answer for two.
  const refMid = median(usable.map((r) => r.mid));
  const lo = refMid * (1 - range / 100);
  const hi = refMid * (1 + range / 100);

  const venues = usable.map((r) => {
    const bidDepth = notionalWithin(r.bids, true, lo, refMid);
    const askDepth = notionalWithin(r.asks, false, refMid, hi);
    // A venue's book stopping inside the reference band makes its contribution
    // a floor — and one floor in the sum makes the sum a floor. Measured
    // against the band actually being asked about, not against that venue's own
    // ±range, which is a different question when its mid is offset.
    const bidReachPrice = r.mid * (1 - (r.reach?.bid ?? 0) / 100);
    const askReachPrice = r.mid * (1 + (r.reach?.ask ?? 0) / 100);
    // The OTHER reason a venue's contribution is a floor, and the one that bites
    // hardest here: the five diff venues reach past their capped REST snapshot
    // only by accumulating updates, so a feed that opened seconds ago has most
    // of its band still missing. Measured live on BTC perp with the feeds two
    // seconds old, Binance came in at $75M against MEXC's $721M — a tenfold gap
    // that is the age of the feed, not the liquidity of the venue. Without this
    // it reads as a venue nobody trades on.
    const reasons = [];
    if (bidReachPrice > lo || askReachPrice < hi) reasons.push('book ends inside the band');
    if (r.accum?.since) reasons.push(`accumulating for ${Math.round((now - r.accum.since) / 1000)}s`);
    const accumulating = !!r.accum?.since;
    return {
      exchange: r.exchange,
      market: r.market,
      symbol: r.symbol,
      quote: r.quote ?? null,
      mid: r.mid,
      // How far this venue's own touch sits from the reference. A venue tens of
      // basis points away is either dislocated or stale, and either way its
      // contribution to the band is not what a reader would assume.
      midOffsetBps: (r.mid / refMid - 1) * 10_000,
      bidDepth,
      askDepth,
      totalDepth: bidDepth + askDepth,
      share: null,        // filled in below, once the total is known
      tsVenue: r.tsVenue ?? null,
      tsRecv: r.tsRecv,
      ageMs: now - r.tsRecv,
      // A depth this venue can only be at LEAST, and why. Both causes make the
      // figure a floor; naming them keeps a young feed from being read as a
      // shallow venue.
      lowerBound: {
        bidDepth: bidReachPrice > lo || accumulating,
        askDepth: askReachPrice < hi || accumulating,
        reasons,
      },
      accumulating: r.accum?.since
        ? { sinceMs: now - r.accum.since, staleFrac: r.accum.staleFrac ?? null }
        : null,
    };
  });

  const bidDepth = venues.reduce((s, v) => s + v.bidDepth, 0);
  const askDepth = venues.reduce((s, v) => s + v.askDepth, 0);
  const totalDepth = bidDepth + askDepth;
  for (const v of venues) v.share = totalDepth > 0 ? v.totalDepth / totalDepth : null;
  venues.sort((a, b) => b.totalDepth - a.totalDepth);

  const recvs = usable.map((r) => r.tsRecv);
  const oldest = Math.min(...recvs);
  const newest = Math.max(...recvs);

  // Venues quoting different settlement currencies are being added together as
  // if a USDT and a USD were the same unit. They are close and they are not
  // equal, and a reader summing eight venues has to be told rather than left to
  // notice. Stated, never silently corrected.
  const quotes = [...new Set(venues.map((v) => v.quote).filter(Boolean))];

  return {
    range,
    // False whenever anything is unaccounted for. A caller checking one boolean
    // must not be able to read a partial sum as a whole one.
    complete: missing.length === 0,
    reference: { mid: refMid, source: `median of ${usable.length} venue mids`, lo, hi },
    asOf: {
      oldestAgeMs: now - oldest,
      newestAgeMs: now - newest,
      // The books were read this far apart. A sum whose legs span seconds is a
      // mosaic, not a snapshot, and nothing else in the payload would say so.
      spanMs: newest - oldest,
    },
    total: {
      bidDepth,
      askDepth,
      totalDepth,
      // Resting-depth imbalance across the whole band. Not order-flow
      // imbalance — same distinction as the single-venue panel.
      imbalance: totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0,
      lowerBound: {
        bidDepth: venues.some((v) => v.lowerBound.bidDepth),
        askDepth: venues.some((v) => v.lowerBound.askDepth),
      },
    },
    quotes,
    mixedQuotes: quotes.length > 1,
    venues,
    missing,
  };
}
