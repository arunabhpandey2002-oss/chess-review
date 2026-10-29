import { describe, it, expect } from 'vitest';
import { hangingPieces, forkAfter, pinsAgainst, skewersAgainst, newLineUps, discoveredAfter, mateInOne, isBackRankMate, threatsAgainst, nullMove, settledMaterial, moveAppeal } from '../../src/facts';
import { tagMove } from '../../src/concepts';
import { parseGame } from '../../src/review';
import { readFileSync } from 'node:fs';

describe('hanging pieces', () => {
  it('finds an undefended attacked knight', () => {
    const h = hangingPieces('4k3/8/8/3n4/8/8/8/3QK3 w - - 0 1', 'b', 1);
    expect(h.map((x) => x.sq)).toEqual(['d5']);
  });
  it('a knight defended by a pawn against a queen is not hanging', () => {
    expect(hangingPieces('4k3/8/4p3/3n4/8/8/8/3QK3 w - - 0 1', 'b', 1)).toEqual([]);
  });
  it('a rook attacked by a pawn is hanging even if defended', () => {
    const h = hangingPieces('4k3/8/8/3r4/4P3/8/8/4K3 w - - 0 1', 'b', 1);
    expect(h.map((x) => x.sq)).toContain('d5');
  });
});

describe('forks', () => {
  it('knight fork of king and rook', () => {
    const f = forkAfter('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7');
    expect(f).not.toBeNull();
    expect(f!.by.sq).toBe('c7');
    expect(f!.targets.map((t) => t.sq).sort()).toEqual(['a8', 'e8']);
  });
  it('pawn fork of two knights', () => {
    const f = forkAfter('4k3/8/2n1n3/8/3P4/8/8/4K3 w - - 0 1', 'd4d5');
    expect(f?.targets.map((t) => t.sq).sort()).toEqual(['c6', 'e6']);
  });
  it('a quiet knight move attacking nothing is not a fork', () => {
    expect(forkAfter('4k3/8/8/8/8/8/8/4K1N1 w - - 0 1', 'g1f3')).toBeNull();
  });
});

describe('pins and skewers', () => {
  it('bishop pins knight to king', () => {
    const p = pinsAgainst('4k3/8/2n5/8/B7/8/8/4K3 w - - 0 1', 'b');
    expect(p.length).toBe(1);
    expect(p[0]).toMatchObject({ absolute: true, front: { sq: 'c6' }, behind: { sq: 'e8' }, attacker: { sq: 'a4' } });
  });
  it('a move that creates a pin is detected as new', () => {
    const p = newLineUps('4k3/8/2n5/8/8/8/8/3BK3 w - - 0 1', 'd1a4', 'pin');
    expect(p[0]?.front.sq).toBe('c6');
  });
  it('rook skewers king to queen', () => {
    const s = skewersAgainst('8/8/8/4q3/8/4k3/8/K3R3 b - - 0 1', 'b');
    expect(s.length).toBe(1);
    expect(s[0]).toMatchObject({ front: { sq: 'e3', type: 'k' }, behind: { sq: 'e5', type: 'q' } });
  });
  it('no pin when a lower-value piece is behind', () => {
    expect(pinsAgainst('4k3/8/2p5/8/4b3/8/8/1B2K3 w - - 0 1', 'b').filter((x) => x.front.sq === 'c6')).toEqual([]);
  });
});

describe('discovered attacks', () => {
  it('knight moves off the e-file and the rook gives check', () => {
    const d = discoveredAfter('4k3/8/8/8/8/8/4N3/4R1K1 w - - 0 1', 'e2c3');
    expect(d.length).toBe(1);
    expect(d[0]).toMatchObject({ slider: { sq: 'e1' }, target: { sq: 'e8' }, check: true });
  });
});

describe('mates and threats', () => {
  const backRank = '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1';
  it('finds the back-rank mate in one', () => {
    expect(mateInOne(backRank)).toEqual(['a1a8']);
    expect(isBackRankMate(backRank, ['a1a8'])).toBe(true);
  });
  it('threatsAgainst sees the mate threat for the defender', () => {
    const t = threatsAgainst('6k1/5ppp/8/8/8/8/5PPP/R5K1 b - - 0 1');
    expect(t.mates).toContain('a1a8');
  });
  it('threatsAgainst sees a hanging piece', () => {
    const t = threatsAgainst('4k3/8/8/3n4/8/8/8/3QK3 b - - 0 1');
    expect(t.captures.map((c) => c.sq)).toContain('d5');
  });
  it('null move is unavailable in check', () => {
    expect(nullMove('4k3/8/8/8/8/8/8/R3K2r w - - 0 1')).toBeNull();
  });
});

describe('material along a line', () => {
  it('settles after recaptures', () => {
    // white wins a knight: Qxd5 and black has nothing back
    expect(settledMaterial('4k3/8/8/3n4/8/8/8/3QK3 w - - 0 1', ['d1d5', 'e8e7'], 'w').net).toBe(3);
  });
  it('captures make a move look natural', () => {
    expect(moveAppeal('4k3/8/8/3n4/8/8/8/3QK3 w - - 0 1', 'd1d5', 40).join(' ')).toMatch(/captures a knight/);
  });
});

describe('tagging a real game move', () => {
  it('13...Nc2+ from Oggiggity vs Arunabh-pandey is tagged as a fork when missed', () => {
    const { plies } = parseGame(readFileSync('test/game.pgn', 'utf8'));
    const p = plies[25]; // 13...Nc2+
    expect(p.san).toBe('Nc2+');
    // pretend the player had played something else: tag the best line as the solution
    const fake = { ...p, uci: 'a7a6', san: 'a6' };
    const r = tagMove({ ply: fake as typeof p, best: { score: { cp: -900, mate: null }, pv: ['d4c2', 'e1d1', 'c2e3', 'f2e3'], depth: 18 }, reply: undefined, mover: 'b' });
    expect(r.solution.map((t) => t.motif)).toContain('fork');
  });
});
