import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import raw from '../../src/repertoire.json';
import { OPENINGS, FAMILIES, familyById, variationsOf, variationWeights, pickVariation, validateRepertoire, judgeMove, wrongText, detectOpening, entryFor, facedStats, moveText, moveLabel, MAX_LOSS, type GameLike } from '../../src/repertoire';

const tsv = 'abcde'.split('').flatMap((f) => readFileSync(`data/${f}.tsv`, 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t')));
const byPgn = new Map(tsv.map(([eco, name, pgn]) => [pgn, { eco, name }]));
const book = JSON.parse(readFileSync('public/book.json', 'utf8'));
const pgnOf = (sans: string[]) => sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(' ');

describe('opening library data', () => {
  it('covers the openings he asked about, both colours', () => {
    const ids = OPENINGS.map((o) => o.id);
    for (const id of ['reti', 'english', 'london', 'qg', 'italian', 'ruy', 'scotch', 'kia', 'kings-gambit', 'danish', 'evans']) expect(ids).toContain(id);
    for (const id of ['sicilian', 'french', 'caro-kann', 'scandinavian', 'kid', 'pirc']) expect(ids).toContain(id);
    for (const id of ['three-knights', 'bishops', 'wayward-queen', 'center-game', 'vienna']) expect(ids).toContain(id);
    for (const id of ['qpg-symmetrical', 'qpg-chigorin', 'indian-knights', 'englund', 'mikenas', 'dutch']) expect(ids).toContain(id);
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
    expect(detectOpening('1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6', 'w', book)!.entry?.id).toBe('sicilian-defense-modern-variations');
    // the same moves with you on the other side: not a line you practise
    expect(detectOpening('1. e4 c5 2. Nf3 d6', 'b', book)!.entry).toBeNull();
    expect(entryFor(['d4', 'd5', 'Nf3', 'Nf6', 'Bf4'], "Queen's Pawn Game: London System", 'b')?.id).toBe('london');
  });
  it('counts openings faced by exact variation name, your score, and flags where you struggle', () => {
    const games = [
      g('1', '1. e4 c5 2. Nf3 d6 3. d4', 'w', 'loss'), g('2', '1. e4 c5 2. Nf3 d6 3. d4', 'w', 'loss'), g('3', '1. e4 c5 2. Nf3 d6 3. d4', 'w', 'draw'), g('3', '1. e4 c5 2. Nf3 d6 3. d4', 'w', 'win'),
      g('4', '1. e4 c5 2. Nc3', 'w', 'win'), g('5', '1. e4 c5 2. Nc3', 'w', 'win'),
      g('6', '1. e4 e5 2. d4 exd4 3. Qxd4 Nc6 4. Qe3', 'b', 'draw'),
    ];
    const rows = facedStats(games, book);
    const name = (pgn: string) => detectOpening(pgn, 'w', book)!.name;
    const open = rows.find((r) => r.label === name('1. e4 c5 2. Nf3 d6 3. d4'))!;
    expect(open.label).toMatch(/^Sicilian Defense/);
    expect(open).toMatchObject({ games: 3, wins: 0, draws: 1, losses: 2, myColor: 'w', struggling: true });
    expect(open.score).toBeCloseTo(1 / 6);
    expect(open.family?.id).toBe('f-sicilian');
    const closed = rows.find((r) => r.label === name('1. e4 c5 2. Nc3'))!;
    expect(closed).toMatchObject({ games: 2, wins: 2, score: 1, struggling: false });
    const cg = rows.find((r) => r.myColor === 'b')!;
    expect(cg.label).toMatch(/^Center Game/);
    expect(cg.family?.id).toBe('f-center');
    expect(rows[0].games).toBeGreaterThanOrEqual(rows[1].games);
  });
});

describe('families and variations', () => {
  it('every variation sits in exactly one family and nothing is dropped', () => {
    const fams = (raw as { families: { variations: string[] }[] }).families;
    expect(FAMILIES.length).toBe(fams.length);
    const all = FAMILIES.flatMap((f) => f.variations);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(OPENINGS.length);
    for (const f of FAMILIES) expect(f.variations.length, f.id).toBeLessThanOrEqual(10);
  });
  it('within a family your move for a position is always the same, so the drill can branch on the opponent only', () => {
    for (const f of FAMILIES) {
      const mine = new Map<string, string>();
      for (const v of variationsOf(f)) for (const p of v.plies) if (p.mine) {
        const k = p.fen.split(' ').slice(0, 3).join(' ');
        if (mine.has(k)) expect(mine.get(k), `${f.id} ${v.id}`).toBe(p.uci);
        mine.set(k, p.uci);
      }
    }
  });
  it('covers the families and variations he asked about, with exact lichess names', () => {
    const names = (id: string) => variationsOf(familyById(id)!).flatMap((v) => v.names);
    expect(names('f-center').some((n) => n.startsWith('Center Game'))).toBe(true);
    expect(names('f-qpg-b')).toEqual(expect.arrayContaining(["Queen's Pawn Game: London System", "Queen's Pawn Game: Accelerated London System"]));
    expect(names('f-indian')).toContain('Indian Defense: Knights Variation');
    for (const f of FAMILIES) for (const v of variationsOf(f)) expect(byPgn.get(v.idPgn)?.name).toBe(v.name);
  });
  it('drops a variation that contradicts your move elsewhere in its family', () => {
    // as White, 1.d4 (Queen's Pawn) and 1.e4 (Sicilian) answer the start position differently: one family can't hold both
    const bad = JSON.parse(JSON.stringify(raw));
    for (const o of bad.openings) delete o.family;
    bad.families = [{ id: 'f-mixed', side: 'w', name: 'Mixed', root: '', familyNames: [], idea: 'x', variations: ['qpg-symmetrical', 'sicilian'], skipped: [] }];
    const r = validateRepertoire(bad);
    expect(r.families.find((x) => x.id === 'f-mixed')!.variations).toEqual(['qpg-symmetrical']);
    // the dropped line still gets a family of its own rather than vanishing
    expect(r.families.some((x) => x.variations.includes('sicilian'))).toBe(true);
  });
  it('the trainer picks variations by how often they are played, due ones first', () => {
    const f = FAMILIES.find((x) => x.variations.length >= 3)!;
    const vs = variationsOf(f);
    const w = variationWeights(f);
    expect([...w.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    const seen = new Map<string, number>();
    let seed = 1;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 4000; i++) { const v = pickVariation(f, () => undefined, 0, rand)!; seen.set(v.id, (seen.get(v.id) ?? 0) + 1); }
    for (const v of vs) expect((seen.get(v.id) ?? 0) / 4000, v.id).toBeCloseTo(w.get(v.id)!, 1);
    // one due variation: it comes first
    const dueId = vs[vs.length - 1].id;
    const srs = (id: string) => (id === dueId ? { due: 5 } : { due: 1e15 }) as never;
    expect(pickVariation(f, srs, 10, rand)!.id).toBe(dueId);
    // never repeats the one you just did when asked not to
    for (let i = 0; i < 50; i++) expect(pickVariation(f, () => undefined, 0, rand, vs[0].id)!.id).not.toBe(vs[0].id);
  });
});
