import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { Chess } from 'chess.js';
import { validateOpenings, explore, openingName, pct3 } from '../../src/openings';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const K0 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';
const meta = { games: 10, month: '2025-09', minRating: 1800, speeds: 'blitz, rapid, classical', maxPly: 20, licence: 'CC0' };
const fixture = { meta, pos: { [K0]: [10, ['e2e4', 3, 1, 2], ['d2d4', 2, 1, 1], ['e2e5', 9, 9, 9]] } };

describe('opening data validation', () => {
  it('accepts the expected shape and drops bad rows', () => {
    const d = validateOpenings(fixture)!;
    expect(d.pos[K0]).toEqual([10, ['e2e4', 3, 1, 2], ['d2d4', 2, 1, 1], ['e2e5', 9, 9, 9]]);
    const bad = validateOpenings({ meta, pos: { [K0]: [10, ['<b>', 1, 1, 1], ['e2e4', -1, 0, 0], ['d2d4', 1.5, 0, 0], ['g1f3', 1, 0, 0]], 'not a key': [5, ['e2e4', 1, 1, 1]], __proto__x: 1 } })!;
    expect(bad.pos[K0]).toEqual([10, ['g1f3', 1, 0, 0]]);
    expect(Object.keys(bad.pos)).toEqual([K0]);
  });
  it('rejects a file with the wrong metadata', () => {
    expect(validateOpenings(null)).toBeNull();
    expect(validateOpenings({ ...fixture, meta: { ...meta, licence: 'other' } })).toBeNull();
    expect(validateOpenings({ ...fixture, meta: { ...meta, speeds: '<script>' } })).toBeNull();
    expect(validateOpenings({ ...fixture, meta: { ...meta, games: 0 } })).toBeNull();
  });
});

describe('explorer view', () => {
  const d = validateOpenings(fixture)!;
  it('shows only legal moves, most played first, with shares and results from the data', () => {
    const v = explore(START, d)!;
    expect(v.total).toBe(10);
    expect(v.moves.map((m) => m.san)).toEqual(['e4', 'd4']);
    expect(v.moves[0]).toMatchObject({ uci: 'e2e4', games: 6, share: 0.6, white: 0.5 });
    expect(v.moves[0].draws + v.moves[0].white + v.moves[0].black).toBeCloseTo(1);
  });
  it('says nothing when the position is not in the data', () => {
    expect(explore('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', d)).toBeNull();
  });
  it('percentages always add up to 100', () => {
    expect(pct3(1, 1, 1)).toEqual([34, 33, 33]);
    expect(pct3(2, 1, 1).reduce((a, b) => a + b)).toBe(100);
    expect(pct3(0, 0, 0)).toEqual([0, 0, 0]);
  });
});

describe('opening name', () => {
  const book = { 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq': "B00|King's Pawn Game", 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq': '' };
  const c = new Chess(); const fens = [c.fen()]; c.move('e4'); fens.push(c.fen()); c.move('e5'); fens.push(c.fen());
  it('names the exact position, or the last named one on the way', () => {
    expect(openingName(fens.slice(0, 2), book)).toEqual({ eco: 'B00', name: "King's Pawn Game", exact: true });
    expect(openingName(fens, book)).toEqual({ eco: 'B00', name: "King's Pawn Game", exact: false });
    expect(openingName(fens.slice(0, 1), book)).toBeNull();
    expect(openingName(fens, null)).toBeNull();
  });
});

describe('bundled opening file', () => {
  const f = 'public/openings.json';
  it.runIf(existsSync(f))('is valid, small enough and consistent', () => {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    const d = validateOpenings(raw)!;
    expect(d).not.toBeNull();
    expect(Object.keys(d.pos).length).toBe(Object.keys(raw.pos).length); // nothing dropped by validation
    expect(readFileSync(f).length).toBeLessThan(4_000_000);
    const v = explore(START, d)!;
    expect(v.total).toBeGreaterThan(d.meta.games * 0.99); // nearly every game passes through the start position
    expect(v.total).toBeLessThanOrEqual(d.meta.games);
    expect(v.moves.length).toBeGreaterThan(3);
    for (const [k, [total, ...rows]] of Object.entries(d.pos)) {
      const sum = rows.reduce((s, r) => s + r[1] + r[2] + r[3], 0);
      expect(sum, k).toBeLessThanOrEqual(total);
    }
  });
});
