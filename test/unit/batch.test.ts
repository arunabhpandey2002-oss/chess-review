import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planBatch, completed, priorityOf, criticalPlies, estimateSeconds, cacheKey } from '../../src/batch';
import { evidenceLevel } from '../../src/insights';
import { parseGame } from '../../src/review';
import type { GameSummary } from '../../src/api';

const pgn = readFileSync(new URL('../game.pgn', import.meta.url), 'utf8');
const short = '[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
const mk = (id: string, endTime: number, res: 'win' | 'loss' | 'draw', body = pgn, result?: string): GameSummary => {
  const r = result ?? (res === 'win' ? '1-0' : res === 'loss' ? '0-1' : '1/2-1/2');
  const p = body.replace(/\[Result "[^"]*"\]/, `[Result "${r}"]`);
  return { id, url: '', pgn: /\[Result/.test(p) ? p : `[Result "${r}"]\n\n${p}`, endTime, timeClass: 'rapid', timeControl: '600', opening: '', rated: true,
    white: { username: 'me', rating: 1200, result: res === 'win' ? 'win' : res === 'draw' ? 'agreed' : 'checkmated' },
    black: { username: 'op', rating: 1200, result: res === 'win' ? 'checkmated' : res === 'draw' ? 'agreed' : 'win' } };
};

describe('batch planning', () => {
  it('only finished games', () => {
    expect(completed(mk('a', 1, 'win'))).toBe(true);
    expect(completed(mk('b', 1, 'win', pgn, '*'))).toBe(false);
    expect(completed({ ...mk('c', 0, 'win') })).toBe(false);
  });
  it('losses first, then draws, then wins; short games last', () => {
    const l = priorityOf(mk('l', 1, 'loss'), 'me'), d = priorityOf(mk('d', 1, 'draw'), 'me'), w = priorityOf(mk('w', 1, 'win'), 'me');
    const s = priorityOf(mk('s', 1, 'loss', short), 'me');
    expect(l).toBeGreaterThan(d); expect(d).toBeGreaterThan(w); expect(w).toBeGreaterThan(s);
  });
  it('drops duplicates, same-move games, reviewed and unfinished games; respects n and since', () => {
    const v = (m: string) => short.replace('4. Qxf7#', m);
    const games = [mk('a', 10, 'win'), mk('a', 10, 'win'), mk('b', 9, 'loss', pgn), mk('c', 8, 'win', v('4. Qxf7+'), '*'), mk('r', 7, 'draw', v('4. Qf3')), mk('o', 5, 'loss', v('4. Qg4'))];
    const { pick, skipped } = planBatch(games, 'me', new Set(['r']), 10);
    expect(pick.map((g) => g.id).sort()).toEqual(['a', 'o']);
    expect(skipped).toEqual([{ id: 'a', why: 'duplicate' }, { id: 'b', why: 'same moves as another game' }, { id: 'c', why: 'not a finished game' }, { id: 'r', why: 'already reviewed' }]);
    const two = [mk('x', 3, 'win'), mk('y', 2, 'loss', short)];
    expect(planBatch(two, 'me', new Set(), 1).pick.map((g) => g.id)).toEqual(['x']);
    expect(planBatch(two, 'me', new Set(), 10, 2).pick.map((g) => g.id)).toEqual(['x']);
  });
  it('orders the picked games by priority', () => {
    const { pick } = planBatch([mk('w', 3, 'win'), mk('l', 2, 'loss', short)], 'me', new Set(), 10);
    expect(pick.map((g) => g.id)).toEqual(['w', 'l']); // a 4-move loss ranks below a full-length win
  });
  it('critical plies: my moves that lost 8% or more, at most 10', () => {
    const plies = parseGame(pgn).plies;
    const ev = JSON.parse(readFileSync(new URL('../game.pgn.native20.evals.json', import.meta.url), 'utf8'));
    const c = criticalPlies(plies, ev, 'w');
    expect(c.length).toBeGreaterThan(0); expect(c.length).toBeLessThanOrEqual(10);
    expect(c.every((i) => plies[i].color === 'w')).toBe(true);
    expect([...c].sort((a, b) => a - b)).toEqual(c);
  });
  it('cache key names the engine, net, depth and lines', () => {
    expect(cacheKey('8/8/8/8/8/8/8/K6k w - - 0 1', 12, 2)).toMatch(/\|sf19lite\|nn-[0-9a-f]+\|v1\|d12\|mpv2$/);
  });
  it('estimate grows with mode', () => {
    const g = [mk('a', 1, 'win')];
    expect(estimateSeconds(g, 'deep', 1)).toBeGreaterThan(estimateSeconds(g, 'standard', 1));
    expect(estimateSeconds(g, 'standard', 1)).toBeGreaterThan(estimateSeconds(g, 'light', 1));
  });
});

describe('pattern evidence', () => {
  it('labels by how many games support it', () => {
    expect(evidenceLevel(1, 10)).toBe('anecdote');
    expect(evidenceLevel(2, 10)).toBe('possible');
    expect(evidenceLevel(3, 8)).toBe('emerging');
    expect(evidenceLevel(3, 4)).toBe('possible');
    expect(evidenceLevel(5, 10)).toBe('stronger');
    expect(evidenceLevel(5, 20)).toBe('possible');
    expect(evidenceLevel(4, 10)).toBe('emerging');
  });
});
