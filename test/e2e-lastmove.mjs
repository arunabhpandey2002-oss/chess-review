// Training view shows the opponent's last move ("Last move: 15. Rb5") and highlights its squares, Black and White at the bottom;
// old positions without the move get it from the stored game PGN; the start position says so.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
const BASE = process.env.BASE || 'http://localhost:4173/';
const base = JSON.parse(readFileSync('test/fixtures/puzzles3.json', 'utf8'));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== '' ? ' — ' + info : ''}`); };

// a White-to-play position: after 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 (last move 3... a6)
const PGN = '[Event "t"]\n[White "me"]\n[Black "them"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 *';
const h = (() => { const c = new Chess(); c.loadPgn(PGN); return c.history({ verbose: true }); })();
const p0 = base[0];
const whiteCore = { ...p0.core, ply: 6, moveNumber: 4, color: 'w', fenBefore: h[6].before, fenAfter: h[6].after, playedUci: 'b5c6', playedSan: 'Bxc6', bestUci: 'b5a4', bestSan: 'Ba4', prevUci: 'a7a6', prevFen: h[5].before };
const { prevUci, prevFen, ...noPrev } = whiteCore;
const pk = p0.profileKey;
const now = Date.now();
const mk = (id, core, extra = {}) => ({ ...p0, id: `${pk}|${id}`, gameId: id, core, srs: { ...p0.srs, retired: false, due: now - 60000, history: [] }, ...extra });
const seeds = [
  mk('lm-black', p0.core),
  mk('lm-white', whiteCore),
  mk('lm-old', noPrev), // saved without its prior move: derived from the stored game
  mk('lm-start', { ...noPrev, fenBefore: new Chess().fen(), moveNumber: 1, ply: 0 }),
];
const games = [{ key: `${pk}|lm-old`, profileKey: pk, game: { id: 'lm-old', platform: 'pgn', url: '', pgn: PGN, white: { username: 'me', rating: 1500 }, black: { username: 'them', rating: 1500 }, endTime: 1, timeClass: 'rapid', opening: '' }, myColor: 'w', savedAt: now }];

for (const [tag, viewport, mobile] of [['desktop', { width: 1400, height: 950 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(30000);
  await page.goto(BASE + '?user=demo-player&view=data');
  await page.waitForSelector('h1');
  await page.evaluate(async ({ seeds, games }) => {
    const db = await new Promise((r, j) => { const q = indexedDB.open('chess-review'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    await new Promise((r, j) => { const t = db.transaction(['puzzles', 'games'], 'readwrite'); seeds.forEach((p) => t.objectStore('puzzles').put(p)); games.forEach((g) => t.objectStore('games').put(g)); t.oncomplete = r; t.onerror = () => j(t.error); });
    db.close();
  }, { seeds, games });

  const open = async (id) => {
    await page.goto(BASE + `?user=demo-player&view=train&p=${encodeURIComponent(`${pk}|${id}`)}`);
    await page.waitForSelector('.trainer #tr-board cg-board');
    await page.waitForTimeout(400);
  };
  // which board cell (column, row from top-left) each last-move square is drawn in, and the squares chessground marks
  const hl = () => page.evaluate(() => {
    const b = document.querySelector('#tr-board cg-board').getBoundingClientRect();
    return [...document.querySelectorAll('#tr-board square.last-move')].map((s) => { const r = s.getBoundingClientRect(); return { key: s.cgKey, col: Math.round(((r.left + r.right) / 2 - b.left) / (b.width / 8) - 0.5), row: Math.round(((r.top + r.bottom) / 2 - b.top) / (b.height / 8) - 0.5) }; }).sort((a, b) => a.key.localeCompare(b.key));
  });
  const cell = (sq, white) => { const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1; return white ? { col: f, row: 7 - r } : { col: 7 - f, row: r }; };
  const sameCells = (got, squares, white) => got.length === 2 && squares.every((sq) => { const g = got.find((x) => x.key === sq); const e = cell(sq, white); return g && g.col === e.col && g.row === e.row; });
  const lastText = async () => (await page.locator('#tr-last').isVisible()) ? (await page.locator('#tr-last').innerText()).replace(/\s+/g, ' ').trim() : '(hidden)';

  // Black to play, Black at the bottom (as in demo-player's screenshot): last move 15. Rb5 (e5 to b5)
  await open('lm-black');
  check(`${tag}: Black to play shows White's last move`, /^Last move: 15\. Rb5 \(e5 → b5\)$/.test(await lastText()), await lastText());
  check(`${tag}: board flipped for Black`, await page.locator('#tr-board.orientation-black, #tr-board .orientation-black').count() >= 1);
  let got = await hl();
  check(`${tag}: e5 and b5 highlighted in the right cells (Black at the bottom)`, sameCells(got, ['e5', 'b5'], false), JSON.stringify(got));
  // a wrong try resets the board; the highlight must come back
  await page.fill('#tr-input', p0.core.playedSan);
  await page.press('#tr-input', 'Enter');
  await page.waitForFunction(() => /move from the game/.test(document.querySelector('#tr-status')?.textContent || ''), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  got = await hl();
  check(`${tag}: highlight restored after a wrong try`, sameCells(got, ['e5', 'b5'], false), JSON.stringify(got));

  // White to play, White at the bottom: 3... a6
  await open('lm-white');
  check(`${tag}: White to play shows Black's move with "..."`, /^Last move: 3\.\.\. a6 \(a7 → a6\)$/.test(await lastText()), await lastText());
  got = await hl();
  check(`${tag}: a7 and a6 highlighted in the right cells (White at the bottom)`, sameCells(got, ['a6', 'a7'], true), JSON.stringify(got));

  // old saved position with no prior move: found from the stored game
  await open('lm-old');
  await page.waitForFunction(() => !document.querySelector('#tr-last')?.hidden, null, { timeout: 5000 }).catch(() => {});
  check(`${tag}: old position gets its last move from the game PGN`, /^Last move: 3\.\.\. a6/.test(await lastText()), await lastText());
  got = await hl();
  check(`${tag}: old position highlight`, sameCells(got, ['a6', 'a7'], true), JSON.stringify(got));

  await open('lm-start');
  check(`${tag}: start position says so`, (await lastText()) === 'Last move: none (start of game)', await lastText());
  check(`${tag}: no highlight at the start`, (await hl()).length === 0);

  // the line sits above the board
  await open('lm-black');
  const above = await page.evaluate(() => document.querySelector('#tr-last').getBoundingClientRect().bottom <= document.querySelector('#tr-board').getBoundingClientRect().top + 1);
  check(`${tag}: line is above the board`, above);
  if (mobile) check(`${tag}: no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}
console.log(`${pass}/${pass + fail} checks passed`);
await browser.close();
process.exit(fail ? 1 : 0);
