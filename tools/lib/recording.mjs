/**
 * The on-disk shape of a recorded book, and the reading of it back.
 *
 * Why this exists at all: this repo measures very well and remembers nothing.
 * Every threshold in it — OKX's 3% drift trigger, Bitunix's refusal of a
 * threshold, MEXC's ±0.25% band — came from a distribution someone sampled once
 * with a script that no longer exists. Those numbers are undefendable a month
 * later: nobody can re-derive them on the same protocol, nobody can say whether
 * the venue has moved, and no figure the chart ever printed can be checked
 * after the fact. An instrument without a tape is an instrument you have to
 * believe.
 *
 * The format is JSONL because it is appendable, greppable and survives a
 * process being killed halfway: every line stands alone.
 *
 *   {"k":"header",...}   once, first
 *   {"k":"b",...}        one per sampled book
 *   {"k":"end",...}      once, last — and only when the run actually finished
 *
 * Two rules the format enforces, both bought with an afternoon each:
 *
 *  - A file is written as `<name>.part` and renamed only on completion, and the
 *    end marker is what says a run finished. A partial JSONL is indistinguishable
 *    from a complete one by size or by existence, and a waiting loop that tests
 *    `[ -s file ]` will happily conclude a crashed capture succeeded.
 *  - Levels are recorded RAW, in base units, exactly as the adapter produced
 *    them. Recording the reduced payload would bake the transport's tradeoff
 *    into the archive forever: the reduction is exact in cumulative notional,
 *    quantity and VWAP, and wrong about the price a given size walks to, which
 *    is the question most worth asking of an archive.
 */
export const FORMAT = 1;
export const encode = (obj) => `${JSON.stringify(obj)}\n`;

export function header(meta) {
  return {
    k: 'header',
    v: FORMAT,
    tool: 'depthviz/tools/record.mjs',
    startedAt: meta.startedAt,
    exchange: meta.exchange,
    market: meta.market,
    symbol: meta.symbol,
    intervalMs: meta.intervalMs,
    clipPct: meta.clipPct,
    // Two venue facts that a reader a month from now cannot recover and would
    // otherwise assume away: whether depth past the snapshot is a lower bound
    // that grows with uptime, and what the venue says about its own book.
    accumulates: meta.accumulates ?? null,
    note: meta.note ?? null,
  };
}

/** One sampled book. `clipPct` bounds the file; null keeps every level. */
export function bookRow(book, clipPct = null) {
  const mid = book.mid ?? (book.bids[0][0] + book.asks[0][0]) / 2;
  const keep = (rows) => {
    if (clipPct == null) return rows;
    const out = [];
    for (const [p, q] of rows) {
      if (Math.abs(p - mid) / mid * 100 > clipPct) break; // sorted outward from mid
      out.push([p, q]);
    }
    return out;
  };
  return {
    k: 'b',
    tsRecv: book.tsRecv,
    // Never filled in locally. A recording whose venue clock was invented is
    // worse than one with no clock at all: it measures a latency of zero and
    // nobody questions it.
    tsVenue: book.tsVenue ?? null,
    source: book.source ?? null,
    mid,
    levels: book.levels ?? [book.bids.length, book.asks.length],
    bids: keep(book.bids),
    asks: keep(book.asks),
  };
}

export const endRow = (counts) => ({ k: 'end', endedAt: Date.now(), ...counts });

/**
 * Read a recording back.
 *
 * `complete` is true only when an end marker was written. A file without one is
 * still readable — a crashed capture is data, not garbage — but nothing may
 * report it as a finished run.
 */
export function parse(text) {
  const out = { header: null, books: [], end: null, complete: false, bad: 0 };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { out.bad++; continue; }
    if (o.k === 'header') out.header = o;
    else if (o.k === 'b') out.books.push(o);
    else if (o.k === 'end') { out.end = o; out.complete = true; }
    else out.bad++;
  }
  return out;
}

/**
 * What a recording contains, before anyone computes anything from it.
 *
 * `gaps` is the one that matters: a capture that lost four minutes to a
 * reconnect still has a plausible-looking book on either side of the hole, and
 * a distribution computed across it silently mixes two regimes.
 */
export function summarize(rec) {
  const b = rec.books;
  if (!b.length) return { books: 0, spanMs: 0, gaps: [], levels: null, clockless: 0 };
  const spanMs = b[b.length - 1].tsRecv - b[0].tsRecv;
  const step = rec.header?.intervalMs || 1000;
  const gaps = [];
  for (let i = 1; i < b.length; i++) {
    const d = b[i].tsRecv - b[i - 1].tsRecv;
    if (d > step * 3) gaps.push({ at: b[i - 1].tsRecv, ms: d });
  }
  const lv = b.map((x) => (x.levels ? x.levels[0] + x.levels[1] : x.bids.length + x.asks.length));
  return {
    books: b.length,
    spanMs,
    gaps,
    coverage: spanMs > 0 ? b.length / (spanMs / step + 1) : null,
    levels: { min: Math.min(...lv), max: Math.max(...lv), last: lv[lv.length - 1] },
    clockless: b.filter((x) => x.tsVenue == null).length,
    complete: rec.complete,
  };
}

/** The p-quantile of a sample, linear interpolation, sorted copy. Nothing clever. */
export function quantile(xs, p) {
  const v = xs.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (i - lo);
}

/** median / p95 / max, with n — the four numbers a threshold has to be quoted with. */
export function distribution(xs) {
  const v = xs.filter(Number.isFinite);
  if (!v.length) return null;
  return {
    n: v.length,
    min: Math.min(...v),
    median: quantile(v, 0.5),
    p95: quantile(v, 0.95),
    p99: quantile(v, 0.99),
    max: Math.max(...v),
  };
}
