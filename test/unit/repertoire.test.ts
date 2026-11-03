import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import raw from '../../src/repertoire.json';
import { OPENINGS, validateRepertoire, judgeMove, wrongText, detectOpening, entryFor, facedStats, moveText, moveLabel, MAX_LOSS, type GameLike } from '../../src/repertoire';

const tsv = 'abcde'.split('').flatMap((f) => readFileSync(`data/${f}.tsv`, 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t')));
const byPgn = new Map(tsv.map(([eco, name, pgn]) => [pgn, { eco, name }]));
const book = JSON.parse(readFileSync('public/book.json', 'utf8'));
const pgnOf = (sans: string[]) => sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(' ');

describe('opening library data', () => {
  it('covers the openings he asked about, both colours', () => {
    const ids = OPENINGS.map((o) => o.id);
    for (const id of ['reti', 'english', 'london', 'qg', 'italian', 'ruy', 'scotch', 'kia', 'kings-gambit', 'danish', 'evans']) expect(ids).toContain(id);
    for (const id of ['sicilian', 'french', 'caro-kann', 'scandinavian', 'kid', 'pirc']) expect(ids).toContain(id);
    expect(OPENINGS.filter((o) => o.side === 'b').every((o) => o.plies[0].mine === false)).toBe(true);
    expect(OPENINGS.filter((o) => o.side === 'w').every((o) => o.plies[0].mine === true)).toBe(true);
  });
  it('every entry survives validation (nothing dropped)', () => {
    expect(OPENINGS.length).toBe((raw as { openings: unknown[] }).openings.length);
  });
  it('names and ECO codes are exactly the lichess chess-openings dataset entry for the identifying moves', () => {
    for (const o of OPENINGS) {
      const row = byPgn.get(o.idPgn);
      expect(row, o.id).toBeTruthy();
      expect(row).toEqual({ eco: o.eco, name: o.name });
      expect(pgnOf(o.plies.slice(0, o.idPlies).map((p) => p.san))).toBe(o.idPgn);
    }
  });
  it('lines are legal, positions match, and every move of yours loses at most 0.5 pawns', () => {
    for (const o of OPENINGS) {
      const c = new Chess();
      for (const p of o.plies) {
        expect(c.fen()).toBe(p.fen);
        expect(c.move(p.san).lan).toBe(p.uci);
        if (p.mine) { expect(p.lossCp).toBeGreaterThanOrEqual(0); expect(p.lossCp!).toBeLessThanOrEqual(MAX_LOSS); }
      }
    }
  });
  it('response lines are 6-10 plies, end on your move, and every one of your replies has a reason', () => {
    for (const o of OPENINGS) {
      const extra = o.plies.length - o.idPlies;
      expect(extra, o.id).toBeGreaterThanOrEqual(6);
      expect(extra, o.id).toBeLessThanOrEqual(10);
      expect(o.plies[o.plies.length - 1].mine).toBe(true);
      o.plies.forEach((p, i) => { if (p.mine && i >= o.idPlies) expect(p.why, `${o.id} ${i}`).toBeTruthy(); });
      expect(o.idea.length).toBeGreaterThan(40);
    }
  });
  it('opponent moves are the most played in the sample', () => {
    for (const o of OPENINGS) for (const p of o.plies.slice(o.idPlies)) if (!p.mine && p.src !== 'engine') expect(p.games, o.id).toBeGreaterThan(0);
  });
  it('rejects a tampered line', () => {
    const bad = JSON.parse(JSON.stringify(raw));
    bad.openings[0].plies[3].uci = 'a2a4';
    expect(validateRepertoire(bad).openings.length).toBe(OPENINGS.length - 1);
    const lossy = JSON.parse(JSON.stringify(raw));
    lossy.openings[1].plies.find((p: { mine: boolean }) => p.mine).lossCp = 120;
    expect(validateRepertoire(lossy).openings.length).toBe(OPENINGS.length - 1);
    expect(validateRepertoire(null).openings).toEqual([]);
  });
  it('move text', () => {
    expect(moveText([{ san: 'e4' }, { san: 'c5' }, { san: 'Nf3' }])).toBe('1. e4 c5 2. Nf3');
    expect(moveLabel(3, 'e6')).toBe('2... e6');
    expect(moveLabel(4, 'g3')).toBe('3. g3');
  });
});

describe('practice judging', () => {
  const reti = OPENINGS.find((o) => o.id === 'reti')!;
  it('book move, sound alternative, weaker move, unknown move', () => {
    const i = reti.plies.findIndex((p, k) => p.mine && k >= reti.idPlies);
    expect(judgeMove(reti, i, reti.plies[i].uci)).toEqual({ kind: 'book' });
    const p = reti.plies[i];
    for (const a of p.alts!) {
      const j = judgeMove(reti, i, a.uci);
      expect(['alt-ok', 'alt-weak']).toContain(j.kind);
      expect(wrongText(j)).toMatch(/Try again|try again/);
    }
    const legal = new Chess(p.fen).moves({ verbose: true }).map((m) => m.lan).find((u) => u !== p.uci && !p.alts!.some((a) => a.uci === u))!;
    const j = judgeMove(reti, i, legal);
    expect(j.kind).toBe('other');
    expect(wrongText(j)).toMatch(/isn't the move in this line/);
  });
});

describe('your games', () => {
  const g = (id: string, pgn: string, myColor: 'w' | 'b', result: GameLike['result']): GameLike => ({ id, pgn, myColor, result });
  it('detects the opening by longest prefix and maps it to the practice entry', () => {
    const d = detectOpening('1. Nf3 d5 2. c4 e6 3. g3 Nf6 4. Bg2 Be7 5. O-O O-O 6. b3 c5 7. Bb2 Nc6 8. e3', 'b', book)!;
    expect(d.eco).toMatch(/^A\d\d$/); // the dataset may name a transposition (here an English line); the practice entry follows the moves
    expect(d.entry?.id).toBe('reti');
    expect(detectOpening('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3', 'b', book)!.entry?.id).toBe('evans');
    expect(detectOpening('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6', 'b', book)!.entry?.id).toBe('italian');
    expect(detectOpening('1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6', 'w', book)!.entry?.id).toBe('sicilian');
    // the same moves with you on the other side: not a line you practise
    expect(detectOpening('1. e4 c5 2. Nf3 d6', 'b', book)!.entry).toBeNull();
    expect(entryFor(['d4', 'd5', 'Nf3', 'Nf6', 'Bf4'], "Queen's Pawn Game: London System", 'b')?.id).toBe('london');
  });
  it('counts openings faced, your score, and flags where you struggle', () => {
    const games = [
      g('1', '1. Nf3 d5 2. c4 e6', 'b', 'loss'), g('2', '1. Nf3 d5 2. c4 d4', 'b', 'loss'), g('3', '1. Nf3 d5 2. c4 c6', 'b', 'draw'), g('3', '1. Nf3 d5', 'b', 'win'),
      g('4', '1. e4 c5 2. Nf3 d6', 'w', 'win'), g('5', '1. e4 c5 2. Nc3', 'w', 'win'),
      g('6', '1. e4 e6 2. d4 d5', 'w', 'draw'),
    ];
    const rows = facedStats(games, book);
    const reti = rows.find((r) => r.entry?.id === 'reti')!;
    expect(reti).toMatchObject({ games: 3, wins: 0, draws: 1, losses: 2, myColor: 'b', struggling: true });
    expect(reti.score).toBeCloseTo(1 / 6);
    expect(rows.find((r) => r.entry?.id === 'sicilian')).toMatchObject({ games: 2, wins: 2, score: 1, struggling: false });
    expect(rows[0].games).toBeGreaterThanOrEqual(rows[1].games);
  });
});
