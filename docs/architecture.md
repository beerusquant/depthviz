# Architecture and tradeoffs

[← README](../README.md) · [Architecture](architecture.md) · [Verification](verification.md) · [Deployment](deployment.md) · [Adding an exchange](adding-an-exchange.md)

Why the thing is built the way it is, and what each choice cost. Every number
below was measured against a live venue, not assumed.

## Stack, and why

- **Backend: Node ESM + `ws` + Express, no build step.** Every exchange here
  refuses browser CORS, and five of the eight need stateful book maintenance
  (snapshot + diff replay). That has to live server-side anyway, so the backend
  also acts as a fan-out hub: N browsers watching the same symbol share one
  upstream connection.
- **ccxt is the judge, not the source.** It was measured rather than assumed,
  and the measurement cuts both ways. Against it as a *source*: it caps at each
  venue's shallow public endpoint (Hyperliquid 20 levels against the stitch's
  ~56), it does not carry Bitunix at all, and — the disqualifying one —
  `fetchOrderBook` returns OKX and MEXC contract-denominated sizes **raw**. It
  exposes `market.contractSize` but never applies it, so reading the book
  straight from ccxt is a silent 100x error on `BTC-USDT-SWAP` and ~780x on the
  inverse `BTC-USD-SWAP`. For it: it is a second, independently maintained
  implementation, which is exactly what a hand-decoded protobuf and hand-rolled
  contract maths need pointed at them. So it is a devDependency and
  `npm run crosscheck` makes it disagree with us on demand.

- **Frontend: vanilla ES modules + Canvas 2D, no charting library.** The chart is
  a bespoke composite — two mirrored stepped cumulative curves with area fill, a
  binned raw-level histogram underneath on the same axis, three dashed reference
  lines and a docked text panel. Every library (lightweight-charts, Chart.js,
  even D3's shape helpers) would have been fought rather than used, and canvas
  redraws 2 500 levels/side at 60 fps without a virtual DOM in the way.

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
4. **Books are reduced server-side without losing reach.** Coinbase's raw
   22 000-level book is ~1 MB of JSON per tick, so the payload has to be cut —
   but the obvious cut is wrong. Keeping the *2 500 levels nearest to mid*
   shipped only +-0.62% of a Binance spot book that actually reached +-11%,
   hiding **64% of the depth inside +-10%** (Coinbase 38%, Bitunix perp 19%).
   Now levels within +-0.6% of mid go out verbatim and everything beyond is
   merged into 5 bps geometric buckets emitted as `[vwapPrice, summedQty]`.
   That form preserves cumulative notional, cumulative base quantity and VWAP
   *exactly*, since `vwapPrice * summedQty === sum(price * qty)` by
   construction. The result reaches the full +-12% clip on **fewer** levels than
   the old truncating rule shipped (~650/side on Coinbase vs 2 500).

   The reach itself is accumulated, not fetched. Binance's and MEXC's snapshots
   are capped (5 000 levels, ~+-1.1% on BTC) but their diff streams carry every
   price level, so a maintained book grows past the snapshot to +-10% and
   beyond. Clearing the book on each resync threw that away — one sequence gap
   dropped the chart back to the snapshot's span and it re-grew silently over
   minutes. `BookSide.applySnapshot` now replaces only the snapshot's own price
   span and keeps the tail beyond it. Because a level cancelled during the
   outage would linger as phantom depth, a kept level must have been seen
   within 5 minutes, and the whole tail is dropped when the gap itself exceeded
   30 s. `node tools/test-book.mjs` covers those branches without a network.
5. **Depth panels are honest about truncation.** When an exchange's book stops
   before the selected range (Binance spot's 5 000 levels only span ~±0.6% on
   BTC), the curve ends where the data ends and a note says so, instead of
   flat-lining to the edge and implying depth that is not there.
6. **OKX needs two transports to reach past +-0.3%.** The `books` websocket
   channel is capped at 400 levels — ~+-0.28% of mid on BTC. REST
   `books-full` returns 5 000 (~+-1.3%) but is not streamed, and the deeper
   tick-by-tick channels (`books-l2-tbt`) require a VIP4+ authenticated
   connection. `books-full` as a websocket channel does not exist — OKX
   rejects the subscription outright. So the socket stays authoritative for
   everything inside its own 400-level span, where price moves matter, and a
   1 s `books-full` poll supplies only the tail beyond that span; no level is
   served by both. BTC-USDT spot went from +-0.28% / $10.3M to +-1.31% /
   $19.5M of depth inside +-10%. On BTC that 5 000-level ceiling is still the
   end of the road, and the truncation note says so.

7. **Accumulated depth is a lower bound, and the panel says so.** Levels that
   sat outside the snapshot before we connected and were never touched by a
   diff are invisible to us forever, so far depth on Binance and MEXC only ever
   grows with uptime. It is never overstated, but it was presented as settled.
   Those adapters now report when their tail last restarted, and the panel says
   *depth beyond ±0.6% is still converging* for the first three minutes.

8. **OKX's two transports check each other for free.** The socket's 400 levels
   and the 1 s `books-full` poll overlap completely, and nothing compared them.
   Cumulative size over that overlap is now measured on every poll — the kind
   of drift a sequence counter cannot catch. Three consecutive readings past
   15% force a resubscribe. Measured live: **0.00-0.18%**, i.e. the incremental
   book and the venue's own full book agree.

9. **`±2%`/`±5%` depths are fixed thresholds**, independent of the range
   selector; `Bid Depth`/`Ask Depth` are the cumulative notional inside the
   *selected* range. They coincide when the book does not reach the threshold.

## The hub, and what it is allowed to do to a book

The hub is the only place a book is touched between an adapter and a viewer, so
the constraints on it are worth stating.

**Two clocks, never conflated.** A book carries `tsVenue` — the exchange's own
event time — and `tsRecv`, when the frame reached this process. `tsVenue` is
`null` wherever the venue stamps nothing: a REST poll, Coinbase's opening frame,
every snapshot. It used to be filled with `Date.now()` on those paths, which made
a feed with no clock indistinguishable from one with a perfect one, and printed a
latency of zero that nobody would think to question. The rule now is that an
adapter reports the venue's time or `null`, and the hub adds its own — so
`tsRecv - tsVenue` is upstream latency where it exists and is absent where it
does not.

Writing that rule found two bugs. **MEXC reported no venue clock on either
market while the venue was stamping every frame**: the perp payload carries
`data.cts` (when the book changed) and `msg.ts` (when the frame was sent), and
the spot protobuf carries the send time in field 6 — all three were being
dropped by the decoders. Both feeds now measure ~90–120 ms, in line with the
other venues. The delta is also shown raw, negative included: a negative one is
clock skew between us and the exchange, which is worth seeing rather than
clamping to zero.

**A slow client drops frames, it does not queue them.** `broadcast` skips any
socket whose `bufferedAmount` is past 1 MB. A book is a snapshot, not a log: the
next frame is strictly better than the one the client has not read yet, and
without this a single stalled viewer on a slow link grows a server-side buffer
without bound. Skipped frames are counted and reported by `/api/feeds`.

**A feed with no viewers is kept for 30 s.** Switching venue and back, or polling
`/api/depth`, used to close the upstream connection and reopen it a moment later
— which is both slower and rude to an exchange whose rate limit is shared with
whatever else the host runs.

**`state` is not health.** It is set by the last status event, so a feed that
reconnects every thirty seconds still reads `live` between drops, and one whose
socket went quiet without closing reads `live` forever. `/api/feeds` therefore
reports `ageMs` — time since the last book — alongside reconnect, error and
dropped-frame counters, and the panel shows the same age on screen, refreshed
once a second so a stalled feed cannot freeze its own staleness.

## One implementation of every number

`shared/metrics.js` computes depth, VWAP, OFI and the truncation flags, and both
the browser and the server import it — the page from `/shared/metrics.js`, the
API by path. It used to live in `public/`, which meant the server did not know
any of its own numbers: getting a depth figure out of this tool required opening
Chrome and pressing COPY, and nothing could log or alert on one. Moving it also
means `tools/test-metrics.mjs` now covers the API's arithmetic, not just the
chart's.

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
  ±0.1% of mid lands at $3–20M per side on all seven perp venues. The same OKX
  book without the contract conversion reads $1 334M — a missed conversion is a
  100× error, and it would not hide.

## The note line, and when it appears

The chart draws nothing past where the venue's data ends — the cumulative curve
simply stops. The one-line note under the chart says so **only when that
happens**: when the book cannot reach the selected range, it names where it
actually ends (`book ends at ±0.068% of ±2%`) and appends the venue's reason.
When the venue fills the window it says nothing at all.

That is a deliberate reversal. It used to print the venue's caveat on every
render — an amber box that was on screen at every range on Hyperliquid, Bitunix
and Aster. A warning shown constantly is wallpaper: it stops being read exactly
when it starts mattering. `smoke-ui.mjs` now asserts both directions — Bitunix
spot at ±2% must warn, Coinbase at ±2% must stay silent.

The one exception is a book still accumulating its deep tail after a resync
(Binance, MEXC, Aster): it says so for its first 60 seconds, because during that
window the far depth genuinely can only grow.
