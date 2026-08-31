// Pure computation: order book -> everything the panel and the chart need.

export const OFI_THRESHOLD = 0.15;
const NBINS = 60;

function walk(rows, mid, range) {
  const pts = [[0, 0]];
  const bins = new Float64Array(NBINS);
  let cum = 0, sumQ = 0, sumPQ = 0, d2 = 0, d5 = 0, far = 0, inRange = 0;

  for (const [p, q] of rows) {
    const pct = (p / mid - 1) * 100;
    const a = Math.abs(pct);
    const n = p * q;
    cum += n;
    if (a <= 2) d2 = cum;
    if (a <= 5) d5 = cum;
    if (a <= range) {
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
  const total = b.depth + a.depth;
  const ofi = total > 0 ? (b.depth - a.depth) / total : 0;

  return {
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
    ofi,
    ofiLabel: ofi > OFI_THRESHOLD ? 'BID-heavy' : ofi < -OFI_THRESHOLD ? 'ASK-heavy' : 'NEUTRAL',
    // true when the exchange's book stops before the requested range
    shortBid: b.reach < range * 0.98,
    shortAsk: a.reach < range * 0.98,
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

/** Panel rows, in the order they are rendered and copied. */
export function panelRows(m, meta) {
  return [
    ['Exchange', `${meta.exchangeName} [${meta.market.toUpperCase()}]`, 'fg'],
    ['Symbol', meta.display, 'fg'],
    ['Mid Price', fmtPrice(m.mid), 'fg'],
    ['Spread', fmtPct(m.spreadPct, m.spreadPct < 0.01 ? 4 : 3), 'fg'],
    ['24H Volume', fmtUsd(meta.vol24h), 'fg'],
    ['Bid VWAP', `${fmtPrice(m.bidVwap)} (${fmtPct(m.bidVwapPct)})`, 'cyan'],
    ['Ask VWAP', `${fmtPrice(m.askVwap)} (${fmtPct(m.askVwapPct)})`, 'orange'],
    ['Bid Depth', fmtUsd(m.bidDepth), 'bid'],
    ['Ask Depth', fmtUsd(m.askDepth), 'ask'],
    ['+2% Depth', fmtUsd(m.depthPlus2), 'fg'],
    ['-2% Depth', fmtUsd(m.depthMinus2), 'fg'],
    ['+5% Depth', fmtUsd(m.depthPlus5), 'fg'],
    ['-5% Depth', fmtUsd(m.depthMinus5), 'fg'],
    ['Total Depth', fmtUsd(m.totalDepth), 'fg'],
    ['OFI', `${m.ofi.toFixed(3)} ${m.ofiLabel}`, m.ofi > OFI_THRESHOLD ? 'bid' : m.ofi < -OFI_THRESHOLD ? 'ask' : 'fg'],
  ];
}
