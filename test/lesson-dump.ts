// Runs the new lesson generator over every test game, both sides, all levels; prints lessons and invariant results.
import { readFileSync, readdirSync } from 'node:fs';
import { parseGame, reviewGame, type Book } from '../src/review';
import { buildMoments } from '../src/coach';
import { lessonFor } from '../src/lesson';
import { checkRecord } from '../src/invariants';
import { buildEvidence } from '../src/evidence';
import { renderText } from '../src/words';
const book: Book = JSON.parse(readFileSync('public/book.json', 'utf8'));
const files = readdirSync('test').filter((f) => /\.pgn$/.test(f));
const quiet = process.argv.includes('-q');
let n = 0, bad = 0, fallback = 0, low = 0;
const mech: Record<string, number> = {};
for (const f of files) {
  const evf = readdirSync('test').find((x) => x.startsWith(f + '.native') && x.endsWith('.evals.json'));
  if (!evf) continue;
  const { plies } = parseGame(readFileSync('test/' + f, 'utf8'));
  const evals = JSON.parse(readFileSync('test/' + evf, 'utf8'));
  const reviews = reviewGame({ plies, evals, book });
  for (const me of ['w', 'b'] as const) for (const level of ['beginner', 'intermediate', 'advanced'] as const) {
    const moments = buildMoments(plies, evals, reviews, me, level);
    for (const m of moments) {
      n++;
      const L = lessonFor(m, { level });
      const rv = checkRecord(L.record, buildEvidence(m, { level }));
      if (L.violations.length || rv.length) bad++;
      if (L.sections.some((s) => s.fallback)) fallback++;
      if (L.lowConfidence) low++;
      mech[L.record.mechanism.id + '/' + L.record.solution.id] = (mech[L.record.mechanism.id + '/' + L.record.solution.id] ?? 0) + 1;
      if (!quiet || L.violations.length || rv.length) {
        console.log(`\n== ${f} ${me} ${level} ${m.moveNumber}${m.color === 'w' ? '.' : '...'}${m.playedSan} best ${m.bestSan} mech ${L.record.mechanism.id} sol ${L.record.solution.id} conf ${L.record.confidence}`);
        for (const s of L.sections) console.log(`  [${s.label}]${s.fallback ? ' (FALLBACK)' : ''} ${renderText(s.text, 'san')}`);
        for (const v of [...L.violations, ...rv]) console.log('  !! ', JSON.stringify(v));
      }
    }
  }
}
console.log(`\nlessons ${n} with-violations ${bad} with-fallback ${fallback} low-confidence ${low}`);
console.log(JSON.stringify(mech));
