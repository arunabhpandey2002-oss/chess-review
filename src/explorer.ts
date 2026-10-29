// "Why is this best?" explorer: best move vs the game move, step through both engine lines,
// tap questions, or try any move and get the engine's answer. Engine + board facts only.
import { Chess, type Color } from 'chess.js';
import { Chessground } from 'chessground';
import type { Api as CgApi } from 'chessground/api';
import type { Key } from 'chessground/types';
import type { DrawShape } from 'chessground/draw';
import { EnginePool, type PosEval } from './engine';
import { buildExplore, stepLine, whatIf, type Explore, type Fact, type Side, type Step } from './explore';
import { fmtScore } from './review';
import { renderText, tokMove } from './words';
import { pvToSan } from './tactics';
import { $, esc, srcChip, reducedMotion, boardDescription, legalDests, parseTyped } from './ui';

export interface ExplorerOpts {
  fen: string; playedUci: string; label: string; // e.g. "16.c3"
  me: Color; before: PosEval; after: PosEval | null; orientation: Color;
}
const colorName = (c: Color) => (c === 'w' ? 'white' : 'black');
const pct = (x: number) => `${Math.round(x)}%`;

export class Explorer {
  o: ExplorerOpts; x: Explore; ov: HTMLElement; host: HTMLElement; cg!: CgApi;
  steps: Step[] = []; which: 'best' | 'played' | null = null; i = 0;
  tryFen: string | null = null; tryGen = 0; pool: EnginePool | null = null;
  cache = new Map<string, Promise<PosEval>>();
  prevFocus: Element | null;
  onHash = () => this.close();
  onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); this.close(); return; }
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'ArrowRight' && this.which) { e.preventDefault(); e.stopPropagation(); this.go(this.i + 1); }
    if (e.key === 'ArrowLeft' && this.which) { e.preventDefault(); e.stopPropagation(); this.go(this.i - 1); }
  };

  constructor(o: ExplorerOpts, x: Explore) {
    this.o = o; this.x = x;
    this.prevFocus = document.activeElement;
    this.ov = document.createElement('div');
    this.ov.className = 'overlay sp-overlay ex-overlay';
    this.ov.setAttribute('role', 'dialog');
    this.ov.setAttribute('aria-modal', 'true');
    this.ov.setAttribute('aria-label', `Explore ${o.label}`);
    this.ov.innerHTML = '<div class="overlay-inner"></div>';
    this.host = this.ov.firstElementChild as HTMLElement;
    this.ov.addEventListener('keydown', this.onKey);
    window.addEventListener('hashchange', this.onHash);
    document.body.appendChild(this.ov);
    document.body.classList.add('modal-open');
    this.render();
    (window as any).__explorer = this;
  }

  get nt() { return localStorage.getItem('cr-notation') === '1'; }
  txt(t: string) { return esc(renderText(t, this.nt ? 'san' : 'words')); }
  san(t: string) { return esc(renderText(t, 'san')); }
  fact(f: Fact) { return `<li>${this.txt(f.text)} ${srcChip(f.src)}</li>`; }
  get mover() { return this.x.mover; }
  get you() { return this.mover === this.o.me; }
  get sideWord() { return this.mover === 'w' ? 'White' : 'Black'; }

  col(s: Side, kind: 'best' | 'played') {
    const facts = s.facts.length ? s.facts : ['no direct threat, capture or defence: it is a quiet move'];
    const left = [...s.left.still, ...s.left.created];
    return `<div class="ex-col ex-${kind}">
      <h3>${kind === 'best' ? '★ Best: ' : this.you ? 'Your move: ' : 'Game move: '}<b>${this.san(s.tok)}</b> <span class="muted">${fmtScore(s.score)} · ${pct(s.wp)} ${srcChip('engine')}</span></h3>
      <p class="ex-k">What it does ${srcChip('rules')}</p>
      <ul>${facts.map((f) => `<li>${this.txt(f.charAt(0).toUpperCase() + f.slice(1))}.</li>`).join('')}</ul>
      ${left.length ? `<p class="ex-k">Still under attack afterwards ${srcChip('rules')}</p><ul>${left.slice(0, 2).map((f) => `<li>${this.txt(f.charAt(0).toUpperCase() + f.slice(1))}.</li>`).join('')}</ul>` : ''}
      ${s.reply ? `<p class="ex-k">Their best reply ${srcChip('engine')}</p><p>${this.san(s.reply.tok)}${s.reply.facts.length ? `: ${this.txt(s.reply.facts.slice(0, 2).join('; '))}` : ''}.</p>` : ''}
      <button class="btn small" data-line="${kind}">Step through this line</button>
    </div>`;
  }

  render() {
    const x = this.x;
    const title = x.same ? `Explore ${this.o.label}` : `Why is ${renderText(x.best.tok, 'san')} best?`;
    this.host.innerHTML = `
      <div class="trainer explorer">
        <div class="tr-board-col">
          <div class="tr-board-wrap"><div class="tr-board" id="ex-board" role="img" aria-label="${esc(boardDescription(x.fen))}"></div></div>
          <div class="ex-stepper" id="ex-stepper">
            <button class="btn" id="ex-prev" aria-label="Previous move">◀</button>
            <span id="ex-pos" class="muted"></span>
            <button class="btn" id="ex-next" aria-label="Next move">▶</button>
            <button class="btn ghost" id="ex-reset">Back to position</button>
          </div>
          <p class="ex-steptext" id="ex-steptext" role="status" aria-live="polite"></p>
          <form class="tr-type" id="ex-type" autocomplete="off">
            <label for="ex-input">Try a move</label>
            <input id="ex-input" placeholder="e.g. Rf1" spellcheck="false">
            <button class="btn">Try</button>
          </form>
        </div>
        <div class="tr-side">
          <div class="tr-head"><h2>${esc(title)}</h2>
            <p class="muted">${esc(this.o.label)} · ${this.you ? 'Your move' : 'Their move'} (${this.sideWord}). Scores and win chances are from ${this.sideWord}'s side.</p></div>
          <p class="ex-verdict" id="ex-verdict">${this.txt(x.verdict.text)} ${srcChip(x.verdict.src)}</p>
          ${x.same ? `<div class="ex-cols">${this.col(x.best, 'best')}</div>` : `<div class="ex-cols">${this.col(x.best, 'best')}${this.col(x.played, 'played')}</div>
          ${x.compare.length ? `<h3 class="ex-h">Why ${this.san(x.best.tok)} is better</h3><ul class="ex-compare" id="ex-compare">${x.compare.map((f) => this.fact(f)).join('')}</ul>` : ''}`}
          <h3 class="ex-h">Ask</h3>
          <div class="ex-qs" id="ex-qs">
            <button class="chip" data-q="threat">What was the threat?</button>
            ${x.same ? '' : `<button class="chip" data-q="mine">Why not ${this.san(x.played.tok)}?</button>`}
            <button class="chip" data-q="reply">What does their reply do?</button>
            <button class="chip" data-q="other">Why not another move?</button>
          </div>
          <div class="ex-answer" id="ex-answer" role="status" aria-live="polite"><p class="muted">Tap a question, step through a line, or play any move on the board to see the engine's answer.</p></div>
          <div class="tr-actions"><button class="btn ghost" id="ex-close">Close</button></div>
        </div>
      </div>`;
    this.cg = Chessground($('#ex-board', this.host), {
      fen: x.fen, orientation: colorName(this.o.orientation), coordinates: true,
      animation: { enabled: !reducedMotion(), duration: 160 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, showDests: true, events: { after: (a, b) => this.onBoardMove(a, b) } },
      draggable: { enabled: true }, drawable: { enabled: false, visible: true }, premovable: { enabled: false },
    });
    this.host.querySelectorAll<HTMLButtonElement>('[data-line]').forEach((b) => (b.onclick = () => this.line(b.dataset.line as 'best' | 'played')));
    this.host.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) => (b.onclick = () => this.ask(b.dataset.q!)));
    $('#ex-prev', this.host).onclick = () => this.go(this.i - 1);
    $('#ex-next', this.host).onclick = () => this.go(this.i + 1);
    $('#ex-reset', this.host).onclick = () => this.reset();
    $('#ex-close', this.host).onclick = () => this.close();
    $('#ex-type', this.host).onsubmit = (e) => {
      e.preventDefault();
      const inp = $<HTMLInputElement>('#ex-input', this.host);
      const uci = parseTyped(x.fen, inp.value);
      if (!uci) { this.answer(`<p class="warn">“${esc(inp.value)}” is not a legal move in the starting position.</p>`); return; }
      inp.value = '';
      this.tryMove(uci);
    };
    this.reset();
    ($('#ex-close', this.host) as HTMLElement).focus({ preventScroll: true });
  }

  answer(html: string) { $('#ex-answer', this.host).innerHTML = html; }

  /** Starting position with the best move (green) and the game move (blue) drawn. */
  reset() {
    this.which = null; this.i = 0; this.steps = []; this.tryFen = null; this.tryGen++;
    const c = new Chess(this.x.fen);
    const shapes: DrawShape[] = [{ orig: this.x.best.uci.slice(0, 2) as Key, dest: this.x.best.uci.slice(2, 4) as Key, brush: 'green' }];
    if (!this.x.same) shapes.push({ orig: this.x.played.uci.slice(0, 2) as Key, dest: this.x.played.uci.slice(2, 4) as Key, brush: 'blue' });
    this.cg.set({
      fen: this.x.fen, turnColor: colorName(c.turn()), lastMove: undefined, check: c.inCheck() ? colorName(c.turn()) : false,
      movable: { color: colorName(c.turn()), dests: legalDests(this.x.fen) as Map<Key, Key[]> },
    });
    this.cg.setAutoShapes(shapes);
    $('#ex-board', this.host).setAttribute('aria-label', boardDescription(this.x.fen));
    $('#ex-pos', this.host).textContent = 'Start';
    $('#ex-steptext', this.host).innerHTML = this.x.same
      ? `Green arrow: ${this.txt(this.x.best.tok)}, the engine's choice. Play any move to compare.`
      : `Green arrow: ${this.txt(this.x.best.tok)} (best). Blue arrow: ${this.txt(this.x.played.tok)} (${this.you ? 'your move' : 'the game move'}). Pick a line to step through, or play any move.`;
    this.buttons();
  }

  buttons() {
    $<HTMLButtonElement>('#ex-prev', this.host).disabled = !this.which || this.i <= 0;
    $<HTMLButtonElement>('#ex-next', this.host).disabled = !this.which || this.i >= this.steps.length;
    $<HTMLButtonElement>('#ex-reset', this.host).disabled = !this.which && !this.tryFen;
    this.host.querySelectorAll<HTMLButtonElement>('[data-line]').forEach((b) => b.classList.toggle('on', b.dataset.line === this.which));
  }

  line(which: 'best' | 'played') {
    this.reset();
    this.which = which;
    const s = which === 'best' ? this.x.best : this.x.played;
    this.steps = stepLine(this.x.fen, s.line, this.mover, 6);
    this.go(1);
  }

  go(i: number) {
    if (!this.which) return;
    this.i = Math.max(0, Math.min(this.steps.length, i));
    const st = this.i ? this.steps[this.i - 1] : null;
    const fen = st ? st.fenAfter : this.x.fen;
    const c = new Chess(fen);
    this.cg.set({ fen, lastMove: st ? [st.uci.slice(0, 2) as Key, st.uci.slice(2, 4) as Key] : undefined, check: c.inCheck() ? colorName(c.turn()) : false, turnColor: colorName(c.turn()), movable: { color: undefined, dests: new Map() } });
    const next = this.steps[this.i];
    const shapes: DrawShape[] = [];
    if (st) shapes.push({ orig: st.uci.slice(0, 2) as Key, dest: st.uci.slice(2, 4) as Key, brush: new Chess(st.fenBefore).turn() === this.mover ? 'green' : 'red' });
    if (next) shapes.push({ orig: next.uci.slice(0, 2) as Key, dest: next.uci.slice(2, 4) as Key, brush: 'paleBlue' });
    this.cg.setAutoShapes(shapes);
    $('#ex-board', this.host).setAttribute('aria-label', boardDescription(fen));
    const name = this.which === 'best' ? 'Best line' : this.you ? 'Your line' : 'Game line';
    $('#ex-pos', this.host).textContent = `${name} · ${this.i}/${this.steps.length}`;
    $('#ex-steptext', this.host).innerHTML = st ? `<b>${esc(st.san)}</b> — ${this.txt(st.text)} ${srcChip('rules')}${this.i === this.steps.length ? ' <span class="muted">End of the engine line.</span>' : ''}` : 'Start of the line.';
    this.buttons();
  }

  ask(q: string) {
    const x = this.x;
    this.host.querySelectorAll('[data-q]').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.q === q));
    const ul = (fs: Fact[]) => `<ul>${fs.map((f) => this.fact(f)).join('')}</ul>`;
    if (q === 'threat') {
      const fs: Fact[] = [x.threat];
      const sq = /on ([a-h][1-8])/.exec(x.threat.text)?.[1];
      if (sq && !x.same) {
        const handled = (s: Side) => !s.left.still.some((t) => t.includes(` on ${sq}`)) && !s.left.created.some((t) => t.includes(` on ${sq}`));
        fs.push({ text: `${x.best.tok} ${handled(x.best) ? 'deals with it' : 'does not deal with it'}; ${x.played.tok} ${handled(x.played) ? 'deals with it' : 'does not'}.`, src: 'rules' });
      }
      this.answer(`<h4>What was the threat?</h4>${ul(fs)}`);
    } else if (q === 'mine') {
      const p = x.played;
      const fs: Fact[] = [];
      fs.push({ text: `${p.tok} ${p.facts.length ? p.facts.slice(0, 2).join('; ').replace(/^it /, '') : 'is a quiet move with no direct threat'}.`, src: 'rules' });
      for (const t of [...p.left.still, ...p.left.created].slice(0, 2)) fs.push({ text: `Afterwards, ${t}.`, src: 'rules' });
      if (p.reply) fs.push({ text: `The engine answers ${p.reply.tok}${p.reply.facts.length ? `: ${p.reply.facts.slice(0, 2).join('; ')}` : ''}.`, src: 'engine' });
      fs.push(x.verdict);
      this.answer(`<h4>Why not ${this.san(p.tok)}?</h4>${ul(fs)}<button class="btn small" data-line2="played">Step through it</button>`);
      $('[data-line2]', this.host).onclick = () => this.line('played');
    } else if (q === 'reply') {
      const fs: Fact[] = [];
      const r = (s: Side, label: string) => s.reply && fs.push({ text: `After ${label}, they play ${s.reply.tok}${s.reply.facts.length ? `: ${s.reply.facts.slice(0, 2).join('; ')}` : ' (a quiet move)'}.`, src: 'engine' });
      r(x.best, x.best.tok);
      if (!x.same) r(x.played, x.played.tok);
      if (!fs.length) fs.push({ text: 'The engine line has no reply here.', src: 'engine' });
      this.answer(`<h4>What does their reply do?</h4>${ul(fs)}`);
    } else {
      const alts = x.alternatives.filter((a) => a.uci !== x.played.uci);
      this.answer(`<h4>Why not another move?</h4>
        <p>Play any move on the board (or type it) and the engine will answer. The engine's other top choices here:</p>
        <div class="ex-alts">${alts.map((a) => `<button class="chip" data-try="${a.uci}">${this.san(a.tok)} <span class="muted">${fmtScore(a.score)} · ${pct(a.wp)}</span></button>`).join('') || '<span class="muted">None stored.</span>'}</div> ${srcChip('engine')}`);
      this.host.querySelectorAll<HTMLButtonElement>('[data-try]').forEach((b) => (b.onclick = () => this.tryMove(b.dataset.try!)));
    }
  }

  onBoardMove(orig: string, dest: string) {
    const c = new Chess(this.x.fen);
    const p = c.get(orig as any);
    const promo = p?.type === 'p' && (dest[1] === '8' || dest[1] === '1') ? 'q' : '';
    this.tryMove(orig + dest + promo);
  }

  evalOf(fen: string, uci: string): Promise<PosEval> {
    const known = this.x.alternatives.find((a) => a.uci === uci);
    const line = this.o.before.lines.find((l) => l.pv[0] === uci);
    if (known && line) return Promise.resolve({ depth: line.depth ?? this.o.before.depth, lines: [{ ...line, pv: line.pv.slice(1) }] } as PosEval);
    if (!this.cache.has(fen)) {
      this.pool ??= new EnginePool(1);
      this.cache.set(fen, this.pool.analyse(fen, 16, 1));
    }
    return this.cache.get(fen)!;
  }

  async tryMove(uci: string) {
    const c = new Chess(this.x.fen);
    let mv;
    try { mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { mv = null; }
    if (!mv) { this.reset(); return; }
    this.which = null; this.steps = []; this.i = 0;
    const g = ++this.tryGen;
    this.tryFen = c.fen();
    const tok = tokMove(this.x.fen, mv.san);
    this.cg.set({ fen: this.tryFen, lastMove: [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key], turnColor: colorName(c.turn()), check: c.inCheck() ? colorName(c.turn()) : false, movable: { color: undefined, dests: new Map() } });
    this.cg.setAutoShapes([]);
    $('#ex-pos', this.host).textContent = `Trying ${mv.san}`;
    $('#ex-steptext', this.host).innerHTML = `You tried ${this.txt(tok)}. Press “Back to position” to try another.`;
    this.buttons();
    this.answer(`<h4>What if ${esc(mv.san)}?</h4><p class="muted">Engine is thinking…</p>`);
    try {
      const ev = await this.evalOf(this.tryFen, uci);
      if (g !== this.tryGen) return;
      const w = whatIf(this.x.fen, uci, ev, this.x.best.wp);
      if (!w) return;
      const r = ev.lines[0]?.pv[0];
      if (r) this.cg.setAutoShapes([{ orig: r.slice(0, 2) as Key, dest: r.slice(2, 4) as Key, brush: 'red' }]);
      this.answer(`<h4>What if ${esc(mv.san)}?</h4><ul>${w.facts.map((f) => this.fact(f)).join('')}</ul>${r ? '<p class="muted small">Red arrow: their best reply.</p>' : ''}<button class="btn small" id="ex-back2">Back to position</button>`);
      $('#ex-back2', this.host).onclick = () => this.reset();
      const rs = r ? pvToSan(this.tryFen, [r], 1)[0] : '';
      $('#ex-steptext', this.host).innerHTML = `${this.txt(tok)}: ${w.score ? `${fmtScore(w.score)}, ${pct(w.wp)} win chance (best ${pct(this.x.best.wp)})` : esc(w.facts[0]?.text ?? '')}${rs ? `. Their best reply: <b>${esc(rs)}</b> (red arrow)` : ''}. ${srcChip('engine')} <span class="muted">Details below.</span>`;
      (window as any).__explorerTry = w;
    } catch {
      if (g === this.tryGen) this.answer('<p class="muted">Could not analyse that move.</p>');
    }
  }

  close() {
    if (!this.ov.isConnected) return;
    window.removeEventListener('hashchange', this.onHash);
    this.tryGen++;
    this.cg?.destroy();
    this.pool?.destroy();
    this.ov.remove();
    if (!document.querySelector('.overlay')) document.body.classList.remove('modal-open');
    (window as any).__explorer = null;
    (this.prevFocus as HTMLElement | null)?.focus?.({ preventScroll: true });
  }
}

export function openExplorer(o: ExplorerOpts): Explorer | null {
  const x = buildExplore(o.fen, o.playedUci, o.before, o.after);
  return x ? new Explorer(o, x) : null;
}
