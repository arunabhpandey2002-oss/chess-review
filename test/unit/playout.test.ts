import { describe, it, expect } from 'vitest';
import { strengthFor, summarizePlayout, ELO_MIN } from '../../src/playout';

describe('play-it-out engine strength', () => {
  it('uses UCI_Elo at and above 1320, clamped to 3190', () => {
    expect(strengthFor(1600).options).toEqual(['UCI_LimitStrength value true', 'UCI_Elo value 1600']);
    expect(strengthFor(ELO_MIN).options[1]).toBe('UCI_Elo value 1320');
    expect(strengthFor(3500).options[1]).toBe('UCI_Elo value 3190');
  });
  it('below 1320 uses skill 0 with a shallow search that deepens with rating', () => {
    const s = strengthFor(460);
    expect(s.options).toEqual(['Skill Level value 0']);
    expect(s.depth).toBe(1);
    expect(strengthFor(1300).depth).toBe(5);
    let prev = 0;
    for (let r = 400; r < 1320; r += 40) { const d = strengthFor(r).depth; expect(d).toBeGreaterThanOrEqual(prev); prev = d; }
    expect(s.label).toMatch(/weakest/);
  });
  it('defaults to 1200 when the rating is unknown', () => {
    expect(strengthFor(undefined).rating).toBe(1200);
    expect(strengthFor(0).rating).toBe(1200);
  });
});

describe('play-it-out summary', () => {
  const mv = (san: string, before: number, after: number) => ({ label: '16.', san, bestSan: 'Qe3', wpBefore: before, wpAfter: after });
  it('says the advantage was kept and finds no slip', () => {
    const s = summarizePlayout({ outcome: 'stopped', startWp: 72, finalWp: 80, mine: [mv('Nf3', 72, 70), mv('Bd3', 70, 69)] });
    expect(s.result).toMatch(/stopped.*2 moves/);
    expect(s.takeaways[0].text).toBe('You kept your advantage: your win chance went from 72% to 80%.');
    expect(s.takeaways[1].text).toMatch(/No move of yours lost more than 2%/);
    expect(s.biggest).toBeNull();
  });
  it('names the biggest slip and the better move', () => {
    const s = summarizePlayout({ outcome: 'mate-loss', startWp: 70, finalWp: null, mine: [mv('Nf3', 70, 66), mv('Kh1', 66, 20)] });
    expect(s.takeaways[0].text).toMatch(/slipped: .*70% to 0%/);
    expect(s.takeaways[1].text).toBe('Biggest slip: 16. Kh1 cost 46% win chance. Qe3 was better.');
  });
  it('treats draws as 50% and handles no moves', () => {
    expect(summarizePlayout({ outcome: 'repetition', startWp: 30, finalWp: null, mine: [] }).takeaways).toEqual([{ text: 'You started worse (30%) and fought back to 50%.', src: 'engine' }]);
  });
});
