/**
 * The health this process remembers, and the shape a scraper can read.
 *
 * `/api/feeds` reported counters with no memory: a pull with nothing behind it.
 * A feed reconnecting forty times an hour and a feed that has never dropped
 * once are indistinguishable in a single reading, because `reconnects` is a
 * total since the feed opened and nobody has the earlier value to subtract. So
 * the reading was only useful to someone who happened to look twice, at the
 * right two moments — which is to say, to nobody.
 *
 * Two things fix that and they are both here: a bounded ring of samples, so the
 * process can answer "what did the last hour look like" on its own, and a
 * Prometheus exposition, so something that never sleeps can answer it instead.
 *
 * Nothing in this file touches a socket or a clock it was not given, which is
 * why tools/test-health.mjs can pin all of it with no network and no waiting.
 */

/** A fixed-size ring. Oldest samples fall off the back; nothing grows. */
export class Ring {
  constructor(capacity) { this.cap = capacity; this.buf = []; this.i = 0; }
  push(v) {
    if (this.buf.length < this.cap) this.buf.push(v);
    else { this.buf[this.i] = v; this.i = (this.i + 1) % this.cap; }
    return this;
  }
  /** Oldest first, always — the order a time series has to be read in. */
  toArray() {
    return this.buf.length < this.cap
      ? this.buf.slice()
      : this.buf.slice(this.i).concat(this.buf.slice(0, this.i));
  }
  get length() { return this.buf.length; }
}

const COUNTERS = ['books', 'reconnects', 'errors', 'droppedFrames', 'rejectedBooks'];

/**
 * What happened across a window of samples.
 *
 * Counters are cumulative, so what a reader wants is the DELTA over the window
 * plus a rate per hour — "three reconnects in the last hour" is actionable in a
 * way that "1 284 reconnects since March" is not. A counter that went backwards
 * means the feed was rebuilt (a new Feed starts at zero) and the delta for that
 * step is taken as the new value rather than as a negative.
 *
 * `worstAgeMs` is the one that catches a silent death: state says `live`
 * between drops, and the age of the last book does not.
 */
export function summarize(samples) {
  if (!samples?.length) return null;
  const first = samples[0], last = samples[samples.length - 1];
  const spanMs = Math.max(0, last.t - first.t);
  const out = { samples: samples.length, spanMs, worstAgeMs: null, staleSamples: 0 };
  for (const k of COUNTERS) {
    let delta = 0;
    for (let i = 1; i < samples.length; i++) {
      const d = (samples[i][k] ?? 0) - (samples[i - 1][k] ?? 0);
      delta += d < 0 ? (samples[i][k] ?? 0) : d;
    }
    out[k] = delta;
    out[`${k}PerHour`] = spanMs > 0 ? (delta * 3600_000) / spanMs : null;
  }
  for (const s of samples) {
    if (s.ageMs == null) continue;
    if (out.worstAgeMs == null || s.ageMs > out.worstAgeMs) out.worstAgeMs = s.ageMs;
  }
  // A sample is stale when the book behind it is older than the gap between two
  // samples: nothing arrived at all while we were not looking. It is a
  // description, not an alarm — an illiquid book legitimately sits still for a
  // minute, and a badge that cried wolf there would be ignored on the day it
  // mattered. What it makes possible is the comparison: this feed went quiet
  // for eleven of the last sixty samples and that one never did.
  const step = samples.length > 1 ? spanMs / (samples.length - 1) : 0;
  if (step > 0) out.staleSamples = samples.filter((s) => s.ageMs != null && s.ageMs > step).length;
  return out;
}

// A Prometheus label value may contain any UTF-8, but a backslash, a double
// quote and a newline end the value early and corrupt every metric after it on
// the line. Symbols come from exchange listings and are attacker-choosable —
// the same reason the front end writes them with textContent.
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const line = (name, labels, value) => {
  if (value == null || !Number.isFinite(value)) return '';
  const l = Object.entries(labels).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}="${esc(v)}"`).join(',');
  return `${name}{${l}} ${value}\n`;
};

/**
 * The text exposition, straight from what /api/feeds already knows.
 *
 * Deliberately built from the same `stats()` rows the JSON route serves, so a
 * scraper and a human curl cannot disagree about what a feed was doing — the
 * same reason the browser and /api/depth share one metrics module.
 */
export function renderPrometheus(rows, extra = {}) {
  let out = '';
  const help = (name, type, text) => { out += `# HELP ${name} ${text}\n# TYPE ${name} ${type}\n`; };

  help('depthviz_feeds', 'gauge', 'Upstream feeds currently held by this process.');
  out += `depthviz_feeds ${rows.length}\n`;
  if (Number.isFinite(extra.clients)) {
    help('depthviz_clients', 'gauge', 'Websocket viewers connected to this process.');
    out += `depthviz_clients ${extra.clients}\n`;
  }
  if (Number.isFinite(extra.uptimeMs)) {
    help('depthviz_uptime_ms', 'gauge', 'Milliseconds since this process started.');
    out += `depthviz_uptime_ms ${extra.uptimeMs}\n`;
  }
  // Memory is a feed-count question here: every feed holds the venue's book as
  // it arrived, and the deepest of them are large (Coinbase 43 000 levels,
  // Bitunix perp 25 000). A process quietly growing towards its heap limit is
  // the other silent failure, next to a feed that stops advancing.
  if (extra.memory) {
    help('depthviz_process_rss_bytes', 'gauge', 'Resident set size of this process.');
    out += `depthviz_process_rss_bytes ${extra.memory.rss}\n`;
    help('depthviz_process_heap_used_bytes', 'gauge', 'V8 heap in use.');
    out += `depthviz_process_heap_used_bytes ${extra.memory.heapUsed}\n`;
  }

  // Per exchange host, not per feed: eight venues serve thirteen feeds and the
  // limit is on the host, so a series per feed would count the same queue twice.
  if (extra.upstream?.length) {
    help('depthviz_upstream_inflight', 'gauge', 'REST calls in flight to this exchange host.');
    for (const u of extra.upstream) out += line('depthviz_upstream_inflight', { host: u.host }, u.inflight);
    help('depthviz_upstream_queued', 'gauge', 'REST calls waiting for a slot on this exchange host. A queue that does not drain is a venue gone slow.');
    for (const u of extra.upstream) out += line('depthviz_upstream_queued', { host: u.host }, u.queued);
  }

  const metrics = [
    ['depthviz_feed_book_age_ms', 'gauge', 'ageMs',
     'Milliseconds since the last book arrived. The measurement that cannot lie: state reads live between drops.'],
    ['depthviz_feed_venue_latency_ms', 'gauge', 'venueLatencyMs',
     'tsRecv - tsVenue. Absent where the venue stamps nothing, never filled in locally.'],
    ['depthviz_feed_books_total', 'counter', 'books', 'Books received from the venue since this feed opened.'],
    ['depthviz_feed_reconnects_total', 'counter', 'reconnects', 'Reconnections since this feed opened.'],
    ['depthviz_feed_errors_total', 'counter', 'errors', 'Error statuses since this feed opened.'],
    ['depthviz_feed_dropped_frames_total', 'counter', 'droppedFrames', 'Frames skipped for clients that were behind.'],
    ['depthviz_feed_rejected_books_total', 'counter', 'rejectedTotal',
     'Books an adapter published and the hub refused: one-sided, non-positive mid, or CROSSED. A rising crossed count is a mis-sequenced stream.'],
    ['depthviz_feed_vol_age_ms', 'gauge', 'volAgeMs',
     'Milliseconds since 24h volume was last read successfully. Refreshes are swallowed on failure, so this is the only thing that says the figure has stopped moving.'],
    ['depthviz_feed_drift_age_ms', 'gauge', 'driftAgeMs',
     'Milliseconds since the ws-vs-REST integrity measurement was last taken. Absent on venues that do not make one.'],
    ['depthviz_feed_clients', 'gauge', 'clients', 'Viewers attached to this feed.'],
    ['depthviz_feed_up_ms', 'gauge', 'upMs', 'Milliseconds since this feed opened.'],
    ['depthviz_feed_levels', 'gauge', 'levelsTotal', 'Levels in the last book, both sides, before reduction.'],
  ];
  for (const [name, type, field, text] of metrics) {
    help(name, type, text);
    for (const r of rows) {
      const [exchange, market, symbol] = String(r.key).split(':');
      const v = field === 'levelsTotal'
        ? (r.levels ? r.levels[0] + r.levels[1] : null)
        : field === 'rejectedTotal'
          ? (r.rejected ? r.rejected.empty + r.rejected.crossed + r.rejected.badMid : null)
          : r[field];
      out += line(name, { exchange, market, symbol, source: r.source, state: r.state }, v);
    }
  }

  // Broken out from the total above because the three refusals are not the same
  // news: `empty` and `badMid` are a feed that has nothing to say yet, while
  // `crossed` is a stream that IS saying something and it is wrong. Alert on
  // the second one.
  help('depthviz_feed_rejected_books_by_reason_total', 'counter',
       'Refused books by reason: empty (one-sided), badMid, crossed (best bid >= best ask).');
  for (const r of rows) {
    const [exchange, market, symbol] = String(r.key).split(':');
    for (const reason of ['empty', 'badMid', 'crossed']) {
      out += line('depthviz_feed_rejected_books_by_reason_total',
                  { exchange, market, symbol, reason }, r.rejected?.[reason] ?? null);
    }
  }

  // `state` is a string, and a string is not a number: it is exposed as the
  // idiomatic one-hot so an alert can say `depthviz_feed_state{state="error"}
  // == 1` instead of parsing anything.
  help('depthviz_feed_state', 'gauge', 'One per feed and state, 1 on the state the last status event set.');
  for (const r of rows) {
    const [exchange, market, symbol] = String(r.key).split(':');
    for (const st of ['live', 'connecting', 'reconnecting', 'error']) {
      out += line('depthviz_feed_state', { exchange, market, symbol, state: st }, r.state === st ? 1 : 0);
    }
  }
  return out;
}
