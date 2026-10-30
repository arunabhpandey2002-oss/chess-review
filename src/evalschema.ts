// Engine-result cache: key format and strict validation. Pure (no storage), so the backup parser can use it.
import { Chess } from 'chess.js';
import type { PosEval, Line } from './engine';

export const ENGINE_NAME_ID = 'sf19lite';
export const ENGINE_NET = 'nn-61e7af4bb97d';
export const CACHE_CFG = 'v1';
export const MAX_CACHE_ENTRIES = 20000;
export const cacheKey = (fen: string, depth: number, mpv: number) => `${fen}|${ENGINE_NAME_ID}|${ENGINE_NET}|${CACHE_CFG}|d${depth}|mpv${mpv}`;

const FEN_RE = /^[1-8pnbrqkPNBRQK/]{15,92} [wb] (?:[KQkq]{1,4}|-) (?:[a-h][36]|-) \d{1,3} \d{1,4}$/;
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const KEY_RE = /^(.+)\|([a-z0-9]+)\|(nn-[0-9a-f]{12})\|(v\d+)\|d(\d{1,2})\|mpv([1-5])$/;
const MATE_CP = 100000;

/** Splits a cache key. Returns null unless it is well formed and was made by this engine, network and settings. */
export function parseCacheKey(k: unknown): { fen: string; depth: number; mpv: number } | null {
  if (typeof k !== 'string' || k.length > 160) return null;
  const m = KEY_RE.exec(k);
  if (!m || m[2] !== ENGINE_NAME_ID || m[3] !== ENGINE_NET || m[4] !== CACHE_CFG || !FEN_RE.test(m[1])) return null;
  const depth = +m[5], mpv = +m[6];
  if (depth < 1 || depth > 40) return null;
  return { fen: m[1], depth, mpv };
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Rebuilds an engine result field by field, or returns null if anything is out of shape.
 *  Only numbers and UCI move strings survive; the first move of every line must be legal in the position. */
export function sanitizeEval(raw: unknown, fen: string, minDepth = 1, legalSet?: Set<string>): PosEval | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.depth, minDepth, 60)) return null;
  if (r.terminal !== undefined) return null; // terminal positions are recomputed from the board, never cached
  if (!Array.isArray(r.lines) || r.lines.length < 1 || r.lines.length > 5) return null;
  const legal = legalSet ?? legalMoves(fen);
  if (!legal) return null;
  const lines: Line[] = [];
  for (const l of r.lines) {
    if (!l || typeof l !== 'object') return null;
    const L = l as Record<string, unknown>;
    const s = L.score as Record<string, unknown> | undefined;
    if (!s || typeof s !== 'object' || !isInt(s.cp, -MATE_CP - 10000, MATE_CP + 10000)) return null;
    if (!(s.mate === null || isInt(s.mate, -300, 300))) return null;
    if (!Array.isArray(L.pv) || L.pv.length < 1 || L.pv.length > 40 || !L.pv.every((u) => typeof u === 'string' && UCI_RE.test(u))) return null;
    if (!legal.has(L.pv[0] as string)) return null;
    if (!isInt(L.depth, 1, 60)) return null;
    lines.push({ score: { cp: s.cp as number, mate: s.mate as number | null }, pv: (L.pv as string[]).slice(0, 14), depth: L.depth as number });
  }
  const out: PosEval = { lines, depth: r.depth as number };
  if (r.best !== undefined) { if (typeof r.best !== 'string' || !UCI_RE.test(r.best) || !legal.has(r.best)) return null; out.best = r.best; }
  return out;
}

function legalMoves(fen: string): Set<string> | null {
  try { return new Set(new Chess(fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ''))); } catch { return null; }
}

export interface CacheEntry { key: string; ev: PosEval; at: number }
/** Validates one stored or imported cache entry; the eval's depth must match the key. */
export function sanitizeCacheEntry(raw: unknown, legalCache?: Map<string, Set<string> | null>): CacheEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const k = parseCacheKey(r.key);
  if (!k) return null;
  let legal: Set<string> | null | undefined = legalCache?.get(k.fen);
  if (legal === undefined) { legal = legalMoves(k.fen); legalCache?.set(k.fen, legal); }
  if (!legal) return null;
  const ev = sanitizeEval(r.ev, k.fen, k.depth, legal);
  if (!ev || ev.depth !== k.depth || ev.lines.length > k.mpv) return null;
  const at = typeof r.at === 'number' && Number.isFinite(r.at) ? Math.max(0, Math.trunc(r.at)) : 0;
  return { key: cacheKey(k.fen, k.depth, k.mpv), ev, at };
}

/** Validates a list (from a backup or the store): one entry per key, the newest `cap`, each rebuilt by sanitizeCacheEntry. */
export function sanitizeCacheEntries(raw: unknown, cap = MAX_CACHE_ENTRIES): CacheEntry[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of raw.slice(0, cap * 4)) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const e = r as Record<string, unknown>;
    if (typeof e.key !== 'string' || !parseCacheKey(e.key)) continue;
    const at = typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : 0;
    const old = byKey.get(e.key);
    if (!old || (old.at as number) < at) byKey.set(e.key, { ...e, at });
  }
  const newest = [...byKey.values()].sort((a, b) => (b.at as number) - (a.at as number)).slice(0, cap);
  const legal = new Map<string, Set<string> | null>();
  const out: CacheEntry[] = [];
  for (const r of newest) { const e = sanitizeCacheEntry(r, legal); if (e) out.push(e); }
  return out;
}
