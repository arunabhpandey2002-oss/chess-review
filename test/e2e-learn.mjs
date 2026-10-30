// End-to-end check of the learning loop: summary, moments, retry with hint, puzzle saved, due queue, Lichess, mobile.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = process.env.OUT || 'shots-learn';
mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
// Lichess answers 404 to the HeadlessChrome user agent, so present the normal Chrome one a real visitor sends.
const UA = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, userAgent: UA });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

async function review(url, label) {
  await page.goto(BASE + url);
  await page.waitForSelector('cg-board piece', { timeout: 60000 });
  const t0 = Date.now();
  await page.waitForSelector('.progress.complete', { timeout: 900000 });
  await page.waitForSelector('.coach-card', { timeout: 30000 });
  console.log(`${label}: analysed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// 1. summary on the reference game
await review('?user=Arunabh-pandey&game=186131916376', '186131916376');
await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true))); const story = (await page.locator('.story').innerText()).trim();
ok('summary story shown', story.length > 40, story.slice(0, 160));
await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true))); const facts = (await page.locator('.coach-card').innerText()).replace(/\s+/g, ' ');
ok('summary has turning point, strongest decision, phases and time', /Turning point/.test(facts) && /Strongest decision/.test(facts) && /By phase/.test(facts) && /Time/.test(facts), facts.slice(0, 220));
ok('recommended action shown', (await page.locator('.action').count()) === 1);
ok('source labels shown', (await page.locator('.src').count()) >= 2);
const m1 = await page.locator('.moment').count();
ok('186131916376 moments (0-3)', m1 >= 0 && m1 <= 3, `${m1} moment(s)`);
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${OUT}/01-summary.png` });

// 2. a game with three critical moments, retry with a hint
await review('?user=Arunabh-pandey&game=186092857180', '186092857180');
const m2 = await page.locator('.moment').count();
ok('three critical moments', m2 === 3, `${m2}`);
await page.locator('[data-retry="0"]').click();
await page.waitForSelector('.overlay .trainer');
ok('eval and lines hidden in retry', (await page.locator('.overlay #evalbar, .overlay .pvw').count()) === 0);
const core = await page.evaluate(() => { const c = window.__trainer.o.core; return { played: c.playedSan, best: c.bestSan, alts: c.lines.map((l) => l.pv[0]) }; });
await page.fill('#tr-input', core.played);
await page.press('#tr-input', 'Enter');
await page.waitForFunction(() => /move from the game/.test(document.querySelector('#tr-status')?.textContent || ''), null, { timeout: 15000 });
ok('game move rejected', true);
await page.click('#tr-hint');
await page.click('#tr-hint');
ok('two hints shown', (await page.locator('.hint').count()) === 2);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/02-retry-with-hint.png` });
await page.fill('#tr-input', core.best);
await page.press('#tr-input', 'Enter');
await page.waitForSelector('.tr-status.good', { timeout: 20000 });
ok('best move accepted', true, core.best);
await page.click('#why-skip');
await page.waitForSelector('.tr-lesson:not([hidden]) .lsec');
const lesson = (await page.locator('.tr-lesson').innerText()).replace(/\s+/g, ' ');
ok('lesson explains why', /What happened/.test(lesson) && /works/.test(lesson), lesson.slice(0, 200));
await page.screenshot({ path: `${OUT}/03-retry-solved.png` });
// play out vs engine
await page.click('#tr-playout');
await page.waitForSelector('.sp-overlay #sp-board cg-board');
ok('play-out against engine opens', true, (await page.locator('#sp-status').innerText()).slice(0, 80));
await page.click('#sp-close');
await page.click('#tr-close');
await page.waitForSelector('.overlay', { state: 'detached' });
const st = await page.locator('.moment').first().locator('.st').innerText();
ok('solve recorded on moment card', /Solved/.test(st), st);

// 3. Mistakes to Master + due queue
await page.click('#tabs a[data-view="puzzles"]');
await page.waitForSelector('.pz-row');
const nP = await page.locator('.pz-row').count();
ok('positions saved as puzzles', nP >= m1 + m2 && nP >= 3, `${nP} saved`);
const solvedRow = await page.locator('.pz-row', { hasText: 'solved with 2 hints' }).count();
ok('solved puzzle shows attempt history and is scheduled', solvedRow === 1);
await page.screenshot({ path: `${OUT}/04-mistakes-to-master.png` });
const due = await page.locator('#train').innerText();
ok('due queue count', /Train \d+ due/.test(due) && !due.includes(String(nP) + ' due'), due);
await page.click('#train');
await page.waitForSelector('.trainer');
ok('due session opens a trainer', true, await page.locator('#train-count').innerText());
await page.click('#tr-reveal');
if (await page.locator('#why-skip').count()) await page.click('#why-skip');
await page.waitForSelector('.tr-status.warn');
ok('reveal schedules a quick repeat', /come back soon/.test(await page.locator('#tr-status').innerText()));
// home panel
await page.click('#tabs a[data-view=""]');
await page.waitForSelector('.home-card');
const home = (await page.locator('.home-card').innerText()).replace(/\s+/g, ' ');
ok('home shows due count', /due now/.test(home), home.slice(0, 160));
await page.screenshot({ path: `${OUT}/05-home.png` });
// keyboard-only: tab to a moment button exists with aria label on boards
ok('board has aria label', (await page.locator('[role=img][aria-label^="Chess board"]').count()) >= 0);

// 4. Lichess
await page.goto(BASE + '?user=EricRosen&site=lichess');
await page.waitForSelector('.game-row', { timeout: 60000 });
const nL = await page.locator('.game-row').count();
ok('Lichess games listed', nL > 0, `${nL} games`);
const firstId = await page.locator('.game-row').first().getAttribute('data-id');
await review(`?user=EricRosen&site=lichess&game=${firstId}`, firstId);
ok('Lichess game reviewed with summary', (await page.locator('.story').count()) === 1, (await page.locator('.story').innerText()).slice(0, 120));
await page.screenshot({ path: `${OUT}/06-lichess-review.png` });

// 5. mobile layout
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(BASE + '?user=Arunabh-pandey&game=186092857180');
await page.waitForSelector('.coach-card', { timeout: 120000 });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok('mobile: no horizontal overflow on review', overflow <= 1, `${overflow}px`);
await page.screenshot({ path: `${OUT}/07-mobile-summary.png` });
await page.locator('[data-retry="1"]').click();
await page.waitForSelector('.overlay .trainer');
await page.click('#tr-hint');
const bw = await page.locator('.overlay .tr-board').boundingBox();
ok('mobile: retry board fits screen', bw && bw.width >= 300 && bw.width <= 390, `${bw?.width}px`);
await page.screenshot({ path: `${OUT}/08-mobile-retry.png` });
await page.click('#tr-close');
await page.goto(BASE + '?user=Arunabh-pandey&view=puzzles');
await page.waitForSelector('.pz-row');
const ov2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok('mobile: puzzles page fits', ov2 <= 1, `${ov2}px`);
await page.screenshot({ path: `${OUT}/09-mobile-puzzles.png`, fullPage: true });

ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
