/**
 * Deterministic tests for the instrument search ranking. No network, no DOM.
 *
 *   node tools/test-search.mjs
 *
 * Why it exists: typing a ticker has one obvious intended answer and neither
 * mode gave it. Measured on Binance spot, which lists BTC against fourteen
 * quote currencies:
 *
 *   compare mode, "BTC"  ->  AAVE/BTC ADA/BTC ARB/BTC ATOM/BTC AVAX/BTC …
 *   single mode,  "BTC"  ->  BTC/USDT BTC/USD BTC/USDC BTC/ARS BTC/BRL BTC/IDR …
 *
 * Compare had no ranking at all, so it returned the pairs where BTC is the
 * QUOTE first. Single ranked three dollars and then treated FDUSD, USDS and
 * USD1 — all dollars — as noise behind Argentine pesos.
 */
import { rankSymbols, scoreSymbol, quoteRank, isUsdQuote } from '../public/search.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};

const sym = (base, quote) => ({ s: `${base}${quote}`, d: `${base}/${quote}`, base, quote });

// Binance spot's real BTC quote list on 2026-09-09, plus the pairs where BTC is
// the quote — which is what compare mode was returning first.
const BINANCE_BTC = [
  'ARS', 'BRL', 'EUR', 'FDUSD', 'IDR', 'JPY', 'MXN', 'TRY', 'U', 'USD', 'USD1', 'USDC', 'USDS', 'USDT',
].map((q) => sym('BTC', q));
const QUOTED_IN_BTC = ['AAVE', 'ADA', 'ARB', 'ATOM', 'AVAX', 'BCH', 'BNB'].map((b) => sym(b, 'BTC'));
const LISTING = [...QUOTED_IN_BTC, ...BINANCE_BTC].sort((a, b) => a.d.localeCompare(b.d));

console.log('quoteRank — dollars first, recognised by shape');
{
  ok('USDT, USD and USDC are the three people mean, in that order',
     quoteRank('USDT') < quoteRank('USD') && quoteRank('USD') < quoteRank('USDC'));
  // A hand-written list is a list that goes stale the week a venue adds one.
  for (const q of ['FDUSD', 'USDS', 'USD1', 'PYUSD', 'TUSD', 'BUSD', 'USDE', 'USDP']) {
    ok(`${q} is recognised as a dollar without being enumerated`, isUsdQuote(q));
  }
  ok('and it ranks ahead of anything that is not', quoteRank('FDUSD') < quoteRank('TRY'));
  for (const q of ['TRY', 'ARS', 'BRL', 'IDR', 'JPY', 'MXN', 'EUR', 'KRW', 'BTC', 'U']) {
    ok(`${q} is not a dollar`, !isUsdQuote(q));
  }
  ok('every non-dollar shares one rank, so they sort by name between themselves',
     quoteRank('TRY') === quoteRank('KRW') && quoteRank('TRY') === quoteRank('EUR'));
}

console.log('\nrankSymbols — what typing BTC has to return');
{
  const hits = rankSymbols(LISTING, 'BTC');
  const top3 = hits.slice(0, 3).map((s) => s.d);
  ok('the first three are the dollars', JSON.stringify(top3) === '["BTC/USDT","BTC/USD","BTC/USDC"]',
     JSON.stringify(top3));

  // The regression that prompted this: BTC is the QUOTE in these, and compare
  // mode put all seven of them first.
  const firstQuotedInBtc = hits.findIndex((s) => s.quote === 'BTC');
  const lastBasedOnBtc = hits.map((s) => s.base).lastIndexOf('BTC');
  ok('every BTC/x pair comes before every x/BTC pair', firstQuotedInBtc > lastBasedOnBtc,
     `first x/BTC at ${firstQuotedInBtc}, last BTC/x at ${lastBasedOnBtc}`);

  // Dollars that are not the famous three still beat pesos.
  const at = (d) => hits.findIndex((s) => s.d === d);
  ok('FDUSD, USDS and USD1 rank above ARS, BRL and IDR',
     Math.max(at('BTC/FDUSD'), at('BTC/USDS'), at('BTC/USD1'))
     < Math.min(at('BTC/ARS'), at('BTC/BRL'), at('BTC/IDR')),
     hits.slice(0, 10).map((s) => s.d).join(' '));

  // Nothing is removed: an instrument that only trades against a local currency
  // has to stay findable, or the search has decided for the viewer.
  ok('the quotes nobody asked for are still there, just last',
     ['BTC/TRY', 'BTC/ARS', 'BTC/JPY', 'BTC/EUR'].every((d) => at(d) >= 0),
     hits.map((s) => s.d).join(' '));
  ok('and so are the pairs where BTC is the quote', at('AAVE/BTC') >= 0);
  ok('nothing is lost overall', hits.length === LISTING.length, `${hits.length} of ${LISTING.length}`);
}

console.log('\nrankSymbols — the other queries people type');
{
  // The case the old comment in menus.js named: RAY/USDT, not RAY/TRY.
  const listing = [sym('RAY', 'TRY'), sym('RAY', 'USDT'), sym('RAYDIUM', 'USDT'), sym('XRAY', 'USDT')];
  const hits = rankSymbols(listing, 'RAY').map((s) => s.d);
  ok('an exact base beats a longer one that starts the same',
     hits[0] === 'RAY/USDT' && hits[1] === 'RAY/TRY', JSON.stringify(hits));
  ok('and a prefix beats a substring elsewhere',
     hits.indexOf('RAYDIUM/USDT') < hits.indexOf('XRAY/USDT'), JSON.stringify(hits));

  // Lowercase, and the raw venue symbol rather than the display name: Bitunix
  // lists its spot pairs lowercase.
  const bit = [{ s: 'btcusdt', d: 'BTC/USDT', base: 'BTC', quote: 'USDT' }];
  ok('the search is case-insensitive', rankSymbols(bit, 'btc').length === 1);
  ok('and it matches the raw venue symbol too',
     rankSymbols([{ s: 'BTC-USDT-SWAP', d: 'BTC/USDT', base: 'BTC', quote: 'USDT' }], 'SWAP').length === 1);

  // An empty query is the menu opening, not a search: the listing order stands.
  const empty = rankSymbols(LISTING, '');
  ok('an empty query does not reorder the listing',
     empty[0].d === LISTING[0].d && empty.length === LISTING.length);
  ok('a query nothing matches returns nothing, not everything',
     rankSymbols(LISTING, 'ZZZZ').length === 0);
  ok('the limit is honoured', rankSymbols(LISTING, 'BTC', 3).length === 3);
}

console.log('\nscoreSymbol — the pieces');
{
  ok('a non-match is null, not a large number', scoreSymbol(sym('ETH', 'USDT'), 'BTC') === null);
  ok('an exact base with the best quote is the floor', scoreSymbol(sym('BTC', 'USDT'), 'BTC') === 0);
  // Where it matched outranks what it is priced in, always: no quote is good
  // enough to lift a substring match above a base match.
  ok('where it matched always outranks what it is priced in',
     scoreSymbol(sym('BTC', 'TRY'), 'BTC') < scoreSymbol(sym('AAVE', 'BTC'), 'BTC'),
     `${scoreSymbol(sym('BTC', 'TRY'), 'BTC')} vs ${scoreSymbol(sym('AAVE', 'BTC'), 'BTC')}`);
  // Symbols with no quote field at all must not throw or sort first.
  ok('a symbol with no quote is handled', scoreSymbol({ s: 'BTC', d: 'BTC', base: 'BTC' }, 'BTC') != null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
