// Mistakes to Master draws a large library 40 rows at a time with a "Show more" button (desktop and phone).
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const base = JSON.parse(readFileSync('test/fixtures/puzzles3.json', 'utf8'));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== '' ? ' — ' + info : ''}`); };
for (const [tag, viewport, mobile] of [['desktop', { width: 1400, height: 950 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(30000);
  await page.goto(BASE + '?user=Arunabh-pandey&view=data');
  await page.waitForSelector('h1');
  await page.evaluate(async (base) => {
    const db = await new Promise((r, j) => { const q = indexedDB.open('chess-review'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    await new Promise((r, j) => { const t = db.transaction('puzzles', 'readwrite'); for (let i = 0; i < 95; i++) { const p = base[i % 3]; t.objectStore('puzzles').put({ ...p, id: `${p.id}-${i}`, gameId: `${p.gameId}x${i}` }); } t.oncomplete = r; t.onerror = () => j(t.error); });
    db.close();
  }, base);
  const t0 = Date.now();
  await page.goto(BASE + '?user=Arunabh-pandey&view=puzzles');
  await page.waitForSelector('.pz-row');
  check(`${tag}: first page opens`, true, `${Date.now() - t0} ms`);
  check(`${tag}: 40 rows drawn first`, (await page.locator('.pz-row').count()) === 40, await page.locator('.pz-row').count());
  check(`${tag}: filter chip counts all 95`, /All \(95\)/.test(await page.locator('.chip').first().innerText()));
  check(`${tag}: show more button says 40 more (55 left)`, /Show 40 more.*55 left/s.test(await page.locator('#pz-more').innerText()));
  await page.click('#pz-more');
  check(`${tag}: 80 rows after one click`, (await page.locator('.pz-row').count()) === 80);
  await page.click('#pz-more');
  check(`${tag}: all 95 rows, button gone`, (await page.locator('.pz-row').count()) === 95 && (await page.locator('#pz-more').count()) === 0);
  check(`${tag}: appended rows have boards`, (await page.locator('.pz-row').nth(94).locator('cg-board').count()) === 1);
  await page.locator('.pz-row').nth(90).locator('[data-train]').click();
  await page.waitForURL(/view=train/);
  check(`${tag}: Train button on an appended row works`, /view=train/.test(page.url()));
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  check(`${tag}: no horizontal overflow`, sw <= viewport.width, sw);
  check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}
console.log(`\n${pass}/${pass + fail} checks passed`);
await browser.close();
process.exit(fail ? 1 : 0);
