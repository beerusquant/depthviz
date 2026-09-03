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
