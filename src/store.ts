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
const DB_VERSION = 1;
export const STORES = ['profiles', 'games', 'reviews', 'puzzles'] as const;
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
}

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
    };
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
export async function byProfile<T>(store: Exclude<StoreName, 'profiles'>, pk: string): Promise<T[]> {
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
export interface Backup { app: 'chess-review'; version: 1; exportedAt: string; profiles: Profile[]; games: StoredGame[]; reviews: StoredReview[]; puzzles: Puzzle[] }

export async function exportAll(): Promise<Backup> {
  const [profiles, games, reviews, puzzles] = await Promise.all([all<Profile>('profiles'), all<StoredGame>('games'), all<StoredReview>('reviews'), all<Puzzle>('puzzles')]);
  return { app: 'chess-review', version: 1, exportedAt: new Date().toISOString(), profiles, games, reviews, puzzles };
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
  return { app: 'chess-review', version: 1, exportedAt: String(x.exportedAt ?? ''), profiles, games, reviews, puzzles };
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
