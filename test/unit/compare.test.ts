import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareLines, checkComparison, walk, moveLabel } from '../../src/compare';
import { VTree } from '../../src/tree';

const fx = JSON.parse(readFileSync('test/compare.fixture.json', 'utf8'));
const tb = { id: 'taken-back' as const, ...fx.takenBack };
const cmp = compareLines(fx.startFen, fx.me, { id: 'original', ...fx.original }, { id: 'replay', ...fx.replay }, [tb]);

describe('compare with original', () => {
  it('labels moves by real move numbers', () => {
    expect(moveLabel(fx.startFen, 'exd5')).toBe('15.exd5');
    expect(walk(fx.startFen, { id: 'original', ...fx.original }, fx.me)[1].label).toBe('15...Nxd3+');
  });
  it('aligns both lines move by move from the shared position', () => {
    expect(cmp.rows).toHaveLength(14);
    expect(cmp.rows[0].label).toBe('15.');
    expect(cmp.rows[1].label).toBe('15...');
    for (const r of cmp.rows) { if (r.orig && r.replay) expect(r.orig.label.split(/\.+/)[0]).toBe(r.replay.label.split(/\.+/)[0]); }
    expect(cmp.curves.original).toHaveLength(15);
    expect(cmp.curves.replay).toHaveLength(15);
  });
  it('finds the divergence and grounds the explanation in both ledgers', () => {
    expect(cmp.divergences).toHaveLength(1);
    const d = cmp.divergences[0];
    expect(d.label).toBe('15.exd5');
    const r0 = walk(fx.startFen, { id: 'replay', ...fx.replay }, fx.me)[0];
    expect(d.replaySan).toBe(r0.san);
    expect(d.text.startsWith(`You diverged at 15.exd5 → ${r0.label}.`)).toBe(true);
    expect(d.text).toMatch(/You still slipped once; the biggest was \S+ \(−\d+%\), the same piece-safety pattern as in the game\./);
    expect(d.text).toMatch(/In the original you lost the queen/);
    expect(checkComparison(cmp)).toEqual([]);
  });
  it('lists mistakes from both lines, including the taken-back attempt', () => {
    const lines = new Set(cmp.slips.map((s) => s.line));
    expect(lines.has('original')).toBe(true);
    expect(lines.has('taken-back')).toBe(true);
    const o = cmp.slips.find((s) => s.line === 'original' && s.label === '15.exd5')!;
    expect(o.concept).toBe('piece-safety');
    expect(cmp.slips.every((s) => s.loss >= 8)).toBe(true);
  });
  it('no divergence when the replay repeats the game; transpositions re-join', () => {
    const same = compareLines(fx.startFen, fx.me, { id: 'original', ...fx.original }, { id: 'replay', ...fx.original });
    expect(same.divergences).toHaveLength(0);
    expect(same.summary).toMatch(/followed the game exactly/);
    expect(same.rows.every((r) => r.shared)).toBe(true);
    // 1.Nf3 Nf6 2.d4 vs 1.d4 Nf6 2.Nf3 reach the same position: one divergence, then shared
    const S = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const ev = Array(4).fill({ cp: 20, mate: null });
    const t = compareLines(S, 'w', { id: 'original', ucis: ['g1f3', 'g8f6', 'd2d4'], evals: ev }, { id: 'replay', ucis: ['d2d4', 'g8f6', 'g1f3'], evals: ev });
    expect(t.divergences).toHaveLength(1);
    expect(t.rows[2].shared).toBe(true);
  });
  it('checkComparison catches a fabricated fact', () => {
    const bad = structuredClone(cmp);
    bad.divergences[0].text = bad.divergences[0].text.replace(/lost the queen/, 'lost the knight').replace(/from \d+%/, 'from 1%');
    expect(checkComparison(bad).length).toBeGreaterThanOrEqual(2);
  });
  it('take-backs from the replay tree become comparison lines', () => {
    const t = new VTree(fx.startFen);
    let id = t.root.id;
    const a = t.add(id, fx.original.ucis[0], 'replay')!; const b = t.add(a.id, fx.original.ucis[1], 'replay')!;
    t.markTakenBack(a.id);
    id = t.root.id;
    for (const u of fx.replay.ucis.slice(0, 4)) id = t.add(id, u, 'replay')!.id;
    const kept = t.branches().filter((br) => br.some((n) => n.kind === 'taken-back'));
    expect(kept).toHaveLength(1);
    expect(kept[0].map((n) => n.uci)).toEqual([a.uci, b.uci]);
    expect(t.mainline().map((n) => n.uci)).toEqual(fx.replay.ucis.slice(0, 4));
  });
});
