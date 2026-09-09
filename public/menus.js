import { $, state } from './state.js';

/**
 * The two dropdowns, and the ranking that makes the symbol one usable.
 *
 * Both take what to do on a pick as an argument rather than importing it, which
 * is what keeps this module a leaf: app.js depends on menus.js, never the other
 * way round, so there is no cycle to reason about.
 */

export function closeMenu(el) { el.classList.remove('open'); }
export function closeAllMenus() { document.querySelectorAll('.menu').forEach(closeMenu); }

/**
 * A menu row: a label and a dim raw value, both written as TEXT.
 *
 * Symbol names are chosen by whoever lists the token, not by us — 27 of the
 * 10 250 pairs served today already carry names outside plain ASCII
 * (`币安人生/USDT`, `GOLD(PAXG)/USDC`). Interpolating those into markup makes
 * the listing form a script tag away from running in the viewer's page, so
 * nothing from an exchange is ever parsed as HTML here. CI greps for innerHTML
 * in this directory for the same reason.
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

export function renderExchangeMenu(onPick) {
  const el = $('ex-menu');
  el.replaceChildren();
  for (const c of state.catalog) {
    const ok = c.markets.includes(state.market);
    const d = menuRow(c.name, c.markets.map((m) => c.transport[m]).join('/'));
    d.className = `menu-i${ok ? '' : ' disabled'}${c.id === state.exchange ? ' sel' : ''}`;
    if (ok) d.onclick = () => { onPick(c.id); closeMenu(el); };
    el.appendChild(d);
  }
}

const QUOTE_RANK = { USDT: 0, USD: 1, USDC: 2, USDE: 3, EUR: 6 };

/** Rank matches so typing "RAY" lands on RAY/USDT, not RAY/TRY. */
export function scoreSymbol(s, needle) {
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

// Some venues list ten thousand pairs; the menu shows the best of them and the
// search is what reaches the rest.
const MAX_ROWS = 400;

/** Render the symbol menu for query `q`, and return the rows it is showing. */
export function renderSymbolMenu(q = '', onPick) {
  const el = $('sym-menu');
  const needle = q.trim().toUpperCase();
  let hits;
  if (!needle) {
    hits = state.symbols.slice(0, MAX_ROWS);
  } else {
    const scored = [];
    for (const s of state.symbols) {
      const sc = scoreSymbol(s, needle);
      if (sc !== null) scored.push([sc, s]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].d.localeCompare(b[1].d));
    hits = scored.slice(0, MAX_ROWS).map((x) => x[1]);
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
      // mousedown, not click: the input's blur handler closes this menu, and a
      // click would fire after the row it was aimed at is already gone.
      d.onmousedown = (e) => { e.preventDefault(); onPick(s); };
      el.appendChild(d);
    }
  }
  el.classList.add('open');
  return hits;
}
