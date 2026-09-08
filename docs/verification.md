# Verification

[← README](../README.md) · [Architecture](architecture.md) · [Verification](verification.md) · [Deployment](deployment.md) · [Adding an exchange](adding-an-exchange.md)

The tool has one product: an order book that is right. A chart that renders
beautifully with the wrong numbers is a worse bug than one that crashes,
because it does not announce itself. Everything here exists to make a wrong
number announce itself.

## What the tests cover, and what they cannot

`npm test` is eleven suites, 400 assertions, no network and no browser — they
run in CI on Node 20 and 22 on every push:

| suite | what it pins |
|---|---|
| `test-book` | `BookSide.applySnapshot`: whether accumulated depth survives a resync, and when it must not |
| `test-stitch` | the Hyperliquid layer reconciliation and its cumulative identity |
| `test-trim` | that reducing the payload preserves cumulative quantity, notional, VWAP **and reach** |
| `test-adapters` | every venue's decoder and unit conversion, replayed from real recorded frames — the OKX contract multiplier and its inverse form, MEXC's hand-written protobuf reader and contract size, Binance/Aster's `depthUpdate`, Bitunix's candle-summed volume, and the Coinbase and Lighter gap-recovery paths |
| `test-reconnect` | the socket liveness watchdog: a path that proves nothing is dropped, and a quiet book whose venue still answers a ping is left alone |
| `test-diff-book` | the sequencing engine five feeds share: the anchor after a snapshot, gap detection, resync — replayed from ids captured live on Binance perp |
| `test-metrics` | every number in the panel — depth, VWAP, imbalance, the truncation flags |
| `test-conformance` | one lifecycle contract, applied to **all thirteen feeds** (see below) |
| `test-limits` | what one client may hold: the feed quota, the socket counter, the token bucket's burst, refill and ceiling |
| `test-health` | the sample ring, the window deltas, and a Prometheus exposition that survives an exchange-chosen symbol |
| `test-recording` | the tape's format: a raw round trip, a crashed capture that must not read as finished, and the gaps that would ruin a distribution |

The last two were written after the fact, for the two functions that had no
coverage at all despite producing everything on screen. Writing them was worth
it immediately: `computeMetrics` was dropping a level sitting **exactly** on a
boundary, because `|95/100 - 1| * 100` is `5.000000000000004` in binary floating
point, so the "-5% depth" figure excluded the very level that defines it. Round
numbers are exactly where real books put size.

### One contract, thirteen feeds

`test-adapters` proves the **decoders** — a field is read, a multiplier applied,
a side not swapped. It says nothing about the **lifecycle**, and every lifecycle
bug this repo has had was found in production on one venue and then fixed on
that venue alone: a Hyperliquid layer that dropped out kept its last snapshot in
the stitch forever and served frozen depth as live; MEXC published `Date.now()`
where the venue's clock belonged; Binance perp stayed pinned to its REST
snapshot from the day it was written. Each of those is tested — on the adapter
it happened to. The next one will land somewhere else.

`test-conformance` asks the same questions of all eight adapters, driving each
through a fake transport and a **gated** fetch stub, from recorded payloads:

- nothing is published before the venue has said anything — the gate is what
  makes this a real question, since five adapters fetch a snapshot at open and
  would otherwise answer themselves before the test could look;
- every book is sorted outward from mid, positive, uncrossed, two-sided, and
  says which transport it came from;
- the clock is the venue's or it is `null`, **never this process's** — checkable
  without knowing each venue's field, because a recorded stamp always predates
  the test run and `Date.now()` never does;
- a connection reported down stops contributing depth: no book at all on a
  single-socket venue, a book that reaches **less far** on Hyperliquid, which is
  the honest answer and was the bug;
- `close()` is idempotent, closes every transport it opened, publishes nothing
  afterwards, and leaves no timer behind.

Writing it found six real defects, none of which any existing test could see:
the five diff-book venues could not be driven through their own `open()` at all
(the transport seam was on the engine's config and no adapter forwarded it);
five adapters published books during the closing handshake, when a socket has
been asked to close but frames are still arriving; and OKX and Bitunix each left
a pending poll timer holding the event loop after `close()` — a second and five
seconds of shutdown per feed, for a response that would be discarded.

**And a test suite is worth what it catches.** Six deliberate breaks, one at a
time, all six caught: Hyperliquid publishing after close, Coinbase stamping
`Date.now()` instead of the venue's clock, Bitunix leaving its poll timer, a
dead Hyperliquid layer keeping its depth in the stitch, Lighter shipping an
unsorted side, and OKX forgetting to close its socket.

One thing the suite could not have without new fixtures: a snapshot and the diff
frame that anchors to it. Recording the two separately and renumbering one onto
the other produces a book that **crosses** — the captures are minutes apart, so
applying later diffs to an earlier book puts a bid above an ask. That looks
exactly like an adapter bug and is not one; it is a fixture that was assembled
instead of recorded. `capture-fixtures.mjs` now takes the pair the way the
adapter does — subscribe, buffer, fetch, keep the first frame that satisfies the
venue's own anchoring rule — so what lands in the file is one coherent instant.

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
npm test                           # 400 assertions, no network, eleven suites
npm run crosscheck                 # tools/crosscheck-ccxt.mjs: ccxt as an independent second opinion (server must be up)
npm run crosscheck -- mexc --repeat 20   # sample one venue repeatedly and report the ratio distribution
npm run verify:bitunix             # the venue ccxt cannot judge, checked against itself and its peers
npm run checks                     # every proof here in one run, for a timer; non-zero if any fails
npm run measure:drift -- --check   # re-derive the distributions two thresholds rest on
```

### A check that cannot report is not a check

Both spawners here ran without a timeout until a venue's ccxt child hung for
over an hour and took the whole hourly run with it — no verdict, no log line,
nothing in `logs/checks.log`, just a unit waiting for `TimeoutStartSec` to kill
it without a word. `crosscheck-ccxt.mjs` now bounds each venue's child
(`DEPTHVIZ_CROSSCHECK_TIMEOUT_MS`, five minutes; the worst legitimate case is 15
samples eight seconds apart) and `run-checks.mjs` bounds each check
(`DEPTHVIZ_CHECK_TIMEOUT_MS`, fifteen). A killed child is "not judged", which
already exits non-zero — an absent measurement was never a passing one.

## Re-deriving a threshold instead of believing it

Every threshold here is supposed to come from a distribution somebody sampled,
with the sample written next to it. Two of them are — OKX's 3% drift trigger and
Bitunix's *refusal* of a threshold — and both were measured once, by a script
that no longer exists. That is a guess with a good story: the venue changes its
cadence, the distribution moves underneath, and the constant keeps looking
measured.

`tools/measure-drift.mjs` reads `drift` off `/api/depth` — the same figure the
adapters compute and the panel shows, not a second implementation — builds the
distribution, writes it to `logs/measurements/`, and with `--check` asserts the
two claims the code actually rests on: that `DRIFT_TOLERANCE` is still at least
`DRIFT_P95_FACTOR` (20) times the measured p95, and that Bitunix perp's median
stays under the 2% CLAUDE.md claims for it. Both constants are **imported from
the adapter**, not copied: a threshold quoted in one file and used in another is
a threshold nobody is checking. Neither a SKIP nor an INCONC counts as a pass —
under ten samples is not a distribution, and it exits non-zero saying so.

It taught something on its first two runs, which is the point of writing it.
The three-minute run failed:

```
       okx spot BTC-USDT          median 0.000%  p95 0.163%  max 6.173%  n=177
       okx perp BTC-USDT-SWAP     median 0.000%  p95 0.182%  max 0.591%  n=177
FAIL   okx spot BTC-USDT          tolerance 3.000% vs 20x p95 = 3.260%
```

against a source that records p95 ≤ 0.093%. Twice as wide: the venue had moved,
or the threshold had rotted. Neither. Fifteen minutes on the same instruments at
the same cadence, an hour later:

```
       okx spot BTC-USDT          median 0.000%  p95 0.023%  max 2.007%  n=895
       okx perp BTC-USDT-SWAP     median 0.000%  p95 0.008%  max 8.069%  n=896
       okx perp ETH-USDT-SWAP     median 0.000%  p95 0.007%  max 3.235%  n=896
       bitunix perp BTCUSDT       median 0.199%  p95 1.659%  max 2.721%  n=892
PASS   every threshold still holds against a fresh sample
```

**A p95 over 177 points is the ninth-largest value**, so two transient spikes
set it; over 895 it is the forty-fifth and they do not. The short sample was not
measuring the venue, it was measuring its own length — and it produced exactly
the shape of a real regression, which is the dangerous kind of wrong. 3% is 130x
the widest of the long-run p95s, comfortably past the 20x the rule asks for.

So the gate refuses a sample too small for the statistic it uses: under 500
readings the p95 targets report INCONC, which already exits non-zero, and the
default run is fifteen minutes. A median settles far sooner, so Bitunix's check
needs only ten. `run-checks` runs the tool **without** `--check` — every hourly
run writes its distribution to `logs/measurements/` and says nothing, building
the sample nobody had — and `--check` stays for a deliberate re-derivation with
enough minutes behind it.

## A recording, so a measurement can be made twice

`tools/record.mjs` writes the venue's **raw** book to JSONL — not the reduced
payload, because a form that is exact in cumulative notional and wrong about the
price a given size walks to is the wrong thing to keep forever. It opens the
venue itself rather than reading this server's socket, and that cost is stated
plainly: it spends the same IP's rate-limit budget. `tools/replay.mjs` reads it
back through the same `shared/metrics.js` the panel uses and reports gaps before
it reports anything else — a capture that lost four minutes to a reconnect has a
plausible book on either side of the hole, and a distribution computed straight
across it silently mixes two regimes.

Two habits from earlier incidents are not optional in it: every dependency is
asserted **before** any collecting starts, and the file is written as `.part`
and renamed only after an end marker. A partial JSONL is byte-for-byte plausible
— same header, same book lines, nothing missing but the end — and a waiting loop
that concluded from a file's size that a capture had finished has already cost
this repo half an hour.

```
$ node tools/replay.mjs data/binance-spot-BTCUSDT-2026-09-08T17-07-54.jsonl
binance spot BTCUSDT
  samples        60 over 1.0 min, every 1000ms
  levels         9894..10111 (both sides, before reduction)
  venue clock    missing on 1/60 samples
  complete       yes
  gaps           none

over ±2%, n=60
  total depth      median  $42.65M   p95  $49.69M   min  $38.70M   max  $50.19M   n=60
  spread           median 0.001 bps  p95 0.001 bps  min 0.001 bps  max 0.027 bps  n=60
  venue→us ms      median   117 ms   p95   186 ms   min    57 ms   max   209 ms   n=59
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

Until `test-adapters.mjs` existed, this cross-check was the *only* thing
watching seven of the eight adapters: `diff-book` and Hyperliquid's `stitch`
were the sole adapter code with a deterministic test, and every decoder, every
unit conversion and every sequence rule rested on an hourly check that cannot
run in CI and that SKIPs when a venue has a bad minute. A renamed field would
have sailed through until somebody read the log.

That suite now replays a real recorded frame from each venue —
`tools/fixtures/venues.json`, produced by `tools/capture-fixtures.mjs`, never
hand-written. It has teeth, which was checked the only way that means anything:
seven mutations were introduced one at a time and every one was caught — the
linear multiplier dropped, an inverse contract treated as linear, MEXC's
`contractSize` dropped, MEXC's protobuf clock discarded, a Bitunix candle
straddling the cutoff counted whole, Coinbase's gap detection disabled, and
Lighter's nonce chain ignored.

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
