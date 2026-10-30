import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseGame, reviewGame, type Book } from '../../src/review';
import { buildMoments } from '../../src/coach';
import { diagnose, clockOf, CHOICES, errorFacts, actualCause, shortOnTime, topCauses } from '../../src/diagnose';
import { allowedSquares, groundCheck } from '../../src/explain';
import { renderText } from '../../src/words';

const book: Book = JSON.parse(readFileSync('public/book.json', 'utf8'));
const { plies, headers } = parseGame(readFileSync('test/g_186092857180.pgn', 'utf8'));
const evals = JSON.parse(readFileSync('test/g_186092857180.pgn.native18.evals.json', 'utf8'));
const reviews = reviewGame({ plies, evals, book });
const ms = buildMoments(plies, evals, reviews, 'w', 'beginner', headers.TimeControl ?? '600');
const by = (san: string) => ms.find((m) => m.playedSan === san)!;
const txt = (d: { lines: { text: string }[] }) => d.lines.map((l) => renderText(l.text, 'san')).join(' ');
const noClock = null;

describe('why-you-erred diagnosis (game 186092857180)', () => {
  it('15.exd5 ignored a threat: the knight on f4 already attacked the queen on d3', () => {
    const m = by('exd5');
    expect(actualCause(errorFacts(m))).toBe('missed-threat');
    const d = diagnose(m, 'no-see', noClock);
    expect(d.cause).toBe('missed-threat');
    expect(d.verdict).toBe('matches');
    expect(txt(d)).toMatch(/knight on f4 already attacked your queen on d3/);
    expect(txt(d)).toMatch(/wins 7 points/);
  });
  it('"I thought I was safe" on 15.exd5: the queen was defended but a cheaper knight could take it', () => {
    const d = diagnose(by('exd5'), 'thought-safe', noClock);
    expect(d.verdict).toBe('partly');
    expect(d.summary).toBe('Matches part: the piece was not as safe as it looked, but also there was a threat to deal with');
    expect(txt(d)).toMatch(/queen on d3 was defended by your .*but it can be taken by their knight on f4, which is worth less/);
  });
  it('10.Rg1 allowed nothing; the real issue was the missed Ne5', () => {
    const m = by('Rg1');
    const d = diagnose(m, 'no-see', noClock);
    expect(d.cause).toBe('missed-chance');
    expect(d.verdict).toBe('differs');
    expect(txt(d)).toMatch(/no threat to miss/);
    expect(txt(d)).toMatch(/Ne5 was stronger/);
    expect(diagnose(m, 'missed-better', noClock).verdict).toBe('matches');
    expect(txt(diagnose(m, 'attacking', noClock))).toMatch(/did not capture, give check or attack/);
  });
  it('time pressure is checked against the clock', () => {
    const m = by('exd5');
    expect(diagnose(m, 'time', { left: 12, spent: 9, base: 600 }).cause).toBe('time');
    const d = diagnose(m, 'time', { left: 400, spent: 25, base: 600 });
    expect(d.verdict).toBe('differs');
    expect(d.cause).toBe('missed-threat');
    expect(txt(d)).toMatch(/6:40 left .*not short/);
    expect(txt(diagnose(m, 'time', null))).toMatch(/No clock times/);
    expect(shortOnTime({ left: 300, spent: 2, base: 600 })).toBe(true);
    expect(shortOnTime({ left: 300, spent: 20, base: 600 })).toBe(false);
  });
  it('moments carry clock facts from the PGN', () => {
    const c = clockOf(by('Rb1'))!;
    expect(c.left).toBeCloseTo(10.8);
    expect(c.base).toBe(600);
    expect(c.spent).not.toBeNull();
    expect(diagnose(by('Rb1'), 'time', c).verdict).toBe('matches');
  });
  it('every answer gives 1-3 grounded sentences with a source', () => {
    for (const m of ms) for (const c of CHOICES) {
      const d = diagnose(m, c.id, clockOf(m));
      expect(d.lines.length).toBeGreaterThan(0);
      expect(d.lines.length).toBeLessThanOrEqual(3);
      for (const l of d.lines) {
        expect(['rules', 'engine']).toContain(l.src);
        expect(groundCheck(renderText(l.text, 'san'), allowedSquares(m))).toBe(true);
      }
    }
  });
  it('new answers: assumed recapture, stopped early, misjudged, moved fast, don\'t remember', () => {
    const m = by('exd5');
    expect(diagnose(m, 'assumed-recapture', noClock).verdict).toBe('matches');
    expect(diagnose(m, 'misjudged', noClock).verdict).toBe('matches');
    expect(diagnose(m, 'stopped-early', noClock).verdict).toBe('partly');
    expect(txt(diagnose(m, 'stopped-early', noClock))).toMatch(/comes right away/);
    expect(diagnose(m, 'too-fast', noClock).verdict).toBe('unchecked');
    expect(diagnose(m, 'too-fast', { left: 300, spent: 2, base: 600 }).verdict).toBe('matches');
    const dr = diagnose(m, 'dont-remember', noClock);
    expect(dr.verdict).toBe('unchecked');
    expect(dr.summary).toBe('Here is what the board shows');
    expect(CHOICES).toHaveLength(11);
    for (const c of CHOICES) if (!['dont-remember', 'other'].includes(c.id)) expect(c.category).not.toBe('');
  });
  it('no vague "Partly", and a diagnosis never contradicts the selected answer', () => {
    for (const m of ms) for (const c of CHOICES) {
      const d = diagnose(m, c.id, clockOf(m));
      expect(d.summary).not.toMatch(/^Partly/);
      if (d.verdict === 'partly') expect(d.summary).toMatch(/^Matches part: .+, but (also|the details)/);
      // "matches" must never be paired with text saying there was nothing of the kind
      if (d.verdict === 'matches') expect(txt(d)).not.toMatch(/There was no threat to miss|There was no recapture|not a rushed move|was not short/);
      if (d.verdict === 'differs' && c.id === 'no-see') expect(errorFacts(m).allowed).toBe(false);
    }
  });
  it('top causes count saved answers', () => {
    expect(topCauses([{ cause: 'missed-threat' }, { cause: 'time' }, { cause: 'missed-threat' }])).toEqual([
      { cause: 'missed-threat', label: 'Missed their threat', n: 2 }, { cause: 'time', label: 'Time pressure or a guess', n: 1 },
    ]);
  });
});
