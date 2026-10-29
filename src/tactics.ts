// Concrete board facts used for classification and explanations. Pure functions on chess.js.
import { Chess, type Move, type Square, type PieceSymbol, type Color } from 'chess.js';

export const VAL: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const NAME: Record<PieceSymbol, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export function material(c: Chess, color: Color): number {
  let s = 0;
  for (const row of c.board()) for (const sq of row) if (sq && sq.color === color) s += VAL[sq.type];
  return s;
}

export function uciToMove(c: Chess, uci: string): Move | null {
  try {
    return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] as PieceSymbol | undefined });
  } catch {
    return null;
  }
}

/** Convert a UCI PV to SAN strings from a FEN; stops at the first illegal move. */
export function pvToSan(fen: string, pv: string[], max = 99): string[] {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const u of pv.slice(0, max)) {
    const m = uciToMove(c, u);
    if (!m) break;
    out.push(m.san);
  }
  return out;
}

export function formatPv(fen: string, sans: string[]): string {
  const parts = fen.split(' ');
  let num = +parts[5];
  let white = parts[1] === 'w';
  const out: string[] = [];
  sans.forEach((s, i) => {
    if (white) out.push(`${num}.${s}`);
    else out.push(i === 0 ? `${num}...${s}` : s);
    if (!white) num++;
    white = !white;
  });
  return out.join(' ');
}

export interface MaterialSwing {
  /** Net material change for `pov` (pawns) over the forcing part of the line. */
  net: number;
  gained: PieceSymbol[]; // opponent pieces captured
  lost: PieceSymbol[]; // own pieces captured
  plies: number; // plies of the line considered
  sans: string[];
  mate: boolean; // line ends in checkmate
}

/**
 * Walk a PV and measure material for `pov` until the line goes quiet (a non-capture,
 * non-promotion move after the exchanges), capped at maxPlies.
 */
export function materialAlongPv(fen: string, pv: string[], pov: Color, maxPlies = 10): MaterialSwing {
  const c = new Chess(fen);
  const start = material(c, pov) - material(c, pov === 'w' ? 'b' : 'w');
  const gained: PieceSymbol[] = [];
  const lost: PieceSymbol[] = [];
  const sans: string[] = [];
  let bestStop = 0;
  let gainedAt: PieceSymbol[] = [], lostAt: PieceSymbol[] = [];
  let netAt = 0;
  for (let i = 0; i < Math.min(pv.length, maxPlies); i++) {
    const m = uciToMove(c, pv[i]);
    if (!m) break;
    sans.push(m.san);
    if (m.captured) (m.color === pov ? gained : lost).push(m.captured);
    if (m.promotion) {
      // promotion changes material: pawn -> piece
      if (m.color === pov) gained.push(m.promotion); else lost.push(m.promotion);
    }
    const nextIsTactical = (() => {
      if (i + 1 >= pv.length || i + 1 >= maxPlies) return false;
      const from = pv[i + 1].slice(2, 4) as Square;
      const p = c.get(from);
      return !!p || pv[i + 1].length === 5 || c.inCheck();
    })();
    if (c.isCheckmate()) {
      return { net: 0, gained: [...gained], lost: [...lost], plies: i + 1, sans, mate: true };
    }
    if (!nextIsTactical) {
      bestStop = i + 1;
      netAt = material(c, pov) - material(c, pov === 'w' ? 'b' : 'w') - start;
      gainedAt = [...gained];
      lostAt = [...lost];
      // stop at the first quiet point after at least one ply that changed material,
      // or after 2 plies if nothing happened yet
      if (gained.length || lost.length || i >= 1) break;
    }
  }
  if (!bestStop) {
    netAt = material(c, pov) - material(c, pov === 'w' ? 'b' : 'w') - start;
    gainedAt = gained; lostAt = lost; bestStop = sans.length;
  }
  return { net: netAt, gained: gainedAt, lost: lostAt, plies: bestStop, sans: sans.slice(0, bestStop), mate: false };
}

function cheapest(types: PieceSymbol[]): PieceSymbol | null {
  if (!types.length) return null;
  return types.reduce((a, b) => (VAL[a] <= VAL[b] ? a : b));
}

/**
 * Pieces of `color` (value >= minVal) the side to move can win immediately, using a simple
 * one-step exchange estimate: gain = value(target) - (defended ? value(cheapest legal attacker) : 0).
 * The board must have the opponent of `color` to move.
 */
export function winnableTargets(c: Chess, color: Color, minVal = 3): { sq: Square; type: PieceSymbol; gain: number }[] {
  const res: { sq: Square; type: PieceSymbol; gain: number }[] = [];
  const caps = c.moves({ verbose: true }).filter((m) => m.captured);
  const bySq = new Map<Square, PieceSymbol[]>();
  for (const m of caps) {
    if (!bySq.has(m.to)) bySq.set(m.to, []);
    bySq.get(m.to)!.push(m.piece);
  }
  for (const [sq, attackers] of bySq) {
    const p = c.get(sq);
    if (!p || p.color !== color || VAL[p.type] < minVal) continue;
    const a = cheapest(attackers)!;
    const defended = c.attackers(sq, color).length > 0;
    const gain = VAL[p.type] - (defended ? VAL[a] : 0);
    if (gain > 0) res.push({ sq, type: p.type, gain });
  }
  return res.sort((x, y) => y.gain - x.gain);
}

/** Is `move` (played from fenBefore) a material sacrifice? Returns the sacrificed piece or null. */
export function sacrifice(fenBefore: string, uci: string): { sq: Square; type: PieceSymbol; net: number } | null {
  const c = new Chess(fenBefore);
  const m = uciToMove(c, uci);
  if (!m) return null;
  if (c.isCheckmate()) return null;
  const capturedVal = m.captured ? VAL[m.captured] : 0;
  const t = winnableTargets(c, m.color, 3);
  if (!t.length) return null;
  const top = t[0];
  // A freshly promoted piece only "cost" a pawn.
  const gain = m.promotion && top.sq === m.to ? Math.min(top.gain, 1) : top.gain;
  const net = gain - capturedVal;
  return net >= 2 ? { sq: top.sq, type: top.type, net } : null;
}

/** Pieces the moved piece attacks after the move: returns attacked enemy squares worth noting. */
export function forkTargets(fenBefore: string, uci: string): PieceSymbol[] | null {
  const c = new Chess(fenBefore);
  const m = uciToMove(c, uci);
  if (!m) return null;
  const myVal = VAL[m.promotion ?? m.piece];
  const enemy: Color = m.color === 'w' ? 'b' : 'w';
  const targets: PieceSymbol[] = [];
  for (const row of c.board()) {
    for (const p of row) {
      if (!p || p.color !== enemy) continue;
      const atk = c.attackers(p.square, m.color);
      if (!atk.includes(m.to)) continue;
      if (p.type === 'k') { targets.push('k'); continue; }
      const defended = c.attackers(p.square, enemy).length > 0;
      if (VAL[p.type] > myVal || (!defended && VAL[p.type] >= 3)) targets.push(p.type);
    }
  }
  if (targets.length < 2) return null;
  return targets.sort((a, b) => (a === 'k' ? -1 : b === 'k' ? 1 : VAL[b] - VAL[a]));
}

/** Simple capture that obviously wins material (captured piece undefended or worth at least the capturer). */
export function isObviousCapture(fenBefore: string, uci: string): boolean {
  const c = new Chess(fenBefore);
  const m = uciToMove(c, uci);
  if (!m || !m.captured) return false;
  if (VAL[m.captured] >= VAL[m.piece]) return true;
  const enemy: Color = m.color === 'w' ? 'b' : 'w';
  return c.attackers(m.to, enemy).length === 0;
}

export function isRecapture(prevMove: Move | null, uci: string): boolean {
  return !!prevMove && !!prevMove.captured && uci.slice(2, 4) === prevMove.to;
}

export function hangingAfter(fenAfter: string, mover: Color): { sq: Square; type: PieceSymbol; gain: number } | null {
  const c = new Chess(fenAfter);
  const t = winnableTargets(c, mover, 1);
  return t.length ? t[0] : null;
}
