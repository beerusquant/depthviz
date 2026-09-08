# Adding an exchange

[← README](../README.md) · [Architecture](architecture.md) · [Verification](verification.md) · [Deployment](deployment.md) · [Adding an exchange](adding-an-exchange.md)

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

and register it in `server/adapters/index.js`. If the venue maintains its book
by snapshot + versioned diffs, do not re-implement it: `server/adapters/diff-book.js`
is that engine, and **five of the thirteen feeds run it** — Binance spot and
perp, Aster, and both MEXC markets. A venue supplies `decode(raw)` and
`snapshot()`, plus how its events chain: `style: 'from'` when the next event
declares `from === version + 1` (Binance spot, MEXC), `'prev'` when each event
names its predecessor (Binance futures, and Aster which clones that API). Sizes
are whatever decode produces, so a venue quoting in contracts converts there and
the engine never learns about contracts at all. Folding MEXC in took it from 265
lines to 166.
`open` may return a promise (OKX, MEXC and Lighter do — they need contract sizes,
or a `market_id`, first) and resolves to `{ close() }`. It
pushes

```js
emit({ bids, asks, ts, source, accum, drift })
```

with sizes in **base units**, bids descending, asks ascending. `source` is
`'ws'` or `'poll'` and drives the panel's transport label. `ts` is the **venue's
own event time, or `null`** — never `Date.now()`: the hub stamps its own
`tsRecv`, and a locally filled `ts` would report an upstream latency of zero on a
feed that never measured one. If the venue's payload has a timestamp anywhere,
find it; MEXC was stamping every frame on both markets and both decoders were
dropping it. The last two are
optional: `accum: { since }` marks a book that only reaches past its snapshot by
accumulating diffs, so the UI can say the far depth is still converging
([tradeoff 7](architecture.md#tradeoffs-i-had-to-make)); `drift` is a 0..1
disagreement between two transports of the same venue, where one exists
([tradeoff 8](architecture.md#tradeoffs-i-had-to-make)). The UI needs no changes.

Two rules about *when* you may emit, both of which have already been broken here:

- **Coalesce.** Apply every upstream frame to your book immediately, but wrap
  the function that materialises and emits it in `coalesce(fn, PUBLISH_MS)` and
  call `.cancel()` from `close()`. Sorting a 20 000-level book ten times a
  second so the hub can discard nine of them costs ~35 ms of event loop per
  second, on the thread every other feed decodes on.
- **Prove the socket is alive, do not assume it.** Pass `pingMs` so
  `reconnectingWs` arms its idle watchdog: a socket killed by a NAT timeout
  stays `OPEN` forever with no error and no close, and the feed then serves a
  frozen book while reading `live`. All eight venues answer an RFC6455 ping with
  a pong (verified), so a quiet-but-healthy book is never mistaken for a dead
  path.

Two more that are not suggestions, because a closing socket keeps delivering:

- **A closed adapter publishes nothing.** `ws.close()` is a handshake, so frames
  already in flight still reach `onMessage` after the hub has let the feed go —
  and a book published then is handed to a `Feed` that is being destroyed. Guard
  the emit on your own `closed` flag; five adapters here did not, and
  `test-conformance` is what noticed.
- **`close()` takes your timers with it.** A `stopped` flag stops the *next*
  poll and leaves the pending one holding the event loop. OKX and Bitunix each
  cost a second and five seconds of shutdown per feed that way, waiting on a
  response they would discard.

## The seam, and the contract

Every adapter takes a transport factory as `opts.connect`, and the hub only ever
builds `opts` as `{ range }` — so nothing in production reaches it. It exists so
`tools/test-conformance.mjs` can drive your adapter with no network, and
**adding a venue means adding a row to its table.** A contract that covers
twelve of thirteen feeds is a contract about nothing. What it will ask of you:

| | |
|---|---|
| nothing before the venue speaks | no book published while the REST gate is shut and no frame has been fed |
| a well-formed book | sorted outward from mid, positive, uncrossed, two-sided, `source` set |
| an honest clock | the venue's `ts`, or `null` — never a stamp from this process |
| a dead connection contributes nothing | no book at all on one socket; on an assembled book, one that reaches *less far* |
| a clean close | idempotent, closes every transport, publishes nothing after, leaves no timer |

Record its payloads with `node tools/capture-fixtures.mjs` — never write them by
hand, and if your venue is a diff book, capture the snapshot and its anchoring
frame **together** (`grabPair`). Two captures taken minutes apart and renumbered
onto each other produce a book that crosses, which reads exactly like a bug in
your adapter and is a bug in the fixture.

If the venue is a snapshot + versioned-diff book, note that `openDiffBook`
accepts a `connect` factory of its own; the venue adapters forward `opts.connect`
into it. That seam exists for `tools/test-diff-book.mjs` and
`tools/test-conformance.mjs` and nothing else — do not use it to inject venue
behaviour.
