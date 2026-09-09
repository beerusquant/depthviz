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
import { resolveEndpoints } from './lib/endpoints.mjs';

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
  ['conformance',     ['tools/test-conformance.mjs']],
  ['reconnect tests', ['tools/test-reconnect.mjs']],
  ['stitch tests',    ['tools/test-stitch.mjs']],
  ['trim tests',      ['tools/test-trim.mjs']],
  ['endpoint tests',  ['tools/test-endpoints.mjs']],
  ['search tests',    ['tools/test-search.mjs']],
  ['metrics tests',   ['tools/test-metrics.mjs']],
  ['aggregate tests', ['tools/test-aggregate.mjs']],
  ['limit tests',     ['tools/test-limits.mjs']],
  ['health tests',    ['tools/test-health.mjs']],
  ['recording tests', ['tools/test-recording.mjs']],
  ['ccxt crosscheck', ['tools/crosscheck-ccxt.mjs']],
  ['bitunix',         ['tools/verify-bitunix.mjs']],
  ['hyperliquid',     ['tools/verify-hyperliquid.mjs']],
  // Not a test of the code: a re-derivation of the distributions two thresholds
  // were set from. It runs WITHOUT --check on purpose, and three minutes is
  // deliberately too short to gate on — a p95 over ~180 readings is the ninth
  // largest of them, and the tool reports INCONC rather than judging on it.
  // What this buys is the archive nobody had: one distribution per hour in
  // logs/measurements/, so the next threshold argument has a sample behind it
  // instead of an afternoon's anecdote. Re-derive deliberately with
  // `npm run measure:drift -- --check`, which defaults to fifteen minutes.
  ['drift distribution', ['tools/measure-drift.mjs', '--minutes', '3']],
];

// A check that never returns is worse than one that fails: it produces no
// verdict, no log line and no exit code, and the hourly unit sits there until
// systemd's TimeoutStartSec kills it silently half an hour later. Observed on
// 2026-09-08 — the ccxt crosscheck spawns a child per venue with no bound of
// its own, and one of them hung for over an hour while every other check waited
// behind it. A timeout that reports is the whole point.
const TIMEOUT_MS = +process.env.DEPTHVIZ_CHECK_TIMEOUT_MS || 15 * 60_000;

/**
 * The endpoint pair every child inherits, with whichever half was missing
 * filled in — see tools/lib/endpoints.mjs for the hour of false failures that
 * bought this. Resolved once, here, rather than in each of sixteen tools.
 */
const ENDPOINTS = resolveEndpoints(process.env);
const CHILD_ENV = { ...process.env, ...ENDPOINTS.env };

const run = (args) => new Promise((res) => {
  const p = spawn(process.execPath, args, { cwd: root, env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill('SIGTERM');
    // A child ignoring SIGTERM is exactly the child this exists for.
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 5000).unref();
  }, TIMEOUT_MS);
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => {
    clearTimeout(timer);
    if (timedOut) {
      out += `\n[run-checks] killed after ${(TIMEOUT_MS / 60_000).toFixed(0)} min — a check that never reports is not a pass\n`;
      return res({ code: 124, out });
    }
    res({ code, out });
  });
});

const started = new Date();
// Printed, never silent: a derived endpoint is a configuration that was written
// half-way, and the next person to read this log should see which half.
console.log(`depthviz checks — ws ${CHILD_ENV.DEPTHVIZ_URL || '(tool default)'}`
  + `  http ${CHILD_ENV.DEPTHVIZ_HTTP || '(tool default)'}`
  + (ENDPOINTS.derived ? `\n  derived ${ENDPOINTS.derived}` : ''));
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
