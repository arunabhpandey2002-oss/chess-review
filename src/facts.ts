// Chess-logic fact extractor. Pure functions over chess.js; every fact here is computed from the
// board or from an engine line, never guessed. Explanations and hints may only cite these facts.
import { Chess, type Color, type PieceSymbol, type Square, type Move } from 'chess.js';
import { VAL, uciToMove, materialAlongPv, winnableTargets } from './tactics';

export interface PieceRef { sq: Square; type: PieceSymbol; color: Color }

const FILES = 'abcdefgh';
const sqName = (f: number, r: number) => (FILES[f] + (r + 1)) as Square;
const coords = (sq: string): [number, number] => [sq.charCodeAt(0) - 97, +sq[1] - 1];
const opp = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const DIAG: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const dirsFor = (t: PieceSymbol) => (t === 'b' ? DIAG : t === 'r' ? ORTH : t === 'q' ? [...DIAG, ...ORTH] : []);

function pieces(c: Chess, color?: Color): PieceRef[] {
  const out: PieceRef[] = [];
  for (const row of c.board()) for (const p of row) if (p && (!color || p.color === color)) out.push({ sq: p.square, type: p.type, color: p.color });
  return out;
}

/** A position with the other side to move (a "null move"). Null when that would be illegal (side to move in check). */
export function nullMove(fen: string): Chess | null {
  const c = new Chess(fen);
  if (c.inCheck()) return null;
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  try { return new Chess(parts.join(' ')); } catch { return null; }
}

export interface SafetyFact extends PieceRef { attackers: Square[]; defenders: Square[]; hanging: boolean }

/** Attackers and defenders of every non-king piece of `color`. Hanging = attacked and either undefended or attacked by a cheaper piece. */
export function pieceSafety(fen: string, color: Color): SafetyFact[] {
  const c = new Chess(fen);
  return pieces(c, color).filter((p) => p.type !== 'k').map((p) => {
    const attackers = c.attackers(p.sq, opp(color));
    const defenders = c.attackers(p.sq, color);
    const cheapest = attackers.reduce((m, s) => Math.min(m, VAL[c.get(s)!.type] || 99), 99);
    const hanging = attackers.length > 0 && (defenders.length === 0 || cheapest < VAL[p.type]);
    return { ...p, attackers, defenders, hanging };
  });
}

export function hangingPieces(fen: string, color: Color, minVal = 1): SafetyFact[] {
  return pieceSafety(fen, color).filter((p) => p.hanging && VAL[p.type] >= minVal).sort((a, b) => VAL[b.type] - VAL[a.type]);
}

/** Moves (UCI) that deliver checkmate for the side to move. */
export function mateInOne(fen: string): string[] {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const m of c.moves({ verbose: true })) {
    c.move(m);
    if (c.isCheckmate()) out.push(m.from + m.to + (m.promotion ?? ''));
    c.undo();
  }
  return out;
}

export interface ThreatFacts {
  inCheck: boolean;
  /** Opponent mate-in-one moves if the side to move did nothing. */
  mates: string[];
  /** Pieces of the side to move the opponent could win right now (simple exchange estimate). */
  captures: { sq: Square; type: PieceSymbol; gain: number }[];
  /** Opponent pawn moves that would promote next move (safely or not). */
  promotions?: string[];
}

/** What the opponent threatens in `fen` (side to move = the player). Uses a null move. */
export function threatsAgainst(fen: string): ThreatFacts {
  const c = new Chess(fen);
  const me = c.turn();
  if (c.inCheck()) return { inCheck: true, mates: [], captures: [] };
  const n = nullMove(fen);
  if (!n) return { inCheck: false, mates: [], captures: [] };
  const promotions = [...new Set(n.moves({ verbose: true }).filter((m) => m.promotion).map((m) => m.from + m.to))];
  return { inCheck: false, mates: mateInOne(n.fen()), captures: winnableTargets(n, me, 1), promotions };
}

export interface ForkFact { by: PieceRef; targets: PieceRef[] }

/** The moved piece attacks two or more worthwhile targets (king, a more valuable piece, or an undefended piece). */
export function forkAfter(fenBefore: string, uci: string): ForkFact | null {
  const c = new Chess(fenBefore);
  const m = uciToMove(c, uci);
  if (!m) return null;
  const type = (m.promotion ?? m.piece) as PieceSymbol;
  const myVal = VAL[type];
  const enemy = opp(m.color);
  const targets: PieceRef[] = [];
  for (const p of pieces(c, enemy)) {
    if (!c.attackers(p.sq, m.color).includes(m.to)) continue;
    if (p.type === 'k') { targets.push(p); continue; }
    const defended = c.attackers(p.sq, enemy).length > 0;
    if (VAL[p.type] > myVal || (!defended && VAL[p.type] >= 3)) targets.push(p);
  }
  if (targets.length < 2) return null;
  targets.sort((a, b) => (a.type === 'k' ? -1 : b.type === 'k' ? 1 : VAL[b.type] - VAL[a.type]));
  return { by: { sq: m.to, type, color: m.color }, targets };
}

export interface LineUpFact { attacker: PieceRef; front: PieceRef; behind: PieceRef; absolute: boolean }

/** Two enemy pieces on one line behind a slider of `attackerColor`. */
function lineUps(c: Chess, attackerColor: Color): LineUpFact[] {
  const out: LineUpFact[] = [];
  for (const s of pieces(c, attackerColor)) {
    for (const [df, dr] of dirsFor(s.type)) {
      let [f, r] = coords(s.sq);
      const hit: PieceRef[] = [];
      for (;;) {
        f += df; r += dr;
        if (f < 0 || f > 7 || r < 0 || r > 7) break;
        const p = c.get(sqName(f, r));
        if (!p) continue;
        hit.push({ sq: sqName(f, r), type: p.type, color: p.color });
        if (hit.length === 2) break;
      }
      if (hit.length === 2 && hit[0].color !== attackerColor && hit[1].color !== attackerColor) {
        out.push({ attacker: s, front: hit[0], behind: hit[1], absolute: hit[1].type === 'k' });
      }
    }
  }
  return out;
}

const worth = (t: PieceSymbol) => (t === 'k' ? 100 : VAL[t]);

/** Pins against `pinnedColor`: the front piece is worth less than the piece behind it (absolute when behind is the king). */
export function pinsAgainst(fen: string, pinnedColor: Color): LineUpFact[] {
  const c = new Chess(fen);
  return lineUps(c, opp(pinnedColor)).filter((l) => l.front.type !== 'k' && (l.absolute || (worth(l.behind.type) > worth(l.front.type) && worth(l.behind.type) > worth(l.attacker.type))));
}

/** Skewers against `victimColor`: the front piece is worth more than (or is the king in front of) a piece of value >= 3 behind it. */
export function skewersAgainst(fen: string, victimColor: Color): LineUpFact[] {
  const c = new Chess(fen);
  return lineUps(c, opp(victimColor)).filter((l) => worth(l.front.type) > worth(l.behind.type) && VAL[l.behind.type] >= 3);
}

const key = (l: LineUpFact) => `${l.attacker.sq}${l.front.sq}${l.behind.sq}`;

/** Pins or skewers that exist after `uci` but not before, created by the moved piece. */
export function newLineUps(fenBefore: string, uci: string, kind: 'pin' | 'skewer'): LineUpFact[] {
  const c = new Chess(fenBefore);
  const m = uciToMove(c, uci);
  if (!m) return [];
  const victim = opp(m.color);
  const f = kind === 'pin' ? pinsAgainst : skewersAgainst;
  const before = new Set(f(fenBefore, victim).map(key));
  return f(c.fen(), victim).filter((l) => !before.has(key(l)) && l.attacker.sq === m.to);
}

export interface DiscoveredFact { slider: PieceRef; target: PieceRef; check: boolean }

/** A different piece of the mover now attacks a worthwhile target through the square the moved piece left. */
export function discoveredAfter(fenBefore: string, uci: string): DiscoveredFact[] {
  const c0 = new Chess(fenBefore);
  const c = new Chess(fenBefore);
  const m = uciToMove(c, uci);
  if (!m) return [];
  const enemy = opp(m.color);
  const [ff, fr] = coords(m.from);
  const out: DiscoveredFact[] = [];
  for (const s of pieces(c, m.color)) {
    if (s.sq === m.to || !dirsFor(s.type).length) continue;
    const [sf, sr] = coords(s.sq);
    const df = Math.sign(ff - sf), dr = Math.sign(fr - sr);
    const aligned = (df === 0 || dr === 0 || Math.abs(ff - sf) === Math.abs(fr - sr)) && !(df === 0 && dr === 0);
    if (!aligned || !dirsFor(s.type).some(([a, b]) => a === df && b === dr)) continue;
    // walk from the slider through the vacated square
    let f = sf, r = sr, passed = false;
    for (;;) {
      f += df; r += dr;
      if (f < 0 || f > 7 || r < 0 || r > 7) break;
      const sq = sqName(f, r);
      if (sq === m.from) { passed = true; continue; }
      const p = c.get(sq);
      if (!p) continue;
      if (!passed || p.color !== enemy) break;
      const wasAttacked = c0.attackers(sq, m.color).includes(s.sq);
      const defended = c.attackers(sq, enemy).length > 0;
      if (!wasAttacked && (p.type === 'k' || VAL[p.type] > VAL[s.type] || (!defended && VAL[p.type] >= 3))) {
        out.push({ slider: s, target: { sq, type: p.type, color: p.color }, check: p.type === 'k' });
      }
      break;
    }
  }
  return out;
}

/** The mating move of a line is a back-rank mate: rook or queen mates a king on its own first rank. */
export function isBackRankMate(fenBefore: string, pv: string[]): boolean {
  const c = new Chess(fenBefore);
  let last: Move | null = null;
  for (const u of pv) { last = uciToMove(c, u); if (!last) return false; if (c.isCheckmate()) break; }
  if (!last || !c.isCheckmate()) return false;
  const mated = c.turn();
  const kSq = pieces(c, mated).find((p) => p.type === 'k')!.sq;
  const home = mated === 'w' ? '1' : '8';
  return kSq[1] === home && last.to[1] === home && (last.piece === 'r' || last.piece === 'q');
}

/** The line reaches checkmate within the given number of plies. */
export function lineMates(fenBefore: string, pv: string[], maxPlies = 99): { plies: number; mover: Color } | null {
  const c = new Chess(fenBefore);
  for (let i = 0; i < Math.min(pv.length, maxPlies); i++) {
    const m = uciToMove(c, pv[i]);
    if (!m) return null;
    if (c.isCheckmate()) return { plies: i + 1, mover: m.color };
  }
  return null;
}

/** First promotion by `color` within maxPlies of the line. */
export function promotionIn(fenBefore: string, pv: string[], color: Color, maxPlies = 6): { ply: number; sq: Square; to: PieceSymbol } | null {
  const c = new Chess(fenBefore);
  for (let i = 0; i < Math.min(pv.length, maxPlies); i++) {
    const m = uciToMove(c, pv[i]);
    if (!m) return null;
    if (m.promotion && m.color === color) return { ply: i, sq: m.to, to: m.promotion };
  }
  return null;
}

export interface RemoveDefenderFact { defender: PieceRef; target: PieceRef }

/** The first move captures a piece that was defending another enemy piece, which the mover then wins later in the line. */
export function removesDefender(fenBefore: string, pv: string[]): RemoveDefenderFact | null {
  if (pv.length < 3) return null;
  const c = new Chess(fenBefore);
  const first = uciToMove(new Chess(fenBefore), pv[0]);
  if (!first || !first.captured) return null;
  const enemy = opp(first.color);
  const defended = pieces(c, enemy).filter((p) => p.type !== 'k' && p.sq !== first.to && VAL[p.type] >= 3 && c.attackers(p.sq, enemy).includes(first.to));
  if (!defended.length) return null;
  const walk = new Chess(fenBefore);
  for (let i = 0; i < Math.min(pv.length, 5); i++) {
    const m = uciToMove(walk, pv[i]);
    if (!m) return null;
    if (i >= 2 && m.color === first.color && m.captured) {
      const t = defended.find((d) => d.sq === m.to && d.type === m.captured);
      if (t) return { defender: { sq: first.to, type: first.captured, color: enemy }, target: t };
    }
  }
  return null;
}

/** Things about the played move that make it look natural (only literal facts). */
export function moveAppeal(fenBefore: string, uci: string, plyIndex: number): string[] {
  const c = new Chess(fenBefore);
  const m = uciToMove(c, uci);
  if (!m) return [];
  const out: string[] = [];
  if (m.captured) out.push(`it captures a ${({ p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' })[m.captured]}`);
  if (m.san.includes('+')) out.push('it gives check');
  if (m.flags.includes('k') || m.flags.includes('q')) out.push('castling is a natural, safe-looking move');
  const before = new Chess(fenBefore);
  const newlyAttacked = pieces(c, opp(m.color)).filter((p) => p.type !== 'k' && VAL[p.type] >= 3 && c.attackers(p.sq, m.color).includes(m.to) && !before.attackers(p.sq, m.color).length);
  if (newlyAttacked.length && !m.captured) out.push(`it attacks the ${({ p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' })[newlyAttacked[0].type]} on ${newlyAttacked[0].sq}`);
  const hangBefore = hangingPieces(fenBefore, m.color, 3).map((h) => h.sq);
  if (hangBefore.includes(m.from) && !hangingPieces(c.fen(), m.color, 3).some((h) => h.sq === m.to)) out.push('it moves a threatened piece to safety');
  const backRank = m.color === 'w' ? '1' : '8';
  if (plyIndex <= 24 && (m.piece === 'n' || m.piece === 'b') && m.from[1] === backRank) out.push('it develops a piece');
  return out;
}

/** Material swing re-export for callers that only import facts. */
export { materialAlongPv };

/** Count of knights, bishops, rooks and queens on the board (both sides). */
export function majorsMinors(fen: string): number {
  const board = fen.split(' ')[0];
  return (board.match(/[nbrqNBRQ]/g) ?? []).length;
}

/**
 * Material change for `pov` at the deepest quiet point of a line (no capture just made or pending, side to move not in check),
 * within maxPlies. `plies` is the first ply from which that material result held.
 */
export function settledMaterial(fen: string, pv: string[], pov: Color, maxPlies = 12): { net: number; plies: number } {
  const c = new Chess(fen);
  const val = (cc: Chess, col: Color) => { let s = 0; for (const row of cc.board()) for (const p of row) if (p && p.color === col) s += VAL[p.type]; return s; };
  const start = val(c, pov) - val(c, opp(pov));
  let net = 0, at = 0, lastNet = 0;
  const n = Math.min(pv.length, maxPlies);
  for (let i = 0; i < n; i++) {
    const m = uciToMove(c, pv[i]);
    if (!m) break;
    if (c.isCheckmate()) break;
    const nowNet = val(c, pov) - val(c, opp(pov)) - start;
    if (nowNet !== lastNet) { lastNet = nowNet; at = i + 1; }
    const next = i + 1 < pv.length ? pv[i + 1] : null;
    const nextCaptures = !!next && !!c.get(next.slice(2, 4) as Square);
    const quiet = !m.captured && !m.promotion && !nextCaptures && !c.inCheck();
    if (quiet || i === n - 1) net = nowNet;
  }
  return { net, plies: at };
}
