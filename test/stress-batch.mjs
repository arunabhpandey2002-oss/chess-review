// Stress: a real 25-game batch; heap before/during/after (CDP, after forced GC), engine workers alive, errors.
// Saves a full backup of the result to stress/seed-backup.json for the large-library seeding test.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const MODE = process.env.MODE || 'standard';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--enable-precise-memory-info'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
const cdp = await ctx.newCDPSession(page);
await cdp.send('HeapProfiler.enable');
const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); const m = await cdp.send('Runtime.getHeapUsage'); return +(m.usedSize / 1048576).toFixed(1); };
const workers = () => page.workers().length;
const est = () => page.evaluate(async () => { const e = await navigator.storage.estimate(); return +((e.usage ?? 0) / 1048576).toFixed(1); });
await page.goto(BASE + '?user=Arunabh-pandey');
await page.waitForSelector('.game-row', { timeout: 60000 });
const h0 = await heap(); const w0 = workers();
console.log(`before: heap ${h0} MB, workers ${w0}, storage ${await est()} MB`);
await page.click('#b-open');
await page.check('input[name="b-n"][value="25"]');
await page.selectOption('#b-mode', MODE);
await page.waitForTimeout(300);
console.log('estimate:', await page.locator('#b-est').innerText());
const t0 = Date.now();
await page.click('#b-start');
await page.waitForFunction(() => window.__batch?.running, null, { timeout: 120000 });
const samples = [];
let peakW = 0;
while (true) {
  await page.waitForTimeout(30000);
  const s = await page.evaluate(() => ({ done: window.__batch.jobs.filter((j) => ['done', 'skipped', 'failed'].includes(j.status)).length, n: window.__batch.jobs.length, running: window.__batch.running }));
  const h = await heap(); peakW = Math.max(peakW, workers());
  samples.push({ t: Math.round((Date.now() - t0) / 1000), done: s.done, heap: h, workers: workers() });
  console.log(`t=${samples.at(-1).t}s ${s.done}/${s.n} games, heap ${h} MB, workers ${workers()}`);
  if (!s.running) break;
  if (Date.now() - t0 > 45 * 60000) { console.log('timeout'); break; }
}
await page.waitForTimeout(2000);
const snap = await page.evaluate(() => window.__batch);
const per = snap.jobs.filter((j) => j.status === 'done').map((j) => j.result.ms);
const h1 = await heap();
console.log(`after: heap ${h1} MB, workers ${workers()} (peak ${peakW}), storage ${await est()} MB, ${snap.jobs.map((j) => j.status).join(',')}`);
console.log(`games done ${per.length}, total ${Math.round((Date.now() - t0) / 1000)} s, mean ${Math.round(per.reduce((a, b) => a + b, 0) / per.length / 1000)} s/game`);
// navigate around after the batch and re-measure (leak check across pages)
for (const v of ['puzzles', 'history', '', 'puzzles', 'history', '']) { await page.goto(BASE + '?user=Arunabh-pandey' + (v ? '&view=' + v : '')); await page.waitForTimeout(800); }
console.log(`after browsing: heap ${await heap()} MB, workers ${workers()}`);
const counts = await page.evaluate(async () => { const db = await new Promise((r) => { const q = indexedDB.open('chess-review'); q.onsuccess = () => r(q.result); }); const out = {}; for (const s of db.objectStoreNames) out[s] = await new Promise((r) => { const q = db.transaction(s).objectStore(s).count(); q.onsuccess = () => r(q.result); }); return out; });
console.log('records:', JSON.stringify(counts));
await page.goto(BASE + '?user=Arunabh-pandey&view=data');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exp')]);
await dl.saveAs('stress/seed-backup.json');
writeFileSync('stress/batch-result.json', JSON.stringify({ h0, h1, w0, peakW, samples, per, counts, errors }, null, 1));
console.log('errors:', errors.length ? errors.slice(0, 5).join(' | ') : 'none');
await browser.close();
