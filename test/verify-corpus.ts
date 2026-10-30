// Re-checks every corpus lesson against native Stockfish at depth 22 (deeper than the depth 18/20 the corpus was built from).
// Writes docs/CORPUS_NATIVE.md. Run: npx tsx test/verify-corpus.ts
import { readFileSync, writeFileSync } from 'node:fs';
// @ts-ignore plain JS helper
import { engine } from '../scripts/sf.mjs';
import { winPct } from '../src/classify';
const D = +(process.env.DEPTH ?? 22);
const cases = JSON.parse(readFileSync('test/corpus/lessons.json', 'utf8'));
const sf = await engine({ threads: 4, hash: 512 });
let sameBest = 0, bestOk = 0, stillErr = 0; const rows: string[] = [];
for (const c of cases) {
  const m = c.core, me = m.color as 'w' | 'b';
  const a = await sf.analyse(m.fenBefore, D, 3);
  const b = await sf.analyse(m.fenAfter, D, 1);
  const top = a.lines[0], wTop = winPct(top.score, me);
  const ours = a.lines.find((l: any) => l.pv[0] === m.bestUci);
  const wOurs = ours ? winPct(ours.score, me) : null;
  const wPlayed = winPct(b.lines[0].score, me);
  const same = top.pv[0] === m.bestUci; if (same) sameBest++;
  const ok = same || (wOurs != null && wTop - wOurs <= 3); if (ok) bestOk++;
  const loss = Math.round(wTop - wPlayed); const err = loss >= 5; if (err) stillErr++;
  rows.push(`| ${c.id} | ${m.bestSan} | ${same ? 'same' : ok ? 'equal (≤3%)' : 'differs: ' + top.pv[0]} | ${Math.round(m.loss)} → ${loss} | ${err ? 'yes' : 'NO'} |`);
  process.stdout.write('.');
}
sf.quit();
const n = cases.length;
const md = `# Corpus check against native Stockfish (depth ${D})\n\nEach lesson in \`test/corpus/lessons.json\` was re-analysed with native Stockfish at depth ${D}, MultiPV 3.\n\n` +
  `- Same best move: **${sameBest}/${n}**\n- Lesson's best move is the engine's best or within 3% win chance of it: **${bestOk}/${n}**\n- The played move is still an error (loses ≥ 5% win chance): **${stillErr}/${n}**\n\n` +
  `| Case | Lesson's best | Depth ${D} | Loss (corpus → depth ${D}) | Still an error |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;
writeFileSync('docs/CORPUS_NATIVE.md', md);
console.log(`\nsame ${sameBest}/${n}, ok ${bestOk}/${n}, still error ${stillErr}/${n}`);
