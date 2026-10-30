// Builds the explanation regression corpus from the test games (native Stockfish evals): every distinct lesson position
// at any level, for both sides, with the expected record. Run: npx tsx test/build-corpus.ts
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { parseGame, reviewGame, type Book } from '../src/review';
import { buildMoments } from '../src/coach';
import { lessonFor } from '../src/lesson';
const book: Book = JSON.parse(readFileSync('public/book.json', 'utf8'));
const out: unknown[] = [];
const seen = new Set<string>();
for (const f of readdirSync('test').filter((x) => /\.pgn$/.test(x))) {
  const evf = readdirSync('test').filter((x) => x.startsWith(f + '.native') && x.endsWith('.evals.json')).sort().pop();
  if (!evf) continue;
  const { plies, headers } = parseGame(readFileSync('test/' + f, 'utf8'));
  const evals = JSON.parse(readFileSync('test/' + evf, 'utf8'));
  const reviews = reviewGame({ plies, evals, book });
  for (const me of ['w', 'b'] as const) for (const level of ['beginner', 'intermediate', 'advanced'] as const) {
    for (const m of buildMoments(plies, evals, reviews, me, level, headers.TimeControl)) {
      const k = `${m.fenBefore}|${m.playedUci}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const L = lessonFor(m, { level: 'intermediate' });
      out.push({ id: `${f.replace(/\.pgn$/, '')}:${m.moveNumber}${m.color === 'w' ? '.' : '...'}${m.playedSan}`, evals: evf.replace(/^.*\.(native\d+)\..*$/, '$1'), core: m,
        expect: { mechanism: L.record.mechanism.id, solution: L.record.solution.id, primaryConcept: L.record.primaryConcept, lowConfidence: !!L.lowConfidence, best: m.bestSan, cls: m.cls } });
    }
  }
}
writeFileSync('test/corpus/lessons.json', JSON.stringify(out, null, 0));
console.log(`${out.length} cases`);
