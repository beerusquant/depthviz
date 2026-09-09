/**
 * The two ways to reach a running depthviz, kept in step with each other.
 *
 * By design the tools take two variables: the ones that stream read
 * `DEPTHVIZ_URL` (a websocket), the ones that call the JSON API read
 * `DEPTHVIZ_HTTP`. That split is right — they are different protocols and a
 * deployment can genuinely put them behind different hosts — but it made the
 * configuration possible to do HALF, and half is worse than not at all.
 *
 * Measured on the Tokyo VPS, 2026-09-09. `depthviz-checks.service` set
 * `DEPTHVIZ_URL=ws://127.0.0.1:8888/ws` and nothing else, while the service
 * listens on 8888. Every websocket check therefore passed and every HTTP one
 * fell back to the built-in `http://127.0.0.1:8787`, where nothing answers:
 *
 *   verify-bitunix   ws checks pass, the ws-vs-REST drift check fails
 *                    -> "FAIL: bitunix" every hour for days, blamed on the venue
 *   measure-drift    180 request errors, n=0, INCONC on all four instruments
 *                    -> and because it runs without --check it exits 0, so the
 *                       verdict counted it as passed while the archive it
 *                       exists to build recorded nothing at all
 *
 * That is §4 with a different hardcoded value: a configuration mistake reading
 * as a venue being unwell. The fix is not to write the second variable down in
 * one more place — it is to make one of them enough. Give either, and the other
 * is derived; give both, and both are used exactly as given.
 */

/** ws://host/ws -> http://host, wss:// -> https://. Null when it cannot be read. */
export function httpFromWs(wsUrl) {
  if (!wsUrl) return null;
  try {
    const u = new URL(wsUrl);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    return `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}`;
  } catch { return null; }
}

/** http://host -> ws://host/ws, https:// -> wss://. Null when it cannot be read. */
export function wsFromHttp(httpUrl) {
  if (!httpUrl) return null;
  try {
    const u = new URL(httpUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/ws`;
  } catch { return null; }
}

/**
 * Fill in whichever of the two is missing, and say what was derived.
 *
 * Returns `{ env, derived }` — `env` is the pair to hand to a child process,
 * `derived` names what had to be worked out, so the run can print it rather
 * than silently paper over a configuration that is still half-written.
 */
export function resolveEndpoints(env = {}) {
  const ws = env.DEPTHVIZ_URL || null;
  const http = env.DEPTHVIZ_HTTP || null;
  if (ws && http) return { env: { DEPTHVIZ_URL: ws, DEPTHVIZ_HTTP: http }, derived: null };
  if (ws) {
    const d = httpFromWs(ws);
    return d
      ? { env: { DEPTHVIZ_URL: ws, DEPTHVIZ_HTTP: d }, derived: `DEPTHVIZ_HTTP=${d} (from DEPTHVIZ_URL)` }
      : { env: { DEPTHVIZ_URL: ws }, derived: null };
  }
  if (http) {
    const d = wsFromHttp(http);
    return d
      ? { env: { DEPTHVIZ_URL: d, DEPTHVIZ_HTTP: http }, derived: `DEPTHVIZ_URL=${d} (from DEPTHVIZ_HTTP)` }
      : { env: { DEPTHVIZ_HTTP: http }, derived: null };
  }
  // Neither given: leave both unset so every tool falls back to its own
  // documented default, which is the local dev port and is the right answer
  // when somebody runs this by hand on their laptop.
  return { env: {}, derived: null };
}
