import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { cacheKey, parseCacheKey, sanitizeEval, sanitizeCacheEntry, ENGINE_NET, MAX_CACHE_ENTRIES } from '../../src/evalschema';
import { cachedAtLeast, putCached, getCached } from '../../src/evalcache';
import * as store from '../../src/store';
import type { PosEval } from '../../src/engine';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ev = (depth: number, n = 3): PosEval => ({ depth, lines: ['e2e4', 'd2d4', 'g1f3', 'c2c4', 'b1c3'].slice(0, n).map((u, i) => ({ score: { cp: 30 - i * 5, mate: null }, pv: [u, 'e7e5'], depth })) });
const backup = (evalcache: unknown) => JSON.stringify({ app: 'chess-review', version: 2, puzzles: [], evalcache });

describe('engine-cache keys and validation', () => {
  it('accepts only keys from this engine, network and settings', () => {
    expect(parseCacheKey(cacheKey(START, 18, 3))).toEqual({ fen: START, depth: 18, mpv: 3 });
    expect(parseCacheKey(cacheKey(START, 18, 3).replace(ENGINE_NET, 'nn-000000000000'))).toBeNull();
    expect(parseCacheKey(cacheKey(START, 18, 3).replace('|v1|', '|v9|'))).toBeNull();
    expect(parseCacheKey(`not a fen|sf19lite|${ENGINE_NET}|v1|d18|mpv3`)).toBeNull();
    expect(parseCacheKey(cacheKey(START, 18, 7))).toBeNull();
    expect(parseCacheKey(42)).toBeNull();
  });
  it('rebuilds a valid result and drops unknown fields', () => {
    const raw = { ...ev(18), extra: '<img src=x onerror=alert(1)>', lines: ev(18).lines.map((l) => ({ ...l, note: '<script>' })) };
    const out = sanitizeEval(raw, START)!;
    expect(out).toEqual(ev(18));
    expect(JSON.stringify(out)).not.toMatch(/img|script|note|extra/);
  });
  it('rejects illegal moves, non-UCI strings, bad scores and shape errors', () => {
    const bad = (f: (e: any) => void) => { const e: any = JSON.parse(JSON.stringify(ev(18))); f(e); return sanitizeEval(e, START); };
    expect(bad((e) => { e.lines[0].pv[0] = 'e2e5'; })).toBeNull();
    expect(bad((e) => { e.lines[0].pv[1] = 'javascript:alert(1)'; })).toBeNull();
    expect(bad((e) => { e.lines[0].score.cp = '30'; })).toBeNull();
    expect(bad((e) => { e.lines[0].score.cp = 1e12; })).toBeNull();
    expect(bad((e) => { e.lines[0].score.mate = 1.5; })).toBeNull();
    expect(bad((e) => { e.lines = []; })).toBeNull();
    expect(bad((e) => { e.lines = new Array(6).fill(e.lines[0]); })).toBeNull();
    expect(bad((e) => { e.depth = 0; })).toBeNull();
    expect(bad((e) => { e.terminal = 'checkmate'; })).toBeNull();
    expect(bad((e) => { e.best = 'a1a8'; })).toBeNull();
    expect(sanitizeEval([1, 2], START)).toBeNull();
  });
  it('an entry must match its key: same depth, no more lines than its line count', () => {
    expect(sanitizeCacheEntry({ key: cacheKey(START, 18, 3), ev: ev(18), at: 5 })).toEqual({ key: cacheKey(START, 18, 3), ev: ev(18), at: 5 });
    expect(sanitizeCacheEntry({ key: cacheKey(START, 18, 3), ev: ev(16), at: 5 })).toBeNull();
    expect(sanitizeCacheEntry({ key: cacheKey(START, 18, 2), ev: ev(18, 3), at: 5 })).toBeNull();
  });
});

describe('backup keeps engine results safely', () => {
  it('keeps valid entries, drops bad and duplicate ones', () => {
    const good = { key: cacheKey(START, 18, 3), ev: ev(18), at: 1 };
    const b = store.parseBackup(backup([good, good, { key: cacheKey(START, 18, 3).replace(ENGINE_NET, 'nn-111111111111'), ev: ev(18) },
      { key: '__proto__', ev: ev(18) }, { key: cacheKey(START, 16, 3), ev: { ...ev(16), lines: [{ score: { cp: 0, mate: null }, pv: ['<b>'], depth: 16 }] } }, 'junk', null]));
    expect(b.evalcache).toEqual([good]);
  });
  it('caps the number of entries', () => {
    const many = Array.from({ length: MAX_CACHE_ENTRIES + 50 }, (_, i) => ({ key: cacheKey(START, [10, 12, 14, 16, 18, 20, 22][i % 7], 1 + (i % 5)), ev: ev([10, 12, 14, 16, 18, 20, 22][i % 7], 1 + (i % 5)), at: i }));
    const b = store.parseBackup(backup(many));
    expect(b.evalcache!.length).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
    expect(b.evalcache!.length).toBe(35); // 7 depths x 5 line counts, de-duplicated
  });
  it('round-trips through export and import without overwriting existing results', async () => {
    await store.deleteAll();
    await putCached(START, 18, 3, ev(18));
    const exported = await store.exportAll();
    expect(exported.evalcache).toHaveLength(1);
    await store.deleteAll();
    await putCached('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 18, 3, { depth: 18, lines: [{ score: { cp: 20, mate: null }, pv: ['e7e5'], depth: 18 }] });
    const n = await store.importAll(JSON.stringify(exported));
    expect(n.positions).toBe(1);
    expect(await getCached(START, 18, 3)).toEqual(ev(18));
    expect((await store.importAll(JSON.stringify(exported))).positions).toBe(0);
  });
});

describe('full review reuses batch results', () => {
  it('uses the deepest saved result at least as deep as asked, never a shallower one', async () => {
    await store.deleteAll();
    await putCached(START, 16, 3, ev(16));
    expect(await cachedAtLeast(START, 18, 3, 20)).toBeNull();
    await putCached(START, 18, 3, ev(18));
    expect((await cachedAtLeast(START, 18, 3, 20))!.depth).toBe(18);
    await putCached(START, 22, 3, ev(22));
    expect((await cachedAtLeast(START, 18, 3, 20))!.depth).toBe(22);
    expect((await cachedAtLeast(START, 14, 3, 20))!.depth).toBe(22);
  });
  it('needs enough lines: a 2-line screening result does not stand in for a 3-line review', async () => {
    await store.deleteAll();
    await putCached(START, 22, 2, ev(22, 2));
    expect(await cachedAtLeast(START, 18, 3, 20)).toBeNull();
    // ...unless the position has only two legal moves
    expect((await cachedAtLeast(START, 18, 3, 2))!.lines).toHaveLength(2);
  });
  it('a damaged stored entry counts as missing', async () => {
    await store.deleteAll();
    await store.put('evalcache', { key: cacheKey(START, 18, 3), ev: { depth: 18, lines: [{ score: { cp: 0, mate: null }, pv: ['e2e5'], depth: 18 }] }, at: 0 });
    expect(await cachedAtLeast(START, 18, 3, 20)).toBeNull();
  });
});

describe('engine-cache size cap', () => {
  it('keeps the newest entries once the cache grows past its trigger, and leaves a small cache alone', async () => {
    await store.deleteAll();
    const fen = (i: number) => START.replace(/ 1$/, ` ${i + 1}`);
    for (let i = 0; i < 30; i++) await store.put('evalcache', { key: cacheKey(fen(i), 18, 3), ev: ev(18), at: 1000 + i });
    expect(await store.pruneOldest('evalcache', 20, 40)).toBe(0);
    expect(await store.pruneOldest('evalcache', 20, 25)).toBe(10);
    const left = await store.all<{ at: number }>('evalcache');
    expect(left.length).toBe(20);
    expect(Math.min(...left.map((e) => e.at))).toBe(1010);
    const { pruneCache } = await import('../../src/evalcache');
    expect(await pruneCache(15)).toBe(5);
    expect(await getCached(fen(29), 18, 3)).not.toBeNull();
    expect(await getCached(fen(0), 18, 3)).toBeNull();
    await store.deleteAll();
  });
});
