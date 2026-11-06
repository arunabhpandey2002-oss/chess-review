// Openings, both sides: "Play the opening" stays strict (the line's moves, wrong tries explained and retried, hints);
// "Defend against it" lets you play any move for 12 moves while the app plays the opening's line, then shows a
// move-by-move review (you played vs best/book, verdict, eval, reason); rows show arrows on the board; progress is
// saved per side. Desktop and phone, with deliberate off-book moves.
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { Chess } from 'chess.js';
const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = process.env.OUT || 'shots-bothsides';
mkdirSync(OUT, { recursive: true });
const data = JSON.parse(readFileSync('src/repertoire.json', 'utf8'));
const byId = (id) => data.openings.find((o) => o.id === id);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== '' ? ' — ' + info : ''}`); };
const USER = 'both-e2e-user';
const key = (fen) => fen.split(' ').slice(0, 3).join(' ');

async function typeMove(page, san) { await page.fill('#tr-input', san); await page.press('#tr-input', 'Enter'); }

/** Plays a defend round: line replies where known, the listed off-book moves at the given move numbers. */
async function defendRound(page, entry, offBook, tag, shotAt, random = false) {
  const replies = random ? new Map(entry.plies.filter((p) => p.mine).map((p) => [key(p.fen), p.san]))
    : new Map(data.openings.filter((o) => o.family === entry.family).flatMap((o) => o.plies.filter((p) => !p.mine).map((p) => [key(p.fen), p.san])));
  const userPly = random ? 1 : entry.side === 'w' ? 1 : 0;
  const played = [];
  const statuses = [];
  for (let guard = 0; guard < 600; guard++) {
    const st = await page.evaluate(() => ({ fen: window.__defend.fen, mine: window.__defend.myTurn(), done: window.__defend.done, ply: window.__defend.ply }));
    if (st.done) break;
    if (!st.mine) { await page.waitForTimeout(150); continue; }
    const c = new Chess(st.fen);
    const n = Math.floor(st.ply / 2) + 1;
    let san = offBook[n] && c.moves().includes(offBook[n]) ? offBook[n] : replies.get(key(st.fen));
    const natural = ['e6', 'd6', 'd5', 'e5', 'g6', 'Bg7', 'Be7', 'Nc6', 'Nbd7', 'O-O', 'c5', 'b6', 'Bb7', 'Re8', 'a6', 'e4', 'd4', 'c4', 'g3', 'Bg2', 'Nc3', 'Bb2', 'b3', 'Be2', 'Re1', 'Qc2', 'Nf6', 'Nf3'];
    if (!san || !c.moves().includes(san)) { const ms = c.moves(); san = natural.find((m) => ms.includes(m)) ?? ms.find((m) => !/[x+#]/.test(m)) ?? ms[0]; }
    played.push(`${n}.${san}${offBook[n] === san ? '*' : ''}`);
    await typeMove(page, san);
    await page.waitForFunction((p) => window.__defend.ply > p, st.ply);
    statuses.push(await page.locator('#tr-status').getAttribute('class'));
    if (n === shotAt && st.ply % 2 === userPly) {
      await page.waitForFunction(() => window.__defend.myTurn() || window.__defend.done, null, { timeout: 30000 });
      await page.waitForTimeout(450);
      await page.screenshot({ path: `${OUT}/${tag}${random ? '' : '-defend'}-1-in-round.png`, fullPage: tag.startsWith('phone') });
    }
  }
  return { played, statuses };
}

for (const [tag, viewport, mobile] of [['desktop', { width: 1400, height: 950 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.setDefaultTimeout(30000);
  await page.route('https://api.chess.com/**', (r) => r.request().url().includes('/games/archives') ? r.fulfill({ json: { archives: [] } }) : r.fulfill({ status: 404, json: {} }));

  // library: both modes on every variation and family
  await page.goto(BASE + `?user=${USER}&view=openings`);
  await page.waitForSelector('.op-card');
  const nVar = await page.locator('.op-var').count();
  check(`${tag}: every variation offers Practise (Defend is on the practice screen / family)`, nVar === data.openings.length && (await page.locator('.op-var [data-practice]').count()) === nVar && (await page.locator('.op-card .op-actions [data-defend]').count()) === data.families.length, nVar);
  check(`${tag}: every family offers Practise all and Defend against it`, (await page.locator('.op-card .op-actions [data-defend]').count()) === data.families.length);

  // ---- play mode: strict, as before ----
  const ik = byId('indian-knights');
  await page.locator('#op-indian-knights [data-practice]').click();
  await page.waitForSelector('#op-task');
  check(`${tag}: play mode selected in the mode switch`, (await page.locator('#op-mode-play').getAttribute('aria-pressed')) === 'true');
  check(`${tag}: play mode names the variation`, /Indian Defense: Knights Variation/.test(await page.locator('.tr-head h2').innerText()) && /A46|A45|Indian/.test(await page.locator('.tr-head h2').innerText()) && /^Practise$/.test((await page.locator('.page-head h1').innerText()).trim()) && /Indian Defense: Knights Variation/.test(await page.locator('#op-namebar').innerText()));
  await page.waitForFunction(() => /to move/.test(document.querySelector('#op-task')?.textContent ?? ''));
  const famIdea = data.families.find((f) => f.id === (ik.family || 'f-indian'))?.idea;
  const ideaTxt = await page.locator('#op-idea-text').textContent();
  check(`${tag}: practising one variation shows that variation's own idea`, ideaTxt === ik.idea && ideaTxt !== famIdea, ideaTxt.slice(0, 80));
  await typeMove(page, 'h4');
  await page.waitForFunction(() => /bad|warn/.test(document.querySelector('#tr-status').className));
  check(`${tag}: play mode still rejects a move outside the line`, /isn't the move in this line|Try again/.test(await page.locator('#tr-status').innerText()), await page.locator('#tr-status').innerText());
  await page.click('#tr-hint');
  check(`${tag}: play mode hint still works`, /Idea:/.test(await page.locator('#tr-hints').innerText()));
  let shot = false;
  for (let i = 0; i < ik.plies.length; i++) {
    const p = ik.plies[i];
    if (!p.mine) continue;
    await page.waitForFunction((n) => /to move/.test(document.querySelector('#op-task').textContent) && document.querySelectorAll('#op-progress').length && document.querySelector('#op-progress').textContent.includes(`${n} of`), ik.plies.slice(0, i).filter((x) => x.mine).length);
    if (!shot && i >= 4) { await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}/${tag}-play-1-in-round.png`, fullPage: mobile }); shot = true; }
    await typeMove(page, p.san);
  }
  await page.waitForSelector('#op-mastery');
  check(`${tag}: play mode completes the line`, /Line complete/.test(await page.locator('#tr-status').innerText()));
  check(`${tag}: opening name bar shows the variation`, /Opening: Indian Defense: Knights Variation/.test(await page.locator('#op-namebar').innerText()), await page.locator('#op-namebar').innerText());
  await page.screenshot({ path: `${OUT}/${tag}-play-2-complete.png`, fullPage: mobile });

  // ---- defend mode (user Black against the Indian Knights line) ----
  await page.click('#op-switch');
  await page.waitForFunction(() => !!window.__defend);
  check(`${tag}: switch goes to defend mode`, page.url().includes('m=defend') && (await page.locator('#op-mode-defend').getAttribute('aria-pressed')) === 'true');
  check(`${tag}: defend: you play Black, the app plays White`, /You play Black/.test(await page.locator('.tr-head').innerText()) && (await page.locator('#op-mode-defend').getAttribute('aria-pressed')) === 'true');
  const r1 = await defendRound(page, ik, { 3: 'h6', 6: 'a5', 9: 'Qd7' }, tag, 5);
  check(`${tag}: defend round accepts any move; nothing marked wrong mid-round`, r1.statuses.every((c) => !/bad|warn/.test(c)), r1.played.join(' '));
  await page.waitForSelector('#dr-review', { timeout: 240000 });
  const rows = await page.locator('.dr-row').count();
  check(`${tag}: round lasted 12 moves, 12 review rows`, rows === 12 && (await page.evaluate(() => window.__defend.ply)) === 24, rows);
  const sum = await page.locator('.dr-sum').innerText();
  check(`${tag}: summary with accuracy and mistake counts`, /\d+%\s*accuracy/.test(sum) && /mistake/.test(sum), sum.replace(/\s+/g, ' '));
  check(`${tag}: defend review shows the book line with where you left it`, (await page.locator('#dr-bookline .dr-ply').count()) > 0 && /You left the line at/.test(await page.locator('#dr-bookline').innerText()) && (await page.locator('#dr-bookline .dr-left').count()) === 1);
  check(`${tag}: says where you left book`, /left book at|stayed in book/.test(await page.locator('#dr-review').innerText()));
  const verdicts = await page.locator('.dr-row .dr-v').allInnerTexts();
  check(`${tag}: off-book moves are not all Book`, verdicts.filter((v) => v !== 'Book').length >= 2 && verdicts[0] === 'Book', verdicts.join(','));
  const whys = await page.locator('.dr-why').allInnerTexts();
  check(`${tag}: every row has a reason`, whys.length === 12 && whys.every((w) => /Book move|Engine|Fine/.test(w)), whys[2]);
  if (mobile) { await page.screenshot({ path: `${OUT}/${tag}-defend-2-review-full.png`, fullPage: true }); await page.evaluate(() => document.querySelector('#dr-review').scrollIntoView()); await page.evaluate(() => scrollBy(0, -(document.querySelector('.topbar')?.offsetHeight ?? 60) - 8)); }
  await page.screenshot({ path: `${OUT}/${tag}-defend-2-review.png` });
  // click the worst row: arrows on the board
  const idx = verdicts.findIndex((v) => /Blunder|Mistake|Inaccuracy/.test(v));
  await page.locator('.dr-row').nth(idx >= 0 ? idx : 2).click();
  await page.waitForFunction(() => document.querySelectorAll('#tr-board svg.cg-shapes line').length >= 2, null, { timeout: 5000 }).catch(() => {});
  const shapes = await page.evaluate(() => document.querySelectorAll('#tr-board svg.cg-shapes line').length);
  check(`${tag}: clicking a row shows both moves as arrows`, shapes >= 2, shapes);
  check(`${tag}: last-move bar says what you played vs should have`, /you played .* should have played/.test(await page.locator('#tr-last').innerText()), await page.locator('#tr-last').innerText());
  if (!mobile) await page.screenshot({ path: `${OUT}/${tag}-defend-3-row-arrows.png` });
  else { await page.evaluate(() => { document.querySelector('#op-namebar').scrollIntoView(); scrollBy(0, -(document.querySelector('.topbar')?.offsetHeight ?? 60) - 8); }); await page.screenshot({ path: `${OUT}/${tag}-defend-3-row-arrows.png` }); }
  check(`${tag}: Play again and Switch side offered`, (await page.locator('#dr-again').count()) === 1 && /Switch side/.test(await page.locator('#dr-switch').innerText()));
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(`${tag}: no horizontal overflow on the review`, ov <= 0, `${ov}px`);

  // ---- defend a Black-side family (you play White vs the Réti reply line) via the family button ----
  await page.goto(BASE + `?user=${USER}&view=openings`);
  await page.waitForSelector('.op-card');
  await page.locator('#op-f-reti .op-actions [data-defend]').click();
  await page.waitForFunction(() => !!window.__defend);
  check(`${tag}: Réti defend: you play White`, /You play White/.test(await page.locator('.tr-head').innerText()) && (await page.locator('#op-mode-defend').getAttribute('aria-pressed')) === 'true');
  const reti = byId('reti');
  const r2 = await defendRound(page, reti, { 2: 'h3', 7: 'Qe2' }, `${tag}-reti`, 4);
  await page.waitForSelector('#dr-review', { timeout: 240000 });
  const end = await page.evaluate(() => ({ ply: window.__defend.ply, task: document.querySelector('#op-task').textContent }));
  check(`${tag}: Réti defend round reviewed (a row per move; 12 unless the game ended first)`, (await page.locator('.dr-row').count()) === r2.played.length && (end.ply === 24 || /checkmate|game over/.test(end.task)), `${r2.played.join(' ')} · ${end.task}`);
  if (mobile) { await page.evaluate(() => { document.querySelector('#dr-review').scrollIntoView(); scrollBy(0, -(document.querySelector('.topbar')?.offsetHeight ?? 60) - 8); }); }
  await page.screenshot({ path: `${OUT}/${tag}-reti-defend-2-review.png` });

  // ---- random opening: you're Black, White's opening is a surprise, named in the review ----
  await page.goto(BASE + `?user=${USER}&view=openings`);
  await page.waitForSelector('#op-random');
  check(`${tag}: library has the Random opening section`, /Random opening/.test(await page.locator('#op-random-card').innerText()) && /64 White openings/.test(await page.locator('#op-random-card').innerText()), await page.locator('#op-random-card .op-status').innerText());
  await page.click('#op-random');
  await page.waitForFunction(() => !!window.__defend && window.__defend.random);
  const rid = await page.evaluate(() => window.__defend.e.id);
  const re = byId(rid);
  check(`${tag}: random picks a White opening; you play Black`, re && re.side === 'b' && /You play Black/.test(await page.locator('.tr-head').innerText()), rid);
  const hidden = (await page.locator('.openings-train').innerText());
  check(`${tag}: random doesn't reveal the opening during the round`, !hidden.includes(re.name) && /hidden/.test(await page.locator('#op-namebar').innerText()) && (await page.locator('.op-modes').count()) === 0, await page.locator('#op-namebar').innerText());
  const r3 = await defendRound(page, re, { 4: 'h6', 8: 'a5' }, `${tag}-random`, 3, true);
  check(`${tag}: random round accepts any move`, r3.statuses.every((c) => !/bad|warn/.test(c)), r3.played.join(' '));
  await page.waitForSelector('#dr-review', { timeout: 240000 });
  const end3 = await page.evaluate(() => ({ ply: window.__defend.ply, task: document.querySelector('#op-task').textContent }));
  check(`${tag}: random round reviewed (row per move)`, (await page.locator('.dr-row').count()) === r3.played.length && (end3.ply === 24 || /checkmate|game over/.test(end3.task)), r3.played.join(' '));
  check(`${tag}: review names the opening White played`, (await page.locator('#dr-reveal').innerText()).includes(re.name), await page.locator('#dr-reveal').innerText());
  check(`${tag}: name bar reveals White's opening after the round`, (await page.locator('#op-namebar').innerText()).includes(`White's opening: ${re.name}`), await page.locator('#op-namebar').innerText());
  const bl = await page.locator('#dr-bookline').innerText();
  check(`${tag}: review shows the full book line`, (await page.locator('#dr-bookline .dr-ply').count()) === re.plies.length && bl.includes(re.plies[re.plies.length - 1].san), bl.slice(0, 120));
  const leftPly = await page.locator('#dr-bookline .dr-left').getAttribute('data-ply').catch(() => null);
  const expLeft = r3.played.findIndex((x) => x.endsWith('*'));
  check(`${tag}: book line highlights where you left it`, leftPly !== null && /You left the line at/.test(bl) && /you played/.test(await page.locator('#dr-bookline .dr-left').innerText()), `${leftPly} (first off-book user move #${expLeft + 1})`);
  check(`${tag}: random review explains this variation's idea`, (await page.locator('#dr-review details.op-line p').last().textContent()) === re.idea);
  check(`${tag}: random review has Drill this line + Next random opening`, (await page.locator('#dr-drill').count()) === 1 && /Next random/.test(await page.locator('#dr-again').innerText()));
  if (mobile) { await page.screenshot({ path: `${OUT}/${tag}-random-2-review-full.png`, fullPage: true }); await page.evaluate(() => { document.querySelector('#dr-review').scrollIntoView(); scrollBy(0, -(document.querySelector('.topbar')?.offsetHeight ?? 60) - 8); }); }
  await page.screenshot({ path: `${OUT}/${tag}-random-2-review.png` });
  await page.evaluate(() => { document.querySelector('#dr-bookline').scrollIntoView(); scrollBy(0, -(document.querySelector('.topbar')?.offsetHeight ?? 60) - 8); });
  await page.screenshot({ path: `${OUT}/${tag}-random-3-bookline.png` });
  await page.click('#dr-drill');
  await page.waitForSelector('#op-task');
  check(`${tag}: Drill this line opens strict practise of that opening as Black`, page.url().includes(`o=${rid}`) && !page.url().includes('m=') && (await page.locator('#op-mode-play').getAttribute('aria-pressed')) === 'true' && /you're Black/.test(await page.locator('#op-mode-play').innerText()) && (await page.locator('.tr-head h2').innerText()).includes(re.name.split(':')[0]), page.url());

  // progress saved per side
  await page.goto(BASE + `?user=${USER}&view=openings`);
  await page.waitForSelector('.op-card');
  const row = page.locator('#op-indian-knights');
  const st = await row.locator('.op-var-top .op-status').innerText();
  const tip = await row.locator('.op-var-top .op-status').getAttribute('title');
  check(`${tag}: progress tracked (combined mark; both modes under the hood)`, !/New/.test(st) && /Play:/.test(tip || '') && /Defend:/.test(tip || ''), `status: ${st} | ${tip}`);
  const ov2 = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(`${tag}: random progress shown on the card`, /1 of 64 seen/.test(await page.locator('#op-random-card .op-status').innerText()), await page.locator('#op-random-card .op-status').innerText());
  check(`${tag}: library has no horizontal overflow`, ov2 <= 0, `${ov2}px`);
  if (mobile) await page.locator('#op-f-indian').screenshot({ path: `${OUT}/${tag}-library-card.png` });
  else await page.locator('#op-f-indian').screenshot({ path: `${OUT}/${tag}-library-card.png` });
  await page.locator('#op-random-card').screenshot({ path: `${OUT}/${tag}-library-random.png` });
  check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}
await browser.close();
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
