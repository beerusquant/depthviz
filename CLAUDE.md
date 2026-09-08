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

## 3. A check that cries wolf is worse than no check

- **Neither a `SKIP` nor an `INCONC` counts as a pass.** Both are an absence of
  proof and exit non-zero. On a day when everything skips, the summary must not
  say "all good" — it said that once, and it was false.
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
| an adapter, a unit conversion | `node tools/test-adapters.mjs` (deterministic, replays recorded frames), **then** `npm run crosscheck` **and** `node tools/verify-conversions.mjs` |
| Bitunix (absent from ccxt) | `npm run verify:bitunix` |
| `reconnectingWs`, a socket's lifecycle | `node tools/test-reconnect.mjs` — both halves: a dead path is dropped, a quiet-but-answering one is not |
| the UI, the layout, the transport | `node tools/smoke-feeds.mjs`, and `smoke-ui.mjs` if the rendering moves |
| `shared/metrics.js`, `/api/depth` | `npm test` **and** a `curl` of the route — the browser and the API share one implementation, so a change to it moves both |

`smoke-feeds.mjs` prints a `clock=` column per venue: `venue+NNms` where the
exchange stamps its frames, `none` where it does not. A venue that silently stops
stamping shows up there.

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
