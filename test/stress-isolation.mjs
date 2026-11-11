// Two separate browser profiles (contexts) = two people. Seeds a library in one; the other must see none of it.
// Also checks the engine-cache cap: an over-cap cache is trimmed to 20,000 shortly after a visit.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const seed = JSON.parse(readFileSync('stress/seed-backup.json', 'utf8'));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const counts = (page) => page.evaluate(async () => { const db = await new Promise((r) => { const q = indexedDB.open('chess-review'); q.onsuccess = () => r(q.result); }); const out = {}; for (const s of ['reviews', 'puzzles', 'evalcache', 'games']) out[s] = await new Promise((r) => { const q = db.transaction(s).objectStore(s).count(); q.onsuccess = () => r(q.result); }); db.close(); return out; });
const a = await (await browser.newContext()).newPage(), b = await (await browser.newContext()).newPage();
await a.goto(BASE + '?user=demo-player'); await a.waitForSelector('.game-row');
await b.goto(BASE + '?user=someone-else'); await b.waitForTimeout(2000);
// person A: 25 real reviews + an over-cap engine cache (16 copies of the real batch cache = 26,352 entries)
await a.evaluate(async (seed) => {
  const db = await new Promise((r) => { const q = indexedDB.open('chess-review'); q.onsuccess = () => r(q.result); });
  const putAll = (s, items) => new Promise((r, j) => { const t = db.transaction(s, 'readwrite'); for (const it of items) t.objectStore(s).put(it); t.oncomplete = r; t.onerror = () => j(t.error); });
  await putAll('reviews', seed.reviews); await putAll('puzzles', seed.puzzles); await putAll('games', seed.games);
  const cache = []; for (let k = 0; k < 16; k++) for (const e of seed.evalcache) { const [fen, ...rest] = e.key.split('|'); const f = fen.split(' '); f[5] = String(+f[5] + k * 200); cache.push({ ...e, key: [f.join(' '), ...rest].join('|'), at: e.at - k * 1000 }); }
  for (let i = 0; i < cache.length; i += 5000) await putAll('evalcache', cache.slice(i, i + 5000));
  db.close();
}, seed);
console.log('A after seeding:', JSON.stringify(await counts(a)));
await b.reload(); await b.waitForTimeout(1500);
console.log('B (separate browser):', JSON.stringify(await counts(b)), 'history rows', await b.goto(BASE + '?user=demo-player&view=history').then(() => b.waitForTimeout(1500)).then(() => b.locator('.hist-list .game-row').count()));
await a.goto(BASE + '?user=demo-player'); await a.waitForTimeout(9000);
console.log('A 9 s after a visit (cache cap):', JSON.stringify(await counts(a)));
await browser.close();
