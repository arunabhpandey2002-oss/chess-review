// Openings section: library, "Openings you face most" from your games, and practising a line (the app plays the
// opponent, you find the book reply; wrong moves get an explanation and a retry; progress is saved per opening).
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const SHOT = process.env.SHOT || '';
const rep = JSON.parse(readFileSync('src/repertoire.json', 'utf8')).openings;
const reti = rep.find((o) => o.id === 'reti');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== '' ? ' — ' + info : ''}`); };
const USER = 'op-e2e-user';
const pk = `chesscom:${USER}`;
const game = (id, pgn, myColor, result) => {
  const me = { username: USER, rating: 1500, result }, them = { username: 'opp', rating: 1500, result: result === 'win' ? 'checkmated' : result === 'draw' ? 'agreed' : 'win' };
  return { key: `${pk}|${id}`, profileKey: pk, myColor, savedAt: 1, game: { id, platform: 'chesscom', url: '', pgn, white: myColor === 'w' ? me : them, black: myColor === 'b' ? me : them, endTime: 1, timeClass: 'rapid', timeControl: '600', opening: '', rated: true } };
};
const games = [
  game('r1', '1. Nf3 d5 2. c4 e6 3. g3 Nf6', 'b', 'resigned'), game('r2', '1. Nf3 d5 2. c4 d4 3. b4', 'b', 'checkmated'), game('r3', '1. Nf3 d5 2. c4 c6 3. b3', 'b', 'agreed'),
  game('s1', '1. e4 c5 2. Nf3 d6 3. d4', 'w', 'win'), game('s2', '1. e4 c5 2. Nf3 Nc6 3. d4', 'w', 'win'),
];
for (const [tag, viewport, mobile] of [['desktop', { width: 1400, height: 950 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(30000);
  await page.route('https://api.chess.com/**', (r) => r.request().url().includes('/games/archives') ? r.fulfill({ json: { archives: [] } }) : r.fulfill({ status: 404, json: {} }));
  await page.goto(BASE + `?user=${USER}&view=data`);
  await page.waitForSelector('h1');
  await page.evaluate(async (games) => {
    const db = await new Promise((r, j) => { const q = indexedDB.open('chess-review'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    await new Promise((r, j) => { const t = db.transaction(['games'], 'readwrite'); games.forEach((g) => t.objectStore('games').put(g)); t.oncomplete = r; t.onerror = () => j(t.error); });
    db.close();
  }, games);

  // library
  await page.goto(BASE + `?user=${USER}&view=openings`);
  await page.waitForSelector('.op-card');
  check(`${tag}: Openings tab is active`, (await page.locator('#tabs a.on').innerText()).trim() === 'Openings');
  check(`${tag}: 17 openings in the library`, (await page.locator('.op-card').count()) === 17, await page.locator('.op-card').count());
  const card = page.locator('#op-reti');
  check(`${tag}: Réti card shows name, ECO, moves and idea`, /Réti Opening/.test(await card.innerText()) && /A09/.test(await card.innerText()) && (await card.locator('.op-moves').innerText()) === '1. Nf3 d5 2. c4' && (await card.locator('.op-idea').innerText()).length > 40);
  await card.locator('summary').click();
  check(`${tag}: Réti line lists reasons`, (await card.locator('.op-line li').count()) >= 4, await card.locator('.op-line li').count());
  check(`${tag}: not practised yet`, /Not practised/.test(await card.locator('.op-status').innerText()));
  await page.waitForSelector('#op-faced table');
  const faced = page.locator('#op-faced');
  const retiRow = faced.locator('tr', { hasText: 'Réti Opening' });
  check(`${tag}: faced most: Réti 3 games, 17% and flagged`, (await retiRow.count()) === 1 && /\b3\b/.test(await retiRow.innerText()) && /17%/.test(await retiRow.innerText()) && (await retiRow.locator('.op-flag').count()) === 1, (await retiRow.innerText().catch(() => '')).replace(/\s+/g, ' '));
  const sicRow = faced.locator('tr', { hasText: 'Sicilian Defense' });
  check(`${tag}: faced most: Sicilian 2 games 100%, not flagged`, /100%/.test(await sicRow.innerText()) && (await sicRow.locator('.op-flag').count()) === 0);
  check(`${tag}: faced most sorted by count`, /Réti/.test(await faced.locator('tbody tr').first().innerText()));
  check(`${tag}: no horizontal overflow on the library`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

  // practise from the faced-most row
  await retiRow.locator('[data-practice]').click();
  await page.waitForSelector('.op-drill #tr-board cg-board');
  check(`${tag}: practice URL`, page.url().includes('view=openings') && page.url().includes('o=reti'));
  check(`${tag}: board flipped for Black`, await page.locator('#tr-board.orientation-black, #tr-board .orientation-black').count() >= 1);
  await page.waitForFunction(() => /Last move: 1\. Nf3/.test(document.querySelector('#tr-last')?.textContent ?? ''));
  check(`${tag}: app played 1. Nf3, named above the board`, /^Last move: 1\. Nf3 \(g1 → f3\)$/.test((await page.locator('#tr-last').innerText()).replace(/\s+/g, ' ').trim()));
  const lm = await page.evaluate(() => [...document.querySelectorAll('#tr-board square.last-move')].map((s) => s.cgKey).sort().join(','));
  check(`${tag}: g1 and f3 highlighted`, lm === 'f3,g1', lm);

  const sq = async (key) => {
    const b = await page.locator('#tr-board cg-board').boundingBox();
    const f = key.charCodeAt(0) - 97, r = +key[1] - 1; // black at the bottom
    const col = 7 - f, row = r;
    return { x: b.x + (col + 0.5) * b.width / 8, y: b.y + (row + 0.5) * b.height / 8 };
  };
  const clickMove = async (from, to) => { for (const k of [from, to]) { const p = await sq(k); mobile ? await page.touchscreen.tap(p.x, p.y) : await page.mouse.click(p.x, p.y); await page.waitForTimeout(120); } };
  // a wrong move: gentle explanation, piece goes back, still your move
  await clickMove('a7', 'a5');
  await page.waitForFunction(() => /try again/i.test(document.querySelector('#tr-status')?.textContent ?? ''));
  check(`${tag}: wrong move explained`, /isn't the move in this line|Try again/.test(await page.locator('#tr-status').innerText()), await page.locator('#tr-status').innerText());
  await page.waitForTimeout(800);
  const a7 = await page.evaluate(() => [...document.querySelectorAll('#tr-board piece')].some((p) => p.cgKey === 'a7'));
  check(`${tag}: board reset after the wrong move`, a7 && /Last move: 1\. Nf3/.test(await page.locator('#tr-last').innerText()));
  // a sound alternative: told it's fine but not this line
  await page.fill('#tr-input', 'Nf6'); await page.press('#tr-input', 'Enter');
  check(`${tag}: sound alternative gets "also played"`, /also played/.test(await page.locator('#tr-status').innerText()), await page.locator('#tr-status').innerText());
  await page.waitForTimeout(700);
  // hints
  await page.click('#tr-hint');
  check(`${tag}: hint 1 gives the idea`, /Idea:/.test(await page.locator('#tr-hints').innerText()));
  await page.click('#tr-hint');
  check(`${tag}: hint 2 names the piece`, /pawn on d7/.test(await page.locator('#tr-hints').innerText()), await page.locator('#tr-hints').innerText());
  // the book move on the board
  await clickMove('d7', 'd5');
  await page.waitForFunction(() => /✓/.test(document.querySelector('#tr-status')?.textContent ?? ''));
  check(`${tag}: book move accepted with its reason`, /d5 — Claim the centre/.test(await page.locator('#tr-status').innerText()), await page.locator('#tr-status').innerText());
  // the rest of the line typed; each time wait for the app's reply
  for (let i = 2; i < reti.plies.length; i++) {
    const p = reti.plies[i];
    if (!p.mine) continue;
    const prev = reti.plies[i - 1].san.replace(/[+#]/g, '');
    await page.waitForFunction((s) => (document.querySelector('#tr-last')?.textContent ?? '').includes(s) && /to move/.test(document.querySelector('#op-task')?.textContent ?? ''), prev);
    if (i === 5) { await page.click('#tr-reveal'); }
    await page.fill('#tr-input', p.san); await page.press('#tr-input', 'Enter');
  }
  await page.waitForSelector('#op-mastery');
  check(`${tag}: line complete`, /Line complete/.test(await page.locator('#op-task').innerText()));
  check(`${tag}: progress shown`, /Progress: (Learning|Due)/.test(await page.locator('#op-mastery').innerText()), await page.locator('#op-mastery').innerText());
  check(`${tag}: hint and answer buttons gone at the end`, !(await page.locator('#tr-hint').isVisible()) && !(await page.locator('#tr-input').isVisible()));
  if (tag === 'desktop' && SHOT) { await page.waitForTimeout(600); await page.screenshot({ path: SHOT }); }
  const saved = await page.evaluate(async (key) => {
    const db = await new Promise((r) => { const q = indexedDB.open('chess-review'); q.onsuccess = () => r(q.result); });
    return await new Promise((r) => { const q = db.transaction('meta').objectStore('meta').get(key); q.onsuccess = () => r(q.result); });
  }, `${pk}|opening|reti`);
  check(`${tag}: progress saved per opening (revealed, so it comes back soon)`, saved?.srs?.history?.length === 1 && saved.srs.history[0].revealed === true && saved.srs.due - Date.now() < 86400000 + 60000);
  check(`${tag}: no horizontal overflow in practice`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  // back to the library: status updated
  await page.click('#op-back');
  await page.waitForSelector('#op-reti');
  check(`${tag}: library shows the new status`, !/Not practised/.test(await page.locator('#op-reti .op-status').innerText()), await page.locator('#op-reti .op-status').innerText());
  // a White line: Sicilian starts with your move, no last move yet
  await page.goto(BASE + `?user=${USER}&view=openings&o=sicilian`);
  await page.waitForSelector('.op-drill #tr-board cg-board');
  check(`${tag}: White line starts with you, white at the bottom`, /none \(start of game\)/.test(await page.locator('#tr-last').innerText()) && await page.locator('#tr-board.orientation-white, #tr-board .orientation-white').count() >= 1);
  await page.fill('#tr-input', 'e4'); await page.press('#tr-input', 'Enter');
  await page.waitForFunction(() => /Last move: 1\.\.\. c5/.test(document.querySelector('#tr-last')?.textContent ?? ''));
  check(`${tag}: app replies 1... c5`, true);
  check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
