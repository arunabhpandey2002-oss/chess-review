// Openings: a library of the openings you meet, practice of one sound reply line per opening (spaced repetition
// per opening), and which openings you face most in your own games.
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
import { OPENINGS, REPERTOIRE, openingById, moveText, moveLabel, judgeMove, wrongText, facedStats, progressKey, type RepEntry, type OpeningProgress, type FacedRow, type GameLike } from './repertoire';
import type { Ctx } from './pages';

export interface OpeningsCtx extends Ctx { games: () => GameSummary[]; book: () => Promise<Book | null>; loadGames: () => Promise<void> }

const STATUS_LABEL: Record<ReturnType<typeof srsStatus>, string> = { new: 'Not practised', due: 'Due', learning: 'Learning', scheduled: 'Learning', mastered: 'Mastered' };
const sideWord = (s: 'w' | 'b') => (s === 'w' ? 'White' : 'Black');

async function loadProgress(pk: string): Promise<Map<string, OpeningProgress>> {
  const m = new Map<string, OpeningProgress>();
  for (const o of OPENINGS) {
    try { const p = await store.get<OpeningProgress>('meta', progressKey(pk, o.id)); if (p?.srs) m.set(o.id, p); } catch { /* no IndexedDB */ }
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
export async function renderOpenings(ctx: OpeningsCtx, id: string | null) {
  destroyDrill();
  const entry = openingById(id);
  if (entry) return renderDrill(ctx, entry);
  document.title = 'Openings · rook-i.e. mistakes';
  const now = Date.now();
  const prog = await loadProgress(ctx.pk);
  const due = OPENINGS.filter((o) => { const p = prog.get(o.id); return p && isDue(p.srs, now); });
  const card = (o: RepEntry) => {
    const st = statusOf(prog.get(o.id), now);
    const resp = o.plies.map((p, i) => ({ p, i })).filter(({ p, i }) => p.mine && i >= o.idPlies - 1 && p.why);
    return `<article class="card op-card" id="op-${esc(o.id)}" data-op="${esc(o.id)}">
      <div class="op-top"><h3>${esc(o.name)} <span class="op-eco">${esc(o.eco)}</span></h3><span class="op-status op-${st.cls}">${esc(st.text)}</span></div>
      <p class="op-moves">${esc(moveText(o.plies.slice(0, o.idPlies)))}</p>
      <p class="op-idea">${esc(o.idea)}</p>
      <details class="op-line"><summary>Your line as ${sideWord(o.side)} (${o.plies.length - o.idPlies} moves after ${esc(moveText(o.plies.slice(0, o.idPlies)).split(' ').slice(-1)[0])})</summary>
        <p class="op-full">${esc(moveText(o.plies))}</p>
        <ul>${resp.map(({ p, i }) => `<li><b>${esc(moveLabel(i, p.san))}</b> — ${esc(p.why!)}</li>`).join('')}</ul>
        <p class="muted small">Ends in: ${esc(o.endsIn)} · Stockfish: ${o.endEvalCp >= 0 ? '+' : ''}${(o.endEvalCp / 100).toFixed(1)} for you</p>
      </details>
      <div class="op-actions"><button class="btn primary" data-practice="${esc(o.id)}">Practise</button></div>
    </article>`;
  };
  ctx.app.innerHTML = `
    <section class="page openings">
      <div class="page-head"><h1>Openings</h1><span class="muted">${OPENINGS.length} openings · ${due.length ? `${due.length} due for practice` : 'practise any of them'}</span></div>
      <div class="card" id="op-faced"><h2>Openings you face most</h2><p class="muted">Looking through your games…</p></div>
      ${due.length ? `<div class="card op-due"><b>Due now:</b> ${due.map((o) => `<button class="chip" data-practice="${esc(o.id)}">${esc(o.name)}</button>`).join(' ')}</div>` : ''}
      <h2 class="op-group">When you're Black</h2>
      <p class="muted small">The opponent opens; you learn a sound reply.</p>
      <div class="op-grid">${OPENINGS.filter((o) => o.side === 'b').map(card).join('')}</div>
      <h2 class="op-group">When you're White</h2>
      <p class="muted small">You play 1.e4 or 1.d4; you learn what to do against each defence.</p>
      <div class="op-grid">${OPENINGS.filter((o) => o.side === 'w').map(card).join('')}</div>
      <p class="muted small op-src">Names and ECO codes: ${esc(REPERTOIRE.meta.sources.names)}. Moves: ${esc(REPERTOIRE.meta.sources.moves)}. ${esc(REPERTOIRE.meta.sources.check)}.</p>
    </section>`;
  const wire = (root: ParentNode) => root.querySelectorAll<HTMLButtonElement>('[data-practice]').forEach((b) => (b.onclick = () => ctx.navigate({ view: 'openings', o: b.dataset.practice! })));
  wire(ctx.app);
  await ctx.loadGames();
  const [games, book] = await Promise.all([myGames(ctx), ctx.book()]);
  const el = document.getElementById('op-faced');
  if (!el) return;
  const rows = facedStats(games, book).slice(0, 10);
  el.innerHTML = `<h2>Openings you face most</h2>${rows.length ? `
    <p class="muted small">From ${games.length} of your games. Score counts a win as 1 and a draw as ½.</p>
    <table class="rec op-faced"><thead><tr><th>Opening</th><th>You</th><th>Games</th><th>Score</th><th></th></tr></thead><tbody>
    ${rows.map((r: FacedRow) => `<tr class="${r.struggling ? 'op-struggle' : ''}" data-faced="${esc(r.key)}">
      <td>${esc(r.label)} <span class="op-eco">${esc(r.eco)}</span>${r.struggling ? ' <span class="op-flag">You struggle here</span>' : ''}</td>
      <td>${sideWord(r.myColor)}</td><td>${r.games}</td>
      <td>${Math.round(r.score * 100)}% <span class="muted small">(${r.wins}W ${r.draws}D ${r.losses}L)</span></td>
      <td>${r.entry ? `<button class="btn small" data-practice="${esc(r.entry.id)}">Practise</button>` : '<span class="muted small">no line yet</span>'}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">No games found yet. Open the Games tab to load your games, then come back.</p>'}`;
  wire(el);
}

// ---------------- practice ----------------
let drill: Drill | null = null;
export function destroyDrill() { drill?.destroy(); drill = null; }

async function renderDrill(ctx: OpeningsCtx, e: RepEntry) {
  document.title = `${e.name} · Openings · rook-i.e. mistakes`;
  ctx.app.innerHTML = `<section class="page train openings-train"><div class="page-head"><h1>Practise: ${esc(e.name)}</h1><button class="btn ghost" id="op-back">‹ All openings</button></div><div id="op-host"></div></section>`;
  $('#op-back').onclick = () => ctx.navigate({ view: 'openings', o: null });
  const key = progressKey(ctx.pk, e.id);
  drill = new Drill($('#op-host'), e, {
    onDone: async (r) => {
      const now = Date.now();
      let prev: OpeningProgress | undefined;
      try { prev = await store.get<OpeningProgress>('meta', key); } catch { /* no IndexedDB */ }
      const srs: SrsState = schedule(prev?.srs ?? newSrs(now), r, now);
      const next: OpeningProgress = { key, profileKey: ctx.pk, openingId: e.id, srs };
      try { await store.put('meta', next); } catch { /* storage unavailable: progress isn't saved */ }
      return statusOf(next, now).text;
    },
    onNext: () => {
      const now = Date.now();
      void loadProgress(ctx.pk).then((p) => {
        const nxt = OPENINGS.find((o) => o.id !== e.id && p.get(o.id) && isDue(p.get(o.id)!.srs, now)) ?? OPENINGS.find((o) => o.id !== e.id && !p.get(o.id));
        ctx.navigate({ view: 'openings', o: nxt ? nxt.id : null });
      });
    },
    onAgain: () => { destroyDrill(); void renderDrill(ctx, e); },
  });
}

interface DrillResult { solved: boolean; attempts: number; hints: number; revealed: boolean }

class Drill {
  cg!: CgApi;
  i = 0;
  wrong = 0;
  hints = 0;
  hintStage = 0;
  revealed = false;
  done = false;
  timer: number | null = null;
  destroyed = false;
  constructor(public host: HTMLElement, public e: RepEntry, public o: { onDone: (r: DrillResult) => Promise<string>; onNext: () => void; onAgain: () => void }) {
    this.render();
    this.advance();
  }

  get color() { return this.e.side === 'w' ? 'white' : 'black'; }

  render() {
    const e = this.e;
    this.host.innerHTML = `
      <div class="trainer op-drill" role="region" aria-label="Practise this opening">
        <div class="tr-board-col">
          <p class="tr-last" id="tr-last" aria-live="polite"></p>
          <div class="tr-board-wrap"><div class="tr-board" id="tr-board" role="img"></div></div>
          <form class="tr-type" id="tr-type" autocomplete="off">
            <label for="tr-input">Type a move</label>
            <input id="tr-input" placeholder="e.g. Nf6 or g8f6" spellcheck="false" aria-describedby="tr-status">
            <button class="btn">Play</button>
          </form>
        </div>
        <div class="tr-side">
          <div class="tr-head"><h2>${esc(e.name)} <span class="op-eco">${esc(e.eco)}</span></h2><p class="muted">You play ${sideWord(e.side)}. The app plays the other side's most common moves.</p></div>
          <p class="tr-task" id="op-task"></p>
          <p class="op-progress" id="op-progress"></p>
          <div class="tr-status" id="tr-status" role="status" aria-live="polite"></div>
          <div class="tr-hints" id="tr-hints"></div>
          <div class="tr-actions" id="tr-actions">
            <button class="btn" id="tr-hint">Hint (1 of 3)</button>
            <button class="btn ghost" id="tr-reveal">Show answer</button>
          </div>
          <details class="op-line"><summary>The idea</summary><p>${esc(e.idea)}</p></details>
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
      <div class="tr-after"><button class="btn primary" id="op-next">Next opening</button><button class="btn" id="op-again">Practise again</button></div>`;
    $('#op-next', this.host).onclick = () => this.o.onNext();
    $('#op-again', this.host).onclick = () => this.o.onAgain();
    this.status(`✓ Line complete: ${esc(moveText(this.e.plies))}`, 'good');
  }
}
