/**
 * Who is allowed to hold how many upstream feeds.
 *
 * The hub already caps how many feeds exist at once, which protects the host.
 * It does not protect the OTHER viewers: one client cycling a symbol list takes
 * every slot, each one lingering 30 s after it lets go, and everybody else is
 * refused from a server that is behaving exactly as designed. On loopback that
 * is theoretical; the moment HOST is set to anything else it is a denial of
 * service that costs nothing to mount and spends this IP's rate-limit budget at
 * eight exchanges while it runs.
 *
 * So the accounting is per owner (a remote address), and it is a separate
 * module for one reason: constructing a real Feed opens sockets to an exchange,
 * so the only way to test the rule deterministically is to keep the rule out of
 * the thing that opens sockets. tools/test-quota.mjs pins it with no network.
 *
 * Joining a feed somebody else already holds is deliberately free of charge —
 * two viewers on BTCUSDT cost one upstream connection, and charging the second
 * one for it would refuse the cheapest possible request.
 */
export class Quota {
  constructor(maxPerOwner) {
    this.max = maxPerOwner;
    this.held = new Map();   // owner -> Map(key -> refcount)
  }

  /** How many distinct feeds this owner is holding. */
  count(owner) { return this.held.get(owner)?.size ?? 0; }

  /**
   * Take a reference for `owner` on `key`, or throw explaining the refusal.
   * A key the owner already holds never counts against the cap again.
   */
  acquire(owner, key) {
    let mine = this.held.get(owner);
    if (!mine) { mine = new Map(); this.held.set(owner, mine); }
    if (!mine.has(key) && mine.size >= this.max) {
      // Tagged, because a refusal and an upstream failure are different answers
      // and a caller has to be able to tell them apart: one means slow down,
      // the other means the exchange is unwell. Reported as 429, not 504.
      const e = new Error(`you are already holding ${mine.size} feeds (max ${this.max} per client); close one first`);
      e.code = 'QUOTA';
      throw e;
    }
    mine.set(key, (mine.get(key) ?? 0) + 1);
    return mine.size;
  }

  /** Drop one reference. The owner is forgotten once it holds nothing. */
  release(owner, key) {
    const mine = this.held.get(owner);
    if (!mine) return;
    const n = (mine.get(key) ?? 0) - 1;
    if (n > 0) mine.set(key, n);
    else mine.delete(key);
    if (mine.size === 0) this.held.delete(owner);
  }

  get owners() { return this.held.size; }
}

/**
 * A capped counter of concurrent things per owner — websocket connections.
 *
 * Separate from Quota because a socket is not a feed: a client can hold one
 * feed and open two hundred sockets, and each of those sockets is memory and an
 * event-loop cost before it has subscribed to anything at all.
 */
export class Counter {
  constructor(max) { this.max = max; this.n = new Map(); }
  add(owner) {
    const c = this.n.get(owner) ?? 0;
    if (c >= this.max) return false;
    this.n.set(owner, c + 1);
    return true;
  }
  sub(owner) {
    const c = (this.n.get(owner) ?? 0) - 1;
    if (c > 0) this.n.set(owner, c); else this.n.delete(owner);
  }
  count(owner) { return this.n.get(owner) ?? 0; }
  get owners() { return this.n.size; }
}
