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
  // Ranking alone was not enough, and this is the case that proved it: OKX
  // lists SOL against nine quotes, so a correct ORDER still put six rows of
  // AED/AUD/BRL/BTC/EUR/TRY plus JITOSOL, OKSOL and RESOLV under the answer.
  // Somebody typing a ticker wants that ticker in dollars, so it filters.
  const hits = rankSymbols(LISTING, 'BTC');
  const shown = hits.map((s) => s.d);
  ok('only BTC priced in dollars comes back',
     shown.every((d) => d.startsWith('BTC/')) && hits.every((s) => isUsdQuote(s.quote)),
     shown.join(' '));
  ok('the three people mean are first, in order',
     JSON.stringify(shown.slice(0, 3)) === '["BTC/USDT","BTC/USD","BTC/USDC"]', JSON.stringify(shown));
  ok('and every other dollar is there too, none of them dropped',
     ['BTC/FDUSD', 'BTC/USD1', 'BTC/USDS'].every((d) => shown.includes(d)), shown.join(' '));

  // The regression that prompted the first fix: compare mode returned these
  // seven first, pairs where BTC is the QUOTE.
  ok('the pairs where BTC is the quote are gone',
     !hits.some((s) => s.quote === 'BTC'), shown.join(' '));
  ok('and so are the local currencies',
     !['BTC/ARS', 'BTC/BRL', 'BTC/IDR', 'BTC/JPY', 'BTC/TRY', 'BTC/EUR', 'BTC/U'].some((d) => shown.includes(d)),
     shown.join(' '));
  ok('six rows, not twenty-one', hits.length === 6, `${hits.length} of ${LISTING.length}`);
}

console.log('\nrankSymbols — the two fallbacks, so nothing is unreachable');
{
  // Filtering must not decide FOR the viewer. Each rule is lifted, one at a
  // time, only when the stricter answer is empty.

  // 1. The ticker exists but trades against no dollar at all. `USDC0` — the
  //    bridged USDC on Hyperliquid — deliberately does NOT count as "no dollar":
  //    it carries USD, so the shape rule catches it and the strict filter holds.
  const bridged = rankSymbols([sym('PURR', 'USDC0'), sym('PURR', 'HYPE')], 'PURR').map((s) => s.d);
  ok('a bridged dollar is still a dollar, so the strict filter stands',
     JSON.stringify(bridged) === '["PURR/USDC0"]', JSON.stringify(bridged));

  const noDollar = [sym('WHYPE', 'HYPE'), sym('WHYPE', 'PURR'), sym('OTHER', 'USDT')];
  const whype = rankSymbols(noDollar, 'WHYPE').map((s) => s.d);
  ok('a ticker with no dollar pair at all still comes back, quote rule lifted',
     whype.length === 2 && whype.includes('WHYPE/HYPE'), JSON.stringify(whype));
  ok('and it is still only that ticker', whype.every((d) => d.startsWith('WHYPE/')), JSON.stringify(whype));

  // 2. No base matches exactly — a half-remembered name.
  const jito = rankSymbols([sym('JITOSOL', 'USDT'), sym('SOL', 'USDT')], 'JITO').map((s) => s.d);
  ok('a partial name falls back to prefix and substring matches',
     JSON.stringify(jito) === '["JITOSOL/USDT"]', JSON.stringify(jito));

  // 3. Typing a ticker no venue lists returns nothing, not everything. A venue
  //    that does not have it must say so rather than offer its whole listing.
  ok('a ticker the venue does not list returns nothing',
     rankSymbols([sym('SOL', 'USDT')], 'JITO').length === 0);

  // The fallbacks are ordered: an exact base with no dollar beats a prefix
  // match that has one, because the ticker is what was asked for.
  const mixed = [sym('RAY', 'TRY'), sym('RAYDIUM', 'USDT')];
  ok('an exact base with no dollar still beats a prefix match with one',
     JSON.stringify(rankSymbols(mixed, 'RAY').map((s) => s.d)) === '["RAY/TRY"]',
     JSON.stringify(rankSymbols(mixed, 'RAY').map((s) => s.d)));
}

console.log('\nrankSymbols — the other queries people type');
{
  // The case the old comment in menus.js named: RAY/USDT, not RAY/TRY — and now
  // RAY/TRY is not shown at all, because RAY has a dollar pair.
  const listing = [sym('RAY', 'TRY'), sym('RAY', 'USDT'), sym('RAYDIUM', 'USDT'), sym('XRAY', 'USDT')];
  const hits = rankSymbols(listing, 'RAY').map((s) => s.d);
  ok('an exact base wins outright', JSON.stringify(hits) === '["RAY/USDT"]', JSON.stringify(hits));
  // ...and with no exact base, the prefix still beats the substring.
  const partial = rankSymbols([sym('XRAY', 'USDT'), sym('RAYDIUM', 'USDT')], 'RAY').map((s) => s.d);
  ok('a prefix beats a substring elsewhere',
     partial.indexOf('RAYDIUM/USDT') < partial.indexOf('XRAY/USDT'), JSON.stringify(partial));

  // Lowercase, and the raw venue symbol rather than the display name: Bitunix
  // lists its spot pairs lowercase.
  const bit = [{ s: 'btcusdt', d: 'BTC/USDT', base: 'BTC', quote: 'USDT' }];
  ok('the search is case-insensitive', rankSymbols(bit, 'btc').length === 1);
  ok('and it matches the raw venue symbol too',
     rankSymbols([{ s: 'BTC-USDT-SWAP', d: 'BTC/USDT', base: 'BTC', quote: 'USDT' }], 'SWAP').length === 1);

  // An empty query is the menu opening, not a search: the listing order stands
  // and nothing is filtered out of it.
  const empty = rankSymbols(LISTING, '');
  ok('an empty query does not reorder or filter the listing',
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
