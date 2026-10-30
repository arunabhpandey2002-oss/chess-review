import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';

// Build a version-1 database exactly as the previous release did, then open it with the new code.
function makeV1(): Promise<void> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('chess-review', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('profiles', { keyPath: 'key' });
      d.createObjectStore('games', { keyPath: 'key' }).createIndex('profileKey', 'profileKey');
      d.createObjectStore('reviews', { keyPath: 'key' }).createIndex('profileKey', 'profileKey');
      d.createObjectStore('puzzles', { keyPath: 'id' }).createIndex('profileKey', 'profileKey');
    };
    r.onsuccess = () => {
      const t = r.result.transaction('puzzles', 'readwrite');
      t.objectStore('puzzles').put({ id: 'old|g|1', profileKey: 'chesscom:me', core: { bestSan: 'Nc6' }, srs: { history: [1, 2] } });
      t.oncomplete = () => { r.result.close(); res(); };
      t.onerror = () => rej(t.error);
    };
    r.onerror = () => rej(r.error);
  });
}

describe('database upgrade v1 → v2', () => {
  it('keeps existing puzzles and adds the new stores', async () => {
    await makeV1();
    const store = await import('../../src/store');
    const p = await store.get<{ srs: { history: number[] } }>('puzzles', 'old|g|1');
    expect(p?.srs.history).toEqual([1, 2]);
    await store.put('jobs', { id: 'j1', profileKey: 'chesscom:me', batchId: 'b1', status: 'waiting' });
    await store.put('replays', { id: 'r1', profileKey: 'chesscom:me' });
    await store.put('evalcache', { key: 'fen|x', v: 1 });
    expect((await store.byProfile('jobs', 'chesscom:me')).length).toBe(1);
    expect(await store.get('evalcache', 'fen|x')).toEqual({ key: 'fen|x', v: 1 });
  });
  it('imports a version-1 backup and round-trips a version-2 backup with replays and reports', async () => {
    const store = await import('../../src/store');
    const v1 = { app: 'chess-review', version: 1, exportedAt: '', profiles: [], games: [], reviews: [], puzzles: [] };
    expect(store.parseBackup(JSON.stringify(v1)).version).toBe(1);
    await store.put('replays', { id: 'r2', profileKey: 'p', sourceId: 's', startFen: '8/8/8/8/8/8/8/K6k w - - 0 1', myColor: 'w', line: ['a1a2', 'bad<script>'], original: [], tree: null, outcome: 'draw', createdAt: 1 });
    await store.put('reports', { id: 'rep1', profileKey: 'p', puzzleId: 'x', kind: 'unclear', note: 'hm', level: 'beginner', record: {}, text: 't', createdAt: 2 });
    const b = await store.exportAll();
    expect(b.version).toBe(2);
    const back = store.parseBackup(JSON.stringify(b));
    expect(back.replays!.find((r) => r.id === 'r2')!.line).toEqual(['a1a2']);
    expect(back.reports!.find((r) => r.id === 'rep1')!.kind).toBe('unclear');
  });
});
