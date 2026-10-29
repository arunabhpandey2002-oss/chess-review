import { readFileSync } from 'node:fs';
import { parseGame, reviewGame, type Book } from '../src/review';
import { buildMoments, buildSummary } from '../src/coach';
import { explainMoment, buildHints } from '../src/explain';
import { renderText } from '../src/words';
import { levelForRating } from '../src/moments';
const [pgnPath, evPath, who] = process.argv.slice(2);
const pgn = readFileSync(pgnPath, 'utf8');
const { plies, headers } = parseGame(pgn);
const evals = JSON.parse(readFileSync(evPath, 'utf8'));
const book: Book = JSON.parse(readFileSync('public/book.json', 'utf8'));
const reviews = reviewGame({ plies, evals, book });
const me = headers.White.toLowerCase() === who.toLowerCase() ? 'w' : 'b';
const level = levelForRating(+(me === 'w' ? headers.WhiteElo : headers.BlackElo));
const moments = buildMoments(plies, evals, reviews, me, level);
const sum = buildSummary({ plies, evals, reviews, me, moments, opening: 'X', opponent: me === 'w' ? headers.Black : headers.White, resultText: 'Result ' + headers.Result, timeControl: headers.TimeControl });
const R = (t: string) => renderText(t, 'san');
console.log('LEVEL', level);
console.log('STORY', sum.story.map(R).join(' '));
console.log('TURN', sum.turning && R(sum.turning)); console.log('STRONG', sum.strongest && R(sum.strongest)); console.log('IMPROVE', sum.improvement && R(sum.improvement));
console.log('PHASES', JSON.stringify(sum.phases)); console.log('TIME', sum.time.join(' | ')); console.log('ACTION', sum.action); console.log('TAGS', sum.errorTags);
for (const m of moments) {
  console.log(`\n== ply ${m.ply} ${m.moveNumber}${m.color === 'w' ? '.' : '...'}${m.playedSan} best ${m.bestSan} loss ${m.loss.toFixed(1)} score ${m.score.toFixed(1)} primary ${m.tags.primary.id} sol ${m.tags.solutionTag.id} err ${m.tags.error.map((t) => t.id)} why ${m.why}`);
  for (const h of buildHints(m)) console.log(`  H${h.stage} ${R(h.text)} ${h.squares?.join(',') ?? ''}`);
  const ls = explainMoment(m, level);
  for (const s of ls.sections) console.log(`  [${s.label}] ${R(s.text)}`);
  console.log('  grounded', ls.grounded);
}
