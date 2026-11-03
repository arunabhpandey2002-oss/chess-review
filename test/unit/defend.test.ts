import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { classifyLoss, clampCp, lineMoves, lineReplies, pickAppMove, bookCandidates, reviewRow, summarize, roundResult, reachedVariation, fmtEval, LOSS, ROUND_PLIES, randomWeight, pickRandomOpening, sideMoves, leftLine, randomResult, RANDOM_BOOST, markLineBook, type MoveCheck } from '../../src/defend';
import { OPENINGS } from '../../src/repertoire';
import { newSrs, schedule } from '../../src/srs';
import { FAMILIES, familyById, openingById, variationsOf } from '../../src/repertoire';
import { validateOpenings, explore } from '../../src/openings';

const START = new Chess().fen();
const data = validateOpenings(JSON.parse(readFileSync('public/openings.json', 'utf8')))!;
const fenAfter = (sans: string[]) => { const c = new Chess(); sans.forEach((s) => c.move(s)); return c.fen(); };
const key = (fen: string) => fen.split(' ').slice(0, 3).join(' ');

describe('verdict classification', () => {
  it('uses the centipawn thresholds', () => {
    expect(classifyLoss(0)).toBe('good');
    expect(classifyLoss(LOSS.good)).toBe('good');
    expect(classifyLoss(LOSS.good + 1)).toBe('inaccuracy');
    expect(classifyLoss(LOSS.inaccuracy)).toBe('inaccuracy');
    expect(classifyLoss(LOSS.inaccuracy + 1)).toBe('mistake');
    expect(classifyLoss(LOSS.mistake)).toBe('mistake');
    expect(classifyLoss(LOSS.mistake + 1)).toBe('blunder');
    expect(classifyLoss(-30)).toBe('good');
  });
  it('a common move is Book only while it is sound', () => {
    expect(classifyLoss(20, true)).toBe('book');
    expect(classifyLoss(LOSS.good + 10, true)).toBe('inaccuracy');
  });
  it('clamps mates and decided positions', () => {
    expect(clampCp(99900)).toBe(1000);
    expect(clampCp(-99900)).toBe(-1000);
    expect(fmtEval(37)).toBe('+0.4');
    expect(fmtEval(-60)).toBe('−0.6');
    expect(fmtEval(99800)).toMatch(/mate/);
  });
  it('builds rows: book, good, mistake, blunder with plain reasons', () => {
    const fen = fenAfter(['d4']);
    const base = { ply: 1, fen, bestUci: 'g8f6', bestCp: -20 };
    const book = [{ uci: 'g8f6', share: 0.5, line: true, cp: -20 }, { uci: 'd7d5', share: 0.3, line: false, cp: -35 }];
    const r1 = reviewRow({ ...base, uci: 'd7d5', san: 'd5', playedCp: -35, book } as MoveCheck);
    expect(r1.verdict).toBe('book');
    expect(r1.same).toBe(true);
    expect(r1.reason).toMatch(/^Book move \(30% of games\)\. The line here is Nf6\./);
    const r2 = reviewRow({ ...base, uci: 'e7e6', san: 'e6', playedCp: -55, book } as MoveCheck);
    expect(r2.verdict).toBe('good');
    expect(r2.recSan).toBe('Nf6');
    const r3 = reviewRow({ ...base, uci: 'g7g5', san: 'g5', playedCp: -190, book } as MoveCheck);
    expect(r3.verdict).toBe('mistake');
    expect(r3.reason).toBe('Engine prefers Nf6, which keeps −0.2; yours drops to −1.9.');
    expect(r3.recKind).toBe('book');
    const r4 = reviewRow({ ...base, uci: 'f7f6', san: 'f6', playedCp: -400, book: [] } as MoveCheck);
    expect(r4.verdict).toBe('blunder');
    expect(r4.recKind).toBe('engine');
    expect(r4.accuracy).toBeLessThan(r3.accuracy);
  });
  it('a popular but unsound move is not Book, and the sound book move is recommended', () => {
    const fen = fenAfter(['e4', 'e5', 'Qh5']);
    const r = reviewRow({ ply: 3, fen, uci: 'g7g6', san: 'g6', bestUci: 'b8c6', bestCp: 60, playedCp: -300, book: [{ uci: 'b8c6', share: 0.6, line: true, cp: 60 }, { uci: 'g7g6', share: 0.1, line: false, cp: -300 }] } as MoveCheck);
    expect(r.verdict).toBe('blunder');
    expect(r.recSan).toBe('Nc6');
    expect(r.reason).toMatch(/Stockfish doesn't trust it/);
  });
  it('summary: accuracy, counts, where you left book; SRS result', () => {
    const fen = fenAfter(['d4']);
    const mk = (uci: string, playedCp: number, bk = false) => reviewRow({ ply: 1, fen, uci, san: uci, bestUci: 'g8f6', bestCp: 0, playedCp, book: bk ? [{ uci, share: 0.4, line: false, cp: playedCp }] : [] } as MoveCheck);
    const rows = [mk('g8f6', 0, true), mk('e7e6', -20), mk('g7g5', -150), mk('f7f6', -500)];
    const s = summarize(rows);
    expect([s.book, s.good, s.inaccuracies, s.mistakes, s.blunders]).toEqual([1, 1, 0, 1, 1]);
    expect(s.leftBook).toBe(rows[1]);
    expect(s.worst).toBe(rows[3]);
    expect(s.accuracy).toBeGreaterThan(0);
    expect(s.accuracy).toBeLessThan(100);
    expect(roundResult(s, 0)).toEqual({ solved: false, attempts: 3, hints: 0, revealed: false });
    expect(roundResult(summarize([rows[0], rows[1]]), 1)).toEqual({ solved: true, attempts: 1, hints: 1, revealed: false });
  });
  it('equal evals say "about as good"; decided positions say so', () => {
    const fen = fenAfter(['d4']);
    const r = reviewRow({ ply: 1, fen, uci: 'e7e6', san: 'e6', bestUci: 'd7d5', bestCp: -30, playedCp: -34, book: [] } as MoveCheck);
    expect(r.reason).toBe("Fine — about as good as the engine's d5 (−0.3).");
    const d = reviewRow({ ply: 1, fen, uci: 'e7e6', san: 'e6', bestUci: 'd7d5', bestCp: -1600, playedCp: -2100, book: [] } as MoveCheck);
    expect(d.verdict).toBe('good');
    expect(d.reason).toMatch(/already decided/);
  });
  it('a round is 12 full moves', () => expect(ROUND_PLIES).toBe(24));
});

describe('defend-mode move selection', () => {
  const indian = familyById('f-indian')!;
  const knights = openingById('indian-knights') ?? variationsOf(indian)[0];
  it('the app plays the opening side\'s line move, for every variation of the family', () => {
    const line = lineMoves(knights, indian);
    for (const v of variationsOf(indian)) for (const p of v.plies) if (p.mine) {
      expect(pickAppMove(p.fen, line, explore(p.fen, data), () => 0.99)).toEqual({ uci: p.uci, src: 'line' });
    }
  });
  it('every family can be defended: the app has a move at its first turn', () => {
    for (const f of FAMILIES) {
      const e = variationsOf(f)[0];
      const line = lineMoves(e, f);
      const first = e.plies.find((p) => p.mine)!;
      expect(pickAppMove(first.fen, line, null)?.uci, f.id).toBe(first.uci);
    }
  });
  it('off the line it plays common sample moves weighted by popularity', () => {
    const fen = fenAfter(['d4', 'a5']); // not in the Indian lines
    const line = lineMoves(knights, indian);
    expect(line.has(key(fen))).toBe(false);
    const view = explore(fen, data);
    const picks = new Map<string, number>();
    for (let i = 0; i < 200; i++) { const p = pickAppMove(fen, line, view, () => i / 200); if (p) picks.set(p.uci, (picks.get(p.uci) ?? 0) + 1); }
    if (view) {
      const common = view.moves.filter((m) => m.games >= 10 && m.share >= 0.08);
      expect([...picks.keys()].every((u) => common.some((m) => m.uci === u))).toBe(true);
      const top = common[0];
      expect(picks.get(top.uci)).toBe(Math.max(...picks.values()));
    }
  });
  it('with no line and no sample data it asks the engine (null)', () => {
    const fen = '8/5k2/8/3K4/8/8/5P2/8 w - - 0 1';
    expect(pickAppMove(fen, new Map(), null)).toBeNull();
    expect(pickAppMove(fen, new Map(), { total: 5, moves: [{ uci: 'f2f4', san: 'f4', games: 2, share: 0.4, white: 1, draws: 0, black: 0 }] })).toBeNull();
  });
  it('book candidates: the line reply first, then common sample moves; illegal ones dropped', () => {
    const fen = fenAfter(['d4']);
    const replies = lineReplies(knights, indian);
    const c = bookCandidates(fen, replies.get(key(fen)), explore(fen, data));
    expect(c[0]).toMatchObject({ uci: 'g8f6', line: true });
    expect(c.some((x) => x.uci === 'd7d5')).toBe(true);
    expect(new Set(c.map((x) => x.uci)).size).toBe(c.length);
    expect(bookCandidates(START, 'e2e5', null)).toEqual([]);
  });
  it('variation reached is the deepest one whose identifying moves you played', () => {
    const v = variationsOf(indian);
    const deep = [...v].sort((a, b) => b.idPlies - a.idPlies)[0];
    expect(reachedVariation(deep.plies.map((p) => p.san), v)?.id).toBe(deep.id);
    expect(reachedVariation(['e4', 'e5'], v)).toBeNull();
  });
});

describe('random opening', () => {
  const pool = OPENINGS.filter((o) => o.side === 'b');
  const now = Date.UTC(2026, 10, 3);
  it('pool is the White openings (you play Black)', () => {
    expect(pool.length).toBeGreaterThan(30);
    expect(pool.every((e) => e.plies[0] && !e.plies[0].mine)).toBe(true);
  });
  it('weights by popularity, boosts openings you got wrong or have not seen, damps ones you know', () => {
    const e = openingById('italian')!;
    const failed = schedule(newSrs(now), { solved: false, attempts: 3, hints: 0, revealed: false }, now);
    let good = newSrs(now);
    for (let i = 0; i < 2; i++) good = schedule(good, { solved: true, attempts: 1, hints: 0, revealed: false }, now);
    const wNew = randomWeight(e, undefined, now);
    const wFail = randomWeight(e, failed, now + 86400000 * 3);
    const wGood = randomWeight(e, good, now);
    expect(wNew).toBeCloseTo(Math.sqrt(e.count!) * RANDOM_BOOST.new);
    expect(wFail).toBeGreaterThan(wNew);
    expect(wGood).toBeLessThan(wNew);
    expect(randomWeight(openingById('english')!, undefined, now)).toBeGreaterThan(randomWeight(openingById('ruy-lopez-morphy-defense-tarrasch-variation')!, undefined, now));
  });
  it('picks follow the weights; a missed opening comes up more often; never repeats the last one', () => {
    let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const count = (srsOf: (id: string) => ReturnType<typeof newSrs> | undefined) => {
      const n = new Map<string, number>();
      for (let i = 0; i < 4000; i++) { const p = pickRandomOpening(pool, srsOf, now, rand)!; n.set(p.id, (n.get(p.id) ?? 0) + 1); }
      return n;
    };
    const base = count(() => undefined);
    expect(base.get('english')!).toBeGreaterThan(base.get('ruy-lopez-morphy-defense-tarrasch-variation') ?? 0);
    const failed = schedule(newSrs(now - 86400000 * 5), { solved: false, attempts: 3, hints: 0, revealed: false }, now - 86400000 * 5);
    const boosted = count((id) => (id === 'evans' ? failed : undefined));
    expect(boosted.get('evans')! / 4000).toBeGreaterThan((base.get('evans') ?? 0) / 4000 * 1.8);
    for (let i = 0; i < 200; i++) expect(pickRandomOpening(pool, () => undefined, now, rand, 'english')!.id).not.toBe('english');
  });
  it('White plays exactly the chosen variation; book line and where you left it', () => {
    const e = openingById('italian')!;
    const w = sideMoves(e, false);
    expect(pickAppMove(START, w, null)!.uci).toBe(e.plies[0].uci);
    expect([...w.values()].every((m) => e.plies.some((p) => !p.mine && p.uci === m.uci))).toBe(true);
    const sans = e.plies.map((p) => p.san);
    expect(leftLine(sans.slice(0, 8), e, 'b')).toBeNull();
    const off = [...sans.slice(0, 3), 'Nf6', 'd3'];
    expect(leftLine(off, e, 'b')).toMatchObject({ ply: 3, byYou: true, played: 'Nf6', book: e.plies[3].san });
    const s = summarize([]);
    expect(randomResult(s, 0, null).solved).toBe(true);
    expect(randomResult(s, 0, leftLine(off, e, 'b'))).toMatchObject({ solved: false, attempts: 2 });
  });
});

describe('markLineBook', () => {
  it('moves on the reached variation count as book when Stockfish is fine with them; not after you leave it', () => {
    const e = openingById('italian')!;
    const sans = [...e.plies.slice(0, 5).map((p) => p.san), 'h6'];
    const fens = [START]; { const c = new Chess(); for (const s of sans) { c.move(s); fens.push(c.fen()); } }
    const mk = (ply: number, loss: number): MoveCheck => { const c = new Chess(fens[ply]); const m = c.move(sans[ply]); return { ply, fen: fens[ply], uci: m.from + m.to, san: m.san, bestUci: m.from + m.to === 'a2a3' ? 'b2b3' : 'a7a6', bestCp: 0, playedCp: -loss, book: [] }; };
    const rows = [1, 3, 5].map((p) => reviewRow(mk(p, 20)));
    expect(rows.every((r) => r.verdict === 'good')).toBe(true);
    const out = markLineBook(rows, sans, e);
    expect(out.map((r) => r.verdict)).toEqual(['book', 'book', 'good']);
    expect(out[0].reason).toContain('Italian Game line');
    expect(markLineBook([reviewRow(mk(3, 150))], sans, e)[0].verdict).toBe('mistake');
  });
});
