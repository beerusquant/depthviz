/**
 * Ranking the instrument search, in one place and with no DOM.
 *
 * Typing "BTC" has one obvious intended answer and the listings do not give it:
 * Binance spot alone lists BTC against fourteen quote currencies — ARS, BRL,
 * EUR, FDUSD, IDR, JPY, MXN, TRY, U, USD, USD1, USDC, USDS, USDT — and compare
 * mode had no ranking at all, so "BTC" returned AAVE/BTC and ADA/BTC first,
 * pairs where BTC is the QUOTE. What somebody typing a ticker wants is that
 * ticker priced in dollars.
 *
 * Two rules, in that order:
 *
 *  1. WHERE it matched. An exact base beats a prefix beats a substring, and
 *     anything matching the base beats a pair that merely contains the letters
 *     somewhere — which is what put six xxx/BTC rows above BTC/USDT.
 *  2. WHAT it is priced in. Dollars first, and the family is recognised rather
 *     than enumerated: `USDT`, `USDC`, `FDUSD`, `USDS`, `USD1`, `PYUSD`, `TUSD`
 *     and whatever ships next all carry `USD`. A hand-written list is a list
 *     that goes stale the week a venue adds a stablecoin.
 *
 * Nothing is REMOVED. A quote nobody asked for still sorts last, but an
 * instrument that only trades against KRW or EUR has to stay findable — the
 * same reasoning as `okSymbol` in server/util.js: refusing to show a real
 * instrument is a worse bug than showing it low in a list.
 *
 * No DOM and no state here, which is what lets tools/test-search.mjs pin it.
 */

/** Where the query matched. Lower is better; 100 apart so quotes never cross it. */
const WHERE = { baseExact: 0, basePrefix: 100, displayPrefix: 200, displayHas: 300, rawHas: 400 };

/** The three dollars people mean, then every other dollar, then everything else. */
const PREFERRED = ['USDT', 'USD', 'USDC'];
const OTHER_USD = 30;
const NOT_USD = 60;

/** Is this quote a dollar? Recognised by shape, so a new stablecoin needs no edit. */
export function isUsdQuote(quote) {
  const q = (quote || '').toUpperCase();
  return q.includes('USD') || q === 'DAI';
}

export function quoteRank(quote) {
  const q = (quote || '').toUpperCase();
  const i = PREFERRED.indexOf(q);
  if (i >= 0) return i;
  return isUsdQuote(q) ? OTHER_USD : NOT_USD;
}

/**
 * Score one instrument against an upper-cased needle, or null if it does not
 * match at all. Lower is better.
 */
export function scoreSymbol(s, needle) {
  const base = (s.base || '').toUpperCase();
  const display = (s.d || '').toUpperCase();
  const raw = (s.s || '').toUpperCase();
  let where;
  if (base === needle) where = WHERE.baseExact;
  else if (base.startsWith(needle)) where = WHERE.basePrefix;
  else if (display.startsWith(needle)) where = WHERE.displayPrefix;
  else if (display.includes(needle)) where = WHERE.displayHas;
  else if (raw.includes(needle)) where = WHERE.rawHas;
  else return null;
  return where + quoteRank(s.quote);
}

/**
 * The matches for `query`, best first, capped at `limit`.
 *
 * An empty query is not a search: it is the menu opening, so the listing is
 * shown in the order the venue gave it rather than reordered around a needle
 * that does not exist.
 */
export function rankSymbols(symbols, query, limit = 400) {
  const needle = String(query || '').trim().toUpperCase();
  if (!needle) return symbols.slice(0, limit);
  const scored = [];
  for (const s of symbols) {
    const sc = scoreSymbol(s, needle);
    if (sc !== null) scored.push([sc, s]);
  }
  // Ties broken by display name so the order is stable between renders: a list
  // that reshuffles under the cursor is a list you cannot click.
  scored.sort((a, b) => a[0] - b[0] || a[1].d.localeCompare(b[1].d));
  return scored.slice(0, limit).map((x) => x[1]);
}
