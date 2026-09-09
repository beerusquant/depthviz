# CLAUDE.md — depthviz

> Rules specific to this repo. They refine the global CLAUDE.md, they do not
> override it.
> Every rule below was born from a real mistake or a measurement made in this
> repo: if you add one, add the evidence with it.

---

## 1. The data comes before the display

This tool has exactly one product: a correct order book. A chart that renders
beautifully with the wrong numbers is a worse bug than a broken chart, because
it does not announce itself.

- **A book size is in base units, always.** Three venues do not quote that way:
  OKX SWAP (`ctVal * ctMult`, and `/ price` on inverses), MEXC perp
  (`contractSize`), Hyperliquid spot (contexts keyed by `ctx.coin`, **never** by
  index — positional alignment gives −99.9% error). A forgotten conversion is an
  invisible 100x error: the chart stays beautiful, only the zeros change.
  Aster and Lighter quote in base units (ccxt `contractSize` = 1, `multiplier`
  = 1.0 across all 242 Lighter markets) — verified, not assumed. Lighter is
  addressed by numeric `market_id` rather than by symbol: resolution goes
  through its own market list, never through an index.
- **No number without a protocol.** A depth figure is stated with its venue, its
  band (±x%) and the instant. "$70M of depth" means nothing.
- **Any depth beyond ±0.6% on Binance, MEXC and Aster is a lower bound**, not a
  fact. Those books only grow past their snapshot by accumulating diffs: levels
  that were there before we connected and were never touched again are invisible
  to us forever. The figure can only go up. The UI says so; the code must not
  forget it.

## 1 bis. Never invent a clock

A book carries two timestamps and they are not interchangeable: `tsVenue` is the
exchange's own event time, `tsRecv` is when the frame reached this process. An
adapter reports the venue's time **or `null`** — never `Date.now()` as a stand-in.
Filling it locally makes a feed with no clock look identical to one with a
perfect one, and prints an upstream latency of zero, which is exactly the kind of
number nobody questions.

Writing that rule found a real bug: **MEXC reported no venue clock on either
market while the venue was stamping every frame** — `data.cts` and `msg.ts` on
perp, field 6 of the spot protobuf, all three dropped by the decoders. Both feeds
now measure ~90–120 ms. The delta is displayed raw, negative included: a negative
one is clock skew against the exchange, which is information, not noise.

Coinbase used to be the one exception to gap detection and no longer is: its
Exchange `level2_batch` feed carried no sequence number at all, so a dropped
update left a wrong level standing with nothing to say so. Advanced Trade's
`level2` channel is equally public and numbers every frame — per **connection**,
not per channel, so the subscription acknowledgement consumes one too and the
counter must be tracked on every message, control frames included. Same book
(22 433/21 457 levels on BTC-USD), venue clock down from ~43 ms to ~5 ms.

Corollary: `state` is not health. It is set by the last status event, so a feed
that reconnects every thirty seconds reads `live` between drops. The measurement
that cannot lie is the age of the last book — `/api/feeds` reports it, and the
panel refreshes it every second so a dead feed cannot freeze its own staleness.

## 1 ter. A snapshot is a point in the stream, not an event boundary

The version a REST snapshot reports can land *inside* an event's `[from, to]`
range or in the **gap between two of them**, so the event that resumes the chain
is found by a range test, never by an equality — and it may arrive at any time,
including after the snapshot has already been applied.

That last clause is the whole lesson. The engine looked for the anchoring event
only among the frames buffered *while the snapshot was in flight*; the first
event to arrive afterwards was judged with the strict contiguity rule, which it
can never satisfy. Measured on Binance perp on 2026-09-08: the book had been
pinned to its REST snapshot **since the adapter was written** — reach ±0.18%
instead of ±3%, `clock=none` because only snapshot frames were ever published,
`src=ws` on what was really a resync loop, and a weight-20 REST depth call every
~400 ms for as long as the feed was open. Nothing in the UI said a word: the
chart was a perfectly plausible order book, one thousand levels wide.

The tell was in `smoke-feeds.mjs` output all along — `lv=1000/1000`, exactly the
snapshot limit, next to a spot feed showing `lv=5085/4943`. **A level count that
equals the venue's REST cap exactly is a book that has never applied a diff.**
`tools/test-diff-book.mjs` replays the captured ids and pins both styles.

## 2. ccxt is a judge, never a source

`fetchOrderBook` returns OKX and MEXC sizes in **raw contracts**: ccxt exposes
`market.contractSize` and does not apply it. Reading a book straight from ccxt is
a 100x error on `BTC-USDT-SWAP` and ~780x on the inverse `BTC-USD-SWAP`.
Measured, not assumed.

OKX's own integrity check is not available to us either: the `books` channel
still carries a `checksum` field and it is **`0` on every frame** — snapshot and
update alike, measured live on 2026-09-08. The deep tick-by-tick channels that
do populate it need VIP4. So the cross-transport drift measurement stays; do not
spend another afternoon implementing CRC32 for it.

ccxt remains valuable as a **second independent implementation** our
hand-written adapters can be wrong against: `npm run crosscheck`. On contract-denominated
venues the **expected ratio is the multiplier, not 1**.

ccxt carries `aster` and `lighter`: both perp DEXs therefore have an external
judge, and their expected ratio is 1 (no contracts).

**Bitunix is not in ccxt** — rechecked against 4.5.78, the current release — but
it is no longer unjudged. CoinGecko runs its own integration against the same
exchange (`/exchanges/bitunix/tickers` and
`/derivatives/exchanges/bitunix_futures`), so it is a genuine second reader:
`verify-bitunix` now compares our mid, and our 24h volume on both markets,
against what an outsider sees. Measured on first run: spot mid +0.13%, perp mid
+0.09%, spot volume ratio 1.004 (the figure that had no judge at all, since
Bitunix publishes no spot ticker and the adapter sums candles), perp volume
1.006. CoinGecko has no order book, so **depth stays judged only by the venue
against itself** — an unreachable or rate-limited judge reports INCONC and exits
non-zero, exactly as a ccxt failure does.

## 2 bis. A tolerance is a measurement, not a taste

Every threshold in this repo has to come from a distribution somebody sampled,
and the sample has to be written down next to it. Two were guesses and both were
found the same week:

- **OKX's ws-vs-REST drift trigger was 15%.** Sampled once a second for ~3
  minutes on BTC-USDT spot, BTC-USDT-SWAP and ETH-USDT-SWAP (n=169 each), the
  real distribution is **median 0.000%, p95 ≤ 0.093%, max 6.24%**. With three
  consecutive breaches required, 15% could not fire on anything short of a
  catastrophe. It is 3% now — thirty times the p95, five times tighter than the
  guess, and a state no spike in that sample ever reached three times running.
- **MEXC spot was judged on ±0.5% with a 0.5–2.0 tolerance**, which is not a
  check, it is a shrug. The venue's own REST book, read twice one second apart,
  disagrees with itself by p95/p05 of **1.51x at ±0.25% and 8.89x at ±2%** — so
  past ±0.25% MEXC is simply not a reference. It is judged at ±0.25% now, at the
  normal tolerance. Our own book was never the problem, and that was measured
  too: against MEXC's REST read at the same instant it comes in at **median
  0.982**, closer than MEXC's book is to itself a second later.

A third threshold was asked for and the data refused it. Bitunix perp's
ws-vs-REST drift, sampled every 5 s for 20 minutes on four instruments over
±0.5% of mid: BTCUSDT median 0.288% / p95 1.84%, ETHUSDT 0.587% / 2.20%,
**SOLUSDT 3.419% / 11.45%**, DOGEUSDT 1.046% / 4.43%. SOL's p95 is four times
BTC's maximum — an order of magnitude apart, so no single number fits, and one
picked anyway would be silent on BTC and permanently breached on SOL. It is
judged in `verify-bitunix` on the **median of ten readings of the default
instrument** instead, where the whole measured range sits under 2%. Not every
measurement earns a threshold; saying so is the answer, not picking one.

That measurement also caught its own bug first: the adapter read our ws book
*before* sending the REST request, putting the whole round-trip into the skew —
the mistake `crosscheck-ccxt` had already been fixed for. Reading it when the
response lands took BTC from median 0.669% to 0.288% and its worst case from
6.4% to 2.8%. **Compare two books at one instant or not at all.**

Corollary: when a check is loose, ask whether the venue is unstable before
widening it further. Widening a tolerance to accommodate someone else's variance
buys silence, not confidence — and the wide band is what made that check blind
to anything under a 2x error.

## 2 ter. A venue's payload is recorded, never imagined

`tools/fixtures/venues.json` holds one real frame from each venue and
`tools/test-adapters.mjs` replays them, so a decoder or a unit conversion can be
wrong in CI instead of only in production. Two rules come with it:

- **Re-record with `tools/capture-fixtures.mjs`, read the diff, then change the
  adapter.** A fixture edited by hand to match new code proves nothing — it is
  the same failure as a screenshot drawn instead of captured.
- **A test suite is worth what it catches.** This one was checked by mutation:
  seven deliberate breaks, one at a time, all seven caught — linear multiplier
  dropped, inverse contract treated as linear, MEXC `contractSize` dropped, MEXC
  protobuf clock discarded, a Bitunix candle straddling the cutoff counted
  whole, Coinbase gap detection disabled, Lighter nonce chain ignored. Do that
  before believing a green suite.

Adapters expose one seam for this and no other: `opts.connect`, a transport
factory the tests pass in. The hub only ever builds `opts` as `{ range }`, so
nothing in production reaches it. Do not use it to inject venue behaviour.

## 2 quater. A measurement nobody can repeat is a guess with a story

Every threshold above came from a distribution sampled once, by a script that no
longer exists. That is not a measurement — it is a number with a good anecdote
attached: the venue changes its cadence, the distribution moves underneath, and
the constant keeps looking measured.

- **A threshold that is checkable must be checked.** `tools/measure-drift.mjs`
  re-derives the two that are, reading `DRIFT_TOLERANCE` and `DRIFT_P95_FACTOR`
  **from the adapter** rather than copying them: a threshold quoted in one file
  and used in another is a threshold nobody is checking.
- **A quantile needs enough sample to be that quantile, and a short run
  produces the exact shape of a real regression.** Measured 2026-09-08 on the
  same instruments at the same cadence, an hour apart: **3 min, n=177 → OKX spot
  p95 0.163%** (FAIL against the 3% tolerance) and **15 min, n=895 → p95
  0.023%** (PASS, 130x margin). A p95 over 177 points is the ninth-largest
  value, so two spikes set it; over 895 it is the forty-fifth and they do not.
  Nothing about the venue had changed. The gate now refuses under 500 readings —
  INCONC, which exits non-zero — and the hourly run records the distribution
  while arming nothing. Relaxing a factor until a check goes green is buying
  silence; so is widening a tolerance. Say "not proven", then go and take a
  longer sample.
- **A book that was not recorded cannot be measured twice.** `tools/record.mjs`
  writes the venue's **raw** book to JSONL and `tools/replay.mjs` reads it back
  through the same `shared/metrics.js` the panel uses. Record the raw book, never
  the shipped one: the reduction is exact in cumulative notional and wrong about
  the price a size walks to, which is the question most worth asking of an
  archive.
- **`.part` until an end marker says otherwise, and gaps before figures.** A
  partial JSONL is byte-for-byte plausible, and a distribution computed across a
  four-minute hole mixes two regimes while looking perfectly clean.

## 2 quinquies. A lifecycle bug is fixed on one venue and lives on in seven

Every one of them was found in production on a single adapter: Hyperliquid's
dead layer serving frozen depth, MEXC's invented clock, Binance perp pinned to
its snapshot. Each is now tested — on the adapter it happened to.

`tools/test-conformance.mjs` asks the same questions of all thirteen feeds:
nothing published before the venue has spoken (the fetch stub is **gated**, or
five adapters answer themselves before the test can look), books sorted,
positive, uncrossed and two-sided, the clock the venue's or `null` and never
this process's, a connection reported down no longer contributing depth, and
`close()` idempotent, closing every transport, publishing nothing afterwards and
leaving no timer behind.

Writing it found six real defects at once — the five diff-book venues could not
be driven through their own `open()`, five adapters published during the closing
handshake, and two left a poll timer holding the event loop after `close()`. Six
deliberate breaks, all six caught. Add a venue to the table when you add an
adapter; a contract that covers twelve of thirteen feeds is a contract about
nothing.

Corollary, learned the expensive way: **a fixture is recorded, never assembled.**
A snapshot and a diff frame captured minutes apart and renumbered onto each other
produce a book that CROSSES — which reads exactly like an adapter bug. Capture
the pair the way the adapter takes it.

## 2 sexies. A figure without its qualification is not a figure

Three numbers in this repo were printed as facts and were not, and none of the
three announced itself:

- **A depth is a measurement only if the book reaches the distance it is quoted
  at.** Bitunix caps its spot book at 50 levels, ~±0.05% of mid, so `-2% Depth`,
  `-5% Depth` and `Total Depth` were the same number rendered as three separate
  measurements — `shortBid`/`shortAsk` are judged against the SELECTED range,
  and those two thresholds are fixed. `computeMetrics` now returns `lowerBound`,
  keyed by the field it qualifies, and the panel prints a `≥`. The value is
  kept, not nulled: a book reaching 1.9% is a useful floor for its ±2% depth.
- **`reach` was the walk's own loop bound, not the book's.** The walk stops at
  `max(range, 5)` for cost, and `reach` was read off it — so a book extending to
  ±20% reported exactly 5.000 at any range under 5, in the field documented as
  how far the book goes. It is O(1) now, off the last level, because a side is
  sorted outward from mid. Measured on Binance spot: 5.000 before, 20.001 after.
- **A swallowed failure leaves the previous value standing, and it looks
  identical to a fresh one.** `vol24h` is refreshed behind a `catch {}` on
  purpose — a ticker having a bad minute must not kill a healthy book — and so
  is the ws-vs-REST `drift` on OKX and Bitunix. Both now carry the instant they
  were last actually read (`vol24hAgeMs`, `driftAgeMs`), and the stamp moves
  only on a success. Same rule as `tsVenue` in §1 bis: the honest answer to "we
  do not know" is to say so, never to serve the last thing we knew as current.

## 2 septies. A book that crosses is not a book

Nothing in this process refused one. `bids[0][0] >= asks[0][0]` — the shape a
mis-sequenced diff stream takes — computed a mid inside a negative spread, a
spread of -2.00%, and two depth curves over prices they share. The chart stays
beautiful, which is this repo's definition of the worst kind of bug, and the
conformance suite already asserted the invariant on the way OUT of an adapter
while nothing checked it on the way IN to the hub.

`Feed.onBook` is the one gate every book passes, and it now refuses three
things and COUNTS each: `empty` (one-sided), `badMid`, `crossed`. Refusing
freezes the feed rather than advancing it with a wrong book, which is the
intended trade — `ageMs` then grows where anyone can see it, and `rejected` says
which of the three it was. `crossed` gets its own Prometheus series, because
`empty` is a feed with nothing to say and `crossed` is a feed saying something
wrong: different news, different fix.

## 2 octies. A sum across venues is four lies in a trench coat

Adding depth across exchanges by hand is wrong in four ways, and every one of
them produces a total that looks right. `server/aggregate.js` exists so each is
reported rather than hidden, and it is a pure module for the same reason
`quota.js` is one — joining feeds opens sockets, so a rule kept with them can
only be tested against the live internet.

- **Every venue has its own mid**, so "±2% of mid" is a different band of prices
  on each and their sum is the depth inside no range at all. One reference mid
  is taken — the **median**, so a dislocated or stale venue cannot drag it — and
  every venue is measured on the same ABSOLUTE band (`notionalWithin`).
- **The books are not simultaneous.** They arrive on independent feeds, so a sum
  is a mosaic of photographs. `asOf.spanMs` says how far apart they were read.
  Measured live on BTC perp: 1.7–3.5 s, most of it from venues whose books
  genuinely do not move often — which is the honest answer, not a defect.
- **A leg that failed must not simply be absent**, because a sum missing one
  looks exactly like a whole one. Failures are named in `missing` with a reason
  and `complete` goes false.
- **A floor in the sum makes the sum a floor**, and there are two ways to get
  one: a book that ends inside the band, and a feed still rebuilding depth from
  a capped snapshot. The second is the one that bites — measured on BTC perp,
  Binance showed **$84M at 1 s old and $511M at 141 s**, on the same band, with
  the venue unchanged. Without the flag that reads as a venue nobody trades on.
  `lowerBound.reasons` says which of the two it was.

Five deliberate breaks — median to mean, per-venue bands, `complete: true`,
`spanMs: 0`, a floor not propagated — all five caught by `test-aggregate.mjs`.
Do that before believing it.

## 2 nonies. The microprice is exposed; the bands stay on the mid

A resting book is not symmetric around `(bid+ask)/2`: when the bid carries ten
times the ask's size, the next trade is far likelier to lift the ask, and the
microprice — each side weighted by the OPPOSITE side's quantity — is where the
touch actually is. This tool never showed it.

It is reported, and the depth bands are **still anchored on the arithmetic
mid**. Moving them would make every depth figure here incomparable with ccxt,
with the venues' own reporting, and with this repo's own recorded measurements —
a definition change dressed as an improvement. What a reader needs instead is
how much that choice costs on the book in front of them, which is
`micropricePct`: at 0.0001% it changes nothing, at 0.05% the ±2% band is shifted
by a fortieth of its width and they should know. Pinned on a level that lands
between the two possible anchors, which is the only place the choice is
observable.

## 3. A check that cries wolf is worse than no check

- **Neither a `SKIP` nor an `INCONC` counts as a pass.** Both are an absence of
  proof and exit non-zero. On a day when everything skips, the summary must not
  say "all good" — it said that once, and it was false.
- **A check that fails has to say WHY, not just that.** `verify-bitunix` reported
  `only 0/10 readings` and nothing else — the same sentence for a rate-limited
  request, a refused connection, a venue that stopped answering, and an adapter
  that simply had not measured yet. Four problems, four different fixes, one
  message, and an evening spent guessing on 2026-09-09 before the check turned
  out to be intermittent and passed on its own. It counts the reasons now and
  prints the breakdown with the URL. A `catch {}` around a sample is how a check
  becomes an oracle nobody can question.
- **A check that never returns is worse than one that fails.** No verdict, no
  log line, no exit code — just a unit sitting there until systemd kills it
  silently. Measured on 2026-09-08: `crosscheck-ccxt` spawns a child per venue
  with no bound of its own, one of them hung for **over an hour**, and the
  twelve checks behind it never ran. Both spawners take a timeout now
  (`DEPTHVIZ_CROSSCHECK_TIMEOUT_MS`, `DEPTHVIZ_CHECK_TIMEOUT_MS`) and a killed
  child is reported as not judged, which already exits non-zero. Any tool that
  spawns or waits gets a bound, and the bound has to *report* rather than only
  stop.
- **One sample is not a verdict.** On a thin book a reading can be 2x the next
  one with nothing broken. MEXC spot came out `FAIL 0.648` at n=3 while two runs
  of n=20 put it at median 1.000. We judge on the **median**, and thin
  instruments take more samples.
- **We compare on the band both sources reach.** Charging us for depth ccxt
  never fetched turns our advantage into a false bug.

## 3 bis. An assembled book is proven layer by layer

Hyperliquid is the only **assembled** book rather than a read one: no endpoint of
the venue will ever reveal that it is wrong. The first stitch used only `{}`,
`{3}` and `{2}` and **discarded any coarse bucket that did not clear the fine
layer by a full bucket width**. Measured result: at ±0.13% of mid on BTC, the
chart showed **0.152 of the real depth**. A hole, not a rounding error.

- **Each layer is a complete measurement out to its own edge**: layers are
  reconciled on **cumulative quantity**, never cut on price boundaries. The first
  coarse bucket that reaches past the fine edge is worth
  `cumulative_coarse − cumulative_fine`.
- **We compare on the price grid of the layer being judged**, not on an
  arbitrary ±x%: cutting at ±10% penalised the stitch for having resolved the
  band better — my first criterion cried wolf (1.0492) while the code was exact.
- `npm run verify:hyperliquid` and `tools/test-stitch.mjs` guard both
  properties.

## 3 ter. A permanent warning is no longer a warning

The note under the chart appears **only when the book does not reach the
requested range** — it then says where it actually stops (`book ends at ±0.068%
of ±2%`) and why. Before, the venue note was shown on every render: a permanent
amber box on Hyperliquid, Bitunix and Aster. A warning that is always there
becomes wallpaper, and stops being read at the exact moment it matters.
`smoke-ui.mjs` tests both directions: Bitunix spot at ±2% must shout, Coinbase at
±2% must stay silent. The chart itself never draws anything beyond the data.

## 4. Do not take a tool at its word

`smoke-feeds.mjs` reported **all 11 feeds dead** in production while the service
was healthy: it targeted a hardcoded port. Two lasting consequences:

- **No tool hardcodes a port.** The three that go through the websocket read
  `DEPTHVIZ_URL` (default `ws://127.0.0.1:8787/ws`); `smoke-ui.mjs` and
  `shoot.mjs` read `DEPTHVIZ_HTTP` (default `http://127.0.0.1:8787`). Against
  production: port 8888.
- **A connection error must name the URL it actually tried.** Without that, a
  configuration mistake reads as an application outage.

Corollary: when a check fails, first ask whether the check is the thing that is
wrong. Here `verify-bitunix` and the live books were passing at the same instant —
the inconsistency was the signal.

## 5. Reducing the payload must never reduce the reach

`hub.trim` kept the 2 500 levels **nearest to mid**, which cut the tail rather
than the weight: Binance spot shipped ±0.62% of a book that reached ±11%, i.e.
**64% of the depth inside ±10% thrown away** (Coinbase 38%, Bitunix perp 19%).

The correct form is a `[vwapPrice, summedQty]` bucket: it preserves cumulative
notional, cumulative quantity and VWAP **exactly**, since
`vwapPrice * summedQty === Σ(price * qty)` by construction. Any future reduction
must preserve that identity, otherwise it lies.

What it does **not** preserve is the inverse function — the price a given size
walks to *inside* a bucket, where the reduced curve is a straight line and the
real book is a staircase. Measured on a book decaying at `exp(-0.6d)`: exact to
1e-12 at ±2%, ±5% and ±10%, 0.082% off at a range that is not a report edge, a
few basis points off on a walk. Invisible on a chart; the whole question for
anyone sizing an order. So the hub keeps the venue's book as it arrived,
`/api/depth?levels=raw` serves it, and figures computed from it say
`metricsFrom: "raw"` rather than leaving a caller to work out which book they
got.

Corollary: **the reduction belongs on the way out, not on the way in.** It used
to run on every book an adapter published, while the hub threw most of those
away at its own throttle — the two run on independent phases — and a feed with
no viewers was reduced for an audience of zero. It runs in `payload()` now,
memoized on the book's sequence: once per book actually shipped.

## 6. A resync must not erase what it cannot see

A snapshot is authoritative **within its own price range**, not beyond it.
Clearing the book on every resync destroyed reach accumulated over several
minutes, and a single sequence gap silently took the chart back to ±1.1%.

Keeping the tail imposes two guardrails, non-negotiable: a kept level must have
been seen less than 5 minutes ago, and the whole tail is dropped if the outage
exceeded 30 s. Without them, an order cancelled during the outage becomes phantom
depth — overstating is worse than understating. Covered by `npm test`, no
network.

## 7. Exposure and deployment

- **The app has no authentication, and every visitor makes the host open
  connections to eight exchanges from its IP.** On a machine that runs something
  else, that is someone else's rate-limit budget being spent by a stranger
  cycling through symbols — and an IP whitelisted at an exchange is expensive.
  So `HOST` defaults to `127.0.0.1` and exposure is an explicit choice.
- **A global ceiling protects the host, not the other viewers.** 48 feeds was
  one cap for everybody: one client cycling a symbol list took every slot, each
  lingering 30 s after it let go, and everyone else was refused by a server
  behaving exactly as designed. The accounting is per remote address now — 12
  feeds, 24 sockets, a token bucket on the two routes that reach an exchange —
  and joining a feed somebody already holds is free, because two viewers on
  BTCUSDT are one upstream connection. It lives in `server/quota.js` and not in
  the hub for a reason that is not cosmetic: constructing a Feed opens sockets,
  so a rule written inside the hub can only be tested against the live internet.
- **A refusal is a 429, never a 504.** This server saying no and the venue being
  unwell are different answers and a caller has to be able to tell them apart.
- **Sizing a limit that fires on legitimate use is how limits get raised in
  anger.** The first bucket (10 burst, 1/s) throttled this repo's own
  measurement tool. What actually bounds the cost to an exchange is the feed
  quota — a feed is one connection however often it is asked for — so the bucket
  only has to stop a tight loop. 20 burst, 5/s.
- **The burst nobody was pacing, measured 2026-09-08:** twelve feeds opened at
  once from one client is enough for **Binance itself to answer 429** on the
  snapshot calls (weight 50 each). The per-client cap bounds how many feeds
  exist; it says nothing about the burst of REST snapshots that opening them
  produces. Every adapter reaches a venue through `fetchJson`, so the bound
  lives there and is written once instead of eight times: four calls in flight
  per exchange HOST, a bounded queue, and a refusal that names the host rather
  than an unbounded queue that silently degrades. Exposed as
  `depthviz_upstream_{inflight,queued}`.

  **Concurrency is a bound; spacing would be a threshold.** Four simultaneous
  requests to one venue is defensible by construction. A minimum gap between
  requests is not — it needs a distribution, and none has been sampled — so
  `DEPTHVIZ_UPSTREAM_GAP_MS` exists, ships at `0`, and stays there until
  somebody measures what the venues tolerate. Per §2 bis: not every measurement
  earns a threshold, and saying so is the answer.

  **Proven live 2026-09-09**, because a limiter checked only against a stub is a
  limiter checked against itself: fourteen concurrent symbols at one server, all
  Binance spot — **12 served, 2 refused with a 429 that says what to do, 0 from
  Binance**, 1 730 ms wall for twelve feeds and twelve weight-50 snapshots. Redo
  it with `tools/` or a dozen curls; the number that matters is the third one.

- **A counter with no memory answers the wrong question.** `reconnects: 1284` is
  a total since the feed opened; whether anything is wrong now is a delta, and
  one reading cannot produce one. Each feed keeps a ten-second sample ring an
  hour deep; `/api/feeds` reports the window behind the instant, `?history=1`
  the samples, and `/metrics` the same rows for a scraper — because a feed that
  quietly stops advancing is invisible to anyone who does not happen to look
  twice at the right two moments. A feed with no venue clock emits **no** latency
  series rather than a zero.
- **Deploy by patch, never by rsync or overwrite.** The deployed directory is not
  a git checkout. A patch that fails to apply tells you the target has drifted —
  an overwrite destroys that information.
- **After deploying, compare hashes file by file.** A service that starts is not
  proof that the right code is running.
- **Search the whole fleet before saying "not deployed".** I concluded twice that
  depthviz was absent, by looking for an assumed path and the dev port: both were
  wrong. Sweep with `find -iname` and `systemctl list-unit-files`.

## 8. Expected evidence

A change that was not executed does not exist. Depending on what you touch:

| What you touch | What you show |
|---|---|
| `BookSide`, `hub.trim`, a resync, `diff-book` sequencing | `npm test` (deterministic, no network) |
| an adapter's lifecycle — open, close, status handling, timers | `node tools/test-conformance.mjs`, and add the venue to its table |
| `server/quota.js`, `tokenBucket`, a limit or a ceiling | `node tools/test-limits.mjs` **and** a live refusal: 14 concurrent symbols must yield 12 served and a 429 that says what to do |
| `server/health.js`, `/api/feeds`, `/metrics` | `node tools/test-health.mjs` **and** a `curl` of both routes |
| `server/aggregate.js`, `/api/depth/aggregate`, `notionalWithin` | `node tools/test-aggregate.mjs` **and** a `curl` of the route on a real basket — check `asOf.spanMs`, `complete` and `lowerBound.reasons`, not just the total |
| `BookSide.staleFraction`, `accum` | `node tools/test-book.mjs` — and read the fraction on a warm Aster feed, where it is ~50% against Binance's 3% |
| an adapter's shape, or `server/adapters/contract.js` | `node tools/test-conformance.mjs` — it asserts the contract AND that its own table still covers every `(exchange, market)` the registry serves |
| `fetchJson`, `upstreamGate`, anything that reaches a venue over REST | `node tools/test-limits.mjs` — the cap, the bounded queue, a failed job releasing its slot |
| anything at all | `npm run lint` — not a style gate, three rules that catch what `node --check` cannot |
| a threshold, or the sample behind one | `npm run measure:drift -- --check`, and the sample written next to the number |
| the recording format | `node tools/test-recording.mjs` **and** one real capture replayed end to end |
| an adapter, a unit conversion | `node tools/test-adapters.mjs` (deterministic, replays recorded frames), **then** `npm run crosscheck` **and** `node tools/verify-conversions.mjs` |
| Bitunix (absent from ccxt) | `npm run verify:bitunix` |
| `reconnectingWs`, a socket's lifecycle | `node tools/test-reconnect.mjs` — both halves: a dead path is dropped, a quiet-but-answering one is not |
| the UI, the layout, the transport | `node tools/smoke-feeds.mjs`, and `smoke-ui.mjs` if the rendering moves — it drives all three modes, and a mode nobody drives is a mode that breaks silently |
| `shared/metrics.js`, `/api/depth` | `npm test` **and** a `curl` of the route — the browser and the API share one implementation, so a change to it moves both |

`smoke-feeds.mjs` prints a `clock=` column per venue: `venue+NNms` where the
exchange stamps its frames, `none` where it does not. A venue that silently stops
stamping shows up there.

The front end is a tree, and it has to stay one: `app.js`, `combined.js` and
`compare.js` are three leaves depending on `state.js`, `feed.js`, `menus.js`,
`theme.js` and `chart.js`; none of those depends on a page. A cycle here is not
a style problem — it is how a module ends up half-initialised at first use, the
same class as the temporal dead zone that once silently killed every line of a
page's script after one line, with the page still loading and streaming.

**`/` is the mode chooser, not the chart.** Single mode lives at
`/single.html`, and `smoke-ui.mjs` and `shoot.mjs` were both pointed at the root
— a tool that kept doing so would have smoke-tested a page with no chart on it
and called the app healthy, which is §4's lesson with a different hardcoded
value.

**N books means N sockets.** The server's websocket protocol holds ONE
subscription per socket, so combined and compare open one connection per book
rather than extending the protocol — which would have touched the hub, the quota
accounting and the conformance suite to buy nothing the existing ceilings do not
already allow. `feed.js` is a factory for that reason, and `compare.js` states
the twelve-book ceiling as the server's `DEPTHVIZ_MAX_FEEDS_PER_CLIENT` rather
than discovering it as an error with no explanation.

**Combined plots absolute price, never percent-from-mid.** Every venue has its
own mid, so a percent axis lands every touch on the same vertical line and hides
exactly the dislocation somebody opened that view to find. And neither new mode
sums anything: a total needs the reference band and the four caveats, which is
what `/api/depth/aggregate` is for.

`smoke-ui.mjs` ends with a mobile pass (390x844 and rotated) that asserts reach,
not looks: no sideways scroll, every control on screen and tall enough for a
thumb, chart height left over, and the touch crosshair setting and clearing. The
crosshair was mouse-only for months — the page loaded, the socket streamed, and
nothing said the chart carried no numbers at all on a phone.

If you cannot prove it, say so explicitly. "It should work" is not a result.

## 9. Documentation lives in `docs/`

`README.md` is the front door: what it is, a live screenshot, the coverage table,
and links. The long-form material — the tradeoffs, the unit conversions, the
verification story, the deployment procedure, the adapter contract — is in
[`docs/`](docs/). A 540-line README is one nobody finishes.

Screenshots are real captures of a live book, produced by `node tools/shoot.mjs`
against a running server, never mockups. It waits 66 s before shooting so the
accumulating-tail note has expired: a transient caveat frozen into a README reads
as a permanent one.

The repo is English-only — code, comments, docs and these rules.
