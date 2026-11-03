// "Defend against it": you take the other side of an opening; the app plays the opening side's moves from its line
// (the same move for a position in every variation of the family), then the most-played moves from the bundled
// sample, then Stockfish. Any legal move is allowed. After 12 full moves every one of your moves is checked:
// your move vs the book move (most played and Stockfish-sound) or the engine's choice. Pure functions here.
import { Chess } from 'chess.js';
import type { RepEntry, RepFamily } from './repertoire';
import { variationsOf } from './repertoire';
import type { ExplorerView } from './openings';
import { winPctFromCp, moveAccuracy } from './classify';
import type { SrsState } from './srs';
import { srsStatus } from './srs';

/** A round is 12 full moves. */
export const ROUND_PLIES = 24;
/** Centipawn loss limits for the verdicts (your move vs the engine's best, from your side). */
export const LOSS = { good: 50, inaccuracy: 100, mistake: 200 } as const;
/** A popular move counts as a sound book move when it is within this many centipawns of the engine's best. */
export const BOOK_SOUND = 30;
/** A move counts as "book" here when it is at least this common in the sample. */
export const BOOK_SHARE = 0.05, BOOK_GAMES = 10;
/** The app only plays sample moves at least this common (so it plays real opening moves, not one-off tries). */
export const APP_SHARE = 0.08, APP_GAMES = 10;

export type Verdict = 'book' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';
export const VERDICT_LABEL: Record<Verdict, string> = { book: 'Book', good: 'Good', inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' };

const posKey = (fen: string) => fen.split(' ').slice(0, 3).join(' ');
/** Centipawns clamped to ±1000 (mates count as 1000) so a decided position can't produce a silly loss. */
export const clampCp = (cp: number) => Math.max(-1000, Math.min(1000, cp));

/** Verdict from centipawn loss; a sound, common move is "book" whatever the engine's exact preference. */
export function classifyLoss(lossCp: number, isBook = false): Verdict {
  const l = Math.max(0, lossCp);
  if (isBook && l <= LOSS.good) return 'book';
  if (l <= LOSS.good) return 'good';
  if (l <= LOSS.inaccuracy) return 'inaccuracy';
  if (l <= LOSS.mistake) return 'mistake';
  return 'blunder';
}

/** The opening side's move for each position: the chosen variation first, then every variation of its family. */
export function lineMoves(e: RepEntry, fam: RepFamily | null): Map<string, { uci: string; entry: string }> {
  const m = new Map<string, { uci: string; entry: string }>();
  const add = (x: RepEntry) => { for (const p of x.plies) if (p.mine && !m.has(posKey(p.fen))) m.set(posKey(p.fen), { uci: p.uci, entry: x.id }); };
  add(e);
  if (fam) for (const v of variationsOf(fam)) add(v);
  return m;
}

/** The defender's line move for a position (the opponent plies in the variations), most common variation's choice first. */
export function lineReplies(e: RepEntry, fam: RepFamily | null): Map<string, string> {
  const m = new Map<string, string>();
  const add = (x: RepEntry) => { for (const p of x.plies) if (!p.mine && !m.has(posKey(p.fen))) m.set(posKey(p.fen), p.uci); };
  add(e);
  if (fam) for (const v of [...variationsOf(fam)].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))) add(v);
  return m;
}

export interface AppPick { uci: string; src: 'line' | 'book' }
/** The app's move: the line's move when the position is on the line, else a sample move weighted by how often it is
 *  played (common moves only), else null (ask the engine). */
export function pickAppMove(fen: string, line: Map<string, { uci: string }>, view: ExplorerView | null, rand: () => number = Math.random): AppPick | null {
  const legal = new Set(new Chess(fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? '')));
  const l = line.get(posKey(fen));
  if (l && legal.has(l.uci)) return { uci: l.uci, src: 'line' };
  const c = (view?.moves ?? []).filter((m) => legal.has(m.uci) && m.games >= APP_GAMES && m.share >= APP_SHARE);
  if (!c.length) return null;
  let x = rand() * c.reduce((a, m) => a + m.games, 0);
  for (const m of c) { x -= m.games; if (x < 0) return { uci: m.uci, src: 'book' }; }
  return { uci: c[c.length - 1].uci, src: 'book' };
}

/** Book candidates for your move: the line's reply first, then common sample moves, most played first. */
export function bookCandidates(fen: string, lineUci: string | undefined, view: ExplorerView | null): { uci: string; share: number; line: boolean }[] {
  const out: { uci: string; share: number; line: boolean }[] = [];
  const share = (u: string) => view?.moves.find((m) => m.uci === u)?.share ?? 0;
  const legal = new Set(new Chess(fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? '')));
  if (lineUci && legal.has(lineUci)) out.push({ uci: lineUci, share: share(lineUci), line: true });
  for (const m of view?.moves ?? []) if (m.games >= BOOK_GAMES && m.share >= BOOK_SHARE && !out.some((o) => o.uci === m.uci) && legal.has(m.uci)) out.push({ uci: m.uci, share: m.share, line: false });
  return out.slice(0, 4);
}

export const sanOf = (fen: string, uci: string) => { try { return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { return uci; } };
/** Eval in pawns from your side: "+0.4", "−0.6", "mate". */
export function fmtEval(cp: number): string {
  if (cp >= 50000) return 'winning (mate)';
  if (cp <= -50000) return 'losing (mate)';
  const p = Math.round(cp / 10) / 10;
  return `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(1)}`;
}

export interface MoveCheck {
  ply: number; fen: string; uci: string; san: string;
  /** Your-side evals: engine's best move, your move. */
  bestUci: string; bestCp: number; playedCp: number;
  /** Book candidates with their your-side evals. */
  book: { uci: string; share: number; line: boolean; cp: number }[];
}
export interface ReviewRow {
  ply: number; label: string; fen: string; uci: string; san: string;
  verdict: Verdict; lossCp: number; beforeCp: number; afterCp: number;
  /** The move you should have played: the sound book move if there is one, else the engine's best. */
  recUci: string; recSan: string; recKind: 'book' | 'engine';
  same: boolean; reason: string; accuracy: number; bookShare: number | null;
}

const moveLabel = (i: number, san: string) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : `${(i + 1) / 2}... ${san}`);
const pct = (s: number) => (s < 0.01 ? '<1%' : `${Math.round(s * 100)}%`);

/** One row of the review from the engine numbers. */
export function reviewRow(m: MoveCheck): ReviewRow {
  const best = clampCp(m.bestCp), played = clampCp(m.playedCp);
  const lossCp = Math.max(0, best - played);
  const sound = m.book.filter((b) => clampCp(best) - clampCp(b.cp) <= BOOK_SOUND);
  const mineBook = m.book.find((b) => b.uci === m.uci);
  const isBook = !!mineBook && lossCp <= LOSS.good;
  const verdict = classifyLoss(lossCp, isBook);
  const rec = isBook ? { uci: m.uci, kind: 'book' as const } : sound.length ? { uci: sound[0].uci, kind: 'book' as const } : { uci: m.bestUci, kind: 'engine' as const };
  const recSan = sanOf(m.fen, rec.uci), bestSan = sanOf(m.fen, m.bestUci);
  const same = rec.uci === m.uci;
  let reason: string;
  if (verdict === 'book') {
    const top = sound[0] && sound[0].uci !== m.uci ? ` The line here is ${sanOf(m.fen, sound[0].uci)}.` : '';
    reason = `Book move${mineBook!.share ? ` (${pct(mineBook!.share)} of games)` : mineBook!.line ? ' (this line)' : ''}.${top}`;
  } else if (Math.abs(best) >= 1000 && Math.abs(played) >= 1000 && Math.sign(best) === Math.sign(played) && verdict === 'good') {
    reason = `The position is already decided (${fmtEval(m.playedCp)}), so the grade is lenient. ${m.uci === m.bestUci ? 'Engine\'s top choice.' : `Engine prefers ${bestSan} (${fmtEval(m.bestCp)}).`}`;
  } else if (verdict === 'good') {
    reason = m.uci === m.bestUci ? `Engine's top choice (${fmtEval(m.playedCp)}).` : lossCp <= 10 ? `Fine — about as good as the engine's ${bestSan} (${fmtEval(m.bestCp)}).` : `Fine. Engine prefers ${bestSan} (${fmtEval(m.bestCp)}); yours keeps ${fmtEval(m.playedCp)}.`;
    if (sound.length && !same) reason += ` Book here: ${recSan}.`;
  } else {
    reason = `Engine prefers ${bestSan}, which keeps ${fmtEval(m.bestCp)}; yours drops to ${fmtEval(m.playedCp)}.`;
    if (rec.kind === 'book' && rec.uci !== m.bestUci) reason += ` Book here: ${recSan}.`;
    if (mineBook) reason += ' Common, but Stockfish doesn\'t trust it.';
  }
  const accuracy = moveAccuracy(winPctFromCp(best) - winPctFromCp(played));
  return { ply: m.ply, label: moveLabel(m.ply, m.san), fen: m.fen, uci: m.uci, san: m.san, verdict, lossCp, beforeCp: m.bestCp, afterCp: m.playedCp, recUci: rec.uci, recSan, recKind: rec.kind, same, reason, accuracy, bookShare: mineBook ? mineBook.share : null };
}

export interface ReviewSummary {
  accuracy: number; moves: number; book: number; good: number; inaccuracies: number; mistakes: number; blunders: number;
  /** Your first move that wasn't a book move. */
  leftBook: ReviewRow | null;
  worst: ReviewRow | null;
}
export function summarize(rows: ReviewRow[]): ReviewSummary {
  const n = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  const acc = rows.length ? rows.reduce((a, r) => a + r.accuracy, 0) / rows.length : 100;
  const bad = rows.filter((r) => r.verdict !== 'book' && r.verdict !== 'good');
  return {
    accuracy: Math.round(acc), moves: rows.length, book: n('book'), good: n('good'), inaccuracies: n('inaccuracy'), mistakes: n('mistake'), blunders: n('blunder'),
    leftBook: rows.find((r) => r.verdict !== 'book') ?? null,
    worst: bad.length ? bad.reduce((a, b) => (b.lossCp > a.lossCp ? b : a)) : null,
  };
}

/** Spaced-repetition result for a round: clean = no mistakes or blunders; inaccuracies and hints lower the quality. */
export function roundResult(s: ReviewSummary, hints: number) {
  const solved = s.mistakes + s.blunders === 0;
  return { solved, attempts: 1 + s.mistakes + s.blunders + (s.inaccuracies >= 2 ? 1 : 0), hints: Math.min(4, hints), revealed: false };
}

/** The deepest variation of the family whose identifying moves you reached (for saving progress), else null. */
export function reachedVariation(sans: string[], vs: RepEntry[]): RepEntry | null {
  let pick: RepEntry | null = null;
  for (const v of vs) {
    const id = v.plies.slice(0, v.idPlies).map((p) => p.san);
    if (id.every((s, i) => sans[i] === s) && (!pick || v.idPlies > pick.idPlies)) pick = v;
  }
  return pick;
}

// ---------------- random opening (you're Black; White picks an opening you don't see until the review) ----------------

/** How much more often an opening comes up in Random mode, by your Random-mode record with it. */
export const RANDOM_BOOST = { due: 4, new: 1.5, learning: 1, scheduled: 0.5, mastered: 0.2 } as const;

/** Pick weight: popularity (square root of sample games, so the very common openings don't drown out the rest) times
 *  a boost for openings you got wrong (due again) or haven't seen. */
export function randomWeight(e: RepEntry, srs: SrsState | undefined, now: number): number {
  const pop = Math.sqrt(Math.max(1, e.count ?? 1));
  const st = srs ? srsStatus(srs, now) : 'new';
  return pop * RANDOM_BOOST[st];
}

/** White's opening for a Random round: weighted by popularity and your record; never the one you just played. */
export function pickRandomOpening(pool: RepEntry[], srsOf: (id: string) => SrsState | undefined, now: number, rand: () => number = Math.random, exclude?: string): RepEntry | null {
  const c = pool.length > 1 ? pool.filter((e) => e.id !== exclude) : pool;
  if (!c.length) return null;
  const w = c.map((e) => randomWeight(e, srsOf(e.id), now));
  let x = rand() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < c.length; i++) { x -= w[i]; if (x < 0) return c[i]; }
  return c[c.length - 1];
}

/** One side's moves of a single variation, keyed by position (for the app to play exactly that variation). */
export function sideMoves(e: RepEntry, mine: boolean): Map<string, { uci: string; entry: string }> {
  const m = new Map<string, { uci: string; entry: string }>();
  for (const p of e.plies) if (p.mine === mine && !m.has(posKey(p.fen))) m.set(posKey(p.fen), { uci: p.uci, entry: e.id });
  return m;
}

/** Where the game left the book line: the first ply that differs (or null if the game followed the whole line, as
 *  far as it went), and whether that ply was yours. */
export function leftLine(sans: string[], e: RepEntry, me: 'w' | 'b'): { ply: number; byYou: boolean; played: string; book: string } | null {
  const n = Math.min(sans.length, e.plies.length);
  for (let i = 0; i < n; i++) if (sans[i] !== e.plies[i].san) return { ply: i, byYou: (i % 2 === 0 ? 'w' : 'b') === me, played: sans[i], book: e.plies[i].san };
  return null;
}

/** Spaced-repetition result for a Random round: it counts as solved only if you kept to the whole book line and made
 *  no mistakes; leaving the line early adds a miss, so the opening comes back sooner. */
export function randomResult(s: ReviewSummary, hints: number, left: ReturnType<typeof leftLine>) {
  const r = roundResult(s, hints);
  const offBook = !!left && left.byYou;
  return { ...r, solved: r.solved && !offBook, attempts: r.attempts + (offBook ? 1 : 0) };
}

/** Moves that follow the variation the game actually reached count as book, even when that variation isn't the most
 *  played choice in the sample (e.g. 2...c6 in the Czech-Indian), as long as Stockfish is fine with them. */
export function markLineBook(rows: ReviewRow[], sans: string[], e: RepEntry): ReviewRow[] {
  const dev = sans.findIndex((s, i) => i >= e.plies.length || s !== e.plies[i].san);
  const onLine = (ply: number) => ply < e.plies.length && (dev < 0 || ply < dev);
  return rows.map((r) => (r.verdict !== 'book' && onLine(r.ply) && r.lossCp <= LOSS.good
    ? { ...r, verdict: 'book' as const, reason: `Book move (the ${e.name} line).`, recUci: r.uci, recSan: r.san, recKind: 'book' as const, same: true }
    : r));
}
