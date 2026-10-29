// "Why is this best?" explorer: best move vs the game move, step through both engine lines,
// tap questions, or try any move and get the engine's answer. Engine + board facts only.
import { Chess, type Color } from 'chess.js';
import { Chessground } from 'chessground';
import type { Api as CgApi } from 'chessground/api';
import type { Key } from 'chessground/types';
import type { DrawShape } from 'chessground/draw';
import { EnginePool, type PosEval } from './engine';
import { buildExplore, stepLine, whatIf, povScore, type Explore, type Fact, type Side, type Step } from './explore';
import { renderText, tokMove } from './words';
import { pvToSan } from './tactics';
import { $, esc, srcTags, dlgHead, reducedMotion, boardDescription, legalDests, parseTyped } from './ui';

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
  /** Moves already glossed in the main panel (each move gets its plain-English words once). */
  seen = new Set<string>();
  txt(t: string, seen: Set<string> = this.seen) { return esc(renderText(t, this.nt ? 'san' : 'words', seen)); }
  san(t: string) { return esc(renderText(t, 'san')); }
  sc(s: Side) { return povScore(s.score, this.mover); }
  /** A bullet list of facts with one quiet source line underneath. */
  facts(fs: Fact[], seen = new Set<string>()) { return `<ul>${fs.map((f) => `<li>${this.txt(f.text, seen)}</li>`).join('')}</ul>${srcTags(fs.map((f) => f.src))}`; }
  get mover() { return this.x.mover; }
  get you() { return this.mover === this.o.me; }
  get sideWord() { return this.mover === 'w' ? 'White' : 'Black'; }

  col(s: Side, kind: 'best' | 'played') {
    const up = (f: string) => this.txt(f.charAt(0).toUpperCase() + f.slice(1));
    const facts = s.facts.length ? s.facts : ['a quiet move: no direct threat, capture or defence'];
    const left = [...s.left.still, ...s.left.created];
    const who = kind === 'best' ? 'Best' : this.you ? 'Your move' : 'Game move';
    return `<div class="ex-col ex-${kind}">
      <div class="ex-col-head"><span class="ex-who">${kind === 'best' ? '★ ' : ''}${who}</span>
        <span class="ex-mv">${this.san(s.tok)}</span><span class="ex-num">${pct(s.wp)} · ${this.sc(s)}</span></div>
      <p class="ex-k">What it does</p>
      <ul>${facts.map((f) => `<li>${up(f)}.</li>`).join('')}</ul>
      ${left.length ? `<p class="ex-k">Left under attack</p><ul>${left.slice(0, 2).map((f) => `<li>${up(f)}.</li>`).join('')}</ul>` : ''}
      ${s.reply ? `<p class="ex-k">Their best reply</p><p><b>${this.san(s.reply.tok)}</b>${s.reply.facts.length ? `: ${this.txt(s.reply.facts.slice(0, 2).join('; '))}` : ' (a quiet move)'}.</p>` : ''}
      <div class="ex-col-foot"><button class="btn small" data-line="${kind}">Step through this line</button>${srcTags(['engine', 'rules'])}</div>
    </div>`;
  }

  render() {
    const x = this.x;
    const title = x.same ? `Explore ${this.o.label}` : `Why is ${renderText(x.best.tok, 'san')} best?`;
    this.seen = new Set();
    const sub = `${esc(this.o.label)} · ${this.you ? 'your move' : 'their move'} as ${this.sideWord} · scores from ${this.sideWord}'s side (+ is good for ${this.sideWord})`;
    const verdict = this.txt(x.verdict.text);
    const cols = x.same ? this.col(x.best, 'best') : this.col(x.best, 'best') + this.col(x.played, 'played');
    const cmp = !x.same && x.compare.length ? `<h3 class="ex-h">Why ${this.san(x.best.tok)} is better</h3><div id="ex-compare">${this.facts(x.compare, this.seen)}</div>` : '';
    this.host.innerHTML = `
      ${dlgHead(title, sub, 'ex-close')}
      <div class="trainer explorer">
        <div class="tr-board-col ex-board-col">
          <div class="tr-board-wrap"><div class="tr-board" id="ex-board" role="img" aria-label="${esc(boardDescription(x.fen))}"></div></div>
          <div class="ex-stepper" id="ex-stepper">
            <button class="btn" id="ex-prev" aria-label="Previous move">◀</button>
            <button class="btn" id="ex-next" aria-label="Next move">▶</button>
            <span id="ex-pos" class="ex-pos"></span>
            <button class="btn ghost" id="ex-reset">Back to position</button>
          </div>
          <div class="ex-steptext" id="ex-steptext" role="status" aria-live="polite"></div>
          <form class="tr-type" id="ex-type" autocomplete="off">
            <label for="ex-input">Try a move</label>
            <input id="ex-input" placeholder="e.g. Rf1" spellcheck="false">
            <button class="btn">Try</button>
          </form>
        </div>
        <div class="tr-side ex-side">
          <div class="ex-verdict" id="ex-verdict"><p>${verdict}</p>${srcTags([x.verdict.src])}</div>
          <div class="ex-cols${x.same ? ' one' : ''}">${cols}</div>
          ${cmp}
        </div>
        <div class="ex-ask">
          <h3 class="ex-h">Ask</h3>
          <div class="ex-qs" id="ex-qs">
            <button class="chip" data-q="threat">What was the threat?</button>
            ${x.same ? '' : `<button class="chip" data-q="mine">Why not ${this.san(x.played.tok)}?</button>`}
            <button class="chip" data-q="reply">What does their reply do?</button>
            <button class="chip" data-q="other">Why not another move?</button>
          </div>
          <div class="ex-answer" id="ex-answer" role="status" aria-live="polite"><p class="muted">Tap a question, step through a line, or play any move on the board to see the engine's answer.</p></div>
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
    const key = (cls: string, label: string, tok: string) => `<span class="lg"><i class="lg-dot ${cls}" aria-hidden="true"></i><span>${label}:&nbsp;<b>${this.san(tok)}</b></span></span>`;
    $('#ex-steptext', this.host).innerHTML = `<div class="ex-legend">${key('green', 'Best', this.x.best.tok)}${this.x.same ? '' : key('blue', this.you ? 'Yours' : 'Played', this.x.played.tok)}<span class="muted lg-hint">Step through a line or play any move.</span></div>`;
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
    $('#ex-steptext', this.host).innerHTML = st ? `<b>${esc(st.san)}</b> — ${this.txt(st.text, new Set())}${this.i === this.steps.length ? ' <span class="muted">End of the engine line.</span>' : ''}` : 'Start of the line.';
    this.buttons();
  }

  ask(q: string) {
    const x = this.x;
    this.host.querySelectorAll('[data-q]').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.q === q));
    const ul = (fs: Fact[]) => this.facts(fs);
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
        <div class="ex-alts">${alts.map((a) => `<button class="chip" data-try="${a.uci}">${this.san(a.tok)} <span class="muted">${pct(a.wp)} · ${povScore(a.score, this.mover)}</span></button>`).join('') || '<span class="muted">None stored.</span>'}</div>${srcTags(['engine'])}`);
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
    $('#ex-steptext', this.host).innerHTML = `You tried ${this.txt(tok, new Set())}. Press “Back to position” to try another.`;
    this.buttons();
    this.answer(`<h4>What if ${esc(mv.san)}?</h4><p class="muted">Engine is thinking…</p>`);
    try {
      const ev = await this.evalOf(this.tryFen, uci);
      if (g !== this.tryGen) return;
      const w = whatIf(this.x.fen, uci, ev, this.x.best.wp);
      if (!w) return;
      const r = ev.lines[0]?.pv[0];
      if (r) this.cg.setAutoShapes([{ orig: r.slice(0, 2) as Key, dest: r.slice(2, 4) as Key, brush: 'red' }]);
      this.answer(`<h4>What if ${esc(mv.san)}?</h4>${this.facts(w.facts)}${r ? '<p class="muted small">Red arrow: their best reply.</p>' : ''}<button class="btn small" id="ex-back2">Back to position</button>`);
      $('#ex-back2', this.host).onclick = () => this.reset();
      const rs = r ? pvToSan(this.tryFen, [r], 1)[0] : '';
      $('#ex-steptext', this.host).innerHTML = `<b>${esc(mv.san)}</b>: ${w.score ? `${povScore(w.score, this.mover)}, ${pct(w.wp)} win chance (best ${pct(this.x.best.wp)})` : esc(w.facts[0]?.text ?? '')}${rs ? `. Their best reply: <b>${esc(rs)}</b> (red arrow)` : ''}. <span class="muted">Details in the answer box.</span>`;
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
