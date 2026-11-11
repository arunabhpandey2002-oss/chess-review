// Stress: seed a large library (100/250/500 reviewed games) from a real batch backup (stress/seed-backup.json),
// then time the main pages, measure JS heap (CDP, after GC) and storage, and collect errors. Desktop and phone (4x CPU throttle).
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const SIZES = (process.env.SIZES || '100,250,500').split(',').map(Number);
const ONLY = process.env.ONLY || '';
const seed = JSON.parse(readFileSync('stress/seed-backup.json', 'utf8'));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const UA = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
const rows = [];
const U = '?user=demo-player';

async function seedDb(page, n) {
  return page.evaluate(async ({ seed, n }) => {
    const db = await new Promise((r, j) => { const q = indexedDB.open('chess-review'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    const putAll = (s, items) => new Promise((r, j) => { const t = db.transaction(s, 'readwrite'); const o = t.objectStore(s); for (const it of items) o.put(it); t.oncomplete = () => r(items.length); t.onerror = () => j(t.error); });
    const base = seed.reviews, B = base.length, DAY = 86400000;
    const reviews = [], puzzles = [], games = [], cache = [];
    const pzBy = new Map(); for (const p of seed.puzzles) { const a = pzBy.get(p.gameId) ?? []; a.push(p); pzBy.set(p.gameId, a); }
    const gBy = new Map(seed.games.map((g) => [g.game.id, g]));
    for (let i = 0; i < n; i++) {
      const r = base[i % B], k = Math.floor(i / B), gid = k ? `${r.gameId}s${k}` : r.gameId, shift = k * 30 * DAY;
      reviews.push({ ...r, key: `${r.profileKey}|${gid}`, gameId: gid, endTime: r.endTime - shift, reviewedAt: r.reviewedAt - shift });
      const g = gBy.get(r.gameId); if (g) games.push({ ...g, key: `${g.profileKey}|${gid}`, game: { ...g.game, id: gid } });
      for (const p of pzBy.get(r.gameId) ?? []) {
        const hist = Array.from({ length: (i + p.core.ply) % 4 }, (_, h) => ({ at: Date.now() - (h + 1) * 3 * DAY, solved: h % 2 === 0, hints: 0, attempts: 1 }));
        puzzles.push({ ...p, id: `${p.profileKey}|${gid}|${p.core.ply}`, gameId: gid, endTime: p.endTime - shift, srs: { ...p.srs, history: [...(p.srs.history ?? []), ...hist] } });
      }
    }
    // engine cache: the real batch's entries, copied once per extra block of games (distinct keys via the move counter)
    const blocks = Math.ceil(n / B);
    for (let k = 0; k < blocks; k++) for (const e of seed.evalcache ?? []) {
      const [fen, ...rest] = e.key.split('|'); const f = fen.split(' '); f[5] = String(+f[5] + k * 200);
      cache.push({ ...e, key: [f.join(' '), ...rest].join('|') });
    }
    await putAll('reviews', reviews); await putAll('puzzles', puzzles); await putAll('games', games);
    for (let i = 0; i < cache.length; i += 5000) await putAll('evalcache', cache.slice(i, i + 5000));
    await putAll('profiles', seed.profiles);
    db.close();
    return { reviews: reviews.length, puzzles: puzzles.length, games: games.length, evalcache: cache.length };
  }, { seed, n });
}

async function run(tag, viewport, mobile, n) {
  const ctx = await browser.newContext({ viewport, userAgent: UA, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); const m = await cdp.send('Runtime.getHeapUsage'); return +(m.usedSize / 1048576).toFixed(1); };
  await page.goto(BASE + U); await page.waitForSelector('.game-row', { timeout: 60000 });
  const counts = await seedDb(page, n);
  if (mobile) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const time = async (url, sel) => { const t = Date.now(); await page.goto(BASE + U + url); await page.waitForSelector(sel, { timeout: 120000 }); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))); return Date.now() - t; };
  const r = { tag, n, ...counts };
  r.reviewedGames = counts.reviews;
  r.homeMs = await time('', '#home-panel .due-big, #home-panel .home-card');
  r.gamesListMs = await time('', '.game-row');
  r.puzzlesMs = await time('&view=puzzles', '.pz-row');
  r.pzRows = await page.locator('.pz-row').count();
  r.heapPuzzles = await heap();
  r.historyMs = await time('&view=history', '.hist-list .game-row');
  r.histRows = await page.locator('.hist-list .game-row').count();
  r.heapHistory = await heap();
  const gid = seed.reviews[0].gameId;
  r.reviewMs = await time(`&game=${gid}`, '#coach, .progress');
  const t = Date.now();
  await page.waitForSelector('.progress.complete', { timeout: 600000 }).catch(() => {});
  r.reviewDoneMs = Date.now() - t + r.reviewMs;
  r.heap = await heap();
  r.reviewText = await page.locator('#progress .ptext').innerText().catch(() => '');
  r.storage = await page.evaluate(async () => { const e = await navigator.storage.estimate(); return { used: +((e.usage ?? 0) / 1048576).toFixed(1), quota: Math.round((e.quota ?? 0) / 1048576) }; });
  r.errors = errors.length ? errors.slice(0, 3).join(' | ') : 'none';
  console.log(JSON.stringify(r));
  rows.push(r);
  await ctx.close();
}
for (const n of SIZES) {
  if (!ONLY || ONLY === 'desktop') await run('desktop', { width: 1400, height: 950 }, false, n);
  if (!ONLY || ONLY === 'phone') await run('phone', { width: 390, height: 844 }, true, n);
}
writeFileSync(`stress/library-${process.env.TAG || 'run'}.json`, JSON.stringify(rows, null, 1));
await browser.close();
