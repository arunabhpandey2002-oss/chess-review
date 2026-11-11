// Security check: tries to inject script through URL params, an imported PGN and an imported backup.
// Passes if no payload runs, no javascript: link appears and no prototype is polluted.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const P = (id) => `"'><img src=x onerror="window.__x=(window.__x||[]).concat('${id}')"><svg onload="window.__x=(window.__x||[]).concat('${id}s')">`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('dialog', (d) => { fails.push('dialog: ' + d.message()); d.dismiss(); });
const fails = []; let checks = 0;
const csp = [];
page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text().slice(0, 200)); });
async function verify(label) {
  await page.waitForTimeout(1200);
  checks++;
  const r = await page.evaluate(() => ({ x: window.__x || [], js: [...document.querySelectorAll('a[href],iframe[src],form[action]')].map((a) => a.getAttribute('href') || a.getAttribute('src') || a.getAttribute('action')).filter((h) => /^\s*(javascript|data|vbscript):/i.test(h)), pol: ({}).polluted, injected: document.querySelectorAll('img[src="x"], svg[onload]').length }));
  const bad = r.x.length || r.js.length || r.pol || r.injected;
  console.log(`${bad ? 'FAIL' : 'PASS'} ${label}${bad ? ' ' + JSON.stringify(r) : ''}`);
  if (bad) fails.push(label);
  await page.evaluate(() => { window.__x = []; });
}
// 1. URL parameters
for (const q of [`?user=${encodeURIComponent(P('user'))}`, `?user=${encodeURIComponent(P('u2'))}&view=puzzles&tag=${encodeURIComponent(P('tag'))}`,
  `?user=demo-player&game=${encodeURIComponent(P('game'))}`, `?user=demo-player&view=history`, `?user=${encodeURIComponent(P('li'))}&site=lichess`,
  `?user=demo-player&view=${encodeURIComponent(P('view'))}`]) {
  await page.goto(BASE + q); await verify('url ' + q.slice(0, 40));
}
// 2. Imported PGN with payloads in every header and a javascript: link
const pgn = `[Event "${P('event').replace(/"/g, "'")}"]\n[Site "javascript:window.__x=['site']"]\n[Link "javascript:window.__x=['link']"]\n[White "${P('white').replace(/"/g, "'")}"]\n[Black "demo-player"]\n[WhiteElo "${P('elo').replace(/"/g, "'")}"]\n[Result "1-0"]\n[Opening "${P('open').replace(/"/g, "'")}"]\n[Termination "${P('term').replace(/"/g, "'")}"]\n[TimeControl "600"]\n\n1. e4 {${P('comment').replace(/[{}]/g, '')}} e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0\n`;
await page.goto(BASE + '?user=demo-player&view=import');
await page.fill('#pgn-text', pgn);
await page.click('#f-pgn button.btn:not(.ghost)');
await page.waitForSelector('.progress.complete', { timeout: 300000 }).catch(() => {});
await verify('pgn import → review');
await page.goto(BASE + '?user=demo-player&view=import'); await verify('pgn import list');
await page.goto(BASE + '?user=demo-player&view=history'); await verify('history after pgn');
// 3. Backup with payloads in fields that are not normally text
await page.goto(BASE + '?user=demo-player&view=data');
const dump = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('chess-review'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const out = {};
  for (const s of ['profiles', 'games', 'reviews', 'puzzles']) out[s] = await new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); });
  return out;
});
const pz = dump.puzzles[0] ? JSON.parse(JSON.stringify(dump.puzzles[0])) : null;
const evil = { app: 'chess-review', version: 1, exportedAt: 'x', profiles: [], games: [], reviews: [], puzzles: [] };
const g0 = JSON.parse(JSON.stringify(dump.games[0]));
g0.key = g0.key.replace(/\|.*/, '|evil'); g0.game.id = P('gid'); g0.game.url = "javascript:window.__x=['gurl']"; g0.game.white.rating = P('rating'); g0.game.black.rating = P('rating2'); g0.game.timeClass = P('tc');
evil.games.push(g0);
if (pz) {
  pz.id = 'evil-1'; pz.core.color = P('color'); pz.core.ply = P('ply'); pz.gameUrl = "javascript:window.__x=['purl']"; pz.gameId = P('pgid');
  pz.srs.due = 0; pz.srs.history = [{ at: 1, solved: true, hints: P('hints'), attempts: P('att'), failure: P('fail') }];
  evil.puzzles.push(pz);
}
if (dump.reviews[0]) { const r = JSON.parse(JSON.stringify(dump.reviews[0])); r.key = r.key.replace(/\|.*/, '|evil'); r.gameId = P('rgid'); r.url = "javascript:window.__x=['rurl']"; r.accuracy = P('acc'); r.endTime = P('end'); r.result = P('res'); evil.reviews.push(r); }
const raw = JSON.stringify(evil).replace('"profiles":[]', '"profiles":[{"key":"p","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}]').replace('"version":1', '"version":1,"__proto__":{"polluted":1}');
writeFileSync('/tmp/evil-backup.json', raw);
await page.setInputFiles('#imp', '/tmp/evil-backup.json');
await page.waitForTimeout(1500);
console.log('  import message:', await page.textContent('#data-msg, [role=status]').catch(() => '?'));
await verify('backup import');
for (const v of ['', 'puzzles', 'history', 'data', 'train']) { await page.goto(BASE + `?user=demo-player${v ? '&view=' + v : ''}`); await verify('after backup: ' + (v || 'home')); }
await page.goto(BASE + '?user=demo-player&game=evil'); await verify('after backup: evil game');
console.log(csp.length ? `CSP reports: ${[...new Set(csp)].slice(0, 5).join(' | ')}` : 'no CSP violations logged');
console.log(`\n${checks - fails.length}/${checks} passed`);
await browser.close();
process.exit(fails.length ? 1 : 0);
