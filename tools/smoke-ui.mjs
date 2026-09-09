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

// A listing name is chosen by whoever lists the token. Serve one that is a
// script and prove the page renders it as text: the symbol menu builds rows
// from exchange strings, and it must never parse them as markup.
{
  const PAYLOAD = '<img src=x onerror="window.__xss=1">';
  await p.route('**/api/symbols*', async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    j.symbols = [{ s: PAYLOAD, d: `${PAYLOAD}/USDT`, base: PAYLOAD, quote: 'USDT' }, ...j.symbols];
    j.count = j.symbols.length;
    await route.fulfill({ response: res, json: j });
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await p.click('#sym-input');
  await p.fill('#sym-input', 'img');
  await p.waitForTimeout(400);
  const seen = await p.evaluate(() => {
    const row = document.querySelector('#sym-menu .menu-i');
    return {
      xss: window.__xss === 1,
      injected: document.querySelectorAll('#sym-menu img').length,
      text: row ? row.firstChild.textContent : '(no row)',
    };
  });
  console.log('hostile listing   ', JSON.stringify(seen));
  if (seen.xss) errs.push('XSS: an exchange-supplied symbol executed script in the page');
  if (seen.injected) errs.push(`XSS: an exchange-supplied symbol created ${seen.injected} <img> node(s)`);
  if (!seen.text.startsWith('<img')) errs.push(`XSS: the hostile name was not rendered verbatim as text (got "${seen.text}")`);
  await p.keyboard.press('Escape');
  await p.unroute('**/api/symbols*');
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(5000);
}

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

for (const [name] of [['OKX', 'BTC/USDT'], ['MEXC', 'BTC/USDT'], ['Bitunix', 'BTC/USDT'], ['Aster', 'BTC/USDT'], ['Lighter', 'BTC/USD'], ['Hyperliquid', 'BTC/USD']]) {
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

// The note is now a truncation signal, not a venue blurb: it must appear when
// the book cannot reach the selected range, and stay silent when it can.
{
  await pickEx('Bitunix');
  const short = await info();
  console.log('bitunix/spot ±2%   ', JSON.stringify(short));
  if (!short.note) errs.push('NOTE: bitunix spot at ±2% should warn that the book ends far short');
  await p.click('#range .seg-b[data-range="0.1"]');
  await p.waitForTimeout(3000);
  const fits = await info();
  console.log('  same book ±0.1%  ', JSON.stringify(fits));
  await p.click('#range .seg-b[data-range="2"]');
  await p.waitForTimeout(3000);
  await pickEx('Coinbase');
  const full = await info();
  console.log('coinbase/spot ±2%  ', JSON.stringify(full));
  if (full.note) errs.push(`NOTE: coinbase reaches ±2%, it should say nothing — got "${full.note}"`);
}

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

// ----------------------------------------------------------------- mobile
// The desktop pass above runs at 1500x900, which is the one width the layout
// was never going to get wrong. A phone is where a toolbar of eight controls
// and a fifteen-row metrics panel stop fitting, and nothing here would have
// said so: the page still loads, the socket still streams, and the controls
// are simply somewhere off to the right where no one can reach them. So the
// assertions are about reach, not about looks.
{
  const mob = await b.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  const mp = await mob.newPage();
  mp.on('pageerror', (e) => errs.push('MOBILE PAGEERROR: ' + e.message));
  mp.on('console', (m) => { if (m.type() === 'error') errs.push('MOBILE CONSOLE: ' + m.text()); });
  await mp.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await mp.waitForTimeout(6000);

  const CONTROLS = ['#market', '#ex-btn', '#sym-input', '#range', '#theme', '#copy', '#png'];
  const geo = await mp.evaluate((sels) => {
    const box = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        inView: r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1,
      };
    };
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      controls: Object.fromEntries(sels.map((s) => [s, box(s)])),
      probe: window.__depthvizProbe?.() ?? null,
    };
  }, CONTROLS);
  console.log('mobile 390x844    ', JSON.stringify(geo));

  if (geo.overflow > 0) errs.push(`RESPONSIVE: the page scrolls sideways by ${geo.overflow}px at 390px wide`);
  for (const [sel, v] of Object.entries(geo.controls)) {
    if (!v) errs.push(`RESPONSIVE: ${sel} is not in the page at 390px`);
    else if (!v.inView) errs.push(`RESPONSIVE: ${sel} is off-screen at 390px (${v.w}x${v.h})`);
    else if (v.h < 26) errs.push(`RESPONSIVE: ${sel} is ${v.h}px tall — below a usable touch target`);
  }
  // A chart squeezed under a wrapped toolbar is the failure mode this whole
  // layout change exists to avoid, so it is asserted rather than eyeballed.
  const ch = geo.probe?.chart;
  if (!ch || ch.h < 300) errs.push(`RESPONSIVE: only ${ch ? ch.h : '?'}px of chart height left at 390px`);

  // The crosshair readout was mouse-only, i.e. absent on every phone. A finger
  // press-and-drag must set it, and lifting the finger must clear it.
  const touch = await mp.evaluate(() => {
    const c = document.getElementById('chart');
    const r = c.getBoundingClientRect();
    const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true,
      clientX: r.left + x, clientY: r.top + y,
    }));
    ev('pointerdown', r.width * 0.35, r.height * 0.6);
    ev('pointermove', r.width * 0.55, r.height * 0.5);
    const dragging = window.__depthvizProbe().hover;
    ev('pointerup', r.width * 0.55, r.height * 0.5);
    return { dragging, released: window.__depthvizProbe().hover };
  });
  console.log('  touch crosshair ', JSON.stringify(touch));
  if (!touch.dragging) errs.push('TOUCH: dragging a finger across the chart set no crosshair');
  if (touch.released) errs.push('TOUCH: the crosshair stayed behind after the finger was lifted');

  // Rotated: the same assertions, on the layout tier above.
  await mp.setViewportSize({ width: 844, height: 390 });
  await mp.waitForTimeout(1200);
  const land = await mp.evaluate((sels) => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    hidden: sels.filter((s) => {
      const e = document.querySelector(s);
      if (!e) return true;
      const r = e.getBoundingClientRect();
      return !(r.width > 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1);
    }),
    chart: window.__depthvizProbe().chart,
  }), CONTROLS);
  console.log('mobile 844x390    ', JSON.stringify(land));
  if (land.overflow > 0) errs.push(`RESPONSIVE: the page scrolls sideways by ${land.overflow}px at 844px wide`);
  if (land.hidden.length) errs.push(`RESPONSIVE: unreachable after rotation: ${land.hidden.join(', ')}`);
  if (land.chart.h < 200) errs.push(`RESPONSIVE: only ${land.chart.h}px of chart height left in landscape`);

  await mp.setViewportSize({ width: 390, height: 844 });
  await mp.waitForTimeout(1500);
  await mp.screenshot({ path: 'tools/out/s_mobile.png' });
  await mob.close();
}

console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no js errors');
await b.close();
