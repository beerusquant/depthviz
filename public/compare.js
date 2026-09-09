import { computeMetrics, panelRows, fmtPrice, fmtBps } from '/shared/metrics.js';
import { draw } from './chart.js';
import { createFeed } from './feed.js';
import { applyStoredTheme, applyTheme } from './theme.js';

/**
 * Compare mode: any books, stacked, each with its own panel and curve.
 *
 * Unlike combined mode these books have nothing in common by construction —
 * different assets, different quote currencies, spot against perp, whatever the
 * viewer put on screen. So there is no shared axis and no total: each pane is
 * its own measurement, drawn by the same `draw()` single mode uses, which is
 * the point. Two books of the same asset are the only thing that CAN be
 * compared, and the only thing the arbitrage line looks at.
 *
 * The ceiling is the server's, not a number invented here: twelve feeds per
 * client, and each pane is one feed.
 */

const $ = (id) => document.getElementById(id);

// server/hub.js DEPTHVIZ_MAX_FEEDS_PER_CLIENT. Stated rather than discovered by
// a viewer who adds a thirteenth book and gets an error with no explanation.
const MAX_PANES = 12;

const state = {
  range: 2,
  theme: applyStoredTheme(),
  panes: [],        // { id, exchange, market, symbol, display, feed, book, metrics, status, detail, el, canvas }
  filter: null,     // null = all
  catalog: [],
  symbols: [],      // listing for the exchange/market currently in the add form
  dirty: true,
  nextId: 1,
};

const invalidate = () => { state.dirty = true; };
const exName = (id) => state.catalog.find((c) => c.id === id)?.name || id;
const visible = () => state.panes.filter((p) => !state.filter || p.key === state.filter);

// -------------------------------------------------------------------- panes
function addPane(exchange, market, symbol, display) {
  if (state.panes.length >= MAX_PANES) {
    toast(`${MAX_PANES} books is this server's per-client ceiling`);
    return;
  }
  if (state.panes.some((p) => p.exchange === exchange && p.market === market && p.symbol === symbol)) {
    toast('already on screen');
    return;
  }
  const pane = {
    id: state.nextId++,
    exchange, market, symbol,
    display: display || symbol,
    key: `${exchange}:${market}:${symbol}`,
    book: null, metrics: null, status: 'connecting', detail: '',
  };
  pane.feed = createFeed({
    onBook: (b) => {
      pane.book = b;
      pane.metrics = computeMetrics(b, state.range);
      pane.status = 'live';
      pane.detail = '';
      invalidate();
    },
    onStatus: (st, detail) => {
      // One book going quiet must not speak for the others: it is reported in
      // its own pane and nowhere else.
      pane.status = st;
      pane.detail = detail || '';
      invalidate();
    },
  });
  pane.feed.subscribe({ exchange, market, symbol, range: state.range });
  state.panes.push(pane);
  rebuild();
}

function removePane(id) {
  const i = state.panes.findIndex((p) => p.id === id);
  if (i < 0) return;
  try { state.panes[i].feed?.close(); } catch { /* already gone */ }
  const [gone] = state.panes.splice(i, 1);
  if (state.filter === gone.key) state.filter = null;
  rebuild();
}

// --------------------------------------------------------------------- DOM
/** Rebuild the pane elements. Called when the SET of panes changes, not per frame. */
function rebuild() {
  const host = $('panes');
  host.replaceChildren();
  for (const p of visible()) {
    const el = document.createElement('section');
    el.className = 'pane';

    const side = document.createElement('div');
    side.className = 'pane-side';

    const head = document.createElement('div');
    head.className = 'pane-head';
    const h = document.createElement('h2');
    // textContent everywhere: symbols come from exchange listings.
    h.textContent = `${exName(p.exchange)} [${p.market.toUpperCase()}]`;
    const sub = document.createElement('div');
    sub.className = 'pane-sym';
    sub.textContent = p.display;
    const kill = document.createElement('button');
    kill.className = 'pane-x';
    kill.type = 'button';
    kill.title = 'Remove this book';
    kill.textContent = '×';
    kill.onclick = () => removePane(p.id);
    head.append(h, sub, kill);

    const rows = document.createElement('div');
    rows.className = 'pane-rows';

    side.append(head, rows);

    const canvas = document.createElement('canvas');
    canvas.className = 'pane-chart';

    el.append(side, canvas);
    host.appendChild(el);
    p.el = el;
    p.rowsEl = rows;
    p.canvas = canvas;
  }
  renderFilter();
  $('add-count').textContent = `${state.panes.length}/${MAX_PANES} BOOKS`;
  invalidate();
}

function renderFilter() {
  const seg = $('filter');
  seg.replaceChildren();
  const mk = (label, key) => {
    const b = document.createElement('button');
    b.className = `seg-b${state.filter === key ? ' active' : ''}`;
    b.type = 'button';
    b.textContent = label;
    b.onclick = () => { state.filter = key; rebuild(); };
    return b;
  };
  seg.appendChild(mk('ALL', null));
  for (const p of state.panes) seg.appendChild(mk(`${exName(p.exchange)} ${p.display}`, p.key));
  $('filterbar').classList.toggle('hidden', state.panes.length < 2);
}

// --------------------------------------------------------------- arbitrage
/**
 * The best spread between two books OF THE SAME ASSET.
 *
 * Same asset only, and stated as such: this tool cannot tell whether a viewer's
 * BTC/USDT and ETH/USDT panes are meant to be compared, and a "spread" between
 * two different assets is a number with no meaning that would look exactly like
 * a live opportunity. Books of the same base in different quote currencies ARE
 * compared — USDT against USD is the case worth seeing — and the line says so.
 *
 * It is a mid-to-mid difference, not an executable edge: it ignores the spread
 * each side would cross, the fees, and the fact that the two books were read at
 * different instants. Named `mid Δ` for that reason.
 */
function bestArb() {
  const live = state.panes.filter((p) => p.metrics && p.base);
  let best = null;
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (a.base !== b.base) continue;
      const [lo, hi] = a.metrics.mid <= b.metrics.mid ? [a, b] : [b, a];
      const diff = hi.metrics.mid - lo.metrics.mid;
      const pct = (diff / lo.metrics.mid) * 100;
      if (!best || pct > best.pct) {
        best = {
          pct,
          diff,
          from: `${exName(lo.exchange)} [${lo.market.toUpperCase()}]`,
          to: `${exName(hi.exchange)} [${hi.market.toUpperCase()}]`,
          mixedQuote: lo.quote !== hi.quote,
          // Both mids, and how far apart the two reads were: comparing books
          // seconds apart is a mosaic, not a spread.
          spanMs: Math.abs((a.book?.tsRecv ?? 0) - (b.book?.tsRecv ?? 0)),
        };
      }
    }
  }
  return { best, pairs: countPairs(live) };
}

function countPairs(live) {
  let n = 0;
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) if (live[i].base === live[j].base) n++;
  }
  return n;
}

function renderArb() {
  const { best, pairs } = bestArb();
  const el = $('arb-text');
  if (!best) {
    el.textContent = state.panes.length < 2
      ? 'add a second book of the same asset to compare'
      : 'no two books share an asset — nothing comparable on screen';
    el.className = 'dim';
    return;
  }
  const bits = [
    `${pairs} COMPARABLE PAIR${pairs > 1 ? 'S' : ''}`,
    `widest mid Δ: ${best.from} → ${best.to}`,
    `${fmtPrice(best.diff)} (${fmtBps(best.pct)})`,
  ];
  // Both caveats are the difference between a number and a claim.
  if (best.mixedQuote) bits.push('different quote currencies');
  if (best.spanMs > 1000) bits.push(`books read ${(best.spanMs / 1000).toFixed(1)}s apart`);
  el.textContent = bits.join(' · ');
  el.className = '';
}

// --------------------------------------------------------------- rendering
function renderPane(p) {
  if (!p.canvas) return;
  draw(p.canvas, {
    range: state.range,
    metrics: p.metrics,
    theme: state.theme,
    hover: null,
    statusText: p.detail || p.status,
    meta: {
      exchangeName: exName(p.exchange),
      market: p.market,
      display: p.display,
      quote: p.quote || 'USD',
      vol24h: p.book?.vol24h ?? null,
      volTs: p.book?.volTs ?? null,
      tsVenue: p.book?.tsVenue ?? null,
      tsRecv: p.book?.tsRecv ?? null,
      now: Date.now(),
    },
  });

  const host = p.rowsEl;
  if (!host) return;
  host.replaceChildren();
  if (!p.metrics) {
    const d = document.createElement('div');
    d.className = 'prow dim';
    d.textContent = p.detail ? `${p.status} — ${p.detail}` : p.status;
    host.appendChild(d);
    return;
  }
  // The same rows single mode shows, from the same shared implementation — so a
  // figure cannot mean one thing in one mode and another here.
  for (const [label, value, colour, key] of panelRows(p.metrics, {
    exchangeName: exName(p.exchange), market: p.market, display: p.display,
    vol24h: p.book?.vol24h ?? null, volTs: p.book?.volTs ?? null,
    tsVenue: p.book?.tsVenue ?? null, tsRecv: p.book?.tsRecv ?? null, now: Date.now(),
  })) {
    if (key === 'exchange' || key === 'symbol') continue;  // already in the header
    const row = document.createElement('div');
    row.className = 'prow';
    const l = document.createElement('span');
    l.className = 'plabel';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = `pvalue c-${colour}`;
    v.textContent = value;
    row.append(l, v);
    host.appendChild(row);
  }
}

function frame() {
  if (state.dirty) {
    state.dirty = false;
    for (const p of visible()) renderPane(p);
    renderArb();
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ toasts
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1600);
}

// ------------------------------------------------------------- the add form
let listGen = 0;

async function loadSymbols() {
  const gen = ++listGen;
  const exchange = $('add-ex').value;
  const market = $('add-mk').value;
  state.symbols = [];
  try {
    const r = await fetch(`/api/symbols?exchange=${exchange}&market=${market}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    if (gen !== listGen) return;   // a later request owns the form now
    state.symbols = j.symbols;
  } catch {
    if (gen === listGen) state.symbols = [];
  }
}

function matches(q) {
  const needle = q.trim().toUpperCase();
  if (!needle) return state.symbols.slice(0, 200);
  const out = [];
  for (const s of state.symbols) {
    const d = s.d.toUpperCase();
    if (d.startsWith(needle) || d.includes(needle) || s.s.toUpperCase().includes(needle)) out.push(s);
    if (out.length >= 200) break;
  }
  return out;
}

function renderAddMenu(q) {
  const el = $('add-menu');
  el.replaceChildren();
  const hits = matches(q);
  if (!hits.length) {
    const d = document.createElement('div');
    d.className = 'menu-empty';
    d.textContent = state.symbols.length ? 'no match' : 'loading…';
    el.appendChild(d);
  }
  for (const s of hits) {
    const d = document.createElement('div');
    d.className = 'menu-i';
    const a = document.createElement('span');
    a.textContent = s.d;
    const b = document.createElement('span');
    b.className = 'raw';
    b.textContent = s.s;
    d.append(a, b);
    d.onmousedown = (e) => {
      e.preventDefault();
      $('add-sym').value = s.d;
      $('add-sym').dataset.raw = s.s;
      $('add-sym').dataset.base = s.base || '';
      $('add-sym').dataset.quote = s.quote || '';
      el.classList.remove('open');
    };
    el.appendChild(d);
  }
  el.classList.add('open');
  return hits;
}

function submitAdd() {
  const input = $('add-sym');
  const hits = matches(input.value);
  const chosen = state.symbols.find((s) => s.s === input.dataset.raw && s.d === input.value) || hits[0];
  if (!chosen) return toast('no such symbol on that venue');
  const p = { exchange: $('add-ex').value, market: $('add-mk').value };
  addPane(p.exchange, p.market, chosen.s, chosen.d);
  const pane = state.panes[state.panes.length - 1];
  if (pane) { pane.base = (chosen.base || '').toUpperCase(); pane.quote = chosen.quote || null; }
  $('add-menu').classList.remove('open');
  invalidate();
}

// ------------------------------------------------------------------- wiring
$('range').onclick = (e) => {
  const b = e.target.closest('.seg-b');
  if (!b) return;
  state.range = +b.dataset.range;
  document.querySelectorAll('#range .seg-b').forEach((x) => x.classList.toggle('active', +x.dataset.range === state.range));
  for (const p of state.panes) {
    p.feed?.subscribe({ exchange: p.exchange, market: p.market, symbol: p.symbol, range: state.range });
    if (p.book) p.metrics = computeMetrics(p.book, state.range);
  }
  invalidate();
};
$('add-ex').onchange = () => { loadSymbols(); };
$('add-mk').onchange = () => { loadSymbols(); };
$('add-sym').onfocus = (e) => renderAddMenu(e.target.value);
$('add-sym').oninput = (e) => { delete e.target.dataset.raw; renderAddMenu(e.target.value); };
$('add-sym').onkeydown = (e) => {
  if (e.key === 'Enter') submitAdd();
  else if (e.key === 'Escape') { $('add-menu').classList.remove('open'); e.target.blur(); }
};
$('add-sym').onblur = () => setTimeout(() => $('add-menu').classList.remove('open'), 120);
$('add-btn').onclick = submitAdd;
$('theme').onclick = () => {
  state.theme = applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  invalidate();
};
$('copy').onclick = async () => {
  const now = Date.now();
  const live = state.panes.filter((p) => p.metrics);
  if (!live.length) return toast('no data yet');
  const { best } = bestArb();
  const out = {
    mode: 'compare', range: state.range,
    books: live.map((p) => ({
      exchange: p.exchange, market: p.market, symbol: p.symbol, quote: p.quote ?? null,
      mid: p.metrics.mid, spreadPct: p.metrics.spreadPct,
      bidDepth: p.metrics.bidDepth, askDepth: p.metrics.askDepth, totalDepth: p.metrics.totalDepth,
      lowerBound: p.metrics.lowerBound,
      tsVenue: p.book.tsVenue, tsRecv: p.book.tsRecv, ageMs: now - p.book.tsRecv,
    })),
    widestMidDelta: best
      ? { from: best.from, to: best.to, abs: best.diff, pct: best.pct,
          mixedQuote: best.mixedQuote, readSpanMs: best.spanMs,
          note: 'mid to mid — not an executable edge: no crossed spread, no fees, and the two books were read at different instants' }
      : null,
  };
  try { await navigator.clipboard.writeText(JSON.stringify(out, null, 2)); toast('copied to clipboard'); }
  catch { toast('clipboard blocked by browser'); }
};

setInterval(invalidate, 1000);
window.addEventListener('resize', invalidate);
window.addEventListener('orientationchange', () => setTimeout(invalidate, 120));

/** Read-only probe for smoke-ui.mjs, not an API. */
window.__depthvizProbe = () => ({
  mode: 'compare',
  range: state.range,
  filter: state.filter,
  panes: state.panes.map((p) => ({
    exchange: p.exchange, market: p.market, symbol: p.symbol,
    live: !!p.metrics, status: p.status,
  })),
  visible: visible().length,
  arb: $('arb-text').textContent,
});

// --------------------------------------------------------------------- init
(async () => {
  state.catalog = await (await fetch('/api/catalog')).json();
  const sel = $('add-ex');
  for (const c of state.catalog) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    sel.appendChild(o);
  }
  sel.value = 'binance';
  await loadSymbols();
  // Two books to open on, so the mode explains itself: the same asset on two
  // venues is the comparison this page is for.
  const btc = state.symbols.find((s) => s.s === 'BTCUSDT');
  if (btc) { $('add-sym').value = btc.d; $('add-sym').dataset.raw = btc.s; submitAdd(); }
  sel.value = 'okx';
  await loadSymbols();
  const okxBtc = state.symbols.find((s) => s.s === 'BTC-USDT');
  if (okxBtc) { $('add-sym').value = okxBtc.d; $('add-sym').dataset.raw = okxBtc.s; submitAdd(); }
  $('add-sym').value = '';
  rebuild();
  requestAnimationFrame(frame);
})();
