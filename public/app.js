import { computeMetrics, panelRows } from '/shared/metrics.js';
import { draw } from './chart.js';
import { $, state, invalidate, exOf, exName } from './state.js';
import { connect, subscribe } from './feed.js';
import { closeMenu, closeAllMenus, renderExchangeMenu, renderSymbolMenu } from './menus.js';

/**
 * The page: what it draws, what its controls do, and how it is wired up.
 *
 * The three things this file does NOT do are the reason the rest of it is
 * readable — `state.js` holds the facts, `feed.js` owns the socket and its
 * reconnects, `menus.js` renders the two dropdowns. The import graph is a tree:
 * app depends on all three, they depend only on state, so there is no cycle to
 * reason about and no module that has to be loaded in a particular order.
 */

const canvas = $('chart');

// ---------------------------------------------------------------- rendering

// The chart is redrawn for reasons that do not change a single number: a
// crosshair moving under the finger, the once-a-second tick that keeps the book
// age honest, a window resize. Recomputing the whole book on those is pure
// waste, so the metrics are keyed on the only two things they depend on.
let metricsKey = null;

/** Everything the chart and the panel need that is not the book itself. */
function meta(now = Date.now()) {
  return {
    exchangeName: exName(),
    market: state.market,
    display: state.display || state.symbol || '—',
    quote: state.quote,
    vol24h: state.vol24h,
    volTs: state.volTs,
    tsVenue: state.book?.tsVenue ?? null,
    tsRecv: state.book?.tsRecv ?? null,
    now,
  };
}

function frame() {
  if (state.dirty) {
    state.dirty = false;
    const key = `${state.bookSeq}:${state.range}`;
    if (key !== metricsKey) {
      metricsKey = key;
      state.metrics = state.book ? computeMetrics(state.book, state.range) : null;
    }
    renderLive();
    draw(canvas, {
      range: state.range,
      metrics: state.metrics,
      theme: state.theme,
      hover: state.hover,
      statusText: state.statusDetail || state.status,
      meta: meta(),
    });
    renderNote();
  }
  requestAnimationFrame(frame);
}

/**
 * The badge's second line is the age of the book it is calling LIVE.
 *
 * It used to read the constant word "STREAMING", which is a claim about the
 * transport, not about the data — a feed whose venue has gone quiet keeps that
 * word forever. The age is the one number that moves when nothing arrives, and
 * it belongs in the widget people actually look at rather than only at the
 * bottom of a sixteen-row panel. It is deliberately not colour-coded: on an
 * illiquid book a two-minute-old top of book is correct, and a badge that cried
 * wolf there would be ignored on the day it mattered.
 */
function renderLive() {
  if (state.status !== 'live') return;
  const t = state.book?.tsRecv;
  const age = t ? Math.max(0, Date.now() - t) : null;
  $('live-s').textContent = age == null ? ''
    : age < 1000 ? ` ${age}ms` : ` ${(age / 1000).toFixed(age < 60_000 ? 1 : 0)}s`;
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
    const a = state.book.accum;
    const secs = Math.round((Date.now() - a.since) / 1000);
    if (secs < 60) bits.push(`depth beyond ±0.6% is still filling in — ${secs}s of updates so far, so it can only grow`);
    else {
      // Past that the book has stopped being obviously young, and the question
      // changes from "is it filled in yet" to "how much of it is corroborated".
      // Only worth saying when it is a large share: a fifth of a book resting
      // untouched for two minutes is an ordinary book, not a warning.
      const f = a.staleFrac && Math.max(a.staleFrac.bid ?? 0, a.staleFrac.ask ?? 0);
      if (f >= 0.5) {
        bits.push(`${Math.round(f * 100)}% of the depth within ±${a.bandPct}% has not been re-confirmed in ${Math.round(a.cutoffMs / 1000)}s — accumulated, not read`);
      }
    }
  }
  const el = $('note');
  el.textContent = bits.join(' · ');
  el.classList.toggle('hidden', bits.length === 0);
}

/** How a connection state is shown. Passed to feed.js, which owns the socket. */
function setStatus(s, detail = '') {
  state.status = s;
  state.statusDetail = detail;
  const el = $('live');
  el.classList.remove('live-on', 'live-wait', 'live-err');
  const map = {
    live: ['live-on', 'LIVE', ''],
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

// -------------------------------------------------------------- symbol list
function pickDefault(list) {
  return list.find((s) => s.base === 'BTC' && s.quote === 'USDT')
    || list.find((s) => s.base === 'BTC')
    || list[0];
}

// Which listing request is the current one. Two clicks between venues put two
// of these in flight, and the one that answers second wins — which is not the
// same as the one that was asked for last. The visible result is a pair list
// from one exchange sitting under another's name, so the next symbol picked
// does not exist on the venue it is sent to. A slow venue is enough on its own.
let listGen = 0;

async function loadSymbols(keepSymbol = null) {
  const gen = ++listGen;
  const { exchange, market } = state;
  $('pairs').textContent = 'LOADING…';
  state.symbols = [];
  let j;
  try {
    const r = await fetch(`/api/symbols?exchange=${exchange}&market=${market}`);
    j = await r.json();
    if (j.error) throw new Error(j.error);
  } catch (e) {
    if (gen !== listGen) return;   // superseded: not this request's error to report
    $('pairs').textContent = 'LIST FAILED';
    setStatus('error', e.message);
    return;
  }
  if (gen !== listGen) return;     // a later request owns the screen now
  // The guard above IS the atomicity the rule is asking for; it cannot see a
  // generation token, only the await before the assignment.
  // eslint-disable-next-line require-atomic-updates
  state.symbols = j.symbols;
  $('pairs').textContent = `${j.count.toLocaleString('en-US')} PAIRS`;
  const found = keepSymbol && state.symbols.find((s) => s.d === keepSymbol);
  selectSymbol(found || pickDefault(state.symbols));
}

function selectSymbol(s) {
  if (!s) return;
  state.symbol = s.s;
  state.display = s.d;
  state.quote = s.quote || 'USD';
  state.book = null;
  state.bookSeq++;
  state.vol24h = null;
  state.volTs = null;
  $('sym-input').value = s.d;
  closeMenu($('sym-menu'));
  invalidate();
  subscribe();
}

// ----------------------------------------------------------------- controls
function setExchange(id) {
  state.exchange = id;
  $('ex-label').textContent = `${exName()} [${state.market.toUpperCase()}]`;
  loadSymbols(state.display);
  renderExchangeMenu(setExchange);
}

function setMarket(mk) {
  state.market = mk;
  document.querySelectorAll('#market .seg-b').forEach((b) => b.classList.toggle('active', b.dataset.market === mk));
  // Coinbase is spot-only: fall back to OKX when the user switches to perps.
  if (!exOf(state.exchange)?.markets.includes(mk)) state.exchange = 'okx';
  $('ex-label').textContent = `${exName()} [${mk.toUpperCase()}]`;
  renderExchangeMenu(setExchange);
  loadSymbols(state.display);
}

function setRange(r) {
  state.range = r;
  document.querySelectorAll('#range .seg-b').forEach((b) => b.classList.toggle('active', +b.dataset.range === r));
  invalidate();
  subscribe(); // some venues (Hyperliquid) need a different aggregation
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $('theme').textContent = state.theme === 'dark' ? '☀' : '☽';
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
  const now = Date.now();
  return {
    text: panelRows(m, meta(now)).map(([l, v]) => `${(l + ':').padEnd(18)}${v}`).join('\n'),
    json: {
      exchange: exName(), exchangeId: state.exchange, market: state.market,
      symbol: state.display, symbolRaw: state.symbol, range: state.range,
      transport: exOf(state.exchange)?.transport?.[state.market],
      tsVenue: state.book?.tsVenue ?? null,
      tsRecv: state.book?.tsRecv ?? null,
      ageMs: state.book?.tsRecv ? now - state.book.tsRecv : null,
      venueLatencyMs: state.book?.tsVenue != null ? state.book.tsRecv - state.book.tsVenue : null,
      levels: state.book?.levels,
      vol24h: state.vol24h,
      // A pasted figure travels without the screen it came from, so the one
      // thing that says whether the volume is still moving travels with it.
      vol24hAgeMs: state.volTs != null ? now - state.volTs : null,
      mid: m.mid, bestBid: m.bestBid, bestAsk: m.bestAsk,
      spread: m.spread, spreadPct: m.spreadPct,
      bidVwap: m.bidVwap, bidVwapPct: m.bidVwapPct,
      askVwap: m.askVwap, askVwapPct: m.askVwapPct,
      bidDepth: m.bidDepth, askDepth: m.askDepth, totalDepth: m.totalDepth,
      depthPlus2: m.depthPlus2, depthMinus2: m.depthMinus2,
      depthPlus5: m.depthPlus5, depthMinus5: m.depthMinus5,
      // Which of those depth figures are FLOORS rather than measurements,
      // because the book ends before the distance they are quoted at. A number
      // pasted without this has lost the only thing that qualifies it.
      lowerBound: m.lowerBound,
      reach: { bid: m.bid.reach, ask: m.ask.reach },
      imbalance: m.imbalance, imbalanceLabel: m.imbalanceLabel,
    },
  };
}

// --------------------------------------------------------------------- init
async function init() {
  applyTheme();
  state.catalog = await (await fetch('/api/catalog')).json();
  renderExchangeMenu(setExchange);
  $('ex-label').textContent = `${exName()} [${state.market.toUpperCase()}]`;
  connect(setStatus);
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

// ------------------------------------------------------------------- wiring
$('market').onclick = (e) => { const b = e.target.closest('.seg-b'); if (b) setMarket(b.dataset.market); };
$('range').onclick = (e) => { const b = e.target.closest('.seg-b'); if (b) setRange(+b.dataset.range); };
$('ex-btn').onclick = (e) => {
  e.stopPropagation();
  const m = $('ex-menu');
  const wasOpen = m.classList.contains('open');
  closeAllMenus();
  if (!wasOpen) { renderExchangeMenu(setExchange); m.classList.add('open'); }
};
$('sym-input').onfocus = () => { $('sym-input').select(); renderSymbolMenu('', selectSymbol); };
$('sym-input').oninput = (e) => renderSymbolMenu(e.target.value, selectSymbol);
$('sym-input').onkeydown = (e) => {
  if (e.key === 'Enter') {
    const hits = renderSymbolMenu(e.target.value, selectSymbol);
    if (hits.length) selectSymbol(hits[0]);
  } else if (e.key === 'Escape') { closeMenu($('sym-menu')); e.target.blur(); }
};
// Deferred, because a pick is a mousedown on a row this would otherwise remove
// before the pick has been processed.
$('sym-input').onblur = () => setTimeout(() => { closeMenu($('sym-menu')); $('sym-input').value = state.display || ''; }, 120);
document.addEventListener('click', closeAllMenus);

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
  try { canvas.setPointerCapture(e.pointerId); } catch { /* capture is a nicety, not a requirement */ }
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
