// Node test harness: analyse a PGN with a UCI engine (native or WASM) and print the review.
import { renderText } from '../src/words';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseGame, reviewGame, summarize, terminalEval, fmtScore, type Book } from '../src/review';
import { mateToCp, type PosEval, type Line } from '../src/engine';

const [pgnPath, engineKind = 'wasm', depthStr = '18', outPath = ''] = process.argv.slice(2);
const depth = +depthStr;
const cmd = engineKind === 'native'
  ? ['/workspace/stockfish/stockfish-linux-x86-64-universal']
  : [process.execPath, 'node_modules/stockfish/bin/stockfish-19-lite-single.js'];

function makeEngine() {
  const p = spawn(cmd[0], cmd.slice(1), { stdio: 'pipe' });
  let buf = '';
  let handler: (l: string) => void = () => {};
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); handler(l); }
  });
  const send = (s: string) => p.stdin.write(s + '\n');
  const analyse = (fen: string): Promise<PosEval> => new Promise((res) => {
    const lines = new Map<number, Line>();
    const wtm = fen.split(' ')[1] === 'w';
    handler = (l) => {
      if (l.startsWith('info ') && l.includes(' pv ') && l.includes(' score ') && !/bound/.test(l)) {
        const t = l.split(' ');
        const d = +t[t.indexOf('depth') + 1];
        const mi = t.indexOf('multipv'); const mp = mi >= 0 ? +t[mi + 1] : 1;
        const si = t.indexOf('score'); const kind = t[si + 1]; const v = +t[si + 2] * (wtm ? 1 : -1);
        lines.set(mp, { score: kind === 'mate' ? { cp: mateToCp(v), mate: v } : { cp: v, mate: null }, pv: t.slice(t.indexOf('pv') + 1), depth: d });
      } else if (l.startsWith('bestmove')) {
        const best = l.split(' ')[1];
        let ls = [...lines.keys()].sort((a, b) => a - b).map((k) => lines.get(k)!);
        const idx = ls.findIndex((x) => x.pv[0] === best);
        if (idx > 0) ls = [ls[idx], ...ls.filter((_, i) => i !== idx)];
        res({ lines: ls, depth: ls[0]?.depth ?? 0 });
      }
    };
    send('setoption name MultiPV value 3');
    send('position fen ' + fen);
    send(`go depth ${depth}`);
  });
  send('uci'); send('setoption name Threads value 1'); send('setoption name Hash value 64'); send('isready');
  return { analyse, quit: () => { send('quit'); p.kill(); } };
}

const { plies } = parseGame(readFileSync(pgnPath, 'utf8'));
const fens = [plies[0].fenBefore, ...plies.map((p) => p.fenAfter)];
const cacheFile = `${pgnPath}.${engineKind}${depth}.evals.json`;
const t0 = Date.now();
let evals: (PosEval | null)[] = new Array(fens.length).fill(null);
if (existsSync(cacheFile)) evals = JSON.parse(readFileSync(cacheFile, 'utf8'));
else {
  const engines = Array.from({ length: 6 }, makeEngine);
  let next = 0;
  await Promise.all(engines.map(async (e) => {
    while (next < fens.length) {
      const i = next++;
      evals[i] = terminalEval(fens[i]) ?? (await e.analyse(fens[i]));
    }
    e.quit();
  }));
  writeFileSync(cacheFile, JSON.stringify(evals));
}
const book: Book = JSON.parse(readFileSync('public/book.json', 'utf8'));
const reviews = reviewGame({ plies, evals, book });
const sum = summarize(plies, evals, reviews);
const rows = plies.map((p, i) => {
  const r = reviews[i]!;
  return { ply: p.index, move: `${p.moveNumber}${p.color === 'w' ? '.' : '...'}${p.san}`, cls: r.cls, loss: +r.loss.toFixed(1), best: r.bestSan, evalAfter: fmtScore(r.scoreAfter), depth: evals[i]!.depth, ex: renderText(r.explanation, 'words') };
});
for (const r of rows) console.log(`${r.move.padEnd(12)} ${r.cls.padEnd(10)} loss=${String(r.loss).padEnd(5)} best=${String(r.best).padEnd(7)} after=${r.evalAfter.padEnd(6)} d${r.depth}  ${r.ex}`);
console.log('accuracy W/B', sum.accW?.toFixed(1), sum.accB?.toFixed(1), JSON.stringify(sum.counts), `${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (outPath) writeFileSync(outPath, JSON.stringify(rows, null, 1));
