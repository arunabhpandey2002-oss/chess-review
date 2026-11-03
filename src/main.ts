import { safeUrl } from './safe';
import 'chessground/assets/chessground.base.css';
import { describe, lineItems, movesFromUci, renderText } from './words';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './style.css';
import { Chessground } from 'chessground';
import type { Api as CgApi } from 'chessground/api';
import type { Key } from 'chessground/types';
import { Chess, type Color } from 'chess.js';
import { fetchArchives, fetchMonth, fetchProfile, resultFor, fmtTimeControl, REASONS, type GameSummary } from './api';
import { fetchLichessGames, fetchLichessGame, fetchLichessProfile } from './sources';
import { EnginePool, type PosEval } from './engine';
import { parseGame, reviewGame, summarize, terminalEval, fmtScore, decidedState, decidedWording, type Ply, type MoveReview, type Book } from './review';
import { openExplorer } from './explorer';
import { CLS_META, CLS_ORDER, winPct, type Cls } from './classify';
import { buildMoments, buildSummary, type Moment, type GameSummaryView } from './coach';
import { levelForRating, LEVEL_LABEL, type Level } from './moments';
import { MOTIF_INFO, SKILL_LABEL, ROLE_PHRASE } from './concepts';
import * as store from './store';
import type { Puzzle, StoredReview } from './store';
import { Trainer, releaseTrainerEngine } from './trainer';
import { openSparring } from './sparring';
import { originalFrom } from './original';
import { coachFor, saveReview } from './persist';
import { batch } from './batch';
import { renderWorkspace, destroyWorkspace, createWorkspace, lessonDoc } from './workspace';
import { renderBatchPanel } from './batch-ui';
import { cachedAtLeast, putCached, pruneCache } from './evalcache';
import { renderHomePanel, renderPuzzles, renderTrain, renderHistory, renderImport, renderData, destroyTrainer, recordAttempt, recordDiagnosis, newPuzzle, rememberGame, storedGame, SITE_LABEL, type Ctx, type Site } from './pages';
import { $, esc, cap, srcChip, applyMotionClass, reducedMotion, boardDescription, fmtWhen } from './ui';
import { isDue, srsStatus } from './srs';

const DEFAULT_USER = 'Arunabh-pandey';
const app = $('#app');
applyMotionClass();
window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', applyMotionClass);

// ---------------- state ----------------
const state = {
  user: '',
  site: 'chesscom' as Site,
  archives: [] as string[],
  loadedMonths: 0,
  exhausted: false,
  games: [] as GameSummary[],
  gamesById: new Map<string, GameSummary>(),
  profile: null as null | { username: string; name?: string; avatar?: string },
  rating: 0,
};
const pk = () => store.profileKey(state.site, state.user);
let book: Book | null = null;
const bookPromise = fetch(`${import.meta.env.BASE_URL}book.json`).then((r) => r.json()).then((b) => (book = b)).catch(() => null);

function params() {
  const p = new URLSearchParams(location.search);
  const site = (p.get('site') === 'lichess' ? 'lichess' : 'chesscom') as Site;
  return { user: p.get('user') || DEFAULT_USER, site, game: p.get('game'), view: p.get('view'), ply: p.get('ply'), p: p.get('p'), tag: p.get('tag'), ws: p.get('ws') };
}
function navigate(q: Record<string, string | null>, replace = false) {
  const p = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(q)) v == null ? p.delete(k) : p.set(k, v);
  if (q.view !== undefined && q.game === undefined && q.view) p.delete('game');
  if (q.game) p.delete('view');
  if (p.get('site') === 'chesscom') p.delete('site');
  const url = `${location.pathname}?${p.toString()}`;
  replace ? history.replaceState(null, '', url) : history.pushState(null, '', url);
  route();
}
window.addEventListener('popstate', () => route());

const levelOverride = (): Level | null => (localStorage.getItem('cr-level') as Level | null) || null;
const ctx: Ctx = {
  app,
  get site() { return state.site; },
  get user() { return state.user; },
  get pk() { return pk(); },
  navigate: (q) => navigate(q),
  level: (rating?: number) => levelOverride() ?? levelForRating(rating ?? (state.rating || null)),
  setLevel: (l) => { l ? localStorage.setItem('cr-level', l) : localStorage.removeItem('cr-level'); },
  levelOverride,
  refreshCounts: () => { void renderTabs(params().view ?? ''); },
};

// ---------------- header ----------------
async function renderTabs(active: string) {
  const el = $('#tabs');
  let due = 0;
  try { due = (await store.byProfile<Puzzle>('puzzles', pk())).filter((p) => isDue(p.srs, Date.now())).length; } catch { /* no IndexedDB */ }
  const tabs: [string, string][] = [['', 'Games'], ['puzzles', `Mistakes to Master${due ? ` <span class="badge-n" aria-label="${due} due">${due}</span>` : ''}`], ['history', 'History'], ['import', 'Import'], ['data', 'Your data']];
  el.innerHTML = tabs.map(([v, label]) => `<a href="?${new URLSearchParams({ user: state.user, ...(state.site === 'lichess' ? { site: 'lichess' } : {}), ...(v ? { view: v } : {}) })}" data-view="${v}" class="${active === v ? 'on' : ''}" ${active === v ? 'aria-current="page"' : ''}>${label}</a>`).join('');
  el.querySelectorAll<HTMLAnchorElement>('a').forEach((a) => (a.onclick = (e) => { e.preventDefault(); navigate({ view: a.dataset.view || null, game: null, p: null, tag: null, ply: null }); }));
}

function renderHeader() {
  const h = $('#user-chip');
  const u = state.profile?.username ?? state.user;
  h.innerHTML = `
    ${state.profile?.avatar ? `<img src="${esc(state.profile.avatar)}" alt="">` : `<span class="avatar-ph">${esc(u.slice(0, 1).toUpperCase())}</span>`}
    <span class="uname"><span class="un">${esc(u)}</span></span>
    <button class="link" id="change-user" title="Review another player's games">Change</button>`;
  $('#change-user').onclick = () => {
    h.innerHTML = `<form id="user-form"><select id="site-input" aria-label="Platform"><option value="chesscom" ${state.site === 'chesscom' ? 'selected' : ''}>Chess.com</option><option value="lichess" ${state.site === 'lichess' ? 'selected' : ''}>Lichess</option></select><input id="user-input" aria-label="Username" placeholder="Username" autocomplete="off" spellcheck="false" value="${esc(state.user)}"><button>Go</button></form>`;
    const inp = $<HTMLInputElement>('#user-input');
    inp.focus(); inp.select();
    $('#user-form').onsubmit = (e) => { e.preventDefault(); const v = inp.value.trim(); if (v) navigate({ user: v, site: $<HTMLSelectElement>('#site-input').value, game: null, view: null }); };
    h.addEventListener('focusout', () => setTimeout(() => { if (!h.contains(document.activeElement)) renderHeader(); }, 200));
  };
}

// ---------------- routing ----------------
let currentReview: ReviewView | null = null;
async function route() {
  const { user, site, game, view, ply, p, tag, ws } = params();
  if (user.toLowerCase() !== state.user.toLowerCase() || site !== state.site) {
    state.user = user; state.site = site; state.archives = []; state.loadedMonths = 0; state.exhausted = false; state.games = []; state.gamesById.clear(); state.profile = null; state.rating = 0;
    renderHeader();
    const prof = site === 'lichess' ? fetchLichessProfile(user) : fetchProfile(user);
    prof.then((pr) => { if (state.user === user) { state.profile = pr; renderHeader(); } }).catch(() => {});
    store.ensureProfile(site, user).catch(() => {});
    void bookPromise.then(() => batch.restore(pk(), book)).catch(() => {});
  }
  document.title = game ? 'Game Review · rook-i.e. mistakes' : `${state.user} · rook-i.e. mistakes`;
  renderTabs(game ? '' : view ?? '');
  if (!game || view) { currentReview?.destroy(); currentReview = null; }
  if (view !== 'train') destroyTrainer();
  if (view !== 'analysis') destroyWorkspace();
  try {
    if (view === 'puzzles') return await renderPuzzles(ctx, tag);
    if (view === 'train') return await renderTrain(ctx, p);
    if (view === 'history') return await renderHistory(ctx);
    if (view === 'import') return await renderImport(ctx);
    if (view === 'data') return await renderData(ctx);
    if (view === 'analysis') { document.title = 'Analysis · rook-i.e. mistakes'; return await renderWorkspace(app, pk(), ws ?? undefined, () => (history.length > 1 ? history.back() : navigate({ view: null, ws: null }))); }
  } catch (e) { app.innerHTML = `<div class="error">Something went wrong: ${esc(String((e as Error)?.message ?? e))}</div>`; return; }
  if (game) {
    if (currentReview && currentReview.game.id === game) { if (ply) currentReview.go(+ply); return; }
    currentReview?.destroy();
    currentReview = null;
    app.innerHTML = `<div class="loading">Loading game…</div>`;
    try {
      const g = await findGame(game);
      if (!g) { app.innerHTML = `<div class="error">Couldn't find that game for ${esc(state.user)}. <a href="#" id="back">Back to games</a></div>`; $('#back').onclick = (e) => { e.preventDefault(); navigate({ game: null }); }; return; }
      if (/\[Result "\*"\]/.test(g.game.pgn)) { app.innerHTML = `<div class="error">This game is still in progress. Only finished games are reviewed. <a href="#" id="back">Back to games</a></div>`; $('#back').onclick = (e) => { e.preventDefault(); navigate({ game: null }); }; return; }
      await bookPromise;
      currentReview = new ReviewView(g.game, state.user, g.myColor);
      if (ply) currentReview.go(+ply);
    } catch (e) {
      showError(e);
    }
  } else {
    renderGameList();
  }
}

function showError(e: unknown) {
  const msg = (e as Error)?.message === 'not-found' ? `No player called “${esc(state.user)}” was found.` : `Couldn't load games (${esc(String((e as Error)?.message ?? e))}).`;
  app.innerHTML = `<div class="error">${msg} <button class="btn" id="retry">Try again</button></div>`;
  $('#retry').onclick = () => { state.user = ''; route(); };
}

async function ensureArchives() {
  if (!state.archives.length) state.archives = await fetchArchives(state.user);
}
function addGames(games: GameSummary[]) {
  for (const g of games) if (!state.gamesById.has(g.id)) { state.gamesById.set(g.id, g); state.games.push(g); }
  state.games.sort((a, b) => b.endTime - a.endTime);
}
async function loadNextMonth(): Promise<boolean> {
  if (state.site === 'lichess') {
    if (state.exhausted) return false;
    const oldest = state.games.length ? state.games[state.games.length - 1].endTime * 1000 - 1 : undefined;
    const games = await fetchLichessGames(state.user, 30, oldest);
    state.loadedMonths++;
    if (games.length < 10) state.exhausted = true;
    addGames(games);
    return games.length > 0;
  }
  await ensureArchives();
  const idx = state.archives.length - 1 - state.loadedMonths;
  if (idx < 0) return false;
  const games = await fetchMonth(state.archives[idx]);
  state.loadedMonths++;
  addGames(games);
  return true;
}
const myColorIn = (g: GameSummary, user: string): Color => (g.black.username.toLowerCase() === user.toLowerCase() ? 'b' : 'w');

async function findGame(id: string): Promise<{ game: GameSummary; myColor: Color } | null> {
  const wrap = (g: GameSummary | null | undefined, c?: Color) => (g ? { game: g, myColor: c ?? myColorIn(g, state.user) } : null);
  if (state.gamesById.has(id)) return wrap(state.gamesById.get(id));
  try { const s = await storedGame(pk(), id); if (s) return wrap(s.game, s.myColor); } catch { /* no IndexedDB */ }
  if (id.startsWith('pgn-')) return null;
  if (id.startsWith('li-')) return wrap(await fetchLichessGame(id.slice(3)));
  if (state.site === 'lichess') return null;
  for (let tries = 0; tries < 24; tries++) {
    if (state.gamesById.has(id)) return wrap(state.gamesById.get(id));
    if (!(await loadNextMonth())) return null;
  }
  return wrap(state.gamesById.get(id));
}

// ---------------- game list ----------------
let homeOff: (() => void) | null = null;
async function renderGameList() {
  app.innerHTML = `
    <section class="games">
      <div id="home-panel"></div>
      <div id="batch-panel" class="batch-panel"></div>
      <div class="games-head"><h1>Recent games</h1><span class="muted" id="games-sub"></span></div>
      <div id="game-list" class="game-list"><div class="loading">Loading games…</div></div>
      <div class="more"><button class="btn" id="more" hidden>Load older games</button></div>
    </section>`;
  renderHomePanel($('#home-panel'), ctx).catch(() => { $('#home-panel').innerHTML = ''; });
  // Keep "Your training" in step with the batch: redraw it each time a game finishes.
  homeOff?.();
  let doneSeen = batch.snapshot().jobs.filter((j) => j.status === 'done').length;
  homeOff = batch.on(() => {
    const hp = document.getElementById('home-panel');
    if (!hp) { homeOff?.(); homeOff = null; return; }
    const d = batch.snapshot().jobs.filter((j) => j.status === 'done').length;
    if (d !== doneSeen) { doneSeen = d; renderHomePanel(hp, ctx).catch(() => {}); }
  });
  renderBatchPanel($('#batch-panel'), {
    pk: pk(), user: state.user, level: ctx.level(), rating: state.rating || null, games: () => state.games,
    loadMore: async () => { try { const more = await loadNextMonth(); drawGameList(); return more; } catch { return false; } },
    book: () => book, openGame: (id) => navigate({ game: id }), train: () => navigate({ view: 'train', p: null }),
  }).catch(() => { $('#batch-panel').innerHTML = ''; });
  try {
    if (!state.loadedMonths) {
      await loadNextMonth();
      while (state.site === 'chesscom' && state.games.length < 10 && (await loadNextMonth()));
    }
  } catch (e) { showError(e); return; }
  drawGameList();
}

function drawGameList() {
  const list = $('#game-list');
  if (!list) return;
  const u = state.user;
  if (!state.games.length) list.innerHTML = `<div class="empty">No finished standard games found for ${esc(u)}.</div>`;
  else list.innerHTML = state.games.map((g) => {
    const meWhite = g.white.username.toLowerCase() === u.toLowerCase();
    const me = meWhite ? g.white : g.black;
    const opp = meWhite ? g.black : g.white;
    const res = resultFor(g, u);
    const reason = REASONS[res === 'win' ? opp.result : me.result] ?? (res === 'win' ? opp.result : me.result);
    const moves = Math.ceil((g.pgn.match(/\s\d+\.\s/g)?.length ?? 0));
    const q = new URLSearchParams({ user: u, ...(state.site === 'lichess' ? { site: 'lichess' } : {}), game: g.id });
    return `<a class="game-row" href="?${q}" data-id="${esc(g.id)}">
      <span class="res res-${res}">${res === 'win' ? 'W' : res === 'loss' ? 'L' : '½'}</span>
      <span class="g-main">
        <span class="g-players"><span class="pc ${meWhite ? 'pw' : 'pb'}"></span><b>${esc(me.username)}</b> <span class="muted">${esc(String(me.rating))}</span> <span class="vs">vs</span> <span class="pc ${meWhite ? 'pb' : 'pw'}"></span><b>${esc(opp.username)}</b> <span class="muted">${esc(String(opp.rating))}</span></span>
        <span class="g-meta">${esc(g.opening || 'Unknown opening')}</span>
      </span>
      <span class="g-side">
        <span>${esc(cap(g.timeClass))} · ${esc(fmtTimeControl(g.timeControl, g.timeClass))}</span>
        <span class="muted">${new Date(g.endTime * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · ${moves} moves · ${esc(res === 'draw' ? 'draw by ' + reason : (res === 'win' ? 'won by ' : 'lost by ') + reason)}</span>
      </span>
      <span class="g-go">Review ›</span>
    </a>`;
  }).join('');
  list.querySelectorAll<HTMLAnchorElement>('.game-row').forEach((a) => a.onclick = (e) => { e.preventDefault(); navigate({ game: a.dataset.id! }); });
  const sub = $('#games-sub');
  if (sub) sub.textContent = state.site === 'lichess' ? `${state.games.length} games` : `${state.games.length} games · ${state.loadedMonths} of ${state.archives.length} months loaded`;
  const more = $<HTMLButtonElement>('#more');
  more.hidden = state.site === 'lichess' ? state.exhausted : state.loadedMonths >= state.archives.length;
  more.onclick = async () => {
    more.disabled = true; more.textContent = 'Loading…';
    try { await loadNextMonth(); } catch (e) { more.textContent = 'Failed, retry'; more.disabled = false; return; }
    more.disabled = false; more.textContent = 'Load older games';
    drawGameList();
  };
}

// ---------------- analysis cache ----------------
const WIN_TIP = "Estimated from the engine's evaluation using a standard win-chance formula; it reflects how good the position is, not real-world odds.";
const GRAPH_TIP = 'Evaluation over the game. Higher means White is better; dots mark inaccuracies (yellow), mistakes (orange) and blunders (red). Click to jump.';

function bestWords(rv: { fenBefore: string; bestPv: string[] }): string {
  const m = movesFromUci(rv.fenBefore, rv.bestPv, 1)[0];
  return m ? describe(m).imperative : '';
}

function lineHtml(fen: string, pv: string[], san: string, notation: boolean): string {
  if (notation) return `<span class="pv">${esc(san)}</span>`;
  const items = lineItems(fen, pv, 5);
  const more = pv.length > 5 ? '<li class="muted more">…</li>' : '';
  return `<ol class="pvw">${items.map((t) => `<li>${esc(t)}</li>`).join('')}${more}</ol>`;
}

const CACHE_V = 'cr1';
function cacheKey(id: string, depth: number) { return `${CACHE_V}:${id}:${depth}`; }
function loadCache(id: string, depth: number): (PosEval | null)[] | null {
  try { const s = localStorage.getItem(cacheKey(id, depth)); return s ? JSON.parse(s) : null; } catch { return null; }
}
function saveCache(id: string, depth: number, evals: (PosEval | null)[]) {
  const slim = evals.map((e) => e && { ...e, lines: e.lines.map((l) => ({ ...l, pv: l.pv.slice(0, 14) })) });
  const data = JSON.stringify(slim);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { localStorage.setItem(cacheKey(id, depth), data); return; } catch {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_V + ':'));
      keys.slice(0, Math.max(1, Math.ceil(keys.length / 2))).forEach((k) => localStorage.removeItem(k));
    }
  }
}

const legalCount = (fen: string) => { try { return new Chess(fen).moves().length; } catch { return 1; } };

// ---------------- review view ----------------
const DEPTHS: Record<string, { depth: number; label: string }> = {
  fast: { depth: 14, label: 'Fast · depth 14' },
  standard: { depth: 18, label: 'Standard · depth 18' },
  deep: { depth: 22, label: 'Deep · depth 22' },
};
let pool: EnginePool | null = null;

class ReviewView {
  game: GameSummary;
  user: string;
  plies: Ply[] = [];
  evals: (PosEval | null)[] = [];
  reviews: (MoveReview | null)[] = [];
  ply = 0;
  orientation: 'white' | 'black' = 'white';
  cg!: CgApi;
  depthKey = localStorage.getItem('cr-depth') || 'standard';
  notation = localStorage.getItem('cr-notation') === '1';
  done = 0;
  destroyed = false;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private raf = 0;
  private resizeObs?: ResizeObserver;

  me: Color;
  moments: Moment[] = [];
  coachSummary: GameSummaryView | null = null;
  coachKey = '';
  trainer: Trainer | null = null;
  puzzles = new Map<number, Puzzle>();

  constructor(game: GameSummary, user: string, me?: Color) {
    this.game = game;
    this.user = user;
    const parsed = parseGame(game.pgn);
    this.plies = parsed.plies;
    this.me = me ?? (game.black.username.toLowerCase() === user.toLowerCase() ? 'b' : 'w');
    this.orientation = this.me === 'b' ? 'black' : 'white';
    if (this.plies.length) state.rating = (this.me === 'w' ? game.white : game.black).rating || state.rating;
    this.render();
    this.ply = 0;
    this.startAnalysis();
    document.addEventListener('keydown', this.keyHandler);
  }

  get fens() { return [this.plies[0]?.fenBefore ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', ...this.plies.map((p) => p.fenAfter)]; }

  destroy() {
    this.destroyed = true;
    this.closeTrainer();
    document.removeEventListener('keydown', this.keyHandler);
    this.resizeObs?.disconnect();
    pool?.destroy();
    pool = null;
    void batch.hold(false);
    this.cg?.destroy();
  }

  render() {
    const g = this.game;
    const meWhite = this.me === 'w';
    const res = resultFor(g, (meWhite ? g.white : g.black).username);
    const reasonKey = res === 'win' ? (meWhite ? g.black.result : g.white.result) : (meWhite ? g.white.result : g.black.result);
    const resultStr = /1-0|0-1|1\/2-1\/2/.exec(g.pgn.match(/\[Result "([^"]+)"\]/)?.[1] ?? '')?.[0] ?? '';
    app.innerHTML = `
    <section class="review">
      <div class="review-top">
        <button class="btn ghost" id="back">‹ Games</button>
        <div class="title"><b>${esc(g.white.username)}</b> (${esc(String(g.white.rating))}) vs <b>${esc(g.black.username)}</b> (${esc(String(g.black.rating))}) <span class="muted">· ${esc(resultStr)} by ${esc(REASONS[reasonKey] ?? reasonKey)} · ${esc(cap(g.timeClass))} ${esc(fmtTimeControl(g.timeControl, g.timeClass))} · ${new Date(g.endTime * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span></div>
        <div class="top-actions">
          <select id="depth" title="Engine strength">${Object.entries(DEPTHS).map(([k, v]) => `<option value="${k}" ${k === this.depthKey ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
          ${safeUrl(g.url) ? `<a class="btn ghost" href="${esc(safeUrl(g.url))}" target="_blank" rel="noopener">Original game ↗</a>` : ''}
        </div>
      </div>
      <div id="coach" class="coach" aria-live="polite"></div>
      <h2 class="sr-only">Move-by-move review</h2>
      <div class="review-grid">
        <div class="board-col">
          <div class="player" id="p-top"></div>
          <div class="board-area">
            <div class="evalbar" id="evalbar"><div class="fill"></div><span class="evaltext"></span></div>
            <div class="board-wrap"><div id="board" class="cg-wrap-host" role="img" aria-label="Chess board"></div><div id="badge" class="badge" hidden></div></div>
          </div>
          <div class="player" id="p-bot"></div>
          <div class="sr-only" id="move-announce" aria-live="polite"></div>
          <div class="controls">
            <button class="ctl" id="c-first" title="Start (↑)">⏮</button>
            <button class="ctl" id="c-prev" title="Previous (←)">◀</button>
            <button class="ctl" id="c-next" title="Next (→)">▶</button>
            <button class="ctl" id="c-last" title="End (↓)">⏭</button>
            <button class="ctl" id="c-flip" title="Flip board (F)">⇅</button>
          </div>
        </div>
        <div class="side-col">
          <div class="progress" id="progress"><div class="bar"><div class="fill"></div></div><span class="ptext"></span></div>
          <div class="card movecard" id="movecard"></div>
          <div class="card graph-card"><svg id="graph" viewBox="0 0 600 120" preserveAspectRatio="none" aria-label="${GRAPH_TIP}"><title>${GRAPH_TIP}</title></svg><p class="graph-cap">${GRAPH_TIP}</p></div>
          <div class="card" id="summary"></div>
          <div class="card movelist" id="movelist"></div>
        </div>
      </div>
    </section>`;
    $('#back').onclick = () => navigate({ game: null });
    $<HTMLSelectElement>('#depth').onchange = (e) => {
      this.depthKey = (e.target as HTMLSelectElement).value;
      localStorage.setItem('cr-depth', this.depthKey);
      this.startAnalysis();
    };
    $('#c-first').onclick = () => this.go(0);
    $('#c-prev').onclick = () => this.go(this.ply - 1);
    $('#c-next').onclick = () => this.go(this.ply + 1);
    $('#c-last').onclick = () => this.go(this.plies.length);
    $('#c-flip').onclick = () => this.flip();
    $('#graph').addEventListener('click', (e) => {
      const svg = e.currentTarget as SVGSVGElement;
      const r = svg.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      this.go(Math.round(x * this.plies.length));
    });
    this.cg = Chessground($('#board'), {
      fen: this.fens[0], orientation: this.orientation, viewOnly: true, coordinates: true,
      animation: { enabled: !reducedMotion(), duration: 180 },
      drawable: { enabled: false, visible: true },
    });
    this.resizeObs = new ResizeObserver(() => this.cg.redrawAll());
    this.resizeObs.observe($('.board-wrap'));
    this.drawMoveList();
    this.update();
  }

  anaGen = 0;
  reused = 0;
  startAnalysis() {
    pool?.destroy();
    pool = null;
    const gen = ++this.anaGen;
    const depth = DEPTHS[this.depthKey]?.depth ?? 18;
    const fens = this.fens;
    const cached = loadCache(this.game.id, depth);
    this.evals = cached && cached.length === fens.length ? cached : fens.map((f) => terminalEval(f));
    this.done = this.evals.filter(Boolean).length;
    this.reused = 0;
    this.recompute();
    if (this.done === fens.length) { this.drawProgress(); return; }
    void this.fillFromBatch(gen, depth).then(() => { if (gen === this.anaGen && !this.destroyed) this.runEngine(gen, depth); });
  }

  /** Positions the background batch (or an earlier review) already analysed at least this deep are reused as they are;
   *  only the rest go to the engine. The coach and the "complete" state still wait for every position. */
  async fillFromBatch(gen: number, depth: number) {
    const fens = this.fens;
    const found = await Promise.all(fens.map((f, i) => (this.evals[i] ? null : cachedAtLeast(f, depth, 3, legalCount(f)).catch(() => null))));
    if (gen !== this.anaGen || this.destroyed) return;
    found.forEach((ev, i) => { if (ev && !this.evals[i]) { this.evals[i] = ev; this.done++; this.reused++; } });
    if (this.reused) this.scheduleRecompute();
  }

  runEngine(gen: number, depth: number) {
    const fens = this.fens;
    const finish = () => {
      saveCache(this.game.id, depth, this.evals);
      this.drawProgress();
    };
    if (this.done === fens.length) { finish(); return; }
    void batch.hold(true);
    const myPool = (pool = new EnginePool(EnginePool.defaultSize()));
    const t0 = performance.now();
    fens.forEach((fen, i) => {
      if (this.evals[i]) return;
      myPool.analyse(fen, depth, 3, depth >= 22 ? 15000 : 8000).then((ev) => {
        if (this.destroyed || pool !== myPool || gen !== this.anaGen) return;
        this.evals[i] = ev;
        this.done++;
        void putCached(fen, depth, 3, ev);
        if (this.done === fens.length) {
          finish();
          console.info(`analysis done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
          myPool.destroy();
          if (pool === myPool) pool = null;
          void batch.hold(false);
        }
        this.scheduleRecompute();
      }).catch(() => {});
    });
    this.drawProgress();
  }

  scheduleRecompute() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.recompute(); });
  }

  recompute() {
    this.reviews = reviewGame({ plies: this.plies, evals: this.evals, book });
    (window as any).__review = { plies: this.plies.map((p) => p.san), reviews: this.reviews, evals: this.evals, done: this.done, total: this.fens.length, reused: this.reused, go: (n: number) => this.go(n) };
    this.drawProgress();
    this.drawMoveList();
    this.drawGraph();
    this.drawSummary();
    this.drawCoach();
    this.update();
  }

  drawProgress() {
    const n = this.fens.length;
    const pct = Math.round((this.done / n) * 100);
    const el = $('#progress');
    if (!el) return;
    el.classList.toggle('complete', this.done >= n);
    $('.fill', el).style.width = pct + '%';
    const depth = DEPTHS[this.depthKey]?.depth ?? 18;
    $('.ptext', el).textContent = this.done >= n
      ? `Analysis complete · depth ${depth}${this.reused ? ` · ${this.reused} positions reused from earlier analysis` : ''}`
      : `Analysing… ${this.done}/${n} positions (${pct}%) · depth ${depth} · ${pool?.size ?? 1} thread${(pool?.size ?? 1) > 1 ? 's' : ''}`;
  }

  go(p: number) {
    this.ply = Math.max(0, Math.min(this.plies.length, p));
    this.update();
  }

  flip() {
    this.orientation = this.orientation === 'white' ? 'black' : 'white';
    this.cg.set({ orientation: this.orientation });
    this.update();
  }

  onKey(e: KeyboardEvent) {
    if (document.querySelector('.sp-overlay')) return; // the play-it-out dialog handles its own keys
    if (this.trainer) { if (e.key === 'Escape') this.closeTrainer(); return; }
    if (document.querySelector('.overlay')) return;
    const tg = (e.target as HTMLElement)?.tagName;
    if (tg === 'INPUT' || tg === 'SELECT' || tg === 'TEXTAREA' || tg === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
    if (e.key === 'ArrowLeft') this.go(this.ply - 1);
    else if (e.key === 'ArrowRight') this.go(this.ply + 1);
    else if (e.key === 'ArrowUp' || e.key === 'Home') this.go(0);
    else if (e.key === 'ArrowDown' || e.key === 'End') this.go(this.plies.length);
    else if (e.key === 'f' || e.key === 'F') this.flip();
    else return;
    e.preventDefault();
  }

  clockAt(color: 'w' | 'b'): string {
    for (let i = this.ply - 1; i >= 0; i--) if (this.plies[i].color === color) return this.plies[i].clock ?? '';
    return '';
  }

  update() {
    const k = this.ply;
    const fen = this.fens[k];
    const mv = k > 0 ? this.plies[k - 1] : null;
    const rv = k > 0 ? this.reviews[k - 1] : null;
    const shapes: { orig: Key; dest?: Key; brush: string }[] = [];
    if (mv && rv && rv.bestUci && !rv.isBestMove && rv.cls !== 'book' && rv.cls !== 'forced') {
      shapes.push({ orig: rv.bestUci.slice(0, 2) as Key, dest: rv.bestUci.slice(2, 4) as Key, brush: 'green' });
    }
    this.cg.set({
      fen, orientation: this.orientation, lastMove: mv ? [mv.from as Key, mv.to as Key] : undefined,
      check: mv && mv.san.includes('+') || mv?.san.includes('#') ? (fen.split(' ')[1] === 'w' ? 'white' : 'black') : false,
    });
    this.cg.setAutoShapes(shapes);
    $('#board').setAttribute('aria-label', boardDescription(fen));
    const ann = $('#move-announce');
    if (ann) ann.textContent = mv ? `${mv.moveNumber}${mv.color === 'w' ? '.' : '...'} ${mv.san}${rv ? `, ${CLS_META[rv.cls].label}` : ''}` : 'Starting position';
    // badge
    const badge = $('#badge');
    if (mv && rv) {
      const m = CLS_META[rv.cls];
      const f = mv.to.charCodeAt(0) - 97, r = +mv.to[1] - 1;
      const left = this.orientation === 'white' ? f : 7 - f;
      const top = this.orientation === 'white' ? 7 - r : r;
      badge.hidden = false;
      badge.style.left = `calc(${(left + 1) * 12.5}% - 2.1%)`;
      badge.style.top = `calc(${top * 12.5}% - 1.6%)`;
      badge.style.background = m.color;
      badge.style.color = m.fg;
      badge.textContent = m.icon;
      badge.title = m.label;
    } else badge.hidden = true;
    // players
    const g = this.game;
    const top = this.orientation === 'white' ? 'b' : 'w';
    const bot = top === 'w' ? 'b' : 'w';
    const pl = (c: 'w' | 'b') => {
      const p = c === 'w' ? g.white : g.black;
      const clk = this.clockAt(c);
      const toMove = fen.split(' ')[1] === c;
      return `<span class="pc ${c === 'w' ? 'pw' : 'pb'}"></span><b>${esc(p.username)}</b><span class="muted">${esc(String(p.rating))}</span>${clk ? `<span class="clock ${toMove ? 'active' : ''}">${esc(clk.replace(/^0:/, '').replace(/\.\d+$/, ''))}</span>` : ''}`;
    };
    $('#p-top').innerHTML = pl(top);
    $('#p-bot').innerHTML = pl(bot);
    // eval bar
    const ev = this.evals[k];
    const bar = $('#evalbar');
    bar.classList.toggle('flipped', this.orientation === 'black');
    if (ev && ev.lines.length) {
      const s = ev.lines[0].score;
      const wp = winPct(s, 'w');
      ($('.fill', bar) as HTMLElement).style.height = `${wp}%`;
      const t = $('.evaltext', bar);
      t.textContent = fmtScore(s).replace('−', '-').replace('+', '');
      t.className = `evaltext ${s.cp >= 0 ? 'w' : 'b'}`;
    } else {
      ($('.fill', bar) as HTMLElement).style.height = '50%';
      $('.evaltext', bar).textContent = '…';
    }
    this.drawMoveCard();
    // move list highlight
    document.querySelectorAll('.mv.cur').forEach((e) => e.classList.remove('cur'));
    const cur = document.querySelector(`.mv[data-ply="${k}"]`);
    if (cur) {
      cur.classList.add('cur');
      const list = $('#movelist');
      const cr = cur.getBoundingClientRect(), lr = list.getBoundingClientRect();
      if (cr.top < lr.top || cr.bottom > lr.bottom) list.scrollTop += cr.top - lr.top - lr.height / 2;
    }
    const gl = document.querySelector('#graph .cursor');
    if (gl) { const x = (k / Math.max(1, this.plies.length)) * 600; gl.setAttribute('x1', String(x)); gl.setAttribute('x2', String(x)); }
  }

  /** Keeps the move card's "Lines and win chance" section open while stepping through moves. */
  mcOpen = false;
  drawMoveCard() {
    const el = $('#movecard');
    const k = this.ply;
    if (k === 0) {
      const ev = this.evals[0];
      const best = ev?.lines[0];
      el.innerHTML = `<div class="mc-head"><span class="mc-title">Starting position</span></div>
        <p class="mc-ex">Use → or the buttons to step through the game. Each move gets a label, the engine's best move, and a short reason.</p>
        ${best ? `<div class="mc-row"><span class="k">Engine</span><span>${fmtScore(best.score)}</span></div>` : ''}`;
      return;
    }
    const mv = this.plies[k - 1];
    const rv = this.reviews[k - 1];
    const num = `${mv.moveNumber}${mv.color === 'w' ? '.' : '...'}`;
    if (!rv) {
      el.innerHTML = `<div class="mc-head"><span class="mc-title">${num}${esc(mv.san)}</span></div><p class="mc-ex muted">Analysing this move…</p>`;
      return;
    }
    const m = CLS_META[rv.cls];
    const showBest = !rv.isBestMove && rv.cls !== 'forced';
    const nt = this.notation;
    const mine = mv.color === this.me;
    const sideW = mv.color === 'w' ? 'White' : 'Black';
    const dw = decidedWording({ ...rv, decided: decidedState(rv.cls, rv.wpBefore, rv.wpAfter) }, mine, mv.color);
    const canExplore = rv.cls !== 'book' && rv.cls !== 'forced' && !!rv.bestUci && !!this.evals[k - 1];
    el.innerHTML = `
      <div class="mc-head">
        <span class="icon" style="background:${m.color};color:${m.fg}">${m.icon}</span>
        <span class="mc-title">${num}${esc(mv.san)} <span style="color:${m.color}">is ${rv.cls === 'book' ? 'a book move' : rv.cls === 'forced' ? 'forced' : rv.cls === 'miss' ? 'a miss' : (/^[aeiou]/.test(m.label.toLowerCase()) ? 'an ' : rv.cls === 'best' ? 'the ' : 'a ') + m.label.toLowerCase() + (rv.cls === 'best' ? ' move' : rv.cls === 'brilliant' || rv.cls === 'great' || rv.cls === 'excellent' || rv.cls === 'good' ? ' move' : '')}${dw ? dw.suffix : ''}</span></span>
        <span class="mc-eval">${fmtScore(rv.scoreAfter)}</span>
      </div>
      <p class="mc-who small muted" id="mc-who">${mine ? 'Your move' : 'Their move'} (${sideW}) · scored from ${sideW}'s side</p>
      <p class="mc-ex">${esc(renderText(rv.explanation, nt ? 'san' : 'words'))}</p>
      ${dw ? `<p class="mc-decided" id="mc-decided">${esc(dw.note)}</p>` : ''}
      ${showBest && rv.bestSan ? `<div class="mc-row"><span class="k">Best</span><span><span class="icon sm" style="background:${CLS_META.best.color}">★</span> ${nt ? `<b>${esc(rv.bestSan)}</b>` : `${esc(bestWords(rv))} (<b>${esc(rv.bestSan)}</b>)`} <span class="muted">(${fmtScore(this.evals[k - 1]?.lines[0]?.score)})</span></span></div>` : ''}
      <details class="disclose" id="mc-more"${this.mcOpen ? ' open' : ''}><summary>Lines and win chance</summary>
      ${rv.bestPvSan ? `<div class="mc-row"><span class="k">Best line</span>${lineHtml(rv.fenBefore, rv.bestPv, rv.bestPvSan, nt)}</div>` : ''}
      ${!rv.isBestMove && rv.playedPvSan ? `<div class="mc-row"><span class="k">After ${esc(mv.san)}</span>${lineHtml(rv.fenAfter, rv.playedPv, rv.playedPvSan, nt)}</div>` : ''}
      <div class="mc-row small muted"><span class="k">Win chance <span class="info" tabindex="0" data-tip="${WIN_TIP}" aria-label="${WIN_TIP}">i</span></span><span>${mv.color === 'w' ? 'White' : 'Black'}: ${rv.wpBefore.toFixed(0)}% → ${rv.wpAfter.toFixed(0)}%${rv.loss >= 0.5 ? ` (−${rv.loss.toFixed(1)})` : ''}</span></div>
      </details>
      <div class="mc-foot">${canExplore ? `<button class="btn small" id="mc-explore">${showBest && rv.bestSan ? `Why is ${esc(rv.bestSan)} best? Explore` : 'Explore this move'}</button>` : ''}<button class="linkbtn" id="nt-toggle">${nt ? 'Show plain English' : 'Show notation'}</button></div>`;
    const more = document.getElementById('mc-more') as HTMLDetailsElement | null;
    if (more) more.ontoggle = () => { this.mcOpen = more.open; };
    const ex = document.getElementById('mc-explore');
    if (ex) ex.onclick = () => openExplorer({ fen: rv.fenBefore, playedUci: mv.uci, label: `${num}${mv.san}`, me: this.me, before: this.evals[k - 1]!, after: this.evals[k] ?? null, orientation: this.orientation === 'black' ? 'b' : 'w' });
    $('#nt-toggle').onclick = () => {
      this.notation = !this.notation;
      localStorage.setItem('cr-notation', this.notation ? '1' : '0');
      this.drawMoveCard();
      this.renderCoach();
    };
  }

  drawMoveList() {
    const el = $('#movelist');
    if (!el) return;
    const rows: string[] = [];
    for (let i = 0; i < this.plies.length; i += 2) {
      const cell = (j: number) => {
        const p = this.plies[j];
        if (!p) return '<span class="mv empty"></span>';
        const r = this.reviews[j];
        const m = r ? CLS_META[r.cls] : null;
        return `<span class="mv" data-ply="${j + 1}" title="${m ? m.label : 'Analysing…'}">${m ? `<span class="icon sm" style="background:${m.color};color:${m.fg}">${m.icon}</span>` : '<span class="icon sm pending"></span>'}<span class="san" ${m && ['inaccuracy', 'mistake', 'miss', 'blunder', 'brilliant', 'great'].includes(r!.cls) ? `style="color:${m.color}"` : ''}>${esc(p.san)}</span></span>`;
      };
      rows.push(`<div class="mrow"><span class="num">${this.plies[i].moveNumber}.</span>${cell(i)}${cell(i + 1)}</div>`);
    }
    el.innerHTML = rows.join('') || '<div class="muted">No moves.</div>';
    el.querySelectorAll<HTMLElement>('.mv[data-ply]').forEach((m) => (m.onclick = () => this.go(+m.dataset.ply!)));
    const cur = el.querySelector(`.mv[data-ply="${this.ply}"]`);
    cur?.classList.add('cur');
  }

  drawGraph() {
    const svg = $('#graph') as unknown as SVGSVGElement;
    if (!svg) return;
    const n = Math.max(1, this.plies.length);
    const W = 600, H = 120;
    const pts = this.evals.map((e, i) => {
      const wp = e && e.lines.length ? winPct(e.lines[0].score, 'w') : null;
      return wp == null ? null : [(i / n) * W, H - (wp / 100) * H] as [number, number];
    });
    let d = '';
    let last: [number, number] | null = null;
    pts.forEach((p, i) => {
      const q = p ?? last ?? [(i / n) * W, H / 2];
      d += `${d ? 'L' : 'M'}${q[0].toFixed(1)},${q[1].toFixed(1)}`;
      last = q;
    });
    const area = `${d}L${W},${H}L0,${H}Z`;
    const dots = this.reviews.map((r, i) => {
      if (!r || !['blunder', 'mistake', 'miss', 'inaccuracy', 'brilliant', 'great'].includes(r.cls)) return '';
      const p = pts[i + 1];
      if (!p) return '';
      return `<circle cx="${p[0]}" cy="${p[1]}" r="4.2" fill="${CLS_META[r.cls].color}" stroke="#1d2027" stroke-width="1.2"><title>${this.plies[i].moveNumber}${this.plies[i].color === 'w' ? '.' : '...'}${esc(this.plies[i].san)}: ${CLS_META[r.cls].label}</title></circle>`;
    }).join('');
    const x = (this.ply / n) * W;
    svg.innerHTML = `<rect width="${W}" height="${H}" fill="#3a3d45"/><path d="${area}" fill="#e9e9ea"/><line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="#888" stroke-width="0.6" stroke-dasharray="3 3"/>
      <line class="cursor" x1="${x}" x2="${x}" y1="0" y2="${H}" stroke="#81b64c" stroke-width="2"/>${dots}`;
  }

  // ---------------- coach: summary, critical moments, retry ----------------
  get myRating() { return (this.me === 'w' ? this.game.white : this.game.black).rating; }
  get level(): Level { return levelOverride() ?? levelForRating(this.myRating || null); }

  drawCoach() {
    const el = $('#coach');
    if (!el) return;
    const n = this.fens.length;
    if (this.done < n) {
      el.innerHTML = `<div class="card coach-wait"><b>Coach summary</b> <span class="muted">appears when the analysis finishes (${Math.round((this.done / n) * 100)}%).</span></div>`;
      return;
    }
    const key = `${this.depthKey}|${this.level}`;
    if (this.coachKey !== key) {
      this.coachKey = key;
      const c = coachFor(this.game, this.me, this.plies, this.evals, this.reviews, this.level);
      this.moments = c.moments;
      this.coachSummary = c.summary;
      this.persist().then(() => this.renderCoach()).catch((e) => {
        console.warn('could not save review', e); this.renderCoach();
        const pt = $('#progress .ptext');
        if (pt && (e as DOMException)?.name === 'QuotaExceededError') pt.textContent += ' · not saved: browser storage is full (free space in Your data)';
      });
    }
    this.renderCoach();
  }

  async persist() {
    const saved = await saveReview(pk(), this.game, this.me, this.plies, this.evals, this.reviews, this.moments, this.coachSummary!, this.myRating || null,
      { analysis: { mode: 'full', depth: DEPTHS[this.depthKey]?.depth ?? 18 } });
    for (const [k, p] of saved) this.puzzles.set(k, p);
    renderTabs('');
  }

  /** Reload this game's saved positions from storage, so the moments list shows what the counter counts. */
  async refreshPuzzles() {
    const key = pk();
    for (const m of this.moments) {
      try { const p = await store.get<Puzzle>('puzzles', `${key}|${this.game.id}|${m.ply}`); if (p) this.puzzles.set(m.ply, p); } catch { /* no IndexedDB */ }
    }
  }

  renderCoach() {
    const el = $('#coach');
    const s = this.coachSummary;
    if (!el || !s) return;
    const nt = this.notation;
    const seen = new Set<string>(); // gloss each move once per card
    const T = (t: string) => esc(renderText(t, nt ? 'san' : 'words', seen));
    const lvl = this.level;
    const phaseRow = s.phases.filter((p) => p.moves).map((p) => `<li><b>${cap(p.phase)}</b>: ${esc(p.label)}${p.accuracy != null ? ` <span class="muted">(accuracy ${p.accuracy.toFixed(0)}, ${p.moves} moves${p.mistakes + p.blunders ? `, ${p.mistakes + p.blunders} error${p.mistakes + p.blunders > 1 ? 's' : ''}` : ''})</span>` : ''}</li>`).join('');
    // status comes from the same saved spaced-review state the Mistakes to Master counter counts
    const now = Date.now();
    const statusOf = (m: Moment) => {
      const p = this.puzzles.get(m.ply);
      const h = p?.srs.history ?? [];
      if (!p || !h.length) return '<span class="st st-new">Not tried</span>';
      const last = h[h.length - 1];
      const st = srsStatus(p.srs, now);
      const when = st === 'mastered' ? ' · mastered' : st === 'due' ? ' · due now' : ` · next ${fmtWhen(p.srs.due, now)}`;
      return last.solved ? `<span class="st st-scheduled">✓ Solved${last.hints ? ` with ${last.hints} hint${last.hints > 1 ? 's' : ''}` : ''}${when}</span>` : `<span class="st st-due">Not solved yet${when}</span>`;
    };
    const dueHere = this.moments.filter((m) => { const p = this.puzzles.get(m.ply); return !p || isDue(p.srs, now); }).length;
    el.innerHTML = `
      <div class="card coach-card">
        <div class="coach-head">
          <h2>Game summary</h2>
          <label class="lvl">Explanations for <select id="lvl" aria-label="Explanation level">${(Object.keys(LEVEL_LABEL) as Level[]).map((l) => `<option value="${l}" ${l === lvl ? 'selected' : ''}>${esc(LEVEL_LABEL[l])}</option>`).join('')}</select></label>
        </div>
        <p class="story">${s.story.map(T).join(' ')}</p>
        <dl class="coach-facts">
          ${s.turning ? `<div><dt>Turning point</dt><dd>${T(s.turning)}</dd></div>` : ''}
          ${s.strongest ? `<div><dt>Strongest decision</dt><dd>${T(s.strongest)}</dd></div>` : ''}
          ${s.improvement ? `<div><dt>Main improvement</dt><dd>${T(s.improvement)}</dd></div>` : ''}
        </dl>
        <div class="action"><b>Do this next:</b> ${T(s.action)}</div>
        <details class="disclose"><summary>Phases and time</summary>
          <dl class="coach-facts">
            <div><dt>By phase</dt><dd><ul class="phases">${phaseRow}</ul></dd></div>
            <div><dt>Time</dt><dd>${s.time.map(esc).join(' ')}</dd></div>
          </dl>
        </details>
        <div class="src-note">Sources:${srcChip('rules')}${srcChip('estimate')}</div>
      </div>
      <div class="moments">
        <h2>Critical moments</h2>${this.moments.length ? `<p class="muted small sub">${this.moments.length} position${this.moments.length > 1 ? 's' : ''} saved to Mistakes to Master · <span id="moments-due">${dueHere ? `${dueHere} to train now` : 'all trained for now'}</span></p>` : ''}
        ${this.moments.length ? `<div class="moment-list">${this.moments.map((m, i) => {
          const cm = CLS_META[m.cls as Cls] ?? CLS_META.mistake;
          const t = m.tags.primary;
          return `<div class="moment" data-i="${i}">
            <div class="mini" data-fen="${esc(m.fenBefore)}" data-color="${m.color}" data-last="${esc(m.prevUci ?? '')}"></div>
            <div class="m-body">
              <div class="m-title"><span class="icon sm" style="background:${cm.color};color:${cm.fg}" aria-hidden="true">${cm.icon}</span> <b>Move ${m.moveNumber}</b> <span class="muted">${cm.label} · ${esc(m.phase)}</span></div>
              <div>${esc(cap(ROLE_PHRASE[t.id] ?? MOTIF_INFO[t.motif].name))}</div>
              <div class="m-tags">${esc(MOTIF_INFO[t.motif].name)} · ${esc(SKILL_LABEL[t.skill])} · ${statusOf(m)}</div>
              <div class="m-act"><button class="btn${i === 0 ? ' primary' : ''}" data-retry="${i}">Retry position</button><button class="btn" data-play="${i}">Play it out</button><button class="btn ghost" data-show="${m.ply}">Show in game</button></div>
            </div></div>`;
        }).join('')}</div>` : `<p class="muted">No critical moments for you in this game: no move of yours lost a clear, teachable amount in a position that was still undecided.</p>`}
      </div>`;
    (window as any).__coach = { moments: this.moments.length, summary: true, played: this.moments.map((m) => m.playedSan) };
    el.querySelectorAll<HTMLElement>('.mini').forEach((m) => Chessground(m, { fen: m.dataset.fen!, orientation: m.dataset.color === 'w' ? 'white' : 'black', viewOnly: true, coordinates: false, animation: { enabled: false }, lastMove: m.dataset.last ? [m.dataset.last.slice(0, 2) as Key, m.dataset.last.slice(2, 4) as Key] : undefined, drawable: { enabled: false, visible: false } }));
    $<HTMLSelectElement>('#lvl', el).onchange = (e) => { ctx.setLevel((e.target as HTMLSelectElement).value as Level); this.drawCoach(); };
    el.querySelectorAll<HTMLButtonElement>('[data-retry]').forEach((b) => (b.onclick = () => this.openTrainer(+b.dataset.retry!)));
    el.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((b) => (b.onclick = () => {
      const m = this.moments[+b.dataset.play!];
      if (m) openSparring({ core: m, rating: this.myRating, level: this.level, title: `Play it out · move ${m.moveNumber}`, ...this.replayLink(m) });
    }));
    el.querySelectorAll<HTMLButtonElement>('[data-show]').forEach((b) => (b.onclick = () => { this.go(+b.dataset.show! + 1); $('#board').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' }); }));
  }

  /** Links a play-out to this game: its own continuation (for "Compare with original") and where to save. */
  replayLink(m: Moment) {
    const key = pk();
    return { original: originalFrom(this.plies, this.evals, m.fenBefore, m.playedUci), profileKey: key, sourceId: `${key}|${this.game.id}|${m.ply}` };
  }

  openTrainer(i: number) {
    this.closeTrainer();
    const m = this.moments[i];
    if (!m) return;
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', `Retry move ${m.moveNumber}`);
    ov.innerHTML = '<div class="overlay-inner"></div>';
    document.body.appendChild(ov);
    document.body.classList.add('modal-open');
    const g = this.game;
    this.trainer = new Trainer(ov.firstElementChild as HTMLElement, {
      core: m, level: this.level,
      title: `Critical moment ${i + 1} of ${this.moments.length} · move ${m.moveNumber}`,
      subtitle: `${g.white.username} vs ${g.black.username}`,
      onResult: async (r) => {
        const p = this.puzzles.get(m.ply);
        if (p) this.puzzles.set(m.ply, await recordAttempt(p, r));
        // a miss can bring back mastered positions, so reload this game's positions, then redraw the list and the counter together
        await this.refreshPuzzles();
        this.renderCoach();
        renderTabs('');
      },
      onClose: () => this.closeTrainer(),
      closeLabel: 'Back to review',
      rating: this.myRating,
      prior: this.puzzles.get(m.ply)?.diagnosis,
      onDiagnosis: async (d) => {
        const p = this.puzzles.get(m.ply);
        if (p) this.puzzles.set(m.ply, await recordDiagnosis(p, d));
      },
      replay: this.replayLink(m),
      onAnalyse: async (mm) => { const id = await createWorkspace(pk(), lessonDoc(mm, mm.color, `${g.white.username} vs ${g.black.username} · move ${mm.moveNumber}`)); this.closeTrainer(); navigate({ view: 'analysis', ws: id }); },
      onNext: () => (i + 1 < this.moments.length ? this.openTrainer(i + 1) : this.closeTrainer()),
      nextLabel: i + 1 < this.moments.length ? 'Next moment' : 'Back to review',
    });
    (ov.querySelector('#tr-input') as HTMLElement | null)?.focus({ preventScroll: true });
    (window as any).__trainer = this.trainer;
  }

  closeTrainer() {
    if (!this.trainer) return;
    this.trainer.destroy();
    this.trainer = null;
    releaseTrainerEngine();
    document.querySelector('.overlay:not(.sp-overlay)')?.remove();
    if (!document.querySelector('.overlay')) document.body.classList.remove('modal-open');
    if (!this.destroyed) this.renderCoach();
  }

  drawSummary() {
    const el = $('#summary');
    if (!el) return;
    const s = summarize(this.plies, this.evals, this.reviews);
    const complete = this.done >= this.fens.length;
    const g = this.game;
    const acc = (a: number | null) => (a == null ? '–' : a.toFixed(1));
    const shown: Cls[] = CLS_ORDER;
    el.innerHTML = `
      <div class="sum-head">
        <div class="acc"><span class="pc pw"></span><span class="name">${esc(g.white.username)}</span><span class="accv">${acc(s.accW)}</span><span class="muted small">accuracy</span></div>
        <div class="acc"><span class="pc pb"></span><span class="name">${esc(g.black.username)}</span><span class="accv">${acc(s.accB)}</span><span class="muted small">accuracy</span></div>
      </div>
      ${complete ? '' : '<div class="muted small center">Partial — still analysing</div>'}
      <table class="counts">${shown.map((c) => {
        const w = s.counts.w[c] ?? 0, b = s.counts.b[c] ?? 0;
        const m = CLS_META[c];
        return `<tr data-cls="${c}" class="${w + b ? '' : 'zero'}"><td class="cw">${w}</td><td class="cl"><span class="icon sm" style="background:${m.color};color:${m.fg}">${m.icon}</span>${m.label}</td><td class="cb">${b}</td></tr>`;
      }).join('')}</table>`;
    el.querySelectorAll<HTMLElement>('tr[data-cls]').forEach((tr) => tr.onclick = () => {
      // jump to the next move with this class
      const c = tr.dataset.cls;
      for (let j = 1; j <= this.reviews.length; j++) {
        const idx = (this.ply + j - 1) % this.reviews.length;
        if (this.reviews[idx]?.cls === c) { this.go(idx + 1); return; }
      }
    });
  }
}

// boot
const { user } = params();
void releaseTrainerEngine;
if (!new URLSearchParams(location.search).get('user')) history.replaceState(null, '', `${location.pathname}?user=${encodeURIComponent(user)}${location.search.includes('game=') ? '&' + location.search.slice(1) : ''}`);
route();
// once per visit, when idle: keep the engine cache bounded (no-op unless it is over its cap)
setTimeout(() => { void pruneCache(); }, 4000);
