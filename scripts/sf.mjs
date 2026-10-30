// Tiny native Stockfish driver for fixtures and verification (box only; the app uses the WASM engine).
import { spawn } from 'node:child_process';
export const SF = process.env.SF || '/workspace/stockfish/stockfish-linux-x86-64-universal';
export async function engine({ threads = 4, hash = 256 } = {}) {
  const sf = spawn(SF);
  let buf = '', waiter = null;
  sf.stdout.on('data', (d) => { buf += d; const ls = buf.split('\n'); buf = ls.pop(); for (const l of ls) waiter?.(l); });
  const send = (s) => sf.stdin.write(s + '\n');
  const until = (pred, on) => new Promise((res) => { waiter = (l) => { on?.(l); if (pred(l)) res(l); }; });
  send('uci'); await until((l) => l === 'uciok');
  send(`setoption name Threads value ${threads}`); send(`setoption name Hash value ${hash}`); send('isready'); await until((l) => l === 'readyok');
  let mpv = 0;
  async function analyse(fen, depth, multipv = 3) {
    if (mpv !== multipv) { send(`setoption name MultiPV value ${multipv}`); mpv = multipv; send('isready'); await until((l) => l === 'readyok'); }
    const lines = new Map();
    const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
    send(`position fen ${fen}`); send(`go depth ${depth}`);
    await until((l) => l.startsWith('bestmove'), (l) => {
      if (!l.startsWith('info ') || !l.includes(' pv ') || l.includes('bound')) return;
      const x = l.split(' '); const d = +x[x.indexOf('depth') + 1]; if (d !== depth) return;
      const mp = +x[x.indexOf('multipv') + 1]; const si = x.indexOf('score'); const kind = x[si + 1], v = +x[si + 2];
      const score = kind === 'mate' ? { cp: v * sign > 0 ? 100000 - v * sign * 100 : -100000 - v * sign * 100, mate: v * sign } : { cp: v * sign, mate: null };
      lines.set(mp, { score, pv: x.slice(x.indexOf('pv') + 1), depth: d });
    });
    return { lines: [...lines.keys()].sort((a, b) => a - b).map((k) => lines.get(k)), depth };
  }
  return { analyse, quit: () => send('quit') };
}
