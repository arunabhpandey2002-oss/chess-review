// Explanation regression corpus: every lesson position from the test games (native Stockfish evals).
// For each case, every level and every "what were you thinking" answer: no invariant violations, only squares on the
// board, a fact-checked record, and the same mechanism and solution as when the corpus was built.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { lessonFor } from '../../src/lesson';
import { checkRecord, checkSection } from '../../src/invariants';
import { buildEvidence } from '../../src/evidence';
import { diagnose, CHOICES } from '../../src/diagnose';
import { allowedSquares, groundCheck, type MomentCore } from '../../src/explain';
import { renderText } from '../../src/words';

interface Case { id: string; core: MomentCore; expect: { mechanism: string; solution: string; primaryConcept: string; lowConfidence: boolean; best: string; cls: string } }
const cases: Case[] = JSON.parse(readFileSync('test/corpus/lessons.json', 'utf8'));
const levels = ['beginner', 'intermediate', 'advanced'] as const;

describe(`explanation corpus (${cases.length} positions)`, () => {
  it('has at least 30 distinct positions', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map((c) => `${c.core.fenBefore}|${c.core.playedUci}`)).size).toBe(cases.length);
  });
  for (const c of cases) {
    it(c.id, () => {
      const allowed = allowedSquares(c.core);
      for (const level of levels) {
        const L = lessonFor(c.core, { level });
        const ev = buildEvidence(c.core, { level });
        expect(L.violations, `${level} lesson`).toEqual([]);
        expect(checkRecord(L.record, ev), `${level} record`).toEqual([]);
        for (const s of L.sections) {
          expect(checkSection(s.text, ev, s.label), `${level} ${s.label}`).toEqual([]);
          expect(groundCheck(renderText(s.text, 'san'), allowed), `${level} ${s.label} squares`).toBe(true);
        }
        if (level === 'intermediate') {
          expect({ mechanism: L.record.mechanism.id, solution: L.record.solution.id, primaryConcept: L.record.primaryConcept, lowConfidence: !!L.lowConfidence })
            .toEqual({ mechanism: c.expect.mechanism, solution: c.expect.solution, primaryConcept: c.expect.primaryConcept, lowConfidence: c.expect.lowConfidence });
        }
      }
      for (const ch of CHOICES) {
        const d = diagnose(c.core, ch.id, null);
        expect(d.lines.length).toBeGreaterThan(0);
        expect(d.lines.length).toBeLessThanOrEqual(3);
        for (const l of d.lines) expect(groundCheck(renderText(l.text, 'san'), allowed), `${ch.id}`).toBe(true);
        if (d.verdict === 'partly') expect(d.summary).toMatch(/^Matches part: .+, but (also .+|the details differ)$/);
      }
    });
  }
});
