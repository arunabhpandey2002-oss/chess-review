// Variation tree for the analysis workspace and play-outs. Plain JSON so it can be stored and exported.
// Node kinds tell the user where a move came from; nothing is ever silently dropped (take-backs stay as branches).
import { Chess } from 'chess.js';
import { uciToMove } from './tactics';

export type NodeKind = 'root' | 'game' | 'engine' | 'mine' | 'replay' | 'taken-back' | 'imported';
export interface TNode { id: string; parent: string | null; uci: string; san: string; fen: string; ply: number; kind: NodeKind; children: string[]; comment?: string }
export interface TreeData { v: 1; rootFen: string; nodes: Record<string, TNode>; cursor: string; seq: number }

export const KIND_LABEL: Record<NodeKind, string> = { root: 'Start', game: 'Game', engine: 'Engine', mine: 'Mine', replay: 'Replay', 'taken-back': 'Taken back', imported: 'Imported' };
const ROOT = 'n0';

export class VTree {
  d: TreeData;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  constructor(rootFen: string, data?: TreeData) {
    this.d = data && data.v === 1 && data.nodes?.[ROOT] ? data : { v: 1, rootFen, nodes: { [ROOT]: { id: ROOT, parent: null, uci: '', san: '', fen: rootFen, ply: 0, kind: 'root', children: [] } }, cursor: ROOT, seq: 0 };
  }
  static from(data: unknown, fallbackFen: string): VTree {
    const x = data as TreeData | null;
    if (x && x.v === 1 && x.nodes && x.nodes[ROOT] && validTree(x)) return new VTree(x.rootFen, x);
    return new VTree(fallbackFen);
  }
  get root() { return this.d.nodes[ROOT]; }
  get cursor() { return this.d.nodes[this.d.cursor]; }
  node(id: string) { return this.d.nodes[id]; }
  private snap() { this.undoStack.push(JSON.stringify(this.d)); if (this.undoStack.length > 200) this.undoStack.shift(); this.redoStack = []; }
  undo(): boolean { const s = this.undoStack.pop(); if (!s) return false; this.redoStack.push(JSON.stringify(this.d)); this.d = JSON.parse(s); return true; }
  redo(): boolean { const s = this.redoStack.pop(); if (!s) return false; this.undoStack.push(JSON.stringify(this.d)); this.d = JSON.parse(s); return true; }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  /** Play `uci` after node `parentId`. Reuses an existing child with the same move. Returns the child, or null if illegal. */
  add(parentId: string, uci: string, kind: NodeKind, opts: { select?: boolean; record?: boolean } = {}): TNode | null {
    const p = this.d.nodes[parentId];
    if (!p) return null;
    const same = p.children.map((c) => this.d.nodes[c]).find((c) => c.uci === uci);
    if (same) {
      // a move that is played again is no longer "taken back"
      if (same.kind === 'taken-back' && kind !== 'taken-back') { if (opts.record !== false) this.snap(); same.kind = kind; }
      if (opts.select !== false) this.d.cursor = same.id;
      return same;
    }
    const c = new Chess(p.fen);
    const mv = uciToMove(c, uci);
    if (!mv) return null;
    if (opts.record !== false) this.snap();
    const id = `n${++this.d.seq}`;
    const n: TNode = { id, parent: p.id, uci, san: mv.san, fen: c.fen(), ply: p.ply + 1, kind, children: [] };
    this.d.nodes[id] = n;
    // a fresh attempt goes ahead of taken-back attempts so the main line is what was finally played
    const firstTb = kind === 'taken-back' ? -1 : p.children.findIndex((x) => this.d.nodes[x].kind === 'taken-back');
    if (firstTb >= 0) p.children.splice(firstTb, 0, id); else p.children.push(id);
    if (opts.select !== false) this.d.cursor = id;
    return n;
  }
  /** Add a whole line of UCI moves from `parentId`; returns the last node added. */
  addLine(parentId: string, ucis: string[], kind: NodeKind, select = false): TNode | null {
    let at: TNode | null = this.d.nodes[parentId];
    const keep = this.d.cursor;
    this.snap();
    for (const u of ucis) { const n = this.add(at!.id, u, kind, { record: false }); if (!n) break; at = n; }
    if (!select) this.d.cursor = keep;
    return at;
  }
  select(id: string) { if (this.d.nodes[id]) this.d.cursor = id; }
  /** Nodes from the root (exclusive) to `id` (inclusive). */
  path(id = this.d.cursor): TNode[] {
    const out: TNode[] = [];
    for (let n: TNode | undefined = this.d.nodes[id]; n && n.parent; n = this.d.nodes[n.parent]) out.unshift(n);
    return out;
  }
  /** Main continuation from `id` (first child each time). */
  mainFrom(id: string): TNode[] {
    const out: TNode[] = [];
    for (let n = this.d.nodes[id]; n && n.children.length; ) { n = this.d.nodes[n.children[0]]; out.push(n); }
    return out;
  }
  mainline(): TNode[] { return this.mainFrom(ROOT); }
  /** Move a branch to first place among its siblings. */
  promote(id: string): boolean {
    const n = this.d.nodes[id];
    if (!n?.parent) return false;
    const p = this.d.nodes[n.parent];
    const i = p.children.indexOf(id);
    if (i <= 0) return false;
    this.snap();
    p.children.splice(i, 1); p.children.unshift(id);
    return true;
  }
  /** Delete a node and everything after it. */
  remove(id: string): boolean {
    const n = this.d.nodes[id];
    if (!n?.parent) return false;
    this.snap();
    const p = this.d.nodes[n.parent];
    p.children = p.children.filter((c) => c !== id);
    const drop = (x: string) => { for (const c of this.d.nodes[x].children) drop(c); delete this.d.nodes[x]; };
    drop(id);
    if (!this.d.nodes[this.d.cursor]) this.d.cursor = p.id;
    return true;
  }
  /** Mark the subtree after `id` (exclusive) as taken back, keeping it as a branch. Used by play-outs. */
  markTakenBack(fromId: string) {
    const mark = (x: string) => { const n = this.d.nodes[x]; if (n.kind !== 'game' && n.kind !== 'root') n.kind = 'taken-back'; n.children.forEach(mark); };
    mark(fromId);
  }
  comment(id: string, text: string) { const n = this.d.nodes[id]; if (n) { this.snap(); n.comment = text.slice(0, 500); } }
  count() { return Object.keys(this.d.nodes).length - 1; }
  branches(): TNode[][] {
    // every leaf's path, main line first
    const leaves = Object.values(this.d.nodes).filter((n) => n.id !== ROOT && !n.children.length);
    return leaves.map((l) => this.path(l.id)).sort((a, b) => (isMain(this, a) ? -1 : 0) - (isMain(this, b) ? -1 : 0));
  }
  json(): TreeData { return JSON.parse(JSON.stringify(this.d)); }

  /** PGN with variations in parentheses. */
  pgn(headers: Record<string, string> = {}): string {
    const fen = this.d.rootFen;
    const std = fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w');
    const h: Record<string, string> = { Event: 'Analysis', Site: 'rook-i.e. mistakes', Result: '*', ...headers };
    if (!std) { h.SetUp = '1'; h.FEN = fen; }
    const head = Object.entries(h).map(([k, v]) => `[${k} "${v.replace(/["\\]/g, '')}"]`).join('\n');
    const num = (n: TNode, force: boolean) => {
      const base = Math.max(1, +fen.split(' ')[5] || 1);
      const moveNo = base + Math.floor((n.ply - 1 + plyOffset(fen)) / 2);
      const white = (n.ply - 1 + plyOffset(fen)) % 2 === 0;
      return white ? `${moveNo}. ` : force ? `${moveNo}... ` : '';
    };
    const cm = (n: TNode) => (n.comment ? ` {${n.comment.replace(/[{}]/g, '')}}` : '');
    const walk = (id: string, force: boolean): string => {
      const p = this.d.nodes[id];
      if (!p.children.length) return '';
      const [main, ...vars] = p.children.map((c) => this.d.nodes[c]);
      let s = `${num(main, force)}${main.san}${cm(main)}`;
      for (const v of vars) s += ` (${num(v, true)}${v.san}${cm(v)}${tailOf(this, v.id)})`;
      const rest = walk(main.id, vars.length > 0);
      return rest ? `${s} ${rest}` : s;
    };
    const tailOf = (t: VTree, id: string): string => { const r = walk(id, false); return r ? ` ${r}` : ''; };
    return `${head}\n\n${walk(ROOT, true)} *`.trim();
  }
}

function plyOffset(fen: string) { return fen.split(' ')[1] === 'b' ? 1 : 0; }
function isMain(t: VTree, path: TNode[]) { const m = t.mainline(); return path.length === m.length && path.every((n, i) => n.id === m[i].id); }
function validTree(x: TreeData): boolean {
  try {
    for (const n of Object.values(x.nodes)) {
      if (typeof n.id !== 'string' || !Array.isArray(n.children)) return false;
      if (n.parent && !x.nodes[n.parent]) return false;
      for (const c of n.children) if (!x.nodes[c]) return false;
    }
    new Chess(x.rootFen);
    return !!x.nodes[x.cursor];
  } catch { return false; }
}

/** Parse a FEN or a PGN typed or pasted by the user. Returns the start position and main-line moves (UCI). */
export function parseImport(text: string): { fen: string; ucis: string[]; headers: Record<string, string> } | null {
  const t = text.trim();
  if (!t || t.length > 200_000) return null;
  try { const c = new Chess(t); return { fen: c.fen(), ucis: [], headers: {} }; } catch { /* not a FEN */ }
  try {
    const c = new Chess();
    c.loadPgn(t);
    const headers = c.getHeaders() as Record<string, string>;
    const hist = c.history({ verbose: true });
    const start = headers.FEN ?? new Chess().fen();
    return { fen: start, ucis: hist.map((m) => m.from + m.to + (m.promotion ?? '')), headers };
  } catch { return null; }
}
