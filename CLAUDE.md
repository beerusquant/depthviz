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

Corollary: `state` is not health. It is set by the last status event, so a feed
that reconnects every thirty seconds reads `live` between drops. The measurement
that cannot lie is the age of the last book — `/api/feeds` reports it, and the
panel refreshes it every second so a dead feed cannot freeze its own staleness.

## 2. ccxt is a judge, never a source

`fetchOrderBook` returns OKX and MEXC sizes in **raw contracts**: ccxt exposes
`market.contractSize` and does not apply it. Reading a book straight from ccxt is
a 100x error on `BTC-USDT-SWAP` and ~780x on the inverse `BTC-USD-SWAP`.
Measured, not assumed.

It remains valuable as a **second independent implementation** our hand-written
adapters can be wrong against: `npm run crosscheck`. On contract-denominated
venues the **expected ratio is the multiplier, not 1**.

ccxt carries `aster` and `lighter`: both perp DEXs therefore have an external
judge, and their expected ratio is 1 (no contracts). Bitunix is the only venue
with no judge.

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
| `BookSide`, `hub.trim`, a resync | `npm test` (deterministic, no network) |
| an adapter, a unit conversion | `npm run crosscheck` **and** `node tools/verify-conversions.mjs` |
| Bitunix (absent from ccxt) | `npm run verify:bitunix` |
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
