// Shared by the review page and the batch runner: build the coach view for a reviewed game and save it locally.
import type { Color } from 'chess.js';
import { resultFor, REASONS, type GameSummary } from './api';
import type { PosEval } from './engine';
import { summarize, type MoveReview, type Ply } from './review';
import { buildMoments, buildSummary, type Moment, type GameSummaryView } from './coach';
import type { Level } from './moments';
import { renderText } from './words';
import * as store from './store';
import type { Puzzle, StoredReview } from './store';
import { newPuzzle, rememberGame } from './pages';

export function coachFor(g: GameSummary, me: Color, plies: Ply[], evals: (PosEval | null)[], reviews: (MoveReview | null)[], level: Level): { moments: Moment[]; summary: GameSummaryView } {
  const moments = buildMoments(plies, evals, reviews, me, level, g.timeControl);
  const meSide = me === 'w' ? g.white : g.black;
  const opp = me === 'w' ? g.black : g.white;
  const res = resultFor(g, meSide.username);
  const reasonKey = res === 'win' ? opp.result : meSide.result;
  const reason = REASONS[reasonKey] ?? reasonKey;
  const resultText = res === 'win' ? `You won by ${reason}` : res === 'loss' ? `You lost by ${reason}` : `The game was drawn by ${reason}`;
  const summary = buildSummary({ plies, evals, reviews, me, moments, opening: g.opening, opponent: opp.username, resultText, timeControl: g.timeControl });
  return { moments, summary };
}

export interface SaveExtra { analysis?: StoredReview['analysis']; verify?: Map<number, Puzzle['verify']> }

export async function saveReview(key: string, g: GameSummary, me: Color, plies: Ply[], evals: (PosEval | null)[], reviews: (MoveReview | null)[], moments: Moment[], s: GameSummaryView, rating: number | null, extra: SaveExtra = {}): Promise<Map<number, Puzzle>> {
  const sum = summarize(plies, evals, reviews);
  const meSide = me === 'w' ? g.white : g.black;
  await rememberGame(key, g, me);
  const rv: StoredReview = {
    key: `${key}|${g.id}`, profileKey: key, gameId: g.id, platform: g.platform ?? 'chesscom', url: g.url,
    white: g.white.username, black: g.black.username, myColor: me, result: resultFor(g, meSide.username), opening: g.opening, endTime: g.endTime,
    accuracy: me === 'w' ? sum.accW : sum.accB, errorTags: s.errorTags,
    moments: moments.map((m) => ({ ply: m.ply, tag: m.tags.primary.id, moveNumber: m.moveNumber })),
    story: renderText(s.story.join(' '), 'san'), reviewedAt: Date.now(),
    ...(extra.analysis ? { analysis: extra.analysis } : {}),
  };
  await store.put('reviews', rv);
  const out = new Map<number, Puzzle>();
  for (const m of moments) {
    const p = await store.savePuzzle(newPuzzle({
      id: `${key}|${g.id}|${m.ply}`, profileKey: key, gameId: g.id, gameUrl: g.url, platform: g.platform ?? 'chesscom',
      white: g.white.username, black: g.black.username, endTime: g.endTime, phase: m.phase,
      core: { ...m, lines: m.lines, reply: m.reply }, rating: rating || null, source: 'game', verify: extra.verify?.get(m.ply) ?? null,
    }));
    out.set(m.ply, p);
  }
  return out;
}
