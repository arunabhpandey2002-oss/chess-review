// Engine-result cache shared by the batch, the full review and backups (IndexedDB 'evalcache').
import type { PosEval } from './engine';
import * as store from './store';
import { cacheKey, sanitizeCacheEntry, type CacheEntry } from './evalschema';

/** Depths anything in the app analyses at (batch screen/verify, review Fast/Standard/Deep). */
export const KNOWN_DEPTHS = [10, 12, 14, 16, 18, 20, 22] as const;

const slim = (ev: PosEval): PosEval => ({ ...ev, lines: ev.lines.map((l) => ({ ...l, pv: l.pv.slice(0, 14) })) });

/** Exact entry (this depth and line count), validated on read; a damaged entry counts as missing. */
export async function getCached(fen: string, depth: number, mpv: number): Promise<PosEval | null> {
  const raw = await store.get<CacheEntry>('evalcache', cacheKey(fen, depth, mpv)).catch(() => undefined);
  return raw ? sanitizeCacheEntry(raw)?.ev ?? null : null;
}

export async function putCached(fen: string, depth: number, mpv: number, ev: PosEval): Promise<PosEval> {
  const s = slim(ev);
  if (!ev.terminal) await store.put('evalcache', { key: cacheKey(fen, depth, mpv), ev: s, at: Date.now() }).catch(() => undefined);
  return s;
}

/** The deepest saved result for this position that is at least `minDepth` deep with at least `minLines` lines
 *  (or every legal move, when there are fewer). Used by the full review to skip positions the batch already analysed. */
export async function cachedAtLeast(fen: string, minDepth: number, minLines: number, legalMoves: number): Promise<PosEval | null> {
  const need = Math.min(minLines, Math.max(1, legalMoves));
  for (const d of [...KNOWN_DEPTHS].filter((x) => x >= minDepth).reverse()) {
    for (const mpv of [5, 4, 3, 2, 1]) {
      if (mpv < need) break;
      const ev = await getCached(fen, d, mpv);
      if (ev && ev.depth >= minDepth && ev.lines.length >= need) return ev;
    }
  }
  return null;
}
