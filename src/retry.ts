// Retry-mode move acceptance. Any move within a win% tolerance of the engine's best is accepted.
export type Verdict = 'correct' | 'close' | 'wrong' | 'played';

/** Tolerance in win% points: 30% of the gap between best and the game move, between 3 and 8. */
export function tolerance(wpBest: number, wpPlayed: number): number {
  const gap = Math.max(0, wpBest - wpPlayed);
  return Math.max(3, Math.min(8, gap * 0.3));
}

export interface JudgeInput {
  wpBest: number;
  wpPlayed: number;
  wpCand: number;
  isPlayed: boolean;
  /** Best line is a forced mate for the player, and the candidate keeps a forced mate. */
  bestMates?: boolean;
  candMates?: boolean;
}

export function judge(j: JudgeInput): Verdict {
  if (j.isPlayed) return 'played';
  if (j.bestMates && j.candMates) return 'correct';
  const tol = tolerance(j.wpBest, j.wpPlayed);
  const loss = j.wpBest - j.wpCand;
  if (loss <= tol) return 'correct';
  const gap = j.wpBest - j.wpPlayed;
  if (j.wpCand - j.wpPlayed >= gap * 0.5) return 'close';
  return 'wrong';
}
