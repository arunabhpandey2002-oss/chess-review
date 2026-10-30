import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { readFileSync, readdirSync } from 'node:fs';
import { parseGame, reviewGame, type Book } from '../../src/review';
import { buildMoments } from '../../src/coach';
import { ledger, ledgerSentence, lossPhrase } from '../../src/ledger';
import { bandFor, bandSolves, buildEvidence } from '../../src/evidence';
import { lessonFor } from '../../src/lesson';
import { checkSection, checkRecord, BANNED } from '../../src/invariants';
import { renderText, tokMove, tokLine } from '../../src/words';
import type { Moment } from '../../src/coach';

const book: Book = JSON.parse(readFileSync('public/book.json', 'utf8'));
const memo = new Map<string, { file: string; level: string; m: Moment }[]>();
function allMoments(levels: readonly string[] = ['beginner', 'intermediate', 'advanced']) {
  const k = levels.join();
  if (!memo.has(k)) memo.set(k, allMomentsRaw(levels as never));
  return memo.get(k)!;
}
function allMomentsRaw(levels: readonly ('beginner' | 'intermediate' | 'advanced')[]) {
  const out: { file: string; level: string; m: Moment }[] = [];
  for (const f of readdirSync('test').filter((x) => /\.pgn$/.test(x))) {
    const evf = readdirSync('test').find((x) => x.startsWith(f + '.native') && x.endsWith('.evals.json'));
    if (!evf) continue;
    const { plies } = parseGame(readFileSync('test/' + f, 'utf8'));
    const evals = JSON.parse(readFileSync('test/' + evf, 'utf8'));
    const reviews = reviewGame({ plies, evals, book });
    for (const me of ['w', 'b'] as const) for (const level of levels) for (const m of buildMoments(plies, evals, reviews, me, level)) out.push({ file: f, level, m });
  }
  return out;
}

describe('material ledger', () => {
  it('a queen trade is a trade, never a queen won', () => {
    const L = ledger('3qk3/8/8/8/8/8/8/3QK3 w - - 0 1', ['d1d8', 'e8d8'], 'w');
    expect(L.queenTrade).toBe(true);
    expect(L.netChange).toBe(0);
    expect(L.won).toHaveLength(0);
    expect(ledgerSentence(L)).toBe('the queens are traded; material stays level');
  });
  it('a free bishop is counted once and checked against the board', () => {
    const L = ledger('4k3/8/8/8/6b1/8/8/3QK3 w - - 0 1', ['d1g4'], 'w');
    expect(L.netChange).toBe(3);
    expect(L.finalCheck).toBe(true);
    expect(ledgerSentence(L)).toBe('you take their bishop on g4; you end up a piece ahead');
    expect(lossPhrase(ledger('4k3/8/8/8/6b1/8/8/3QK3 b - - 0 1', ['g4d1', 'e1d1'], 'w'))).toBe('your queen for a bishop');
  });
  it('never cuts an exchange in half at the ply limit', () => {
    // 1.Bxf6 gxf6: the recapture is past maxPlies=1 but is still counted
    const L = ledger('4k3/8/5n2/8/8/8/1B6/4K3 w - - 0 1', ['b2f6'], 'w', 1);
    expect(L.netChange).toBe(3);
    const L2 = ledger('4k3/6p1/5n2/8/8/8/1B6/4K3 w - - 0 1', ['b2f6', 'g7f6'], 'w', 1);
    expect(L2.plies).toBe(2);
    expect(L2.netChange).toBe(0);
    expect(L2.exchanged).toHaveLength(1);
  });
  it('board total always equals the event total on the test games', () => {
    for (const { m } of allMoments(['intermediate'])) {
      const L = ledger(m.fenBefore, [m.playedUci, ...(m.reply?.pv ?? [])], m.color);
      expect(L.finalCheck, `${m.fenBefore} ${m.playedUci}`).toBe(true);
    }
  }, 120_000);
});

describe('retry bands', () => {
  const base = { level: 'intermediate', legal: true, isPlayed: false, isBest: false, wpBest: 80, wpPlayed: 30, bestMates: false, candMates: false, onlyMove: false };
  it('grades best, acceptable, playable, fails and illegal', () => {
    expect(bandFor({ ...base, isBest: true, wpCand: 80 })).toBe('best');
    expect(bandFor({ ...base, wpCand: 77 })).toBe('acceptable');
    expect(bandFor({ ...base, wpCand: 70 })).toBe('playable');
    expect(bandFor({ ...base, wpCand: 40 })).toBe('fails');
    expect(bandFor({ ...base, isPlayed: true, wpCand: 30 })).toBe('fails');
    expect(bandFor({ ...base, legal: false, wpCand: 0 })).toBe('illegal');
  });
  it('a different mate is fully acceptable; giving up the mate for a big edge is only playable', () => {
    expect(bandFor({ ...base, wpBest: 100, bestMates: true, candMates: true, wpCand: 100 })).toBe('acceptable');
    expect(bandFor({ ...base, wpBest: 100, bestMates: true, candMates: false, wpCand: 95 })).toBe('playable');
    expect(bandFor({ ...base, wpBest: 100, bestMates: true, candMates: false, wpCand: 70 })).toBe('fails');
  });
  it('tightens in only-move positions and for stronger players', () => {
    expect(bandFor({ ...base, wpCand: 74 })).not.toBe('acceptable');
    expect(bandFor({ ...base, level: 'beginner', wpCand: 74 })).toBe('acceptable');
    expect(bandFor({ ...base, level: 'beginner', onlyMove: true, wpCand: 74 })).not.toBe('acceptable');
    expect(bandFor({ ...base, level: 'advanced', wpCand: 78 })).toBe('acceptable');
  });
  it('a move that loses material against the best line is never fully acceptable', () => {
    expect(bandFor({ ...base, wpCand: 79, candNet: -3, bestNet: 0 })).not.toBe('acceptable');
  });
  it('playable solves for beginners and intermediates but not advanced players', () => {
    expect(bandSolves('playable', 'beginner')).toBe(true);
    expect(bandSolves('playable', 'advanced')).toBe(false);
    expect(bandSolves('fails', 'beginner')).toBe(false);
  });
});

describe('explanations on every test game moment (3 levels)', () => {
  const all = allMoments();
  it('has a real sample', () => expect(all.length).toBeGreaterThan(60));
  it('every lesson passes all invariants without fallback, and the record is consistent', () => {
    for (const { m, level, file } of all) {
      const L = lessonFor(m, { level });
      expect(L.violations, `${file} ${level} ${m.playedSan}`).toEqual([]);
      expect(checkRecord(L.record, buildEvidence(m, { level }))).toEqual([]);
      const ids = L.sections.map((s) => s.id);
      expect(ids).toContain('happened');
      expect(ids).toContain('notice');
      const text = L.sections.map((s) => renderText(s.text, 'san')).join(' ').toLowerCase();
      for (const b of BANNED) expect(text).not.toContain(b);
      if (L.record.materialOutcome.queenTrade) expect(text).not.toMatch(/win (the|their) queen/);
    }
  }, 120_000);
  it('levels change depth: beginners get the fewest sections, advanced the most', () => {
    const byKey = new Map<string, Record<string, number>>();
    for (const { m, level, file } of all) {
      const k = `${file}|${m.ply}`;
      const r = byKey.get(k) ?? {}; r[level] = lessonFor(m, { level }).sections.length; byKey.set(k, r);
    }
    for (const r of byKey.values()) if (r.beginner && r.advanced) expect(r.beginner).toBeLessThan(r.advanced);
  }, 120_000);
  it('low-confidence moments use the honest positional fallback, not an invented tactic', () => {
    for (const { m, level } of all) {
      const L = lessonFor(m, { level });
      if (!L.lowConfidence) continue;
      const best = L.sections.find((s) => s.id === 'best')!;
      expect(renderText(best.text, 'san')).toMatch(/positional factors rather than one immediate tactic/);
      expect(L.sections.some((s) => s.id === 'pattern')).toBe(false);
    }
  }, 120_000);
});

describe('invariants catch fabricated claims', () => {
  const all = allMoments(['intermediate']);
  const hit = all.find(({ m }) => buildEvidence(m, { level: 'intermediate' }).rec.mechanism.id !== 'positional')!.m;
  const ev = buildEvidence(hit, { level: 'intermediate' });
  const rules = (t: string) => checkSection(t, ev).map((v) => v.rule);
  it('illegal move token', () => expect(rules(`Play ${tokMove(hit.fenBefore, 'Ke9')}.`)).toContain('illegal-move'));
  it('move that is in no engine line', () => {
    const legalOther = new Chess(hit.fenBefore).moves().find((s: string) => !ev.rec.bestMoves.some((b) => b.san === s) && s !== hit.playedSan);
    expect(rules(`Play ${tokMove(hit.fenBefore, legalOther)}.`)).toContain('move-not-in-line');
  });
  it('line that is not a prefix of the engine line', () => {
    expect(rules(`Line: ${tokLine(hit.fenBefore, [hit.playedSan])}.`)).not.toContain('move-not-in-line');
  });
  it('invented capture', () => expect(rules('Then they take your queen on a1.')).toContain('capture-claim'));
  it('invented mate', () => { if (ev.rec.mateIn == null && ev.rec.bestMateIn == null) expect(rules('This allows mate in 3.')).toContain('mate-claim'); });
  it('wrong material amount', () => expect(rules('you end up 17 points of material ahead')).toContain('material-amount'));
  it('piece that is not on the square', () => {
    const empty = 'a4'; // a queen and a king cannot both stand on one square
    expect(rules(`Your queen on ${empty} and your king on ${empty}.`)).toContain('piece-on-square');
  });
  it('"only move" when there were alternatives', () => { if (!ev.rec.onlyMove) expect(rules('This was the only move.')).toContain('forced-claim'); });
  it('sacrifice not in the ledger', () => { if (!ev.replyL.tempSacrifice && !ev.replyL.genuineSacrifice && !ev.bestL.tempSacrifice && !ev.bestL.genuineSacrifice) expect(rules('A brilliant sacrifice.')).toContain('sacrifice-claim'); });
  it('banned shallow phrase', () => expect(rules('The engine prefers another move.')).toContain('banned-phrase'));
  it('a lesson with a fabricated section falls back to the concrete line', () => {
    const L = lessonFor(hit, { level: 'intermediate' });
    expect(L.grounded).toBe(true);
  });
});
