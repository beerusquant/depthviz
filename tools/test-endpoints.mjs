/**
 * Deterministic tests for the endpoint pair. No network.
 *
 *   node tools/test-endpoints.mjs
 *
 * What they exist to pin, measured on the Tokyo VPS on 2026-09-09:
 * `depthviz-checks.service` set DEPTHVIZ_URL and nothing else while the service
 * listened on 8888, so every websocket check passed and every HTTP one fell
 * back to the built-in 8787 and found nothing. That read as "FAIL: bitunix"
 * every hour for days — a configuration mistake wearing a venue's name — and
 * left `measure-drift` recording n=0 into the archive it exists to build, while
 * still exiting 0 because it runs without --check.
 *
 * The rule this file holds down: give either variable and the other is derived,
 * give both and both are used exactly as given, and a derivation is always
 * reported rather than silently papering over a half-written config.
 */
import { httpFromWs, wsFromHttp, resolveEndpoints } from './lib/endpoints.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};

console.log('httpFromWs / wsFromHttp');
{
  ok('the deployed pair round-trips', httpFromWs('ws://127.0.0.1:8888/ws') === 'http://127.0.0.1:8888');
  ok('and back', wsFromHttp('http://127.0.0.1:8888') === 'ws://127.0.0.1:8888/ws');
  ok('tls is carried across', httpFromWs('wss://depth.example/ws') === 'https://depth.example');
  ok('and back again', wsFromHttp('https://depth.example') === 'wss://depth.example/ws');
  ok('a non-default port survives', httpFromWs('ws://10.0.0.4:9001/ws') === 'http://10.0.0.4:9001');
  ok('the websocket path is dropped, not carried into the HTTP base',
     httpFromWs('ws://h:1/ws') === 'http://h:1');

  // A wrong scheme must produce nothing rather than a plausible-looking URL:
  // the caller then leaves the variable unset and every tool uses its own
  // documented default, which is a knowable state.
  ok('an http URL is not a websocket URL', httpFromWs('http://127.0.0.1:8888') === null);
  ok('and the reverse', wsFromHttp('ws://127.0.0.1:8888/ws') === null);
  ok('garbage is null, not a throw', httpFromWs('not a url') === null && wsFromHttp('¿') === null);
  ok('so is nothing at all', httpFromWs(null) === null && wsFromHttp(undefined) === null);
}

console.log('\nresolveEndpoints — the half-written config that cost a week');
{
  // The exact unit that was deployed on Tokyo.
  const only = resolveEndpoints({ DEPTHVIZ_URL: 'ws://127.0.0.1:8888/ws' });
  ok('one variable is enough: the other is derived',
     only.env.DEPTHVIZ_HTTP === 'http://127.0.0.1:8888', JSON.stringify(only));
  ok('and the derivation is reported, not silent',
     /DEPTHVIZ_HTTP=http:\/\/127\.0\.0\.1:8888 \(from DEPTHVIZ_URL\)/.test(only.derived), only.derived);
  ok('the given one is untouched', only.env.DEPTHVIZ_URL === 'ws://127.0.0.1:8888/ws');

  const rev = resolveEndpoints({ DEPTHVIZ_HTTP: 'http://127.0.0.1:8888' });
  ok('it works from the other side too', rev.env.DEPTHVIZ_URL === 'ws://127.0.0.1:8888/ws', JSON.stringify(rev));

  // A deployment may genuinely put the two behind different hosts, which is why
  // there are two variables at all. Both given means both used, verbatim.
  const both = resolveEndpoints({ DEPTHVIZ_URL: 'wss://ws.example/ws', DEPTHVIZ_HTTP: 'https://api.example' });
  ok('both given means neither is second-guessed',
     both.env.DEPTHVIZ_URL === 'wss://ws.example/ws' && both.env.DEPTHVIZ_HTTP === 'https://api.example');
  ok('and nothing is reported as derived', both.derived === null);

  // Neither given is a laptop running this by hand: leave both unset so each
  // tool falls back to its own documented default rather than being handed one.
  const none = resolveEndpoints({});
  ok('neither given leaves both unset', Object.keys(none.env).length === 0 && none.derived === null);

  // A malformed value must not be turned into a second malformed value.
  const bad = resolveEndpoints({ DEPTHVIZ_URL: 'nonsense' });
  ok('an unreadable value derives nothing',
     bad.env.DEPTHVIZ_HTTP === undefined && bad.derived === null, JSON.stringify(bad));
  ok('but it is still passed through, so the failure names what was configured',
     bad.env.DEPTHVIZ_URL === 'nonsense');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
