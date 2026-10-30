// Local-first storage: everything lives in this browser's IndexedDB. Nothing is uploaded.
import type { Diagnosis } from './diagnose';
import type { GameSummary, Platform } from './api';
import type { MomentCore } from './explain';
import type { SrsState } from './srs';
import type { Level } from './moments';
import type { Phase } from './concepts';
import { MOTIF_INFO, SKILL_LABEL } from './concepts';
import { safeUrl } from './safe';

export const DB_NAME = 'chess-review';
const DB_VERSION = 2;
export const STORES = ['profiles', 'games', 'reviews', 'puzzles', 'evalcache', 'jobs', 'meta', 'replays', 'workspace', 'reports'] as const;
type StoreName = (typeof STORES)[number];

export interface Profile { key: string; platform: Platform | 'chesscom'; username: string; level?: Level; createdAt: number; updatedAt: number }
export interface StoredGame { key: string; profileKey: string; game: GameSummary; myColor?: 'w' | 'b'; savedAt: number }
export interface StoredReview {
  key: string; // profileKey|gameId
  profileKey: string;
  gameId: string;
  platform: string;
  url: string;
  white: string; black: string; myColor: 'w' | 'b';
  result: 'win' | 'loss' | 'draw';
  opening: string;
  endTime: number;
  accuracy: number | null;
  /** Distinct tag ids of the player's real mistakes in this game (for recurring-error stats). */
  errorTags: string[];
  moments: { ply: number; tag: string; moveNumber: number }[];
  /** How this review was made: a full analysis on the review page, or a batch (screened, critical positions verified deeper). */
  analysis?: { mode: 'full' | 'light' | 'standard' | 'deep'; depth: number; screenDepth?: number; verified?: number; stable?: number; ms?: number };
  story: string;
  reviewedAt: number;
}
export interface Puzzle {
  id: string; // profileKey|gameId|ply
  profileKey: string;
  gameId: string;
  gameUrl: string;
  platform: string;
  white: string; black: string;
  endTime: number;
  phase: Phase;
  core: MomentCore;
  srs: SrsState;
  createdAt: number;
  /** Your rating in that game (sets the play-it-out engine strength). */
  rating?: number | null;
  /** Your answer to "what were you thinking" and what the board showed. */
  diagnosis?: Diagnosis;
  /** Where the puzzle came from: a reviewed game (default), the analysis workspace, or a played-out replay. */
  source?: 'game' | 'workspace' | 'replay';
  /** Verification: depth the critical position was checked at, and whether the best move held. */
  verify?: { depth: number; sameBest: boolean | null } | null;
}

/** A played-out continuation from a lesson ("Play it out"), saved with every attempt including taken-back moves. */
export interface StoredReplay {
  id: string;
  profileKey: string;
  /** The puzzle / moment this replay started from. */
  sourceId: string;
  startFen: string;
  myColor: 'w' | 'b';
  /** Main replay line and the original game continuation, as UCI from startFen. */
  line: string[];
  original: string[];
  /** Variation tree with take-back branches (serialised tree.ts). */
  tree: unknown;
  outcome: string;
  /** Per-ply evals of the replay line, once reviewed ("Review this game"). */
  evals?: ({ cp: number; mate: number | null } | null)[];
  reviewedAt?: number;
  createdAt: number;
}
export interface WorkspaceDoc { id: string; profileKey: string; title: string; startFen: string; tree: unknown; orientation: 'white' | 'black'; source?: string; updatedAt: number; createdAt: number }
export interface ExplanationReport { id: string; profileKey: string; puzzleId: string; kind: 'incorrect' | 'unclear' | 'too-advanced'; note: string; level: string; record: unknown; text: string; createdAt: number }

export const profileKey = (platform: string, user: string) => `${platform}:${user.toLowerCase()}`;

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('profiles')) d.createObjectStore('profiles', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('games')) d.createObjectStore('games', { keyPath: 'key' }).createIndex('profileKey', 'profileKey');
      if (!d.objectStoreNames.contains('reviews')) d.createObjectStore('reviews', { keyPath: 'key' }).createIndex('profileKey', 'profileKey');
      if (!d.objectStoreNames.contains('puzzles')) d.createObjectStore('puzzles', { keyPath: 'id' }).createIndex('profileKey', 'profileKey');
      // v2: background analysis, replays, analysis workspace, explanation reports
      if (!d.objectStoreNames.contains('evalcache')) d.createObjectStore('evalcache', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('jobs')) { const j = d.createObjectStore('jobs', { keyPath: 'id' }); j.createIndex('profileKey', 'profileKey'); j.createIndex('batchId', 'batchId'); }
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('replays')) d.createObjectStore('replays', { keyPath: 'id' }).createIndex('profileKey', 'profileKey');
      if (!d.objectStoreNames.contains('workspace')) d.createObjectStore('workspace', { keyPath: 'id' }).createIndex('profileKey', 'profileKey');
      if (!d.objectStoreNames.contains('reports')) d.createObjectStore('reports', { keyPath: 'id' }).createIndex('profileKey', 'profileKey');
    };
    r.onblocked = () => console.warn('database upgrade is waiting for another tab to close');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out: T | undefined;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const put = <T>(store: StoreName, v: T) => tx(store, 'readwrite', (s) => s.put(v)).then(() => undefined);
export const get = <T>(store: StoreName, key: string) => tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>);
export const del = (store: StoreName, key: string) => tx(store, 'readwrite', (s) => s.delete(key)).then(() => undefined);
export async function byProfile<T>(store: Exclude<StoreName, 'profiles' | 'evalcache' | 'meta'>, pk: string): Promise<T[]> {
  const d = await db();
  return req(d.transaction(store).objectStore(store).index('profileKey').getAll(pk) as IDBRequest<T[]>);
}
export async function all<T>(store: StoreName): Promise<T[]> {
  const d = await db();
  return req(d.transaction(store).objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function ensureProfile(platform: string, username: string): Promise<Profile> {
  const key = profileKey(platform, username);
  const now = Date.now();
  const p = (await get<Profile>('profiles', key)) ?? { key, platform: platform as Platform, username, createdAt: now, updatedAt: now };
  p.updatedAt = now;
  await put('profiles', p);
  return p;
}

/** Saves a puzzle, keeping existing SRS progress if this moment was saved before. */
export async function savePuzzle(p: Puzzle): Promise<Puzzle> {
  const old = await get<Puzzle>('puzzles', p.id);
  const merged = old ? { ...p, srs: old.srs, createdAt: old.createdAt, diagnosis: old.diagnosis ?? p.diagnosis } : p;
  await put('puzzles', merged);
  return merged;
}

// ---------------- export / import / delete ----------------
export interface Backup {
  app: 'chess-review'; version: 1 | 2; exportedAt: string; profiles: Profile[]; games: StoredGame[]; reviews: StoredReview[]; puzzles: Puzzle[];
  replays?: StoredReplay[]; workspace?: WorkspaceDoc[]; reports?: ExplanationReport[];
}

export async function exportAll(): Promise<Backup> {
  const [profiles, games, reviews, puzzles, replays, workspace, reports] = await Promise.all([all<Profile>('profiles'), all<StoredGame>('games'), all<StoredReview>('reviews'), all<Puzzle>('puzzles'),
    all<StoredReplay>('replays'), all<WorkspaceDoc>('workspace'), all<ExplanationReport>('reports')]);
  return { app: 'chess-review', version: 2, exportedAt: new Date().toISOString(), profiles, games, reviews, puzzles, replays, workspace, reports };
}

const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_RE = /^[\w.:|@+-]{1,200}$/;
const int = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
/** Removes HTML brackets from every string and drops keys that could reach an object prototype. */
function clean(v: unknown, depth = 0): unknown {
  if (depth > 40) return null;
  if (typeof v === 'string') return v.replace(/[<>]/g, '');
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
  if (obj(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!BAD_KEYS.has(k)) o[k] = clean(x, depth + 1);
    return o;
  }
  return typeof v === 'number' || typeof v === 'boolean' || v === null ? v : null;
}

/** Parses and checks a backup file. Anything that does not look like data this app wrote is dropped or reset. */
export function parseBackup(text: string): Backup {
  if (text.length > MAX_BACKUP_BYTES) throw new Error('That file is too large to be a rook-i.e. mistakes backup.');
  let raw: unknown;
  try { raw = JSON.parse(text, (k, v) => (BAD_KEYS.has(k) ? undefined : v)); } catch { throw new Error('That file is not valid JSON.'); }
  const x = clean(raw) as any;
  if (!obj(x) || x.app !== 'chess-review' || !Array.isArray(x.puzzles)) throw new Error('That file is not a rook-i.e. mistakes backup.');
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter(obj) : []);
  const side = (v: any) => ({ ...v, username: String(v?.username ?? ''), rating: int(v?.rating), result: String(v?.result ?? '') });
  const games = arr(x.games).filter((g) => typeof g.key === 'string' && obj(g.game) && ID_RE.test(String(g.game.id))).map((g) => ({
    ...g, profileKey: String(g.profileKey ?? ''), myColor: g.myColor === 'b' ? 'b' : g.myColor === 'w' ? 'w' : undefined, savedAt: num(g.savedAt),
    game: { ...g.game, id: String(g.game.id), url: safeUrl(g.game.url), pgn: String(g.game.pgn ?? ''), white: side(g.game.white), black: side(g.game.black), endTime: num(g.game.endTime), timeClass: String(g.game.timeClass ?? 'game'), timeControl: String(g.game.timeControl ?? '-'), opening: String(g.game.opening ?? ''), rated: !!g.game.rated },
  })) as StoredGame[];
  const reviews = arr(x.reviews).filter((r) => typeof r.key === 'string' && ID_RE.test(String(r.gameId))).map((r) => ({
    ...r, url: safeUrl(r.url), myColor: r.myColor === 'b' ? 'b' : 'w', result: oneOf(r.result, ['win', 'loss', 'draw'] as const, 'draw'), endTime: num(r.endTime),
    accuracy: r.accuracy == null ? null : num(r.accuracy), errorTags: Array.isArray(r.errorTags) ? r.errorTags.map(String) : [],
    moments: arr(r.moments).map((m) => ({ ...m, ply: int(m.ply), moveNumber: int(m.moveNumber), tag: String(m.tag ?? '') })),
  })) as StoredReview[];
  const motifs = Object.keys(MOTIF_INFO); const skills = Object.keys(SKILL_LABEL);
  const puzzles = arr(x.puzzles).filter((p) => ID_RE.test(String(p.id)) && obj(p.core) && typeof p.core.fenBefore === 'string' && obj(p.srs) && obj(p.core.tags) && obj(p.core.tags.primary)
    && motifs.includes(p.core.tags.primary.motif) && skills.includes(p.core.tags.primary.skill)).map((p) => ({
    ...p, id: String(p.id), gameId: ID_RE.test(String(p.gameId)) ? String(p.gameId) : '', gameUrl: safeUrl(p.gameUrl), endTime: num(p.endTime), createdAt: num(p.createdAt),
    rating: p.rating == null ? null : int(p.rating),
    core: { ...p.core, ply: int(p.core.ply), moveNumber: int(p.core.moveNumber), color: p.core.color === 'b' ? 'b' : 'w', wpBest: num(p.core.wpBest) },
    srs: { ...p.srs, ease: num(p.srs.ease, 2.5), interval: num(p.srs.interval), reps: int(p.srs.reps), lapses: int(p.srs.lapses), due: num(p.srs.due), retired: !!p.srs.retired,
      history: arr(p.srs.history).map((h) => ({ ...h, t: num(h.t), solved: !!h.solved, attempts: int(h.attempts), hints: int(h.hints), revealed: !!h.revealed, close: int(h.close), quality: int(h.quality),
        failure: h.failure === 'calculation' || h.failure === 'concept' ? h.failure : undefined })) },
  })) as Puzzle[];
  const levels = ['beginner', 'intermediate', 'advanced'] as const;
  const profiles = arr(x.profiles).filter((p) => typeof p.key === 'string').map((p) => ({ ...p, username: String(p.username ?? ''), level: p.level == null ? undefined : oneOf(p.level, levels, 'beginner'), createdAt: num(p.createdAt), updatedAt: num(p.updatedAt) })) as Profile[];
  const FEN_RE = /^[1-8pnbrqkPNBRQK/]+ [wb] [KQkq-]+ [a-h1-8-]+ \d+ \d+$/;
  const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
  const ucis = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((u) => UCI_RE.test(u)).slice(0, 600) : []);
  const replays = arr(x.replays).filter((r) => ID_RE.test(String(r.id)) && FEN_RE.test(String(r.startFen))).map((r) => ({
    ...r, id: String(r.id), profileKey: String(r.profileKey ?? ''), sourceId: String(r.sourceId ?? ''), myColor: r.myColor === 'b' ? 'b' : 'w', line: ucis(r.line), original: ucis(r.original),
    outcome: String(r.outcome ?? ''), createdAt: num(r.createdAt), reviewedAt: r.reviewedAt == null ? undefined : num(r.reviewedAt),
    evals: Array.isArray(r.evals) ? r.evals.map((e: any) => (obj(e) ? { cp: num(e.cp), mate: e.mate == null ? null : int(e.mate) } : null)) : undefined,
  })) as StoredReplay[];
  const workspace = arr(x.workspace).filter((w) => ID_RE.test(String(w.id)) && FEN_RE.test(String(w.startFen))).map((w) => ({
    ...w, id: String(w.id), profileKey: String(w.profileKey ?? ''), title: String(w.title ?? '').slice(0, 200), orientation: w.orientation === 'black' ? 'black' : 'white', updatedAt: num(w.updatedAt), createdAt: num(w.createdAt),
  })) as WorkspaceDoc[];
  const reports = arr(x.reports).filter((r) => ID_RE.test(String(r.id))).map((r) => ({
    ...r, id: String(r.id), profileKey: String(r.profileKey ?? ''), puzzleId: String(r.puzzleId ?? ''), kind: oneOf(r.kind, ['incorrect', 'unclear', 'too-advanced'] as const, 'unclear'),
    note: String(r.note ?? '').slice(0, 2000), level: String(r.level ?? ''), text: String(r.text ?? '').slice(0, 20000), createdAt: num(r.createdAt),
  })) as ExplanationReport[];
  return { app: 'chess-review', version: x.version === 2 ? 2 : 1, exportedAt: String(x.exportedAt ?? ''), profiles, games, reviews, puzzles, replays, workspace, reports };
}

export async function importAll(b: unknown): Promise<{ profiles: number; reviews: number; puzzles: number; games: number }> {
  const x = parseBackup(typeof b === 'string' ? b : JSON.stringify(b ?? null));
  const n = { profiles: 0, reviews: 0, puzzles: 0, games: 0 };
  for (const p of x.profiles) { await put('profiles', p); n.profiles++; }
  for (const g of x.games) { await put('games', g); n.games++; }
  for (const r of x.reviews) { await put('reviews', r); n.reviews++; }
  for (const p of x.puzzles) {
    const old = await get<Puzzle>('puzzles', p.id);
    // keep whichever copy has more review history
    if (!old || (p.srs.history?.length ?? 0) >= (old.srs.history?.length ?? 0)) { await put('puzzles', p); n.puzzles++; }
  }
  for (const r of x.replays ?? []) await put('replays', r);
  for (const w of x.workspace ?? []) await put('workspace', w);
  for (const r of x.reports ?? []) await put('reports', r);
  return n;
}

export async function deleteAll(): Promise<void> {
  const d = await db();
  await new Promise<void>((res, rej) => {
    const t = d.transaction([...STORES], 'readwrite');
    for (const s of STORES) t.objectStore(s).clear();
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('cr1:') || k.startsWith('cr-')) localStorage.removeItem(k);
  } catch { /* ignore */ }
}
