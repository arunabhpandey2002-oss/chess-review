import { chromium } from '@playwright/test';
const BASE = process.env.BASE || 'http://localhost:4173/';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(BASE);
await page.waitForSelector('.game-row', { timeout: 30000 });
console.log('games listed:', await page.locator('.game-row').count());
console.log('first row:', (await page.locator('.game-row').first().innerText()).replace(/\s+/g, ' '));
await page.screenshot({ path: 'shots/01-game-list.png', fullPage: false });
await page.locator('.game-row[data-id="186131916376"]').click();
await page.waitForSelector('cg-board piece');
const t0 = Date.now();
await page.waitForSelector('.progress.complete', { timeout: 600000 });
console.log('analysis seconds:', ((Date.now() - t0) / 1000).toFixed(1));
const lines = logs.filter((l) => l.includes('analysis done')); console.log(lines.join('\n'));
// go to 13...Nc2+ (ply 26) and 28.Bf6 (ply 55)
async function at(ply, shot) {
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('ArrowUp');
  for (let i = 0; i < ply; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);
  const card = (await page.locator('#movecard').innerText()).replace(/\n+/g, ' | ');
  console.log(`ply ${ply}:`, card);
  if (shot) await page.screenshot({ path: shot });
}
await at(25, 'shots/03-move-25-c3-blunder.png');
await at(26, 'shots/02-move-26-Nc2-fork.png');
await at(55, 'shots/04-move-55-Bf6.png');
const br = await page.evaluate(() => window.__review.reviews.map((r, i) => ({ i, cls: r && r.cls, best: r && r.bestSan, loss: r && r.loss })));
(await import('node:fs')).writeFileSync('test/browser18.json', JSON.stringify(br));
console.log('summary:', (await page.locator('#summary').innerText()).replace(/\s+/g, ' '));
// graph click jump
const g = await page.locator('#graph').boundingBox();
await page.mouse.click(g.x + g.width * 0.5, g.y + g.height / 2);
await page.waitForTimeout(300);
console.log('after graph click:', (await page.locator('.mv.cur').innerText()).trim());
// flip
await page.click('#c-flip');
await page.waitForTimeout(300);
console.log('orientation after flip:', await page.locator('.cg-wrap').getAttribute('class'));
await page.screenshot({ path: 'shots/05-flipped.png' });
// mobile
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mp = await m.newPage();
await mp.goto(BASE + '?user=Arunabh-pandey&game=186131916376');
await mp.waitForSelector('.progress.complete', { timeout: 600000 }); // should be instant from cache? separate context => re-analysis
await mp.locator('.mv[data-ply="26"]').click();
await mp.waitForTimeout(400);
await mp.screenshot({ path: 'shots/06-mobile-review.png', fullPage: true });
await mp.goto(BASE);
await mp.waitForSelector('.game-row');
await mp.screenshot({ path: 'shots/07-mobile-list.png' });
console.log('errors:', logs.filter((l) => /error/i.test(l)).join('\n') || 'none');
await browser.close();
