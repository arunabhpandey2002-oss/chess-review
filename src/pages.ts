// Home training panel, Mistakes to Master, training session, history, import and data pages.
import { Chessground } from 'chessground';
import type { Key } from 'chessground/types';
import * as store from './store';
import type { Puzzle, StoredReview, StoredGame } from './store';
import { schedule, reactivate, isDue, srsStatus, newSrs } from './srs';
import { topCauses, type Diagnosis } from './diagnose';
import { recurringErrors, topInsight, confidenceNote, tagPhrase, MIN_GAMES_FOR_INSIGHT } from './insights';
import { MOTIF_INFO, SKILL_LABEL } from './concepts';
import { LEVEL_LABEL, type Level } from './moments';
import { Trainer, releaseTrainerEngine, type TrainResult } from './trainer';
import { importPgn } from './sources';
import { $, esc, fmtDate, fmtWhen, applyMotionClass, reducedMotion } from './ui';
import type { GameSummary } from './api';

export type Site = 'chesscom' | 'lichess';
export interface Ctx {
  app: HTMLElement;
  site: Site;
  user: string;
  pk: string;
  navigate: (q: Record<string, string | null>) => void;
  level: (rating?: number) => Level;
  setLevel: (l: Level | null) => void;
  levelOverride: () => Level | null;
}

export const SITE_LABEL: Record<string, string> = { chesscom: 'Chess.com', lichess: 'Lichess', pgn: 'PGN' };

// ---------------- SRS application ----------------
export async function recordAttempt(p: Puzzle, r: TrainResult): Promise<Puzzle> {
  const now = Date.now();
  const fresh = (await store.get<Puzzle>('puzzles', p.id)) ?? p;
  const next: Puzzle = { ...fresh, srs: schedule(fresh.srs, r, now) };
  await store.put('puzzles', next);
  const failed = next.srs.history[next.srs.history.length - 1].quality < 3;
  if (failed) {
    // the weakness is back: return mastered puzzles with the same tag to the queue
    const tag = p.core.tags.primary.id;
    for (const q of await store.byProfile<Puzzle>('puzzles', p.profileKey)) {
      if (q.id !== p.id && q.srs.retired && q.core.tags.primary.id === tag) await store.put('puzzles', { ...q, srs: reactivate(q.srs, now) });
    }
  }
  return next;
}

/** Save the answer to "what were you thinking" on the puzzle. */
export async function recordDiagnosis(p: Puzzle, d: Diagnosis): Promise<Puzzle> {
  const fresh = (await store.get<Puzzle>('puzzles', p.id)) ?? p;
  const next: Puzzle = { ...fresh, diagnosis: d };
  await store.put('puzzles', next);
  return next;
}

export function puzzleTitle(p: Puzzle): string {
  return `Move ${p.core.moveNumber} · ${p.core.color === 'w' ? 'White' : 'Black'} to play`;
}
export function puzzleSub(p: Puzzle): string {
  return `${p.white} vs ${p.black} · ${SITE_LABEL[p.platform] ?? p.platform} · ${fmtDate(p.endTime)}`;
}

export function miniBoard(el: HTMLElement, fen: string, color: 'w' | 'b', lastUci?: string) {
  Chessground(el, {
    fen, orientation: color === 'w' ? 'white' : 'black', viewOnly: true, coordinates: false,
    animation: { enabled: false }, lastMove: lastUci ? [lastUci.slice(0, 2) as Key, lastUci.slice(2, 4) as Key] : undefined,
    drawable: { enabled: false, visible: false },
  });
}

const sortQueue = (ps: Puzzle[], now: number) => ps.slice().sort((a, b) => {
  const da = isDue(a.srs, now) ? 0 : 1, db = isDue(b.srs, now) ? 0 : 1;
  return da - db || a.srs.due - b.srs.due || b.createdAt - a.createdAt;
});

// ---------------- home panel ----------------
export async function renderHomePanel(el: HTMLElement, ctx: Ctx) {
  const now = Date.now();
  const [puzzles, reviews] = await Promise.all([store.byProfile<Puzzle>('puzzles', ctx.pk), store.byProfile<StoredReview>('reviews', ctx.pk)]);
  const due = sortQueue(puzzles.filter((p) => isDue(p.srs, now)), now);
  const insight = topInsight(reviews);
  const mastered = puzzles.filter((p) => p.srs.retired).length;
  const diags = puzzles.flatMap((p) => (p.diagnosis ? [p.diagnosis] : []));
  const causes = topCauses(diags);
  if (!puzzles.length && !reviews.length) {
    el.innerHTML = `<div class="card home-card"><h2>Your training</h2><p>Open any game below. When the review finishes you get a short summary, up to three positions to retry, and those positions are saved as your own puzzles for spaced review.</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="card home-card">
      <div class="home-head">
        <div><h2>Your training</h2><p class="muted">${puzzles.length} saved position${puzzles.length === 1 ? '' : 's'} · ${mastered} mastered · ${reviews.length} game${reviews.length === 1 ? '' : 's'} reviewed</p></div>
        <div class="due-big" aria-label="${due.length} positions due"><span class="n">${due.length}</span><span>due now</span></div>
      </div>
      ${due.length ? `<div class="due-row">${due.slice(0, 2).map((p) => `<button class="due-pos" data-id="${esc(p.id)}" aria-label="Train ${esc(puzzleTitle(p))}"><div class="mini" data-fen="${esc(p.core.fenBefore)}" data-color="${p.core.color}"></div><span><b>${esc(MOTIF_INFO[p.core.tags.primary.motif].name)}</b><br><span class="muted small">${esc(puzzleTitle(p))}</span></span></button>`).join('')}</div>
        <button class="btn primary" id="start-due">Train ${due.length} due position${due.length === 1 ? '' : 's'}</button>`
        : `<p>Nothing is due. ${puzzles.length ? `Next review ${fmtWhen(Math.min(...puzzles.filter((p) => !p.srs.retired).map((p) => p.srs.due).concat([Infinity])), now)}.` : ''}</p>`}
      ${insight ? `<div class="insight"><b>Pattern:</b> ${esc(insight.text)} <span class="muted small">${esc(insight.note)}</span> <span class="src src-estimate" title="Counted from your reviewed games">Estimate</span></div>`
        : reviews.length < MIN_GAMES_FOR_INSIGHT ? `<p class="muted small">Review ${MIN_GAMES_FOR_INSIGHT - reviews.length} more game${MIN_GAMES_FOR_INSIGHT - reviews.length === 1 ? '' : 's'} to see your recurring patterns.</p>` : ''}
      ${causes.length ? `<div class="insight" id="why-causes"><b>Why you go wrong:</b> ${causes.map((c) => `${esc(c.label)} (${c.n})`).join(' · ')} <span class="muted small">from ${diags.length} answer${diags.length === 1 ? '' : 's'}</span> <span class="src src-estimate" title="Counted from your answers, checked against the board">Estimate</span></div>` : ''}
    </div>`;
  el.querySelectorAll<HTMLElement>('.mini').forEach((m) => miniBoard(m, m.dataset.fen!, m.dataset.color as 'w' | 'b'));
  el.querySelectorAll<HTMLButtonElement>('.due-pos').forEach((b) => (b.onclick = () => ctx.navigate({ view: 'train', p: b.dataset.id! })));
  const sd = $('#start-due', el);
  if (sd) sd.onclick = () => ctx.navigate({ view: 'train', p: null });
}

// ---------------- Mistakes to Master ----------------
export async function renderPuzzles(ctx: Ctx, filter: string | null) {
  const now = Date.now();
  const all = await store.byProfile<Puzzle>('puzzles', ctx.pk);
  const tags = new Map<string, number>();
  for (const p of all) tags.set(p.core.tags.primary.motif, (tags.get(p.core.tags.primary.motif) ?? 0) + 1);
  const list = sortQueue(all.filter((p) => !filter || p.core.tags.primary.motif === filter), now);
  const due = all.filter((p) => isDue(p.srs, now)).length;
  ctx.app.innerHTML = `
    <section class="page puzzles">
      <div class="page-head"><h1>Mistakes to Master</h1>
        <button class="btn primary" id="train" ${due ? '' : 'disabled'}>${due ? `Train ${due} due` : 'Nothing due'}</button></div>
      <p class="muted">Positions from your own games where a better move existed. Solve them on first try and they come back less often; after four clean solves at a 3-week interval they count as mastered. Miss one and it comes back in 10 minutes.</p>
      ${tags.size ? `<div class="filters" role="group" aria-label="Filter by pattern"><button class="chip ${filter ? '' : 'on'}" data-f="">All (${all.length})</button>${[...tags.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `<button class="chip ${filter === t ? 'on' : ''}" data-f="${t}">${esc(MOTIF_INFO[t as keyof typeof MOTIF_INFO]?.name ?? t)} (${n})</button>`).join('')}</div>` : ''}
      <div class="pz-list">${list.length ? list.map((p) => {
        const st = srsStatus(p.srs, now);
        const last = p.srs.history[p.srs.history.length - 1];
        return `<div class="pz-row" data-id="${esc(p.id)}">
          <div class="mini" data-fen="${esc(p.core.fenBefore)}" data-color="${p.core.color}"></div>
          <div class="pz-main">
            <div><b>${esc(MOTIF_INFO[p.core.tags.primary.motif].name)}</b> <span class="tag">${esc(SKILL_LABEL[p.core.tags.primary.skill])}</span> <span class="st st-${st}">${st === 'due' ? 'Due' : st === 'new' ? 'New' : st === 'mastered' ? 'Mastered' : st === 'learning' ? `Retry ${fmtWhen(p.srs.due, now)}` : `Next ${fmtWhen(p.srs.due, now)}`}</span></div>
            <div class="muted small">${esc(puzzleTitle(p))} · ${esc(puzzleSub(p))}${p.gameUrl ? ` · <a href="${esc(p.gameUrl)}" target="_blank" rel="noopener">source game ↗</a>` : ''}</div>
            <div class="muted small">${p.srs.history.length ? `${p.srs.history.length} attempt${p.srs.history.length === 1 ? '' : 's'} · last: ${last.solved ? `solved${last.hints ? ` with ${last.hints} hint${last.hints > 1 ? 's' : ''}` : ''}${last.attempts > 1 ? ` in ${last.attempts} tries` : ''}` : 'not solved'}${last.failure ? ` (${last.failure === 'calculation' ? 'calculation slip' : 'pattern not yet recognised'})` : ''}` : 'Not tried yet'}</div>
          </div>
          <div class="pz-act"><button class="btn" data-train="${esc(p.id)}">Train</button><button class="btn ghost" data-game="${esc(p.gameId)}" data-ply="${p.core.ply + 1}">Open game</button></div>
        </div>`;
      }).join('') : `<div class="empty">No saved positions yet. Review a game and its critical moments are saved here automatically.</div>`}</div>
    </section>`;
  ctx.app.querySelectorAll<HTMLElement>('.mini').forEach((m) => miniBoard(m, m.dataset.fen!, m.dataset.color as 'w' | 'b'));
  ctx.app.querySelectorAll<HTMLButtonElement>('.chip[data-f]').forEach((b) => (b.onclick = () => ctx.navigate({ view: 'puzzles', tag: b.dataset.f || null })));
  ctx.app.querySelectorAll<HTMLButtonElement>('[data-train]').forEach((b) => (b.onclick = () => ctx.navigate({ view: 'train', p: b.dataset.train! })));
  ctx.app.querySelectorAll<HTMLButtonElement>('[data-game]').forEach((b) => (b.onclick = () => ctx.navigate({ view: null, game: b.dataset.game!, ply: b.dataset.ply! })));
  const tr = $<HTMLButtonElement>('#train');
  if (tr) tr.onclick = () => ctx.navigate({ view: 'train', p: null });
}

// ---------------- training session ----------------
let trainer: Trainer | null = null;
export function destroyTrainer() { trainer?.destroy(); trainer = null; releaseTrainerEngine(); }

export async function renderTrain(ctx: Ctx, onlyId: string | null) {
  destroyTrainer();
  const now = Date.now();
  const all = await store.byProfile<Puzzle>('puzzles', ctx.pk);
  const queue = onlyId ? all.filter((p) => p.id === onlyId) : sortQueue(all.filter((p) => isDue(p.srs, now)), now);
  let i = 0, solved = 0;
  ctx.app.innerHTML = `<section class="page train"><div class="page-head"><h1>${onlyId ? 'Train position' : 'Due review'}</h1><span class="muted" id="train-count"></span></div><div id="train-host"></div></section>`;
  const host = $('#train-host');
  const show = () => {
    trainer?.destroy();
    if (i >= queue.length) {
      host.innerHTML = `<div class="card done-card"><h2>${queue.length ? 'Session complete' : 'Nothing due right now'}</h2>
        ${queue.length ? `<p>You solved ${solved} of ${queue.length}. Missed positions come back in 10 minutes; solved ones are scheduled further out.</p>` : '<p>Come back later, or review another game to add positions.</p>'}
        <button class="btn primary" id="to-list">Mistakes to Master</button> <button class="btn ghost" id="to-games">Games</button></div>`;
      $('#to-list').onclick = () => ctx.navigate({ view: 'puzzles', p: null });
      $('#to-games').onclick = () => ctx.navigate({ view: null, p: null });
      return;
    }
    const p = queue[i];
    $('#train-count').textContent = queue.length > 1 ? `${i + 1} of ${queue.length}` : '';
    trainer = new Trainer(host, {
      core: p.core, level: ctx.level(),
      title: puzzleTitle(p), subtitle: puzzleSub(p),
      onResult: async (r) => { if (r.solved) solved++; await recordAttempt(p, r); },
      rating: p.rating, prior: p.diagnosis, onDiagnosis: async (d) => { await recordDiagnosis(p, d); },
      onNext: () => { i++; show(); }, nextLabel: i + 1 < queue.length ? 'Next position' : 'Finish',
      onClose: () => ctx.navigate({ view: 'puzzles', p: null }), closeLabel: 'Stop',
    });
  };
  show();
}

// ---------------- history ----------------
export async function renderHistory(ctx: Ctx) {
  const reviews = (await store.byProfile<StoredReview>('reviews', ctx.pk)).sort((a, b) => b.endTime - a.endTime);
  const stats = recurringErrors(reviews);
  const n = Math.min(reviews.length, 20);
  ctx.app.innerHTML = `
    <section class="page history">
      <div class="page-head"><h1>Review history</h1><span class="muted">${reviews.length} game${reviews.length === 1 ? '' : 's'} reviewed</span></div>
      <div class="card">
        <h2>Recurring errors <span class="src src-estimate">Estimate</span></h2>
        ${stats.length ? `<p class="muted small">${esc(confidenceNote(n))} Counted once per game, across your last ${n} reviewed game${n === 1 ? '' : 's'}.</p>
          <table class="rec"><thead><tr><th>Pattern</th><th>Games</th><th class="barcol"></th></tr></thead><tbody>${stats.slice(0, 8).map((s) => `<tr><td>${esc(cap1(s.phrase))}</td><td>${s.games} of ${s.of}</td><td class="barcol"><span class="bar" style="width:${Math.round(s.share * 100)}%"></span></td></tr>`).join('')}</tbody></table>`
          : `<p class="muted">${reviews.length ? 'No recurring tactical errors found yet.' : 'Review some games to see which mistakes repeat.'}</p>`}
      </div>
      <div class="hist-list">${reviews.map((r) => `<a class="game-row" href="#" data-game="${esc(r.gameId)}">
          <span class="res res-${r.result}">${r.result === 'win' ? 'W' : r.result === 'loss' ? 'L' : '½'}</span>
          <span class="g-main"><span class="g-players"><b>${esc(r.white)}</b> <span class="vs">vs</span> <b>${esc(r.black)}</b></span><span class="g-meta">${esc(r.opening || '')} · ${esc(SITE_LABEL[r.platform] ?? r.platform)} · ${fmtDate(r.endTime)}${r.accuracy != null ? ` · accuracy ${r.accuracy.toFixed(0)}` : ''}</span>
          <span class="g-meta">${r.moments.length ? r.moments.map((m) => esc(tagPhrase(m.tag))).join(' · ') : 'No critical moments'}</span></span>
          <span class="g-go">Open ›</span></a>`).join('')}</div>
    </section>`;
  ctx.app.querySelectorAll<HTMLAnchorElement>('[data-game]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); ctx.navigate({ view: null, game: a.dataset.game! }); }));
}
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------- import ----------------
export async function renderImport(ctx: Ctx) {
  const games = (await store.byProfile<StoredGame>('games', ctx.pk)).filter((g) => g.game.platform === 'pgn').sort((a, b) => b.savedAt - a.savedAt);
  ctx.app.innerHTML = `
    <section class="page import">
      <div class="page-head"><h1>Import games</h1></div>
      <div class="import-grid">
        <form class="card" id="f-cc"><h2>Chess.com</h2><label for="cc-user">Username</label><input id="cc-user" required spellcheck="false" autocomplete="off" value="${ctx.site === 'chesscom' ? esc(ctx.user) : ''}"><button class="btn primary">Load games</button><p class="muted small">Public archive API; finished games only.</p></form>
        <form class="card" id="f-li"><h2>Lichess</h2><label for="li-user">Username</label><input id="li-user" required spellcheck="false" autocomplete="off" value="${ctx.site === 'lichess' ? esc(ctx.user) : ''}"><button class="btn primary">Load games</button><p class="muted small">Public game export; finished standard games only. Lichess's own engine evaluations are not used.</p></form>
        <form class="card wide" id="f-pgn"><h2>Paste or upload PGN</h2>
          <label for="pgn-text">PGN (one or more games)</label><textarea id="pgn-text" rows="7" spellcheck="false" placeholder='[Event "..."]&#10;1. e4 e5 2. Nf3 ...  1-0'></textarea>
          <div class="row"><label class="filebtn btn ghost">Upload .pgn<input type="file" id="pgn-file" accept=".pgn,.txt,application/x-chess-pgn" hidden></label>
          <label for="pgn-side">I played</label><select id="pgn-side"><option value="auto">Detect from my username (${esc(ctx.user)})</option><option value="w">White</option><option value="b">Black</option></select>
          <button class="btn primary">Import</button></div>
          <div id="pgn-msg" role="status" aria-live="polite"></div>
          <p class="muted small">Games without a result (still in progress) are not analysed.</p>
        </form>
      </div>
      ${games.length ? `<h2>Imported PGN games</h2><div class="hist-list">${games.map((g) => `<a class="game-row" href="#" data-game="${esc(g.game.id)}"><span class="res">PGN</span><span class="g-main"><span class="g-players"><b>${esc(g.game.white.username)}</b> <span class="vs">vs</span> <b>${esc(g.game.black.username)}</b></span><span class="g-meta">${fmtDate(g.game.endTime)} · you played ${g.myColor === 'b' ? 'Black' : 'White'}</span></span><span class="g-go">Review ›</span></a>`).join('')}</div>` : ''}
    </section>`;
  $('#f-cc').onsubmit = (e) => { e.preventDefault(); const v = $<HTMLInputElement>('#cc-user').value.trim(); if (v) ctx.navigate({ site: 'chesscom', user: v, view: null, game: null }); };
  $('#f-li').onsubmit = (e) => { e.preventDefault(); const v = $<HTMLInputElement>('#li-user').value.trim(); if (v) ctx.navigate({ site: 'lichess', user: v, view: null, game: null }); };
  $<HTMLInputElement>('#pgn-file').onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) $<HTMLTextAreaElement>('#pgn-text').value = await f.text();
  };
  $('#f-pgn').onsubmit = async (e) => {
    e.preventDefault();
    const msg = $('#pgn-msg');
    const { ok, errors } = importPgn($<HTMLTextAreaElement>('#pgn-text').value);
    const side = $<HTMLSelectElement>('#pgn-side').value;
    for (const g of ok) {
      const me = side === 'w' || side === 'b' ? side : g.black.username.toLowerCase() === ctx.user.toLowerCase() ? 'b' : 'w';
      await store.put<StoredGame>('games', { key: `${ctx.pk}|${g.id}`, profileKey: ctx.pk, game: g, myColor: me, savedAt: Date.now() });
    }
    msg.innerHTML = `${ok.length ? `Imported ${ok.length} game${ok.length > 1 ? 's' : ''}.` : ''} ${errors.map(esc).join(' ')}`;
    if (ok.length === 1) ctx.navigate({ view: null, game: ok[0].id });
    else if (ok.length) setTimeout(() => renderImport(ctx), 600);
  };
  ctx.app.querySelectorAll<HTMLAnchorElement>('[data-game]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); ctx.navigate({ view: null, game: a.dataset.game! }); }));
}

export async function storedGame(pk: string, id: string): Promise<StoredGame | undefined> {
  return store.get<StoredGame>('games', `${pk}|${id}`);
}
export async function rememberGame(pk: string, g: GameSummary, myColor: 'w' | 'b') {
  const old = await storedGame(pk, g.id);
  if (!old) await store.put<StoredGame>('games', { key: `${pk}|${g.id}`, profileKey: pk, game: g, myColor, savedAt: Date.now() });
}

// ---------------- your data ----------------
export async function renderData(ctx: Ctx) {
  const b = await store.exportAll();
  const motion = localStorage.getItem('cr-motion') ?? 'system';
  const lvl = ctx.levelOverride();
  ctx.app.innerHTML = `
    <section class="page data">
      <div class="page-head"><h1>Your data & settings</h1></div>
      <div class="card"><h2>What leaves your device</h2>
        <p>Only requests to the public Chess.com and Lichess APIs to download your games. Engine analysis runs in your browser. Reviews, puzzles and progress are stored only in this browser (IndexedDB). There are no accounts, no tracking and no server-side copy.</p>
        <p class="muted small">Stored here: ${b.profiles.length} profile${b.profiles.length === 1 ? '' : 's'}, ${b.reviews.length} reviewed game${b.reviews.length === 1 ? '' : 's'}, ${b.puzzles.length} saved position${b.puzzles.length === 1 ? '' : 's'}.</p>
        <div class="row"><button class="btn" id="exp">Export JSON</button><label class="btn ghost filebtn">Import JSON<input type="file" id="imp" accept=".json,application/json" hidden></label><button class="btn danger" id="del">Delete all data</button></div>
        <div id="data-msg" role="status" aria-live="polite"></div>
      </div>
      <div class="card"><h2>Settings</h2>
        <label for="set-level">Explanation level</label>
        <select id="set-level"><option value="">Automatic (from your rating)</option>${(Object.keys(LEVEL_LABEL) as Level[]).map((l) => `<option value="${l}" ${lvl === l ? 'selected' : ''}>${esc(LEVEL_LABEL[l])}</option>`).join('')}</select>
        <label for="set-motion">Animations</label>
        <select id="set-motion"><option value="system" ${motion === 'system' ? 'selected' : ''}>Follow system setting${reducedMotion() && motion === 'system' ? ' (reduced)' : ''}</option><option value="reduce" ${motion === 'reduce' ? 'selected' : ''}>Reduce motion</option><option value="full" ${motion === 'full' ? 'selected' : ''}>Full animations</option></select>
      </div>
    </section>`;
  const msg = $('#data-msg');
  $('#exp').onclick = async () => {
    const data = JSON.stringify(await store.exportAll(), null, 1);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = `chess-review-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    msg.textContent = 'Backup downloaded.';
  };
  $<HTMLInputElement>('#imp').onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try { const n = await store.importAll(JSON.parse(await f.text())); msg.textContent = `Imported ${n.reviews} reviews and ${n.puzzles} positions.`; setTimeout(() => renderData(ctx), 800); }
    catch (err) { msg.textContent = (err as Error).message || 'Could not read that file.'; }
  };
  $('#del').onclick = async () => {
    if (!confirm('Delete all reviews, saved positions and progress stored in this browser? This cannot be undone (export a backup first if you want one).')) return;
    await store.deleteAll();
    msg.textContent = 'All local data deleted.';
    setTimeout(() => renderData(ctx), 600);
  };
  $<HTMLSelectElement>('#set-level').onchange = (e) => ctx.setLevel(((e.target as HTMLSelectElement).value || null) as Level | null);
  $<HTMLSelectElement>('#set-motion').onchange = (e) => { const v = (e.target as HTMLSelectElement).value; v === 'system' ? localStorage.removeItem('cr-motion') : localStorage.setItem('cr-motion', v); applyMotionClass(); };
}

export function newPuzzle(o: Omit<Puzzle, 'srs' | 'createdAt'>): Puzzle {
  const now = Date.now();
  return { ...o, srs: newSrs(now), createdAt: now };
}
