/**
 * Deterministic tests for the socket liveness watchdog. No exchange, no network
 * beyond loopback: the two servers below are the two cases that matter.
 *
 *   node tools/test-reconnect.mjs
 *
 * The failure it exists for: a TCP connection killed without a FIN — a NAT table
 * entry expiring, a load balancer dropping the flow — leaves the socket
 * `readyState === OPEN` forever. No error, no close, no data. The feed then
 * reads `live` and serves the book frozen at the instant the path broke, which
 * is the one thing this tool must never do.
 *
 * The other half is just as important and is tested here too: a book can be
 * genuinely quiet for minutes on an illiquid pair, so a watchdog that kills a
 * healthy-but-silent socket would be a worse bug than the one it fixes. That is
 * why liveness is proven by the venue answering a ping, not by data arriving.
 */
import { WebSocketServer } from 'ws';
import { reconnectingWs } from '../server/util.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PING_MS = 200;              // watchdog fires at PING_MS * 2.5 = 500ms
const listen = (opts) => new Promise((res) => {
  const wss = new WebSocketServer({ port: 0, ...opts });
  wss.on('listening', () => res(wss));
});

console.log('reconnectingWs — the idle watchdog');

{
  // A server that never answers a ping and never sends a frame: the socket is
  // open and worthless, which is exactly what a dead path looks like.
  const wss = await listen({ autoPong: false });
  let opens = 0;
  const states = [];
  wss.on('connection', () => { opens++; });
  const conn = reconnectingWs(`ws://127.0.0.1:${wss.address().port}`, {
    onStatus: (st, d) => states.push(`${st}${d ? `:${d}` : ''}`),
  }, { pingMs: PING_MS });

  // The budget: the watchdog fires at 500 ms, and the reconnect that follows
  // waits 500 ms of backoff plus up to 400 ms of jitter — so the second
  // connection lands between 1005 and 1405 ms. Waiting 1400 ms put the
  // assertion exactly on that upper edge and this test failed most runs, which
  // is worse than not having it: a suite with one habitual red line teaches
  // people to read past red lines.
  await wait(2200);
  conn.close();
  wss.close();

  ok('a socket that proves nothing is declared dead',
     states.some((s) => s.includes('socket assumed dead')), states.join(' | '));
  ok('and the connection is retried rather than left hanging', opens >= 2, `opens=${opens}`);
}

{
  // The same silence, but the server answers pings. Nothing arrives on this
  // socket either — and it must be left alone.
  const wss = await listen({});      // ws auto-pongs by default
  let opens = 0;
  const states = [];
  wss.on('connection', () => { opens++; });
  const conn = reconnectingWs(`ws://127.0.0.1:${wss.address().port}`, {
    onStatus: (st, d) => states.push(`${st}${d ? `:${d}` : ''}`),
  }, { pingMs: PING_MS });

  await wait(1400);
  conn.close();
  wss.close();

  ok('a quiet book whose venue still answers is left alone',
     !states.some((s) => s.includes('assumed dead')), states.join(' | '));
  ok('and it is never reconnected', opens === 1, `opens=${opens}`);
}

{
  // Data alone also proves the path: a venue that sends frames but ignores pings
  // is alive, and killing it every 500ms would be a self-inflicted outage.
  const wss = await listen({ autoPong: false });
  const states = [];
  wss.on('connection', (ws) => {
    const t = setInterval(() => { try { ws.send('tick'); } catch {} }, 100);
    ws.on('close', () => clearInterval(t));
  });
  let msgs = 0;
  const conn = reconnectingWs(`ws://127.0.0.1:${wss.address().port}`, {
    onMessage: () => { msgs++; },
    onStatus: (st, d) => states.push(`${st}${d ? `:${d}` : ''}`),
  }, { pingMs: PING_MS });

  await wait(1400);
  conn.close();
  wss.close();

  ok('inbound frames alone keep the socket alive',
     !states.some((s) => s.includes('assumed dead')) && msgs > 5,
     `msgs=${msgs} ${states.join(' | ')}`);
}

{
  // No pingMs means no watchdog: a caller that opted out must not have its
  // socket torn down behind its back.
  const wss = await listen({ autoPong: false });
  let opens = 0;
  wss.on('connection', () => { opens++; });
  const conn = reconnectingWs(`ws://127.0.0.1:${wss.address().port}`, {}, {});
  await wait(900);
  conn.close();
  wss.close();
  ok('no pingMs, no watchdog', opens === 1, `opens=${opens}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
