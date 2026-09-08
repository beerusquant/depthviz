import { fmtUsd, fmtPct, fmtPrice, panelRows } from '/shared/metrics.js';

const THEMES = {
  dark: {
    bg: '#07080a', grid: '#151a20', axis: '#7d8590', text: '#e6edf3', sub: '#9aa4ae',
    bidLine: '#00e676', bidFill: 'rgba(0,230,118,.15)', bidBar: 'rgba(0,200,83,.60)',
    askLine: '#ff1744', askFill: 'rgba(255,23,68,.13)', askBar: 'rgba(255,23,68,.55)',
    cyan: '#22d3ee', orange: '#f59e0b', mid: '#e6edf3',
    panelBg: 'rgba(6,8,10,.86)', panelLine: '#232a32',
  },
  light: {
    bg: '#ffffff', grid: '#e8ecf0', axis: '#5b6570', text: '#1a1f24', sub: '#5b6570',
    bidLine: '#0a9b52', bidFill: 'rgba(10,155,82,.14)', bidBar: 'rgba(10,155,82,.45)',
    askLine: '#d81b3f', askFill: 'rgba(216,27,63,.12)', askBar: 'rgba(216,27,63,.42)',
    cyan: '#0e7490', orange: '#b45309', mid: '#1a1f24',
    panelBg: 'rgba(255,255,255,.92)', panelLine: '#d8dee4',
  },
};

/**
 * Chart geometry, derived from the canvas rather than fixed.
 *
 * The old constants (`l: 78, r: 22, t: 58, b: 40`) plus a seven-item legend and
 * a fifteen-row metrics panel assume roughly 1 000 CSS pixels of width. On a
 * 390px phone the same numbers leave ~290px of plot behind a panel that is
 * wider than it, which is not a small chart — it is no chart. So each piece is
 * dropped or shrunk in the order it stops earning its space: the legend first
 * (its colours are also the panel's), then the panel down to the rows that
 * cannot be inferred from the curve, then the gutters.
 */
function layout(cssW, cssH) {
  const tiny = cssW < 480;
  const narrow = cssW < 760;
  const short = cssH < 420;
  return {
    tiny,
    narrow,
    legend: !narrow,
    compactPanel: narrow,
    xTicks: tiny ? 5 : narrow ? 7 : 9,
    titleSize: tiny ? 11 : narrow ? 12 : 14,
    pad: {
      l: tiny ? 50 : narrow ? 62 : 78,
      r: tiny ? 10 : narrow ? 14 : 22,
      t: narrow ? (short ? 30 : 34) : 58,
      b: tiny ? 32 : 40,
    },
  };
}

/** Cut a label to what fits, so a long title never overruns the plot. */
function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid; else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/** Pick a human tick step (1/2/2.5/5 x 10^k) giving roughly `want` ticks. */
function tickStep(max, want) {
  if (!(max > 0)) return 1;
  const raw = max / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * mag;
}

function dashed(ctx, x, y0, y1, color, pattern = [5, 4]) {
  ctx.save();
  ctx.setLineDash(pattern);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, y1);
  ctx.stroke();
  ctx.restore();
}

export function draw(canvas, st) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const T = THEMES[st.theme] || THEMES.dark;
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  const L = layout(cssW, cssH);
  const PAD = L.pad;
  const W = cssW - PAD.l - PAD.r;
  const H = cssH - PAD.t - PAD.b;
  if (W < 120 || H < 100) return null;

  const { range, metrics: m, meta } = st;
  const title = m
    ? L.narrow
      ? `${meta.display} — ${meta.exchangeName} [${meta.market.toUpperCase()}]`
      : `${meta.display} — ${meta.exchangeName} [${meta.market.toUpperCase()}] Order Book Depth`
    : `${meta.exchangeName} [${meta.market.toUpperCase()}] — waiting for book…`;

  ctx.textBaseline = 'middle';
  ctx.font = `600 ${L.titleSize}px ui-monospace, Menlo, monospace`;
  ctx.fillStyle = T.text;
  ctx.textAlign = 'center';
  ctx.fillText(fit(ctx, title, W), PAD.l + W / 2, L.narrow ? 14 : 22);

  if (L.legend) drawLegend(ctx, T, PAD.l + W, 44);

  if (!m) {
    ctx.textAlign = 'center';
    ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.fillStyle = T.sub;
    ctx.fillText(st.statusText || 'connecting…', PAD.l + W / 2, PAD.t + H / 2);
    return null;
  }

  const maxCum = Math.max(
    m.bid.pts.at(-1)?.[1] || 0,
    m.ask.pts.at(-1)?.[1] || 0,
    1,
  );
  const yMax = maxCum * 1.08;

  const x = (pct) => PAD.l + ((pct + range) / (2 * range)) * W;
  const y = (v) => PAD.t + H - (v / yMax) * H;
  const y0 = PAD.t + H;

  // --- grid + axes -------------------------------------------------------
  const step = tickStep(yMax, L.tiny ? 4 : 6);
  ctx.font = `${L.tiny ? 9 : 10}px ui-monospace, Menlo, monospace`;
  ctx.strokeStyle = T.grid;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (let v = 0; v <= yMax; v += step) {
    const yy = Math.round(y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(PAD.l + W, yy); ctx.stroke();
    ctx.fillStyle = T.axis;
    ctx.fillText(v === 0 ? '0' : fmtUsd(v), PAD.l - (L.tiny ? 5 : 8), yy);
  }

  ctx.textAlign = 'center';
  const XT = L.xTicks;
  for (let i = 0; i < XT; i++) {
    const pct = -range + (2 * range * i) / (XT - 1);
    const xx = Math.round(x(pct)) + 0.5;
    ctx.strokeStyle = T.grid;
    ctx.beginPath(); ctx.moveTo(xx, PAD.t); ctx.lineTo(xx, y0); ctx.stroke();
    ctx.fillStyle = T.axis;
    ctx.fillText(range >= 1 ? pct.toFixed(1) : pct.toFixed(2), xx, y0 + (L.tiny ? 13 : 16));
  }
  ctx.fillStyle = T.sub;
  // Two labels, one gutter: on a phone the axis captions are the first thing to
  // go, because the tick values already carry the units.
  if (!L.tiny) {
    ctx.fillText('% from mid', PAD.l + W / 2, y0 + 31);
    ctx.save();
    ctx.translate(14, PAD.t + H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = T.sub;
    ctx.fillText(`Depth (${meta.quote || 'USD'})`, 0, 0);
    ctx.restore();
  }

  // --- raw level histogram (drawn under the curves) ----------------------
  const bw = W / 2 / m.nbins;
  const bar = (bins, sign, color) => {
    ctx.fillStyle = color;
    for (let i = 0; i < m.nbins; i++) {
      const v = bins[i];
      if (!(v > 0)) continue;
      const p0 = sign * (i / m.nbins) * range;
      const px = sign < 0 ? x(p0) - bw : x(p0);
      const h = (v / yMax) * H;
      ctx.fillRect(px + 0.5, y0 - h, Math.max(1, bw - 1), h);
    }
  };
  bar(m.bid.bins, -1, T.bidBar);
  bar(m.ask.bins, 1, T.askBar);

  // --- cumulative curves -------------------------------------------------
  const curve = (pts, line, fill) => {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(x(pts[0][0]), y(pts[0][1]));
    for (let i = 1; i < pts.length; i++) {
      // stepped: hold the previous cumulative until the next price level
      ctx.lineTo(x(pts[i][0]), y(pts[i - 1][1]));
      ctx.lineTo(x(pts[i][0]), y(pts[i][1]));
    }
    ctx.save();
    ctx.lineTo(x(pts.at(-1)[0]), y0);
    ctx.lineTo(x(pts[0][0]), y0);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(x(pts[0][0]), y(pts[0][1]));
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(x(pts[i][0]), y(pts[i - 1][1]));
      ctx.lineTo(x(pts[i][0]), y(pts[i][1]));
    }
    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };
  curve(m.bid.pts, T.bidLine, T.bidFill);
  curve(m.ask.pts, T.askLine, T.askFill);

  // --- reference lines ---------------------------------------------------
  if (m.bidVwapPct != null && m.bidVwapPct >= -range) dashed(ctx, x(m.bidVwapPct), PAD.t, y0, T.cyan, [6, 4]);
  if (m.askVwapPct != null && m.askVwapPct <= range) dashed(ctx, x(m.askVwapPct), PAD.t, y0, T.orange, [6, 4]);
  dashed(ctx, x(0), PAD.t, y0, T.mid, [7, 6]);

  // --- data panel --------------------------------------------------------
  drawPanel(ctx, T, PAD.l + (L.tiny ? 6 : 12), PAD.t + 8, m, meta, L);

  // --- hover crosshair ---------------------------------------------------
  if (st.hover && st.hover.x >= PAD.l && st.hover.x <= PAD.l + W) {
    const pct = ((st.hover.x - PAD.l) / W) * 2 * range - range;
    const src = pct < 0 ? m.bid.pts : m.ask.pts;
    let cum = 0;
    for (const [p, c] of src) { if (Math.abs(p) <= Math.abs(pct)) cum = c; else break; }
    dashed(ctx, st.hover.x, PAD.t, y0, T.sub, [2, 3]);
    const label = `${pct >= 0 ? '+' : ''}${pct.toFixed(range >= 1 ? 2 : 3)}%  ${fmtUsd(cum)}`;
    ctx.font = '11px ui-monospace, Menlo, monospace';
    const w = ctx.measureText(label).width + 14;
    const bx = Math.min(PAD.l + W - w, Math.max(PAD.l, st.hover.x + 8));
    const by = Math.max(PAD.t + 4, Math.min(y0 - 26, st.hover.y - 26));
    ctx.fillStyle = T.panelBg;
    ctx.strokeStyle = T.panelLine;
    ctx.fillRect(bx, by, w, 20);
    ctx.strokeRect(bx + 0.5, by + 0.5, w, 20);
    ctx.fillStyle = pct < 0 ? T.bidLine : T.askLine;
    ctx.textAlign = 'left';
    ctx.fillText(label, bx + 7, by + 10);
  }

  return { x, y, yMax };
}

function drawLegend(ctx, T, right, yy) {
  const items = [
    ['Cumulative Bid', T.bidLine, 'line'],
    ['Cumulative Ask', T.askLine, 'line'],
    ['Bid VWAP', T.cyan, 'dash'],
    ['Ask VWAP', T.orange, 'dash'],
    ['Mid', T.mid, 'dash'],
    ['Bid Lvls', T.bidBar, 'box'],
    ['Ask Lvls', T.askBar, 'box'],
  ];
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left';
  let w = 0;
  for (const [t] of items) w += ctx.measureText(t).width + 34;
  let cx = right - w;
  for (const [text, color, kind] of items) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.save();
    if (kind === 'box') {
      ctx.fillRect(cx, yy - 4, 18, 8);
    } else {
      if (kind === 'dash') ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(cx, yy); ctx.lineTo(cx + 18, yy); ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = T.sub;
    ctx.fillText(text, cx + 24, yy);
    cx += ctx.measureText(text).width + 34;
  }
}

// The rows a trader cannot read off the curve itself. Everything dropped here
// (the ±2%/±5% depths, total depth, the exchange line) is still in the COPY
// payload — the panel is shortened, the data is not.
const COMPACT_ROWS = new Set(['symbol', 'mid', 'spread', 'bidDepth', 'askDepth', 'imbalance', 'age']);

function drawPanel(ctx, T, px, py, m, meta, L) {
  const all = panelRows(m, meta);
  const rows = L.compactPanel ? all.filter(([, , , key]) => COMPACT_ROWS.has(key)) : all;
  ctx.font = `${L.tiny ? 9 : L.narrow ? 10 : 11}px ui-monospace, Menlo, monospace`;
  const lh = L.tiny ? 11.5 : L.narrow ? 12.5 : 13.5;
  let labelW = 0, valW = 0;
  for (const [l, v] of rows) {
    labelW = Math.max(labelW, ctx.measureText(`${l}:`).width);
    valW = Math.max(valW, ctx.measureText(v).width);
  }
  const w = labelW + valW + (L.tiny ? 22 : 30);
  const h = rows.length * lh + 16;

  ctx.fillStyle = T.panelBg;
  ctx.fillRect(px, py, w, h);
  ctx.strokeStyle = T.panelLine;
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 0.5, py + 0.5, w, h);

  const colors = { fg: T.text, bid: T.bidLine, ask: T.askLine, cyan: T.cyan, orange: T.orange };
  ctx.textAlign = 'left';
  rows.forEach(([l, v, c], i) => {
    const yy = py + 14 + i * lh;
    ctx.fillStyle = T.sub;
    ctx.fillText(`${l}:`, px + 10, yy);
    ctx.fillStyle = colors[c] || T.text;
    ctx.fillText(v, px + 10 + labelW + (L.tiny ? 8 : 12), yy);
  });
}
