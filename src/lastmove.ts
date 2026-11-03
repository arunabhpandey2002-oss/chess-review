// The opponent's move that led to a training position: "Last move: 16. Bf4", with its squares for the board highlight.
import { Chess } from 'chess.js';
import type { MomentCore } from './explain';

export interface LastMove { san: string; uci: string; from: string; to: string; label: string }
/** A known last move, 'start' for the starting position, or null when it is not known. */
export type LastMoveInfo = LastMove | 'start' | null;

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
/** Position key without the move counters, for matching positions. */
const posKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ');

/** Label a move played from prevFen: "15. Bxf4" for White, "15... Nc6" for Black. */
export function describeMove(prevFen: string, uci: string): LastMove | null {
  try {
    const c = new Chess(prevFen);
    const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
    if (!mv) return null;
    const f = prevFen.split(' ');
    const n = Number(f[5]) || 1;
    return { san: mv.san, uci, from: mv.from, to: mv.to, label: `${n}${f[1] === 'b' ? '...' : '.'} ${mv.san}` };
  } catch { return null; }
}

/** From the saved position itself (prevUci + prevFen). */
export function lastMoveOf(core: Pick<MomentCore, 'fenBefore' | 'prevUci' | 'prevFen'>): LastMoveInfo {
  if (core.prevUci && core.prevFen) {
    const d = describeMove(core.prevFen, core.prevUci);
    if (d) return d;
  }
  if (posKey(core.fenBefore) === START) return 'start';
  return null;
}

/** For old saved positions without their prior move: replay the game PGN and find the move that reached fenBefore. */
export function lastMoveFromPgn(pgn: string, fenBefore: string, ply?: number): LastMoveInfo {
  try {
    const g = new Chess();
    g.loadPgn(pgn);
    const hist = g.history({ verbose: true });
    const want = posKey(fenBefore);
    const hit = (i: number) => i >= 0 && i < hist.length && posKey(hist[i].before) === want;
    // prefer the stored ply (index of the player's move), else the first match
    const i = ply != null && hit(ply) ? ply : hist.findIndex((h) => posKey(h.before) === want);
    if (i < 0) return null;
    if (i === 0) return posKey(hist[0].before) === START ? 'start' : null;
    const p = hist[i - 1];
    return describeMove(p.before, p.from + p.to + (p.promotion ?? ''));
  } catch { return null; }
}

export function lastMoveText(info: LastMoveInfo): string | null {
  if (info === 'start') return 'Last move: none (start of game)';
  if (!info) return null;
  return `Last move: ${info.label}`;
}
