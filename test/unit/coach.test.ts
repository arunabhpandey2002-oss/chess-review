import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseGame, reviewGame, type Book } from '../../src/review';
import { buildMoments, buildSummary, playerErrors } from '../../src/coach';
import { explainMoment, buildHints } from '../../src/explain';
import { renderText } from '../../src/words';

const book: Book = JSON.parse(readFileSync('public/book.json', 'utf8'));
function load(pgnPath: string, evPath: string) {
  const { plies, headers } = parseGame(readFileSync(pgnPath, 'utf8'));
  const evals = JSON.parse(readFileSync(evPath, 'utf8'));
  const reviews = reviewGame({ plies, evals, book });
  return { plies, headers, evals, reviews };
}

describe('coach on Oggiggity vs Arunabh-pandey (186131916376)', () => {
  const g = load('test/game.pgn', 'test/game.pgn.native20.evals.json');
  const moments = buildMoments(g.plies, g.evals, g.reviews, 'b', 'beginner');
  const s = buildSummary({ plies: g.plies, evals: g.evals, reviews: g.reviews, me: 'b', moments, opening: 'Philidor Defense', opponent: 'Oggiggity', resultText: 'You won by resignation', timeControl: '600' });
  it('finds at most three teachable moments, none in decided positions', () => {
    expect(moments.length).toBeGreaterThan(0);
    expect(moments.length).toBeLessThanOrEqual(3);
    for (const m of moments) { expect(m.color).toBe('b'); expect(m.wpBest).toBeLessThan(97); }
  });
  it('the strongest decision is the 13...Nc2+ fork', () => {
    expect(renderText(s.strongest!, 'san')).toMatch(/13\.\.\.Nc2\+.*fork/);
  });
  it('the story names the turning point 13.c3', () => {
    expect(renderText(s.story.join(' '), 'san')).toMatch(/move 13: your opponent played c3/);
  });
  it('has time notes from the clock', () => {
    expect(s.time.join(' ')).toMatch(/seconds per move/);
  });
  it('every lesson is grounded and hints come in four stages', () => {
    for (const m of moments) {
      const l = explainMoment(m, 'beginner');
      expect(l.grounded).toBe(true);
      expect(buildHints(m).map((h) => h.stage)).toEqual([1, 2, 3, 4]);
      expect(buildHints(m)[3].candidates).toContain(m.bestUci);
    }
  });
});

describe('coach on a game with several errors (186092857180)', () => {
  const g = load('test/g_186092857180.pgn', 'test/g_186092857180.pgn.native18.evals.json');
  it('selects three moments including the 15.exd5 ignored threat', () => {
    const ms = buildMoments(g.plies, g.evals, g.reviews, 'w', 'beginner');
    expect(ms.length).toBe(3);
    const ex = ms.find((m) => m.playedSan === 'exd5')!;
    expect(ex.tags.primary.id).toBe('allowed:ignored-threat');
    expect(renderText(explainMoment(ex, 'beginner').sections[0].text, 'san')).toMatch(/queen on d3 hanging/);
  });
  it('every player error is tagged with something', () => {
    for (const e of playerErrors(g.plies, g.evals, g.reviews, 'w')) expect(e.tags.primary.id).toMatch(/^(missed|allowed):/);
  });
});
