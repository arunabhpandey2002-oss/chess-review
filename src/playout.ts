// "Play it out": strength settings for the sparring engine and the end-of-game summary.
// Pure functions so they can be unit tested without a browser.
import type { Source } from './explain';

export interface Strength {
  rating: number;
  /** Extra UCI options sent once when the engine starts. */
  options: string[];
  depth: number;
  movetime: number;
  label: string;
}

/** Stockfish 19 accepts UCI_Elo from 1320 to 3190. Below that we use Skill Level 0 and a shallow search. */
export const ELO_MIN = 1320;
export const ELO_MAX = 3190;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export function strengthFor(rating?: number | null): Strength {
  const r = Math.round(rating && rating > 0 ? rating : 1200);
  if (r >= ELO_MIN) {
    const elo = clamp(r, ELO_MIN, ELO_MAX);
    return { rating: r, options: ['UCI_LimitStrength value true', `UCI_Elo value ${elo}`], depth: 12, movetime: 600, label: `Stockfish limited to ${elo} Elo` };
  }
  const t = clamp((r - 400) / (ELO_MIN - 400), 0, 1);
  const depth = 1 + Math.round(t * 4);
  return { rating: r, options: ['Skill Level value 0'], depth, movetime: 100 + Math.round(t * 300), label: `Stockfish at skill 0, depth ${depth} (its weakest settings; may still be stronger than ${r})` };
}

export type Outcome = 'mate-win' | 'mate-loss' | 'stalemate' | 'repetition' | 'insufficient' | 'fifty' | 'draw' | 'resigned' | 'stopped';

export interface MyMove {
  label: string; // e.g. "16." or "16..."
  san: string; // move text (token or SAN)
  bestSan: string; // engine's best move in the same position
  wpBefore: number; // your win% with best play before the move
  wpAfter: number; // your win% after the move
}

export interface PlayoutSummary { result: string; takeaways: { text: string; src: Source }[]; biggest: MyMove | null }

const RESULT: Record<Outcome, string> = {
  'mate-win': 'You won by checkmate.',
  'mate-loss': 'The engine checkmated you.',
  stalemate: 'Draw by stalemate.',
  repetition: 'Draw by threefold repetition.',
  insufficient: 'Draw: not enough material to mate.',
  fifty: 'Draw by the 50-move rule.',
  draw: 'The game ended in a draw.',
  resigned: 'You resigned.',
  stopped: 'You stopped the game.',
};

export const SLIP = 8; // win% drop that counts as a real slip

export function summarizePlayout(o: { outcome: Outcome; startWp: number; finalWp: number | null; mine: MyMove[] }): PlayoutSummary {
  const fin = o.outcome === 'mate-win' ? 100 : o.outcome === 'mate-loss' || o.outcome === 'resigned' ? 0
    : ['stalemate', 'repetition', 'insufficient', 'fifty', 'draw'].includes(o.outcome) ? 50 : o.finalWp;
  const n = o.mine.length;
  const result = `${RESULT[o.outcome]} You played ${n} move${n === 1 ? '' : 's'}.`;
  const takeaways: PlayoutSummary['takeaways'] = [];
  const s = Math.round(o.startWp);
  if (fin != null) {
    const f = Math.round(fin);
    if (s >= 60) takeaways.push({ text: f >= s - 10 ? `You kept your advantage: your win chance went from ${s}% to ${f}%.` : `The advantage slipped: your win chance went from ${s}% to ${f}%.`, src: 'engine' });
    else if (s > 40) takeaways.push({ text: `From a balanced position (${s}%), you finished at ${f}%.`, src: 'engine' });
    else takeaways.push({ text: f > s + 10 ? `You started worse (${s}%) and fought back to ${f}%.` : `You started worse (${s}%) and finished at ${f}%.`, src: 'engine' });
  }
  let biggest: MyMove | null = null;
  for (const m of o.mine) if (!biggest || m.wpBefore - m.wpAfter > biggest.wpBefore - biggest.wpAfter) biggest = m;
  if (biggest) {
    const d = Math.round(biggest.wpBefore - biggest.wpAfter);
    if (d >= SLIP) takeaways.push({ text: `Biggest slip: ${biggest.label} ${biggest.san} cost ${d}% win chance. ${biggest.bestSan} was better.`, src: 'engine' });
    else { takeaways.push({ text: `No move of yours lost more than ${Math.max(0, d)}% win chance.`, src: 'engine' }); biggest = null; }
  }
  return { result, takeaways: takeaways.slice(0, 2), biggest };
}
