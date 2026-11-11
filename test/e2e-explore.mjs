// E2E for "Why is this best? Explore" and decided-position wording, desktop + 390x844 phone.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = process.env.OUT || 'shots-explore';
mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const UA = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
const GAME = '?user=demo-player&game=186132691608';
const errors = [];

async function run(tag, ctxOpts) {
  const ctx = await browser.newContext({ userAgent: UA, ...ctxOpts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  await page.goto(BASE + GAME);
  await page.waitForSelector('cg-board piece', { timeout: 60000 });
  await page.waitForSelector('.progress.complete', { timeout: 900000 });
  await page.evaluate(() => localStorage.setItem('cr-notation', '0'));
  if (process.env.DUMP && tag === 'desktop') writeFileSync(process.env.DUMP, JSON.stringify(await page.evaluate(() => window.__review.evals)));
  // 21.dxe6 decided wording (ply 41)
  await page.evaluate(() => window.__review.go(41));
  await page.waitForSelector('#mc-decided');
  const head = await page.locator('.mc-title').innerText();
  const note = await page.locator('#mc-decided').innerText();
  const who = await page.locator('#mc-who').innerText();
  ok(`${tag}: 21.dxe6 headline says lost position`, /21\.dxe6 is an? \w+ move in a lost position/.test(head), head);
  ok(`${tag}: decided note`, /^Grades compare your move with the best move here, not who's winning\. You were already lost; this kept things about as good as possible \(\d+% → \d+%\)\.$/.test(note), note);
  ok(`${tag}: side label`, /^Your move \(White\)/.test(who), who);
  if (tag === 'desktop') await page.locator('#movecard').screenshot({ path: `${OUT}/${tag}-decided-card.png` });
  // 16.c3 (ply 31)
  await page.evaluate(() => window.__review.go(31));
  await page.waitForSelector('#mc-explore');
  const btn = await page.locator('#mc-explore').innerText();
  ok(`${tag}: explore button`, /Why is \w+ best\? Explore/.test(btn), btn);
  await page.click('#mc-explore');
  await page.waitForSelector('.ex-overlay #ex-board cg-board');
  const x = await page.evaluate(() => { const e = window.__explorer.x; return { best: e.best.san, played: e.played.san, gap: e.gap, verdict: e.verdict.text }; });
  ok(`${tag}: explorer compares best and played`, x.played === 'c3' && !!x.best, JSON.stringify({ best: x.best, gap: Math.round(x.gap) }));
  const verdict = await page.locator('#ex-verdict').innerText();
  ok(`${tag}: honest size of the gap`, /difference is (tiny|modest)/.test(verdict) && /losing either way/.test(verdict), verdict);
  const cmp = await page.locator('#ex-compare').innerText();
  console.log('   compare:', cmp.replace(/\n/g, ' | '));
  if (['Rf1', 'f4'].includes(x.best)) ok(`${tag}: compare names the f2 pawn and the g2 queen`, /pawn on f2/.test(cmp) && /queen on g2/.test(cmp), '');
  else ok(`${tag}: compare says plainly when no single fact separates them`, /No immediate threat|pawn on f2/.test(cmp), x.best);
  if (tag === 'desktop') await page.screenshot({ path: `${OUT}/${tag}-explore.png` }); else { await page.locator('#ex-verdict').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${OUT}/${tag}-explore.png` }); }
  // step through the played line
  await page.click('[data-line="played"]');
  const s1 = await page.locator('#ex-steptext').innerText();
  ok(`${tag}: step 1 explains c3`, /c-pawn to c3/.test(s1), s1);
  await page.click('#ex-next');
  const s2 = await page.locator('#ex-steptext').innerText();
  const pos = await page.locator('#ex-pos').innerText();
  ok(`${tag}: step 2 explains the reply`, /^\S+ — Black/.test(s2) && /2\/\d/.test(pos), `${pos}: ${s2}`);
  const shapes = await page.evaluate(() => window.__explorer.cg.state.drawable.autoShapes.length);
  ok(`${tag}: arrows drawn`, shapes >= 1, String(shapes));
  if (tag === 'desktop') await page.locator('.tr-board-col').screenshot({ path: `${OUT}/${tag}-step.png` });
  await page.click('#ex-prev');
  ok(`${tag}: step back`, /1\/\d/.test(await page.locator('#ex-pos').innerText()));
  // questions
  for (const q of ['threat', 'mine', 'reply', 'other']) {
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true))); await page.click(`[data-q="${q}"]`);
    const a = await page.locator('#ex-answer').innerText();
    ok(`${tag}: question ${q}`, a.length > 30 && !/undefined|NaN/.test(a), a.replace(/\n/g, ' | ').slice(0, 160));
  }
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true))); await page.click('[data-q="threat"]');
  const th = await page.locator('#ex-answer').innerText();
  ok(`${tag}: threat answer names f2 and the g2 queen`, /your pawn on f2 was attacked by their queen on g2 and had no defender/.test(th), '');
  // try an arbitrary move from the board
  await page.click('#ex-reset');
  await page.fill('#ex-input', 'a3');
  await page.press('#ex-input', 'Enter');
  await page.waitForFunction(() => /Engine:/.test(document.querySelector('#ex-answer')?.textContent || ''), null, { timeout: 60000 });
  const t = await page.locator('#ex-answer').innerText();
  ok(`${tag}: what-if a3 gets engine eval and reply`, /Engine: [−+\d]/.test(t) && /Their best reply/.test(t), t.replace(/\n/g, ' | ').slice(0, 200));
  const under = await page.locator('#ex-steptext').innerText();
  ok(`${tag}: what-if summary under the board`, /win chance \(best \d+%\)/.test(under), under);
  if (tag !== 'desktop') { await page.locator('#ex-board').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${OUT}/${tag}-whatif.png` }); }
  await page.click('#ex-back2');
  const back = await page.evaluate(() => window.__explorer.tryFen === null && window.__explorer.cg.state.movable.color !== undefined);
  ok(`${tag}: back to position`, back);
  await page.keyboard.press('Escape');
  ok(`${tag}: Escape closes`, (await page.locator('.ex-overlay').count()) === 0);
  await ctx.close();
}

await run('desktop', { viewport: { width: 1360, height: 900 } });
await run('phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
ok('no page errors', errors.length === 0, errors.join('; '));
await browser.close();
const fail = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - fail}/${results.length} passed`);
process.exit(fail ? 1 : 0);
