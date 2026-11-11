// Stress: storage quota exhausted. Caps this origin's quota just above what it uses (CDP Storage.overrideQuotaForOrigin),
// then runs a batch and opens a review. Checks: no uncaught errors, the batch ends, engine workers are cleaned up, pages still load.
import { chromium } from '@playwright/test';
const BASE = process.env.BASE || 'http://localhost:4173/';
const N = process.env.N || '10';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();
const errors = [], logs = []; let phase = 'load';
page.on('pageerror', (e) => errors.push(`pageerror [${phase}]: ${e.message}`));
page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/Failed to load resource/.test(m.text())) logs.push(m.type() + ': ' + m.text()); });
page.on('dialog', (d) => d.accept());
if (process.env.TRACE) await page.addInitScript(() => { const o = IDBDatabase.prototype.transaction; IDBDatabase.prototype.transaction = function (...a) { const st = new Error().stack; const t = o.apply(this, a); t.addEventListener('abort', () => console.log('IDBABORT ' + a[0] + ' ' + st.split('\n').slice(2, 7).join(' < '))); return t; }; });
if (process.env.TRACE) page.on('console', (m) => { if (m.text().startsWith('IDBABORT')) console.log(`[${phase}] ` + m.text()); });
const cdp = await ctx.newCDPSession(page);
const U = '?user=demo-player';
await page.goto(BASE + U); await page.waitForSelector('.game-row', { timeout: 60000 });
const origin = new URL(BASE).origin;
const est = () => page.evaluate(async () => { const e = await navigator.storage.estimate(); return { used: e.usage, quota: e.quota }; });
const e0 = await est();
const cap = (e0.used ?? 0) + 200 * 1024;
await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: cap });
console.log('quota capped to', (cap / 1048576).toFixed(2), 'MB; used', ((e0.used ?? 0) / 1048576).toFixed(2), 'MB', JSON.stringify(await est()));
await page.click('#b-open');
await page.check(`input[name="b-n"][value="${N}"]`).catch(async () => { await page.check('input[name="b-n"]'); });
await page.waitForTimeout(300);
const t0 = Date.now();
phase = 'batch'; await page.click('#b-start');
await page.waitForFunction(() => window.__batch?.running, null, { timeout: 60000 }).catch(() => console.log('batch never started'));
let s;
while (true) {
  await page.waitForTimeout(10000);
  s = await page.evaluate(() => ({ running: window.__batch.running, st: window.__batch.jobs.map((j) => j.status + (j.status === 'running' ? `[${j.stage} ${j.posDone}/${j.posTotal}]` : '') + (j.error ? `(${j.error.slice(0, 60)})` : '')) }));
  console.log(`t=${Math.round((Date.now() - t0) / 1000)}s running=${s.running} workers=${page.workers().length} ${s.st.join(',')}`);
  if (!s.running || Date.now() - t0 > (+process.env.MAXS || 1200) * 1000) break;
}
await page.waitForTimeout(1500);
console.log('after batch: workers', page.workers().length, 'storage', JSON.stringify(await est()));
console.log('panel:', (await page.locator('#batch-panel, .b-panel, #home-panel').first().innerText().catch(() => '')).slice(0, 300).replace(/\n/g, ' / '));
phase = 'pages'; // pages still load
for (const v of ['puzzles', 'history', '']) { const t = Date.now(); await page.goto(BASE + U + (v ? '&view=' + v : '')); await page.waitForLoadState('networkidle'); console.log(`view ${v || 'games'} loaded in ${Date.now() - t} ms`); }
// open a review of a game the batch did not do (last row)
const gid = await page.locator('.game-row').last().getAttribute('data-id').catch(() => null);
const rowCount = await page.locator('.game-row').count();
phase = 'review'; await page.locator('.game-row').nth(rowCount - 1).click();
const t1 = Date.now();
await page.waitForSelector('.progress.complete', { timeout: 300000 }).then(() => console.log(`review completed in ${Date.now() - t1} ms (${gid})`)).catch(() => console.log('review did not complete'));
console.log('review text:', (await page.locator('#progress .ptext').innerText().catch(() => '')));
console.log('workers on review page', page.workers().length);
await page.goto(BASE + U); await page.waitForSelector('.game-row');
console.log('workers after leaving review', page.workers().length);
console.log('errors:', errors.length ? errors.join(' | ') : 'none');
console.log('console errors/warnings:', logs.length ? [...new Set(logs)].slice(0, 8).join(' | ') : 'none');
await browser.close();
