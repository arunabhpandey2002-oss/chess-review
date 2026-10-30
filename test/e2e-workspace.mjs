// E2E for the analysis workspace: open a lesson in analysis, engine lines and depth, Ask, Save as puzzle, a new
// variation compared with the main line, undo/redo, refresh persistence, FEN load, and the Import entry point.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = process.env.OUT || 'shots-ws';
mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const UA = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
const GAME = '?user=Arunabh-pandey&game=186092857180';
const errors = [];
const lines = (page) => page.waitForFunction(() => document.querySelectorAll('#ws-lines .ws-pl').length > 0, null, { timeout: 60000 });

async function run(tag, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, userAgent: UA, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
  await page.goto(BASE + GAME);
  await page.waitForSelector('.progress.complete', { timeout: 900000 });
  await page.waitForFunction(() => window.__coach && window.__coach.played);
  const ix = await page.evaluate(() => window.__coach.played.indexOf('exd5'));
  await page.locator(`[data-retry="${ix}"]`).click();
  await page.waitForSelector('.overlay .trainer');
  await page.click('#tr-reveal');
  await page.click('[data-why="thought-safe"]');
  await page.waitForSelector('#tr-analyse');
  await page.click('#tr-analyse');
  await page.waitForSelector('.ws #ws-board cg-board');
  ok(`${tag}: lesson opens in analysis`, /view=analysis&ws=ws/.test(page.url()) && (await page.locator('.overlay').count()) === 0, page.url().replace(BASE, ''));
  await lines(page);
  const tree = await page.evaluate(() => ({ moves: [...document.querySelectorAll('.ws-mv')].map((b) => b.textContent), vars: document.querySelectorAll('.ws-var').length, kinds: Object.values(window.__ws.tree.json().nodes).map((n) => n.kind) }));
  ok(`${tag}: game move as main line, best line as a branch`, tree.moves[0] === '15.exd5' && tree.vars === 1 && tree.kinds.includes('game') && tree.kinds.includes('engine'), tree.moves.slice(0, 6).join(' '));
  await page.selectOption('#ws-mpv', '5');
  await page.selectOption('#ws-depth', '12');
  await page.waitForFunction(() => document.querySelectorAll('#ws-lines .ws-pl').length === 5, null, { timeout: 60000 });
  const lt = await page.locator('#ws-lines').innerText();
  ok(`${tag}: engine shows 5 lines at depth 12`, /Depth 1[2-9]/.test(lt), lt.split('\n').slice(0, 2).join(' / '));
  // Ask about the game move
  await page.locator('.ws-mv', { hasText: '15.exd5' }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('#ws-ask li').length >= 2, null, { timeout: 60000 });
  const ask = (await page.locator('#ws-ask').innerText()).replace(/\s+/g, ' ');
  ok(`${tag}: Ask explains the move with engine and board facts`, /best move here was/.test(ask) && /win chance/.test(ask), ask.slice(0, 220));
  await page.screenshot({ path: `${OUT}/${tag}-1-lesson.png` });
  // Save as puzzle
  await page.click('#ws-save');
  await page.waitForFunction(() => /Saved as a puzzle|Could not|nothing to find|nearly as good/.test(document.querySelector('#ws-msg').textContent), null, { timeout: 60000 });
  const msg = await page.locator('#ws-msg').innerText();
  const pz = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('chess-review'); r.onsuccess = () => { const q = r.result.transaction('puzzles').objectStore('puzzles').getAll(); q.onsuccess = () => res(q.result.filter((p) => p.source === 'workspace').map((p) => ({ played: p.core.playedSan, best: p.core.bestSan, loss: Math.round(p.core.loss) }))); }; }));
  ok(`${tag}: Save as puzzle`, /^Saved as a puzzle/.test(msg) && pz.length === 1 && pz[0].played === 'exd5', `${msg} ${JSON.stringify(pz)}`);
  // a new variation of my own, from the start
  await page.click('#ws-first');
  await lines(page);
  const alt = await page.evaluate(() => window.__ws.last.lines.map((l) => l.pv[0]).find((u) => u !== window.__ws.tree.mainline()[0].uci && !window.__ws.tree.root.children.map((c) => window.__ws.tree.node(c).uci).includes(u)));
  await page.fill('#ws-input', alt); await page.press('#ws-input', 'Enter');
  await lines(page);
  const best = await page.evaluate(() => window.__ws.last.lines[0].pv[0]);
  await page.fill('#ws-input', best); await page.press('#ws-input', 'Enter');
  const n1 = await page.evaluate(() => window.__ws.tree.count());
  ok(`${tag}: own moves become a new variation`, (await page.locator('.ws-var').count()) === 2 && (await page.locator('.ws-mv.cur').innerText()).length > 0, `${n1} moves in the tree`);
  await page.click('#ws-cmp');
  await page.waitForSelector('#ws-cmpout .cmp-graph', { timeout: 120000 });
  const cmp = await page.evaluate(() => window.__wsCompare.divergences.map((d) => d.text)[0] ?? window.__wsCompare.summary);
  ok(`${tag}: compare with the main line`, /^You diverged at 15\.exd5 → 15\./.test(cmp), cmp);
  await page.locator('#ws-cmpout').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${tag}-2-compare.png` });
  // undo / redo
  await page.click('#ws-undo');
  const n2 = await page.evaluate(() => window.__ws.tree.count());
  await page.click('#ws-redo');
  const n3 = await page.evaluate(() => window.__ws.tree.count());
  ok(`${tag}: undo and redo`, n2 === n1 - 1 && n3 === n1, `${n1} → ${n2} → ${n3}`);
  // refresh keeps everything
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForSelector('.ws #ws-board cg-board');
  const n4 = await page.evaluate(() => window.__ws.tree.count());
  const pgn = await page.evaluate(() => window.__ws.tree.pgn());
  ok(`${tag}: saved on this device across a refresh`, n4 === n1 && /\(15\. /.test(pgn), `${n4} moves; PGN ${pgn.slice(pgn.indexOf('15.'), pgn.indexOf('15.') + 60)}`);
  // load a FEN
  await page.locator('.ws-io summary').click();
  await page.fill('#ws-load', '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1');
  await page.click('#ws-loadbtn');
  await lines(page);
  ok(`${tag}: load a FEN`, (await page.evaluate(() => window.__ws.fen)) === '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1');
  // Import page entry point
  await page.goto(BASE + '?user=Arunabh-pandey&view=import');
  await page.fill('#ws-text', '[White "A"]\n[Black "B"]\n\n1. e4 e5 2. Nf3 Nc6 *');
  await page.click('#f-ws button');
  await page.waitForSelector('.ws #ws-board cg-board');
  ok(`${tag}: open a PGN from Import`, (await page.locator('.ws-mv').count()) === 4 && /A vs B/.test(await page.locator('#ws-title').innerText()));
  await lines(page);
  await page.click('#ws-last');
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  ok(`${tag}: no horizontal overflow`, ov <= 0, `${ov}px`);
  await page.screenshot({ path: `${OUT}/${tag}-3-import.png`, fullPage: mobile });
  await ctx.close();
}
await run('desktop', { width: 1400, height: 950 }, false);
await run('phone', { width: 390, height: 844 }, true);
ok('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
