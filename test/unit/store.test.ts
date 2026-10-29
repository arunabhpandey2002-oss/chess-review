import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../../src/store';
import { newSrs, schedule } from '../../src/srs';
import type { MomentCore } from '../../src/explain';

const core = { ply: 3, moveNumber: 2, color: 'b', fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2', fenAfter: '', playedUci: 'f7f6', playedSan: 'f6', bestUci: 'b8c6', bestSan: 'Nc6', lines: [], reply: null, wpBest: 50, wpPlayed: 35, loss: 15, cls: 'mistake', tags: { solution: [], error: [], primary: { id: 'missed:positional', motif: 'positional', role: 'missed', skill: 'positional', squares: [] }, solutionTag: { id: 'missed:positional', motif: 'positional', role: 'missed', skill: 'positional', squares: [] } } } as unknown as MomentCore;
const puzzle = (id: string): store.Puzzle => ({ id, profileKey: 'chesscom:me', gameId: 'g1', gameUrl: '', platform: 'chesscom', white: 'a', black: 'me', endTime: 1, phase: 'opening', core, srs: newSrs(0), createdAt: 0 });

beforeEach(async () => { await store.deleteAll(); });

describe('local store', () => {
  it('keeps SRS progress when a puzzle is saved again', async () => {
    const p = puzzle('chesscom:me|g1|3');
    await store.savePuzzle(p);
    await store.put('puzzles', { ...p, srs: schedule(p.srs, { solved: true, attempts: 1, hints: 0, revealed: false }, 1000) });
    const again = await store.savePuzzle(puzzle('chesscom:me|g1|3'));
    expect(again.srs.history.length).toBe(1);
    expect((await store.byProfile<store.Puzzle>('puzzles', 'chesscom:me')).length).toBe(1);
  });
  it('exports, deletes and re-imports everything', async () => {
    await store.ensureProfile('lichess', 'Someone');
    await store.savePuzzle(puzzle('x'));
    const b = await store.exportAll();
    expect(b.puzzles.length).toBe(1);
    expect(b.profiles[0].key).toBe('lichess:someone');
    await store.deleteAll();
    expect((await store.exportAll()).puzzles.length).toBe(0);
    const n = await store.importAll(JSON.parse(JSON.stringify(b)));
    expect(n.puzzles).toBe(1);
    expect((await store.get<store.Puzzle>('puzzles', 'x'))?.core.bestSan).toBe('Nc6');
  });
  it('rejects files that are not backups', async () => {
    await expect(store.importAll({ hello: 1 })).rejects.toThrow(/not a rook-i\.e\. mistakes backup/);
  });
});
