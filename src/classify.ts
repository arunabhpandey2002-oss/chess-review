// Move classification based on expected win-percentage loss (Lichess win% model).
import { MATE_BASE, type Score } from './engine';

export type Cls =
  | 'brilliant' | 'great' | 'best' | 'excellent' | 'good' | 'book' | 'forced'
  | 'inaccuracy' | 'mistake' | 'miss' | 'blunder';

// Okabe-Ito based palette (distinguishable with common colour-vision deficiencies); every class also has a distinct icon.
export const CLS_META: Record<Cls, { label: string; icon: string; color: string; fg: string }> = {
  brilliant: { label: 'Brilliant', icon: '!!', color: '#0072B2', fg: '#fff' },
  great: { label: 'Great', icon: '!', color: '#56B4E9', fg: '#10202b' },
  best: { label: 'Best', icon: '★', color: '#009E73', fg: '#fff' },
  excellent: { label: 'Excellent', icon: '👍', color: '#3fb58f', fg: '#0d231b' },
  good: { label: 'Good', icon: '✓', color: '#7fbf9f', fg: '#10231a' },
  book: { label: 'Book', icon: '📖', color: '#a88865', fg: '#1f160c' },
  forced: { label: 'Forced', icon: '→', color: '#8a9a90', fg: '#111' },
  inaccuracy: { label: 'Inaccuracy', icon: '?!', color: '#F0E442', fg: '#222' },
  mistake: { label: 'Mistake', icon: '?', color: '#E69F00', fg: '#1d1300' },
  miss: { label: 'Miss', icon: '✕', color: '#CC79A7', fg: '#1f0f18' },
  blunder: { label: 'Blunder', icon: '??', color: '#D55E00', fg: '#fff' },
};

export const CLS_ORDER: Cls[] = [
  'brilliant', 'great', 'best', 'excellent', 'good', 'book', 'forced',
  'inaccuracy', 'mistake', 'miss', 'blunder',
];

/**
 * Thresholds (expected win% lost by the mover, 0-100 scale):
 *   Best        played the engine's top move (loss 0)
 *   Excellent   loss <  2
 *   Good        loss <  5
 *   Inaccuracy  loss < 10
 *   Mistake     loss < 20
 *   Blunder     loss >= 20
 * Special labels:
 *   Book        position after the move is in the embedded ECO book and all earlier moves were book
 *   Forced      only legal move
 *   Great       top move AND the 2nd-best engine line is >= 15 win% worse and leaves the mover
 *               at <= 80% (an "only move"); not when in check, not a recapture, not an obviously
 *               winning capture (undefended piece or piece worth at least the capturer)
 *   Brilliant   loss <= 2 AND the move sacrifices material (a piece worth >= 3 can be won by
 *               the opponent for a net gain of >= 2 pawns) AND the mover is not worse after it
 *               (win% >= 50) AND the position was not already totally won (win% < 97)
 *   Miss        the opponent's previous move lost >= 10 win%, best play would have gained >= 10
 *               win% over the position before that error, this move loses >= 10 win%, and it
 *               gives the chance back (mover ends no more than 10 win% below the pre-error level)
 *   Decided positions (best play <= 3% or >= 97%): a move that newly hangs a piece (>= 3) that
 *               the engine's reply takes for >= 3 net is a Blunder when losing, Mistake when winning
 */
export const T = { excellent: 2, good: 5, inaccuracy: 10, mistake: 20, great: 15, missPrev: 10, missCur: 10, missGain: 10 };

/** Lichess winning-chances model. cp is from the perspective of the side we care about. */
export function winPctFromCp(cp: number): number {
  if (cp >= MATE_BASE / 2) return 100;
  if (cp <= -MATE_BASE / 2) return 0;
  const c = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

export function winPct(s: Score, pov: 'w' | 'b'): number {
  return winPctFromCp(pov === 'w' ? s.cp : -s.cp);
}

/** Lichess per-move accuracy from win% lost. */
export function moveAccuracy(loss: number): number {
  const a = 103.1668 * Math.exp(-0.04354 * Math.max(0, loss)) - 3.1669;
  return Math.max(0, Math.min(100, a));
}

/**
 * Lichess game accuracy: mean of a volatility-weighted mean and a harmonic mean of move accuracies.
 * wpWhite: win% for White at each position 0..n; returns [white, black].
 */
export function gameAccuracy(wpWhite: number[], losses: (number | null)[]): [number | null, number | null] {
  const n = losses.length;
  if (n === 0) return [null, null];
  const win = Math.max(2, Math.min(8, Math.floor(n / 10)));
  const weights: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, Math.min(i, wpWhite.length - win));
    const slice = wpWhite.slice(lo, lo + win);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length);
    weights.push(Math.max(0.5, Math.min(12, sd)));
  }
  const out: (number | null)[] = [];
  for (const side of [0, 1]) {
    let ws = 0, wsum = 0, hs = 0, cnt = 0;
    for (let i = side; i < n; i += 2) {
      const l = losses[i];
      if (l == null) continue;
      const a = moveAccuracy(l);
      ws += a * weights[i];
      wsum += weights[i];
      hs += 1 / Math.max(a, 1);
      cnt++;
    }
    if (!cnt) { out.push(null); continue; }
    const weighted = ws / wsum;
    const harmonic = cnt / hs;
    out.push((weighted + harmonic) / 2);
  }
  return [out[0], out[1]];
}
