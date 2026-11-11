// E2E for four fixes: one batch across tabs (Web Locks), full review reuses batch results, engine results survive a
// backup round-trip (tampered entries dropped), and Mistakes to Master links to the analysis board. Desktop and phone.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = process.env.OUT || 'shots-gaps';
const ONLY = process.env.ONLY || '';
mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const UA = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
const LIST = '?user=demo-player';
const errors = [];
const idb = (page, store) => page.evaluate(async (s) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('chess-review'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return await new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => { res(q.result); db.close(); }; });
}, store);

async function run(tag, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, userAgent: UA, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, acceptDownloads: true });
  const watch = (p) => { p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${tag}: ${m.text()}`); }); p.on('dialog', (d) => d.accept()); };
  const a = await ctx.newPage(); watch(a);
  await a.goto(BASE + LIST);
  await a.waitForSelector('.game-row', { timeout: 60000 });
  await a.evaluate(() => localStorage.setItem('cr-depth', 'fast'));
  await a.click('#b-open');
  await a.check('input[name="b-n"][value="5"]');
  await a.selectOption('#b-mode', 'light');
  await a.click('#b-start');
  await a.waitForFunction(() => window.__batch?.running && window.__batch.jobs.some((j) => j.status === 'running'), null, { timeout: 60000 });

  // 2. a second tab sees the running batch and offers no second one
  const b = await ctx.newPage(); watch(b);
  await b.goto(BASE + LIST);
  await b.waitForSelector('.game-row', { timeout: 60000 });
  await b.waitForSelector('#b-elsewhere', { timeout: 20000 }).catch(() => {});
  const note = await b.locator('#b-elsewhere').innerText().catch(() => '');
  ok(`${tag}: second tab shows a calm note`, /running in another tab/.test(note), note);
  ok(`${tag}: second tab offers no start or controls`, (await b.locator('#b-open, #b-start, #b-pause, #b-cancel').count()) === 0);
  ok(`${tag}: second tab runs no engine work`, (await b.evaluate(() => window.__batch?.running)) === false);
  await b.screenshot({ path: `${OUT}/${tag}-1-elsewhere.png` });
  await a.waitForFunction(() => window.__batch?.jobs.some((j) => j.status === 'done'), null, { timeout: 600000 });
  const doneA = (await a.evaluate(() => window.__batch)).jobs.filter((j) => j.status === 'done').map((j) => j.id);
  const gid = doneA[0];
  ok(`${tag}: first tab finished a game`, !!gid, doneA.join(','));
  await a.close();
  await b.waitForFunction(() => window.__batch && !window.__batch.elsewhere && window.__batch.running, null, { timeout: 30000 }).catch(() => {});
  const sb = await b.evaluate(() => window.__batch);
  ok(`${tag}: second tab takes over when the first closes`, sb && !sb.elsewhere && sb.running && (await b.locator('#b-elsewhere').count()) === 0, sb && sb.jobs.map((j) => j.status).join(','));
  ok(`${tag}: finished work is kept, not redone`, sb && doneA.every((id) => sb.jobs.find((j) => j.id === id)?.status === 'done'));
  await b.click('#b-cancel').catch(() => {});
  await b.waitForFunction(() => !window.__batch?.running, null, { timeout: 30000 }).catch(() => {});

  // 1. full review reuses what the batch analysed and only deepens the rest
  await b.addInitScript(() => {
    window.__early = false;
    const t = setInterval(() => { const c = document.getElementById('coach'); if (c && c.querySelector('.coach-head') && !/Analysis complete/.test(document.body.innerText)) window.__early = true; }, 50);
    setTimeout(() => clearInterval(t), 600000);
  });
  await b.goto(BASE + LIST + `&game=${gid}`);
  await b.waitForFunction(() => window.__review && window.__review.total > 0 && window.__review.done === window.__review.total && document.querySelector('#coach .coach-head'), null, { timeout: 600000 });
  const rv = await b.evaluate(() => ({ reused: window.__review.reused, total: window.__review.total, minDepth: Math.min(...window.__review.evals.map((e) => e.terminal ? 99 : e.depth)), early: window.__early, text: document.body.innerText.match(/Analysis complete[^\n]*/)?.[0] ?? '' }));
  ok(`${tag}: review reuses batch results`, rv.reused > 0 && rv.reused < rv.total, `${rv.reused}/${rv.total} reused`);
  ok(`${tag}: every position at least as deep as asked`, rv.minDepth >= 14, `min depth ${rv.minDepth}`);
  ok(`${tag}: progress names the reuse`, /reused from earlier analysis/.test(rv.text), rv.text);
  ok(`${tag}: coach waits for the complete analysis`, !rv.early);
  await b.screenshot({ path: `${OUT}/${tag}-2-review.png` });

  // 3. backup keeps engine results; tampered ones are dropped
  const before = await idb(b, 'evalcache');
  await b.goto(BASE + LIST + '&view=data');
  await b.waitForSelector('#exp');
  const [dl] = await Promise.all([b.waitForEvent('download'), b.click('#exp')]);
  const file = `/tmp/gaps-${tag}.json`;
  await dl.saveAs(file);
  const bk = JSON.parse(readFileSync(file, 'utf8'));
  ok(`${tag}: backup includes engine results`, Array.isArray(bk.evalcache) && bk.evalcache.length === before.length && before.length > 0, `${bk.evalcache?.length} exported, ${before.length} stored`);
  const good = bk.evalcache[0];
  const tampered = [
    { ...good, key: good.key.replace('|d', '|d1'), ev: { ...good.ev, lines: [{ ...good.ev.lines[0], pv: ['a1a8'] }] } },
    { ...good, key: good.key.replace(/nn-[0-9a-f]+/, 'nn-000000000000') },
    { key: good.key.replace(/^[^|]+/, '<img src=x onerror=window.__x=1>'), ev: good.ev, at: 1 },
    { ...good, key: good.key.replace(/\|d\d+\|/, '|d40|') },
  ];
  bk.evalcache = [...tampered, ...bk.evalcache];
  writeFileSync(file, JSON.stringify(bk));
  await b.click('#del');
  await b.waitForTimeout(1200);
  ok(`${tag}: delete clears engine results`, (await idb(b, 'evalcache')).length === 0);
  await b.goto(BASE + LIST + '&view=data');
  await b.setInputFiles('#imp', file);
  await b.waitForFunction(() => /Imported/.test(document.getElementById('data-msg')?.textContent ?? ''), null, { timeout: 30000 });
  const msg = await b.locator('#data-msg').innerText();
  const after = await idb(b, 'evalcache');
  const keys = new Set(after.map((e) => e.key));
  ok(`${tag}: import restores engine results`, after.length === before.length && before.every((e) => keys.has(e.key)) && /saved engine results/.test(msg), `${after.length}/${before.length} · ${msg}`);
  ok(`${tag}: tampered engine results dropped`, tampered.every((t) => !keys.has(t.key)) && !(await b.evaluate(() => window.__x)));
  // Delete all also cleared settings; ask for the same depth again. The review can only come from the restored engine results.
  await b.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('cr1:')) localStorage.removeItem(k); localStorage.setItem('cr-depth', 'fast'); });
  await b.goto(BASE + LIST + `&game=${gid}`);
  await b.waitForFunction(() => window.__review && window.__review.total > 0 && document.querySelector('#coach .coach-head'), null, { timeout: 120000 });
  const rv2 = await b.evaluate(() => ({ reused: window.__review.reused, total: window.__review.total, live: window.__review.evals.filter((e) => !e.terminal).length }));
  ok(`${tag}: restored results reused after import`, rv2.reused === rv2.live, `${rv2.reused}/${rv2.total} reused (${rv2.total - rv2.live} game-over position needs no engine)`);

  // 4. Mistakes to Master links each position to the analysis board
  await b.goto(BASE + LIST + '&view=puzzles');
  await b.waitForSelector('.pz-act', { timeout: 30000 });
  const pz = (await idb(b, 'puzzles'))[0];
  const btn = b.locator('[data-analyse]').first();
  const id = await btn.getAttribute('data-analyse');
  const target = (await idb(b, 'puzzles')).find((p) => p.id === id) ?? pz;
  await b.screenshot({ path: `${OUT}/${tag}-3-puzzles.png` });
  await btn.click();
  await b.waitForFunction(() => window.__ws && /view=analysis/.test(location.search) && /ws=/.test(location.search), null, { timeout: 20000 });
  const ws = await b.evaluate(() => ({ start: window.__ws.doc.startFen, n: window.__ws.tree.count() }));
  ok(`${tag}: Analyse opens the board at that position`, ws.start === target.core.fenBefore && ws.n > 1, `${ws.n} moves loaded`);
  await b.screenshot({ path: `${OUT}/${tag}-4-board.png` });
  const ov = await b.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  ok(`${tag}: no horizontal overflow`, ov <= 0, `${ov}px`);
  await ctx.close();
}
if (!ONLY || ONLY === 'phone') await run('phone', { width: 390, height: 844 }, true);
if (!ONLY || ONLY === 'desktop') await run('desktop', { width: 1400, height: 950 }, false);
ok('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
