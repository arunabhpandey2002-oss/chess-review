// Cross-game recurring-error statistics, with honest small-sample notes.
import { ROLE_PHRASE, MOTIF_INFO, type Motif } from './concepts';
import { isDue, type SrsState } from './srs';

export interface ReviewLike { errorTags: string[]; endTime: number }
export interface TagStat { tag: string; phrase: string; games: number; of: number; share: number }
export type Confidence = 'low' | 'medium' | 'high';

export const MIN_GAMES_FOR_INSIGHT = 3;

export function confidence(n: number): Confidence {
  return n < 5 ? 'low' : n < 15 ? 'medium' : 'high';
}
export function confidenceNote(n: number): string {
  const c = confidence(n);
  if (c === 'low') return `Based on only ${n} reviewed game${n === 1 ? '' : 's'}, so treat this as a hint, not a verdict.`;
  if (c === 'medium') return `Based on ${n} reviewed games; a clearer picture appears after about 15.`;
  return `Based on ${n} reviewed games.`;
}

export function tagPhrase(tag: string): string {
  if (ROLE_PHRASE[tag]) return ROLE_PHRASE[tag];
  const motif = tag.split(':')[1] as Motif;
  return MOTIF_INFO[motif]?.name.toLowerCase() ?? tag;
}

/** Counts in how many of the most recent `window` reviewed games each tag appeared (once per game). */
export function recurringErrors(reviews: ReviewLike[], window = 20): TagStat[] {
  const recent = reviews.slice().sort((a, b) => b.endTime - a.endTime).slice(0, window);
  const n = recent.length;
  const counts = new Map<string, number>();
  for (const r of recent) for (const t of new Set(r.errorTags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, games]) => ({ tag, phrase: tagPhrase(tag), games, of: n, share: n ? games / n : 0 }))
    .sort((a, b) => b.games - a.games || a.tag.localeCompare(b.tag));
}

/** One evidence-based insight for the home screen, or null when there is not enough data. */
export function topInsight(reviews: ReviewLike[]): { text: string; note: string; tag: string } | null {
  if (reviews.length < MIN_GAMES_FOR_INSIGHT) return null;
  const s = recurringErrors(reviews)[0];
  if (!s || s.games < 2) return null;
  return { text: `You ${s.phrase} in ${s.games} of your last ${s.of} reviewed games.`, note: confidenceNote(s.of), tag: s.tag };
}

export function dueCount(items: { srs: SrsState }[], now: number): number {
  return items.filter((p) => isDue(p.srs, now)).length;
}
