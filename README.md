# depthviz

Live cumulative order-book depth visualizer across six venues, spot and perp.
Pick a market type, an exchange and a symbol; get a cumulative depth curve with
the raw book levels underneath and a full metrics panel.

```bash
npm install
npm start          # http://localhost:8787
```

## Stack, and why

- **Backend: Node ESM + `ws` + Express, no build step.** Every exchange here
  refuses browser CORS, and three of the six need stateful book maintenance
  (snapshot + diff replay). That has to live server-side anyway, so the backend
  also acts as a fan-out hub: N browsers watching the same symbol share one
  upstream connection.
- **No ccxt.** It supports five of the six, but the native endpoints win on the
  thing that actually matters for this chart — depth. Binance native gives 5000
  levels vs ccxt's default 100; Coinbase's `level=2` book is ~22 000 levels;
  Bitunix futures returns >15 000. Bitunix is not in ccxt at all. Adding a
  unified-symbol translation layer to get *less* depth was not worth it.
- **Frontend: vanilla ES modules + Canvas 2D, no charting library.** The chart is
  a bespoke composite — two mirrored stepped cumulative curves with area fill, a
  binned raw-level histogram underneath on the same axis, three dashed reference
  lines and a docked text panel. Every library (lightweight-charts, Chart.js,
  even D3's shape helpers) would have been fought rather than used, and canvas
  redraws 2 500 levels/side at 60 fps without a virtual DOM in the way.

## Exchange coverage (all verified live)

| Exchange | Spot | Perp | Transport | Levels seen on BTC | Notes |
|---|---|---|---|---|---|
| OKX | 1 385 | 458 | **WS** `books` (incremental, seq-checked) | 400/400 | SWAP sizes are contracts; linear → `ctVal*ctMult`, inverse → `ctVal*ctMult/price` |
| Binance | 1 358 | 568 | **WS** diff depth @100ms + REST snapshot | 5 000 / 1 000 | canonical U/u (spot) and `pu` (futures) resync algorithm |
| MEXC | 1 974 | 1 120 | **WS** protobuf (spot) + **WS** JSON (perp), REST snapshot | 2 000 / 1 500 | contract sizes converted via `contractSize`; 8s poll watchdog behind both |
| Bitunix | 844 | 732 | REST poll 1s (spot) / **WS** `depth_books` (perp) | 50 / 15 600 | spot book is capped by the exchange, see tradeoffs |
| Hyperliquid | 326 | 177 | **WS** `l2Book` ×3 stitched | ~55 / ~55 | three parallel `nSigFigs` layers, see tradeoffs |
| Coinbase | 521 | — | **WS** `level2_batch` (snapshot + updates) | ~22 000 | spot only; the PERP option greys it out |

Bitunix spot 24h volume is not a ticker read: the venue publishes no spot
ticker at all (every `/market/ticker*` path 404s), so it is summed from hourly
candles over a rolling 24h window, valuing each candle at its own close and
weighting the boundary candle by its overlap. That restored a real number
(~$125M on BTC/USDT) where the panel previously read `n/a`.

Symbol lists are fetched from each venue's own instruments endpoint at request
time (5-minute cache), filtered to the selected market type, and the live pair
count is shown next to the search box.

## Tradeoffs I had to make

1. **Bitunix spot is capped at 50 levels per side — the one limitation that
   survived.** Tried and rejected: `limit` = 100/500/1000/5000, the alternative
   parameter names `size`/`depth`/`level`, a `precision` and a `scale`/`type`
   argument, the endpoints `/market/depth/full`, `/market/orderbook`,
   `/market/books`, a `v2` path, the uppercase symbol form, and the whole
   `api.bitunix.com` REST host. All return 50 levels or 404. There is also no
   spot websocket: `wss://fapi.bitunix.com/public/` serves futures only, and of
   ~30 host/path combinations tried the single one that accepts a connection
   (`wss://api.bitunix.com/ws/public`) answers every subscription shape with
   nothing but a `ping`. So the curve ends around ±0.05% on BTC, and the app
   says so specifically for Bitunix spot whenever the range is wider than
   ±0.5%. Bitunix *futures* is the opposite — 15 600 levels, over websocket.
2. **Hyperliquid returns exactly 20 aggregated levels per subscription**, and
   `nSigFigs` only trades precision for reach (`mantissa` was tested too: it is
   accepted only alongside `nSigFigs: 5` and buys at most ±0.12%). Rather than
   pick one, the adapter runs **three l2Book subscriptions in parallel** —
   `null` (~±0.03%), `3` (~±2.5%) and `2` (~±25%) — and stitches them into one
   book, accepting a coarse bucket only once it clears the finer layer by a full
   bucket width. Mid and spread now come from the finest ticks at every range:
   BTC perp at ±10% reports a 0.0013% spread instead of the 1.27% the coarse
   feed alone implied, with ~55 levels per side instead of 20. The cost is a
   one-bucket seam where two layers meet, and three sockets per symbol.
3. **MEXC spot now streams, by decoding its protobuf by hand.** The old JSON
   channel is dead (`wbs.mexc.com` answers `Not Subscribed successfully …
   Reason： Blocked!`); the live feed is `wbs-api.mexc.com` with `.pb` frames.
   Rather than add a protobuf dependency and vendor a `.proto` that MEXC can
   rev, the adapter reads the wire format directly — the layout was recovered
   from live frames with a schema-less field walker and is tiny: field 1 =
   channel, 3 = symbol, 313 = body, and inside it 1 = asks, 2 = bids (each
   `{1: price, 2: qty}`), 4/5 = from/toVersion. Those versions share the same
   sequence space as the REST snapshot's `lastUpdateId` (both ~8.0e10), so the
   book is maintained with the same snapshot-then-replay algorithm as Binance.
   MEXC perp moved to its JSON `sub.depth` channel the same way. Because a
   hand-read schema is the most fragile integration here, **both MEXC feeds keep
   a watchdog**: if the websocket produces no book for 8 seconds, REST polling
   starts automatically and stops again the moment the socket recovers — and the
   panel says `poll` while that is happening.
4. **Books are trimmed server-side** to ±12% of mid and 2 500 levels per side
   before being sent, then throttled to 5 updates/s. Coinbase's raw 22 000-level
   book is ~1 MB of JSON per tick otherwise. All metrics inside ±10% are
   unaffected.
5. **Depth panels are honest about truncation.** When an exchange's book stops
   before the selected range (Binance spot's 5 000 levels only span ~±0.6% on
   BTC), the curve ends where the data ends and a note says so, instead of
   flat-lining to the edge and implying depth that is not there.
6. **`±2%`/`±5%` depths are fixed thresholds**, independent of the range
   selector; `Bid Depth`/`Ask Depth` are the cumulative notional inside the
   *selected* range. They coincide when the book does not reach the threshold.

## Unit conversions, and how they were verified

Three venues do not quote book sizes in base units. Getting these wrong is
invisible — the chart still looks right, just with the wrong zeros — so each one
is checked against a second, independent source by
`node tools/verify-conversions.mjs`:

- **OKX SWAP sizes are in contracts.** Linear contracts (`BTC-USDT-SWAP`) carry
  `ctVal` in the base coin; **inverse** ones (`BTC-USD-SWAP`) carry it in USD, so
  base = `contracts * ctVal * ctMult / price`. Checked against each ticker's own
  `volCcy24h / vol24h` ratio, a completely separate field pair:
  **458/458 instruments agree within 2%**. The inverse case was found by this
  check — before it, the 15 `-USD-SWAP` markets were the only mismatches.
- **MEXC contract sizes.** Checked against `amount24 / (volume24 * price)`:
  **1 067/1 146 within 5%**, and the ratio distribution across all contracts is
  p05 = 0.98, median = 1.004, p95 = 1.05 — clustered on 1, nowhere near a power
  of ten, so the residual is 24h price drift inside `amount24`, not a units
  error.
- **Hyperliquid spot contexts.** `spotMetaAndAssetCtxs` returns 718 contexts for
  a 326-entry universe and they are *not* positionally aligned. Keying by
  `ctx.coin` puts `ctx.midPx` within 0.02–0.19% of the live l2Book mid for every
  pair tested; the positional lookup is off by **−99.9% and −100%** on two of
  four. `dayNtlVlm` is independently cross-checked against a different endpoint,
  `candleSnapshot` (sum of 24 hourly `volume * close`): ratios 0.972 and 0.983.
- **Cross-venue sanity at a single instant.** BTC perp cumulative depth within
  ±0.1% of mid lands at $6–20M per side on all five perp venues. The same OKX
  book without the contract conversion reads $1 334M — a missed conversion is a
  100× error, and it would not hide.

## Metrics

Mid, spread %, 24h volume, bid/ask VWAP with % distance from mid, bid/ask
cumulative depth inside the range, depth at ±2% and ±5%, total depth, and
OFI = (bidDepth − askDepth) / (bidDepth + askDepth), labelled BID-heavy /
ASK-heavy outside ±0.15 with the raw number always shown.

## Controls

Market toggle · exchange picker (Coinbase disabled under PERPS) · ranked symbol
search over the full live pair list · range ±0.1/0.5/2/5/10% · LIVE indicator
driven by real connection state (`connecting` / `live` / `reconnecting` /
`error` / `offline`) · theme toggle · COPY (panel text + JSON to clipboard) ·
PNG export.

## Adding an exchange

Drop a module in `server/adapters/` exporting
`{ id, name, markets, transport, listSymbols(market), vol24h(market, s), open(market, s, opts, emit, status) }`
and register it in `server/adapters/index.js`. `open` returns `{ close() }` and
pushes `{ bids, asks, ts, source }` with sizes in base units, bids descending,
asks ascending. The UI needs no changes.

## Smoke tests

```bash
node tools/smoke-feeds.mjs         # subscribes to all 11 exchange/market combos, prints live mids and depth
node tools/smoke-ui.mjs            # drives the real page in Chrome: every venue, search, range, copy, PNG
node tools/verify-conversions.mjs  # re-runs the unit-conversion cross-checks above against live data
```

`smoke-ui.mjs` needs Chrome (`npm i -D playwright`, then it launches the
installed `chrome` channel) and writes screenshots to `tools/out/`.
