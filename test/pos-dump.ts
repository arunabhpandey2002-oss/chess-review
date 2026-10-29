import { readFileSync } from 'node:fs';
import { parseGame } from '../src/review';
import { pvToSan, formatPv } from '../src/tactics';
const [pgnPath, evPath, ...idx] = process.argv.slice(2);
const { plies } = parseGame(readFileSync(pgnPath, 'utf8'));
const evals = JSON.parse(readFileSync(evPath, 'utf8'));
for (const s of idx) { const i = +s; const p = plies[i];
  console.log(i, p.moveNumber, p.san, p.fenBefore);
  for (const l of evals[i].lines) console.log('  best', JSON.stringify(l.score), formatPv(p.fenBefore, pvToSan(p.fenBefore, l.pv, 10)));
  const r = evals[i + 1].lines[0]; console.log('  reply', JSON.stringify(r.score), formatPv(p.fenAfter, pvToSan(p.fenAfter, r.pv, 10)));
}
