import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseGame, reviewGame, decidedState, decidedWording, type Book } from '../../src/review';
import { buildExplore, moveFacts, threatText, stepLine, whatIf, gapVerdict, captureToTest, captureNote, pinnedBy } from '../../src/explore';
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
    expect(v).toMatch(/^The difference is modest\. Rf1 keeps the win chance at (\d+)% \([−+]\d+\.\d\); c3 gives (\d+)% \([−+]\d+\.\d\), (\d+) points less\. White is losing either way\./);
    const [, a, b, d] = /at (\d+)%.*gives (\d+)%.*?, (\d+) points less/.exec(v)!;
    expect(+a - +b).toBe(+d); // the gap matches the rounded numbers shown
    expect(v).toMatch(/f4 and Nc3 are almost as good, so Rf1 is not the only good move\.$/);
    expect(v).not.toMatch(/\. \(|\)\s*\(/); // no orphan parentheses
  });
  it('glosses each move once, then uses the short name', () => {
    const seen = new Set<string>();
    const out = renderText(x.verdict.text, 'words', seen) + ' ' + x.compare.map((f) => renderText(f.text, 'words', seen)).join(' ');
    expect(out.match(/Rf1 \(/g)?.length).toBe(1);
    expect(out.match(/(?<![A-Za-z])c3 \(/g)?.length).toBe(1);
    expect(out).toMatch(/Rf1 \(bringing the rook to f1\)/);
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
    expect(san(n.compare[0].text)).toBe("No immediate threat or capture separates Nc3 from c3; the engine's edge shows further into its line.");
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

describe('what if they take: 14.Nxg5 (before 14.a3)', () => {
  const F = '3k3r/2p2p2/rpnb1n1p/p3p1p1/4P3/2N1BN2/PPP2PPP/R2R2K1 w - - 0 14';
  const sc = (cp: number) => ({ cp, mate: null });
  // native Stockfish depth 24: Nxg5 best (+5.06, reply Ke8); after Nxg5 hxg5 the answer is Bxg5 (+4.37)
  const before = { depth: 24, lines: [{ score: sc(506), pv: ['f3g5', 'd8e8'], depth: 24 }, { score: sc(120), pv: ['a2a3', 'd8e7'], depth: 24 }] } as any;
  const x = buildExplore(F, 'a2a3', before, null)!;
  const takeEv = { depth: 24, lines: [{ score: sc(437), pv: ['e3g5', 'd8e7', 'c3d5', 'e7e6', 'd5f6'], depth: 24 }] } as any;
  it('flags the knight on g5 as left under attack and picks the pawn capture hxg5', () => {
    expect(x.best.san).toBe('Nxg5');
    expect(x.best.left.created.join(' ')).toMatch(/knight on g5 is attacked by their pawn on h6/);
    const cap = captureToTest(F, x.best)!;
    expect(cap.uci).toBe('h6g5');
    expect(san(cap.label)).toBe('14…hxg5');
  });
  it('says Bxg5 pins the f6 knight to the king and Nd5+ then Nxf6 wins it back, with the engine number', () => {
    const cap = captureToTest(F, x.best)!;
    const n = captureNote(F, x.best, cap, takeEv)!;
    expect(n.fine).toBe(false);
    expect(san(n.facts[0].text)).toBe('If they take with 14…hxg5, 15.Bxg5 pins their knight on f6 to the king, and 16.Nd5+ then 17.Nxf6 wins it back.');
    expect(san(n.facts[1].text)).toMatch(/^Engine after 15\.Bxg5: \+4\.4 for White, \d+% win chance \(\d+% after their best reply\)\.$/);
    expect(n.line.slice(0, 4)).toEqual(['f3g5', 'h6g5', 'e3g5', 'd8e7']);
    const steps = stepLine(F, n.line, 'w', 7);
    expect(steps.map((s) => s.san)).toEqual(['Nxg5', 'hxg5', 'Bxg5', 'Ke7', 'Nd5+', 'Ke6', 'Nxf6']);
  });
  it('only claims a pin the board shows', () => {
    expect(pinnedBy('3k3r/2p2p2/rpnb1n2/p3p1B1/4P3/2N5/PPP2PPP/R2R2K1 b - - 0 15', 'g5')).toBe('f6');
    expect(pinnedBy('4k2r/2p2p2/rpnb1n2/p3p1B1/4P3/2N5/PPP2PPP/R2R2K1 b - - 0 15', 'g5')).toBeNull();
  });
  it('is honest when taking is fine for them, and falls back to the concrete line without a pin', () => {
    const cap = captureToTest(F, x.best)!;
    const ok = captureNote(F, x.best, cap, { depth: 24, lines: [{ score: sc(10), pv: ['e3g5', 'd8e7'], depth: 24 }] } as any)!;
    expect(ok.fine).toBe(true);
    expect(san(ok.facts[0].text)).toBe('If they take with 14…hxg5, that is a reasonable option for them: the engine answers 15.Bxg5.');
    const noPin = captureNote(F, x.best, cap, { depth: 24, lines: [{ score: sc(400), pv: ['c3d5', 'f6d5'], depth: 24 }] } as any)!;
    expect(san(noPin.facts[0].text)).toMatch(/^If they take with 14…hxg5, the engine answers 15\.Nd5/);
    expect(noPin.facts[0].text).not.toMatch(/pins/);
  });
});
