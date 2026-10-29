// Guided retry: the player tries to find a better move in a critical position, with staged hints.
import { Chess, type Color } from 'chess.js';
import { Chessground } from 'chessground';
import type { Api as CgApi } from 'chessground/api';
import type { Key } from 'chessground/types';
import { EnginePool, type Score } from './engine';
import { winPct, CLS_META } from './classify';
import { judge, type Verdict } from './retry';
import { buildHints, explainMoment, type MomentCore, type Hint } from './explain';
import type { Level } from './moments';
import { MOTIF_INFO, SKILL_LABEL } from './concepts';
import { uciToMove, pvToSan, formatPv } from './tactics';
import { lineItems, renderText } from './words';
import { fmtScore } from './review';
import { $, esc, srcChip, reducedMotion, boardDescription, legalDests, parseTyped } from './ui';

export interface TrainResult { solved: boolean; attempts: number; hints: number; revealed: boolean; close: number; move?: string }
export interface TrainerOpts {
  core: MomentCore;
  level: Level;
  title: string;
  subtitle?: string;
  onResult: (r: TrainResult) => void | Promise<void>;
  onClose?: () => void;
  closeLabel?: string;
  nextLabel?: string;
  onNext?: () => void;
}

const colorName = (c: Color) => (c === 'w' ? 'white' : 'black');
const mateFor = (s: Score, c: Color) => s.mate !== null && s.mate !== 0 && (s.mate > 0) === (c === 'w');

let evalPool: EnginePool | null = null;
function engine(): EnginePool { return (evalPool ??= new EnginePool(1)); }
export function releaseTrainerEngine() { evalPool?.destroy(); evalPool = null; }

export class Trainer {
  host: HTMLElement;
  o: TrainerOpts;
  cg!: CgApi;
  hints: Hint[];
  hintsShown = 0;
  attempts = 0;
  close = 0;
  finished = false;
  busy = false;
  tried = new Map<string, Verdict>();
  playout = 0;
  playFen = '';
  destroyed = false;

  constructor(host: HTMLElement, o: TrainerOpts) {
    this.host = host;
    this.o = o;
    this.hints = buildHints(o.core);
    this.render();
  }

  get side() { return this.o.core.color === 'w' ? 'White' : 'Black'; }

  render() {
    const m = this.o.core;
    this.host.innerHTML = `
      <div class="trainer" role="region" aria-label="Retry this position">
        <div class="tr-board-col">
          <div class="tr-board-wrap"><div class="tr-board" id="tr-board" role="img" aria-label="${esc(boardDescription(m.fenBefore))}"></div></div>
          <form class="tr-type" id="tr-type" autocomplete="off">
            <label for="tr-input">Type a move</label>
            <input id="tr-input" placeholder="e.g. Nf3 or g1f3" spellcheck="false" aria-describedby="tr-status">
            <button class="btn">Play</button>
          </form>
        </div>
        <div class="tr-side">
          <div class="tr-head"><h2>${esc(this.o.title)}</h2>${this.o.subtitle ? `<p class="muted">${esc(this.o.subtitle)}</p>` : ''}</div>
          <p class="tr-task"><b>${this.side} to move.</b> Find a better move than the one played in the game. The evaluation is hidden.</p>
          <div class="tr-status" id="tr-status" role="status" aria-live="polite"></div>
          <div class="tr-hints" id="tr-hints"></div>
          <div class="tr-actions" id="tr-actions">
            <button class="btn" id="tr-hint">Hint (1 of 4)</button>
            <button class="btn ghost" id="tr-reveal">Show answer</button>
            ${this.o.onClose ? `<button class="btn ghost" id="tr-close">${esc(this.o.closeLabel ?? 'Close')}</button>` : ''}
          </div>
          <div class="tr-lesson" id="tr-lesson" hidden></div>
        </div>
      </div>`;
    const anim = !reducedMotion();
    this.cg = Chessground($('#tr-board', this.host), {
      fen: m.fenBefore,
      orientation: colorName(m.color),
      turnColor: colorName(m.color),
      coordinates: true,
      animation: { enabled: anim, duration: 160 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, color: colorName(m.color), dests: legalDests(m.fenBefore) as Map<Key, Key[]>, showDests: true, events: { after: (orig, dest) => this.onBoardMove(orig, dest) } },
      draggable: { enabled: true },
      drawable: { enabled: false, visible: true },
      premovable: { enabled: false },
    });
    $('#tr-type', this.host).onsubmit = (e) => {
      e.preventDefault();
      const inp = $<HTMLInputElement>('#tr-input', this.host);
      const fen = this.playFen || m.fenBefore;
      const uci = parseTyped(fen, inp.value);
      if (!uci) { this.status(`“${inp.value}” is not a legal move here.`, 'warn'); return; }
      inp.value = '';
      if (this.playFen) this.playoutMove(uci); else this.tryMove(uci);
    };
    $('#tr-hint', this.host).onclick = () => this.showHint();
    $('#tr-reveal', this.host).onclick = () => this.reveal();
    if (this.o.onClose) $('#tr-close', this.host).onclick = () => this.o.onClose!();
    this.status(`Drag a piece, click a piece then a square, or type a move. You can try as many times as you like.`);
  }

  destroy() { this.destroyed = true; this.cg?.destroy(); }

  status(text: string, kind: '' | 'good' | 'warn' | 'bad' = '') {
    const el = $('#tr-status', this.host);
    el.className = `tr-status ${kind}`;
    el.innerHTML = text;
  }

  setBoard(fen: string, last?: string) {
    const c = new Chess(fen);
    const moverToPlay = c.turn() === this.o.core.color && !this.finished || (this.playFen && c.turn() === this.o.core.color);
    this.cg.set({
      fen,
      turnColor: colorName(c.turn()),
      check: c.inCheck() ? colorName(c.turn()) : false,
      lastMove: last ? [last.slice(0, 2) as Key, last.slice(2, 4) as Key] : undefined,
      movable: { color: moverToPlay ? colorName(this.o.core.color) : undefined, dests: moverToPlay ? (legalDests(fen) as Map<Key, Key[]>) : new Map() },
    });
    $('#tr-board', this.host).setAttribute('aria-label', boardDescription(fen));
  }

  onBoardMove(orig: string, dest: string) {
    const fen = this.playFen || this.o.core.fenBefore;
    const c = new Chess(fen);
    const p = c.get(orig as any);
    let uci = orig + dest;
    if (p?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
      const best = this.o.core.bestUci;
      uci += best.startsWith(uci) && best.length === 5 ? best[4] : 'q';
    }
    if (this.playFen) this.playoutMove(uci); else this.tryMove(uci);
  }

  async evalCandidate(uci: string): Promise<Score | null> {
    const m = this.o.core;
    const l = m.lines.find((x) => x.pv[0] === uci);
    if (l) return l.score;
    if (uci === m.playedUci && m.reply) return m.reply.score;
    const c = new Chess(m.fenBefore);
    if (!uciToMove(c, uci)) return null;
    if (c.isCheckmate()) return { cp: m.color === 'w' ? 100000 : -100000, mate: m.color === 'w' ? 1 : -1 } as Score;
    if (c.isDraw()) return { cp: 0, mate: null };
    try {
      const ev = await engine().analyse(c.fen(), 16, 1, 4000);
      return ev.lines[0]?.score ?? null;
    } catch { return null; }
  }

  async tryMove(uci: string) {
    if (this.finished || this.busy) return;
    const m = this.o.core;
    const c = new Chess(m.fenBefore);
    const mv = uciToMove(c, uci);
    if (!mv) { this.setBoard(m.fenBefore); return; }
    this.setBoard(c.fen(), uci);
    this.cg.set({ movable: { color: undefined, dests: new Map() } });
    this.busy = true;
    this.attempts++;
    let verdict = this.tried.get(uci);
    if (!verdict) {
      this.status(`Checking ${esc(mv.san)}…`);
      const sc = await this.evalCandidate(uci);
      if (this.destroyed) return;
      if (!sc) { this.busy = false; this.attempts--; this.status('Could not check that move. Try again.', 'warn'); this.setBoard(m.fenBefore); return; }
      verdict = judge({ wpBest: m.wpBest, wpPlayed: m.wpPlayed, wpCand: winPct(sc, m.color), isPlayed: uci === m.playedUci, bestMates: mateFor(m.lines[0].score, m.color), candMates: mateFor(sc, m.color) });
      this.tried.set(uci, verdict);
    }
    this.busy = false;
    if (verdict === 'correct') {
      this.finish(true, uci, mv.san);
      return;
    }
    if (verdict === 'close') this.close++;
    const msg = verdict === 'played' ? `${esc(mv.san)} is the move from the game. Look for something better.`
      : verdict === 'close' ? `${esc(mv.san)} is better than the game move, but there is something stronger. Try again.`
      : `${esc(mv.san)} is not it. Try again${this.hintsShown < 4 ? ', or take a hint' : ''}.`;
    this.status(msg, verdict === 'close' ? 'warn' : 'bad');
    setTimeout(() => { if (!this.finished && !this.destroyed) this.setBoard(m.fenBefore); }, reducedMotion() ? 300 : 900);
  }

  showHint() {
    if (this.finished || this.hintsShown >= 4) return;
    const h = this.hints[this.hintsShown++];
    const el = $('#tr-hints', this.host);
    const nt = localStorage.getItem('cr-notation') === '1';
    const cands = h.candidates?.length
      ? `<div class="tr-cands">${h.candidates.map((u) => { const s = pvToSan(this.o.core.fenBefore, [u], 1)[0]; return `<button class="chip" data-uci="${u}">${esc(s)}</button>`; }).join('')}</div>` : '';
    el.insertAdjacentHTML('beforeend', `<div class="hint"><b>Hint ${h.stage}: ${esc(h.title)}</b> ${srcChip('rules')}<p>${esc(renderText(h.text, nt ? 'san' : 'words'))}</p>${cands}</div>`);
    el.querySelectorAll<HTMLButtonElement>('.chip[data-uci]').forEach((b) => (b.onclick = () => this.tryMove(b.dataset.uci!)));
    if (h.squares?.length) {
      const custom = new Map<Key, string>();
      for (const s of h.squares) custom.set(s as Key, h.stage === 1 ? 'hint-threat' : 'hint-area');
      this.cg.set({ highlight: { custom } });
    }
    const btn = $<HTMLButtonElement>('#tr-hint', this.host);
    if (this.hintsShown >= 4) { btn.disabled = true; btn.textContent = 'No more hints'; } else btn.textContent = `Hint (${this.hintsShown + 1} of 4)`;
    this.status(`Hint ${h.stage} shown.`);
  }

  reveal() {
    if (this.finished) return;
    const m = this.o.core;
    const c = new Chess(m.fenBefore);
    uciToMove(c, m.bestUci);
    this.setBoard(c.fen(), m.bestUci);
    this.finish(false, m.bestUci, m.bestSan, true);
  }

  async finish(solved: boolean, uci: string, san: string, revealed = false) {
    this.finished = true;
    const m = this.o.core;
    const res: TrainResult = { solved, attempts: this.attempts, hints: this.hintsShown, revealed, close: this.close, move: uci };
    this.cg.set({ movable: { color: undefined, dests: new Map() }, highlight: { custom: new Map() } });
    this.cg.setAutoShapes([{ orig: m.bestUci.slice(0, 2) as Key, dest: m.bestUci.slice(2, 4) as Key, brush: 'green' }]);
    const isBest = uci === m.bestUci;
    if (solved) this.status(`✓ ${esc(san)} works${isBest ? '. It is the engine\'s top choice' : `. The engine's top choice was ${esc(m.bestSan)}, but yours is good enough`}. Solved in ${this.attempts} ${this.attempts === 1 ? 'try' : 'tries'}${this.hintsShown ? ` with ${this.hintsShown} hint${this.hintsShown > 1 ? 's' : ''}` : ''}.`, 'good');
    else this.status(`The answer is ${esc(m.bestSan)}. This position will come back soon so you can try it again.`, 'warn');
    $('#tr-hint', this.host).hidden = true;
    $('#tr-reveal', this.host).hidden = true;
    $('#tr-type', this.host).hidden = true;
    this.drawLesson(uci);
    await this.o.onResult(res);
  }

  drawLesson(movedUci: string) {
    const m = this.o.core;
    const nt = localStorage.getItem('cr-notation') === '1';
    const lesson = explainMoment(m, this.o.level);
    const best = m.lines[0];
    const lineText = nt ? esc(formatPv(m.fenBefore, pvToSan(m.fenBefore, best.pv, lesson.linePlies)))
      : `<ol class="pvw">${lineItems(m.fenBefore, best.pv, lesson.linePlies).map((t) => `<li>${esc(t)}</li>`).join('')}</ol>`;
    const replyText = m.reply ? (nt ? esc(formatPv(m.fenAfter, pvToSan(m.fenAfter, m.reply.pv, lesson.linePlies))) : `<ol class="pvw">${lineItems(m.fenAfter, m.reply.pv, lesson.linePlies).map((t) => `<li>${esc(t)}</li>`).join('')}</ol>`) : '';
    const t = m.tags.primary;
    const cm = CLS_META[m.cls as keyof typeof CLS_META] ?? CLS_META.mistake;
    const el = $('#tr-lesson', this.host);
    el.hidden = false;
    el.innerHTML = `
      <div class="lesson-tags"><span class="tag">${esc(MOTIF_INFO[t.motif].name)}</span><span class="tag">${esc(SKILL_LABEL[t.skill])}</span><span class="tag cls" style="background:${cm.color};color:${cm.fg}">${cm.icon} ${esc(cm.label)}</span> ${srcChip('formula')}</div>
      ${lesson.sections.map((s) => `<div class="lsec"><h3>${esc(s.label)} ${srcChip(s.src)}</h3><p>${esc(renderText(s.text, nt ? 'san' : 'words'))}</p></div>`).join('')}
      <div class="lsec"><h3>Best line ${srcChip('engine')}</h3>${lineText}</div>
      ${replyText ? `<div class="lsec"><h3>What happens after ${esc(m.playedSan)} ${srcChip('engine')}</h3>${replyText}</div>` : ''}
      <div class="tr-after">
        <button class="btn" id="tr-playout">Play it out against the engine</button>
        ${this.o.onNext ? `<button class="btn primary" id="tr-next">${esc(this.o.nextLabel ?? 'Next')}</button>` : ''}
      </div>`;
    $('#tr-playout', this.host).onclick = () => this.startPlayout(movedUci);
    if (this.o.onNext) $('#tr-next', this.host).onclick = () => this.o.onNext!();
  }

  // ---- play-out: a few moves against the engine from the solution ----
  async startPlayout(uci: string) {
    const btn = $<HTMLButtonElement>('#tr-playout', this.host);
    btn.disabled = true;
    const c = new Chess(this.o.core.fenBefore);
    uciToMove(c, uci);
    this.playFen = c.fen();
    this.playout = 0;
    this.cg.setAutoShapes([]);
    $('#tr-type', this.host).hidden = false;
    await this.engineReply();
  }

  async engineReply() {
    const c = new Chess(this.playFen);
    if (c.isGameOver()) { this.endPlayout(c); return; }
    this.status('Engine is thinking…');
    let ev;
    try { ev = await engine().analyse(this.playFen, 12, 1, 2000); } catch { return; }
    if (this.destroyed) return;
    const u = ev.lines[0]?.pv[0];
    if (!u) { this.endPlayout(c); return; }
    const mv = uciToMove(c, u)!;
    this.playFen = c.fen();
    this.setBoard(this.playFen, u);
    if (c.isGameOver()) { this.endPlayout(c); return; }
    this.status(`Engine played ${esc(mv.san)}. Your move (${3 - this.playout} left in this play-out).`);
  }

  async playoutMove(uci: string) {
    const c = new Chess(this.playFen);
    const mv = uciToMove(c, uci);
    if (!mv) { this.setBoard(this.playFen); return; }
    this.playFen = c.fen();
    this.setBoard(this.playFen, uci);
    this.playout++;
    if (c.isGameOver() || this.playout >= 3) { this.endPlayout(c); return; }
    await this.engineReply();
  }

  async endPlayout(c: Chess) {
    this.cg.set({ movable: { color: undefined, dests: new Map() } });
    $('#tr-type', this.host).hidden = true;
    let txt = 'Play-out finished.';
    if (c.isCheckmate()) txt = `Checkmate. ${c.turn() === this.o.core.color ? 'The engine won.' : 'You won.'}`;
    else if (c.isDraw()) txt = 'The play-out ended in a draw.';
    else {
      try {
        const ev = await engine().analyse(c.fen(), 14, 1, 3000);
        const s = ev.lines[0]?.score;
        if (s) txt = `Play-out finished. Engine evaluation now: ${fmtScore(s)} ${srcChip('engine')}`;
      } catch { /* ignore */ }
    }
    this.playFen = '';
    this.status(txt);
    const btn = $<HTMLButtonElement>('#tr-playout', this.host);
    if (btn) { btn.disabled = false; btn.textContent = 'Play it out again'; }
  }
}
