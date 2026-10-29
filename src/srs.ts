// Spaced repetition: SM-2 style scheduler with quality derived from attempts and hints.
export interface Attempt {
  t: number; // timestamp (ms)
  solved: boolean;
  attempts: number; // moves tried (including the solving move)
  hints: number; // 0-4 hint stages used
  revealed: boolean; // gave up and looked at the answer
  close: number; // wrong tries that were close to good enough
  quality: number;
  failure?: 'calculation' | 'concept';
}

export interface SrsState {
  ease: number;
  interval: number; // days
  reps: number; // successful reviews in a row (SM-2 "n")
  lapses: number;
  due: number; // ms timestamp
  retired: boolean;
  history: Attempt[];
}

export const DAY = 86400000;
export const MIN = 60000;
export const RETIRE = { streak: 4, interval: 21 };

export function newSrs(now: number): SrsState {
  return { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: now, retired: false, history: [] };
}

/** 0-5 quality. 5 = first try without hints; < 3 = failed (gave up, or needed the candidate list). */
export function quality(o: { solved: boolean; attempts: number; hints: number; revealed: boolean }): number {
  if (!o.solved || o.revealed) return o.attempts <= 1 && o.hints === 0 ? 0 : 1;
  if (o.hints >= 4) return 2;
  if (o.hints === 0 && o.attempts <= 1) return 5;
  if (o.hints === 0 && o.attempts === 2) return 4;
  if (o.hints === 1 && o.attempts <= 2) return 4;
  return 3;
}

/** Calculation failure: the player found the right area but not the exact move (close tries, no idea hint needed). Concept: needed the motif hint or never got close. */
export function failureType(o: { solved: boolean; hints: number; close: number; revealed: boolean; attempts: number }): 'calculation' | 'concept' | undefined {
  if (o.solved && o.hints === 0 && o.attempts <= 1) return undefined;
  if (o.hints >= 3) return 'concept';
  if (o.close > 0) return 'calculation';
  return o.solved ? undefined : 'concept';
}

export function schedule(s: SrsState, o: { solved: boolean; attempts: number; hints: number; revealed: boolean; close?: number }, now: number): SrsState {
  const q = quality(o);
  const att: Attempt = { t: now, solved: o.solved && !o.revealed, attempts: o.attempts, hints: o.hints, revealed: o.revealed, close: o.close ?? 0, quality: q, failure: failureType({ ...o, close: o.close ?? 0 }) };
  const n: SrsState = { ...s, history: [...s.history, att] };
  if (q < 3) {
    n.lapses = s.lapses + 1;
    n.reps = 0;
    n.interval = 0;
    // fail: back in 10 minutes the first time today, otherwise tomorrow
    const failedRecently = s.history.some((h) => h.quality < 3 && now - h.t < DAY);
    n.due = now + (failedRecently ? DAY : 10 * MIN);
    n.ease = Math.max(1.3, s.ease - 0.2);
    n.retired = false;
    return n;
  }
  n.reps = s.reps + 1;
  if (n.reps === 1) n.interval = q === 5 ? 2 : 1;
  else if (n.reps === 2) n.interval = q === 5 ? 6 : q === 4 ? 4 : 3;
  else n.interval = Math.round(Math.max(1, s.interval) * s.ease * (q === 3 ? 0.8 : q === 5 ? 1.15 : 1));
  n.ease = Math.max(1.3, s.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  n.due = now + n.interval * DAY;
  n.retired = n.reps >= RETIRE.streak && n.interval >= RETIRE.interval && q >= 4;
  return n;
}

export const isDue = (s: SrsState, now: number) => !s.retired && s.due <= now;

/** When a new failure shows a weakness has come back, bring retired puzzles with the same tag back into the queue. */
export function reactivate(s: SrsState, now: number): SrsState {
  if (!s.retired) return s;
  return { ...s, retired: false, reps: Math.max(0, s.reps - 2), interval: 1, due: now + DAY };
}

export function srsStatus(s: SrsState, now: number): 'new' | 'due' | 'learning' | 'scheduled' | 'mastered' {
  if (s.retired) return 'mastered';
  if (!s.history.length) return 'new';
  if (s.due <= now) return 'due';
  return s.reps === 0 ? 'learning' : 'scheduled';
}
