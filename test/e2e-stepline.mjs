// "Why is Nxg5 best?" (game 186374332730, before 14.a3): the card's step button advances one move per press,
// and the "If they take" line (14...hxg5) appears and steps. Desktop + 390x844 phone.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = process.env.OUT || 'shots-stepline';
mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (name, cond, info = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const UA = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
for (const [tag, opts] of [['desktop', { viewport: { width: 1400, height: 950 } }], ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
  const ctx = await browser.newContext({ userAgent: UA, ...opts });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('cr-notation', '1'));
  await page.goto(BASE + '?user=demo-player&game=186374332730');
  await page.waitForSelector('cg-board piece', { timeout: 60000 });
  await page.waitForSelector('.progress.complete', { timeout: 300000 });
  await page.evaluate(() => window.__review.go(27));
  await page.waitForSelector('#mc-explore');
  ok(`${tag}: explore button`, /Why is Nxg5 best\?/.test(await page.locator('#mc-explore').innerText()), await page.locator('#mc-explore').innerText());
  await page.click('#mc-explore');
  await page.waitForSelector('.ex-overlay #ex-board cg-board');
  const best = page.locator('[data-line="best"]');
  // repeated presses on the card button advance the board one move each
  const seen = [];
  for (let k = 1; k <= 3; k++) {
    await best.click();
    seen.push({ pos: await page.locator('#ex-pos').innerText(), text: await page.locator('#ex-steptext').innerText(), label: await best.innerText(), last: await page.evaluate(() => window.__explorer.cg.state.lastMove?.join('')) });
  }
  ok(`${tag}: press 1 plays Nxg5`, /^Best line · 1\/\d/.test(seen[0].pos) && /^Nxg5 — /.test(seen[0].text) && seen[0].last === 'f3g5', JSON.stringify(seen[0]));
  ok(`${tag}: press 2 plays their reply`, /^Best line · 2\//.test(seen[1].pos) && seen[1].last !== seen[0].last, `${seen[1].pos}: ${seen[1].text}`);
  ok(`${tag}: press 3 plays the next move`, /^Best line · 3\//.test(seen[2].pos) && seen[2].last !== seen[1].last, `${seen[2].pos}: ${seen[2].text}`);
  ok(`${tag}: button turns into Next move`, /^Next move \(4\/\d\)$/.test(seen[2].label), seen[2].label);
  ok(`${tag}: arrow and highlight drawn`, (await page.evaluate(() => window.__explorer.cg.state.drawable.autoShapes.length)) >= 1 && (await page.locator('#ex-board square.last-move').count()) === 2);
  await page.click('[data-back="best"]');
  ok(`${tag}: Back steps one move back`, /^Best line · 2\//.test(await page.locator('#ex-pos').innerText()), await page.locator('#ex-pos').innerText());
  // the capture line
  await page.waitForSelector('#ex-capture [data-line="capture"]', { timeout: 120000 });
  const capText = await page.locator('#ex-capture').innerText();
  const n = await page.evaluate(() => window.__explorerCapture);
  ok(`${tag}: "If they take" note for 14…hxg5`, /If they take with 14…hxg5/.test(capText) && /Engine after 15\./.test(capText), capText.replace(/\n/g, ' | '));
  if (/pins their knight on f6/.test(capText)) ok(`${tag}: pin stated only with the board line Bxg5`, /15\.Bxg5 pins their knight on f6 to the king/.test(capText));
  const cap = page.locator('[data-line="capture"]');
  const cs = [];
  for (let k = 1; k <= 3; k++) { await cap.click(); cs.push({ pos: await page.locator('#ex-pos').innerText(), text: await page.locator('#ex-steptext').innerText() }); }
  ok(`${tag}: capture line steps Nxg5, hxg5, then the answer`, /^If they take · 1\//.test(cs[0].pos) && /^Nxg5/.test(cs[0].text) && /^hxg5/.test(cs[1].text) && /^If they take · 3\//.test(cs[2].pos), cs.map((c) => c.text.split(' — ')[0]).join(', ') + ` · line ${n?.line?.length}`);
  ok(`${tag}: best-line button resets when another line is active`, (await best.innerText()) === 'Step through this line');
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  ok(`${tag}: no horizontal overflow`, sw <= opts.viewport.width, String(sw));
  if (tag === 'desktop') await page.screenshot({ path: `${OUT}/desktop-capture-step.png` });
  else { await page.locator('#ex-capture').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${OUT}/phone-capture.png` }); }
  ok(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}
console.log(`\n${pass}/${pass + fail} checks passed`);
await browser.close();
process.exit(fail ? 1 : 0);
