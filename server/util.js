import WebSocket from 'ws';

const UA = { 'User-Agent': 'depthviz/1.0', 'Accept': 'application/json' };

export async function fetchJson(url, opts = {}) {
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
 */
export function reconnectingWs(url, handlers, opts = {}) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let pingTimer = null;

  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    }
  };

  const connect = () => {
    if (closed) return;
    handlers.onStatus?.(attempt === 0 ? 'connecting' : 'reconnecting');
    ws = new WebSocket(url, opts.wsOptions);

    ws.on('open', () => {
      attempt = 0;
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
      try { handlers.onMessage?.(raw, send); }
      catch (e) { handlers.onStatus?.('error', String(e)); }
    });

    ws.on('error', (e) => handlers.onStatus?.('error', e?.message || String(e)));

    ws.on('close', () => {
      clearInterval(pingTimer);
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
      clearInterval(pingTimer);
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

  /** Sorted [[price,size]...] — bids descending, asks ascending. */
  toArray() {
    const out = [...this.m.entries()];
    out.sort(this.isBid ? (a, b) => b[0] - a[0] : (a, b) => a[0] - b[0]);
    return out;
  }
  get size() { return this.m.size; }
}

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
