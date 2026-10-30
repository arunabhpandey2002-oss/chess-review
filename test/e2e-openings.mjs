// E2E for the opening explorer on the analysis board: moves, game counts and results from the bundled sample,
// opening name, click-to-play, a plain "no data" message, graceful failure if the file is missing,
// no outside requests, no layout overflow. Desktop and phone.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = process.env.OUT || 'shots-openings';
mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const UA = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
const host = new URL(BASE).host;
const errors = [];
const rows = (page) => page.$$eval('#ws-book tbody tr', (trs) => trs.map((tr) => ({ san: tr.querySelector('.ob-mv').textContent, games: +tr.querySelector('.num').firstChild.textContent.replace(/[^\d]/g, ''), share: tr.querySelector('.num .muted').textContent, bar: tr.querySelector('.ob-bar').getAttribute('aria-label') })));

async function run(tag, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, userAgent: UA, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const page = await ctx.newPage();
  const outside = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (/^https?:/.test(u.protocol) && u.host !== host && !/api\.chess\.com|lichess\.org/.test(u.host)) outside.push(u.host); if (/explorer|opening/i.test(u.host)) outside.push(u.host); });
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${tag}: ${m.text()}`); });
  await page.goto(BASE + '?user=Arunabh-pandey&view=analysis');
  await page.waitForSelector('#ws-book .ob-mv', { timeout: 30000 });
  const r0 = await rows(page);
  const total0 = +(await page.locator('#ws-book').innerText()).match(/([\d,]+) games reached this position/)[1].replace(/,/g, '');
  ok(`${tag}: start position lists common moves`, r0.length >= 4 && ['e4', 'd4'].includes(r0[0].san), r0.slice(0, 4).map((r) => `${r.san} ${r.games} (${r.share})`).join(', '));
  ok(`${tag}: most played first, counts add up`, r0.every((r, i) => i === 0 || r.games <= r0[i - 1].games) && r0.reduce((s, r) => s + r.games, 0) <= total0, `${total0} games`);
  ok(`${tag}: each move has White/draw/Black results summing to 100%`, r0.every((r) => { const n = (r.bar.match(/\d+/g) || []).map(Number); return n.length === 3 && n[0] + n[1] + n[2] === 100; }), r0[0].bar);
  ok(`${tag}: no opening name at the start, said plainly`, /No named opening/.test(await page.locator('#ob-name').innerText()));
  const src = await page.locator('.ob-src').innerText();
  ok(`${tag}: sample described, no site named`, /rated online games/.test(src) && !/lichess|chess\.com/i.test(await page.locator('#ws-book').innerText()), src);
  await page.screenshot({ path: `${OUT}/${tag}-1-start.png`, fullPage: mobile });
  // click to play
  await page.locator('#ws-book .ob-mv', { hasText: /^e4$/ }).click();
  await page.waitForFunction(() => window.__ws?.fen.startsWith('rnbqkbnr/pppppppp/8/8/4P3/'), null, { timeout: 5000 });
  await page.waitForFunction(() => /…/.test(document.querySelector('#ws-book .ob-mv')?.textContent ?? ''), null, { timeout: 5000 });
  ok(`${tag}: clicking a move plays it on the board`, (await page.evaluate(() => window.__ws.tree.mainline().map((n) => n.san))).join(' ') === 'e4');
  const nm = await page.locator('#ob-name').innerText();
  ok(`${tag}: opening name shown`, /^B00 /.test(nm) || /^[A-E]\d\d /.test(nm), nm);
  const r1 = await rows(page);
  await page.locator('#ws-book .ob-mv').first().click();
  await page.waitForFunction(() => window.__ws.tree.mainline().length === 2, null, { timeout: 5000 });
  ok(`${tag}: replies listed for Black`, r1.length >= 3 && r1[0].san.startsWith('…'), r1.slice(0, 3).map((r) => r.san).join(', '));
  await page.screenshot({ path: `${OUT}/${tag}-2-after.png`, fullPage: mobile });
  // a position the sample never reached
  await page.locator('.ws-io summary').click();
  await page.fill('#ws-load', '8/5k2/8/3K4/8/8/5P2/8 w - - 0 1');
  await page.click('#ws-loadbtn');
  await page.waitForSelector('#ob-none', { timeout: 5000 });
  ok(`${tag}: plain message when there is no data`, /No games in the sample reach this position/.test(await page.locator('#ob-none').innerText()) && (await page.locator('#ws-book .ob-mv').count()) === 0);
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  ok(`${tag}: no horizontal overflow`, ov <= 0, `${ov}px`);
  ok(`${tag}: no outside requests for opening data`, outside.length === 0, [...new Set(outside)].join(','));
  // file missing: degrade gracefully, board still works
  const p2 = await ctx.newPage();
  await p2.route('**/openings.json', (r) => r.abort());
  await p2.goto(BASE + '?user=Arunabh-pandey&view=analysis');
  await p2.waitForSelector('#ob-none', { timeout: 15000 });
  ok(`${tag}: missing data handled calmly`, /could not be loaded/.test(await p2.locator('#ob-none').innerText()) && (await p2.locator('#ws-board cg-board').count()) === 1);
  await ctx.close();
}
await run('phone', { width: 390, height: 844 }, true);
await run('desktop', { width: 1400, height: 950 }, false);
ok('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
