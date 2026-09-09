/**
 * One websocket to this server, carrying one book. Instantiable.
 *
 * It used to be a module singleton, which was right while the page showed one
 * venue. Combined and compare mode need several books at once and the server's
 * websocket protocol holds ONE subscription per socket — `subscribe` replaces
 * whatever that socket was watching — so N books means N sockets. That is a
 * client-side answer on purpose: extending the protocol would have touched the
 * hub, the quota accounting and the conformance suite, to buy nothing the
 * existing ceilings do not already allow (24 sockets per address, 12 feeds per
 * client, and joining a feed somebody already holds is free).
 *
 * It owns its lifecycle — reconnect, backoff, the race between a subscription
 * and a symbol the viewer has already moved on from — and reports through
 * callbacks. It touches no DOM and no shared state, so the page decides what a
 * book means and where it goes.
 */

// Exponential, capped, so a server restart is picked up in under a second but a
// server that is gone is not hammered.
const RETRY_MAX_MS = 8000;

/**
 * @param handlers.onBook(book, feed)     a book for the CURRENT subscription
 * @param handlers.onStatus(state, detail, feed)
 */
export function createFeed(handlers = {}) {
  let ws = null;
  let retry = 0;
  let timer = null;
  let closed = false;
  let want = null;   // the subscription this feed should be holding

  const feed = {
    /** What it is currently asking for: { exchange, market, symbol, range }. */
    get spec() { return want; },

    /** Ask for a different book. Safe before the socket is open. */
    subscribe(spec) {
      want = { ...spec };
      send();
      return feed;
    },

    close() {
      closed = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closing */ }
      ws = null;
    },
  };

  function send() {
    if (!want || !ws || ws.readyState !== WebSocket.OPEN) return;
    handlers.onStatus?.('connecting', '', feed);
    ws.send(JSON.stringify({ op: 'subscribe', ...want }));
  }

  function open() {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => { retry = 0; send(); };

    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.op === 'status') { handlers.onStatus?.(m.state, m.detail, feed); return; }
      if (m.op !== 'book') return;
      // A book for something this feed has already left. The server answers the
      // subscription it was given, and a slow venue can land its first book
      // after the next one was chosen — drawing it would put one venue's depth
      // under another's name.
      if (!want || m.exchange !== want.exchange || m.market !== want.market || m.symbol !== want.symbol) return;
      handlers.onBook?.({
        exchange: m.exchange, market: m.market, symbol: m.symbol,
        bids: m.bids, asks: m.asks,
        tsVenue: m.tsVenue, tsRecv: m.tsRecv,
        source: m.source, levels: m.levels, accum: m.accum,
        drift: m.drift, driftTs: m.driftTs,
        vol24h: m.vol24h, volTs: m.volTs ?? null,
      }, feed);
    };

    ws.onclose = () => {
      if (closed) return;
      handlers.onStatus?.('offline', 'server unreachable', feed);
      clearTimeout(timer);
      timer = setTimeout(open, Math.min(RETRY_MAX_MS, 400 * 2 ** retry++));
    };
    // An error is always followed by a close, so the reconnect is driven there
    // and this only makes sure the close actually happens.
    ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
  }

  open();
  return feed;
}
