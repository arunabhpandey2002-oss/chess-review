// E2E for background batch analysis: start, keep browsing, refresh mid-batch and resume from the cache, pause, resume, cancel.
// Measures UI responsiveness while the engine runs (long tasks and animation-frame gaps). Desktop and phone.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = process.env.OUT || 'shots-batch';
const ONLY = process.env.ONLY || '';
mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const UA = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
const LIST = '?user=Arunabh-pandey';
const errors = [];
const perfInit = () => {
  window.__perf = { long: [], gaps: [], last: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch {}
  const tick = (t) => { if (window.__perf.last) window.__perf.gaps.push(Math.round(t - window.__perf.last)); window.__perf.last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
};
const perf = (page) => page.evaluate(() => { const g = window.__perf.gaps.slice(20).sort((a, b) => a - b); const p = (q) => g[Math.min(g.length - 1, Math.floor(g.length * q))] ?? 0; return { frames: g.length, p50: p(0.5), p99: p(0.99), max: g[g.length - 1] ?? 0, long: window.__perf.long.length, longMax: Math.max(0, ...window.__perf.long) }; });
const snap = (page) => page.evaluate(() => window.__batch);

async function run(tag, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, userAgent: UA, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await ctx.addInitScript(perfInit);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${tag}: ${m.text()}`); });
  await page.goto(BASE + LIST);
  await page.waitForSelector('.game-row', { timeout: 60000 });
  await page.click('#b-open');
  await page.check('input[name="b-n"][value="5"]');
  await page.selectOption('#b-mode', 'light');
  const est = await page.locator('#b-est').innerText();
  ok(`${tag}: options with an estimate`, /^5 games, about .* on this device/.test(est), est);
  await page.screenshot({ path: `${OUT}/${tag}-1-options.png` });
  const t0 = Date.now();
  await page.click('#b-start');
  await page.waitForSelector('.batch-run', { timeout: 30000 });
  // keep browsing while it runs: open Puzzles and come back
  await page.waitForFunction(() => window.__batch?.jobs.some((j) => j.status === 'running' && j.posDone > 5), null, { timeout: 120000 });
  const tNav = Date.now();
  await page.click('a[href*="view=practice"], a[href*="view=puzzles"], [data-view="practice"], [data-view="puzzles"]').catch(() => {});
  await page.waitForTimeout(300);
  await page.goBack();
  await page.waitForSelector('.batch-run', { timeout: 30000 });
  ok(`${tag}: browsing during a batch`, Date.now() - tNav < 5000, `${Date.now() - tNav} ms to leave and return`);
  // wait for the first game to finish and the second to be part-way
  await page.waitForFunction(() => { const j = window.__batch?.jobs ?? []; return j.filter((x) => x.status === 'done').length >= 1 && j.some((x) => x.status === 'running' && x.stage === 'screening' && x.posDone >= 15); }, null, { timeout: 900000 });
  const before = await snap(page);
  const first = before.jobs.find((j) => j.status === 'done');
  const mid = before.jobs.find((j) => j.status === 'running');
  const p1 = await perf(page);
  ok(`${tag}: UI stays responsive during the batch`, p1.p99 < 200, JSON.stringify(p1));
  ok(`${tag}: first game analysed`, first.result && first.result.positions > 20, `${Math.round(first.result.ms / 1000)} s, ${first.result.positions} positions, ${first.result.verified} verified, ${first.result.moments} lessons, ${first.result.stable}/${first.result.moments} stable`);
  await page.locator('.batch-run details summary').click();
  await page.screenshot({ path: `${OUT}/${tag}-2-running.png` });
  // refresh mid-game
  await page.reload();
  await page.waitForSelector('.batch-run', { timeout: 60000 });
  await page.waitForFunction((id) => { const j = (window.__batch?.jobs ?? []).find((x) => x.id === id); return j && j.status === 'done'; }, mid.id, { timeout: 900000 });
  const after = await snap(page);
  const midAfter = after.jobs.find((j) => j.id === mid.id);
  const firstAfter = after.jobs.find((j) => j.id === first.id);
  ok(`${tag}: refresh resumes where it stopped`, midAfter.result.cached >= 15 && firstAfter.status === 'done' && firstAfter.result.ms === first.result.ms, `resumed game reused ${midAfter.result.cached} cached positions; first game not repeated`);
  // pause and resume
  await page.click('#b-pause');
  await page.waitForFunction(() => window.__batch && !window.__batch.running && window.__batch.meta.paused, null, { timeout: 30000 });
  const st = await page.locator('#b-status').innerText();
  ok(`${tag}: pause`, /^Paused after/.test(st), st);
  await page.click('#b-pause');
  await page.waitForFunction(() => window.__batch && window.__batch.running && !window.__batch.meta.paused, null, { timeout: 30000 });
  ok(`${tag}: resume`, true);
  if (tag === 'desktop') {
    // let it finish and show the summary
    await page.waitForSelector('.batch-done', { timeout: 1200000 });
    const all = await snap(page);
    const sum = await page.locator('.batch-done').innerText();
    ok(`${tag}: batch finished with a summary`, /games? analysed in/.test(sum), sum.replace(/\n+/g, ' | '));
    const per = all.jobs.filter((j) => j.status === 'done').map((j) => Math.round(j.result.ms / 1000));
    ok(`${tag}: time per game (Light, ${await page.evaluate(() => navigator.hardwareConcurrency)} cores)`, per.length >= 4, `${per.join(', ')} s; total ${Math.round((Date.now() - t0) / 1000)} s incl. refresh`);
    const pz = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('chess-review'); r.onsuccess = () => { const q = r.result.transaction('puzzles').objectStore('puzzles').getAll(); q.onsuccess = () => res(q.result.map((p) => ({ v: p.verify }))); }; }));
    ok(`${tag}: lessons saved with verification`, pz.length === all.jobs.reduce((s, j) => s + (j.result?.moments ?? 0), 0) && pz.every((p) => p.v && p.v.depth === 16), `${pz.length} puzzles for ${all.jobs.reduce((s, j) => s + (j.result?.moments ?? 0), 0)} lessons, depths ${[...new Set(pz.map((p) => p.v?.depth))].join("/")}, ${pz.filter((p) => p.v?.sameBest).length} with the same best move at both depths`);
    await page.waitForTimeout(800);
    const home = await page.locator('#home-panel').innerText();
    const saved = +((home.match(/(\d+) saved positions?/) ?? [])[1] ?? -1);
    ok(`${tag}: home panel counts the new positions`, saved === pz.length, `${saved} saved shown, ${pz.length} stored`);
    await page.screenshot({ path: `${OUT}/${tag}-3-done.png` });
    const p2 = await perf(page);
    ok(`${tag}: responsiveness over the whole batch`, p2.p99 < 200, JSON.stringify(p2));
  } else {
    await page.click('#b-cancel');
    await page.waitForFunction(() => window.__batch?.meta?.cancelled && !window.__batch.running, null, { timeout: 30000 });
    const c = await snap(page);
    ok(`${tag}: cancel`, c.jobs.some((j) => j.status === 'cancelled') && (await page.locator('#b-open').count()) === 1, c.jobs.map((j) => j.status).join(','));
  }
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  ok(`${tag}: no horizontal overflow`, ov <= 0, `${ov}px`);
  await ctx.close();
}
if (!ONLY || ONLY === 'phone') await run('phone', { width: 390, height: 844 }, true);
if (!ONLY || ONLY === 'desktop') await run('desktop', { width: 1400, height: 950 }, false);
ok('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
