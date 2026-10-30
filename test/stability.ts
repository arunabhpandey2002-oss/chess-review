// Standard-vs-Deep stability with native Stockfish: does the screening depth find the same critical moves, and does a
// deeper check keep the same best move and lesson? Writes docs/STABILITY.md. Run: npx tsx test/stability.ts
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { parseGame, reviewGame, type Book } from '../src/review';
import { buildMoments } from '../src/coach';
import { criticalPlies } from '../src/batch';
import { lessonFor } from '../src/lesson';
import type { PosEval } from '../src/engine';
// @ts-ignore plain JS helper
import { engine } from '../scripts/sf.mjs';

const book: Book = JSON.parse(readFileSync('public/book.json', 'utf8'));
const sf = await engine({ threads: 1, hash: 64 });
async function evalsAt(file: string, depth: number, mpv: number): Promise<PosEval[]> {
  const cache = `test/${file}.native${depth}.evals.json`;
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  const { plies } = parseGame(readFileSync(`test/${file}`, 'utf8'));
  const fens = [plies[0].fenBefore, ...plies.map((p) => p.fenAfter)];
  const out: PosEval[] = [];
  for (const f of fens) out.push(await sf.analyse(f, depth, mpv));
  writeFileSync(cache, JSON.stringify(out));
  return out;
}
const files = readdirSync('test').filter((f) => /^g_.*\.pgn$/.test(f) && existsSync(`test/${f}.native18.evals.json`)).concat(['game.pgn']);
const rows: string[] = [];
const T = { crit18: 0, crit12found: 0, verified: 0, sameBest: 0, moments18: 0, momentsBatch: 0, sameMoment: 0, sameMech: 0 };
for (const f of files) {
  const { plies } = parseGame(readFileSync(`test/${f}`, 'utf8'));
  const deep = f === 'game.pgn' ? JSON.parse(readFileSync('test/game.pgn.native20.evals.json', 'utf8')) : JSON.parse(readFileSync(`test/${f}.native18.evals.json`, 'utf8'));
  const screen = await evalsAt(f, 12, 2);
  for (const me of ['w', 'b'] as const) {
    const c18 = criticalPlies(plies, deep, me), c12 = criticalPlies(plies, screen, me);
    T.crit18 += c18.length; T.crit12found += c18.filter((i) => c12.includes(i)).length;
    // batch evals: screen everywhere, deep at critical plies and the one after
    const ev = screen.slice();
    for (const i of c12) { ev[i] = deep[i]; ev[i + 1] = deep[i + 1]; }
    for (const i of c12) { T.verified++; if (screen[i].lines[0]?.pv[0] === deep[i].lines[0]?.pv[0]) T.sameBest++; }
    const full = buildMoments(plies, deep, reviewGame({ plies, evals: deep, book }), me, 'intermediate');
    const set12 = new Set(c12);
    const bm = buildMoments(plies, ev, reviewGame({ plies, evals: ev, book }), me, 'intermediate').filter((m) => set12.has(m.ply));
    T.moments18 += full.length; T.momentsBatch += bm.length;
    for (const m of full) {
      const b = bm.find((x) => x.ply === m.ply);
      if (!b) continue;
      T.sameMoment++;
      if (lessonFor(m, { level: 'intermediate' }).record.mechanism.id === lessonFor(b, { level: 'intermediate' }).record.mechanism.id) T.sameMech++;
    }
  }
}
// Standard (d20) vs Deep (d22) on game.pgn
const { plies } = parseGame(readFileSync('test/game.pgn', 'utf8'));
const d20 = JSON.parse(readFileSync('test/game.pgn.native20.evals.json', 'utf8')), d22 = JSON.parse(readFileSync('test/game.pgn.native22.evals.json', 'utf8'));
let dm = 0, dsame = 0, dbest = 0, dmech = 0;
for (const me of ['w', 'b'] as const) {
  const a = buildMoments(plies, d20, reviewGame({ plies, evals: d20, book }), me, 'intermediate');
  const b = buildMoments(plies, d22, reviewGame({ plies, evals: d22, book }), me, 'intermediate');
  for (const m of a) { dm++; const x = b.find((y) => y.ply === m.ply); if (!x) continue; dsame++; if (x.bestUci === m.bestUci) dbest++; if (lessonFor(m, { level: 'intermediate' }).record.mechanism.id === lessonFor(x, { level: 'intermediate' }).record.mechanism.id) dmech++; }
}
sf.quit();
const pc = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');
rows.push(`# Stability (native Stockfish, ${new Date().toISOString().slice(0, 10)})`, '',
  `Games: ${files.length}, both sides. Screen depth 12 (MultiPV 2) vs check depth 18 (MultiPV 3); game.pgn uses depth 20.`, '',
  '| Check | Result |', '|---|---|',
  `| Critical moves (≥8% loss at depth 18) also flagged at depth 12 | ${T.crit12found}/${T.crit18} (${pc(T.crit12found, T.crit18)}) |`,
  `| Flagged positions where the best move is the same at both depths | ${T.sameBest}/${T.verified} (${pc(T.sameBest, T.verified)}) |`,
  `| Full-depth lessons that the two-pass batch also picks | ${T.sameMoment}/${T.moments18} (${pc(T.sameMoment, T.moments18)}) |`,
  `| … of those, same error mechanism in the lesson | ${T.sameMech}/${T.sameMoment} (${pc(T.sameMech, T.sameMoment)}) |`,
  `| Depth 20 vs 22 (game.pgn): same lesson positions | ${dsame}/${dm} (${pc(dsame, dm)}) |`,
  `| Depth 20 vs 22: same best move / same mechanism | ${dbest}/${dsame}, ${dmech}/${dsame} |`, '');
writeFileSync('docs/STABILITY.md', rows.join('\n'));
console.log(rows.join('\n'));
