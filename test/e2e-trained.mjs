// Training a position must update the "to train" list and the due counter together:
// A) Mistakes to Master: the trained position leaves "Due now" and the badge, button and group count agree.
// B) Game review (FULL=1, runs a full analysis): the critical-moment card and its "to train now" count update with the badge.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const base = JSON.parse(readFileSync('test/fixtures/puzzles3.json', 'utf8'));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== '' ? ' — ' + info : ''}`); };
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(30000);
const badge = async () => Number((await page.locator('#tabs .badge-n').textContent().catch(() => '0')) || 0);
const counts = async () => {
  const btn = (await page.locator('#train').innerText()).match(/Train (\d+) due/);
  const head = (await page.locator('#pz-due-head').textContent().catch(() => '')).match(/\((\d+)\)/);
  return { badge: await badge(), button: btn ? +btn[1] : 0, group: head ? +head[1] : 0 };
};

await page.goto(BASE + '?user=Arunabh-pandey&view=data');
await page.waitForSelector('h1');
await page.evaluate(async (base) => {
  const db = await new Promise((r, j) => { const q = indexedDB.open('chess-review'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  await new Promise((r, j) => { const t = db.transaction('puzzles', 'readwrite'); const now = Date.now(); for (let i = 0; i < 6; i++) { const p = base[i % 3]; t.objectStore('puzzles').put({ ...p, id: `${p.id}-t${i}`, gameId: `${p.gameId}t${i}`, srs: { ...p.srs, retired: false, due: now - 1000 * (i + 1), history: [] } }); } t.oncomplete = r; t.onerror = () => j(t.error); });
  db.close();
}, base);
await page.goto(BASE + '?user=Arunabh-pandey&view=puzzles');
await page.waitForSelector('.pz-row');
const before = await counts();
check('before: badge, button and Due-now group agree', before.badge === before.button && before.button === before.group && before.group >= 6, JSON.stringify(before));
const dueIds = async () => page.evaluate(() => { const out = []; let el = document.querySelector('#pz-due-head')?.nextElementSibling; while (el && el.classList.contains('pz-row')) { out.push(el.dataset.id); el = el.nextElementSibling; } return out; });
const firstIds = await dueIds();
const target = firstIds[0];
// train the first due position: solve it with the best move
await page.locator(`.pz-row[data-id="${target}"] [data-train]`).click();
await page.waitForSelector('.trainer #tr-input');
const best = await page.evaluate(() => window.__trainerCore?.bestSan ?? null);
const core = best ?? (await page.evaluate((id) => new Promise((r) => { const q = indexedDB.open('chess-review'); q.onsuccess = () => { const g = q.result.transaction('puzzles').objectStore('puzzles').get(id); g.onsuccess = () => r(g.result.core.bestSan); }; }), target));
await page.fill('#tr-input', core);
await page.press('#tr-input', 'Enter');
await page.waitForSelector('.tr-status.good', { timeout: 20000 });
await page.waitForTimeout(500);
check('badge drops right after the solve', (await badge()) === before.badge - 1, `${await badge()}`);
await page.click('#tr-close');
await page.waitForSelector('.pz-row');
const after = await counts();
const afterIds = await dueIds();
check('after: counter dropped by one', after.badge === before.badge - 1, JSON.stringify(after));
check('after: badge, button and Due-now group still agree', after.badge === after.button && after.button === after.group, JSON.stringify(after));
check('trained position left the Due-now list', !afterIds.includes(target) && afterIds.length === firstIds.length - 1, `${afterIds.length} due rows`);
const st = await page.locator(`.pz-row[data-id="${target}"] .st`).innerText();
check('trained position shows its next review date', /Next in/.test(st), st);

if (process.env.FULL) {
  await page.goto(BASE + '?user=Arunabh-pandey&game=186092857180');
  await page.waitForSelector('.progress.complete', { timeout: 420000 });
  await page.waitForSelector('.moment');
  const b0 = await badge();
  const sub0 = await page.locator('#moments-due').innerText();
  const st0 = await page.locator('.moment').first().locator('.st').innerText();
  await page.locator('[data-retry="0"]').click();
  await page.waitForSelector('.overlay .trainer');
  const best2 = await page.evaluate(() => window.__trainer.o.core.bestSan);
  const lm = (await page.locator('.overlay #tr-last').innerText()).trim();
  const lmHl = await page.locator('.overlay #tr-board square.last-move').count();
  check('review: last move line and highlight in the critical-moment trainer', /^Last move: \d+\.(\.\.)? \S+ \([a-h][1-8] → [a-h][1-8]\)$/.test(lm) && lmHl === 2, `${lm} · ${lmHl} squares`);
  await page.fill('#tr-input', best2);
  await page.press('#tr-input', 'Enter');
  await page.waitForSelector('.tr-status.good', { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.click('#tr-close');
  await page.waitForSelector('.overlay', { state: 'detached' });
  const b1 = await badge();
  const sub1 = await page.locator('#moments-due').innerText();
  const st1 = await page.locator('.moment').first().locator('.st').innerText();
  check('review: badge dropped', b1 === b0 - 1, `${b0} -> ${b1}`);
  check('review: moment card updated', /Solved/.test(st1) && /next in/.test(st1) && st1 !== st0, `${st0} -> ${st1}`);
  check('review: "to train now" count dropped', sub1 !== sub0, `${sub0} -> ${sub1}`);
}
check('no page errors', errors.length === 0, errors.join(' | '));
console.log(`${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
