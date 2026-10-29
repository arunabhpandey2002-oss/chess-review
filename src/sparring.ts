// "Play it out": play the rest of the game from a critical position against Stockfish at roughly your strength.
// Take back and restart freely. At the end you get the result and up to two engine-checked takeaways.
import { Chess, type Color } from 'chess.js';
import { Chessground } from 'chessground';
import type { Api as CgApi } from 'chessground/api';
import type { Key } from 'chessground/types';
import { EnginePool } from './engine';
import { winPct } from './classify';
import type { MomentCore } from './explain';
import { uciToMove, pvToSan, formatPv } from './tactics';
import { tokMove, renderText } from './words';
import { strengthFor, summarizePlayout, type Outcome, type MyMove, type Strength } from './playout';
import { $, esc, srcChip, dlgHead, reducedMotion, boardDescription, legalDests, parseTyped } from './ui';

interface Ply { uci: string; san: string; fenBefore: string; by: Color }
interface PosInfo { wp: number; bestUci: string | null }

const colorName = (c: Color) => (c === 'w' ? 'white' : 'black');

export interface SparringOpts { core: MomentCore; rating?: number | null; title: string; onClose?: () => void }

export class Sparring {
  o: SparringOpts;
  ov: HTMLElement;
  host: HTMLElement;
  cg!: CgApi;
  me: Color;
  start: string;
  fen: string;
  hist: Ply[] = [];
  gen = 0;
  thinking = false;
  over = false;
  st: Strength;
  play: EnginePool;
  ana: EnginePool;
  cache = new Map<string, Promise<PosInfo>>();
  prevFocus: Element | null;
  onHash = () => this.close();
  onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } };

  constructor(o: SparringOpts) {
    this.o = o;
    this.me = o.core.color;
    this.start = o.core.fenBefore;
    this.fen = this.start;
    this.st = strengthFor(o.rating);
    this.play = new EnginePool(1, this.st.options);
    this.ana = new EnginePool(1);
    this.cache.set(this.start, Promise.resolve({ wp: o.core.wpBest, bestUci: o.core.bestUci }));
    this.prevFocus = document.activeElement;
    this.ov = document.createElement('div');
    this.ov.className = 'overlay sp-overlay';
    this.ov.setAttribute('role', 'dialog');
    this.ov.setAttribute('aria-modal', 'true');
    this.ov.setAttribute('aria-label', `Play it out from move ${o.core.moveNumber}`);
    this.ov.innerHTML = '<div class="overlay-inner"></div>';
    this.host = this.ov.firstElementChild as HTMLElement;
    this.ov.addEventListener('keydown', this.onKey);
    window.addEventListener('hashchange', this.onHash);
    document.body.appendChild(this.ov);
    document.body.classList.add('modal-open');
    this.render();
    (window as any).__sparring = this;
  }

  get nt() { return localStorage.getItem('cr-notation') === '1'; }
  txt(t: string) { return esc(renderText(t, this.nt ? 'san' : 'words')); }

  render() {
    const m = this.o.core;
    const side = this.me === 'w' ? 'White' : 'Black';
    this.host.innerHTML = `
      ${dlgHead(this.o.title, `You are ${side}, from the position before ${esc(m.playedSan)}. Opponent: ${esc(this.st.label)} ${srcChip('estimate')}`, 'sp-close')}
      <div class="trainer sparring">
        <div class="tr-board-col">
          <div class="tr-board-wrap"><div class="tr-board" id="sp-board" role="img" aria-label="${esc(boardDescription(this.start))}"></div></div>
          <form class="tr-type" id="sp-type" autocomplete="off">
            <label for="sp-input">Type a move</label>
            <input id="sp-input" placeholder="e.g. Nf3 or g1f3" spellcheck="false" aria-describedby="sp-status">
            <button class="btn">Play</button>
          </form>
        </div>
        <div class="tr-side">

          <div class="tr-status" id="sp-status" role="status" aria-live="polite"></div>
          <p class="sp-moves muted" id="sp-moves"></p>
          <div class="tr-actions" id="sp-actions">
            <button class="btn" id="sp-back">Take back</button>
            <button class="btn" id="sp-restart">Restart</button>
            <button class="btn ghost" id="sp-resign">Resign</button>
            <button class="btn ghost" id="sp-stop">Stop and review</button>
          </div>
          <div class="sp-end" id="sp-end" hidden></div>
        </div>
      </div>`;
    this.cg = Chessground($('#sp-board', this.host), {
      fen: this.start,
      orientation: colorName(this.me),
      coordinates: true,
      animation: { enabled: !reducedMotion(), duration: 160 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, showDests: true, events: { after: (a, b) => this.onBoardMove(a, b) } },
      draggable: { enabled: true },
      drawable: { enabled: false, visible: true },
      premovable: { enabled: false },
    });
    $('#sp-type', this.host).onsubmit = (e) => {
      e.preventDefault();
      const inp = $<HTMLInputElement>('#sp-input', this.host);
      const uci = parseTyped(this.fen, inp.value);
      if (!uci || this.thinking || this.over) { this.status(uci ? 'Wait for the engine to move.' : `“${esc(inp.value)}” is not a legal move here.`, 'warn'); return; }
      inp.value = '';
      this.myMove(uci);
    };
    $('#sp-back', this.host).onclick = () => this.takeBack();
    $('#sp-restart', this.host).onclick = () => this.restart();
    $('#sp-resign', this.host).onclick = () => this.end('resigned');
    $('#sp-stop', this.host).onclick = () => this.end('stopped');
    $('#sp-close', this.host).onclick = () => this.close();
    this.sync();
    this.status('Your move. Play the rest of the game; take back or restart any time.');
    if (!matchMedia('(pointer: coarse)').matches) ($('#sp-input', this.host) as HTMLElement).focus({ preventScroll: true });
  }

  status(t: string, kind: '' | 'good' | 'warn' | 'bad' = '') {
    const el = $('#sp-status', this.host);
    el.className = `tr-status ${kind}`;
    el.innerHTML = t;
  }

  /** Redraw the board and controls from the current state. */
  sync() {
    const c = new Chess(this.fen);
    const mine = !this.over && !this.thinking && c.turn() === this.me;
    const last = this.hist[this.hist.length - 1];
    this.cg.set({
      fen: this.fen,
      turnColor: colorName(c.turn()),
      check: c.inCheck() ? colorName(c.turn()) : false,
      lastMove: last ? [last.uci.slice(0, 2) as Key, last.uci.slice(2, 4) as Key] : undefined,
      movable: { color: mine ? colorName(this.me) : undefined, dests: mine ? (legalDests(this.fen) as Map<Key, Key[]>) : new Map() },
    });
    $('#sp-board', this.host).setAttribute('aria-label', boardDescription(this.fen));
    $('#sp-moves', this.host).textContent = this.hist.length ? `Moves: ${formatPv(this.start, this.hist.map((h) => h.san))}` : '';
    $<HTMLButtonElement>('#sp-back', this.host).disabled = this.over || !this.hist.some((h) => h.by === this.me);
    $<HTMLButtonElement>('#sp-restart', this.host).disabled = !this.hist.length && !this.over;
    for (const id of ['#sp-resign', '#sp-stop']) $<HTMLButtonElement>(id, this.host).hidden = this.over;
    $('#sp-type', this.host).hidden = this.over;
  }

  onBoardMove(orig: string, dest: string) {
    const c = new Chess(this.fen);
    const p = c.get(orig as any);
    const promo = p?.type === 'p' && (dest[1] === '8' || dest[1] === '1') ? 'q' : '';
    this.myMove(orig + dest + promo);
  }

  apply(uci: string, by: Color): boolean {
    const c = new Chess(this.fen);
    const fenBefore = this.fen;
    const mv = uciToMove(c, uci);
    if (!mv) return false;
    this.hist.push({ uci, san: mv.san, fenBefore, by });
    this.fen = c.fen();
    return true;
  }

  /** Repetition needs the move history, so replay it. */
  outcome(): Outcome | null {
    const c = new Chess(this.start);
    for (const h of this.hist) uciToMove(c, h.uci);
    if (c.isCheckmate()) return c.turn() === this.me ? 'mate-loss' : 'mate-win';
    if (c.isStalemate()) return 'stalemate';
    if (c.isInsufficientMaterial()) return 'insufficient';
    if (c.isThreefoldRepetition()) return 'repetition';
    if (c.isDrawByFiftyMoves()) return 'fifty';
    if (c.isDraw()) return 'draw';
    return null;
  }

  async myMove(uci: string) {
    if (this.over || this.thinking || new Chess(this.fen).turn() !== this.me) return;
    if (!this.apply(uci, this.me)) { this.sync(); return; }
    const h = this.hist[this.hist.length - 1];
    this.info(h.fenBefore); this.info(this.fen); // analyse in the background for the summary
    const o = this.outcome();
    if (o) { this.end(o); return; }
    await this.engineMove();
  }

  async engineMove() {
    const g = ++this.gen;
    this.thinking = true;
    this.sync();
    this.status('Engine is thinking…');
    let best: string | undefined;
    try {
      const ev = await this.play.analyse(this.fen, this.st.depth, 1, this.st.movetime);
      best = ev.best ?? ev.lines[0]?.pv[0];
    } catch { return; }
    if (g !== this.gen || this.over) return; // taken back or restarted meanwhile
    this.thinking = false;
    if (!best || !this.apply(best, this.me === 'w' ? 'b' : 'w')) { this.end('stopped'); return; }
    const h = this.hist[this.hist.length - 1];
    this.sync();
    const o = this.outcome();
    if (o) { this.end(o); return; }
    this.status(`Engine played ${this.txt(tokMove(h.fenBefore, h.san))}. Your move.`);
  }

  takeBack() {
    if (this.over) return;
    this.gen++;
    this.thinking = false;
    while (this.hist.length) {
      const h = this.hist.pop()!;
      this.fen = h.fenBefore;
      if (h.by === this.me) break;
    }
    this.sync();
    this.status('Move taken back. Your move.');
  }

  restart() {
    this.gen++;
    this.thinking = false;
    this.over = false;
    this.hist = [];
    this.fen = this.start;
    $('#sp-end', this.host).hidden = true;
    this.sync();
    this.status('Back to the starting position. Your move.');
  }

  /** Your win% (and the engine's best move) in a position, analysed once and cached. */
  info(fen: string): Promise<PosInfo> {
    let p = this.cache.get(fen);
    if (!p) {
      const c = new Chess(fen);
      if (c.isCheckmate()) p = Promise.resolve({ wp: c.turn() === this.me ? 0 : 100, bestUci: null });
      else if (c.isDraw()) p = Promise.resolve({ wp: 50, bestUci: null });
      else p = this.ana.analyse(fen, 12, 1, 1500).then((ev) => ({ wp: ev.lines[0] ? winPct(ev.lines[0].score, this.me) : 50, bestUci: ev.lines[0]?.pv[0] ?? null }));
      this.cache.set(fen, p);
    }
    return p;
  }

  async end(outcome: Outcome) {
    if (this.over) return;
    this.over = true;
    this.gen++;
    this.thinking = false;
    this.sync();
    const g = this.gen;
    this.status('Game over. Checking your moves with the engine…');
    const el = $('#sp-end', this.host);
    el.hidden = false;
    el.innerHTML = '<p class="muted">Analysing…</p>';
    const mine: MyMove[] = [];
    try {
      for (const h of this.hist) {
        if (h.by !== this.me) continue;
        const [b, a] = await Promise.all([this.info(h.fenBefore), this.info(this.after(h))]);
        const num = h.fenBefore.split(' ')[5];
        const bestSan = b.bestUci ? pvToSan(h.fenBefore, [b.bestUci], 1)[0] : h.san;
        mine.push({ label: `${num}${h.by === 'w' ? '.' : '...'}`, san: tokMove(h.fenBefore, h.san), bestSan: tokMove(h.fenBefore, bestSan), wpBefore: b.wp, wpAfter: a.wp });
      }
      const fin = this.hist.length ? (await this.info(this.fen)).wp : this.o.core.wpBest;
      if (g !== this.gen) return;
      const s = summarizePlayout({ outcome, startWp: this.o.core.wpBest, finalWp: fin, mine });
      el.innerHTML = `
        <h3>${esc(s.result)}</h3>
        <ul class="sp-take">${s.takeaways.map((t) => `<li>${this.txt(t.text)} ${srcChip(t.src)}</li>`).join('')}</ul>
        <div class="tr-after"><button class="btn primary" id="sp-again">Play again from the start</button></div>`;
      $('#sp-again', this.host).onclick = () => this.restart();
      this.status(esc(s.result), outcome === 'mate-win' ? 'good' : outcome === 'mate-loss' || outcome === 'resigned' ? 'bad' : '');
      (window as any).__sparringSummary = s;
    } catch {
      if (g === this.gen) el.innerHTML = '<p class="muted">Could not analyse the game.</p>';
    }
  }

  after(h: Ply): string { const c = new Chess(h.fenBefore); uciToMove(c, h.uci); return c.fen(); }

  close() {
    if (!this.ov.isConnected) return;
    window.removeEventListener('hashchange', this.onHash);
    this.gen++;
    this.cg?.destroy();
    this.play.destroy();
    this.ana.destroy();
    this.ov.remove();
    if (!document.querySelector('.overlay')) document.body.classList.remove('modal-open');
    (window as any).__sparring = null;
    (this.prevFocus as HTMLElement | null)?.focus?.({ preventScroll: true });
    this.o.onClose?.();
  }
}

export function openSparring(o: SparringOpts): Sparring { return new Sparring(o); }
