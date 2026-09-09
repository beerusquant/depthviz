/**
 * Deterministic tests for the health this process remembers and the shape a
 * scraper reads. No network, no clock of its own.
 *
 *   node tools/test-health.mjs
 *
 * What they exist to pin: a counter with no memory answers the wrong question.
 * `reconnects: 1284` is a total since the feed opened and says nothing about
 * whether anything is wrong NOW; the delta over a known window does. And the
 * exposition has to survive a symbol chosen by an exchange listing, which is a
 * string an attacker can pick — the same reason the front end writes them with
 * textContent.
 */
import { Ring, summarize, renderPrometheus } from '../server/health.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

console.log('Ring — bounded, and oldest first');
{
  const r = new Ring(3);
  ok('an empty ring reads empty', r.toArray().length === 0);
  r.push(1).push(2);
  ok('it reads back in order while it is filling', JSON.stringify(r.toArray()) === '[1,2]');
  r.push(3).push(4).push(5);
  ok('it never grows past its capacity', r.length === 3);
  // The order is the whole point: a time series read out of order is not a time
  // series, and this is where a ring buffer is usually wrong.
  ok('and the oldest sample is still the first one out',
     JSON.stringify(r.toArray()) === '[3,4,5]', JSON.stringify(r.toArray()));
  for (let i = 6; i <= 20; i++) r.push(i);
  ok('after many wraps it still holds the last N, in order',
     JSON.stringify(r.toArray()) === '[18,19,20]', JSON.stringify(r.toArray()));
}

console.log('\nsummarize — what happened over the window, not since the beginning');
{
  const s = (t, o) => ({ t, books: 0, reconnects: 0, errors: 0, droppedFrames: 0, ageMs: 100, ...o });
  const hour = 3600_000;
  const rows = [
    s(0,        { books: 1000, reconnects: 40 }),
    s(hour / 2, { books: 2000, reconnects: 42 }),
    s(hour,     { books: 3000, reconnects: 43 }),
  ];
  const w = summarize(rows);
  ok('the delta is what the window saw, not the total since the feed opened',
     w.reconnects === 3 && w.books === 2000, JSON.stringify(w));
  ok('and it is expressed as a rate a person can act on',
     near(w.reconnectsPerHour, 3), String(w.reconnectsPerHour));
  ok('the span is reported so the rate can be judged', w.spanMs === hour && w.samples === 3);

  // A feed that was rebuilt starts its counters at zero. Subtracting the old
  // value would report a large negative delta — i.e. would hide the restart
  // and every reconnect after it.
  const restarted = [s(0, { reconnects: 40 }), s(hour / 2, { reconnects: 2 }), s(hour, { reconnects: 5 })];
  const r = summarize(restarted);
  ok('a counter that goes backwards is a rebuilt feed, not a negative delta',
     r.reconnects === 5, String(r.reconnects));

  ok('no samples is null, never a zeroed summary that looks healthy',
     summarize([]) === null && summarize(null) === null);
  ok('one sample has no window, and says so with a null rate',
     summarize([s(0, {})]).spanMs === 0 && summarize([s(0, {})]).reconnectsPerHour === null);
}
{
  // The failure this whole file exists for: `state` reads live between drops.
  // Age does not.
  const rows = [
    { t: 0,      books: 1, ageMs: 200, state: 'live' },
    { t: 10_000, books: 1, ageMs: 10_200, state: 'live' },
    { t: 20_000, books: 1, ageMs: 20_200, state: 'live' },
  ];
  const w = summarize(rows);
  ok('the worst book age over the window is kept', w.worstAgeMs === 20_200);
  ok('and a book older than the sampling step is counted as a stale sample',
     w.staleSamples === 2, String(w.staleSamples));
  const healthy = summarize([
    { t: 0, books: 1, ageMs: 150 }, { t: 10_000, books: 2, ageMs: 90 }, { t: 20_000, books: 3, ageMs: 120 },
  ]);
  ok('a feed that keeps arriving has none', healthy.staleSamples === 0);
  ok('a feed that has never produced a book has no age, not an age of zero',
     summarize([{ t: 0, books: 0, ageMs: null }]).worstAgeMs === null);
}

console.log('\nrenderPrometheus — readable by something that never sleeps');
{
  const rows = [{
    key: 'binance:spot:BTCUSDT:', clients: 2, state: 'live', source: 'ws',
    ageMs: 120, venueLatencyMs: 43, levels: [5085, 4943],
    books: 900, reconnects: 3, errors: 0, droppedFrames: 1, upMs: 60_000,
  }];
  const out = renderPrometheus(rows, { clients: 2, uptimeMs: 60_000 });
  ok('every series carries the venue, market and symbol it belongs to',
     out.includes('exchange="binance",market="spot",symbol="BTCUSDT"'));
  ok('the age of the last book is exposed — the number that cannot lie',
     /depthviz_feed_book_age_ms\{[^}]*\} 120\n/.test(out));
  ok('so are the counters, as counters', out.includes('# TYPE depthviz_feed_reconnects_total counter')
     && /depthviz_feed_reconnects_total\{[^}]*\} 3\n/.test(out));
  ok('levels are summed across both sides', /depthviz_feed_levels\{[^}]*\} 10028\n/.test(out));
  ok('and the state is one-hot, so an alert can compare it to 1',
     /depthviz_feed_state\{[^}]*state="live"\} 1\n/.test(out)
     && /depthviz_feed_state\{[^}]*state="error"\} 0\n/.test(out));
  ok('every metric declares HELP and TYPE', (out.match(/# HELP /g) || []).length >= 10);
  // Memory is the other silent failure: every feed holds the venue's book as it
  // arrived, and the deepest are 43 000 levels.
  const mem = renderPrometheus(rows, { memory: { rss: 123, heapUsed: 45 } });
  ok('process memory is exposed when it is given', /depthviz_process_rss_bytes 123\n/.test(mem)
     && /depthviz_process_heap_used_bytes 45\n/.test(mem));
  ok('and omitted entirely when it is not', !out.includes('depthviz_process_rss_bytes'));
}
{
  // A venue with no clock must produce no latency series at all. Emitting one
  // with a value of 0 would put a perfect upstream latency into a dashboard for
  // a feed that has no clock — the exact lie this repo refuses everywhere else.
  const out = renderPrometheus([{
    key: 'bitunix:spot:BTCUSDT:', clients: 1, state: 'live', source: 'poll',
    ageMs: 900, venueLatencyMs: null, levels: [50, 50],
    books: 10, reconnects: 0, errors: 0, droppedFrames: 0, upMs: 1000,
  }]);
  ok('a feed with no venue clock exposes no latency, rather than a zero',
     !out.includes('depthviz_feed_venue_latency_ms{'), out.split('\n').find((l) => l.startsWith('depthviz_feed_venue_latency_ms{')));
  ok('while everything it does know is still exposed', out.includes('depthviz_feed_book_age_ms{'));
}
{
  // Symbols come from exchange listings and are attacker-choosable. A quote in
  // a label value ends it early and corrupts every metric after it on the line.
  const out = renderPrometheus([{
    key: 'mexc:spot:GOLD"(PAXG)\\USDT:', clients: 0, state: 'live', source: 'ws',
    ageMs: 1, venueLatencyMs: null, levels: null,
    books: 1, reconnects: 0, errors: 0, droppedFrames: 0, upMs: 1,
  }]);
  ok('a quote or a backslash in a symbol is escaped, not passed through',
     out.includes('symbol="GOLD\\"(PAXG)\\\\USDT"'),
     out.split('\n').find((l) => l.includes('PAXG')));
  const bad = out.split('\n').filter((l) => l && !l.startsWith('#') && !/^[a-z_]+(\{.*\})? -?[\d.e+-]+$/.test(l));
  ok('and every emitted line is still one metric and one number', bad.length === 0, JSON.stringify(bad.slice(0, 2)));
}
{
  ok('no feeds is a valid exposition, not an empty body',
     renderPrometheus([]).includes('depthviz_feeds 0'));
}

// A refused book is not a book that never came. The hub drops one-sided,
// non-positive-mid and CROSSED books, and the third is the one that means the
// stream is wrong rather than quiet — so it gets its own series to alert on.
{
  const rows = [{
    key: 'binance:spot:BTCUSDT', state: 'live', source: 'ws', ageMs: 40,
    rejected: { empty: 2, badMid: 0, crossed: 7 }, volAgeMs: 900_000, driftAgeMs: 5_000,
  }];
  const out = renderPrometheus(rows);
  ok('the refusals are exposed as one total',
     /depthviz_feed_rejected_books_total\{[^}]*\} 9\n/.test(out), out);
  ok('and broken out by reason, so a crossed stream is alertable on its own',
     /by_reason_total\{[^}]*reason="crossed"\} 7\n/.test(out)
     && /by_reason_total\{[^}]*reason="empty"\} 2\n/.test(out), out);
  ok('a stale 24h volume is visible to a scraper, not only on screen',
     /depthviz_feed_vol_age_ms\{[^}]*\} 900000\n/.test(out), out);
  ok('and so is the age of the integrity measurement',
     /depthviz_feed_drift_age_ms\{[^}]*\} 5000\n/.test(out), out);

  // A venue that makes no drift measurement must emit nothing rather than a
  // zero: a zero here reads as "measured just now, and it agreed".
  const quiet = renderPrometheus([{ key: 'coinbase:spot:BTC-USD', state: 'live', ageMs: 5,
                                    rejected: { empty: 0, badMid: 0, crossed: 0 },
                                    volAgeMs: null, driftAgeMs: null }]);
  ok('a venue with no such measurement emits no series for it, never a zero',
     !/depthviz_feed_drift_age_ms\{/.test(quiet) && !/depthviz_feed_vol_age_ms\{/.test(quiet), quiet);
  ok('but its refusals are still counted at zero, which is a fact',
     /by_reason_total\{[^}]*reason="crossed"\} 0\n/.test(quiet), quiet);
}

// The gate that bounds the burst of REST snapshots a feed opening makes is per
// HOST — eight venues serve thirteen feeds — so it is exposed per host, and a
// process with nothing in flight emits nothing rather than a row of zeros.
{
  const busy = renderPrometheus([], { upstream: [{ host: 'api.binance.com', inflight: 4, queued: 9 }] });
  ok('a saturated exchange host is visible to a scraper',
     /depthviz_upstream_inflight\{host="api\.binance\.com"\} 4\n/.test(busy)
     && /depthviz_upstream_queued\{host="api\.binance\.com"\} 9\n/.test(busy), busy);
  ok('and an idle process says nothing about upstream at all',
     !/depthviz_upstream/.test(renderPrometheus([], {})));
}

// The window summary has to carry refusals too: a feed refusing four books an
// hour and one refusing none are the same in a single reading.
{
  const rows = [
    { t: 0, books: 0, reconnects: 0, errors: 0, droppedFrames: 0, rejectedBooks: 0, ageMs: 10 },
    { t: 1800_000, books: 5, reconnects: 0, errors: 0, droppedFrames: 0, rejectedBooks: 2, ageMs: 10 },
    { t: 3600_000, books: 9, reconnects: 0, errors: 0, droppedFrames: 0, rejectedBooks: 6, ageMs: 10 },
  ];
  const w = summarize(rows);
  ok('refusals are summed over the window like every other counter', w.rejectedBooks === 6, `${w.rejectedBooks}`);
  ok('and reported as a rate an alert can use', near(w.rejectedBooksPerHour, 6), `${w.rejectedBooksPerHour}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
