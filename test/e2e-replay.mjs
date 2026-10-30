// E2E for Play it out → Review this game → Compare with original, with a take-back, on desktop and a phone.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = process.env.OUT || 'shots-replay';
mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const UA = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
const GAME = '?user=Arunabh-pandey&game=186092857180';
const errors = [];

async function run(tag, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, userAgent: UA, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
  await page.goto(BASE + GAME);
  await page.waitForSelector('.progress.complete', { timeout: 900000 });
  await page.waitForFunction(() => window.__coach && window.__coach.played);
  const ix = await page.evaluate(() => window.__coach.played.indexOf('exd5'));
  await page.locator(`[data-play="${ix}"]`).click();
  await page.waitForSelector('.sp-overlay #sp-board cg-board');
  const play = async (uci) => {
    const n = await page.evaluate(() => window.__sparring.hist.length);
    await page.fill('#sp-input', uci); await page.press('#sp-input', 'Enter');
    await page.waitForFunction((n) => (window.__sparring.hist.length >= n + 2 && !window.__sparring.thinking) || window.__sparring.over, n, { timeout: 60000 });
  };
  // first attempt repeats the game move, then is taken back (kept as a branch)
  await play("e4d5");
  await page.click('#sp-back');
  // second attempt: the engine's best move, then the engine's own suggestions for a few moves
  await play(await page.evaluate(() => window.__sparring.o.core.bestUci));
  for (let i = 0; i < 3; i++) {
    const u = await page.evaluate(async () => (await window.__sparring.info(window.__sparring.fen)).bestUci);
    if (!u || (await page.evaluate(() => window.__sparring.over))) break;
    await play(u);
  }
  const tree = await page.evaluate(() => ({ kinds: Object.values(window.__sparring.tree.json().nodes).map((n) => n.kind), main: window.__sparring.tree.path(window.__sparring.node).length, hist: window.__sparring.hist.length }));
  ok(`${tag}: take-back kept as a branch`, tree.kinds.filter((k) => k === 'taken-back').length === 2 && tree.main === tree.hist, JSON.stringify({ tb: tree.kinds.filter((k) => k === 'taken-back').length, main: tree.main, hist: tree.hist }));
  await page.click('#sp-stop');
  await page.waitForSelector('#sp-review', { timeout: 120000 });
  ok(`${tag}: end screen offers review and compare`, (await page.locator('#sp-compare').count()) === 1);
  const t0 = Date.now();
  await page.click('#sp-review');
  await page.waitForFunction(() => window.__replayReview, null, { timeout: 120000 });
  const rr = await page.evaluate(() => ({ plies: window.__replayReview.plies.length, mine: window.__replayReview.mine, moments: window.__replayReview.moments.length, text: document.querySelector('#sp-end').innerText }));
  ok(`${tag}: review of the replay`, rr.plies >= 8 && rr.mine >= 4 && /Review of your replay/.test(rr.text), `${rr.plies} plies, ${rr.mine} mine, ${rr.moments} moments, ${Date.now() - t0} ms`);
  const saved = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('chess-review'); r.onsuccess = () => { const q = r.result.transaction('replays').objectStore('replays').getAll(); q.onsuccess = () => res(q.result.map((x) => ({ src: x.sourceId, line: x.line.length, orig: x.original.length, ev: x.evals?.length ?? 0, nodes: Object.keys(x.tree.nodes).length }))); }; }));
  ok(`${tag}: replay saved locally, linked to the moment`, saved.length >= 1 && /\|186092857180\|28$/.test(saved[0].src) && saved[0].ev === saved[0].line + 1 && saved[0].nodes > saved[0].line + 1, JSON.stringify(saved[0]));
  await page.locator('#sp-end').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${tag}-1-review.png` });
  await page.click('#sp-compare');
  await page.waitForSelector('.cmp-graph', { timeout: 120000 });
  const cmp = await page.evaluate(() => ({ div: window.__compare.divergences.map((d) => d.text), slips: window.__compare.slips.map((s) => `${s.line}:${s.label}:${Math.round(s.loss)}:${s.concept}`), rows: window.__compare.rows.length, curves: [window.__compare.curves.original.length, window.__compare.curves.replay.length] }));
  ok(`${tag}: divergence found and explained`, cmp.div.length >= 1 && /^You diverged at 15\.exd5 → 15\./.test(cmp.div[0]) && /lost the queen/.test(cmp.div[0]), cmp.div[0]);
  ok(`${tag}: slips from game, replay and taken-back line`, cmp.slips.some((s) => s.startsWith('original:15.exd5')) && cmp.slips.some((s) => s.startsWith('taken-back:15.exd5')), cmp.slips.join(' | '));
  ok(`${tag}: two curves drawn`, (await page.locator('.cg-line').count()) === 2 && cmp.curves[0] > 2 && cmp.curves[1] > 2, JSON.stringify(cmp.curves));
  const at0 = await page.locator('#cmp-at').innerText();
  await page.click('#cmp-next');
  const at1 = await page.locator('#cmp-at').innerText();
  const fens = await page.evaluate(() => [...document.querySelectorAll('.cmp-board')].map((b) => b.querySelectorAll('piece').length));
  ok(`${tag}: synced step-through moves both boards`, at0 !== at1 && fens.every((n) => n > 10), `${at0} → ${at1}; pieces ${fens}`);
  const ow = await page.evaluate(() => { const o = document.querySelector('.sp-overlay'); return o.scrollWidth - o.clientWidth; });
  ok(`${tag}: no horizontal overflow`, ow <= 1, `${ow}px`);
  await page.locator('.cmp-sum').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${tag}-2-compare.png` });
  await page.locator('.cmp-table, .cmp-step').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${tag}-3-compare-steps.png` });
  await ctx.close();
}
await run('desktop', { width: 1400, height: 950 }, false);
await run('phone', { width: 390, height: 844 }, true);
ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
