// Critical-moment selection: at most three teachable moments for the reviewed player.
import type { Motif } from './concepts';
import type { Cls } from './classify';

export type Level = 'beginner' | 'intermediate' | 'advanced';
export const LEVEL_LABEL: Record<Level, string> = { beginner: 'Beginner (under 1000)', intermediate: 'Intermediate (1000-1800)', advanced: 'Advanced (over 1800)' };

export function levelForRating(r?: number | null): Level {
  if (!r || !Number.isFinite(r)) return 'intermediate';
  return r < 1000 ? 'beginner' : r <= 1800 ? 'intermediate' : 'advanced';
}

export interface MomentCandidate {
  ply: number; // 0-based ply index in the game
  loss: number; // win% lost by the player (0-100)
  wpBest: number; // player's win% with best play
  wpPlayed: number; // player's win% after the game move
  wpSecond: number | null; // player's win% with the engine's 2nd choice
  cls: Cls;
  motif: Motif; // primary teaching motif
  solutionMotif: Motif; // idea behind the best move
  tacticPlies: number | null; // plies until the tactic pays off (mate or material), null if none
}

/** How much each motif matters at each level (beginners: piece safety and simple tactics first). */
export const MOTIF_WEIGHT: Record<Level, Record<Motif, number>> = {
  beginner: {
    'hanging-piece': 1.7, mate: 1.5, 'back-rank': 1.5, fork: 1.35, 'ignored-threat': 1.4, pin: 1.15, skewer: 1.15, 'discovered-attack': 1.1,
    'removing-defender': 1.0, promotion: 1.2, material: 1.0, defence: 1.1, positional: 0.35,
  },
  intermediate: {
    'hanging-piece': 1.3, mate: 1.35, 'back-rank': 1.35, fork: 1.3, 'ignored-threat': 1.25, pin: 1.25, skewer: 1.25, 'discovered-attack': 1.25,
    'removing-defender': 1.2, promotion: 1.2, material: 1.05, defence: 1.05, positional: 0.75,
  },
  advanced: {
    'hanging-piece': 1.1, mate: 1.2, 'back-rank': 1.2, fork: 1.15, 'ignored-threat': 1.1, pin: 1.15, skewer: 1.15, 'discovered-attack': 1.15,
    'removing-defender': 1.15, promotion: 1.1, material: 1.05, defence: 1.05, positional: 1.0,
  },
};

export interface MomentScore { score: number; why: string[] }

/** Score a candidate or return null when it is not teachable (book, decided, nitpick). */
export function scoreMoment(c: MomentCandidate, level: Level): MomentScore | null {
  if (c.cls === 'book' || c.cls === 'forced') return null;
  const minLoss = level === 'beginner' ? 10 : level === 'intermediate' ? 8 : 6;
  if (c.loss < minLoss) return null;
  // Already decided: still clearly winning after the move, or already lost before it.
  if (c.wpBest >= 97 && c.wpPlayed >= 80) return null;
  if (c.wpBest <= 5) return null;
  if (c.motif === 'positional' && c.solutionMotif === 'positional' && level === 'beginner' && c.loss < 15) return null;
  const why: string[] = [];
  const weight = MOTIF_WEIGHT[level][c.motif] ?? 1;
  const gap = c.wpSecond == null ? 10 : Math.max(0, c.wpBest - c.wpSecond);
  const clarity = 0.6 + 0.4 * Math.min(1, gap / 15);
  if (gap >= 15) why.push('one clearly best move');
  const short = c.tacticPlies != null && c.tacticPlies <= 5 ? 1.15 : c.solutionMotif === 'positional' ? 0.75 : 1;
  if (short > 1) why.push('short, concrete line');
  const miss = c.cls === 'miss' ? 1.1 : 1;
  if (miss > 1) why.push('missed chance to punish');
  const score = Math.min(c.loss, 60) * weight * clarity * short * miss;
  return { score, why };
}

/** Pick at most `max` moments, highest score first, never two on consecutive own moves; returned in game order. */
export function selectMoments<T extends MomentCandidate>(cands: T[], level: Level, max = 3): (T & { score: number; why: string[] })[] {
  const scored = cands
    .map((c) => ({ c, s: scoreMoment(c, level) }))
    .filter((x): x is { c: T; s: MomentScore } => !!x.s)
    .sort((a, b) => b.s.score - a.s.score);
  const out: (T & { score: number; why: string[] })[] = [];
  for (const { c, s } of scored) {
    if (out.length >= max) break;
    if (out.some((o) => Math.abs(o.ply - c.ply) <= 2)) continue;
    out.push({ ...c, score: s.score, why: s.why });
  }
  return out.sort((a, b) => a.ply - b.ply);
}
