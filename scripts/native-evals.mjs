// Make a test fixture: native Stockfish evals (MultiPV 3) for every position of a PGN.
// usage: node scripts/native-evals.mjs game.pgn depth > game.pgn.nativeD.evals.json
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
const [pgnPath, depthArg] = process.argv.slice(2);
const depth = +(depthArg || 18);
const SF = process.env.SF || '/workspace/stockfish/stockfish-linux-x86-64-universal';
const g = new Chess(); g.loadPgn(readFileSync(pgnPath, 'utf8'));
const c = new Chess(); const fens = [c.fen()];
for (const m of g.history()) { c.move(m); fens.push(c.fen()); }
const sf = spawn(SF);
let buf = '', waiter = null;
sf.stdout.on('data', (d) => { buf += d; const ls = buf.split('\n'); buf = ls.pop(); for (const l of ls) waiter?.(l); });
const send = (s) => sf.stdin.write(s + '\n');
const until = (pred, on) => new Promise((res) => { waiter = (l) => { on?.(l); if (pred(l)) res(l); }; });
send('uci'); await until((l) => l === 'uciok');
send('setoption name Threads value 4'); send('setoption name Hash value 256'); send('setoption name MultiPV value 3'); send('isready'); await until((l) => l === 'readyok');
const out = [];
for (const fen of fens) {
  const t = new Chess(fen);
  if (t.isGameOver()) { out.push({ lines: [], depth: 0, terminal: t.isCheckmate() ? 'checkmate' : t.isStalemate() ? 'stalemate' : 'draw' }); continue; }
  const lines = new Map();
  const wtm = fen.split(' ')[1] === 'w', sign = wtm ? 1 : -1;
  send(`position fen ${fen}`); send(`go depth ${depth}`);
  const best = await until((l) => l.startsWith('bestmove'), (l) => {
    if (!l.startsWith('info ') || !l.includes(' pv ') || l.includes('bound')) return;
    const x = l.split(' '); const d = +x[x.indexOf('depth') + 1]; if (d !== depth) return;
    const mp = +x[x.indexOf('multipv') + 1]; const si = x.indexOf('score'); const kind = x[si + 1], v = +x[si + 2];
    const score = kind === 'mate' ? { cp: v * sign > 0 ? 100000 - v * sign * 100 : -100000 - v * sign * 100, mate: v * sign } : { cp: v * sign, mate: null };
    lines.set(mp, { score, pv: x.slice(x.indexOf('pv') + 1), depth: d });
  });
  out.push({ lines: [...lines.keys()].sort().map((k) => lines.get(k)), depth });
  void best;
}
send('quit');
process.stdout.write(JSON.stringify(out));
