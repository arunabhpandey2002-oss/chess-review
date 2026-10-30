import { describe, it, expect } from 'vitest';
import { safeUrl } from '../../src/safe';
import { parseBackup } from '../../src/store';

describe('safety', () => {
  it('only keeps http(s) links', () => {
    expect(safeUrl('https://www.chess.com/game/live/1')).toBe('https://www.chess.com/game/live/1');
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl(' JaVaScRiPt:alert(1)')).toBe('');
    expect(safeUrl('data:text/html,x')).toBe('');
    expect(safeUrl('https://x.com/"onmouseover=1')).toBe('');
    expect(safeUrl(42)).toBe('');
  });
  it('cleans a hostile backup', () => {
    const raw = `{"app":"chess-review","version":1,"__proto__":{"polluted":1},"profiles":[{"key":"p","constructor":{"prototype":{"polluted":1}}}],
      "games":[{"key":"k|1","game":{"id":"\\"><img src=x>","url":"javascript:1"}},{"key":"k|2","game":{"id":"pgn-1","url":"javascript:1","white":{"username":"<b>x</b>","rating":"\\"><svg>"}}}],
      "reviews":[],"puzzles":[{"id":"a|b|3","core":{"fenBefore":"8/8","color":"w\\" onclick=\\"x","ply":"1\\"","tags":{"primary":{"motif":"fork","skill":"tactics"}}},"srs":{"history":[{"hints":"<img>"}]},"gameUrl":"javascript:x"}]}`;
    const b = parseBackup(raw);
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(b.profiles[0])).toBe(Object.prototype);
    expect(b.games.map((g) => g.game.id)).toEqual(['pgn-1']);
    expect(b.games[0].game.url).toBe('');
    expect(b.games[0].game.white.username).toBe('bx/b');
    expect(b.games[0].game.white.rating).toBe(0);
    expect(JSON.stringify(b)).not.toMatch(/[<>]/);
    for (const p of b.puzzles) { expect(p.core.color).toBe('w'); expect(typeof p.core.ply).toBe('number'); expect(p.gameUrl).toBe(''); }
  });
  it('rejects files that are not backups', () => {
    expect(() => parseBackup('not json')).toThrow(/valid JSON/);
    expect(() => parseBackup('{"app":"x","puzzles":[]}')).toThrow(/not a rook-i\.e\. mistakes backup/);
  });
});
