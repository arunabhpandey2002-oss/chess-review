// Background batch analysis: a persistent queue of recent games, analysed in two passes (screen every position,
// then verify the critical ones deeper), saved locally. Survives refresh: cached positions are never re-analysed.
import { Chess, type Color } from 'chess.js';
import type { GameSummary } from './api';
import { resultFor } from './api';
import { EnginePool, type PosEval } from './engine';
import { parseGame, reviewGame, terminalEval, type Ply, type Book } from './review';
import { winPct } from './classify';
import type { Level } from './moments';
import { cacheKey } from './evalschema';
import { getCached, putCached, pruneCache } from './evalcache';
import { coachFor, saveReview } from './persist';
import * as store from './store';
import type { Puzzle, StoredReview } from './store';

export type Mode = 'light' | 'standard' | 'deep';
export const MODES: Record<Mode, { label: string; screen: number; verify: number; workers: number; secPerPos: number }> = {
  light: { label: 'Light', screen: 10, verify: 16, workers: 1, secPerPos: 0.25 },
  standard: { label: 'Standard', screen: 12, verify: 18, workers: 2, secPerPos: 0.4 },
  deep: { label: 'Deep', screen: 14, verify: 22, workers: 3, secPerPos: 0.9 },
};
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';
export type Stage = 'waiting' | 'validating' | 'screening' | 'verifying' | 'lessons' | 'saving' | 'complete';
export const STAGE_LABEL: Record<Stage, string> = { waiting: 'Waiting', validating: 'Checking the game', screening: 'Pass 1: every position', verifying: 'Pass 2: critical positions, deeper', lessons: 'Writing lessons', saving: 'Saving', complete: 'Complete' };
export interface Job {
  id: string; batchId: string; profileKey: string; gameId: string; game: GameSummary; myColor: Color; priority: number;
  status: JobStatus; stage: Stage; posDone: number; posTotal: number; error?: string; tries?: number;
  result?: { moments: number; verified: number; stable: number; ms: number; positions: number; cached: number; accuracy: number | null };
  createdAt: number; updatedAt: number;
}
export interface BatchMeta { key: 'batch'; batchId: string; profileKey: string; mode: Mode; level: Level; rating: number | null; paused: boolean; cancelled?: boolean; createdAt: number; finishedAt?: number }

export { cacheKey };
export const BATCH_LOCK = 'rook-ie-mistakes-batch';

/** Higher runs first: losses, then draws, then wins; very short or aborted games last. */
export function priorityOf(g: GameSummary, user: string): number {
  const res = resultFor(g, user);
  const moves = (g.pgn.match(/\s\d+\.\s/g)?.length ?? 0);
  const base = res === 'loss' ? 400 : res === 'draw' ? 300 : 200;
  if (moves < 10 || /abandon/.test(g.white.result + g.black.result)) return base - 1000 + moves;
  return base + Math.min(moves, 99) / 100;
}
const moveKey = (pgn: string) => { try { const c = new Chess(); c.loadPgn(pgn); return c.history().join(' '); } catch { return pgn; } };

/** Picks the games for a batch: newest first, drops duplicates and already-reviewed games, then orders by priority. */
export function planBatch(games: GameSummary[], user: string, reviewed: Set<string>, n: number, since?: number): { pick: GameSummary[]; skipped: { id: string; why: string }[] } {
  const seen = new Set<string>(), seenMoves = new Set<string>();
  const skipped: { id: string; why: string }[] = [];
  const pick: GameSummary[] = [];
  for (const g of games.slice().sort((a, b) => b.endTime - a.endTime)) {
    if (since && g.endTime <= since) continue;
    if (pick.length >= n) break;
    if (seen.has(g.id)) { skipped.push({ id: g.id, why: 'duplicate' }); continue; }
    seen.add(g.id);
    const mk = moveKey(g.pgn);
    if (seenMoves.has(mk)) { skipped.push({ id: g.id, why: 'same moves as another game' }); continue; }
    seenMoves.add(mk);
    if (reviewed.has(g.id)) { skipped.push({ id: g.id, why: 'already reviewed' }); continue; }
    if (!completed(g)) { skipped.push({ id: g.id, why: 'not a finished game' }); continue; }
    pick.push(g);
  }
  return { pick: pick.sort((a, b) => priorityOf(b, user) - priorityOf(a, user)), skipped };
}
/** Only finished games are analysed (never a game in progress). */
export function completed(g: GameSummary): boolean {
  if (!g.endTime || !g.pgn) return false;
  const r = /\[Result "([^"]*)"\]/.exec(g.pgn)?.[1];
  return r === '1-0' || r === '0-1' || r === '1/2-1/2';
}

/** My moves worth verifying: those that lost at least 8% in the screen pass, biggest first, at most 10. */
export function criticalPlies(plies: Ply[], evals: (PosEval | null)[], me: Color): number[] {
  const out: { i: number; loss: number }[] = [];
  plies.forEach((p, i) => {
    if (p.color !== me) return;
    const b = evals[i]?.lines[0]?.score, a = evals[i + 1]?.lines[0]?.score ?? (evals[i + 1]?.terminal === 'checkmate' ? { cp: me === 'w' ? 100000 : -100000, mate: 0 } : null);
    if (!b || !a) return;
    const loss = winPct(b, me) - winPct(a, me);
    if (loss >= 8) out.push({ i, loss });
  });
  return out.sort((x, y) => y.loss - x.loss).slice(0, 10).map((x) => x.i).sort((x, y) => x - y);
}

export function estimateSeconds(games: GameSummary[], mode: Mode, workers: number): number {
  const pos = games.reduce((s, g) => s + Math.max(20, (g.pgn.match(/\s\d+\.\s/g)?.length ?? 40) * 2), 0);
  return Math.round((pos * MODES[mode].secPerPos) / Math.max(1, workers) + games.length * 10 * MODES[mode].secPerPos * 3);
}

export function workersFor(mode: Mode): number {
  const cores = navigator.hardwareConcurrency || 2;
  const phone = matchMedia('(pointer: coarse)').matches || cores <= 4;
  return phone ? 1 : Math.max(1, Math.min(MODES[mode].workers, cores - 1));
}

type Listener = () => void;
class Runner {
  meta: BatchMeta | null = null;
  jobs: Job[] = [];
  running = false;
  pool: EnginePool | null = null;
  gen = 0;
  listeners = new Set<Listener>();
  book: Book | null = null;
  lastSave = 0;
  held = false;
  /** True while another tab of this browser holds the batch lock. */
  elsewhere = false;
  private release: (() => void) | null = null;
  private watching = false;
  private pk = '';

  /** Gives the engine to a full game review on screen; the batch continues afterwards. */
  async hold(on: boolean) {
    if (on === this.held) return;
    this.held = on;
    if (on) { if (this.running) await this.stop(true); }
    else if (this.meta && !this.meta.paused && !this.meta.cancelled && this.jobs.some((j) => j.status === 'queued')) void this.run();
    this.emit();
  }

  /** One batch per browser: whoever holds the Web Lock runs it; other tabs show a note and take over when it is free. */
  private acquire(): Promise<boolean> {
    const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : undefined;
    if (!locks) return Promise.resolve(true);
    if (this.release) return Promise.resolve(true);
    return new Promise<boolean>((res) => {
      locks.request(BATCH_LOCK, { ifAvailable: true }, (lock: unknown) => {
        if (!lock) { res(false); return undefined; }
        return new Promise<void>((done) => { this.release = () => { this.release = null; done(); }; res(true); });
      }).catch(() => res(true));
    });
  }
  private unlock() { this.release?.(); }
  private async heldElsewhere(): Promise<boolean> {
    const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : undefined;
    if (!locks?.query || this.release) return false;
    try { const q = await locks.query(); return (q.held ?? []).some((l: { name: string }) => l.name === BATCH_LOCK); } catch { return false; }
  }
  /** Waits for the other tab to finish or close, then reloads the queue and carries on with anything left. */
  private watch() {
    const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : undefined;
    if (!locks || this.watching) return;
    this.watching = true;
    locks.request(BATCH_LOCK, () => { this.watching = false; }).then(async () => {
      this.elsewhere = false;
      if (this.pk) await this.restore(this.pk, this.book);
      this.emit();
    }).catch(() => { this.watching = false; });
  }

  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const f of this.listeners) { try { f(); } catch { /* ignore */ } } (window as any).__batch = this.snapshot(); }
  snapshot() { return { meta: this.meta, running: this.running, held: this.held, elsewhere: this.elsewhere, jobs: this.jobs.map((j) => ({ id: j.gameId, status: j.status, stage: j.stage, posDone: j.posDone, posTotal: j.posTotal, result: j.result, error: j.error })) }; }

  async load(pk: string) {
    this.pk = pk;
    if (this.running && this.meta?.profileKey === pk) { this.emit(); return; }
    this.elsewhere = await this.heldElsewhere();
    if (this.elsewhere) this.watch();
    const m = (await store.get<BatchMeta>('meta', 'batch')) ?? null;
    this.meta = m && m.profileKey === pk ? m : null;
    this.jobs = this.meta ? (await store.byProfile<Job>('jobs', pk)).filter((j) => j.batchId === this.meta!.batchId).sort((a, b) => b.priority - a.priority) : [];
    this.emit();
  }

  /** On page load: jobs left mid-way go back to waiting and the batch resumes unless it was paused. */
  async restore(pk: string, book: Book | null) {
    this.book = book;
    if (this.running) return;
    await this.load(pk);
    if (!this.meta || this.meta.paused || this.meta.cancelled || this.elsewhere) return;
    if (this.jobs.some((j) => j.status === 'queued' || j.status === 'running')) void this.run();
  }

  async start(o: { pk: string; user: string; games: GameSummary[]; mode: Mode; level: Level; rating: number | null; book: Book | null }) {
    if (await this.heldElsewhere()) { this.elsewhere = true; this.watch(); this.emit(); return; }
    await this.stop();
    this.pk = o.pk;
    this.book = o.book;
    const batchId = `b${Date.now().toString(36)}`;
    this.meta = { key: 'batch', batchId, profileKey: o.pk, mode: o.mode, level: o.level, rating: o.rating, paused: false, createdAt: Date.now() };
    await store.put('meta', this.meta).catch(() => undefined); // storage full: the first job reports it and pauses
    // earlier batches' jobs are only history: drop them so the queue store does not grow with every batch
    for (const j of await store.byProfile<Job>('jobs', o.pk)) if (j.batchId !== batchId) await store.del('jobs', j.id).catch(() => undefined);
    const now = Date.now();
    this.jobs = o.games.map((g) => ({ id: `${o.pk}|${batchId}|${g.id}`, batchId, profileKey: o.pk, gameId: g.id, game: g, myColor: g.black.username.toLowerCase() === o.user.toLowerCase() ? 'b' : 'w',
      priority: priorityOf(g, o.user), status: 'queued', stage: 'waiting', posDone: 0, posTotal: 0, createdAt: now, updatedAt: now }));
    for (const j of this.jobs) await store.put('jobs', j).catch(() => undefined);
    this.emit();
    void this.run();
  }

  async pause() {
    if (!this.meta) return;
    this.meta.paused = true; await store.put('meta', this.meta).catch(() => undefined);
    await this.stop(true);
  }
  async resume() {
    if (!this.meta) return;
    this.meta.paused = false; await store.put('meta', this.meta).catch(() => undefined);
    void this.run();
  }
  async cancel() {
    if (!this.meta) return;
    this.meta.cancelled = true; this.meta.finishedAt = Date.now(); await store.put('meta', this.meta).catch(() => undefined);
    await this.stop(true);
    for (const j of this.jobs) if (j.status === 'queued') { j.status = 'cancelled'; await store.put('jobs', j).catch(() => undefined); }
    this.emit();
  }
  /** Stops the engine; a job in progress goes back to waiting (its cached positions are kept). */
  async stop(requeue = false) {
    this.gen++;
    this.pool?.destroy(); this.pool = null;
    if (requeue) for (const j of this.jobs) if (j.status === 'running') { j.status = 'queued'; j.stage = 'waiting'; await store.put('jobs', j).catch(() => undefined); }
    this.running = false;
    this.unlock();
    this.emit();
  }

  async run() {
    if (this.running || !this.meta || this.held) return;
    this.running = true;
    const g = ++this.gen;
    if (!(await this.acquire())) { this.running = false; this.elsewhere = true; this.watch(); this.emit(); return; }
    if (g !== this.gen) { this.running = false; this.unlock(); return; }
    this.elsewhere = false;
    // with the lock held, the stored queue is the truth: pick up progress another tab saved, and requeue its unfinished job
    if (this.meta) {
      const stored = (await store.byProfile<Job>('jobs', this.meta.profileKey)).filter((j) => j.batchId === this.meta!.batchId);
      const byId = new Map(stored.map((j) => [j.id, j]));
      this.jobs = this.jobs.map((j) => byId.get(j.id) ?? j);
      for (const j of this.jobs) if (j.status === 'running') { j.status = 'queued'; j.stage = 'waiting'; await store.put('jobs', j).catch(() => undefined); }
      const m = await store.get<BatchMeta>('meta', 'batch');
      if (m && m.batchId === this.meta.batchId) this.meta = m;
    }
    this.emit();
    while (g === this.gen && this.meta && !this.meta.paused && !this.meta.cancelled && !this.held) {
      const job = this.jobs.find((j) => j.status === 'queued');
      if (!job) break;
      try { await this.runJob(job, g); } catch (e) {
        if (g !== this.gen) break;
        if ((e as DOMException)?.name === 'QuotaExceededError') {
          // browser storage is full: stop here (rather than failing every remaining game) and say why
          job.status = 'failed'; job.error = STORAGE_FULL;
          if (this.meta) { this.meta.paused = true; await store.put('meta', this.meta).catch(() => undefined); }
          this.emit();
          break;
        }
        job.tries = (job.tries ?? 0) + 1;
        job.status = job.tries >= 2 ? 'failed' : 'queued';
        job.error = String((e as Error)?.message ?? e).slice(0, 200);
        await store.put('jobs', job).catch(() => undefined); // e.g. storage full: keep going so the pool is still cleaned up
      }
      this.emit();
    }
    if (g === this.gen) {
      this.running = false;
      this.pool?.destroy(); this.pool = null;
      void pruneCache();
      if (this.meta && !this.jobs.some((j) => j.status === 'queued' || j.status === 'running') && !this.meta.finishedAt) { this.meta.finishedAt = Date.now(); await store.put('meta', this.meta).catch(() => undefined); }
      this.unlock();
      this.emit();
    }
  }

  async touch(job: Job, force = false) {
    job.updatedAt = Date.now();
    if (force || job.updatedAt - this.lastSave > 1500) {
      this.lastSave = job.updatedAt;
      const w = store.put('jobs', job);
      if (force) await w; else w.catch(() => undefined); // progress ticks never throw; a forced save reports a full disk
    }
    this.emit();
  }

  async evalAt(fen: string, depth: number, mpv: number, g: number, counts: { cached: number }): Promise<PosEval | null> {
    const t = terminalEval(fen);
    if (t) return t;
    const hit = await getCached(fen, depth, mpv);
    if (hit) { counts.cached++; return hit; }
    if (g !== this.gen || !this.pool) throw new Error('stopped');
    const ev = await this.pool.analyse(fen, depth, mpv, depth >= 20 ? 15000 : 8000);
    return putCached(fen, depth, mpv, ev);
  }

  async runJob(job: Job, g: number) {
    const meta = this.meta!;
    const M = MODES[meta.mode];
    const t0 = performance.now();
    job.status = 'running'; job.stage = 'validating'; job.error = undefined;
    await this.touch(job, true);
    if (!completed(job.game)) { job.status = 'skipped'; job.error = 'Not a finished game'; await this.touch(job, true); return; }
    const reviewed = await store.get<StoredReview>('reviews', `${job.profileKey}|${job.gameId}`);
    if (reviewed && !reviewed.analysis?.mode?.match(/light|standard|deep/)) { job.status = 'skipped'; job.error = 'Already reviewed'; await this.touch(job, true); return; }
    const { plies } = parseGame(job.game.pgn);
    if (plies.length < 4) { job.status = 'skipped'; job.error = 'Too short to analyse'; await this.touch(job, true); return; }
    const fens = [plies[0].fenBefore, ...plies.map((p) => p.fenAfter)];
    if (!this.pool) this.pool = new EnginePool(workersFor(meta.mode));
    const counts = { cached: 0 };
    // pass 1: every position
    job.stage = 'screening'; job.posTotal = fens.length; job.posDone = 0;
    await this.touch(job, true);
    const screen: (PosEval | null)[] = await Promise.all(fens.map(async (f) => {
      const ev = await this.evalAt(f, M.screen, 2, g, counts);
      job.posDone++; void this.touch(job);
      return ev;
    }));
    if (g !== this.gen) throw new Error('stopped');
    // pass 2: critical positions and the positions after them, deeper
    job.stage = 'verifying';
    const crit = criticalPlies(plies, screen, job.myColor);
    const idx = [...new Set(crit.flatMap((i) => [i, i + 1]))];
    job.posTotal = fens.length + idx.length;
    await this.touch(job, true);
    const evals = screen.slice();
    await Promise.all(idx.map(async (i) => {
      const ev = await this.evalAt(fens[i], M.verify, 3, g, counts);
      if (ev) evals[i] = ev;
      job.posDone++; void this.touch(job);
    }));
    if (g !== this.gen) throw new Error('stopped');
    job.stage = 'lessons'; await this.touch(job, true);
    const reviews = reviewGame({ plies, evals, book: this.book });
    // only verified positions may become lessons
    const { moments: all, summary } = coachFor(job.game, job.myColor, plies, evals, reviews, meta.level);
    const verifiedSet = new Set(crit);
    const moments = all.filter((m) => verifiedSet.has(m.ply));
    const verify = new Map<number, Puzzle['verify']>();
    let stable = 0;
    for (const m of moments) {
      const same = (screen[m.ply]?.lines[0]?.pv[0] ?? null) === (evals[m.ply]?.lines[0]?.pv[0] ?? null);
      if (same) stable++;
      verify.set(m.ply, { depth: M.verify, sameBest: same });
    }
    job.stage = 'saving'; await this.touch(job, true);
    const ms = Math.round(performance.now() - t0);
    const saved = await saveReview(job.profileKey, job.game, job.myColor, plies, evals, reviews, moments, summary, meta.rating, { analysis: { mode: meta.mode, depth: M.verify, screenDepth: M.screen, verified: idx.length, stable, ms }, verify });
    const rv = await store.get<StoredReview>('reviews', `${job.profileKey}|${job.gameId}`);
    job.result = { moments: saved.size, verified: idx.length, stable, ms, positions: fens.length, cached: counts.cached, accuracy: rv?.accuracy ?? null };
    job.status = 'done'; job.stage = 'complete';
    await this.touch(job, true);
  }
}

export const STORAGE_FULL = 'Browser storage is full. Export a backup and delete old data in Your data, then resume.';
export const batch = new Runner();
if (typeof window !== "undefined") (window as any).__batchRunner = batch;
