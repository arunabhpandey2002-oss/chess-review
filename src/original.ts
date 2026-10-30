// The game's own continuation after a moment, for "Compare with original".
import type { Score, PosEval } from './engine';
import type { Ply } from './review';
import { parseGame } from './review';
import * as store from './store';
import type { Original } from './sparring';

const MAX = 40;
export function originalFrom(plies: Ply[], evals: (PosEval | null)[], startFen: string, playedUci: string): Original | null {
  const i = plies.findIndex((p) => p.fenBefore === startFen && p.uci === playedUci);
  if (i < 0) return null;
  const ucis = plies.slice(i, i + MAX).map((p) => p.uci);
  const ev: (Score | null)[] = [];
  for (let k = 0; k <= ucis.length; k++) ev.push(evals[i + k]?.lines[0]?.score ?? null);
  return { ucis, evals: ev };
}

/** Loads the original continuation for a saved puzzle from this device (the stored game and any cached evals). */
export async function originalForPuzzle(profileKey: string, gameId: string, startFen: string, playedUci: string): Promise<Original | null> {
  const g = await store.get<store.StoredGame>('games', `${profileKey}|${gameId}`);
  if (!g?.game.pgn) return null;
  const { plies } = parseGame(g.game.pgn);
  let evals: (PosEval | null)[] = [];
  for (const d of [22, 18, 14]) {
    try { const s = localStorage.getItem(`cr1:${gameId}:${d}`); if (s) { const e = JSON.parse(s); if (Array.isArray(e) && e.length === plies.length + 1) { evals = e; break; } } } catch { /* ignore */ }
  }
  return originalFrom(plies, evals, startFen, playedUci);
}
