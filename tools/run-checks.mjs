/**
 * One command that runs every proof this repo has, meant for a timer.
 *
 * Why bother: an exchange can change a field or a contract multiplier
 * overnight. The chart stays beautiful and the numbers become wrong by a
 * factor of a hundred, and nothing says so — that is exactly how the OKX
 * contract-size bug survived. A check that only runs when someone remembers to
 * run it does not catch that.
 *
 *   node tools/run-checks.mjs            # needs the server up; honours DEPTHVIZ_URL
 *
 * Exit code is non-zero if ANY check failed, and the last line is a one-line
 * verdict so a log reader (or a human on `journalctl`) sees the state at once.
 * Neither a skip nor an inconclusive result counts as a pass anywhere here.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const LOG = process.env.DEPTHVIZ_CHECK_LOG || path.join(root, 'logs', 'checks.log');

// Every deterministic suite, not a subset of them: `npm test` grew two suites
// that this list never learned about, so a timer reporting ALL PASS was
// reporting on two thirds of the arithmetic.
const CHECKS = [
  ['book tests',      ['tools/test-book.mjs']],
  ['diff-book tests', ['tools/test-diff-book.mjs']],
  ['adapter tests',   ['tools/test-adapters.mjs']],
  ['reconnect tests', ['tools/test-reconnect.mjs']],
  ['stitch tests',    ['tools/test-stitch.mjs']],
  ['trim tests',      ['tools/test-trim.mjs']],
  ['metrics tests',   ['tools/test-metrics.mjs']],
  ['ccxt crosscheck', ['tools/crosscheck-ccxt.mjs']],
  ['bitunix',         ['tools/verify-bitunix.mjs']],
  ['hyperliquid',     ['tools/verify-hyperliquid.mjs']],
];

const run = (args) => new Promise((res) => {
  const p = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => res({ code, out }));
});

const started = new Date();
const results = [];
for (const [name, args] of CHECKS) {
  const t0 = Date.now();
  const { code, out } = await run(args);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  results.push({ name, ok: code === 0, secs, out });
  console.log(`\n===== ${name} (${secs}s) — ${code === 0 ? 'PASS' : 'FAIL'} =====`);
  console.log(out.trim());
}

const bad = results.filter((r) => !r.ok);
const verdict = bad.length === 0
  ? `ALL PASS — ${results.map((r) => r.name).join(', ')}`
  : `FAIL: ${bad.map((r) => r.name).join(', ')}  (passed: ${results.filter((r) => r.ok).map((r) => r.name).join(', ') || 'none'})`;

// Keep the one-line history even when nobody is reading the journal.
try {
  mkdirSync(path.dirname(LOG), { recursive: true });
  appendFileSync(LOG, `${started.toISOString()} ${verdict}\n`);
} catch (e) {
  console.log(`(could not write ${LOG}: ${e.message})`);
}

console.log(`\n${verdict}`);
process.exit(bad.length ? 1 : 0);
