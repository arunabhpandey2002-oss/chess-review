// Analysis workspace: a board with a variation tree, the engine (lines and depth), "Ask about this move", compare two
// lines, FEN/PGN in and out, and "Save as puzzle". Everything stays on this device. Engine + board facts only.
import { Chess, type Color } from 'chess.js';
import { Chessground } from 'chessground';
import type { Api as CgApi } from 'chessground/api';
import type { Key } from 'chessground/types';
import { EnginePool, type PosEval } from './engine';
import { VTree, parseImport, KIND_LABEL, type TNode } from './tree';
import { whatIf, povScore, type Fact } from './explore';
import { winPct } from './classify';
import { pvToSan } from './tactics';
import { renderText, tokMove } from './words';
import { terminalEval, parseGame, reviewGame } from './review';
import { tagMove, phaseOf } from './concepts';
import { compareLines } from './compare';
import { renderCompare } from './replay-view';
import { newSrs } from './srs';
import { batch } from './batch';
import * as store from './store';
import type { WorkspaceDoc, Puzzle } from './store';
import type { MomentCore } from './explain';
import { $, esc, srcTags, reducedMotion, legalDests, parseTyped } from './ui';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const DEPTHS = [12, 16, 20];
const pct = (x: number) => `${Math.round(x)}%`;
const nt = () => localStorage.getItem('cr-notation') === '1';
const txt = (t: string) => esc(renderText(t, nt() ? 'san' : 'words'));

export interface NewDoc { title: string; startFen: string; orientation?: 'white' | 'black'; lines?: { ucis: string[]; kind: 'game' | 'engine' | 'imported'; then?: { ucis: string[]; kind: 'engine' } }[]; source?: string }

/** Creates a workspace document and returns its id (the caller navigates to it). */
export async function createWorkspace(pk: string, d: NewDoc): Promise<string> {
  const t = new VTree(d.startFen);
  for (const l of d.lines ?? []) {
    const end = t.addLine(t.root.id, l.ucis, l.kind);
    if (end && l.then?.ucis.length) t.addLine(end.id, l.then.ucis, l.then.kind);
  }
  t.select(t.root.id);
  const id = `ws${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const doc: WorkspaceDoc = { id, profileKey: pk, title: d.title.slice(0, 120), startFen: d.startFen, tree: t.json(), orientation: d.orientation ?? (new Chess(d.startFen).turn() === 'w' ? 'white' : 'black'), source: d.source, createdAt: now, updatedAt: now };
  await store.put('workspace', doc);
  return id;
}

/** A lesson opened in the workspace: the game move (with the engine's reply) as the main line, the best line as a branch. */
export function lessonDoc(m: MomentCore, me: Color, title: string): NewDoc {
  return { title, startFen: m.fenBefore, orientation: me === 'w' ? 'white' : 'black', source: 'lesson',
    lines: [{ ucis: [m.playedUci], kind: 'game', then: m.reply ? { ucis: m.reply.pv.slice(0, 7), kind: 'engine' } : undefined }, { ucis: (m.lines[0]?.pv ?? [m.bestUci]).slice(0, 8), kind: 'engine' }] };
}

let current: Workspace | null = null;
export function destroyWorkspace() { current?.destroy(); current = null; }

export async function renderWorkspace(app: HTMLElement, pk: string, id: string | undefined, back: () => void) {
  destroyWorkspace();
  let doc = id ? await store.get<WorkspaceDoc>('workspace', id) : undefined;
  if (!doc) {
    const nid = await createWorkspace(pk, { title: 'New analysis', startFen: START, orientation: 'white' });
    doc = (await store.get<WorkspaceDoc>('workspace', nid))!;
    const u = new URL(location.href); u.searchParams.set('ws', nid); history.replaceState(null, '', u);
  }
  current = new Workspace(app, doc, pk, back);
}

class Workspace {
  tree: VTree; cg!: CgApi; pool: EnginePool | null = null; gen = 0; saveT = 0;
  evals = new Map<string, PosEval>();
  mpv = +(localStorage.getItem('cr-ws-mpv') || 3); depth = +(localStorage.getItem('cr-ws-depth') || 16);
  engineOn = localStorage.getItem('cr-ws-engine') !== '0';
  last: PosEval | null = null;
  onKey = (e: KeyboardEvent) => {
    const tg = (e.target as HTMLElement).tagName;
    if (tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); this.up(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); this.down(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); if (this.tree.undo()) this.changed(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); if (this.tree.redo()) this.changed(); }
  };
  constructor(public app: HTMLElement, public doc: WorkspaceDoc, public pk: string, public back: () => void) {
    this.tree = VTree.from(doc.tree, doc.startFen);
    this.render();
    document.addEventListener('keydown', this.onKey);
    void batch.hold(true);
    (window as any).__ws = this;
  }
  destroy() {
    this.gen++;
    document.removeEventListener('keydown', this.onKey);
    this.pool?.destroy(); this.pool = null;
    this.cg?.destroy();
    void batch.hold(false);
    this.flush();
  }
  get node() { return this.tree.cursor; }
  get fen() { return this.node.fen; }
  get me(): Color { return this.doc.orientation === 'black' ? 'b' : 'w'; }

  render() {
    this.app.innerHTML = `
      <section class="ws">
        <div class="ws-head"><button class="btn ghost" id="ws-back">‹ Back</button><h1 id="ws-title">${esc(this.doc.title)}</h1></div>
        <div class="ws-grid">
          <div class="ws-boardcol">
            <div class="ws-boardrow"><div class="evalbar" id="ws-bar" aria-hidden="true"><div class="fill"></div></div><div class="board-wrap"><div id="ws-board" class="cg-wrap"></div></div></div>
            <div class="ws-nav" role="group" aria-label="Moves">
              <button class="btn" id="ws-first" aria-label="Start">«</button><button class="btn" id="ws-prev" aria-label="Previous move">‹</button>
              <button class="btn" id="ws-next" aria-label="Next move">›</button><button class="btn" id="ws-last" aria-label="End of line">»</button>
              <button class="btn ghost" id="ws-flip" aria-label="Flip board">⇅</button>
            </div>
            <form id="ws-type" class="sp-type"><label for="ws-input" class="muted small">Type a move</label><input id="ws-input" autocomplete="off" placeholder="e.g. Nf3 or g1f3"><button class="btn">Play</button></form>
          </div>
          <div class="ws-side">
            <div class="card ws-engine">
              <div class="ws-eh"><label class="ws-toggle"><input type="checkbox" id="ws-on"${this.engineOn ? ' checked' : ''}> Engine</label>
                <span class="ws-ctl"><label>Lines <select id="ws-mpv">${[1, 2, 3, 4, 5].map((n) => `<option${n === this.mpv ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
                <label>Depth <select id="ws-depth">${DEPTHS.map((d) => `<option${d === this.depth ? ' selected' : ''}>${d}</option>`).join('')}</select></label></span></div>
              <div id="ws-lines" aria-live="polite"></div>
            </div>
            <div class="card ws-tree"><div class="ws-th"><h2>Moves</h2><span class="ws-tools">
              <button class="btn sm ghost" id="ws-undo" title="Undo (Ctrl+Z)">Undo</button><button class="btn sm ghost" id="ws-redo" title="Redo (Ctrl+Y)">Redo</button>
              <button class="btn sm ghost" id="ws-promote">Make main line</button><button class="btn sm ghost" id="ws-del">Delete from here</button></span></div>
              <div id="ws-moves" class="ws-moves"></div></div>
            <div class="card ws-ask" id="ws-ask"></div>
            <div class="tr-after"><button class="btn primary" id="ws-save">Save as puzzle</button><button class="btn" id="ws-cmp">Compare with main line</button></div>
            <p class="small" id="ws-msg" role="status" aria-live="polite"></p>
            <div id="ws-cmpout"></div>
            <details class="ws-io"><summary>FEN and PGN</summary>
              <div class="tr-after"><button class="btn sm" id="ws-cfen">Copy FEN</button><button class="btn sm" id="ws-cpgn">Copy PGN</button></div>
              <label class="muted small" for="ws-load">Paste a FEN or PGN to start a new line from it</label>
              <textarea id="ws-load" rows="3" spellcheck="false"></textarea><button class="btn sm" id="ws-loadbtn">Load</button>
            </details>
            <p class="muted small">Saved on this device as you go. Only finished games: never use the engine during a game you are playing.</p>
          </div>
        </div>
      </section>`;
    this.cg = Chessground($('#ws-board', this.app), {
      orientation: this.doc.orientation, coordinates: true,
      animation: { enabled: !reducedMotion(), duration: 150 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, showDests: true, events: { after: (a, b) => this.boardMove(a, b) } },
      draggable: { enabled: true }, drawable: { enabled: true, visible: true }, premovable: { enabled: false },
    });
    const on = (id: string, f: () => void) => { $(id, this.app).onclick = (e) => { e.preventDefault(); f(); }; };
    on('#ws-back', () => this.back());
    on('#ws-first', () => { this.tree.select(this.tree.root.id); this.changed(false); });
    on('#ws-prev', () => this.up());
    on('#ws-next', () => this.down());
    on('#ws-last', () => { const l = this.tree.mainFrom(this.node.id); if (l.length) { this.tree.select(l[l.length - 1].id); this.changed(false); } });
    on('#ws-flip', () => { this.doc.orientation = this.doc.orientation === 'white' ? 'black' : 'white'; this.cg.set({ orientation: this.doc.orientation }); this.save(); this.drawBar(); });
    on('#ws-undo', () => { if (this.tree.undo()) this.changed(); });
    on('#ws-redo', () => { if (this.tree.redo()) this.changed(); });
    on('#ws-promote', () => { if (this.tree.promote(this.node.id)) this.changed(); });
    on('#ws-del', () => { const p = this.node.parent; if (p && this.tree.remove(this.node.id)) { this.tree.select(p); this.changed(); } });
    on('#ws-save', () => void this.savePuzzle());
    on('#ws-cmp', () => void this.compare());
    on('#ws-cfen', () => this.copy(this.fen, 'FEN copied.'));
    on('#ws-cpgn', () => this.copy(this.tree.pgn({ Event: this.doc.title }), 'PGN copied, with all variations.'));
    on('#ws-loadbtn', () => this.load($<HTMLTextAreaElement>('#ws-load', this.app).value));
    $<HTMLInputElement>('#ws-on', this.app).onchange = (e) => { this.engineOn = (e.target as HTMLInputElement).checked; localStorage.setItem('cr-ws-engine', this.engineOn ? '1' : '0'); if (!this.engineOn) { this.gen++; this.pool?.destroy(); this.pool = null; } this.analyse(); };
    $<HTMLSelectElement>('#ws-mpv', this.app).onchange = (e) => { this.mpv = +(e.target as HTMLSelectElement).value; localStorage.setItem('cr-ws-mpv', String(this.mpv)); this.analyse(); };
    $<HTMLSelectElement>('#ws-depth', this.app).onchange = (e) => { this.depth = +(e.target as HTMLSelectElement).value; localStorage.setItem('cr-ws-depth', String(this.depth)); this.analyse(); };
    $('#ws-type', this.app).onsubmit = (e) => {
      e.preventDefault();
      const inp = $<HTMLInputElement>('#ws-input', this.app);
      const u = parseTyped(this.fen, inp.value);
      if (!u) { this.msg(`"${inp.value}" is not a legal move here.`); return; }
      inp.value = ''; this.play(u, 'mine');
    };
    this.changed(false);
  }

  msg(t: string) { $('#ws-msg', this.app).textContent = t; }
  copy(t: string, done: string) { navigator.clipboard?.writeText(t).then(() => this.msg(done), () => this.msg(t)); }
  up() { const p = this.node.parent; if (p) { this.tree.select(p); this.changed(false); } }
  down() { const c = this.node.children[0]; if (c) { this.tree.select(c); this.changed(false); } }
  boardMove(a: string, b: string) {
    const c = new Chess(this.fen);
    const mv = c.moves({ verbose: true }).find((m) => m.from === a && m.to === b && (!m.promotion || m.promotion === 'q'));
    if (mv) this.play(mv.from + mv.to + (mv.promotion ?? ''), 'mine'); else this.sync();
  }
  play(uci: string, kind: 'mine' | 'engine') {
    const n = this.tree.add(this.node.id, uci, kind, { select: true });
    if (!n) { this.msg('That move is not legal here.'); this.sync(); return; }
    this.changed();
  }
  load(text: string) {
    const r = parseImport(text);
    if (!r) { this.msg('That is not a FEN or PGN I can read.'); return; }
    this.tree = new VTree(r.fen);
    if (r.ucis.length) this.tree.addLine(this.tree.root.id, r.ucis, 'imported');
    this.tree.select(this.tree.root.id);
    this.doc.startFen = r.fen;
    this.msg(`Loaded${r.ucis.length ? ` ${r.ucis.length} moves` : ' the position'}.`);
    this.changed();
  }
  /** After any change: redraw board, moves, engine; `persist` saves the document. */
  changed(persist = true) {
    this.sync(); this.drawMoves(); this.drawAsk(); this.analyse();
    $('#ws-cmpout', this.app).innerHTML = '';
    $<HTMLButtonElement>('#ws-undo', this.app).disabled = !this.tree.canUndo();
    $<HTMLButtonElement>('#ws-redo', this.app).disabled = !this.tree.canRedo();
    $<HTMLButtonElement>('#ws-promote', this.app).disabled = !this.node.parent || this.tree.node(this.node.parent).children[0] === this.node.id;
    $<HTMLButtonElement>('#ws-del', this.app).disabled = !this.node.parent;
    $<HTMLButtonElement>('#ws-cmp', this.app).disabled = !this.offMain();
    if (persist) this.save();
  }
  offMain() { const main = new Set(this.tree.mainline().map((n) => n.id)); return this.node.parent !== null && !main.has(this.node.id); }
  save() { clearTimeout(this.saveT); this.saveT = window.setTimeout(() => this.flush(), 300); }
  flush() { clearTimeout(this.saveT); this.doc.tree = this.tree.json(); this.doc.updatedAt = Date.now(); void store.put('workspace', this.doc).catch(() => {}); }

  sync() {
    const c = new Chess(this.fen);
    const n = this.node;
    this.cg.set({ fen: this.fen, turnColor: c.turn() === 'w' ? 'white' : 'black', check: c.inCheck(), lastMove: n.uci ? [n.uci.slice(0, 2) as Key, n.uci.slice(2, 4) as Key] : undefined,
      movable: { color: c.isGameOver() ? undefined : c.turn() === 'w' ? 'white' : 'black', dests: legalDests(this.fen) as Map<Key, Key[]> } });
    this.cg.setAutoShapes(this.last && this.engineOn ? this.last.lines.slice(0, 1).filter((l) => l.pv[0]).map((l) => ({ orig: l.pv[0].slice(0, 2) as Key, dest: l.pv[0].slice(2, 4) as Key, brush: 'paleGreen' })) : []);
  }

  drawMoves() {
    const t = this.tree;
    const cur = this.node.id;
    const mv = (n: TNode, forceNum: boolean) => {
      const white = new Chess(t.node(n.parent!).fen).turn() === 'w';
      const no = +t.node(n.parent!).fen.split(' ')[5];
      const num = white ? `${no}.` : forceNum ? `${no}...` : '';
      const kind = n.kind !== 'mine' && n.kind !== 'game' && n.kind !== 'imported' ? ` ws-k-${n.kind}` : '';
      return `<button class="ws-mv${n.id === cur ? ' cur' : ''}${kind}" data-n="${n.id}"${n.id === cur ? ' aria-current="true"' : ''} title="${esc(KIND_LABEL[n.kind])}">${num ? `<span class="muted">${num}</span>` : ''}${esc(n.san)}</button>`;
    };
    // main line inline; side lines in brackets, nested
    const line = (startId: string, first: boolean, depth: number): string => {
      let out = '', id = startId, force = first;
      for (;;) {
        const n = t.node(id);
        out += mv(n, force); force = false;
        const p = t.node(n.parent!);
        const sibs = p.children.slice(1);
        if (p.children[0] === n.id && sibs.length) { out += sibs.map((s) => `<span class="ws-var d${Math.min(depth, 3)}">(${line(s, true, depth + 1)})</span>`).join(''); force = true; }
        if (!n.children.length) break;
        id = n.children[0];
      }
      return out;
    };
    const r = t.root;
    $('#ws-moves', this.app).innerHTML = r.children.length ? line(r.children[0], true, 1) + (r.children.length ? '' : '') : '<p class="muted small">Make a move on the board, or play an engine line.</p>';
    this.app.querySelectorAll<HTMLButtonElement>('.ws-mv').forEach((b) => (b.onclick = () => { this.tree.select(b.dataset.n!); this.changed(false); }));
    $('.ws-mv.cur', this.app)?.scrollIntoView?.({ block: 'nearest' });
  }

  async pos(fen: string, depth = this.depth, mpv = this.mpv): Promise<PosEval | null> {
    const t = terminalEval(fen); if (t) return t;
    const k = `${fen}|${depth}|${mpv}`;
    const hit = this.evals.get(k); if (hit) return hit;
    if (!this.pool) this.pool = new EnginePool(1);
    const ev = await this.pool.analyse(fen, depth, mpv, depth >= 20 ? 20000 : 10000);
    this.evals.set(k, ev);
    return ev;
  }
  analyse() {
    const g = ++this.gen;
    const el = $('#ws-lines', this.app);
    if (!this.engineOn) { el.innerHTML = '<p class="muted small">Engine off.</p>'; this.last = null; this.sync(); this.drawBar(); return; }
    const fen = this.fen;
    if (new Chess(fen).isGameOver()) { this.last = terminalEval(fen); el.innerHTML = `<p class="small">${new Chess(fen).isCheckmate() ? 'Checkmate.' : 'The game is drawn here.'}</p>`; this.drawBar(); return; }
    el.innerHTML = `<p class="muted small">Thinking… depth ${this.depth}</p>`;
    // a running search is replaced by the new position
    if (this.pool) { this.pool.destroy(); this.pool = null; }
    this.pos(fen).then((ev) => {
      if (g !== this.gen || !ev) return;
      this.last = ev;
      const mover = new Chess(fen).turn();
      el.innerHTML = `<ol class="ws-lines">${ev.lines.map((l, i) => {
        const sans = pvToSan(fen, l.pv, 10);
        return `<li><button class="btn sm ws-pl" data-i="${i}" title="Play this line">${esc(povScore(l.score, 'w'))}</button> <span class="ws-pv">${esc(sans.join(' '))}</span></li>`;
      }).join('')}</ol><p class="muted small">Depth ${ev.depth} · ${pct(winPct(ev.lines[0]?.score ?? { cp: 0, mate: null }, mover))} for ${mover === 'w' ? 'White' : 'Black'} ${srcTags(['engine'])}</p>`;
      el.querySelectorAll<HTMLButtonElement>('.ws-pl').forEach((b) => (b.onclick = () => {
        const l = ev.lines[+b.dataset.i!]; if (!l) return;
        const end = this.tree.addLine(this.node.id, l.pv.slice(0, 8), 'engine', false);
        if (end) { const first = this.tree.node(this.node.id).children.find((c) => this.tree.node(c).uci === l.pv[0]); if (first) this.tree.select(first); this.changed(); }
      }));
      this.sync(); this.drawBar(); this.drawAsk();
    }).catch(() => { if (g === this.gen) el.innerHTML = '<p class="muted small">The engine stopped. Change the position or depth to try again.</p>'; });
  }
  drawBar() {
    const bar = $('#ws-bar', this.app);
    const s = this.last?.lines[0]?.score;
    const w = s ? winPct(s, 'w') : 50;
    bar.classList.toggle('flipped', this.doc.orientation === 'black');
    $<HTMLElement>('.fill', bar).style.height = `${w}%`;
  }

  /** "Ask about this move": board facts and the engine's view of the move that led here. */
  drawAsk() {
    const el = $('#ws-ask', this.app);
    const n = this.node;
    if (!n.parent) { el.innerHTML = `<h2>Ask about a move</h2><p class="muted small">Select or play a move to see what it does.</p>`; return; }
    const pf = this.tree.node(n.parent).fen;
    el.innerHTML = `<h2>About ${txt(tokMove(pf, n.san))} <span class="muted small">· ${esc(KIND_LABEL[n.kind])}</span></h2><p class="muted small" id="ws-askbody">Checking…</p>`;
    if (!this.engineOn) { $('#ws-askbody', el).textContent = 'Turn the engine on to compare this move with the best one.'; return; }
    const g = this.gen;
    void (async () => {
      const after = this.last && this.fen === n.fen ? this.last : null;
      if (!after) return; // drawn again once the engine has this position
      let before: PosEval | null = null;
      try { before = await this.pos(pf); } catch { return; }
      if (!before) return;
      if (g !== this.gen) return;
      const mover = new Chess(pf).turn();
      const bestWp = before.lines[0] ? winPct(before.lines[0].score, mover) : 50;
      const w = whatIf(pf, n.uci, after, bestWp);
      if (!w) return;
      const best = before.lines[0]?.pv[0];
      const facts: Fact[] = w.facts.slice();
      if (best && best !== n.uci) facts.push({ text: `The engine's best move here was ${tokMove(pf, pvToSan(pf, [best], 1)[0])} (${pct(bestWp)}).`, src: 'engine' });
      el.innerHTML = `<h2>About ${txt(w.tok)} <span class="muted small">· ${esc(KIND_LABEL[n.kind])}</span></h2><ul>${facts.map((f) => `<li>${txt(f.text)}</li>`).join('')}</ul>${srcTags(facts.map((f) => f.src))}`;
    })();
  }

  /** The move to quiz: the selected move if it is not the best; otherwise the game move it replaced. */
  async puzzleCore(): Promise<{ core: MomentCore; note: string } | string> {
    const n = this.node;
    if (!n.parent) return 'Select a move first: the puzzle is "find a better move than this one".';
    const p = this.tree.node(n.parent);
    const before = await this.pos(p.fen, Math.max(16, this.depth), 3);
    if (!before?.lines[0]) return 'This position has no moves to find.';
    const best = before.lines[0].pv[0];
    let pick: TNode | undefined = n.uci !== best ? n : p.children.map((c) => this.tree.node(c)).find((c) => c.uci !== best && (c.kind === 'game' || c.kind === 'imported'));
    if (!pick) return `${pvToSan(p.fen, [best], 1)[0]} is already the engine's best move here, so there is nothing to find. Select a weaker move to make a puzzle.`;
    const after = await this.pos(pick.fen, Math.max(16, this.depth), 1);
    const c = new Chess(p.fen);
    const mover = c.turn();
    const head = `[SetUp "1"]\n[FEN "${p.fen}"]\n\n`;
    const { plies } = parseGame(head + pick.san);
    if (!plies.length) return 'Could not read that move.';
    const reviews = reviewGame({ plies, evals: [before, after], book: null });
    const r = reviews[0];
    if (!r) return 'Could not check that move.';
    if (r.loss < 3) return `${pick.san} is nearly as good as the best move (${pct(r.wpAfter)} vs ${pct(r.wpBefore)}), so it would not make a useful puzzle.`;
    const tags = tagMove({ ply: plies[0], best: before.lines[0], reply: after?.lines[0], mover });
    const core: MomentCore = {
      ply: plies[0].moveNumber * 2 - (mover === 'w' ? 2 : 1), moveNumber: plies[0].moveNumber, color: mover, fenBefore: p.fen, fenAfter: pick.fen, playedUci: pick.uci, playedSan: pick.san,
      bestUci: best, bestSan: pvToSan(p.fen, [best], 1)[0], lines: before.lines.map((l) => ({ ...l, pv: l.pv.slice(0, 12) })),
      reply: after?.lines[0] ? { ...after.lines[0], pv: after.lines[0].pv.slice(0, 12) } : null,
      wpBest: r.wpBefore, wpPlayed: r.wpAfter, loss: r.loss, cls: r.cls, tags,
      prevUci: p.uci || undefined, prevFen: p.parent ? this.tree.node(p.parent).fen : undefined,
    };
    return { core, note: pick === n ? '' : ` (quiz on the game move ${pick.san})` };
  }
  async savePuzzle() {
    this.msg('Checking the position…');
    try {
      const r = await this.puzzleCore();
      if (typeof r === 'string') { this.msg(r); return; }
      const id = `${this.pk}|${this.doc.id}|${r.core.fenBefore.split(' ').slice(0, 4).join('_')}|${r.core.playedUci}`;
      const pz: Puzzle = { id, profileKey: this.pk, gameId: this.doc.id, gameUrl: '', platform: 'workspace', white: this.doc.title, black: '', endTime: Math.floor(Date.now() / 1000),
        phase: phaseOf(r.core.fenBefore, r.core.ply), core: r.core, srs: newSrs(Date.now()), createdAt: Date.now(), source: 'workspace', verify: { depth: Math.max(16, this.depth), sameBest: null } };
      await store.savePuzzle(pz);
      this.msg(`Saved as a puzzle${r.note}: find a better move than ${r.core.playedSan}. It is in Puzzles and Train.`);
      (window as any).__wsSaved = pz;
    } catch (e) { this.msg(`Could not save: ${String((e as Error)?.message ?? e)}`); }
  }

  /** Compare the selected line with the main line from where they split. */
  async compare() {
    const out = $('#ws-cmpout', this.app);
    const path = this.tree.path(this.node.id);
    const main = this.tree.mainline();
    let k = 0; while (k < path.length && k < main.length && path[k].id === main[k].id) k++;
    const startFen = k ? path[k - 1].fen : this.tree.root.fen;
    const a = main.slice(k, k + 16).map((n) => n.uci), b = path.slice(k).map((n) => n.uci);
    if (!b.length) return;
    out.innerHTML = '<p class="muted small">Checking both lines…</p>';
    const g = this.gen;
    const evalsOf = async (ucis: string[]) => {
      const c = new Chess(startFen); const fens = [startFen];
      for (const u of ucis) { c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); fens.push(c.fen()); }
      const ev: (import('./engine').Score | null)[] = [];
      for (const f of fens) { const e = await this.pos(f, 12, 1); ev.push(e?.lines[0]?.score ?? null); }
      return ev;
    };
    try {
      const [ea, eb] = [await evalsOf(a), await evalsOf(b)];
      if (g !== this.gen) return;
      const me = new Chess(startFen).turn();
      const cmp = compareLines(startFen, me, { id: 'original', ucis: a, evals: ea }, { id: 'replay', ucis: b, evals: eb }, []);
      renderCompare(out, cmp, { nt: nt(), onBack: () => { out.innerHTML = ''; }, onAgain: () => { out.innerHTML = ''; } });
      out.querySelectorAll('#sp-again').forEach((x) => x.remove());
      (window as any).__wsCompare = cmp;
    } catch { out.innerHTML = '<p class="muted small">Could not compare these lines.</p>'; }
  }
}
