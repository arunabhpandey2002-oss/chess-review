// Openings: a library of opening families you meet, each with its main named variations and a sound reply line for
// each; practice that branches on the opponent's choices (weighted by how often each is played, spaced repetition per
// variation); and which variations you face most in your own games.
import { Chess } from 'chess.js';
import { Chessground } from 'chessground';
import type { Api as CgApi } from 'chessground/api';
import type { Key } from 'chessground/types';
import * as store from './store';
import type { StoredGame } from './store';
import type { GameSummary } from './api';
import { resultFor } from './api';
import type { Book } from './review';
import { newSrs, schedule, srsStatus, isDue, type SrsState } from './srs';
import { describeMove } from './lastmove';
import { $, esc, fmtWhen, reducedMotion, boardDescription, legalDests, parseTyped } from './ui';
import { openingName, loadOpenings, explore, type OpeningData } from './openings';
import { EnginePool, type PosEval } from './engine';
import { ROUND_PLIES, LOSS, VERDICT_LABEL, lineMoves, lineReplies, sideMoves, leftLine, pickRandomOpening, randomResult, pickAppMove, bookCandidates, sanOf, fmtEval, reviewRow, summarize, roundResult, reachedVariation, markLineBook, type MoveCheck, type ReviewRow } from './defend';
import { OPENINGS, FAMILIES, REPERTOIRE, openingById, familyById, familyOf, variationsOf, variationWeights, pickVariation, moveText, moveLabel, judgeMove, wrongText, facedStats, progressKey, type RepEntry, type RepFamily, type OpeningProgress, type FacedRow, type GameLike } from './repertoire';
import type { Ctx } from './pages';

export interface OpeningsCtx extends Ctx { games: () => GameSummary[]; book: () => Promise<Book | null>; loadGames: () => Promise<void> }

const STATUS_LABEL: Record<ReturnType<typeof srsStatus>, string> = { new: 'Not practised', due: 'Due', learning: 'Learning', scheduled: 'Learning', mastered: 'Mastered' };
const sideWord = (s: 'w' | 'b') => (s === 'w' ? 'White' : 'Black');

export type Mode = 'play' | 'defend' | 'random';
/** Progress is kept per side: "Play the opening" under the variation's id, "Defend against it" under id|defend,
 *  Random-opening rounds (you're Black, White's opening is a surprise) under id|random. */
const progId = (id: string, mode: Mode) => (mode === 'play' ? id : `${id}|${mode}`);
/** White openings for Random mode: the lines where you're Black. */
const RANDOM_POOL = () => OPENINGS.filter((o) => o.side === 'b');
const other = (s: 'w' | 'b'): 'w' | 'b' => (s === 'w' ? 'b' : 'w');

async function loadProgress(pk: string, mode: Mode = 'play'): Promise<Map<string, OpeningProgress>> {
  const m = new Map<string, OpeningProgress>();
  for (const o of OPENINGS) {
    try { const p = await store.get<OpeningProgress>('meta', progressKey(pk, progId(o.id, mode))); if (p?.srs) m.set(o.id, p); } catch { /* no IndexedDB */ }
  }
  return m;
}

function statusOf(p: OpeningProgress | undefined, now: number) {
  if (!p) return { cls: 'new', text: STATUS_LABEL.new };
  const s = srsStatus(p.srs, now);
  const when = s === 'scheduled' || s === 'learning' ? ` · next ${fmtWhen(p.srs.due, now)}` : '';
  const runs = p.srs.history.length;
  return { cls: s, text: `${STATUS_LABEL[s]}${when}${runs ? ` · ${runs} run${runs === 1 ? '' : 's'}` : ''}` };
}

/** Your games (stored + loaded this visit), each with your colour and result. */
async function myGames(ctx: OpeningsCtx): Promise<GameLike[]> {
  const out: GameLike[] = [];
  const user = ctx.user.toLowerCase();
  const add = (g: GameSummary, mc?: 'w' | 'b') => {
    const myColor = mc ?? (g.black.username.toLowerCase() === user ? 'b' : g.white.username.toLowerCase() === user ? 'w' : null);
    if (!myColor || !g.pgn) return;
    const me = myColor === 'w' ? g.white : g.black;
    out.push({ id: g.id, pgn: g.pgn, myColor, result: resultFor(g, me.username) });
  };
  try { for (const s of await store.byProfile<StoredGame>('games', ctx.pk)) add(s.game, s.myColor); } catch { /* no IndexedDB */ }
  for (const g of ctx.games()) add(g);
  return out;
}

// ---------------- library ----------------
const pctText = (x: number) => (x >= 0.995 ? '100%' : x < 0.01 ? '<1%' : `${Math.round(x * 100)}%`);

function familyStatus(f: RepFamily, prog: Map<string, OpeningProgress>, now: number) {
  const vs = f.variations;
  const mastered = vs.filter((id) => { const p = prog.get(id); return p && srsStatus(p.srs, now) === 'mastered'; }).length;
  const due = vs.filter((id) => { const p = prog.get(id); return p && isDue(p.srs, now); }).length;
  const tried = vs.filter((id) => prog.get(id)).length;
  if (due) return { cls: 'due', text: `${due} due · ${mastered} of ${vs.length} mastered` };
  if (!tried) return { cls: 'new', text: `Not practised · ${vs.length} variation${vs.length === 1 ? '' : 's'}` };
  return { cls: mastered === vs.length ? 'mastered' : 'learning', text: `${mastered} of ${vs.length} mastered · ${tried} practised` };
}

export async function renderOpenings(ctx: OpeningsCtx, id: string | null, mode: Mode = 'play') {
  destroyDrill();
  if (id === 'random') return renderRandom(ctx);
  const fam = familyById(id);
  if (fam) return renderDrill(ctx, fam, null, true, mode);
  const entry = openingById(id);
  if (entry) return renderDrill(ctx, familyOf(entry), entry, false, mode);
  document.title = 'Openings · rook-i.e. mistakes';
  const now = Date.now();
  const prog = await loadProgress(ctx.pk);
  const dprog = await loadProgress(ctx.pk, 'defend');
  const due = OPENINGS.filter((o) => { const p = prog.get(o.id); return p && isDue(p.srs, now); });
  const ddue = OPENINGS.filter((o) => { const p = dprog.get(o.id); return p && isDue(p.srs, now); });
  const rprog = await loadProgress(ctx.pk, 'random');
  const rpool = RANDOM_POOL();
  const rseen = rpool.filter((o) => rprog.get(o.id)).length;
  const rdue = rpool.filter((o) => { const p = rprog.get(o.id); return p && isDue(p.srs, now); }).length;
  const varRow = (f: RepFamily, o: RepEntry, w: number) => {
    const st = statusOf(prog.get(o.id), now);
    const dst = statusOf(dprog.get(o.id), now);
    const resp = o.plies.map((p, i) => ({ p, i })).filter(({ p, i }) => p.mine && i >= o.idPlies - 1 && p.why);
    const short = o.name.startsWith(family(f, o.name)) && o.name.includes(':') ? o.name.slice(o.name.indexOf(':') + 1).trim() : o.name;
    return `<li class="op-var" id="op-${esc(o.id)}" data-op="${esc(o.id)}">
      <div class="op-var-top"><span class="op-var-name"><b>${esc(short)}</b> <span class="op-eco">${esc(o.eco)}</span>${o.fromGames ? ` <span class="op-mine" title="Seen in your games">in your games ×${o.fromGames}</span>` : ''}</span>
        <span class="op-var-meta"><span class="muted small" title="Share of this family's sample games">${pctText(w)}</span> <span class="op-status op-${st.cls}">${esc(st.text)}</span> <button class="btn small" data-practice="${esc(o.id)}" aria-label="Practise ${esc(o.name)}">Practise</button></span></div>
      <div class="op-var-def"><span class="muted small">Defend against it (you play ${sideWord(other(o.side))}):</span> <span class="op-status op-${dst.cls}">${esc(dst.text)}</span> <button class="btn small" data-defend="${esc(o.id)}" aria-label="Defend against ${esc(o.name)}">Defend</button></div>
      <details class="op-line"><summary>${esc(moveText(o.plies.slice(0, o.idPlies)))} — your line (${o.plies.length - o.idPlies} moves)</summary>
        <p class="op-full">${esc(moveText(o.plies))}</p>
        <ul>${resp.map(({ p, i }) => `<li><b>${esc(moveLabel(i, p.san))}</b> — ${esc(p.why!)}</li>`).join('')}</ul>
        ${o.also?.length ? `<p class="muted small">This line also covers: ${esc(o.also.join('; '))}</p>` : ''}
        <p class="muted small">Ends in: ${esc(o.endsIn)} · Stockfish: ${o.endEvalCp >= 0 ? '+' : ''}${(o.endEvalCp / 100).toFixed(1)} for you</p>
      </details></li>`;
  };
  const card = (f: RepFamily) => {
    const st = familyStatus(f, prog, now);
    const w = variationWeights(f);
    const vs = variationsOf(f);
    const sk = f.skipped.filter((x) => x.games);
    return `<article class="card op-card" id="op-${esc(f.id)}" data-family="${esc(f.id)}">
      <div class="op-top"><h3>${esc(f.name)}</h3><span class="op-status op-${st.cls}">${esc(st.text)}</span></div>
      <p class="op-moves">${esc(f.root)}</p>
      <p class="op-idea">${esc(f.idea)}</p>
      <ul class="op-vars">${vs.map((o) => varRow(f, o, w.get(o.id) ?? 0)).join('')}</ul>
      ${sk.length ? `<p class="muted small op-skipped">From your games, not in this line: ${sk.map((x) => `${esc(x.name)} (${esc(x.why)})`).join('; ')}.</p>` : ''}
      <div class="op-actions"><button class="btn primary" data-practice="${esc(f.id)}">Practise all ${vs.length > 1 ? `${vs.length} variations` : ''}</button><button class="btn" data-defend="${esc(f.id)}">Defend against it</button><span class="muted small">Practise: you play ${sideWord(f.side)} and find each move of the line. Defend: you play ${sideWord(other(f.side))} against it, any move you like, then a 12-move review.</span></div>
    </article>`;
  };
  const nVars = FAMILIES.reduce((a, f) => a + f.variations.length, 0);
  ctx.app.innerHTML = `
    <section class="page openings">
      <div class="page-head"><h1>Openings</h1><span class="muted">${FAMILIES.length} families · ${nVars} variations · ${due.length + ddue.length ? `${due.length + ddue.length} due for practice` : 'practise any of them'}</span></div>
      <div class="card op-random" id="op-random-card"><div class="op-top"><h2>Random opening</h2><span class="op-status op-${rdue ? 'due' : rseen ? 'learning' : 'new'}">${rseen ? `${rseen} of ${rpool.length} seen${rdue ? ` · ${rdue} to repeat` : ''}` : `${rpool.length} White openings`}</span></div>
        <p class="muted small">You're Black. White picks one of ${rpool.length} openings at random — popular ones more often, and ones you got wrong come back sooner. You aren't told which: play any moves for 12 moves, then the review names the opening and shows the book line you should have played.</p>
        <div class="op-actions"><button class="btn primary" id="op-random">Play a random opening</button></div></div>
      <div class="card" id="op-faced"><h2>Openings you face most</h2><p class="muted">Looking through your games…</p></div>
      ${due.length || ddue.length ? `<div class="card op-due"><b>Due now:</b> ${due.map((o) => `<button class="chip" data-practice="${esc(o.id)}">${esc(o.name)}</button>`).join(' ')} ${ddue.map((o) => `<button class="chip" data-defend="${esc(o.id)}">${esc(o.name)} (defend)</button>`).join(' ')}</div>` : ''}
      <h2 class="op-group">When you're Black</h2>
      <p class="muted small">The opponent opens; you learn a sound reply to each of its main variations.</p>
      <div class="op-grid">${FAMILIES.filter((f) => f.side === 'b').map(card).join('')}</div>
      <h2 class="op-group">When you're White</h2>
      <p class="muted small">You open; you learn what to do against each defence and its main variations.</p>
      <div class="op-grid">${FAMILIES.filter((f) => f.side === 'w').map(card).join('')}</div>
      <p class="muted small op-src">Names and ECO codes: ${esc(REPERTOIRE.meta.sources.names)}. Moves: ${esc(REPERTOIRE.meta.sources.moves)}. ${esc(REPERTOIRE.meta.sources.check)}.${REPERTOIRE.meta.sources.yourGames ? ` Variations marked "in your games": ${esc(REPERTOIRE.meta.sources.yourGames)}` : ''}</p>
    </section>`;
  const wire = (root: ParentNode) => {
    root.querySelectorAll<HTMLButtonElement>('[data-practice]').forEach((b) => (b.onclick = () => ctx.navigate({ view: 'openings', o: b.dataset.practice!, m: null })));
    root.querySelectorAll<HTMLButtonElement>('[data-defend]').forEach((b) => (b.onclick = () => ctx.navigate({ view: 'openings', o: b.dataset.defend!, m: 'defend' })));
  };
  wire(ctx.app);
  $('#op-random').onclick = () => ctx.navigate({ view: 'openings', o: 'random', m: null });
  await ctx.loadGames();
  const [games, book] = await Promise.all([myGames(ctx), ctx.book()]);
  const el = document.getElementById('op-faced');
  if (!el) return;
  const all = facedStats(games, book);
  const row = (r: FacedRow) => {
    const target = r.entry && (r.entry.name === r.label || r.entry.names.includes(r.label)) ? r.entry : null;
    const btn = target ? `<button class="btn small" data-practice="${esc(target.id)}">Practise</button>`
      : r.family ? `<button class="btn small" data-practice="${esc(r.family.id)}">Practise ${esc(r.family.name)}</button>` : '<span class="muted small">no line yet</span>';
    return `<tr class="${r.struggling ? 'op-struggle' : ''}" data-faced="${esc(r.key)}">
      <td>${esc(r.label)} <span class="op-eco">${esc(r.eco)}</span>${r.struggling ? ' <span class="op-flag">You struggle here</span>' : ''}${target && target.name !== r.label ? `<div class="muted small">Line: ${esc(target.name)}</div>` : ''}${r.differs ? `<div class="muted small">Your trainer line differs: it ${esc(r.differs)}.</div>` : ''}</td>
      <td>${sideWord(r.myColor)}</td><td>${r.games}</td>
      <td>${Math.round(r.score * 100)}% <span class="muted small">(${r.wins}W ${r.draws}D ${r.losses}L)</span></td>
      <td>${btn}</td></tr>`;
  };
  const head = '<thead><tr><th>Opening (lichess name)</th><th>You</th><th>Games</th><th>Score</th><th></th></tr></thead>';
  el.innerHTML = `<h2>Openings you face most</h2>${all.length ? `
    <p class="muted small">From ${games.length} of your games, by exact variation name. Score counts a win as 1 and a draw as ½.</p>
    <table class="rec op-faced">${head}<tbody>${all.slice(0, 12).map(row).join('')}</tbody></table>
    ${all.length > 12 ? `<details class="op-more"><summary>All ${all.length} variations from your games</summary><table class="rec op-faced">${head}<tbody>${all.slice(12).map(row).join('')}</tbody></table></details>` : ''}`
    : '<p class="muted">No games found yet. Open the Games tab to load your games, then come back.</p>'}`;
  wire(el);
}

/** Family prefix of a variation name, e.g. "Center Game" for "Center Game: Paulsen Attack". */
function family(_f: RepFamily, name: string) { return name.split(':')[0]; }

// ---------------- practice ----------------
let drill: Round | null = null;
export function destroyDrill() { drill?.destroy(); drill = null; }

async function saveProgress(ctx: OpeningsCtx, id: string, m: Mode, r: DrillResult) {
  const key = progressKey(ctx.pk, progId(id, m));
  const t = Date.now();
  let prev: OpeningProgress | undefined;
  try { prev = await store.get<OpeningProgress>('meta', key); } catch { /* no IndexedDB */ }
  const srs: SrsState = schedule(prev?.srs ?? newSrs(t), r, t);
  const next: OpeningProgress = { key, profileKey: ctx.pk, openingId: id, srs };
  try { await store.put('meta', next); } catch { /* storage unavailable: progress isn't saved */ }
  return statusOf(next, t).text;
}

/** Random opening: you're Black, White plays a surprise opening (weighted by popularity and your record). */
async function renderRandom(ctx: OpeningsCtx, exclude?: string) {
  const prog = await loadProgress(ctx.pk, 'random');
  const e = pickRandomOpening(RANDOM_POOL(), (id) => prog.get(id)?.srs, Date.now(), Math.random, exclude);
  if (!e) return ctx.navigate({ view: 'openings', o: null, m: null });
  const book = await ctx.book();
  document.title = 'Random opening · rook-i.e. mistakes';
  ctx.app.innerHTML = `<section class="page train openings-train"><div class="page-head"><h1>Random opening</h1><button class="btn ghost" id="op-back">‹ All openings</button></div><div id="op-host"></div></section>`;
  $('#op-back').onclick = () => ctx.navigate({ view: 'openings', o: null, m: null });
  drill = new DefendRound($('#op-host'), e, {
    kind: 'random', family: null, branching: false, book,
    onDone: (r, id) => saveProgress(ctx, id, 'random', r),
    onAgain: () => { destroyDrill(); void renderRandom(ctx, e.id); },
    onSwitch: () => ctx.navigate({ view: 'openings', o: e.id, m: null }),
    onBack: () => ctx.navigate({ view: 'openings', o: null, m: null }),
  });
}

async function renderDrill(ctx: OpeningsCtx, fam: RepFamily | null, chosen: RepEntry | null, branch = !chosen, mode: Mode = 'play') {
  const now = Date.now();
  const branching = branch && !!fam;
  let e = chosen;
  if (!e && fam) { const p = await loadProgress(ctx.pk, mode); e = pickVariation(fam, (id) => p.get(id)?.srs, now); }
  if (!e) return ctx.navigate({ view: 'openings', o: null, m: null });
  const entry = e;
  const title = branching ? fam!.name : entry.name;
  const book = await ctx.book();
  document.title = `${title} · ${mode === 'defend' ? 'Defend' : 'Openings'} · rook-i.e. mistakes`;
  const target = branching ? fam!.id : entry.id;
  ctx.app.innerHTML = `<section class="page train openings-train"><div class="page-head"><h1>${mode === 'defend' ? 'Defend against' : 'Practise'}: ${esc(title)}</h1><button class="btn ghost" id="op-back">‹ All openings</button></div>
    <div class="op-modes" role="group" aria-label="Mode">
      <button class="btn small${mode === 'play' ? ' on' : ''}" id="op-mode-play" aria-pressed="${mode === 'play'}">Play the opening <span class="muted">(you're ${sideWord(entry.side)})</span></button>
      <button class="btn small${mode === 'defend' ? ' on' : ''}" id="op-mode-defend" aria-pressed="${mode === 'defend'}">Defend against it <span class="muted">(you're ${sideWord(other(entry.side))})</span></button>
    </div><div id="op-host"></div></section>`;
  $('#op-back').onclick = () => ctx.navigate({ view: 'openings', o: null, m: null });
  const go = (m: Mode) => ctx.navigate({ view: 'openings', o: target, m: m === 'defend' ? 'defend' : null });
  $('#op-mode-play').onclick = () => mode !== 'play' && go('play');
  $('#op-mode-defend').onclick = () => mode !== 'defend' && go('defend');
  const save = (id: string, m: Mode, r: DrillResult) => saveProgress(ctx, id, m, r);
  if (mode === 'defend') {
    drill = new DefendRound($('#op-host'), entry, {
      family: fam, branching, book,
      onDone: (r, id) => save(id, 'defend', r),
      onAgain: () => { destroyDrill(); void renderDrill(ctx, fam, branching ? null : entry, branching, 'defend'); },
      onSwitch: () => go('play'),
      onBack: () => ctx.navigate({ view: 'openings', o: null, m: null }),
    });
    return;
  }
  const share = fam ? variationWeights(fam).get(entry.id) ?? 1 : 1;
  drill = new Drill($('#op-host'), entry, {
    family: fam, branching, share, book,
    onDone: (r) => save(entry.id, 'play', r),
    onNext: () => {
      const t = Date.now();
      void loadProgress(ctx.pk).then((p) => {
        if (branching && fam && fam.variations.length > 1) {
          destroyDrill();
          return void renderDrill(ctx, fam, pickVariation(fam, (id) => p.get(id)?.srs, t, Math.random, entry.id), true);
        }
        const nxt = OPENINGS.find((o) => o.id !== entry.id && p.get(o.id) && isDue(p.get(o.id)!.srs, t)) ?? OPENINGS.find((o) => o.id !== entry.id && !p.get(o.id));
        ctx.navigate({ view: 'openings', o: nxt ? nxt.id : null, m: null });
      });
    },
    onAgain: () => { destroyDrill(); void renderDrill(ctx, fam, entry, branching); },
    onSwitch: () => go('defend'),
  });
}

/** "Opening: Indian Defense: Knights Variation A46" for the moves so far (latest named position). */
function nameBar(fens: string[], book: Book | null): string {
  const n = openingName(fens, book);
  return n ? `Opening: <b>${esc(n.name)}</b> <span class="op-eco">${esc(n.eco)}</span>` : `Opening: <span class="muted">${fens.length > 1 ? 'no named opening yet' : 'start position'}</span>`;
}

interface DrillResult { solved: boolean; attempts: number; hints: number; revealed: boolean }

interface Round { destroy(): void }
class Drill implements Round {
  cg!: CgApi;
  i = 0;
  wrong = 0;
  hints = 0;
  hintStage = 0;
  revealed = false;
  done = false;
  timer: number | null = null;
  destroyed = false;
  constructor(public host: HTMLElement, public e: RepEntry, public o: { family: RepFamily | null; branching: boolean; share: number; book: Book | null; onDone: (r: DrillResult) => Promise<string>; onNext: () => void; onAgain: () => void; onSwitch: () => void }) {
    this.render();
    this.advance();
  }

  get color() { return this.e.side === 'w' ? 'white' : 'black'; }

  render() {
    const e = this.e;
    this.host.innerHTML = `
      <div class="trainer op-drill" role="region" aria-label="Practise this opening">
        <div class="tr-board-col">
          <p class="op-namebar" id="op-namebar" aria-live="polite"></p>
          <p class="tr-last" id="tr-last" aria-live="polite"></p>
          <div class="tr-board-wrap"><div class="tr-board" id="tr-board" role="img"></div></div>
          <form class="tr-type" id="tr-type" autocomplete="off">
            <label for="tr-input">Type a move</label>
            <input id="tr-input" placeholder="e.g. Nf6 or g8f6" spellcheck="false" aria-describedby="tr-status">
            <button class="btn">Play</button>
          </form>
        </div>
        <div class="tr-side">
          <div class="tr-head"><h2>${this.o.branching ? esc(this.o.family!.name) : `${esc(e.name)} <span class="op-eco">${esc(e.eco)}</span>`}</h2><p class="muted">You play ${sideWord(e.side)}. ${this.o.branching ? `The app picks the other side's moves among the ${this.o.family!.variations.length} main variations, as often as each is played.` : "The app plays the other side's most common moves."}</p><p class="op-varname" id="op-varname" aria-live="polite"></p></div>
          <p class="tr-task" id="op-task"></p>
          <p class="op-progress" id="op-progress"></p>
          <div class="tr-status" id="tr-status" role="status" aria-live="polite"></div>
          <div class="tr-hints" id="tr-hints"></div>
          <div class="tr-actions" id="tr-actions">
            <button class="btn" id="tr-hint">Hint (1 of 3)</button>
            <button class="btn ghost" id="tr-reveal">Show answer</button>
          </div>
          <details class="op-line"><summary>The idea</summary><p>${esc(this.o.family?.idea || e.idea)}</p></details>
          <div class="tr-lesson" id="tr-lesson" hidden></div>
        </div>
      </div>`;
    this.cg = Chessground($('#tr-board', this.host), {
      fen: new Chess().fen(), orientation: this.color, turnColor: 'white', coordinates: true,
      animation: { enabled: !reducedMotion(), duration: 200 }, highlight: { lastMove: true, check: true },
      movable: { free: false, color: undefined, dests: new Map(), showDests: true, events: { after: (a, b) => this.onBoardMove(a, b) } },
      draggable: { enabled: true }, drawable: { enabled: false, visible: true }, premovable: { enabled: false },
    });
    $('#tr-type', this.host).onsubmit = (ev) => {
      ev.preventDefault();
      const inp = $<HTMLInputElement>('#tr-input', this.host);
      const p = this.e.plies[this.i];
      if (!p || !p.mine || this.done) return;
      const uci = parseTyped(p.fen, inp.value);
      if (!uci) { this.status(`“${esc(inp.value)}” is not a legal move here.`, 'warn'); return; }
      inp.value = '';
      this.tryMove(uci);
    };
    $('#tr-hint', this.host).onclick = () => this.hint();
    $('#tr-reveal', this.host).onclick = () => this.reveal();
  }

  destroy() { this.destroyed = true; if (this.timer) clearTimeout(this.timer); this.cg?.destroy(); }

  status(html: string, kind: '' | 'good' | 'warn' | 'bad' = '') { const el = $('#tr-status', this.host); el.className = `tr-status ${kind}`; el.innerHTML = html; }

  /** Board at the position before ply i, with the move that led there highlighted and named above the board. */
  show(i: number) {
    const fen = i < this.e.plies.length ? this.e.plies[i].fen : (() => { const c = new Chess(this.e.plies[i - 1].fen); const u = this.e.plies[i - 1].uci; c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); return c.fen(); })();
    const prev = i > 0 ? this.e.plies[i - 1] : null;
    const lm = prev ? describeMove(prev.fen, prev.uci) : null;
    const last = $('#tr-last', this.host);
    last.innerHTML = lm ? `Last move: <b>${esc(lm.label)}</b> <span class="muted">(${esc(lm.from)} → ${esc(lm.to)})</span>` : 'Last move: none (start of game)';
    const c = new Chess(fen);
    const mine = !this.done && i < this.e.plies.length && this.e.plies[i].mine;
    this.cg.set({
      fen, turnColor: c.turn() === 'w' ? 'white' : 'black', check: c.inCheck() ? (c.turn() === 'w' ? 'white' : 'black') : false,
      lastMove: prev ? [prev.uci.slice(0, 2) as Key, prev.uci.slice(2, 4) as Key] : undefined,
      movable: { color: mine ? this.color : undefined, dests: mine ? (legalDests(fen) as Map<Key, Key[]>) : new Map() },
    });
    this.cg.setAutoShapes([]);
    $('#tr-board', this.host).setAttribute('aria-label', boardDescription(fen));
    const fens = [...this.e.plies.slice(0, Math.min(i, this.e.plies.length)).map((p) => p.fen), fen];
    const named = !this.o.branching || this.done || i >= this.e.idPlies;
    const now = openingName(fens, this.o.book);
    $('#op-namebar', this.host).innerHTML = named
      ? `Opening: <b>${esc(this.e.name)}</b> <span class="op-eco">${esc(this.e.eco)}</span>${now && now.name !== this.e.name && i > this.e.idPlies ? ` <span class="muted small">· this position is also known as ${esc(now.name)} (${esc(now.eco)})</span>` : ''}`
      : `Opening: <b>${esc(this.o.family!.name)}</b> <span class="muted small">· variation shown once the opponent commits</span>`;
    const mineTotal = this.e.plies.filter((p) => p.mine).length;
    const mineDone = this.e.plies.slice(0, i).filter((p) => p.mine).length;
    $('#op-progress', this.host).innerHTML = `<span class="op-bar"><span style="width:${Math.round((mineDone / mineTotal) * 100)}%"></span></span> ${mineDone} of ${mineTotal} moves · <span class="muted">${esc(moveText(this.e.plies.slice(0, i)) || 'start position')}</span>`;
  }

  /** Play the opponent's moves until it's your turn (or the line ends). */
  advance() {
    if (this.destroyed) return;
    this.hintStage = 0;
    $('#tr-hints', this.host).innerHTML = '';
    if (this.i >= this.e.plies.length) return this.finish();
    const p = this.e.plies[this.i];
    this.show(this.i);
    this.varName();
    if (p.mine) {
      const n = Math.floor(this.i / 2) + 1;
      $('#op-task', this.host).innerHTML = `<b>${sideWord(this.e.side)} to move${this.i === 0 ? '' : ` (move ${n})`}.</b> Find the move in this line.`;
      $<HTMLButtonElement>('#tr-hint', this.host).disabled = false;
      $<HTMLButtonElement>('#tr-hint', this.host).textContent = 'Hint (1 of 3)';
      if (!this.wrong && !this.hints && this.i < 2) this.status('Drag a piece, click a piece then a square, or type a move.');
      return;
    }
    $('#op-task', this.host).innerHTML = `<b>${sideWord(this.e.side === 'w' ? 'b' : 'w')} is thinking…</b>`;
    this.timer = window.setTimeout(() => { this.timer = null; this.i++; this.advance(); }, reducedMotion() ? 150 : 650);
  }

  /** In branching practice the variation is named once the opponent has committed to it. */
  varName() {
    const el = $('#op-varname', this.host);
    if (this.o.branching && this.i < this.e.idPlies && !this.done) { el.innerHTML = '<span class="muted">Which variation? Watch the opponent\'s moves.</span>'; return; }
    el.innerHTML = `Variation: <b>${esc(this.e.name)}</b> <span class="op-eco">${esc(this.e.eco)}</span>${this.o.family && this.o.family.variations.length > 1 ? ` <span class="muted small">(${Math.round(this.o.share * 100)}% of this family's games)</span>` : ''}`;
  }

  onBoardMove(orig: string, dest: string) {
    const p = this.e.plies[this.i];
    let uci = orig + dest;
    const piece = new Chess(p.fen).get(orig as never);
    if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) uci += p.uci.length === 5 && p.uci.startsWith(uci) ? p.uci[4] : 'q';
    this.tryMove(uci);
  }

  tryMove(uci: string) {
    if (this.done) return;
    const p = this.e.plies[this.i];
    const j = judgeMove(this.e, this.i, uci);
    if (j.kind === 'book') {
      this.status(`✓ <b>${esc(p.san)}</b>${p.why ? ` — ${esc(p.why)}` : ''}`, 'good');
      this.i++;
      this.advance();
      return;
    }
    this.wrong++;
    this.status(esc(wrongText(j)), j.kind === 'alt-ok' ? 'warn' : 'bad');
    // put the piece back after a moment so you can see what you tried
    this.cg.set({ movable: { color: undefined, dests: new Map() } });
    this.timer = window.setTimeout(() => { this.timer = null; if (!this.destroyed) this.show(this.i); }, 600);
  }

  hint() {
    const p = this.e.plies[this.i];
    if (!p?.mine || this.done) return;
    this.hintStage++;
    this.hints = Math.min(4, this.hints + 1);
    const box = $('#tr-hints', this.host);
    if (this.hintStage === 1) {
      box.innerHTML = `<div class="hint"><b>Idea:</b> ${esc(p.why ?? this.e.idea)}</div>`;
      $('#tr-hint', this.host).textContent = 'Hint (2 of 3)';
    } else if (this.hintStage === 2) {
      const from = p.uci.slice(0, 2);
      const pc = new Chess(p.fen).get(from as never);
      const name = pc ? ({ p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' } as Record<string, string>)[pc.type] : 'piece';
      box.innerHTML += `<div class="hint"><b>Piece:</b> move your ${name} on ${from} (circled).</div>`;
      this.cg.setAutoShapes([{ orig: from as Key, brush: 'green' }]);
      $('#tr-hint', this.host).textContent = 'Hint (3 of 3)';
    } else {
      this.reveal();
    }
  }

  reveal() {
    const p = this.e.plies[this.i];
    if (!p?.mine || this.done) return;
    this.revealed = true;
    this.status(`The move is <b>${esc(p.san)}</b>${p.why ? ` — ${esc(p.why)}` : ''}. Play it on the board to continue.`, 'warn');
    this.cg.setAutoShapes([{ orig: p.uci.slice(0, 2) as Key, dest: p.uci.slice(2, 4) as Key, brush: 'green' }]);
  }

  async finish() {
    this.done = true;
    this.show(this.e.plies.length);
    this.varName();
    $('#op-task', this.host).innerHTML = '<b>Line complete.</b>';
    $('#tr-actions', this.host).style.display = 'none';
    $('#tr-type', this.host).style.display = 'none';
    const r: DrillResult = { solved: !this.revealed, attempts: 1 + this.wrong, hints: this.hints, revealed: this.revealed };
    const clean = !this.wrong && !this.hints && !this.revealed;
    const status = await this.o.onDone(r);
    if (this.destroyed) return;
    const l = $('#tr-lesson', this.host);
    l.hidden = false;
    l.innerHTML = `
      <p class="${clean ? 'good' : ''}">${clean ? 'Perfect run — every move found first time.' : `Done. ${this.wrong} wrong tr${this.wrong === 1 ? 'y' : 'ies'}${this.hints ? `, ${this.hints} hint${this.hints === 1 ? '' : 's'}` : ''}${this.revealed ? ', answer shown' : ''}.`} ${clean ? 'It comes back in a couple of days.' : this.revealed ? 'It comes back soon so you can lock it in.' : 'It comes back a little sooner.'}</p>
      <p class="muted small" id="op-mastery">Progress: ${esc(status)}</p>
      <p class="muted small">This position: ${esc(this.e.endsIn)}. Stockfish: ${this.e.endEvalCp >= 0 ? '+' : ''}${(this.e.endEvalCp / 100).toFixed(1)} for you.</p>
      <div class="tr-after"><button class="btn primary" id="op-next">${this.o.branching && this.o.family!.variations.length > 1 ? 'Next variation' : 'Next opening'}</button><button class="btn" id="op-again">Practise again</button><button class="btn ghost" id="op-switch">Now defend against it</button></div>`;
    $('#op-next', this.host).onclick = () => this.o.onNext();
    $('#op-switch', this.host).onclick = () => this.o.onSwitch();
    $('#op-again', this.host).onclick = () => this.o.onAgain();
    this.status(`✓ Line complete: ${esc(moveText(this.e.plies))}`, 'good');
  }
}

// ---------------- defend against it ----------------
const START_FEN = new Chess().fen();
const DEPTH = 12;
const VERDICT_BRUSH: Record<string, string> = { book: 'blue', good: 'blue', inaccuracy: 'yellow', mistake: 'red', blunder: 'red' };
const PIECE: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const posKeyOf = (fen: string) => fen.split(' ').slice(0, 3).join(' ');

interface DefendOpts {
  /** defend: you take the other side of the opening; random: you're the line's side (Black) but White's opening is a surprise. */
  kind?: 'defend' | 'random';
  family: RepFamily | null; branching: boolean; book: Book | null;
  onDone: (r: DrillResult, variationId: string) => Promise<string>; onAgain: () => void; onSwitch: () => void; onBack: () => void;
}

/** You play the other side; the app plays the opening's line. Any legal move; 12 moves, then the review. */
class DefendRound implements Round {
  cg!: CgApi;
  me: 'w' | 'b';
  fens: string[] = [START_FEN];
  ucis: string[] = [];
  sans: string[] = [];
  line: Map<string, { uci: string; entry: string }>;
  replies: Map<string, string>;
  data: OpeningData | null = null;
  ana = new EnginePool(1);
  play: EnginePool | null = null;
  evals = new Map<string, Promise<PosEval>>();
  checks: Promise<MoveCheck>[] = [];
  rows: ReviewRow[] = [];
  appSrc: ('line' | 'book' | 'engine')[] = [];
  hints = 0;
  hintStage = 0;
  done = false;
  destroyed = false;
  timer: number | null = null;
  random: boolean;
  them: 'w' | 'b';
  constructor(public host: HTMLElement, public e: RepEntry, public o: DefendOpts) {
    this.random = o.kind === 'random';
    this.me = this.random ? e.side : other(e.side);
    this.them = other(this.me);
    if (this.random) {
      // White plays exactly this variation; your book moves are the line's own moves (and the family's, once you transpose).
      this.line = sideMoves(e, false);
      this.replies = new Map([...lineMoves(e, o.family)].map(([k, v]) => [k, v.uci]));
    } else {
      this.line = lineMoves(e, o.family);
      this.replies = lineReplies(e, o.family);
    }
    (window as unknown as { __defend: DefendRound }).__defend = this;
    this.render();
    this.show();
    void loadOpenings().then((r) => { this.data = r.data; }).finally(() => this.advance());
  }

  get fen() { return this.fens[this.fens.length - 1]; }
  get ply() { return this.ucis.length; }
  get color() { return this.me === 'w' ? 'white' : 'black'; }
  get name() { return this.o.branching ? this.o.family!.name : this.e.name; }

  render() {
    const them = sideWord(this.them);
    this.host.innerHTML = `
      <div class="trainer op-drill op-defend${this.random ? ' op-random-round' : ''}" role="region" aria-label="${this.random ? 'Random opening' : 'Defend against this opening'}">
        <div class="tr-board-col">
          <p class="op-namebar" id="op-namebar" aria-live="polite"></p>
          <p class="tr-last" id="tr-last" aria-live="polite"></p>
          <div class="tr-board-wrap"><div class="tr-board" id="tr-board" role="img"></div></div>
          <form class="tr-type" id="tr-type" autocomplete="off">
            <label for="tr-input">Type a move</label>
            <input id="tr-input" placeholder="e.g. Nf6 or g8f6" spellcheck="false" aria-describedby="tr-status">
            <button class="btn">Play</button>
          </form>
        </div>
        <div class="tr-side" id="dr-side">
          <div class="tr-head">${this.random ? `<h2 id="dr-title">A surprise White opening</h2>
            <p class="muted">You play Black. White has picked an opening and won't say which. Play any move you like — nothing is marked wrong during the round. After 12 moves the review names the opening and shows the book line you should have played.</p>` : `<h2>${esc(this.name)}${this.o.branching ? '' : ` <span class="op-eco">${esc(this.e.eco)}</span>`}</h2>
            <p class="muted">You play ${sideWord(this.me)}. The app plays ${them}'s moves from this opening${this.o.branching ? ` (all ${this.o.family!.variations.length} variations)` : ''}. Play any move you like — nothing is marked wrong during the round. After 12 moves you get a review of every move.</p>`}</div>
          <p class="tr-task" id="op-task"></p>
          <p class="op-progress" id="op-progress"></p>
          <div class="tr-status" id="tr-status" role="status" aria-live="polite"></div>
          <div class="tr-hints" id="tr-hints"></div>
          <div class="tr-actions" id="tr-actions">
            <button class="btn" id="tr-hint">Hint (1 of 2)</button>
            <button class="btn ghost" id="dr-restart">Restart</button>
          </div>
          ${this.random ? '' : `<details class="op-line"><summary>The idea</summary><p>${esc(this.o.family?.idea || this.e.idea)}</p><p class="muted small">This is ${them}'s plan; you are on the other side. Your book replies come from the most played moves in the sample, checked with Stockfish.</p></details>`}
          <div class="tr-lesson" id="tr-lesson" hidden></div>
        </div>
      </div>`;
    this.cg = Chessground($('#tr-board', this.host), {
      fen: START_FEN, orientation: this.color, turnColor: 'white', coordinates: true,
      animation: { enabled: !reducedMotion(), duration: 200 }, highlight: { lastMove: true, check: true },
      movable: { free: false, color: undefined, dests: new Map(), showDests: true, events: { after: (a, b) => this.onBoardMove(a, b) } },
      draggable: { enabled: true }, drawable: { enabled: false, visible: true }, premovable: { enabled: false },
    });
    $('#tr-type', this.host).onsubmit = (ev) => {
      ev.preventDefault();
      const inp = $<HTMLInputElement>('#tr-input', this.host);
      if (!this.myTurn()) return;
      const uci = parseTyped(this.fen, inp.value);
      if (!uci) { this.status(`“${esc(inp.value)}” is not a legal move here.`, 'warn'); return; }
      inp.value = '';
      this.userMove(uci);
    };
    $('#tr-hint', this.host).onclick = () => void this.hint();
    $('#dr-restart', this.host).onclick = () => this.o.onAgain();
  }

  destroy() { this.destroyed = true; if (this.timer) clearTimeout(this.timer); this.cg?.destroy(); this.ana.destroy(); this.play?.destroy(); }
  status(html: string, kind: '' | 'good' | 'warn' | 'bad' = '') { const el = $('#tr-status', this.host); el.className = `tr-status ${kind}`; el.innerHTML = html; }
  myTurn() { return !this.done && new Chess(this.fen).turn() === this.me; }

  show() {
    const fen = this.fen, c = new Chess(fen);
    const i = this.ply;
    const lm = i > 0 ? describeMove(this.fens[i - 1], this.ucis[i - 1]) : null;
    $('#tr-last', this.host).innerHTML = lm ? `Last move: <b>${esc(lm.label)}</b> <span class="muted">(${esc(lm.from)} → ${esc(lm.to)})</span>` : 'Last move: none (start of game)';
    const mine = this.myTurn();
    this.cg.set({
      fen, turnColor: c.turn() === 'w' ? 'white' : 'black', check: c.inCheck() ? (c.turn() === 'w' ? 'white' : 'black') : false,
      lastMove: i > 0 ? [this.ucis[i - 1].slice(0, 2) as Key, this.ucis[i - 1].slice(2, 4) as Key] : undefined,
      movable: { color: mine ? this.color : undefined, dests: mine ? (legalDests(fen) as Map<Key, Key[]>) : new Map() },
    });
    this.cg.setAutoShapes([]);
    $('#tr-board', this.host).setAttribute('aria-label', boardDescription(fen));
    $('#op-namebar', this.host).innerHTML = this.random ? this.randomBar(this.fens) : nameBar(this.fens, this.o.book);
    const moveNo = Math.min(12, Math.floor(i / 2) + 1);
    $('#op-progress', this.host).innerHTML = `<span class="op-bar"><span style="width:${Math.round((i / ROUND_PLIES) * 100)}%"></span></span> Move ${moveNo} of 12 · <span class="muted">${esc(moveText(this.sans.map((san) => ({ san }))) || 'start position')}</span>`;
  }

  /** Random mode: the opening stays hidden during the round; afterwards, White's choice plus what the position became. */
  randomBar(fens: string[]) {
    if (!this.done) return 'Opening: <b>hidden</b> <span class="muted">— named in the review</span>';
    const n = openingName(fens, this.o.book);
    return `White's opening: <b>${esc(this.e.name)}</b> <span class="op-eco">${esc(this.e.eco)}</span>${n && n.name !== this.e.name ? ` <span class="muted small">· this position: ${esc(n.name)}</span>` : ''}`;
  }

  over() { const c = new Chess(this.fen); return this.ply >= ROUND_PLIES || c.isGameOver(); }

  advance() {
    if (this.destroyed || this.done) return;
    this.hintStage = 0;
    $('#tr-hints', this.host).innerHTML = '';
    $<HTMLButtonElement>('#tr-hint', this.host).textContent = 'Hint (1 of 2)';
    this.show();
    if (this.over()) return void this.finish();
    if (this.myTurn()) {
      $('#op-task', this.host).innerHTML = `<b>${sideWord(this.me)} to move (move ${Math.floor(this.ply / 2) + 1}).</b> Your choice — any legal move.`;
      $<HTMLButtonElement>('#tr-hint', this.host).disabled = false;
      if (this.ply < 2) this.status('Drag a piece, click a piece then a square, or type a move.');
      return;
    }
    $<HTMLButtonElement>('#tr-hint', this.host).disabled = true;
    $('#op-task', this.host).innerHTML = `<b>${sideWord(this.them)} is thinking…</b>`;
    const t0 = Date.now(), fen = this.fen;
    void this.appMove(fen).then((u) => {
      if (this.destroyed || this.fen !== fen) return;
      const wait = Math.max(0, (reducedMotion() ? 150 : 600) - (Date.now() - t0));
      this.timer = window.setTimeout(() => { this.timer = null; if (!this.destroyed && this.fen === fen) { this.apply(u.uci); this.appSrc.push(u.src); this.advance(); } }, wait);
    });
  }

  /** The line's move, else a common sample move, else Stockfish at a modest depth. */
  async appMove(fen: string): Promise<{ uci: string; src: 'line' | 'book' | 'engine' }> {
    const p = pickAppMove(fen, this.line, this.data ? explore(fen, this.data) : null);
    if (p) return p;
    this.play ??= new EnginePool(1, ['Skill Level value 15']);
    try {
      const r = await this.play.analyse(fen, 10, 1, 1500);
      const u = r.best ?? r.lines[0]?.pv[0];
      if (u) return { uci: u, src: 'engine' };
    } catch { /* engine unavailable */ }
    const m = new Chess(fen).moves({ verbose: true })[0];
    return { uci: m.from + m.to + (m.promotion ?? ''), src: 'engine' };
  }

  apply(uci: string) {
    const c = new Chess(this.fen);
    const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    this.ucis.push(uci);
    this.sans.push(m.san);
    this.fens.push(c.fen());
  }

  onBoardMove(orig: string, dest: string) {
    let uci = orig + dest;
    const piece = new Chess(this.fen).get(orig as never);
    if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) uci += 'q';
    this.userMove(uci);
  }

  userMove(uci: string) {
    if (!this.myTurn()) return;
    const fen = this.fen, ply = this.ply;
    try { this.apply(uci); } catch { this.show(); return; }
    this.status(`You played <b>${esc(moveLabel(ply, this.sans[ply]))}</b>.`);
    this.checks.push(this.check(ply, fen, uci));
    this.advance();
  }

  ev(fen: string, mpv: number): Promise<PosEval> {
    const k = `${fen}|${mpv}`;
    let p = this.evals.get(k);
    if (!p) { p = this.ana.analyse(fen, DEPTH, mpv, 4000); this.evals.set(k, p); }
    return p;
  }

  /** Your-side evals for your move, the engine's best and the book candidates (runs in the background during the round). */
  async check(ply: number, fen: string, uci: string): Promise<MoveCheck> {
    const pov = (cp: number) => (this.me === 'w' ? cp : -cp);
    const a = await this.ev(fen, 3);
    const cpOf = async (u: string) => {
      const l = a.lines.find((x) => x.pv[0] === u);
      if (l) return pov(l.score.cp);
      const c = new Chess(fen);
      c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      if (c.isCheckmate()) return 100000;
      if (c.isDraw()) return 0;
      const b = await this.ev(c.fen(), 1);
      return b.lines.length ? pov(b.lines[0].score.cp) : 0;
    };
    const bestUci = a.lines[0]?.pv[0] ?? uci;
    const bestCp = a.lines.length ? pov(a.lines[0].score.cp) : 0;
    const playedCp = await cpOf(uci);
    const book: MoveCheck['book'] = [];
    for (const b of bookCandidates(fen, this.replies.get(posKeyOf(fen)), this.data ? explore(fen, this.data) : null)) book.push({ ...b, cp: await cpOf(b.uci) });
    return { ply, fen, uci, san: sanOf(fen, uci), bestUci, bestCp, playedCp, book };
  }

  /** Hint 1 names the piece of the suggested move (the line's reply or the most played move; else the engine's); hint 2 draws it. */
  async hint() {
    if (!this.myTurn()) return;
    const fen = this.fen;
    const cands = bookCandidates(fen, this.replies.get(posKeyOf(fen)), this.data ? explore(fen, this.data) : null);
    let u = cands[0]?.uci, src = cands[0] ? (cands[0].line ? 'the line' : 'the most played move') : '';
    if (!u) { $('#tr-hints', this.host).innerHTML = '<div class="hint muted">Asking the engine…</div>'; const a = await this.ev(fen, 3); u = a.lines[0]?.pv[0]; src = 'the engine'; }
    if (!u || this.fen !== fen || this.destroyed) return;
    this.hintStage++;
    this.hints++;
    const box = $('#tr-hints', this.host);
    const pc = new Chess(fen).get(u.slice(0, 2) as never) as { type: string } | null;
    if (this.hintStage === 1) {
      box.innerHTML = `<div class="hint"><b>Piece:</b> ${esc(src)} moves your ${pc ? PIECE[pc.type] : 'piece'} on ${u.slice(0, 2)} (circled).</div>`;
      this.cg.setAutoShapes([{ orig: u.slice(0, 2) as Key, brush: 'green' }]);
      $('#tr-hint', this.host).textContent = 'Hint (2 of 2)';
    } else {
      box.innerHTML = `<div class="hint"><b>Move:</b> ${esc(sanOf(fen, u))} (${esc(src)}).</div>`;
      this.cg.setAutoShapes([{ orig: u.slice(0, 2) as Key, dest: u.slice(2, 4) as Key, brush: 'green' }]);
      $<HTMLButtonElement>('#tr-hint', this.host).disabled = true;
    }
  }

  async finish() {
    this.done = true;
    this.show();
    $('#tr-actions', this.host).style.display = 'none';
    $('#tr-type', this.host).style.display = 'none';
    $('#tr-hints', this.host).innerHTML = '';
    const c = new Chess(this.fen);
    $('#op-task', this.host).innerHTML = `<b>Round over${c.isCheckmate() ? ' — checkmate' : c.isGameOver() ? ' — game over' : ` after ${Math.ceil(this.ply / 2)} moves`}.</b>`;
    let n = 0;
    const tick = () => this.status(`Checking your moves with Stockfish… ${n} of ${this.checks.length}`);
    tick();
    const checks = await Promise.all(this.checks.map((p) => p.then((x) => { n++; if (!this.destroyed) tick(); return x; })));
    if (this.destroyed) return;
    const reached = (this.o.family ? reachedVariation(this.sans, variationsOf(this.o.family)) : null) ?? this.e;
    this.rows = markLineBook(checks.map(reviewRow), this.sans, reached);
    const s = summarize(this.rows);
    const left = leftLine(this.sans, reached, this.me);
    const progress = await this.o.onDone(this.random ? randomResult(s, this.hints, left) : roundResult(s, this.hints), this.o.branching ? reached.id : this.e.id);
    if (this.destroyed) return;
    this.status(`✓ Round complete: ${esc(moveText(this.sans.map((san) => ({ san }))))}`, 'good');
    this.renderReview(s, progress, reached, left);
  }

  /** The book line, your moves in bold, the ply where the game left it highlighted. */
  bookLine(entry: RepEntry, left: ReturnType<typeof leftLine>) {
    const n = Math.min(entry.plies.length, Math.max(ROUND_PLIES, entry.plies.length));
    const parts = entry.plies.slice(0, n).map((p, i) => {
      const num = i % 2 === 0 ? `${i / 2 + 1}. ` : i === 0 ? '1... ' : '';
      const mineSide = (i % 2 === 0 ? 'w' : 'b') === this.me;
      const cls = left && i === left.ply ? 'dr-left' : left && i > left.ply ? 'dr-after' : '';
      const mv = mineSide ? `<b>${esc(p.san)}</b>` : esc(p.san);
      return `<span class="dr-ply ${cls}" data-ply="${i}">${num}${mv}${left && i === left.ply ? ` <span class="dr-you">${left.byYou ? 'you played' : `${sideWord(this.them)} played`} ${esc(left.played)}</span>` : ''}</span>`;
    });
    const why = entry.plies.map((p, i) => ({ p, i })).filter(({ p, i }) => (i % 2 === 0 ? 'w' : 'b') === this.me && p.why && (!left || i >= left.ply)).slice(0, 3);
    const leftTxt = !left ? (this.sans.length >= entry.plies.length ? `You followed the whole line (${entry.plies.length} plies).` : `You followed the line for all ${this.sans.length} moves played.`)
      : left.byYou ? `You left the line at <b>${esc(moveLabel(left.ply, left.played))}</b> — the line plays <b>${esc(moveLabel(left.ply, left.book))}</b>.`
      : `${sideWord(this.them)} left the line at ${esc(moveLabel(left.ply, left.played))} after you had kept to it (the line has ${esc(moveLabel(left.ply, left.book))}).`;
    return `<div class="dr-bookline" id="dr-bookline"><h4>Book line${this.random ? '' : ` for ${sideWord(this.me)}`}: ${esc(entry.name)} <span class="op-eco">${esc(entry.eco)}</span></h4>
      <p class="dr-plies">${parts.join(' ')}</p>
      <p class="small">${leftTxt}</p>
      ${why.length ? `<ul class="small dr-whys">${why.map(({ p, i }) => `<li><b>${esc(moveLabel(i, p.san))}</b> — ${esc(p.why!)}</li>`).join('')}</ul>` : ''}</div>`;
  }

  renderReview(s: ReturnType<typeof summarize>, progress: string, reached: RepEntry, lineLeft: ReturnType<typeof leftLine>) {
    const l = $('#tr-lesson', this.host);
    l.hidden = false;
    const left = s.leftBook;
    const leftTxt = left
      ? `You left book at <b>${esc(left.label)}</b> — ${left.recKind === 'book' ? `book was <b>${esc(left.recSan)}</b>` : `no common move here, engine preferred <b>${esc(left.recSan)}</b>`}.`
      : `You stayed in book for all ${s.moves} moves.`;
    const appLeft = this.appSrc.indexOf('engine');
    const row = (r: ReviewRow, i: number) => `
      <tr class="dr-row dr-${r.verdict}" data-i="${i}" tabindex="0" aria-label="Show ${esc(r.label)} on the board">
        <td class="dr-n">${esc(r.label.split(' ')[0])}</td>
        <td><b>${esc(r.san)}</b></td>
        <td>${r.same ? '<span class="muted">same</span>' : `<b>${esc(r.recSan)}</b>`} <span class="muted small">${r.recKind === 'book' ? 'book' : 'engine'}</span></td>
        <td><span class="dr-v dr-v-${r.verdict}">${VERDICT_LABEL[r.verdict]}</span></td>
        <td class="dr-ev">${esc(fmtEval(r.beforeCp))} → ${esc(fmtEval(r.afterCp))}</td>
      </tr>
      <tr class="dr-why" data-i="${i}"><td colspan="5">${esc(r.reason)}</td></tr>`;
    l.innerHTML = `
      <div class="dr-review" id="dr-review">
        ${this.random ? `<p class="dr-reveal" id="dr-reveal">White played: <b>${esc(reached.name)}</b> <span class="op-eco">${esc(reached.eco)}</span></p>` : ''}
        <h3>Review: how you played vs how you should have played</h3>
        <div class="dr-sum">
          <div class="dr-acc"><b>${s.accuracy}%</b><span>accuracy</span></div>
          <div><b>${s.book}</b><span>book</span></div><div><b>${s.good}</b><span>good</span></div>
          <div><b>${s.inaccuracies}</b><span>inaccurac${s.inaccuracies === 1 ? 'y' : 'ies'}</span></div>
          <div class="${s.mistakes ? 'dr-bad' : ''}"><b>${s.mistakes}</b><span>mistake${s.mistakes === 1 ? '' : 's'}</span></div>
          <div class="${s.blunders ? 'dr-bad' : ''}"><b>${s.blunders}</b><span>blunder${s.blunders === 1 ? '' : 's'}</span></div>
        </div>
        <p class="small">${this.random ? '' : leftTxt}${s.worst ? ` Biggest slip: <b>${esc(s.worst.label)}</b> (${esc(VERDICT_LABEL[s.worst.verdict].toLowerCase())}, ${(s.worst.lossCp / 100).toFixed(1)} pawns).` : ''}</p>
        ${this.o.branching && reached ? `<p class="muted small">Variation reached: ${esc(reached.name)} <span class="op-eco">${esc(reached.eco)}</span>${appLeft >= 0 ? ` · ${sideWord(this.them)} ran out of book after your moves and continued with the engine` : ''}.</p>` : appLeft >= 0 ? `<p class="muted small">${sideWord(this.them)} ran out of book after your moves and continued with the engine.</p>` : ''}
        ${this.bookLine(reached, lineLeft)}
        <div class="dr-tablewrap"><table class="rec dr-table">
          <thead><tr><th>Move</th><th>You played</th><th>Best / book</th><th>Verdict</th><th>Eval (you)</th></tr></thead>
          <tbody>${this.rows.map(row).join('')}</tbody>
        </table></div>
        <p class="muted small">Tap a move to see it on the board: <span class="dr-key dr-key-best">green</span> is the move you should have played, your move is drawn in blue (book or good), yellow (inaccuracy) or red (mistake/blunder). Eval: Stockfish depth ${DEPTH} with the best move → after yours, in pawns from your side. Good loses at most ${(LOSS.good / 100).toFixed(1)}, inaccuracy ${(LOSS.inaccuracy / 100).toFixed(1)}, mistake ${(LOSS.mistake / 100).toFixed(1)}; more is a blunder. Book = played in ${'≥'}5% of games here and Stockfish-sound.</p>
        <details class="op-line"${this.random ? ' open' : ''}><summary>${this.random ? 'The idea of this line' : 'The idea you were facing'}</summary><p>${esc(this.o.family?.idea || this.e.idea)}</p></details>
        <p class="muted small" id="op-mastery">Progress (${this.random ? 'random openings' : 'defending'}): ${esc(progress)}${this.random ? (lineLeft?.byYou || s.mistakes + s.blunders ? ' — it will come up again soon.' : ' — it will come up less often now.') : ''}</p>
        <div class="tr-after">${this.random
          ? `<button class="btn primary" id="dr-drill">Drill this line</button><button class="btn" id="dr-again">Next random opening</button><button class="btn ghost" id="dr-back">All openings</button>`
          : `<button class="btn primary" id="dr-again">Play again</button><button class="btn" id="dr-switch">Switch side: play the opening</button><button class="btn ghost" id="dr-back">All openings</button>`}</div>
      </div>`;
    $('#dr-again', this.host).onclick = () => this.o.onAgain();
    const sw = this.host.querySelector<HTMLButtonElement>(this.random ? '#dr-drill' : '#dr-switch');
    if (sw) sw.onclick = () => this.o.onSwitch();
    $('#dr-back', this.host).onclick = () => this.o.onBack();
    l.querySelectorAll<HTMLElement>('tr[data-i]').forEach((tr) => {
      tr.onclick = () => this.select(+tr.dataset.i!);
      tr.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.select(+tr.dataset.i!); } };
    });
  }

  /** Board at the position before your move, with your move and the recommended one as arrows. */
  select(i: number) {
    const r = this.rows[i];
    if (!r) return;
    this.host.querySelectorAll('.dr-row.on, .dr-why.on').forEach((x) => x.classList.remove('on'));
    this.host.querySelectorAll(`tr[data-i="${i}"]`).forEach((x) => x.classList.add('on'));
    const c = new Chess(r.fen);
    const prev = r.ply > 0 ? this.ucis[r.ply - 1] : null;
    this.cg.set({ fen: r.fen, turnColor: c.turn() === 'w' ? 'white' : 'black', check: c.inCheck() ? (c.turn() === 'w' ? 'white' : 'black') : false, lastMove: prev ? [prev.slice(0, 2) as Key, prev.slice(2, 4) as Key] : undefined, movable: { color: undefined, dests: new Map() } });
    const shapes: { orig: Key; dest: Key; brush: string }[] = [{ orig: r.recUci.slice(0, 2) as Key, dest: r.recUci.slice(2, 4) as Key, brush: 'green' }];
    if (!r.same) shapes.push({ orig: r.uci.slice(0, 2) as Key, dest: r.uci.slice(2, 4) as Key, brush: VERDICT_BRUSH[r.verdict] });
    this.cg.setAutoShapes(shapes);
    $('#tr-board', this.host).setAttribute('aria-label', boardDescription(r.fen));
    $('#op-namebar', this.host).innerHTML = this.random ? this.randomBar(this.fens.slice(0, r.ply + 1)) : nameBar(this.fens.slice(0, r.ply + 1), this.o.book);
    $('#tr-last', this.host).innerHTML = `Move <b>${esc(r.label.split(' ')[0])}</b>: you played <b>${esc(r.san)}</b>${r.same ? ' (the move to play)' : ` · should have played <b>${esc(r.recSan)}</b>`} <span class="dr-v dr-v-${r.verdict}">${VERDICT_LABEL[r.verdict]}</span>`;
  }
}
