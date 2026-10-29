import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseGame, reviewGame, decidedState, decidedWording, type Book } from '../../src/review';
import { buildExplore, moveFacts, threatText, stepLine, whatIf, gapVerdict } from '../../src/explore';
import { renderText } from '../../src/words';

const book: Book = JSON.parse(readFileSync('public/book.json', 'utf8'));
const { plies } = parseGame(readFileSync('test/g_186132691608.pgn', 'utf8'));
const browser = JSON.parse(readFileSync('test/g_186132691608.pgn.browser.evals.json', 'utf8'));
const native = JSON.parse(readFileSync('test/g_186132691608.pgn.native18.evals.json', 'utf8'));
const san = (t: string) => renderText(t, 'san');
const C3 = 30; // 16.c3
const FEN = plies[C3].fenBefore;

describe('explore 16.c3 vs Rf1 (walls79 game)', () => {
  const x = buildExplore(FEN, plies[C3].uci, browser[C3], browser[C3 + 1])!;
  it('uses the browser engine: Rf1 best, c3 played', () => {
    expect(plies[C3].san).toBe('c3');
    expect(x.best.san).toBe('Rf1');
    expect(x.played.san).toBe('c3');
  });
  it('names the threat: the undefended f2 pawn hit by the queen on g2', () => {
    expect(san(threatText(FEN, 'w').text)).toBe('Before the move, your pawn on f2 was attacked by their queen on g2 and had no defender.');
  });
  it('Rf1 defends f2; c3 attacks b4 but leaves f2 hanging', () => {
    expect(x.best.facts).toContain('it defends your pawn on f2, which their queen on g2 attacks');
    expect(x.played.facts).toContain('it attacks their bishop on b4 (undefended)');
    expect(x.played.left.still).toContain('your pawn on f2 is attacked by their queen on g2 and has no defender');
    expect(x.best.left.still).toEqual([]);
  });
  it('compare says why, and that the reply is the same', () => {
    const t = x.compare.map((f) => san(f.text));
    expect(t[0]).toBe('After c3, your pawn on f2 is attacked by their queen on g2 and has no defender. Rf1 defends it.');
    expect(t.some((s) => /Their best reply is Bd6 in both cases \(it attacks your knight on e5\)/.test(s))).toBe(true);
    expect(t.some((s) => /c3 does do something: it attacks their bishop on b4 \(undefended\), but Bd6 simply moves their bishop on b4 out of danger/.test(s))).toBe(true);
  });
  it('is honest about a modest gap and close alternatives', () => {
    const v = san(x.verdict.text);
    expect(v).toMatch(/^The difference is modest: Rf1 keeps the win chance at \d+%, c3 at \d+% \(\d points\)\. White is losing either way/);
    expect(v).toMatch(/f4 and Nc3 are rated almost the same as Rf1, so it is not the only good move/);
  });
  it('steps through the played line in plain English', () => {
    const s = stepLine(FEN, x.played.line, 'w', 3).map((st) => st.text);
    expect(s[0]).toBe('White pushes the c-pawn to c3: it attacks their bishop on b4 (undefended).');
    expect(s[1]).toBe('Black brings the bishop to d6: it moves their bishop on b4 out of danger; it attacks your knight on e5.');
  });
  it('what-if uses the engine eval and reply', () => {
    const ev = { depth: 16, lines: [{ score: { cp: -420, mate: null }, pv: ['b4d6', 'f2f4'], depth: 16 }] };
    const w = whatIf(FEN, 'a2a3', ev as any, x.best.wp)!;
    expect(w.facts.map((f) => san(f.text))).toEqual([
      'a3: it attacks their bishop on b4 (undefended).',
      expect.stringMatching(/^Engine: −4\.2, win chance \d+% \(/),
      'Their best reply is Bd6: it moves their bishop on b4 out of danger; it attacks your knight on e5.',
      'After a3, your pawn on f2 is attacked by their queen on g2 and has no defender.',
    ]);
  });
  it('native Stockfish (f4 on top) still gives grounded, honest output', () => {
    const n = buildExplore(FEN, plies[C3].uci, native[C3], native[C3 + 1])!;
    expect(n.best.san).toBe('f4');
    expect(n.best.facts).toContain('it moves your pawn on f2 out of danger');
    expect(san(n.verdict.text)).toMatch(/^The difference is (tiny|modest)/);
  });
  it('says plainly when no single board fact separates the moves (Nc3 on top)', () => {
    const before = { depth: 18, lines: [{ score: { cp: -390, mate: null }, pv: ['a4c3', 'b4d6', 'f2f4'], depth: 18 }, ...browser[C3].lines] };
    const n = buildExplore(FEN, plies[C3].uci, before as any, browser[C3 + 1])!;
    expect(san(n.compare[0].text)).toBe('No single threat, defence or capture separates Nc3 from c3 right now; the engine prefers Nc3 after looking further ahead, so compare the two lines step by step.');
  });
  it('moveFacts: open file and check', () => {
    expect(moveFacts('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1a8', 'w')).toContain('it gives check');
    expect(moveFacts('4k3/8/8/8/8/8/5P2/R3K3 w - - 0 1', 'a1d1', 'w')).toContain('it puts the rook on the open d-file');
  });
  it('gap verdict: tiny when both sides are decided', () => {
    const side = (wp: number) => ({ tok: 'x', wp, score: { cp: -900, mate: null } }) as any;
    expect(gapVerdict(side(3), side(2), 'w').text).toMatch(/^The difference is tiny/);
  });
});

describe('decided-position wording', () => {
  const reviews = reviewGame({ plies, evals: browser, book });
  const rv = reviews[40]!; // 21.dxe6
  it('21.dxe6 is excellent in a lost position', () => {
    expect(plies[40].san).toBe('dxe6');
    expect(['excellent', 'best']).toContain(rv.cls);
    expect(rv.decided).toBe('lost');
    const w = decidedWording(rv, true, 'w')!;
    expect(w.suffix).toBe(' in a lost position');
    expect(w.note).toMatch(/^Grades compare your move with the best move here, not who's winning\. You were already lost; this kept things about as good as possible \(\d+% → \d+%\)\.$/);
  });
  it('opponent wording, won side, and undecided', () => {
    expect(decidedWording({ cls: 'inaccuracy', wpBefore: 96, wpAfter: 93, decided: 'won' }, false, 'b')!.note)
      .toBe("Grades compare the move with the best move here, not who's winning. Black was already winning; this gave back some of the advantage the best move would have kept (96% → 93%).");
    expect(decidedState('excellent', 40, 38)).toBeNull();
    expect(decidedState('book', 2, 2)).toBeNull();
    expect(decidedState('good', 5, 4)).toBe('lost');
  });
});
