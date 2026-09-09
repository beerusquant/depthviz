import { computeMetrics, fmtUsd, fmtBps, fmtPrice } from '/shared/metrics.js';
import { drawCombined, venueColor } from './chart.js';
import { createFeed } from './feed.js';
import { applyStoredTheme, applyTheme } from './theme.js';

/**
 * Combined mode: one ticker, every exchange that lists it, one price axis.
 *
 * Two things are deliberately NOT done here.
 *
 * The curves are not summed. `/api/depth/aggregate` is the sum, and it is a sum
 * only because it carries a reference band, the spread of the read instants,
 * the venues that failed and which contributions are floors. Drawing a total
 * without those would be the four-ways-wrong total that route exists to avoid.
 *
 * And the axis is absolute price, not percent-from-mid. On a percent axis every
 * venue's touch lands on the same vertical line, which quietly hides the one
 * thing this view is for: a venue quoting ten basis points away from the others
 * is a curve shifted sideways, and that is the dislocation somebody opened this
 * page to find.
 *
 * The route is used for one thing: resolving which symbol each venue lists for
 * this asset. That resolution is reported per venue rather than guessed, and it
 * is shown on screen — `BTC` is `BTCUSDT` on Binance, `BTC-USDT-SWAP` on OKX
 * and `BTC` on Hyperliquid, and a viewer comparing them should see that.
 */

const $ = (id) => document.getElementById(id);

const state = {
  market: 'spot',
  base: 'BTC',
  range: 2,
  theme: applyStoredTheme(),
  rows: [],            // { exchange, symbol, quote, label, color, feed, book, metrics, status }
  status: 'connecting',
  statusDetail: '',
  dirty: true,
  resolveGen: 0,
};

const invalidate = () => { state.dirty = true; };

// ------------------------------------------------------------------ status
function setStatus(s, detail = '') {
  state.status = s;
  state.statusDetail = detail;
  const el = $('live');
  el.classList.remove('live-on', 'live-wait', 'live-err');
  const map = {
    live: ['live-on', 'LIVE', ''],
    connecting: ['live-wait', 'CONNECTING', ''],
    idle: ['live-wait', 'IDLE', ''],
    error: ['live-err', 'ERROR', detail.slice(0, 44)],
    offline: ['live-err', 'OFFLINE', 'server unreachable'],
  };
  const [cls, b, sub] = map[s] || ['live-wait', String(s).toUpperCase(), detail];
  el.classList.add(cls);
  $('live-b').textContent = b;
  $('live-s').textContent = sub ? ` ${sub}` : '';
  invalidate();
}

// ----------------------------------------------------------------- feeds
function dropFeeds() {
  for (const r of state.rows) { try { r.feed?.close(); } catch { /* already gone */ } }
  state.rows = [];
}

/**
 * Ask the aggregate route which venue lists this asset under which symbol, then
 * hold one live feed per venue.
 *
 * One REST call rather than one instrument listing per exchange: those are up
 * to a megabyte each on a cache miss, and the resolution rule already lives on
 * the server where it can report what it chose.
 */
async function reload() {
  const gen = ++state.resolveGen;
  dropFeeds();
  $('resolved').textContent = 'RESOLVING…';
  setStatus('connecting');
  invalidate();

  let j;
  try {
    const url = `/api/depth/aggregate?market=${encodeURIComponent(state.market)}`
      + `&base=${encodeURIComponent(state.base)}&range=${state.range}`;
    const r = await fetch(url);
    j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  } catch (e) {
    if (gen !== state.resolveGen) return;   // superseded
    $('resolved').textContent = 'NO MATCH';
    setStatus('error', e.message);
    return;
  }
  if (gen !== state.resolveGen) return;

  const venues = j.venues || [];
  if (!venues.length) {
    $('resolved').textContent = 'NO MATCH';
    setStatus('error', `no venue lists ${state.base} on ${state.market}`);
    return;
  }

  // Sorted by exchange id so a venue keeps its colour between reloads: a curve
  // that changes colour when another one drops out is unreadable.
  venues.sort((a, b) => a.exchange.localeCompare(b.exchange));
  state.rows = venues.map((v, i) => ({
    exchange: v.exchange,
    symbol: v.symbol,
    quote: v.quote,
    label: `${v.exchange.toUpperCase()} ${v.symbol}`,
    color: venueColor(i),
    book: null,
    metrics: null,
    status: 'connecting',
    feed: null,
  }));

  // The venues that could not answer are stated, not dropped silently.
  const miss = (j.missing || []).filter((m) => m.reason);
  $('resolved').textContent = `${venues.length} VENUE${venues.length > 1 ? 'S' : ''}`
    + (miss.length ? ` · ${miss.length} UNAVAILABLE` : '');
  $('note').textContent = miss.length
    ? `not shown: ${miss.map((m) => `${m.exchange} (${m.reason})`).join(' · ')}`
    : '';
  $('note').classList.toggle('hidden', !miss.length);

  for (const row of state.rows) {
    row.feed = createFeed({
      onBook: (b) => {
        row.book = b;
        row.metrics = computeMetrics(b, state.range);
        row.status = 'live';
        if (state.status !== 'live') setStatus('live');
        invalidate();
      },
      onStatus: (st, detail) => {
        row.status = st;
        // A venue dropping out must not make the page claim it is offline: the
        // others are still streaming. It shows in that venue's own row.
        if (st === 'offline' || st === 'error') { row.detail = detail; invalidate(); }
      },
    });
    row.feed.subscribe({
      exchange: row.exchange, market: state.market, symbol: row.symbol, range: state.range,
    });
  }
  invalidate();
}

// ---------------------------------------------------------------- rendering
function renderRows() {
  const host = $('rows');
  host.replaceChildren();
  const live = state.rows.filter((r) => r.metrics);
  const total = live.reduce((s, r) => s + r.metrics.totalDepth, 0);

  for (const r of state.rows) {
    const el = document.createElement('div');
    el.className = 'vrow';
    const swatch = document.createElement('i');
    swatch.className = 'vswatch';
    swatch.style.background = r.color;
    const name = document.createElement('span');
    name.className = 'vname';
    // textContent, never markup: the symbol came from an exchange listing.
    name.textContent = r.label;

    const cells = document.createElement('span');
    cells.className = 'vcells';
    if (r.metrics) {
      const m = r.metrics;
      const floor = m.lowerBound?.totalDepth ? '≥ ' : '';
      const age = r.book?.tsRecv ? Date.now() - r.book.tsRecv : null;
      for (const [label, value, cls] of [
        ['mid', fmtPrice(m.mid), ''],
        ['spread', fmtBps(m.spreadPct), ''],
        [`depth ±${+state.range.toFixed(3)}%`, `${floor}${fmtUsd(m.totalDepth)}`, ''],
        ['share', total > 0 ? `${((m.totalDepth / total) * 100).toFixed(1)}%` : '—', ''],
        // The age is the measurement that cannot lie: a venue whose book has
        // stopped arriving still reads `live` between drops.
        ['age', age == null ? '—' : age < 1000 ? `${age}ms` : `${(age / 1000).toFixed(1)}s`,
          age != null && age > 5000 ? 'stale' : ''],
      ]) {
        const c = document.createElement('span');
        c.className = `vcell${cls ? ` ${cls}` : ''}`;
        c.textContent = `${label} ${value}`;
        cells.appendChild(c);
      }
    } else {
      const c = document.createElement('span');
      c.className = 'vcell dim';
      c.textContent = r.detail ? `${r.status} — ${r.detail}` : r.status;
      cells.appendChild(c);
    }
    el.append(swatch, name, cells);
    host.appendChild(el);
  }
}

function frame() {
  if (state.dirty) {
    state.dirty = false;
    drawCombined($('chart'), {
      range: state.range,
      theme: state.theme,
      rows: state.rows,
      statusText: state.statusDetail || state.status,
    });
    renderRows();
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ export
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1600);
}

function payload() {
  const now = Date.now();
  const live = state.rows.filter((r) => r.metrics);
  if (!live.length) return null;
  return {
    mode: 'combined', market: state.market, base: state.base, range: state.range,
    venues: live.map((r) => ({
      exchange: r.exchange, symbol: r.symbol, quote: r.quote,
      mid: r.metrics.mid, spreadPct: r.metrics.spreadPct,
      bidDepth: r.metrics.bidDepth, askDepth: r.metrics.askDepth,
      totalDepth: r.metrics.totalDepth,
      // Without this a pasted total is a number nobody can qualify.
      lowerBound: r.metrics.lowerBound,
      reach: { bid: r.metrics.bid.reach, ask: r.metrics.ask.reach },
      tsVenue: r.book.tsVenue, tsRecv: r.book.tsRecv, ageMs: now - r.book.tsRecv,
    })),
    // These curves are not summed on screen and the export does not sum them
    // either: a total needs the reference band and the caveats that come with
    // it, which is what /api/depth/aggregate is for.
    note: 'per-venue readings, not a sum — see GET /api/depth/aggregate for a total',
  };
}

// ------------------------------------------------------------------- wiring
$('market').onclick = (e) => {
  const b = e.target.closest('.seg-b');
  if (!b) return;
  state.market = b.dataset.market;
  document.querySelectorAll('#market .seg-b').forEach((x) => x.classList.toggle('active', x.dataset.market === state.market));
  reload();
};
$('range').onclick = (e) => {
  const b = e.target.closest('.seg-b');
  if (!b) return;
  state.range = +b.dataset.range;
  document.querySelectorAll('#range .seg-b').forEach((x) => x.classList.toggle('active', +x.dataset.range === state.range));
  // The range changes what each feed is asked for (Hyperliquid aggregates
  // differently per range), so it is a resubscribe, not a redraw.
  for (const r of state.rows) {
    r.feed?.subscribe({ exchange: r.exchange, market: state.market, symbol: r.symbol, range: state.range });
    if (r.book) r.metrics = computeMetrics(r.book, state.range);
  }
  invalidate();
};
let baseTimer = null;
$('base-input').oninput = (e) => {
  const v = e.target.value.trim().toUpperCase();
  clearTimeout(baseTimer);
  // Debounced: every keystroke would otherwise resolve and open eight feeds.
  baseTimer = setTimeout(() => { if (v) { state.base = v; reload(); } }, 350);
};
$('theme').onclick = () => {
  state.theme = applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  invalidate();
};
$('copy').onclick = async () => {
  const p = payload();
  if (!p) return toast('no data yet');
  try { await navigator.clipboard.writeText(JSON.stringify(p, null, 2)); toast('copied to clipboard'); }
  catch { toast('clipboard blocked by browser'); }
};

// The age of a book is the one number that moves while nothing arrives.
setInterval(invalidate, 1000);
window.addEventListener('resize', invalidate);
window.addEventListener('orientationchange', () => setTimeout(invalidate, 120));

/** Read-only probe for smoke-ui.mjs, not an API. */
window.__depthvizProbe = () => ({
  mode: 'combined',
  base: state.base,
  market: state.market,
  range: state.range,
  venues: state.rows.map((r) => ({ exchange: r.exchange, symbol: r.symbol, live: !!r.metrics })),
});

reload();
requestAnimationFrame(frame);
