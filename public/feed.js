import { state, invalidate } from './state.js';

/**
 * The websocket to this server, and nothing else.
 *
 * Split out of app.js because it is the one part of the page that has a
 * lifecycle of its own — it reconnects, it backs off, it races a subscription
 * against a symbol the viewer has already moved on from — and none of that is
 * about rendering. It writes the book into `state` and reports connection
 * changes through a callback, so it never touches the DOM and app.js never
 * touches a socket.
 */

// Exponential, capped, so a server restart is picked up in under a second but a
// server that is gone is not hammered.
const RETRY_MAX_MS = 8000;

let ws = null;
let retry = 0;
let timer = null;
let onStatus = () => {};

/** Tell the server what this page is looking at, if it is looking at anything. */
export function subscribe() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !state.symbol) return;
  onStatus('connecting');
  ws.send(JSON.stringify({
    op: 'subscribe',
    exchange: state.exchange,
    market: state.market,
    symbol: state.symbol,
    range: state.range,
  }));
}

function open() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => { retry = 0; subscribe(); };

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.op === 'status') { onStatus(m.state, m.detail); return; }
    if (m.op !== 'book') return;
    // A book for a symbol the viewer has already left. The server answers the
    // subscription it was given, and a slow venue can land its first book after
    // the next one has been chosen — drawing it would put one venue's depth
    // under another's name.
    if (m.exchange !== state.exchange || m.market !== state.market || m.symbol !== state.symbol) return;
    state.book = {
      bids: m.bids, asks: m.asks,
      tsVenue: m.tsVenue, tsRecv: m.tsRecv,
      source: m.source, levels: m.levels, accum: m.accum,
      drift: m.drift, driftTs: m.driftTs,
    };
    state.bookSeq++;
    state.vol24h = m.vol24h;
    state.volTs = m.volTs ?? null;
    if (state.status !== 'live') onStatus('live');
    invalidate();
  };

  ws.onclose = () => {
    onStatus('offline');
    clearTimeout(timer);
    timer = setTimeout(open, Math.min(RETRY_MAX_MS, 400 * 2 ** retry++));
  };
  // An error is always followed by a close, so the reconnect is driven there
  // and this only makes sure the close actually happens.
  ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
}

/** Start the connection. `handleStatus(state, detail)` owns how it is shown. */
export function connect(handleStatus) {
  onStatus = handleStatus;
  open();
}
