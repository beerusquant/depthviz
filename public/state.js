/**
 * What the page knows, and the one way anything asks to be redrawn.
 *
 * The bottom of the front end's import graph: this module imports nothing, so
 * `feed.js` and `menus.js` can both depend on it without depending on each
 * other. It holds no DOM and no transport — only the facts the rest of the page
 * reads, which is what keeps a redraw from having to know where a book came
 * from.
 */

export const $ = (id) => document.getElementById(id);

export const state = {
  catalog: [],
  exchange: 'binance',
  market: 'spot',
  symbol: null,
  display: null,
  quote: 'USD',
  range: 2,
  symbols: [],
  book: null,
  // Bumped on every book, and on every symbol change that invalidates the last
  // one. It is what the metrics are memoized on, so it has to move whenever the
  // numbers could.
  bookSeq: 0,
  vol24h: null,
  // When that volume was last actually read upstream, not when it was last
  // asked for: the server swallows a failed refresh to protect the feed, so
  // this is the only thing that says the figure has stopped moving.
  volTs: null,
  metrics: null,
  status: 'connecting',
  statusDetail: '',
  // Shared across all four pages; see theme.js.
  theme: (() => { try { return localStorage.getItem('depthviz.theme') || 'dark'; } catch { return 'dark'; } })(),
  hover: null,
  dirty: true,
};

/**
 * Ask for a redraw on the next frame.
 *
 * Everything that changes anything calls this and nothing draws directly: a
 * crosshair moving under a finger, a book arriving, the once-a-second tick that
 * keeps the age honest and a window resize all coalesce into one paint.
 */
export function invalidate() { state.dirty = true; }

export const exOf = (id) => state.catalog.find((c) => c.id === id);
export const exName = () => exOf(state.exchange)?.name || state.exchange;
