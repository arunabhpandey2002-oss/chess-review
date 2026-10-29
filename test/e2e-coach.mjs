// E2E for the why-you-erred coach and Play it out, on desktop and a 390x844 phone.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = process.env.OUT || 'shots-coach';
mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const UA = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
const GAME = '?user=Arunabh-pandey&game=186092857180';
const errors = [];
const statusHas = (page, sel, re) => page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent || ''), [sel, re.source], { timeout: 60000 });

async function openReview(page) {
  await page.goto(BASE + GAME);
  await page.waitForSelector('cg-board piece', { timeout: 60000 });
  await page.waitForSelector('.progress.complete', { timeout: 900000 });
  await page.waitForSelector('.coach-card', { timeout: 30000 });
  await page.waitForFunction(() => window.__coach && window.__coach.played);
  return page.evaluate(() => window.__coach.played);
}
/** a legal move for the side the player controls in the play-it-out board */
const anyMove = (page) => page.evaluate(() => { const d = window.__sparring.cg.state.movable.dests; const [o, t] = [...d.entries()][0]; return o + t[0]; });

async function playOut(page, tag) {
  await page.waitForSelector('.sp-overlay #sp-board cg-board');
  const st = await page.evaluate(() => ({ opts: window.__sparring.st.options, label: window.__sparring.st.label, rating: window.__sparring.st.rating }));
  ok(`${tag}: engine strength from rating`, st.opts.length > 0, `${st.rating} → ${st.opts.join(', ')}`);
  await page.fill('#sp-input', await anyMove(page));
  await page.press('#sp-input', 'Enter');
  await statusHas(page, '#sp-status', /Engine played/);
  ok(`${tag}: engine replies`, true, (await page.locator('#sp-status').innerText()).slice(0, 70));
  await page.click('#sp-back');
  const back = await page.evaluate(() => ({ n: window.__sparring.hist.length, atStart: window.__sparring.fen === window.__sparring.start }));
  ok(`${tag}: take back returns to the start`, back.n === 0 && back.atStart, JSON.stringify(back));
  for (let k = 0; k < 2; k++) {
    await page.fill('#sp-input', await anyMove(page));
    await page.press('#sp-input', 'Enter');
    await page.waitForFunction((n) => window.__sparring.hist.length >= n && !window.__sparring.thinking || window.__sparring.over, (k + 1) * 2, { timeout: 60000 });
  }
}

// ---------------- desktop ----------------
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, userAgent: UA });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const played = await openReview(page);
  ok('three moments with Play it out buttons', played.length === 3 && (await page.locator('[data-play]').count()) === 3, played.join(', '));
  const ix = played.indexOf('exd5');
  ok('15.exd5 is a moment', ix >= 0);

  // 1. why-you-erred, before the answer
  await page.locator(`[data-retry="${ix}"]`).click();
  await page.waitForSelector('.overlay .trainer');
  await page.click('#tr-reveal');
  await page.waitForSelector('.why-card');
  const pre = await page.evaluate(() => ({ chips: document.querySelectorAll('[data-why]').length, status: document.querySelector('#tr-status').textContent, lessons: document.querySelectorAll('.tr-lesson .lsec').length, best: window.__trainer.o.core.bestSan, arrows: window.__trainer.cg.state.drawable.autoShapes.length }));
  ok('question shown before the answer', pre.chips === 5 && pre.lessons === 0 && pre.arrows === 0 && !pre.status.includes(pre.best), JSON.stringify(pre));
  await page.screenshot({ path: `${OUT}/01-why-question.png` });
  await page.click('[data-why="thought-safe"]');
  await page.waitForSelector('#tr-diag');
  const diag = (await page.locator('#tr-diag').innerText()).replace(/\s+/g, ' ');
  ok('diagnosis is grounded in the position', /queen on d3/.test(diag) && /knight on f4/.test(diag) && /Partly/.test(diag), diag.slice(0, 260));
  ok('diagnosis has source labels', (await page.locator('#tr-diag .src').count()) >= 1);
  ok('answer shown after the diagnosis', /The answer is/.test(await page.locator('#tr-status').innerText()));
  await page.locator('#tr-diag').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/02-why-diagnosis.png` });

  // 2. Play it out from the trainer lesson, stacked over it; Escape closes only the play-out
  await page.click('#tr-playout');
  await page.waitForSelector('.sp-overlay');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sp-overlay', { state: 'detached' });
  ok('play-out from the lesson opens and closes over the trainer', (await page.locator('.overlay .trainer').count()) === 1);
  await page.click('#tr-close');
  await page.waitForSelector('.overlay', { state: 'detached' });

  // saved answer is reused, not asked again
  await page.locator(`[data-retry="${ix}"]`).click();
  await page.waitForSelector('.overlay .trainer');
  await page.click('#tr-reveal');
  await page.waitForSelector('.tr-lesson:not([hidden]) .lsec');
  ok('saved diagnosis reused on the next retry', (await page.locator('.why-card').count()) === 0 && (await page.locator('#tr-diag').count()) === 1);
  await page.click('#tr-close');
  await page.waitForSelector('.overlay', { state: 'detached' });

  // 3. Play it out from the moments list
  await page.locator(`[data-play="${ix}"]`).click();
  await playOut(page, 'desktop');
  await page.click('#sp-stop');
  await page.waitForSelector('#sp-end h3', { timeout: 120000 });
  const end = (await page.locator('#sp-end').innerText()).replace(/\s+/g, ' ');
  const nTake = await page.locator('.sp-take li').count();
  ok('stop gives a result and 1-2 takeaways', /You stopped the game/.test(end) && nTake >= 1 && nTake <= 2, end.slice(0, 260));
  ok('takeaways cite the engine', (await page.locator('.sp-take .src').count()) === nTake);
  await page.screenshot({ path: `${OUT}/03-playout-summary.png` });
  await page.click('#sp-again');
  ok('restart resets the game', await page.evaluate(() => window.__sparring.hist.length === 0 && !window.__sparring.over));
  await page.click('#sp-close');
  await page.waitForSelector('.sp-overlay', { state: 'detached' });

  // 4. home shows top causes
  await page.click('#tabs a[data-view=""]');
  await page.waitForSelector('#why-causes');
  const causes = (await page.locator('#why-causes').innerText()).replace(/\s+/g, ' ');
  ok('home shows why-you-go-wrong summary', /Why you go wrong: Missed their threat \(1\)/.test(causes), causes);
  await page.screenshot({ path: `${OUT}/04-home-causes.png` });
  await ctx.close();
}

// ---------------- mobile ----------------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: UA.replace(/\(X11[^)]*\)/, '(Linux; Android 14; Pixel 8)') + ' Mobile', isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const played = await openReview(page);
  const iq = played.indexOf('Rg1') >= 0 ? played.indexOf('Rg1') : 0;
  await page.locator(`[data-retry="${iq}"]`).click();
  await page.waitForSelector('.overlay .trainer');
  await page.click('#tr-reveal');
  await page.waitForSelector('.why-card');
  await page.locator('.why-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/05-mobile-why-question.png` });
  await page.locator('[data-why="no-see"]').tap();
  await page.waitForSelector('#tr-diag');
  const d = (await page.locator('#tr-diag').innerText()).replace(/\s+/g, ' ');
  ok('mobile: diagnosis after a tap', d.length > 40, d.slice(0, 200));
  await page.locator('#tr-diag').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/06-mobile-diagnosis.png` });
  await page.click('#tr-close');
  await page.waitForSelector('.overlay', { state: 'detached' });

  await page.locator(`[data-play="${iq}"]`).click();
  await page.waitForSelector('.sp-overlay #sp-board cg-board');
  const bw = await page.locator('#sp-board').boundingBox();
  ok('mobile: play-out board fits the screen', bw && bw.width >= 300 && bw.width <= 390, `${bw?.width}px`);
  const ow = await page.evaluate(() => { const o = document.querySelector('.sp-overlay'); return o.scrollWidth - o.clientWidth; });
  ok('mobile: no horizontal overflow in play-out', ow <= 1, `${ow}px`);
  // tap-to-move on the board: tap a piece then a destination square
  const mv = await anyMove(page);
  const sq = async (s) => {
    const b = await page.locator('#sp-board cg-board').boundingBox();
    const white = await page.evaluate(() => window.__sparring.me === 'w');
    const f = s.charCodeAt(0) - 97, r = +s[1] - 1, size = b.width / 8;
    const x = white ? f : 7 - f, y = white ? 7 - r : r;
    return { x: b.x + (x + 0.5) * size, y: b.y + (y + 0.5) * size };
  };
  const a = await sq(mv.slice(0, 2)), c = await sq(mv.slice(2, 4));
  await page.touchscreen.tap(a.x, a.y);
  await page.touchscreen.tap(c.x, c.y);
  await statusHas(page, '#sp-status', /Engine played/);
  ok('mobile: tap-to-move works and engine replies', true, mv);
  await page.screenshot({ path: `${OUT}/07-mobile-playout.png` });
  await page.click('#sp-back');
  ok('mobile: take back', await page.evaluate(() => window.__sparring.hist.length === 0));
  await page.fill('#sp-input', await anyMove(page));
  await page.press('#sp-input', 'Enter');
  await statusHas(page, '#sp-status', /Engine played/);
  await page.click('#sp-resign');
  await page.waitForSelector('#sp-end h3', { timeout: 120000 });
  const end = (await page.locator('#sp-end').innerText()).replace(/\s+/g, ' ');
  ok('mobile: resign gives a result and takeaways', /You resigned/.test(end) && (await page.locator('.sp-take li').count()) >= 1, end.slice(0, 200));
  await page.locator('#sp-end').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/08-mobile-playout-summary.png` });
  await ctx.close();
}

ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
