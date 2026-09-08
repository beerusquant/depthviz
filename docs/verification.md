# Verification

[← README](../README.md) · [Architecture](architecture.md) · [Verification](verification.md) · [Deployment](deployment.md) · [Adding an exchange](adding-an-exchange.md)

The tool has one product: an order book that is right. A chart that renders
beautifully with the wrong numbers is a worse bug than one that crashes,
because it does not announce itself. Everything here exists to make a wrong
number announce itself.

## What the tests cover, and what they cannot

`npm test` is four suites, 52 assertions, no network and no browser — they run
in CI on Node 20 and 22 on every push:

| suite | what it pins |
|---|---|
| `test-book` | `BookSide.applySnapshot`: whether accumulated depth survives a resync, and when it must not |
| `test-stitch` | the Hyperliquid layer reconciliation and its cumulative identity |
| `test-trim` | that reducing the payload preserves cumulative quantity, notional, VWAP **and reach** |
| `test-reconnect` | the socket liveness watchdog: a path that proves nothing is dropped, and a quiet book whose venue still answers a ping is left alone |
| `test-diff-book` | the sequencing engine five feeds share: the anchor after a snapshot, gap detection, resync — replayed from ids captured live on Binance perp |
| `test-metrics` | every number in the panel — depth, VWAP, imbalance, the truncation flags |

The last two were written after the fact, for the two functions that had no
coverage at all despite producing everything on screen. Writing them was worth
it immediately: `computeMetrics` was dropping a level sitting **exactly** on a
boundary, because `|95/100 - 1| * 100` is `5.000000000000004` in binary floating
point, so the "-5% depth" figure excluded the very level that defines it. Round
numbers are exactly where real books put size.

What CI deliberately does not run: anything needing the network. A build that
goes red because an exchange had a bad minute teaches people to ignore the
build. Those checks run hourly against the live service instead, where a failure
is information rather than noise.

## Smoke tests

```bash
node tools/smoke-feeds.mjs         # subscribes to all 13 exchange/market combos, prints live mids and depth
node tools/smoke-ui.mjs            # drives the real page in Chrome: every venue, search, range, copy, PNG
node tools/verify-conversions.mjs  # re-runs the unit-conversion cross-checks against live data
npm run verify:hyperliquid         # the only assembled book: every stitched layer vs its own measurement
npm test                           # 52 assertions over the four pure cores, no network
npm run crosscheck                 # tools/crosscheck-ccxt.mjs: ccxt as an independent second opinion (server must be up)
npm run crosscheck -- mexc --repeat 20   # sample one venue repeatedly and report the ratio distribution
npm run verify:bitunix             # the venue ccxt cannot judge, checked against itself and its peers
npm run checks                     # every proof here in one run, for a timer; non-zero if any fails
```

No tool hardcodes a port. The three websocket-backed ones take `DEPTHVIZ_URL`
(default `ws://127.0.0.1:8787/ws`) and `smoke-ui.mjs` takes `DEPTHVIZ_HTTP`
(default `http://127.0.0.1:8787`); the deployed service listens on 8888, so
point them at it: `DEPTHVIZ_URL=ws://127.0.0.1:8888/ws node tools/smoke-feeds.mjs`. Getting
this wrong is not subtle in its consequences — it reports every feed dead
while the server is perfectly healthy, which is exactly what it used to do
before it honoured the variable.

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
tail -5 logs/checks.log                    # one verdict line per run
journalctl -u depthviz-checks -n 200       # the full output of the last runs
```

The unit `Requires=depthviz.service`: with the app down the checks measure
nothing, and "not judged" must never read as a pass.

## The Hyperliquid stitch, and the depth it used to eat

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
whole-book stream), both with the mid identical to four decimals. Bitunix is absent from ccxt — rechecked against 4.5.78, the current release — so
`crosscheck-ccxt` reports it as *not judged*, and a skip is never counted as a
pass. `verify-bitunix.mjs` covers it in two layers.

Three checks that share no arithmetic with the code they test, but are still our
own reading of the venue, so they bound the error: the 24 h spot volume
recomputed from 15-minute candles instead of hourly ones (**ratio 1.0000**, so
the candle-summing that replaces the non-existent spot ticker is sound), the
futures websocket book against the venue's own REST snapshot (**mid identical,
size ratio 1.010**), and the spot mid against the median of three other venues
(**+0.000%**). To those is added the adapter's continuous `drift` — the same two
transports compared every 5 s — judged on the **median of ten readings at 2%**.
That threshold is the widest the data supports and no wider: sampled every 5 s
for 20 minutes, BTCUSDT runs median 0.288% / max 2.76% while SOLUSDT runs 3.42% /
16.73%, so a single global number would be silent on one and permanently
breached on the other.

And one check that *is* a second implementation. CoinGecko runs its own
integration against Bitunix, so it reads the same exchange with different code
on its own schedule: the spot mid comes in at **+0.132%** against what it sees,
the perp mid at **+0.092%**, the spot 24 h volume at **ratio 1.0041** — the
figure that previously had no judge whatsoever — and the perp volume at
**1.0061**. It publishes no order book, so **depth remains judged only by the
venue against itself**. An unreachable or rate-limited judge reports INCONC and
exits non-zero, exactly as a ccxt failure does.

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

The hourly timer then failed twice more, on MEXC spot, and the answer was not
more samples either. Queried **directly on MEXC's own REST endpoint** — no ccxt,
no depthviz in the path — ten reads four seconds apart returned 177, 132, 115,
43, 221, 164, 140, 218, 146 and 172 BTC within ±2%, with the level count steady
at ~1780. The venue's own liquidity swings 5x in forty seconds. Our feed was
motionless throughout that window (373–385 levels, reach ±3.83%, no resync), and
widening the judged band made it worse, not better (p05 0.19 at ±2%).

So MEXC spot carries its own tolerance, and the check keeps only the power it
actually has there: catching an order-of-magnitude or systematic error, not a
10% one — a missed contract multiplier is 100x and still screams. Claiming more
precision than the venue offers is how a check starts crying wolf, and a check
nobody believes catches nothing.

## What an hourly timer taught the checks

Running the suite once an hour turned the checks into their own experiment, and
the first night's verdict was damning: **5 failures in 26 runs**, none of them
the data. Two Binance markets reported unjudged after a transient ccxt error;
`binance/perp` returned 0.895 once at n=3, which a direct comparison against
Binance's own REST endpoint could not reproduce (1.000 / 1.004 / 0.997 at ±0.05
/ ±0.1 / ±0.156%, eight samples); Coinbase straddled agreement at n=3;
Hyperliquid straddled it at n=15 on a ±0.025% band; and one Hyperliquid layer
reconciliation came back 1.0153 while the other nineteen were exactly 1.0000.

A checker that fails one run in five trains you to ignore it, so each cause was
answered where it lived, and none of them by relaxing a global threshold:

- **The narrow-band instruments take 15 samples,** not 3. The band is not a
  choice — it is however far ccxt's book reaches, ±0.16% on Binance perp and
  ±0.025% on Hyperliquid — and at that width a couple of orders are the whole
  measurement.
- **Tolerance is per instrument, derived from its measured noise** (see the MEXC
  spot note below for what that measurement looks like). This is the honest
  version of the trade: on those instruments the check can prove there is no
  order-of-magnitude or systematic error, and cannot prove there is no 10% one.
  A missed contract multiplier is 100x and still screams.
- **A failure to measure is retried once** before it counts as unjudged, and the
  output says `[measured on the retry]` so a venue that needs it every time
  stays visible.
- **`verify-hyperliquid` re-reads before it accuses.** Its six layers are fetched
  together but are not one atomic snapshot, so the book can move between the
  first response and the last. A stitch bug is wrong on every read; skew is not.
  A layer is only reported when it fails three independent reads — verified by
  injecting both a transient fault (recovered on read 2, exit 0) and a permanent
  one (still off after 3 reads, named, exit 1).

Three samples still could not find MEXC spot's median — it read 0.648 on one
full run — so that instrument alone takes 15 by default. And when a sample's own
p05..p95 straddles agreement, the run reports **INCONC** rather than FAIL: it has
failed to measure a disagreement, which is not the same as finding one. Neither
an inconclusive nor a skipped venue counts as a pass, and either makes the run
exit non-zero.
