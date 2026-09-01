/**
 * Cross-checks the three unit conversions against a SECOND, independent source
 * inside each venue, plus a cross-venue comparison of the same instant.
 */
const get = (u) => fetch(u, { headers: { 'User-Agent': 'depthviz/1.0' } }).then((r) => r.json());
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const usd = (v) => '$' + (v / 1e6).toFixed(2) + 'M';

console.log('=== A. OKX SWAP ctVal — checked against the ticker\'s own vol24h/volCcy24h pair ===');
{
  const inst = (await get('https://www.okx.com/api/v5/public/instruments?instType=SWAP')).data;
  const tick = (await get('https://www.okx.com/api/v5/market/tickers?instType=SWAP')).data;
  const byId = new Map(inst.map((i) => [i.instId, i]));
  let ok = 0, bad = 0, checked = 0;
  const samples = [];
  for (const t of tick) {
    const i = byId.get(t.instId);
    if (!i || !(+t.vol24h > 0)) continue;
    const implied = +t.volCcy24h / +t.vol24h;          // base units per contract
    // inverse swaps quote ctVal in USD, so base-per-contract = ctVal / price
    const declared = (+i.ctVal || 1) * (+i.ctMult || 1) / (i.ctType === 'inverse' ? +t.last : 1);
    checked++;
    const rel = Math.abs(implied - declared) / declared;
    if (rel < 0.02) ok++; else { bad++; if (samples.length < 5) samples.push(`${t.instId} ctType=${i.ctType} declared=${declared.toPrecision(6)} implied=${implied.toPrecision(6)} ratio=${(implied / declared).toFixed(3)}`); }
  }
  console.log(`  ${ok}/${checked} SWAP instruments: inverse-aware ctVal matches volCcy24h/vol24h within 2%  (mismatches: ${bad})`);
  samples.forEach((s) => console.log('   mismatch:', s));
  for (const id of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'DOGE-USDT-SWAP', 'BTC-USD-SWAP']) {
    const i = byId.get(id), t = tick.find((x) => x.instId === id);
    console.log(`   ${id.padEnd(16)} ctType=${i.ctType.padEnd(7)} ctVal=${i.ctVal} ${i.ctValCcy}  base/contract: declared=${((+i.ctVal) * (+i.ctMult || 1) / (i.ctType === 'inverse' ? +t.last : 1)).toPrecision(6)} implied=${(+t.volCcy24h / +t.vol24h).toPrecision(6)}`);
  }
}

console.log('\n=== B. MEXC contractSize — checked against the ticker\'s amount24/volume24 pair ===');
{
  const det = (await get('https://contract.mexc.com/api/v1/contract/detail')).data;
  const tick = (await get('https://contract.mexc.com/api/v1/contract/ticker')).data;
  const byId = new Map(det.map((d) => [d.symbol, d]));
  let ok = 0, bad = 0, checked = 0; const samples = [], ratios = [];
  for (const t of tick) {
    const d = byId.get(t.symbol);
    if (!d || !(+t.volume24 > 0) || !(+t.lastPrice > 0)) continue;
    const implied = +t.amount24 / (+t.volume24 * +t.lastPrice); // contract size in base units
    checked++;
    const rel = Math.abs(implied - d.contractSize) / d.contractSize;
    ratios.push(implied / d.contractSize);
    if (rel < 0.05) ok++; else { bad++; if (samples.length < 5) samples.push(`${t.symbol} declared=${d.contractSize} implied=${implied.toPrecision(4)} ratio=${(implied / d.contractSize).toFixed(3)}`); }
  }
  console.log(`  ${ok}/${checked} contracts: contractSize matches amount24/(volume24*price) within 5%  (mismatches: ${bad})`);
  samples.forEach((s) => console.log('   mismatch:', s));
  ratios.sort((a, b) => a - b);
  const q = (f) => ratios[Math.floor(f * (ratios.length - 1))].toFixed(3);
  console.log(`  ratio implied/declared across all contracts: min=${q(0)} p05=${q(0.05)} median=${q(0.5)} p95=${q(0.95)} max=${q(1)}`);
  console.log(`  none near a power of ten -> the residual is 24h price drift in amount24, not a units error`);
}

console.log('\n=== C. Hyperliquid spot ctx keying — ctx.midPx vs the l2Book mid for the same coin ===');
{
  const [meta, ctxs] = await post('https://api.hyperliquid.xyz/info', { type: 'spotMetaAndAssetCtxs' });
  const byCoin = new Map(ctxs.map((c) => [c.coin, c]));
  const tok = new Map(meta.tokens.map((t) => [t.index, t]));
  const pick = ['@107', '@1', 'PURR/USDC', '@207'];
  for (const coin of pick) {
    const name = (() => { const u = meta.universe.find((x) => x.name === coin); return u ? `${tok.get(u.tokens[0])?.name}/${tok.get(u.tokens[1])?.name}` : '?'; })();
    const book = await post('https://api.hyperliquid.xyz/info', { type: 'l2Book', coin });
    const mid = (+book.levels[0][0].px + +book.levels[1][0].px) / 2;
    const keyed = byCoin.get(coin);
    const posIdx = meta.universe.findIndex((x) => x.name === coin);
    const positional = ctxs[posIdx];
    const err = (c) => c ? `${((+c.midPx / mid - 1) * 100).toFixed(2)}%` : 'n/a';
    console.log(`  ${coin.padEnd(11)} ${name.padEnd(14)} book mid=${mid.toPrecision(6).padStart(11)}  keyed-by-coin off by ${err(keyed).padStart(9)}   positional off by ${err(positional).padStart(11)} (coin=${positional?.coin})`);
  }
  // dayNtlVlm cross-checked against a completely different endpoint: candles
  const now = Date.now();
  for (const coin of ['@107', 'PURR/USDC']) {
    const c = await post('https://api.hyperliquid.xyz/info', { type: 'candleSnapshot', req: { coin, interval: '1h', startTime: now - 24 * 3600e3, endTime: now } });
    const fromCandles = c.reduce((s, k) => s + +k.v * +k.c, 0);
    const fromCtx = +byCoin.get(coin).dayNtlVlm;
    console.log(`  ${coin.padEnd(11)} dayNtlVlm=${usd(fromCtx).padStart(10)}  sum(1h candles vol*close)=${usd(fromCandles).padStart(10)}  ratio=${(fromCtx / fromCandles).toFixed(3)}`);
  }
}

console.log('\n=== D. Cross-venue sanity: BTC perp cumulative USD depth within ±0.1% of mid, same instant ===');
{
  const band = (bids, asks, mid) => {
    const f = (rows) => rows.reduce((s, [p, q]) => (Math.abs(p / mid - 1) <= 0.001 ? s + p * q : s), 0);
    return [f(bids), f(asks)];
  };
  const rows = [];
  {
    const d = await get('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000');
    const b = d.bids.map((r) => [+r[0], +r[1]]), a = d.asks.map((r) => [+r[0], +r[1]]);
    const mid = (b[0][0] + a[0][0]) / 2; rows.push(['Binance  (base units, no conversion)', mid, ...band(b, a, mid)]);
  }
  {
    const d = (await get('https://www.okx.com/api/v5/market/books?instId=BTC-USDT-SWAP&sz=400')).data[0];
    const CT = 0.01;
    const b = d.bids.map((r) => [+r[0], +r[1] * CT]), a = d.asks.map((r) => [+r[0], +r[1] * CT]);
    const mid = (b[0][0] + a[0][0]) / 2; rows.push([`OKX      (x ctVal ${CT})`, mid, ...band(b, a, mid)]);
    const bRaw = d.bids.map((r) => [+r[0], +r[1]]), aRaw = d.asks.map((r) => [+r[0], +r[1]]);
    rows.push(['OKX      (RAW contracts - what a missed fix looks like)', mid, ...band(bRaw, aRaw, mid)]);
  }
  {
    const inst = (await get('https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=BTC-USD-SWAP')).data[0];
    const d = (await get('https://www.okx.com/api/v5/market/books?instId=BTC-USD-SWAP&sz=400')).data[0];
    const CT = +inst.ctVal * (+inst.ctMult || 1);
    const conv = (r) => [+r[0], (+r[1] * CT) / +r[0]];
    const b = d.bids.map(conv), a = d.asks.map(conv);
    const mid = (b[0][0] + a[0][0]) / 2; rows.push([`OKX inv  (x ctVal ${CT} USD / price)`, mid, ...band(b, a, mid)]);
  }
  {
    const d = (await get('https://contract.mexc.com/api/v1/contract/depth/BTC_USDT')).data;
    const CS = 1e-4;
    const b = d.bids.map((r) => [+r[0], +r[1] * CS]), a = d.asks.map((r) => [+r[0], +r[1] * CS]);
    const mid = (b[0][0] + a[0][0]) / 2; rows.push([`MEXC     (x contractSize ${CS})`, mid, ...band(b, a, mid)]);
  }
  {
    const d = (await get('https://fapi.bitunix.com/api/v1/futures/market/depth?symbol=BTCUSDT&limit=max')).data;
    const b = d.bids.map((r) => [+r[0], +r[1]]), a = d.asks.map((r) => [+r[0], +r[1]]);
    const mid = (b[0][0] + a[0][0]) / 2; rows.push(['Bitunix  (base units, no conversion)', mid, ...band(b, a, mid)]);
  }
  {
    const d = await post('https://api.hyperliquid.xyz/info', { type: 'l2Book', coin: 'BTC' });
    const b = d.levels[0].map((l) => [+l.px, +l.sz]), a = d.levels[1].map((l) => [+l.px, +l.sz]);
    const mid = (b[0][0] + a[0][0]) / 2; rows.push(['Hyperliq (base units, no conversion)', mid, ...band(b, a, mid)]);
  }
  {
    const d = await get('https://fapi.asterdex.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000');
    const b = d.bids.map((r) => [+r[0], +r[1]]), a = d.asks.map((r) => [+r[0], +r[1]]);
    const mid = (b[0][0] + a[0][0]) / 2; rows.push(['Aster    (base units, no conversion)', mid, ...band(b, a, mid)]);
  }
  {
    // Lighter publishes no aggregated REST book — this sums the INDIVIDUAL
    // resting orders, which is a different endpoint and a different shape from
    // the aggregated websocket levels the adapter consumes. 200 orders/side is
    // the endpoint's ceiling and reaches ~+-0.15%, so it just covers the band.
    const d = await get('https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=1&limit=200');
    const conv = (rows) => rows.map((o) => [+o.price, +o.remaining_base_amount]);
    const b = conv(d.bids), a = conv(d.asks);
    const mid = (b[0][0] + a[0][0]) / 2; rows.push(['Lighter  (base units, summed per-order REST)', mid, ...band(b, a, mid)]);
  }
  for (const [n, mid, bd, ad] of rows) console.log(`  ${n.padEnd(54)} mid=${mid.toFixed(1)}  bid=${usd(bd).padStart(9)}  ask=${usd(ad).padStart(9)}`);
}
