// Header: long usernames stay on-screen (ellipsis if needed), gear stays clickable, no horizontal clip.
import { chromium } from '@playwright/test';
const BASE = process.env.BASE || 'http://localhost:4173/';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== '' ? ' — ' + info : ''}`); };

const cases = [
  ['arunabh-pandey', 1280, false],
  ['arunabh-pandey', 1100, false],
  ['arunabh-pandey', 1024, false],
  ['minimal-ui-shots', 1024, false],
  ['arunabh-pandey', 390, true],
  ['minimal-ui-shots', 390, true],
  ['arunabh-pandey-extra-long-username', 1024, false],
  ['arunabh-pandey-extra-long-username', 390, true],
];

for (const [user, w, mobile] of cases) {
  const ctx = await browser.newContext({ viewport: { width: w, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://api.chess.com/**', (r) => r.fulfill({ json: { archives: [] } }));
  await page.goto(`${BASE}?user=${encodeURIComponent(user)}&view=practice`);
  await page.waitForSelector('#settings-btn');
  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const gear = document.getElementById('settings-btn');
    const chip = document.getElementById('user-chip');
    const un = chip.querySelector('.un');
    const outside = (el) => { const r = el.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1 || r.width < 4; };
    return {
      ox: de.scrollWidth - de.clientWidth,
      gearOut: outside(gear),
      chipOut: outside(chip),
      unOut: outside(un),
      title: document.querySelector('.uname')?.getAttribute('title') || '',
      text: un.textContent,
      ellipsis: un.scrollWidth > un.clientWidth + 1,
      intentionalEllipsis: getComputedStyle(un).textOverflow === 'ellipsis',
    };
  });
  const tag = `${user.slice(0, 18)}@${w}`;
  check(`${tag}: no page horizontal scroll`, m.ox <= 1, m.ox);
  check(`${tag}: gear fully in viewport`, !m.gearOut);
  check(`${tag}: profile chip fully in viewport`, !m.chipOut && !m.unOut);
  check(`${tag}: full name available via title`, m.title === user, m.title);
  // If text is shorter than the DOM string visually, it must be via ellipsis — never mid-glyph viewport clip
  if (m.ellipsis) check(`${tag}: tight space uses ellipsis (not viewport clip)`, m.intentionalEllipsis);
  await page.click('#settings-btn');
  check(`${tag}: gear opens the settings menu`, (await page.locator('#settings-menu:not([hidden])').count()) === 1);
  const menuIn = await page.evaluate(() => {
    const m = document.getElementById('settings-menu');
    const r = m.getBoundingClientRect();
    return r.left >= -2 && r.right <= innerWidth + 2 && r.width > 80;
  });
  check(`${tag}: settings menu stays on-screen`, menuIn);
  await page.keyboard.press('Escape');
  check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
