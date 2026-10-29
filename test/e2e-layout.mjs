// Layout QA: every main screen at 5 widths, both board orientations (a White and a Black game).
// Fails on horizontal page scroll, elements spilling out of their parent or the viewport, and clipped text.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173/';
const OUT = process.env.OUT || 'shots-qa/after';
const SHOTS = process.env.SHOTS !== '0';
mkdirSync(OUT, { recursive: true });
const VIEWS = [[1440, 900], [1280, 800], [768, 1024], [390, 844], [360, 780]];
const GAMES = { white: { id: '186132691608', ply: 31 }, black: { id: '186131916376', ply: 14 } };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const UA = (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
const problems = [], errors = [];
let checks = 0;

/** Runs in the page: returns a list of layout problems inside `root`. */
function audit(rootSel) {
  const out = [];
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) out.push(`page scrolls sideways (${de.scrollWidth} > ${de.clientWidth})`);
  const root = document.querySelector(rootSel) || document.body;
  const vw = de.clientWidth;
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : '');
  const scrollable = (e) => { const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowX); };
  for (const e of root.querySelectorAll('*')) {
    if (e.closest('cg-board, cg-container, svg, .sr-only, coords, .mini, [hidden]')) continue;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const s = getComputedStyle(e);
    if (s.visibility === 'hidden' || s.position === 'fixed') continue;
    let inScroll = false;
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) if (scrollable(a) && !a.classList.contains('overlay')) { inScroll = true; break; }
    if (!inScroll && (r.right > vw + 1 || r.left < -1)) out.push(`${name(e)} outside the viewport (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`);
    const p = e.parentElement;
    if (p && !inScroll && s.position !== 'absolute' && !scrollable(p) && p !== document.body) {
      const pr = p.getBoundingClientRect();
      if (r.right > pr.right + 2 || r.left < pr.left - 2) out.push(`${name(e)} spills out of ${name(p)} by ${Math.round(Math.max(r.right - pr.right, pr.left - r.left))}px`);
    }
    // clipped text (not an intentional ellipsis)
    if (e.children.length === 0 && e.textContent.trim() && s.overflowX === 'hidden' && s.textOverflow !== 'ellipsis' && e.scrollWidth > e.clientWidth + 1) out.push(`${name(e)} text is clipped`);
    if (e.children.length === 0 && e.textContent.trim() && !e.closest('.info, .evaltext') && parseFloat(s.fontSize) < 10) out.push(`${name(e)} text is ${s.fontSize}`);
  }
  return [...new Set(out)].slice(0, 25);
}

async function check(page, tag, rootSel = 'body') {
  await page.waitForTimeout(250);
  checks++;
  const res = await page.evaluate(audit, rootSel);
  for (const r of res) problems.push(`${tag}: ${r}`);
  console.log(`${res.length ? 'FAIL' : 'PASS'} ${tag}${res.length ? '\n   ' + res.join('\n   ') : ''}`);
  if (SHOTS) await page.screenshot({ path: `${OUT}/${tag}.png` });
}
const closeOverlays = async (page) => { while (await page.locator('.overlay').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); } };

// pages without a game
{
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  for (const [w, h] of VIEWS) {
    await page.setViewportSize({ width: w, height: h });
    for (const v of ['', 'puzzles', 'history', 'import', 'data']) {
      await page.goto(`${BASE}?user=Arunabh-pandey${v ? '&view=' + v : ''}`);
      await page.waitForSelector(v ? 'main .page, main .card, main h1' : '.game-row', { timeout: 60000 });
      await check(page, `${w}-${v || 'home'}`);
    }
  }
  await ctx.close();
}

for (const [side, g] of Object.entries(GAMES)) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}?user=Arunabh-pandey&game=${g.id}`);
  await page.waitForSelector('.progress.complete', { timeout: 900000 });
  await page.waitForFunction(() => window.__coach && window.__coach.played, null, { timeout: 60000 }).catch(() => {});
  await page.waitForSelector('[data-retry="0"]', { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => localStorage.setItem('cr-notation', '0'));
  for (const [w, h] of VIEWS) {
    await page.setViewportSize({ width: w, height: h });
    const t = `${w}-${side}`;
    await page.evaluate((p) => window.__review.go(p), g.ply);
    await page.waitForSelector('#mc-explore');
    await page.evaluate(() => window.scrollTo(0, 0));
    await check(page, `${t}-review`);
    await page.locator('.movelist').scrollIntoViewIfNeeded();
    if (SHOTS) await page.screenshot({ path: `${OUT}/${t}-review-lower.png` });
    await page.click('#mc-explore');
    await page.waitForSelector('.ex-overlay cg-board');
    await check(page, `${t}-explore`, '.ex-overlay');
    await page.click('[data-q="mine"], [data-q="threat"]');
    await page.click('[data-line="best"]');
    await page.click('#ex-next');
    await check(page, `${t}-explore-step`, '.ex-overlay');
    await closeOverlays(page);
    if (await page.locator('[data-retry="0"]').count()) {
      await page.locator('[data-retry="0"]').click();
      await page.waitForSelector('.overlay .trainer');
      await check(page, `${t}-retry`, '.overlay');
      await page.click('#tr-reveal');
      await page.waitForSelector('.why-card, .tr-lesson:not([hidden]) .lsec');
      await check(page, `${t}-why`, '.overlay');
      await closeOverlays(page);
      await page.locator('[data-play="0"]').click();
      await page.waitForSelector('.sp-overlay cg-board');
      await check(page, `${t}-playout`, '.sp-overlay');
      await closeOverlays(page);
    }
  }
  await ctx.close();
}
await browser.close();
writeFileSync(`${OUT}/layout-report.json`, JSON.stringify({ checks, problems, errors }, null, 1));
console.log(`\n${checks} screens checked, ${problems.length} problems, ${errors.length} page errors`);
if (errors.length) console.log(errors.join('\n'));
process.exit(problems.length || errors.length ? 1 : 0);
