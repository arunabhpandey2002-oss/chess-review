import { describe, it, expect } from 'vitest';
import { tolerance, judge } from '../../src/retry';
import { newSrs, schedule, quality, isDue, reactivate, srsStatus, DAY, MIN } from '../../src/srs';
import { selectMoments, scoreMoment, levelForRating, type MomentCandidate } from '../../src/moments';
import { groundCheck } from '../../src/explain';
import { recurringErrors, topInsight, confidence } from '../../src/insights';
import { importPgn, lichessGameToSummary } from '../../src/sources';
import { parseClock, parseTimeControl } from '../../src/coach';
import { parseTyped } from '../../src/ui';

describe('retry acceptance', () => {
  it('tolerance is 30% of the gap, clamped to 3..8', () => {
    expect(tolerance(80, 78)).toBe(3);
    expect(tolerance(80, 60)).toBe(6);
    expect(tolerance(90, 10)).toBe(8);
  });
  it('accepts the best move and near-equal alternatives', () => {
    expect(judge({ wpBest: 80, wpPlayed: 40, wpCand: 80, isPlayed: false })).toBe('correct');
    expect(judge({ wpBest: 80, wpPlayed: 40, wpCand: 73, isPlayed: false })).toBe('correct');
  });
  it('marks partial recoveries as close and others as wrong', () => {
    expect(judge({ wpBest: 80, wpPlayed: 40, wpCand: 65, isPlayed: false })).toBe('close');
    expect(judge({ wpBest: 80, wpPlayed: 40, wpCand: 45, isPlayed: false })).toBe('wrong');
  });
  it('the game move is never accepted', () => {
    expect(judge({ wpBest: 80, wpPlayed: 78, wpCand: 78, isPlayed: true })).toBe('played');
  });
  it('any move keeping a forced mate is accepted', () => {
    expect(judge({ wpBest: 100, wpPlayed: 60, wpCand: 99, isPlayed: false, bestMates: true, candMates: true })).toBe('correct');
  });
});

describe('spaced repetition', () => {
  const t0 = Date.UTC(2026, 9, 1);
  it('quality reflects attempts and hints', () => {
    expect(quality({ solved: true, attempts: 1, hints: 0, revealed: false })).toBe(5);
    expect(quality({ solved: true, attempts: 2, hints: 0, revealed: false })).toBe(4);
    expect(quality({ solved: true, attempts: 3, hints: 2, revealed: false })).toBe(3);
    expect(quality({ solved: true, attempts: 2, hints: 4, revealed: false })).toBe(2);
    expect(quality({ solved: false, attempts: 3, hints: 1, revealed: true })).toBe(1);
  });
  it('a failure comes back in 10 minutes, a repeat failure tomorrow', () => {
    let s = schedule(newSrs(t0), { solved: false, attempts: 2, hints: 0, revealed: true }, t0);
    expect(s.due - t0).toBe(10 * MIN);
    expect(isDue(s, t0 + 11 * MIN)).toBe(true);
    s = schedule(s, { solved: false, attempts: 1, hints: 0, revealed: true }, t0 + 11 * MIN);
    expect(s.due - (t0 + 11 * MIN)).toBe(DAY);
  });
  it('easy solves are spaced out and eventually retired', () => {
    let s = newSrs(t0), t = t0;
    const intervals: number[] = [];
    for (let i = 0; i < 6 && !s.retired; i++) {
      s = schedule(s, { solved: true, attempts: 1, hints: 0, revealed: false }, t);
      intervals.push(s.interval);
      t = s.due;
    }
    expect(intervals[0]).toBe(2);
    expect(intervals[1]).toBe(6);
    for (let i = 1; i < intervals.length; i++) expect(intervals[i]).toBeGreaterThan(intervals[i - 1]);
    expect(s.retired).toBe(true);
    expect(srsStatus(s, t)).toBe('mastered');
    const back = reactivate(s, t);
    expect(back.retired).toBe(false);
    expect(back.due - t).toBe(DAY);
  });
  it('hinted solves grow intervals more slowly than clean ones', () => {
    const a = schedule(schedule(newSrs(t0), { solved: true, attempts: 1, hints: 0, revealed: false }, t0), { solved: true, attempts: 1, hints: 0, revealed: false }, t0 + 2 * DAY);
    const b = schedule(schedule(newSrs(t0), { solved: true, attempts: 3, hints: 2, revealed: false }, t0), { solved: true, attempts: 3, hints: 2, revealed: false }, t0 + DAY);
    expect(b.interval).toBeLessThan(a.interval);
  });
});

describe('critical-moment selection', () => {
  const c = (o: Partial<MomentCandidate>): MomentCandidate => ({ ply: 0, loss: 20, wpBest: 60, wpPlayed: 40, wpSecond: 45, cls: 'mistake', motif: 'hanging-piece', solutionMotif: 'hanging-piece', tacticPlies: 3, ...o });
  it('skips book moves, nitpicks and decided positions', () => {
    expect(scoreMoment(c({ cls: 'book' }), 'beginner')).toBeNull();
    expect(scoreMoment(c({ loss: 5 }), 'beginner')).toBeNull();
    expect(scoreMoment(c({ wpBest: 99, wpPlayed: 90 }), 'beginner')).toBeNull();
    expect(scoreMoment(c({ wpBest: 3, wpPlayed: 0 }), 'advanced')).toBeNull();
    expect(scoreMoment(c({ motif: 'positional', solutionMotif: 'positional', loss: 12 }), 'beginner')).toBeNull();
    expect(scoreMoment(c({ motif: 'positional', solutionMotif: 'positional', loss: 12 }), 'advanced')).not.toBeNull();
  });
  it('picks at most three, not on adjacent moves, in game order', () => {
    const cands = [c({ ply: 10, loss: 30 }), c({ ply: 12, loss: 40 }), c({ ply: 20, loss: 25 }), c({ ply: 30, loss: 15 }), c({ ply: 40, loss: 35 })];
    const s = selectMoments(cands, 'intermediate');
    expect(s.map((x) => x.ply)).toEqual([12, 20, 40]);
  });
  it('a missed chance with one clear best move outranks a vague one of equal loss', () => {
    const a = scoreMoment(c({ cls: 'miss', wpSecond: 20 }), 'intermediate')!;
    const b = scoreMoment(c({ wpSecond: 58, tacticPlies: null, motif: 'positional', solutionMotif: 'positional' }), 'intermediate')!;
    expect(a.score).toBeGreaterThan(b.score);
  });
  it('level comes from rating', () => {
    expect(levelForRating(460)).toBe('beginner');
    expect(levelForRating(1500)).toBe('intermediate');
    expect(levelForRating(2100)).toBe('advanced');
  });
});

describe('grounding', () => {
  it('rejects text naming squares that are not in the position or lines', () => {
    const allowed = new Set(['e4', 'e5', 'g1', 'f3']);
    expect(groundCheck('Nf3 attacks the pawn on e5.', allowed)).toBe(true);
    expect(groundCheck('The knight lands on c7 with a fork.', allowed)).toBe(false);
  });
});

describe('recurring errors', () => {
  it('counts each tag once per game and reports small samples honestly', () => {
    const rs = [
      { errorTags: ['allowed:hanging-piece', 'allowed:hanging-piece'], endTime: 1 },
      { errorTags: ['allowed:hanging-piece', 'missed:fork'], endTime: 2 },
      { errorTags: [], endTime: 3 },
      { errorTags: ['allowed:hanging-piece'], endTime: 4 },
    ];
    const s = recurringErrors(rs);
    expect(s[0]).toMatchObject({ tag: 'allowed:hanging-piece', games: 3, of: 4 });
    const ins = topInsight(rs)!;
    expect(ins.text).toBe('You left a piece hanging in 3 of your last 4 reviewed games.');
    expect(ins.note).toMatch(/only 4/);
    expect(confidence(20)).toBe('high');
    expect(topInsight(rs.slice(0, 2))).toBeNull();
  });
});

describe('imports', () => {
  it('refuses unfinished PGNs and reads finished ones', () => {
    const done = '[Event "x"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n[TimeControl "300+2"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
    const live = '[Event "y"]\n[White "A"]\n[Black "B"]\n[Result "*"]\n\n1. e4 e5 *';
    const r = importPgn(done + '\n\n' + live);
    expect(r.ok.length).toBe(1);
    expect(r.ok[0]).toMatchObject({ platform: 'pgn', timeClass: 'blitz', black: { result: 'checkmated' }, white: { result: 'win' } });
    expect(r.errors[0]).toMatch(/in progress/);
  });
  it('maps Lichess games and skips ongoing ones', () => {
    const g = { id: 'abc', variant: 'standard', speed: 'blitz', status: 'resign', winner: 'black', rated: true, clock: { initial: 300, increment: 3 }, lastMoveAt: 1700000000000, opening: { name: 'Sicilian Defense' }, players: { white: { user: { name: 'W' }, rating: 1500 }, black: { user: { name: 'B' }, rating: 1510 } }, pgn: '1. e4 c5 0-1' };
    expect(lichessGameToSummary(g)).toMatchObject({ id: 'li-abc', platform: 'lichess', white: { result: 'resigned' }, black: { result: 'win' }, timeControl: '300+3' });
    expect(lichessGameToSummary({ ...g, status: 'started' })).toBeNull();
    expect(lichessGameToSummary({ ...g, variant: 'chess960' })).toBeNull();
  });
  it('parses clocks and time controls', () => {
    expect(parseClock('0:09:58.3')).toBeCloseTo(598.3);
    expect(parseTimeControl('600')).toEqual({ base: 600, inc: 0 });
    expect(parseTimeControl('180+2')).toEqual({ base: 180, inc: 2 });
    expect(parseTimeControl('1/86400')).toBeNull();
  });
});

describe('typed moves (keyboard play)', () => {
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  it('accepts SAN, lowercase SAN and UCI', () => {
    expect(parseTyped(start, 'Nf3')).toBe('g1f3');
    expect(parseTyped(start, 'nf3')).toBe('g1f3');
    expect(parseTyped(start, 'e2e4')).toBe('e2e4');
    expect(parseTyped(start, 'e4')).toBe('e2e4');
    expect(parseTyped(start, 'Ke2')).toBeNull();
  });
  it('distinguishes pawn b-file captures from bishop moves', () => {
    expect(parseTyped('4k3/8/8/8/8/2n5/1P6/4K3 w - - 0 1', 'bxc3')).toBe('b2c3');
  });
});
