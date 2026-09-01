# depthviz

Live cumulative order-book depth visualizer across eight venues, spot and perp.
Pick a market type, an exchange and a symbol; get a cumulative depth curve with
the raw book levels underneath and a full metrics panel.

```bash
npm install
npm start          # http://127.0.0.1:8787
```

It binds loopback only. There is no authentication, and every viewer makes the
host open upstream connections to eight exchanges from *its* IP — on a box that
also runs trading bots, that is someone else's rate-limit budget. Exposing it is
therefore deliberate: `HOST=0.0.0.0 PORT=8888 npm start`.

`CLAUDE.md` carries the working rules for this repo — every one of them written
after something here went wrong, with the measurement that caused it.

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

## Exchange coverage (all verified live)

| Exchange | Spot | Perp | Transport | Levels / reach on BTC | Notes |
|---|---|---|---|---|---|
| OKX | 1 385 | 458 | **WS** `books` (incremental, seq-checked) + REST `books-full` tail @1s | 5 000 lv, ±1.3% | SWAP sizes are contracts; linear → `ctVal*ctMult`, inverse → `ctVal*ctMult/price` |
| Binance | 1 358 | 569 | **WS** diff depth @100ms + REST snapshot | 5 000 / 1 300 lv, **±10%** | canonical U/u (spot) and `pu` (futures) resync algorithm |
| MEXC | 1 982 | 1 129 | **WS** protobuf (spot) + **WS** JSON (perp), REST snapshot | 2 000 / 1 500 lv, ±5% / ±3% | contract sizes converted via `contractSize`; 8s poll watchdog behind both |
| Bitunix | 844 | 735 | REST poll 1s (spot) / **WS** `depth_books` (perp) | 50 lv ±0.05% / 16 000 lv **±12%** | spot book is capped by the exchange, see tradeoffs |
| Hyperliquid | 326 | 177 | **WS** `l2Book` ×6 stitched | ~88 lv, **±11%** | six parallel `nSigFigs`/`mantissa` layers reconciled on cumulative quantity, see tradeoffs |
| Coinbase | 521 | — | **WS** `level2_batch` (snapshot + updates) | ~22 000 lv, whole book | spot only; the PERP option greys it out |
| Aster | — | 553 | **WS** diff depth @100ms + REST snapshot | 1 000 lv snapshot ±2.7%, grows with uptime (±5.9% after 9 s) | perp DEX; Binance-futures API dialect, so it runs the shared `diff-book.js` engine |
| Lighter | — | 214 | **WS** whole-book snapshot + nonce-chained diffs | ~2 900 lv, past ±50% (clipped to ±12%) | perp DEX; markets addressed by numeric `market_id`, resolved from the symbol |

Aster and Lighter are perp DEXs and are exposed as perp only. Aster does list
spot pairs on a separate `sapi` host; that is a different, much thinner product
and is not wired up. Lighter publishes no active spot market at all.

Bitunix spot 24h volume is not a ticker read: the venue publishes no spot
ticker at all (every `/market/ticker*` path 404s), so it is summed from hourly
candles over a rolling 24h window, valuing each candle at its own close and
weighting the boundary candle by its overlap. That restored a real number
(~$125M on BTC/USDT) where the panel previously read `n/a`.

Pair counts are a **snapshot taken 2026-09-01** and drift daily as venues list
and delist — the app never uses them. Symbol lists are fetched from each venue's
own instruments endpoint at request time (5-minute cache), filtered to the
selected market type, and the live count is shown next to the search box.

Reach is what the chart can actually draw, not the snapshot size: Binance's and
MEXC's books grow past their capped snapshots by applying diffs (tradeoff 4), so
they are quoted at the reach a settled feed holds, not at the REST limit.

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

## Deployment

It runs on the Tokyo VPS (ssh alias `my-vps`) as `depthviz.service`, from
`/opt/depthviz` with `PORT=8888` and node at `node`. That
directory is **not a git checkout**: deploys are a `git diff` of the local
commits, copied over and applied with `git apply`, then `systemctl restart
depthviz` and a look at `journalctl -u depthviz`. Never rsync the tree — a patch
that does not apply is telling you the target has drifted, which is information
an overwrite destroys. After deploying, confirm the tree matches the commit by
comparing per-file hashes rather than assuming.

The service listens on loopback and ufw carries no rule for 8888, so it is not
reachable from the internet; get to it with
`ssh -L 8888:127.0.0.1:8888 my-vps` and open `http://127.0.0.1:8888`.
devDependencies are installed there too, so all four checks run in place.

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

### Reaching it from a browser, without thinking about it

The service listens on loopback on the VPS, so a browser needs an SSH tunnel.
Typing one every time is how a tool stops being used, so macOS keeps it up:
`deploy/dev.depthviz.tunnel.plist` goes in `~/Library/LaunchAgents/`.

```bash
cp deploy/dev.depthviz.tunnel.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.depthviz.tunnel.plist
```

It forwards `8888:127.0.0.1:8888` to `my-vps`, starts at login and, with
`KeepAlive`, comes back on its own after a network drop, a wake from sleep or a
kill — verified by killing the process and watching a new pid serve HTTP 200
twelve seconds later. `ServerAliveInterval=30` / `CountMax=3` is what notices a
connection that died without closing. Then **`http://127.0.0.1:8888`** always
works; bookmark it.

`deploy/Depthviz.app` is the same thing as one click: copy it to
`~/Applications` and it shows up in Spotlight, so ⌘-Space → "depth" → Enter
opens the chart. It checks the tunnel first and, if the agent was stopped or the
Mac has just woken, restarts it and waits before opening the browser — from a
fully torn-down state it takes ~5 s. It says so in an alert rather than opening
a dead page when the VPS itself is unreachable.

Requires a passphrase-less key (or one loaded outside the agent): a LaunchAgent
has no terminal to prompt on. Remove with
`launchctl bootout gui/$(id -u)/dev.depthviz.tunnel`, and read
`~/Library/Logs/depthviz-tunnel.log` if it ever stops.

## Continuous verification

`npm run checks` runs the unit tests, the stitch tests, the full ccxt
crosscheck, `verify-bitunix` and `verify-hyperliquid` in one go, appends a
one-line verdict to `logs/checks.log`, and exits non-zero if anything failed.

On the VPS it runs hourly from `deploy/depthviz-checks.{service,timer}`
(`RandomizedDelaySec=600`, so it does not hit six venues at the top of every
hour from an IP that also runs trading bots). The point is not the passing runs:
an exchange can change a field or a contract multiplier overnight, the chart
stays beautiful, and the numbers are silently wrong by a factor of a hundred —
which is precisely how the OKX contract-size bug survived. Reading it:

```bash
systemctl list-timers depthviz-checks      # when it last ran, when it runs next
tail -5 /opt/depthviz/logs/checks.log   # one verdict line per run
journalctl -u depthviz-checks -n 200       # the full output of the last runs
```

The unit `Requires=depthviz.service`: with the app down the checks measure
nothing, and "not judged" must never read as a pass.

## Adding an exchange

Drop a module in `server/adapters/` exporting

```js
{
  id, name,
  markets,            // ['spot', 'perp']
  transport,          // { spot: 'ws' | 'poll', perp: ... } — shown in the panel
  notes,              // optional { spot?: string, perp?: string }, surfaced in the UI note line
  listSymbols(market),                  // -> [{ s, d, base, quote }]
  vol24h(market, s),                    // -> quote-denominated number | null
  open(market, s, opts, emit, status),  // may be async; -> { close() }
}
```

and register it in `server/adapters/index.js`. If the venue speaks the Binance
snapshot+diff dialect, do not re-implement it: `server/adapters/diff-book.js`
holds that engine (`style: 'spot'` for `U === lastUpdateId + 1`, `'futures'` for
`pu === lastUpdateId`) and both Binance and Aster are thin config on top of it.
`open` may return a promise (OKX, MEXC and Lighter do — they need contract sizes,
or a `market_id`, first) and resolves to `{ close() }`. It
pushes

```js
emit({ bids, asks, ts, source, accum, drift })
```

with sizes in **base units**, bids descending, asks ascending. `source` is
`'ws'` or `'poll'` and drives the panel's transport label. The last two are
optional: `accum: { since }` marks a book that only reaches past its snapshot by
accumulating diffs, so the UI can say the far depth is still converging
(tradeoff 7); `drift` is a 0..1 disagreement between two transports of the same
venue, where one exists (tradeoff 8). The UI needs no changes.

## Smoke tests

```bash
node tools/smoke-feeds.mjs         # subscribes to all 13 exchange/market combos, prints live mids and depth
node tools/smoke-ui.mjs            # drives the real page in Chrome: every venue, search, range, copy, PNG
node tools/verify-conversions.mjs  # re-runs the unit-conversion cross-checks above against live data
npm run verify:hyperliquid         # the only assembled book: every stitched layer vs its own measurement
npm test                           # BookSide.applySnapshot resync semantics, no network
npm run crosscheck                 # tools/crosscheck-ccxt.mjs: ccxt as an independent second opinion (server must be up)
npm run crosscheck -- mexc --repeat 20   # sample one venue repeatedly and report the ratio distribution
npm run verify:bitunix             # the venue ccxt cannot judge, checked against itself and its peers
npm run checks                     # every proof above in one run, for a timer; non-zero if any fails
```

No tool hardcodes a port. The three websocket-backed ones take `DEPTHVIZ_URL`
(default `ws://127.0.0.1:8787/ws`) and `smoke-ui.mjs` takes `DEPTHVIZ_HTTP`
(default `http://127.0.0.1:8787`); the deployed service listens on 8888, so
point them at it: `DEPTHVIZ_URL=ws://127.0.0.1:8888/ws node tools/smoke-feeds.mjs`. Getting
this wrong is not subtle in its consequences — it reports every feed dead
while the server is perfectly healthy, which is exactly what it used to do
before it honoured the variable.

### The Hyperliquid stitch, and the depth it used to eat

Hyperliquid is the only book here that is *assembled* rather than read, so it is
the only one that can be wrong in a way no venue endpoint would reveal. It was.

The venue serves exactly 20 aggregated levels per subscription; `nSigFigs` and
`mantissa` choose the bucket width, and therefore how far those 20 reach.
Measured on BTC: `{}` 0.0013% buckets to ±0.025%, `{nSigFigs:5,mantissa:2}`
0.0026% to ±0.05%, `{5, mantissa:5}` 0.0064% to ±0.125%, `{4}` 0.0128% to
±0.25%, `{3}` 0.128% to ±2.5%, `{2}` 1.27% to ±25%. The first implementation
subscribed to only `{}`, `{3}` and `{2}` — a jump straight from 0.0013% buckets
to 0.128% ones — and stitched them by **discarding any coarse bucket that did
not clear the finer layer's edge by a full bucket width**, throwing away the
depth inside it.

Both halves of that were costly, and `npm run verify:hyperliquid` quantifies it
by comparing the stitched book against each layer's own cumulative quantity,
taken on that layer's own price grid:

| cumulative quantity out to | before | after |
|---|---|---|
| BTC, `{5,m:2}` edge (±0.05%) | **0.429** | 1.0000 |
| BTC, `{5,m:5}` edge (±0.13%) | **0.152** | 1.0000 |
| BTC, `{4}` edge (±0.25%) | **0.313** | 1.0000 |
| BTC, `{3}` edge (±2.44%) | 0.917 | 1.0000 |
| BTC, `{2}` edge (±24.7%) | 0.881 | 1.0000 |

Near mid the chart was showing **15% of the real depth** — not a rounding
artefact, a hole. Two changes fix it. The ladder gains the four intermediate
layers the venue was already willing to serve (55 → 88 levels/side on BTC, and
the widest hole inside ±0.5% falls from 0.24% to 0.13%). And the layers are now
reconciled on **cumulative quantity** instead of cut at price boundaries: each
layer is complete from the top of book out to its own edge, so the first coarse
bucket reaching past the finer edge contributes `cumulative_coarse −
cumulative_fine`, exactly the part the finer layer could not see. All 20 layer
reconciliations across BTC, ETH, PUMP and HYPE now land at 1.0000.

When the two subscriptions disagree because they were sampled a moment apart,
the residual goes negative; it is clamped to zero, so a skew costs one stale
seam bucket for one tick rather than inventing depth. `node tools/test-stitch.mjs`
(in `npm test`, no network) pins that, the cumulative identity, and the cheap-coin
case where every layer returns the same book.

Lighter's resync path is the one branch live traffic will not exercise on
demand, so it was forced: a scratch copy of the adapter corrupted its expected
nonce after five updates, and the feed detected the gap, unsubscribed,
resubscribed and came back on a second full snapshot (`snapshots=2 resyncs=1
books=455` over 25 s). The venue refuses a second `subscribe` on a live channel
(code 30003 "Already Subscribed"), which is why the channel is dropped first.

`smoke-ui.mjs` needs Chrome: playwright is already a devDependency, and it
drives the `chrome` channel installed on the machine rather than downloading a
browser. Screenshots land in `tools/out/`.

`crosscheck` samples our live websocket book and a ccxt REST snapshot of the
same instrument moments apart, then compares cumulative base quantity over the
band **both** books actually reach — charging us for depth ccxt never fetched
would make the deeper feed look like a bug. Contract-denominated venues are
expected to differ by exactly the contract multiplier (`ctVal`, or `ctVal/price`
when inverse); anything else is the error. It takes the median of 3 samples by
default, because one sample is not a verdict. Last full run: **all 11 judged
instruments agree**, medians 0.94–1.03 — Aster at **1.004** (n=3) and Lighter at
**1.010** (n=15, judged on the ±0.046% its 100-level ccxt book spans against our
whole-book stream), both with the mid identical to four decimals. Bitunix is absent from ccxt, so it has no
judge and is reported as *not judged* — a skip is never counted as a pass.
`verify-bitunix.mjs` substitutes three checks that share no arithmetic with the
code they test: the 24 h spot volume recomputed from 15-minute candles instead
of hourly ones (**ratio 1.0011**, so the candle-summing that replaces the
non-existent spot ticker is sound), the futures websocket book against the
venue's own REST snapshot (**mid identical, size ratio 0.991**), and the spot
mid against the median of three other venues (**-0.019%**). None of them is a
second implementation, so they bound the error rather than confirm the data.

A single sample of a thin book can land 2x off simply because the book moved
between the two reads, so one ratio proves little. `--repeat N` holds one socket
open, samples repeatedly, and takes the verdict on the **median**. MEXC spot —
the hand-decoded protobuf feed, and so the integration most likely to be wrong —
was the loosest single reading at 1.15. Two independent runs of n = 20 both put
its **median at exactly 1.000** (p05 0.47, p95 1.67): the spread is the book
moving, not our sizes. MEXC perp lands at median 1.000 with p05 0.99 / p95 1.08,
as a dense book should. Hyperliquid is judged on the ~±0.025% its 20 aggregated
levels span, the narrowest band here and so the noisiest: median **1.003** at
n = 20, p05 0.70 / p95 1.30.

Hyperliquid needed the same treatment for the same reason, and the hourly timer
is what surfaced it: judged on the ±0.025% its finest 20 levels span, three
samples straddled agreement (p05 0.68 / p95 1.10) and the run reported
INCONCLUSIVE — which exits non-zero, correctly, and would have cried wolf every
hour. It takes 15 samples now: median **1.005**, and the fix is more evidence,
not a looser threshold.

Three samples still could not find MEXC spot's median — it read 0.648 on one
full run — so that instrument alone takes 15 by default. And when a sample's own
p05..p95 straddles agreement, the run reports **INCONC** rather than FAIL: it has
failed to measure a disagreement, which is not the same as finding one. Neither
an inconclusive nor a skipped venue counts as a pass, and either makes the run
exit non-zero.
