import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { describeMove, lastMoveOf, lastMoveFromPgn, lastMoveText } from '../../src/lastmove';

const PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 5. O-O f6 *';
const hist = (() => { const c = new Chess(); c.loadPgn(PGN); return c.history({ verbose: true }); })();

describe('last move line', () => {
  it('labels a White move with "n." and a Black move with "n..."', () => {
    expect(describeMove(hist[6].before, 'b5c6')!.label).toBe('4. Bxc6');
    expect(describeMove(hist[7].before, 'd7c6')!.label).toBe('4... dxc6');
    const w = describeMove(hist[8].before, 'e1g1')!;
    expect(w.label).toBe('5. O-O');
    expect([w.from, w.to]).toEqual(['e1', 'g1']);
  });
  it('uses the saved prior move of a position (Black to play: White just moved)', () => {
    const l = lastMoveOf({ fenBefore: hist[7].before, prevFen: hist[6].before, prevUci: 'b5c6' });
    expect(l).not.toBe('start');
    expect(lastMoveText(l)).toBe('Last move: 4. Bxc6');
  });
  it('White to play: Black just moved, shown with "..."', () => {
    expect(lastMoveText(lastMoveOf({ fenBefore: hist[8].before, prevFen: hist[7].before, prevUci: 'd7c6' }))).toBe('Last move: 4... dxc6');
  });
  it('start of game, and unknown for old positions without the move', () => {
    expect(lastMoveText(lastMoveOf({ fenBefore: new Chess().fen() }))).toBe('Last move: none (start of game)');
    expect(lastMoveText(lastMoveOf({ fenBefore: hist[7].before }))).toBeNull();
    expect(lastMoveOf({ fenBefore: hist[7].before, prevFen: hist[6].before, prevUci: 'a1a8' })).toBeNull();
  });
  it('derives the move from the game PGN when the position does not carry it', () => {
    const l = lastMoveFromPgn(PGN, hist[9].before, 9);
    expect(lastMoveText(l)).toBe('Last move: 5. O-O');
    expect(lastMoveText(lastMoveFromPgn(PGN, hist[9].before))).toBe('Last move: 5. O-O'); // no ply: search
    expect(lastMoveFromPgn(PGN, hist[0].before, 0)).toBe('start');
    expect(lastMoveFromPgn(PGN, '8/8/8/8/8/8/8/K6k w - - 0 1')).toBeNull();
    expect(lastMoveFromPgn('not a pgn', hist[3].before)).toBeNull();
  });
});
