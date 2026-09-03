import { computeMetrics, panelRows } from '/shared/metrics.js';
import { draw } from './chart.js';

const $ = (id) => document.getElementById(id);
const canvas = $('chart');

const state = {
  catalog: [],
  exchange: 'binance',
  market: 'spot',
  symbol: null,
  display: null,
  quote: 'USD',
  range: 2,
  symbols: [],
  book: null,
  vol24h: null,
  metrics: null,
  status: 'connecting',
  statusDetail: '',
  theme: localStorage.getItem('depthviz.theme') || 'dark',
  hover: null,
  dirty: true,
};

const exOf = (id) => state.catalog.find((c) => c.id === id);
const exName = () => exOf(state.exchange)?.name || state.exchange;

// ---------------------------------------------------------------- rendering
function invalidate() { state.dirty = true; }

function frame() {
  if (state.dirty) {
    state.dirty = false;
    state.metrics = state.book ? computeMetrics(state.book, state.range) : null;
    draw(canvas, {
      range: state.range,
      metrics: state.metrics,
      theme: state.theme,
      hover: state.hover,
      statusText: state.statusDetail || state.status,
      meta: {
        exchangeName: exName(),
        market: state.market,
        display: state.display || state.symbol || '—',
        quote: state.quote,
        vol24h: state.vol24h,
        tsVenue: state.book?.tsVenue ?? null,
        tsRecv: state.book?.tsRecv ?? null,
        now: Date.now(),
      },
    });
    renderNote();
  }
  requestAnimationFrame(frame);
}

function renderNote() {
  // One rule: say something only when the book does NOT reach the range being
  // asked for. A caveat shown on every venue at every range is wallpaper — it
  // stops being read exactly when it starts mattering. When the curve ends
  // inside the window, nothing is drawn past it and the note says where and
  // why; when the venue fills the window, the chart speaks for itself.
  const bits = [];
  const m = state.metrics;
  if (m && (m.shortBid || m.shortAsk)) {
    const at = (r) => `${r.toFixed(r < 1 ? 3 : 2)}%`;
    const where = m.shortBid && m.shortAsk
      ? `±${at(Math.max(m.bid.reach, m.ask.reach))}`
      : m.shortBid ? `-${at(m.bid.reach)} on the bid side` : `+${at(m.ask.reach)} on the ask side`;
    bits.push(`book ends at ${where} of ±${state.range}% — the exchange publishes nothing further, so nothing is drawn there`);
    const n = exOf(state.exchange)?.notes?.[state.market];
    if (n) bits.push(n);
  } else if (state.book?.accum?.since && state.range > 0.6) {
    // A book that only reaches past its snapshot by accumulating diffs is a
    // lower bound while it is young. Said once, briefly, then it goes away.
    const secs = Math.round((Date.now() - state.book.accum.since) / 1000);
    if (secs < 60) bits.push(`depth beyond ±0.6% is still filling in — ${secs}s of updates so far, so it can only grow`);
  }
  const el = $('note');
  el.textContent = bits.join(' · ');
  el.classList.toggle('hidden', bits.length === 0);
}

// ---------------------------------------------------------- server websocket
let ws = null, wsRetry = 0, wsTimer = null;

function setStatus(s, detail = '') {
  state.status = s;
  state.statusDetail = detail;
  const el = $('live');
  el.classList.remove('live-on', 'live-wait', 'live-err');
  const map = {
    live: ['live-on', 'LIVE', 'STREAMING'],
    connecting: ['live-wait', 'CONNECTING', ''],
    reconnecting: ['live-wait', 'RECONNECTING', ''],
    idle: ['live-wait', 'IDLE', ''],
    error: ['live-err', 'ERROR', detail.slice(0, 44)],
    offline: ['live-err', 'OFFLINE', 'server unreachable'],
  };
  const [cls, b, sub] = map[s] || ['live-wait', s.toUpperCase(), detail];
  el.classList.add(cls);
  $('live-b').textContent = b;
  $('live-s').textContent = sub ? ` ${sub}` : '';
  invalidate();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { wsRetry = 0; sendSubscribe(); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.op === 'status') setStatus(m.state, m.detail);
    else if (m.op === 'book') {
      if (m.exchange !== state.exchange || m.market !== state.market || m.symbol !== state.symbol) return;
      state.book = { bids: m.bids, asks: m.asks, tsVenue: m.tsVenue, tsRecv: m.tsRecv, source: m.source, levels: m.levels, accum: m.accum };
      state.vol24h = m.vol24h;
      if (state.status !== 'live') setStatus('live');
      invalidate();
    }
  };
  ws.onclose = () => {
    setStatus('offline');
    clearTimeout(wsTimer);
    wsTimer = setTimeout(connect, Math.min(8000, 400 * 2 ** wsRetry++));
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function sendSubscribe() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !state.symbol) return;
  setStatus('connecting');
  ws.send(JSON.stringify({
    op: 'subscribe',
    exchange: state.exchange,
    market: state.market,
    symbol: state.symbol,
    range: state.range,
  }));
}

// -------------------------------------------------------------- symbol list
function pickDefault(list) {
  return list.find((s) => s.base === 'BTC' && s.quote === 'USDT')
    || list.find((s) => s.base === 'BTC')
    || list[0];
}

async function loadSymbols(keepSymbol = null) {
  $('pairs').textContent = 'LOADING…';
  state.symbols = [];
  try {
    const r = await fetch(`/api/symbols?exchange=${state.exchange}&market=${state.market}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    state.symbols = j.symbols;
    $('pairs').textContent = `${j.count.toLocaleString('en-US')} PAIRS`;
  } catch (e) {
    $('pairs').textContent = 'LIST FAILED';
    setStatus('error', e.message);
    return;
  }
  const found = keepSymbol && state.symbols.find((s) => s.d === keepSymbol);
  selectSymbol(found || pickDefault(state.symbols));
}

function selectSymbol(s) {
  if (!s) return;
  state.symbol = s.s;
  state.display = s.d;
  state.quote = s.quote || 'USD';
  state.book = null;
  state.vol24h = null;
  $('sym-input').value = s.d;
  closeMenu($('sym-menu'));
  invalidate();
  sendSubscribe();
}

// -------------------------------------------------------------------- menus
function closeMenu(el) { el.classList.remove('open'); }
function closeAll() { document.querySelectorAll('.menu').forEach(closeMenu); }

/**
 * A menu row: a label and a dim raw value, both written as TEXT.
 *
 * Symbol names are chosen by whoever lists the token, not by us — 27 of the
 * 10 250 pairs served today already carry names outside plain ASCII
 * (`币安人生/USDT`, `GOLD(PAXG)/USDC`). Interpolating those into markup makes
 * the listing form a script tag away from running in the viewer's page, so
 * nothing from an exchange is ever parsed as HTML here.
 */
function menuRow(label, raw) {
  const d = document.createElement('div');
  const a = document.createElement('span');
  a.textContent = label;
  const b = document.createElement('span');
  b.className = 'raw';
  b.textContent = raw;
  d.append(a, b);
  return d;
}

function renderExchangeMenu() {
  const el = $('ex-menu');
  el.replaceChildren();
  for (const c of state.catalog) {
    const ok = c.markets.includes(state.market);
    const d = menuRow(c.name, c.markets.map((m) => c.transport[m]).join('/'));
    d.className = `menu-i${ok ? '' : ' disabled'}${c.id === state.exchange ? ' sel' : ''}`;
    if (ok) d.onclick = () => { setExchange(c.id); closeMenu(el); };
    el.appendChild(d);
  }
}

const QUOTE_RANK = { USDT: 0, USD: 1, USDC: 2, USDE: 3, EUR: 6 };

/** Rank matches so typing "RAY" lands on RAY/USDT, not RAY/TRY. */
function scoreSymbol(s, needle) {
  const base = s.base.toUpperCase();
  const d = s.d.toUpperCase();
  const raw = s.s.toUpperCase();
  let hit;
  if (base === needle) hit = 0;
  else if (base.startsWith(needle)) hit = 1;
  else if (d.startsWith(needle)) hit = 2;
  else if (d.includes(needle)) hit = 3;
  else if (raw.includes(needle)) hit = 4;
  else return null;
  return hit * 10 + (QUOTE_RANK[s.quote?.toUpperCase()] ?? 5);
}

function renderSymbolMenu(q = '') {
  const el = $('sym-menu');
  const needle = q.trim().toUpperCase();
  let hits;
  if (!needle) {
    hits = state.symbols.slice(0, 400);
  } else {
    const scored = [];
    for (const s of state.symbols) {
      const sc = scoreSymbol(s, needle);
      if (sc !== null) scored.push([sc, s]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].d.localeCompare(b[1].d));
    hits = scored.slice(0, 400).map((x) => x[1]);
  }
  el.replaceChildren();
  if (!hits.length) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = 'no match';
    el.appendChild(empty);
  } else {
    for (const s of hits) {
      const d = menuRow(s.d, s.s);
      d.className = `menu-i${s.s === state.symbol ? ' sel' : ''}`;
      d.onmousedown = (e) => { e.preventDefault(); selectSymbol(s); };
      el.appendChild(d);
    }
  }
  el.classList.add('open');
  return hits;
}

// ----------------------------------------------------------------- controls
function setExchange(id) {
  state.exchange = id;
  $('ex-label').textContent = `${exName()} [${state.market.toUpperCase()}]`;
  loadSymbols(state.display);
  renderExchangeMenu();
}

function setMarket(mk) {
  state.market = mk;
  document.querySelectorAll('#market .seg-b').forEach((b) => b.classList.toggle('active', b.dataset.market === mk));
  // Coinbase is spot-only: fall back to OKX when the user switches to perps.
  if (!exOf(state.exchange)?.markets.includes(mk)) state.exchange = 'okx';
  $('ex-label').textContent = `${exName()} [${mk.toUpperCase()}]`;
  renderExchangeMenu();
  loadSymbols(state.display);
}

function setRange(r) {
  state.range = r;
  document.querySelectorAll('#range .seg-b').forEach((b) => b.classList.toggle('active', +b.dataset.range === r));
  invalidate();
  sendSubscribe(); // some venues (Hyperliquid) need a different aggregation
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $('theme').textContent = state.theme === 'dark' ? '\u2600' : '\u263D';
  invalidate();
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1600);
}

function snapshotPayload() {
  const m = state.metrics;
  if (!m) return null;
  const meta = {
    exchange: exName(), exchangeId: state.exchange, market: state.market,
    symbol: state.display, symbolRaw: state.symbol, range: state.range,
    transport: exOf(state.exchange)?.transport?.[state.market],
    tsVenue: state.book?.tsVenue ?? null,
    tsRecv: state.book?.tsRecv ?? null,
    ageMs: state.book?.tsRecv ? Date.now() - state.book.tsRecv : null,
    venueLatencyMs: state.book?.tsVenue != null ? state.book.tsRecv - state.book.tsVenue : null,
    levels: state.book?.levels, vol24h: state.vol24h,
  };
  return {
    text: panelRows(m, {
      exchangeName: exName(), market: state.market, display: state.display, vol24h: state.vol24h,
      tsVenue: state.book?.tsVenue ?? null, tsRecv: state.book?.tsRecv ?? null,
    })
      .map(([l, v]) => `${(l + ':').padEnd(14)}${v}`).join('\n'),
    json: {
      ...meta,
      mid: m.mid, bestBid: m.bestBid, bestAsk: m.bestAsk,
      spread: m.spread, spreadPct: m.spreadPct,
      bidVwap: m.bidVwap, bidVwapPct: m.bidVwapPct,
      askVwap: m.askVwap, askVwapPct: m.askVwapPct,
      bidDepth: m.bidDepth, askDepth: m.askDepth, totalDepth: m.totalDepth,
      depthPlus2: m.depthPlus2, depthMinus2: m.depthMinus2,
      depthPlus5: m.depthPlus5, depthMinus5: m.depthMinus5,
      ofi: m.ofi, ofiLabel: m.ofiLabel,
    },
  };
}

// --------------------------------------------------------------------- init
async function init() {
  applyTheme();
  state.catalog = await (await fetch('/api/catalog')).json();
  renderExchangeMenu();
  $('ex-label').textContent = `${exName()} [${state.market.toUpperCase()}]`;
  connect();
  await loadSymbols();
  requestAnimationFrame(frame);
}

/**
 * A read-only probe for `smoke-ui.mjs`, not an API.
 *
 * The crosshair readout lives entirely inside the canvas, so from outside the
 * page there is nothing to assert on: the book is streaming, every frame
 * differs from the last, and a pixel diff cannot tell a crosshair from a tick.
 * The touch path is exactly the one no developer exercises by accident, so it
 * gets the one hook that makes it testable.
 */
window.__depthvizProbe = () => ({
  hover: state.hover ? { ...state.hover } : null,
  range: state.range,
  chart: { w: canvas.clientWidth, h: canvas.clientHeight },
});

$('market').onclick = (e) => { const b = e.target.closest('.seg-b'); if (b) setMarket(b.dataset.market); };
$('range').onclick = (e) => { const b = e.target.closest('.seg-b'); if (b) setRange(+b.dataset.range); };
$('ex-btn').onclick = (e) => { e.stopPropagation(); const m = $('ex-menu'); const o = m.classList.contains('open'); closeAll(); if (!o) { renderExchangeMenu(); m.classList.add('open'); } };
$('sym-input').onfocus = () => { $('sym-input').select(); renderSymbolMenu(''); };
$('sym-input').oninput = (e) => renderSymbolMenu(e.target.value);
$('sym-input').onkeydown = (e) => {
  if (e.key === 'Enter') {
    const hits = renderSymbolMenu(e.target.value);
    if (hits.length) selectSymbol(hits[0]);
  } else if (e.key === 'Escape') { closeMenu($('sym-menu')); e.target.blur(); }
};
$('sym-input').onblur = () => setTimeout(() => { closeMenu($('sym-menu')); $('sym-input').value = state.display || ''; }, 120);
document.addEventListener('click', closeAll);

$('theme').onclick = () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('depthviz.theme', state.theme);
  applyTheme();
};

$('copy').onclick = async () => {
  const p = snapshotPayload();
  if (!p) return toast('no data yet');
  const payload = `${p.text}\n\n${JSON.stringify(p.json, null, 2)}`;
  try { await navigator.clipboard.writeText(payload); toast('copied to clipboard'); }
  catch { toast('clipboard blocked by browser'); }
};

$('png').onclick = () => {
  const a = document.createElement('a');
  a.download = `depth_${state.exchange}_${state.market}_${(state.display || '').replace('/', '-')}_${state.range}pct.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
  toast('PNG exported');
};

// The crosshair readout was mouse-only, which meant the chart carried no
// numbers at all on a phone: `mousemove` never fires for a finger, and the
// synthetic one a tap emits arrives after the tap, at the wrong place. Pointer
// events cover both devices — a mouse tracks as it moves, a finger drags the
// crosshair and drops it on release. The touch is captured so the readout keeps
// following even when the finger wanders off the canvas mid-drag.
const trackHover = (e) => {
  const r = canvas.getBoundingClientRect();
  state.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
  invalidate();
};
const clearHover = () => { if (state.hover) { state.hover = null; invalidate(); } };

let dragId = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  dragId = e.pointerId;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  trackHover(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' || e.pointerId === dragId) trackHover(e);
});
const endDrag = (e) => { if (e.pointerId === dragId) { dragId = null; clearHover(); } };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') clearHover(); });

// The book age is the one number that changes while nothing arrives, so it is
// also the one that would quietly freeze on a dead feed and keep reading "40ms"
// forever. A one-second tick makes a stalled feed visible on the panel.
setInterval(invalidate, 1000);

// A phone rotation changes the layout the chart derives its geometry from, and
// on iOS the resize event can land before the new size is readable.
window.addEventListener('resize', invalidate);
window.addEventListener('orientationchange', () => setTimeout(invalidate, 120));

init();
