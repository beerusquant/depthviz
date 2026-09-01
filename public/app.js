import { computeMetrics, panelRows } from './metrics.js';
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
      },
    });
    renderNote();
  }
  requestAnimationFrame(frame);
}

function renderNote() {
  const bits = [];
  const n = exOf(state.exchange)?.notes?.[state.market];
  if (n) bits.push(n);
  if (state.exchange === 'bitunix' && state.market === 'spot' && state.range > 0.5) {
    bits.push(`±${state.range}% is far beyond what Bitunix spot publishes — read the depth numbers as "everything the exchange will show", not as depth to ±${state.range}%`);
  }
  // Venues maintained by snapshot + diff only reach past the snapshot's own
  // span by accumulating updates, so their far depth is a lower bound that
  // grows with uptime rather than a settled figure. Say so while it is young.
  const acc = state.book?.accum;
  if (acc?.since && state.range > 0.6) {
    const secs = Math.max(0, Math.round((Date.now() - acc.since) / 1000));
    if (secs < 180) {
      bits.push(`depth beyond ±0.6% is still converging — built from ${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`} of updates, so it can only grow`);
    }
  }
  const m = state.metrics;
  if (m && (m.shortBid || m.shortAsk)) {
    bits.push(`book stops before ±${state.range}% on ${m.shortBid && m.shortAsk ? 'both sides' : m.shortBid ? 'the bid side' : 'the ask side'} — the curve ends where the exchange's data ends`);
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
      state.book = { bids: m.bids, asks: m.asks, ts: m.ts, source: m.source, levels: m.levels, accum: m.accum };
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

function renderExchangeMenu() {
  const el = $('ex-menu');
  el.innerHTML = '';
  for (const c of state.catalog) {
    const ok = c.markets.includes(state.market);
    const d = document.createElement('div');
    d.className = `menu-i${ok ? '' : ' disabled'}${c.id === state.exchange ? ' sel' : ''}`;
    d.innerHTML = `<span>${c.name}</span><span class="raw">${c.markets.map((m) => c.transport[m]).join('/')}</span>`;
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
  el.innerHTML = '';
  if (!hits.length) {
    el.innerHTML = '<div class="menu-empty">no match</div>';
  } else {
    for (const s of hits) {
      const d = document.createElement('div');
      d.className = `menu-i${s.s === state.symbol ? ' sel' : ''}`;
      d.innerHTML = `<span>${s.d}</span><span class="raw">${s.s}</span>`;
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
  $('theme').innerHTML = state.theme === 'dark' ? '&#9728;' : '&#9789;';
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
    bookTs: state.book?.ts, levels: state.book?.levels, vol24h: state.vol24h,
  };
  return {
    text: panelRows(m, { exchangeName: exName(), market: state.market, display: state.display, vol24h: state.vol24h })
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

$('back').onclick = () => toast('back — no parent view in this build');

canvas.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect();
  state.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
  invalidate();
});
canvas.addEventListener('mouseleave', () => { state.hover = null; invalidate(); });
window.addEventListener('resize', invalidate);

init();
