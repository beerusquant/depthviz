import WebSocket from 'ws';

const UA = { 'User-Agent': 'depthviz/1.0', 'Accept': 'application/json' };

// How often a feed is allowed to publish a book. One number, used by the
// adapters to coalesce upstream frames and by the hub to throttle fan-out, so
// the two cannot fight: an adapter publishing faster than the hub ships is pure
// waste, and an adapter publishing slower makes the hub's throttle a lie.
export const PUBLISH_MS = 200;

/**
 * How many REST calls this process may have in flight to ONE exchange host, and
 * what happens to the rest.
 *
 * Measured 2026-09-08: opening twelve feeds at once from a single client is
 * enough for Binance itself to answer 429 on the snapshot calls. The per-client
 * feed quota bounds how many feeds exist; nothing bounded the burst of REST
 * snapshots that opening them produces, and every adapter reaches an exchange
 * through this one function — which makes it the only place a bound can be
 * written once instead of eight times.
 *
 * Concurrency is the parameter that needs no distribution behind it: four
 * simultaneous requests to one venue is a bound by construction, not a
 * threshold someone guessed. A minimum SPACING between requests would need one,
 * and this repo does not hand out thresholds it has not sampled — so it exists,
 * it defaults to off, and it stays off until somebody measures what the venues
 * actually tolerate. See §2 bis: not every measurement earns a threshold.
 *
 * The queue is bounded and REPORTS. An unbounded one is worse than the 429 it
 * is avoiding: requests pile up behind a venue that has stopped answering, each
 * one holding a caller, and the process degrades with nothing to say why.
 */
const UPSTREAM = {
  maxInflight: +process.env.DEPTHVIZ_UPSTREAM_INFLIGHT || 4,
  minGapMs: +process.env.DEPTHVIZ_UPSTREAM_GAP_MS || 0,
  maxQueue: +process.env.DEPTHVIZ_UPSTREAM_QUEUE || 64,
};

export function upstreamGate({ maxInflight = 4, minGapMs = 0, maxQueue = 64 } = {}) {
  const hosts = new Map(); // host -> { inflight, last, q, timer }

  const pump = (host) => {
    const st = hosts.get(host);
    if (!st) return;
    st.timer = null;
    while (st.q.length && st.inflight < maxInflight) {
      const now = Date.now();
      const wait = minGapMs - (now - st.last);
      if (wait > 0) {
        // Re-armed rather than spun: the next start is a clock event, not a slot
        // event.
        //
        // NOT unref'd, and that was a bug the tests caught before this shipped:
        // this timer only exists while the queue is non-empty, i.e. while
        // somebody is awaiting a promise that nothing else will ever resolve.
        // Unref'ing it let the process exit with those callers still suspended.
        // The reason to unref — a gate that keeps a quiet process alive — does
        // not apply, because an idle host holds no timer at all.
        st.timer = setTimeout(() => pump(host), wait);
        return;
      }
      st.last = now;
      st.inflight += 1;
      st.q.shift()();
    }
    // Hosts are a bounded set today, but a gate that never forgets one keeps a
    // row per host for the life of the process. An idle host holds no state
    // worth remembering.
    if (!st.q.length && !st.inflight && !st.timer) hosts.delete(host);
  };

  return {
    /** Run `fn` when this host has room, or refuse saying the host is saturated. */
    run(host, fn) {
      let st = hosts.get(host);
      if (!st) { st = { inflight: 0, last: 0, q: [], timer: null }; hosts.set(host, st); }
      // `finally` and not `then`: a request that FAILED still gives its slot
      // back, or one unreachable venue permanently narrows the gate for itself
      // and the queue behind it never drains.
      const start = () => Promise.resolve().then(fn).finally(() => {
        st.inflight -= 1;
        pump(host);
      });
      // Queued callers go first, always: letting a new one overtake them is how
      // a steady stream of requests starves whatever is already waiting.
      if (!st.q.length && st.inflight < maxInflight && Date.now() - st.last >= minGapMs) {
        st.last = Date.now();
        st.inflight += 1;
        return start();
      }
      if (st.q.length >= maxQueue) {
        const e = new Error(`upstream ${host} saturated: ${st.inflight} in flight, ${st.q.length} queued`);
        e.code = 'UPSTREAM_BUSY';
        return Promise.reject(e);
      }
      return new Promise((res, rej) => { st.q.push(() => start().then(res, rej)); });
    },
    stats() {
      return [...hosts].map(([host, st]) => ({ host, inflight: st.inflight, queued: st.q.length }));
    },
  };
}

const gate = upstreamGate(UPSTREAM);

/** What each exchange host currently owes us, for /api/feeds. */
export const upstreamStats = () => gate.stats();

export async function fetchJson(url, opts = {}) {
  // Every adapter's REST call passes here, so the per-host bound is applied
  // once rather than in eight adapters that would each have to remember it.
  return gate.run(new URL(url).host, async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), opts.timeout || 12000);
    try {
      const r = await fetch(url, {
        method: opts.method || 'GET',
        headers: { ...UA, ...(opts.headers || {}) },
        body: opts.body,
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 120)}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  });
}

export function postJson(url, payload, opts = {}) {
  return fetchJson(url, {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Memoize an async fn by key with a TTL, collapsing concurrent calls. */
export function ttlCache(fn, ttlMs) {
  const store = new Map(); // key -> {t, val, pending}
  return async (...args) => {
    const key = JSON.stringify(args);
    const now = Date.now();
    const hit = store.get(key);
    if (hit && now - hit.t < ttlMs && hit.val !== undefined) return hit.val;
    if (hit && hit.pending) return hit.pending;
    const pending = fn(...args)
      .then((val) => {
        store.set(key, { t: Date.now(), val });
        return val;
      })
      .catch((e) => {
        store.delete(key);
        if (hit && hit.val !== undefined) return hit.val; // serve stale on failure
        throw e;
      });
    store.set(key, { t: hit?.t ?? 0, val: hit?.val, pending });
    return pending;
  };
}

/**
 * Rate-limit a publish to at most one call per `ms`, keeping the LAST arguments.
 *
 * An order book is a snapshot, not a log: when frames arrive faster than they
 * can be shipped, the right thing is to drop the intermediate ones, and the
 * cheapest place to drop them is before the expensive part. The adapters used
 * to sort and serialise the whole book on every upstream frame — Binance pushes
 * one every 100 ms — and the hub then threw ~95% of that away at its own 200 ms
 * throttle. Measured on a 20 000-level side: 2.2 ms to sort both sides plus
 * 1.3 ms to bucket them, i.e. 35 ms of event-loop time per second per feed,
 * nearly all of it discarded.
 *
 * The trailing call runs with the arguments of the most recent invocation, and
 * no upstream frame can land between that invocation and the timer without
 * itself becoming a new invocation — so the venue timestamp passed in always
 * belongs to the last event actually applied to the book. Coalescing must never
 * pair a fresh book with a stale clock.
 */
export function coalesce(fn, ms) {
  let last = 0, timer = null, args = null;
  const call = (...a) => {
    args = a;
    if (timer) return;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) { last = Date.now(); const x = args; args = null; fn(...x); return; }
    timer = setTimeout(() => {
      timer = null; last = Date.now();
      const x = args; args = null;
      if (x) fn(...x);
    }, wait);
  };
  call.cancel = () => { clearTimeout(timer); timer = null; args = null; };
  return call;
}

/** Repeatedly run `tick` every intervalMs until closed. Never overlaps. */
export function poller(tick, intervalMs, onError) {
  let stopped = false;
  let timer = null;
  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (e) {
      if (!stopped && onError) onError(e);
    }
    if (!stopped) timer = setTimeout(run, intervalMs);
  };
  run();
  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * WebSocket with automatic reconnect + exponential backoff.
 * handlers: { onOpen(send), onMessage(data, send), onStatus(state, detail) }
 *
 * `opts.pingMs` also arms a liveness deadline. A socket that dies without a
 * FIN — a NAT table entry expiring, a load balancer dropping the flow — stays
 * `readyState === OPEN` forever: no error, no close, no data. The feed then
 * reads `live` and serves a book frozen at the instant the path broke, which is
 * the one failure mode this tool must never have. Anything inbound (a frame, a
 * pong, a protocol ping) proves the path; going `IDLE_FACTOR` ping intervals
 * without any of it does not, so the socket is destroyed and the normal
 * reconnect path takes over.
 */
const IDLE_FACTOR = 2.5;

export function reconnectingWs(url, handlers, opts = {}) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let pingTimer = null;
  let idleTimer = null;

  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    }
  };

  const clearTimers = () => { clearInterval(pingTimer); clearTimeout(idleTimer); };

  const connect = () => {
    if (closed) return;
    const alive = () => {
      if (!opts.pingMs || closed) return;
      clearTimeout(idleTimer);
      const sock = ws;
      idleTimer = setTimeout(() => {
        if (closed || sock !== ws) return;
        handlers.onStatus?.('reconnecting', `${new URL(url).host}: no data for ${Math.round(opts.pingMs * IDLE_FACTOR / 1000)}s, socket assumed dead`);
        try { sock.terminate(); } catch { try { sock.close(); } catch {} }
      }, opts.pingMs * IDLE_FACTOR);
    };
    handlers.onStatus?.(attempt === 0 ? 'connecting' : 'reconnecting');
    ws = new WebSocket(url, opts.wsOptions);

    ws.on('open', () => {
      attempt = 0;
      alive();
      handlers.onStatus?.('open');
      try { handlers.onOpen?.(send); } catch (e) { handlers.onStatus?.('error', String(e)); }
      if (opts.pingMs) {
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            if (opts.pingPayload) ws.send(opts.pingPayload);
            else ws.ping();
          }
        }, opts.pingMs);
      }
    });

    ws.on('message', (raw) => {
      alive();
      try { handlers.onMessage?.(raw, send); }
      catch (e) { handlers.onStatus?.('error', String(e)); }
    });
    ws.on('pong', alive);
    ws.on('ping', alive);

    ws.on('error', (e) => handlers.onStatus?.('error', e?.message || String(e)));

    ws.on('close', () => {
      clearTimers();
      if (closed) return;
      const delay = Math.min(30000, 500 * 2 ** attempt) + Math.random() * 400;
      attempt += 1;
      handlers.onStatus?.('reconnecting', `retry in ${Math.round(delay)}ms`);
      setTimeout(connect, delay);
    });
  };

  connect();

  return {
    send,
    close() {
      closed = true;
      clearTimers();
      try { ws?.close(); } catch {}
    },
  };
}

/** A price-keyed order book side. size 0 removes the level. */
export class BookSide {
  constructor(isBid) {
    this.isBid = isBid;
    this.m = new Map();
    this.seen = new Map();  // price -> ms of the last update that set it
  }
  clear() { this.m.clear(); this.seen.clear(); }
  set(price, size, now = Date.now()) {
    const p = +price, s = +size;
    if (!isFinite(p)) return;
    if (!(s > 0)) { this.m.delete(p); this.seen.delete(p); }
    else { this.m.set(p, s); this.seen.set(p, now); }
  }

  /**
   * Rebuild from a REST snapshot WITHOUT discarding the deep tail.
   *
   * Venues that stream diffs cap their snapshot (Binance spot: 5000 levels,
   * only ~+-1.1% of mid on BTC) but stream updates for every price level, so a
   * book maintained over time reaches far past the snapshot — +-10% and beyond.
   * Clearing the book on every resync threw that away, and a single sequence
   * gap silently dropped the chart's reach back to the snapshot's span for
   * minutes while it re-accumulated.
   *
   * The snapshot is complete and authoritative *inside its own price span*, so
   * that range is replaced outright. Levels beyond it are kept — but a level
   * cancelled while we were disconnected would linger as phantom depth, so a
   * kept level must also have been seen within `maxAgeMs`. Callers drop the
   * tail entirely when the gap itself was long (see `keepTail` at each site).
   *
   * Returns how many out-of-span levels survived.
   */
  applySnapshot(rows, { maxAgeMs = 5 * 60_000, keepTail = true, now = Date.now() } = {}) {
    if (!rows.length) { this.clear(); return 0; }
    let edge = +rows[0][0];
    for (const r of rows) {
      const p = +r[0];
      if (this.isBid ? p < edge : p > edge) edge = p;
    }
    const inSpan = (p) => (this.isBid ? p >= edge : p <= edge);
    let kept = 0;
    for (const p of [...this.m.keys()]) {
      if (!keepTail || inSpan(p) || now - (this.seen.get(p) ?? 0) > maxAgeMs) {
        this.m.delete(p); this.seen.delete(p);
      } else kept++;
    }
    for (const r of rows) this.set(r[0], r[1], now);
    return kept;
  }

  /**
   * How much of the depth inside `band`% of mid has not been touched recently.
   *
   * The venues that stream diffs reach past their capped REST snapshot only by
   * accumulating updates, so their far depth is a lower bound that grows with
   * uptime — this repo has said so since §1, and `accum: { since }` marks it.
   * What `since` cannot answer is HOW MUCH: "$70M at ±10%" and "$70M at ±10%,
   * of which 62% is levels nobody has confirmed in two minutes" are different
   * claims, and only the second one is a measurement.
   *
   * A stale level is not a wrong level — a resting order can legitimately sit
   * untouched for an hour, and on an illiquid book most of them do. It is the
   * fraction that cannot be corroborated, which is the honest caveat on a
   * figure that was reconstructed rather than read.
   *
   * Returns null rather than 0 when there is nothing inside the band to weigh:
   * a fraction of no depth is not zero staleness.
   */
  staleFraction(mid, band, cutoffMs, now = Date.now()) {
    let total = 0, stale = 0;
    for (const [p, q] of this.m) {
      if (Math.abs(p / mid - 1) * 100 > band) continue;
      const n = p * q;
      total += n;
      if (now - (this.seen.get(p) ?? 0) > cutoffMs) stale += n;
    }
    return total > 0 ? stale / total : null;
  }

  /** Sorted [[price,size]...] — bids descending, asks ascending. */
  toArray() {
    const out = [...this.m.entries()];
    out.sort(this.isBid ? (a, b) => b[0] - a[0] : (a, b) => a[0] - b[0]);
    return out;
  }
  get size() { return this.m.size; }
}

/**
 * Is this string safe to carry as a symbol?
 *
 * A symbol is chosen by the caller and ends up inside an exchange REST URL — in
 * a query string on most venues, in a PATH SEGMENT on MEXC futures and Coinbase.
 * Unescaped, `BTC_USDT?limit=1&x=` appends parameters to somebody else's request
 * and `../../` walks to another endpoint entirely, from a process with no
 * authentication in front of it. The fix for that is `encodeURIComponent` at
 * every site that builds a URL, which is where it now lives; this is the cheap
 * outer guard, and it is deliberately permissive.
 *
 * It has to be. A charset allowlist was the obvious first answer and it was
 * wrong: checked against the live listings of all eight venues, 31 of the 10 358
 * symbols served today fail any reasonable one — `币安人生USDT` and four more CJK
 * meme tokens on Binance and Aster, sixteen `GOLD(PAXG)USDT`-style names on MEXC,
 * and Hyperliquid's `PURR/USDC`, whose slash is exactly the character a URL guard
 * wants to ban and which never reaches a URL on that venue (Hyperliquid takes its
 * symbols in a JSON body). Rejecting a real instrument to protect a call that is
 * already escaped is a worse bug than the one being guarded against.
 *
 * So: no control characters — nothing legitimate has them, and they are what
 * poisons a log line or a header — and a length no listing comes close to.
 */
export const okSymbol = (s) => typeof s === 'string'
  && s.length > 0 && s.length <= 64
  // eslint-disable-next-line no-control-regex
  && !/[\u0000-\u001f\u007f]/.test(s);

export const num = (x) => { const v = +x; return isFinite(v) ? v : null; };

/**
 * Minimal protobuf wire-format reader — no schema, no dependency.
 * Returns Map<fieldNumber, value[]>; values are Buffer (wire 2), BigInt
 * (wire 0/1) or Number (wire 5). Unknown fields are simply skipped.
 */
export function pbFields(buf) {
  const out = new Map();
  let i = 0;
  const push = (f, v) => { const a = out.get(f); if (a) a.push(v); else out.set(f, [v]); };
  while (i < buf.length) {
    let k = 0, shift = 0, b;
    do { if (i >= buf.length) return out; b = buf[i++]; k |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const field = k >>> 3, wire = k & 7;
    if (wire === 0) {
      let v = 0n, s = 0n;
      do { if (i >= buf.length) return out; b = buf[i++]; v |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80);
      push(field, v);
    } else if (wire === 2) {
      let len = 0, s2 = 0;
      do { if (i >= buf.length) return out; b = buf[i++]; len |= (b & 0x7f) << s2; s2 += 7; } while (b & 0x80);
      push(field, buf.subarray(i, i + len));
      i += len;
    } else if (wire === 5) { push(field, buf.readUInt32LE(i)); i += 4; }
    else if (wire === 1) { push(field, buf.readBigUInt64LE(i)); i += 8; }
    else return out; // groups / unknown wire type: stop rather than misparse
  }
  return out;
}

/**
 * Starts a fallback transport when the primary has not produced data within
 * `ms`, and stops it again as soon as the primary recovers.
 */
export function watchdogFallback(ms, startFallback) {
  let fb = null, timer = null, closed = false;
  const arm = () => {
    clearTimeout(timer);
    if (closed) return;
    timer = setTimeout(() => { if (!closed && !fb) fb = startFallback(); }, ms);
  };
  arm();
  return {
    ok() { if (fb) { try { fb.close(); } catch {} fb = null; } arm(); },
    close() { closed = true; clearTimeout(timer); if (fb) { try { fb.close(); } catch {} fb = null; } },
  };
}

/**
 * A token bucket, keyed, with the clock injected so it can be tested.
 *
 * Both public routes that take a symbol open upstream connections to an
 * exchange from this host's IP — `/api/depth` opens a feed, `/api/symbols`
 * fetches a listing — so an unthrottled caller cycling a symbol list spends
 * somebody else's rate-limit budget as fast as it can loop. The global feed cap
 * bounds how many connections exist at once; it does nothing about how fast
 * they are churned.
 *
 * `capacity` is the burst a normal user needs (flipping through venues fires a
 * handful of calls in a second), `refillPerSec` is the sustained rate. `take`
 * returns null when allowed and the seconds to wait when it is not, so the
 * caller can put a real number in `Retry-After` rather than a guess.
 */
export function tokenBucket(capacity, refillPerSec) {
  const buckets = new Map(); // key -> { tokens, t }
  return {
    take(key, now = Date.now()) {
      let b = buckets.get(key);
      if (!b) { b = { tokens: capacity, t: now }; buckets.set(key, b); }
      b.tokens = Math.min(capacity, b.tokens + ((now - b.t) / 1000) * refillPerSec);
      b.t = now;
      if (b.tokens >= 1) { b.tokens -= 1; return null; }
      return (1 - b.tokens) / refillPerSec;
    },
    // Keys are remote addresses, so the map is attacker-growable: drop the ones
    // that have been full (i.e. idle) for long enough that forgetting them
    // changes nothing.
    sweep(now = Date.now()) {
      const idle = (capacity / refillPerSec) * 1000;
      for (const [k, b] of buckets) if (now - b.t > idle) buckets.delete(k);
      return buckets.size;
    },
    get size() { return buckets.size; },
  };
}
