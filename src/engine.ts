// Stockfish (WASM, lite single-threaded) worker pool.
// Each worker analyses one position at a time with MultiPV.

export interface Score {
  /** White-POV centipawns. Mates are encoded as +/-(100000 - plies*100) so they sort correctly. */
  cp: number;
  /** White-POV mate distance in moves (positive = White mates). 0 means the side to move is already mated. */
  mate: number | null;
}

export interface Line {
  score: Score;
  pv: string[]; // UCI moves
  depth: number;
}

export interface PosEval {
  lines: Line[]; // sorted by MultiPV rank (best first)
  depth: number;
  terminal?: 'checkmate' | 'stalemate' | 'draw';
}

export const MATE_BASE = 100000;

export function mateToCp(mateWhitePov: number): number {
  // mate in n for White (n>0) => large positive; for Black (n<0) => large negative
  if (mateWhitePov > 0) return MATE_BASE - mateWhitePov * 100;
  if (mateWhitePov < 0) return -MATE_BASE - mateWhitePov * 100;
  return 0;
}

interface Job {
  fen: string;
  depth: number;
  movetime: number;
  multipv: number;
  resolve: (e: PosEval) => void;
  reject: (e: unknown) => void;
}

const engineUrl = () => `${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`;

class EngineWorker {
  private w: Worker;
  private ready: Promise<void>;
  private job: Job | null = null;
  private lines = new Map<number, Line>();
  private onLine: ((l: string) => void) | null = null;
  busy = false;

  constructor() {
    this.w = new Worker(engineUrl());
    this.w.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
      for (const l of text.split('\n')) if (l && this.onLine) this.onLine(l);
    };
    this.ready = new Promise((res) => {
      this.onLine = (l) => {
        if (l === 'uciok') {
          this.send('setoption name Hash value 32');
          this.send('isready');
        } else if (l === 'readyok') {
          this.onLine = (x) => this.handle(x);
          res();
        }
      };
      this.send('uci');
    });
  }

  private send(cmd: string) {
    this.w.postMessage(cmd);
  }

  async run(job: Job) {
    this.busy = true;
    await this.ready;
    this.job = job;
    this.lines.clear();
    this.send(`setoption name MultiPV value ${job.multipv}`);
    this.send(`position fen ${job.fen}`);
    this.send(`go depth ${job.depth} movetime ${job.movetime}`);
  }

  private handle(l: string) {
    const job = this.job;
    if (!job) return;
    if (l.startsWith('info ') && l.includes(' pv ') && l.includes(' score ')) {
      if (l.includes(' lowerbound') || l.includes(' upperbound')) return;
      const t = l.split(' ');
      const depth = +t[t.indexOf('depth') + 1];
      const mpIdx = t.indexOf('multipv');
      const mp = mpIdx >= 0 ? +t[mpIdx + 1] : 1;
      const si = t.indexOf('score');
      const kind = t[si + 1];
      const val = +t[si + 2];
      const pv = t.slice(t.indexOf('pv') + 1);
      const whiteToMove = job.fen.split(' ')[1] === 'w';
      const sign = whiteToMove ? 1 : -1;
      let score: Score;
      if (kind === 'mate') {
        const m = val * sign;
        score = { cp: mateToCp(m === 0 ? (whiteToMove ? -0.0001 : 0.0001) : m), mate: m };
      } else {
        score = { cp: val * sign, mate: null };
      }
      this.lines.set(mp, { score, pv, depth });
    } else if (l.startsWith('bestmove')) {
      const best = l.split(' ')[1];
      const ranks = [...this.lines.keys()].sort((a, b) => a - b);
      let lines = ranks.map((k) => this.lines.get(k)!);
      // Guarantee line 1 matches the engine's final bestmove.
      if (best && best !== '(none)' && lines.length && lines[0].pv[0] !== best) {
        const idx = lines.findIndex((x) => x.pv[0] === best);
        if (idx > 0) lines = [lines[idx], ...lines.filter((_, i) => i !== idx)];
      }
      // Drop duplicate first moves (can happen when a depth is interrupted).
      const seen = new Set<string>();
      lines = lines.filter((x) => (seen.has(x.pv[0]) ? false : (seen.add(x.pv[0]), true)));
      const depth = lines.length ? lines[0].depth : 0;
      this.job = null;
      this.busy = false;
      job.resolve({ lines, depth });
    }
  }

  terminate() {
    this.w.terminate();
    if (this.job) this.job.reject(new Error('terminated'));
    this.job = null;
  }
}

export class EnginePool {
  private workers: EngineWorker[] = [];
  private queue: Job[] = [];

  constructor(size: number) {
    for (let i = 0; i < size; i++) this.workers.push(new EngineWorker());
  }

  static defaultSize(): number {
    const hc = navigator.hardwareConcurrency || 2;
    return Math.max(1, Math.min(4, hc - 1));
  }

  get size() {
    return this.workers.length;
  }

  analyse(fen: string, depth: number, multipv = 3, movetime = 8000): Promise<PosEval> {
    return new Promise((resolve, reject) => {
      this.queue.push({ fen, depth, movetime, multipv, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    for (const w of this.workers) {
      if (!w.busy && this.queue.length) {
        const job = this.queue.shift()!;
        const orig = job.resolve;
        job.resolve = (e) => {
          orig(e);
          this.pump();
        };
        w.run(job);
      }
    }
  }

  destroy() {
    for (const j of this.queue) j.reject(new Error('cancelled'));
    this.queue = [];
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
