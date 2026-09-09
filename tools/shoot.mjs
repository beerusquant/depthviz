/**
 * Regenerate the screenshots the README embeds.
 *
 * They are real captures of a live book, not mockups, which is the only kind
 * worth putting in a README of a tool whose whole claim is that the numbers are
 * right. Because they are live, re-running this produces a different book: run
 * it when the UI changes, not to chase a prettier print.
 *
 *   node server/index.js &
 *   node tools/shoot.mjs                 # honours DEPTHVIZ_HTTP like every tool here
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.DEPTHVIZ_HTTP || 'http://127.0.0.1:8787';
const OUT = 'docs/img';
mkdirSync(OUT, { recursive: true });

// 60s, not 6s. Binance's deep tail is accumulated from diffs, so for its first
// minute the app correctly says the far depth is still a lower bound — true,
// but it is a transient state, and a README screenshot showing it would read as
// a permanent caveat. Waiting it out is cheaper than explaining it.
const settle = 66000;

const b = await chromium.launch({ channel: 'chrome' });

const shoot = async (name, contextOpts, prepare) => {
  const ctx = await b.newContext(contextOpts);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/single.html`, { waitUntil: 'networkidle' }).catch((e) => {
    console.error(`could not load ${BASE} — is the server up? (${e.message.split('\n')[0]})`);
    process.exit(1);
  });
  await p.waitForTimeout(settle);
  if (prepare) await prepare(p);
  // Park the cursor off-canvas so no crosshair lands in a published image.
  await p.mouse.move(2, 2);
  await p.waitForTimeout(600);
  const path = `${OUT}/${name}.png`;
  await p.screenshot({ path });
  const info = await p.evaluate(() => ({
    sym: document.getElementById('sym-input').value,
    ex: document.getElementById('ex-label').textContent,
    live: document.getElementById('live-b').textContent.trim(),
  }));
  console.log(path.padEnd(28), JSON.stringify(info));
  await ctx.close();
};

await shoot('desktop', { viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2 });

await shoot('mobile', {
  viewport: { width: 390, height: 780 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
});

await b.close();
