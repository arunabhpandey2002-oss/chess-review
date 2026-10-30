import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { VTree, parseImport } from '../../src/tree';

const START = new Chess().fen();
describe('variation tree', () => {
  it('adds moves, reuses identical moves, and keeps branches', () => {
    const t = new VTree(START);
    const e4 = t.add(t.root.id, 'e2e4', 'mine')!;
    t.add(e4.id, 'e7e5', 'mine');
    const again = t.add(t.root.id, 'e2e4', 'mine')!;
    expect(again.id).toBe(e4.id);
    t.add(t.root.id, 'd2d4', 'mine');
    expect(t.root.children).toHaveLength(2);
    expect(t.mainline().map((n) => n.san)).toEqual(['e4', 'e5']);
    expect(t.add(t.root.id, 'e2e5', 'mine')).toBeNull();
  });
  it('promotes, deletes, undoes and redoes', () => {
    const t = new VTree(START);
    t.add(t.root.id, 'e2e4', 'mine');
    const d4 = t.add(t.root.id, 'd2d4', 'mine')!;
    expect(t.promote(d4.id)).toBe(true);
    expect(t.mainline()[0].san).toBe('d4');
    expect(t.remove(d4.id)).toBe(true);
    expect(t.mainline()[0].san).toBe('e4');
    expect(t.undo()).toBe(true);
    expect(t.mainline()[0].san).toBe('d4');
    expect(t.redo()).toBe(true);
    expect(t.mainline()[0].san).toBe('e4');
  });
  it('take-backs stay in the tree as branches', () => {
    const t = new VTree(START);
    const e4 = t.add(t.root.id, 'e2e4', 'replay')!;
    const e5 = t.add(e4.id, 'e7e5', 'replay')!;
    t.markTakenBack(e5.id);
    t.select(e4.id);
    const c5 = t.add(e4.id, 'c7c5', 'replay')!;
    expect(t.node(e5.id).kind).toBe('taken-back');
    expect(c5.kind).toBe('replay');
    expect(t.branches()).toHaveLength(2);
    // replaying the taken-back move un-marks it
    expect(t.add(e4.id, 'e7e5', 'replay')!.kind).toBe('replay');
  });
  it('exports PGN with variations that chess.js can read back', () => {
    const t = new VTree(START);
    const e4 = t.add(t.root.id, 'e2e4', 'game')!;
    t.add(e4.id, 'e7e5', 'game');
    t.add(e4.id, 'c7c5', 'mine');
    const pgn = t.pgn();
    expect(pgn).toContain('1. e4 e5 (1... c5) *');
    const c = new Chess(); c.loadPgn(pgn);
    expect(c.history()).toEqual(['e4', 'e5']);
  });
  it('numbers moves from a FEN with black to move', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 7';
    const t = new VTree(fen);
    const a = t.add(t.root.id, 'e7e5', 'mine')!;
    t.add(a.id, 'g1f3', 'mine');
    expect(t.pgn()).toContain('7... e5 8. Nf3');
  });
  it('serialises and rejects broken data', () => {
    const t = new VTree(START);
    t.add(t.root.id, 'e2e4', 'mine');
    const back = VTree.from(JSON.parse(JSON.stringify(t.json())), START);
    expect(back.mainline()[0].san).toBe('e4');
    expect(VTree.from({ v: 1, nodes: { n0: { id: 'n0', children: ['zz'] } }, cursor: 'n0', rootFen: START }, START).count()).toBe(0);
  });
  it('imports FEN and PGN', () => {
    expect(parseImport('8/8/8/8/8/8/8/K6k w - - 0 1')!.ucis).toEqual([]);
    expect(parseImport('1. e4 e5 2. Nf3 *')!.ucis).toEqual(['e2e4', 'e7e5', 'g1f3']);
    expect(parseImport('not chess')).toBeNull();
  });
});
