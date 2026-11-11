// Welcome screen: no default player, remember last user, Change account, ?user= links.
import { chromium } from '@playwright/test';
const BASE = process.env.BASE || 'http://localhost:4173/';
const USER = 'demo-player';
const OUT = 'shots-welcome';

const game = {
  url: 'https://www.chess.com/game/live/1',
  pgn: '[Event "Live"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0',
  white: { username: USER, rating: 1500, result: 'win' },
  black: { username: 'opp', rating: 1480, result: 'checkmated' },
  time_class: 'rapid',
  time_control: '600',
  end_time: 1700000000,
  rated: true,
  rules: 'chess',
};

async function mockChess(page, { missing = false, empty = false } = {}) {
  await page.route('https://api.chess.com/**', (r) => {
    const u = r.request().url();
    if (missing) return r.fulfill({ status: 404, json: { message: 'Not found' } });
    if (u.includes('/games/archives')) {
      return r.fulfill({ json: { archives: empty ? [] : [`https://api.chess.com/pub/player/${USER}/games/2026/01`] } });
    }
    if (u.includes('/games/2026/01')) return r.fulfill({ json: { games: [game] } });
    if (/\/player\/[^/]+$/.test(new URL(u).pathname) || /\/player\/[^/]+\?/.test(u)) {
      return r.fulfill({ json: { username: USER, url: `https://www.chess.com/member/${USER}` } });
    }
    return r.fulfill({ status: 404, json: {} });
  });
}

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== '' ? ' — ' + info : ''}`); };

for (const [tag, viewport, mobile] of [['desktop', { width: 1280, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mockChess(page);

  // 1. Fresh browser at root shows welcome; player tabs are hidden
  await page.goto(BASE);
  await page.waitForSelector('#welcome');
  check(`${tag}: welcome at root with no remembered player`, /Review your games/.test(await page.locator('#welcome h1').innerText()));
  check(`${tag}: Load games and PGN option present`, (await page.locator('#welcome-go').count()) === 1 && (await page.locator('#welcome-import').count()) === 1);
  check(`${tag}: Games / Practice / History tabs hidden`, (await page.locator('#tabs a[data-view=""]').count()) === 0 && (await page.locator('#tabs a[data-view="practice"]').count()) === 0 && (await page.locator('#tabs a[data-view="history"]').count()) === 0);
  check(`${tag}: Openings still available`, (await page.locator('#tabs a[data-view="openings"]').count()) === 1);
  check(`${tag}: no profile chip yet`, (await page.locator('#user-chip .un').count()) === 0);
  await page.screenshot({ path: `${OUT}/${tag}-1-welcome.png` });

  // empty submit
  await page.click('#welcome-go');
  check(`${tag}: empty username is rejected`, /Enter a username/.test(await page.locator('#welcome-msg').innerText()));

  // error: unknown player
  await mockChess(page, { missing: true });
  await page.fill('#welcome-user', 'no-such-user');
  await page.click('#welcome-go');
  await page.waitForFunction(() => /No player called/.test(document.querySelector('#welcome-msg')?.textContent ?? ''));
  check(`${tag}: unknown player shows a friendly error`, /No player called/.test(await page.locator('#welcome-msg').innerText()));
  await page.screenshot({ path: `${OUT}/${tag}-2-error.png` });

  // 2. Entering a username loads games
  await mockChess(page);
  await page.fill('#welcome-user', USER);
  await page.click('#welcome-go');
  await page.waitForSelector('.game-row', { timeout: 15000 });
  check(`${tag}: Load games opens the game list`, (await page.locator('.game-row').count()) >= 1);
  check(`${tag}: URL has ?user=`, new URL(page.url()).searchParams.get('user') === USER, page.url());
  check(`${tag}: profile shows the username`, (await page.locator('#user-chip .un').innerText()) === USER);
  check(`${tag}: Games tab is visible`, (await page.locator('#tabs a[data-view=""]').count()) === 1);

  // 3. Reload at root returns to that player
  await page.goto(BASE);
  await page.waitForSelector('.game-row, #welcome');
  check(`${tag}: reload at root reopens the remembered player`, (await page.locator('.game-row').count()) >= 1 && (await page.locator('#welcome').count()) === 0, page.url());

  // 4. Change account returns to welcome
  await page.click('#settings-btn');
  await page.click('[data-set="account"]');
  await page.waitForSelector('#welcome');
  check(`${tag}: Change account returns to welcome`, (await page.locator('#welcome').count()) === 1 && (await page.locator('.game-row').count()) === 0);

  // 5. Direct ?user= link works
  await page.goto(BASE + `?user=${USER}`);
  await page.waitForSelector('.game-row', { timeout: 15000 });
  check(`${tag}: ?user= link loads that player directly`, (await page.locator('.game-row').count()) >= 1 && (await page.locator('#user-chip .un').innerText()) === USER);

  check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
