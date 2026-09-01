import { chromium } from 'playwright';
// Same rule as the other tools: never hardcode the port. The deployed service
// listens on 8888, and a tool pointed at nothing reports a broken app rather
// than a misconfigured tool.
const BASE = process.env.DEPTHVIZ_HTTP || 'http://127.0.0.1:8787';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' }).catch((e) => {
  console.error(`could not load ${BASE} — is the server up? (${e.message.split('\n')[0]})`);
  process.exit(1);
});

const info = () => p.evaluate(() => ({
  ex: document.getElementById('ex-label').textContent,
  sym: document.getElementById('sym-input').value,
  pairs: document.getElementById('pairs').textContent,
  live: document.getElementById('live-b').textContent.trim(),
  note: document.getElementById('note').textContent.slice(0, 70),
}));
const pickEx = async (name) => {
  await p.click('#ex-btn');
  await p.click(`#ex-menu .menu-i:not(.disabled) >> text=${name}`);
  await p.waitForTimeout(4500);
};
const pickSym = async (q) => {
  await p.click('#sym-input');
  await p.fill('#sym-input', q);
  await p.waitForTimeout(250);
  const n = await p.locator('#sym-menu .menu-i').count();
  const first = n ? await p.locator('#sym-menu .menu-i').first().innerText() : '(none)';
  await p.keyboard.press('Enter');
  await p.waitForTimeout(4500);
  return `${n} matches, first=${first.replace('\n', ' ')}`;
};

await p.waitForTimeout(5000);
console.log('binance/spot      ', JSON.stringify(await info()));
console.log('  search RAY ->', await pickSym('RAY'));
console.log('  after         ', JSON.stringify(await info()));
await p.mouse.move(500, 500); await p.waitForTimeout(300);
await p.screenshot({ path: 'tools/out/s_binance_ray.png' });

// PERPS -> Coinbase must be disabled
await p.click('#market .seg-b[data-market="perp"]');
await p.waitForTimeout(4500);
await p.click('#ex-btn');
const menu = await p.evaluate(() => [...document.querySelectorAll('#ex-menu .menu-i')].map(e => e.textContent.split(/(?=[a-z])/)[0] + (e.classList.contains('disabled') ? ' [DISABLED]' : '')));
console.log('  perp menu:', JSON.stringify(menu));
await p.keyboard.press('Escape'); await p.click('body', { position: { x: 700, y: 400 } });
console.log('perp default      ', JSON.stringify(await info()));

for (const [name, sym] of [['OKX', 'BTC/USDT'], ['MEXC', 'BTC/USDT'], ['Bitunix', 'BTC/USDT'], ['Hyperliquid', 'BTC/USD']]) {
  await pickEx(name);
  console.log(`${name}/perp`.padEnd(18), JSON.stringify(await info()));
}
await p.screenshot({ path: 'tools/out/s_hl_perp.png' });

// range switch on hyperliquid (forces a different upstream aggregation)
for (const r of ['0.5', '10']) {
  await p.click(`#range .seg-b[data-range="${r}"]`);
  await p.waitForTimeout(4000);
  console.log(`  HL range ±${r}%`.padEnd(18), JSON.stringify(await info()));
}
await p.screenshot({ path: 'tools/out/s_hl_r10.png' });

// back to spot, coinbase
await p.click('#range .seg-b[data-range="2"]');
await p.click('#market .seg-b[data-market="spot"]');
await p.waitForTimeout(4000);
await pickEx('Coinbase');
console.log('coinbase/spot     ', JSON.stringify(await info()));
await p.mouse.move(1100, 600); await p.waitForTimeout(300);
await p.screenshot({ path: 'tools/out/s_coinbase.png' });

// copy + png
await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
await p.click('#copy'); await p.waitForTimeout(400);
const clip = await p.evaluate(() => navigator.clipboard.readText().catch(e => 'ERR ' + e));
console.log('COPY payload head:\n' + clip.split('\n').slice(0, 4).map(l => '   ' + l).join('\n'));
const dl = p.waitForEvent('download', { timeout: 5000 }).catch(() => null);
await p.click('#png');
const d = await dl;
console.log('PNG export:', d ? d.suggestedFilename() : 'no download event');

// light theme
await p.click('#theme'); await p.waitForTimeout(500);
await p.screenshot({ path: 'tools/out/s_light.png' });

console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no js errors');
await b.close();
