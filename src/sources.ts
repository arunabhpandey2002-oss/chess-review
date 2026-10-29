// Lichess (public NDJSON export) and pasted/uploaded PGN imports. Everything runs in the browser.
import { Chess } from 'chess.js';
import type { GameSummary, PlayerSide } from './api';

const LI = 'https://lichess.org';

/** Lichess `status` → Chess.com-style result for the losing / drawing side. */
const LI_STATUS: Record<string, string> = {
  mate: 'checkmated', resign: 'resigned', outoftime: 'timeout', timeout: 'abandoned', draw: 'agreed',
  stalemate: 'stalemate', insufficientMaterialClaim: 'insufficient', variantEnd: 'resigned', cheat: 'abandoned', noStart: 'abandoned',
};
const UNFINISHED = new Set(['created', 'started', 'aborted', 'unknownFinish', 'noStart']);

function liSpeedToClass(s: string): string {
  if (s === 'correspondence') return 'daily';
  if (s === 'ultraBullet') return 'bullet';
  if (s === 'classical') return 'rapid';
  return s;
}

export function lichessGameToSummary(g: any): GameSummary | null {
  if (!g || g.variant !== 'standard' || UNFINISHED.has(g.status) || !g.pgn) return null;
  const side = (c: 'white' | 'black'): PlayerSide => {
    const p = g.players?.[c] ?? {};
    const name = p.user?.name ?? (p.aiLevel ? `Stockfish level ${p.aiLevel}` : 'Anonymous');
    let result: string;
    if (g.winner === c) result = 'win';
    else if (!g.winner) result = LI_STATUS[g.status] === 'stalemate' ? 'stalemate' : g.status === 'insufficientMaterialClaim' ? 'insufficient' : 'agreed';
    else result = LI_STATUS[g.status] ?? 'resigned';
    return { username: name, rating: p.rating ?? 0, result };
  };
  const clock = g.clock ? `${g.clock.initial}+${g.clock.increment}` : g.daysPerTurn ? `1/${g.daysPerTurn * 86400}` : '-';
  return {
    id: `li-${g.id}`,
    url: `${LI}/${g.id}`,
    pgn: g.pgn,
    white: side('white'),
    black: side('black'),
    timeClass: liSpeedToClass(g.speed ?? 'rapid'),
    timeControl: clock,
    endTime: Math.round((g.lastMoveAt ?? g.createdAt ?? Date.now()) / 1000),
    opening: g.opening?.name ?? '',
    rated: !!g.rated,
    platform: 'lichess',
  };
}

export async function fetchLichessGames(user: string, max = 30, until?: number): Promise<GameSummary[]> {
  const q = new URLSearchParams({ max: String(max), evals: 'false', clocks: 'true', opening: 'true', pgnInJson: 'true', finished: 'true' });
  if (until) q.set('until', String(until));
  const r = await fetch(`${LI}/api/games/user/${encodeURIComponent(user)}?${q}`, { headers: { Accept: 'application/x-ndjson' } });
  if (r.status === 404) throw new Error('not-found');
  if (r.status === 429) throw new Error('Lichess is rate-limiting requests; wait a minute and try again');
  if (!r.ok) throw new Error(`Lichess API error ${r.status}`);
  const text = await r.text();
  const out: GameSummary[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const s = lichessGameToSummary(JSON.parse(line)); if (s) out.push(s); } catch { /* skip bad line */ }
  }
  return out;
}

export async function fetchLichessProfile(user: string): Promise<{ username: string; url: string }> {
  const r = await fetch(`${LI}/api/user/${encodeURIComponent(user)}`);
  if (r.status === 404) throw new Error('not-found');
  if (!r.ok) throw new Error(`Lichess API error ${r.status}`);
  const j = await r.json();
  return { username: j.username, url: j.url };
}

export async function fetchLichessGame(id: string): Promise<GameSummary | null> {
  const r = await fetch(`${LI}/game/export/${encodeURIComponent(id)}?evals=false&clocks=true&opening=true&pgnInJson=true`, { headers: { Accept: 'application/json' } });
  if (!r.ok) return null;
  return lichessGameToSummary(await r.json());
}

// ---------------- PGN ----------------
export function splitPgns(text: string): string[] {
  const t = text.replace(/\r\n?/g, '\n').trim();
  if (!t) return [];
  const parts = t.split(/\n\s*\n(?=\[Event )/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export interface PgnImport { ok: GameSummary[]; errors: string[] }

/** Parse one or more PGNs. Unfinished games (Result "*") are refused: only finished games are reviewed. */
export function importPgn(text: string): PgnImport {
  const ok: GameSummary[] = [];
  const errors: string[] = [];
  splitPgns(text).forEach((pgn, i) => {
    const c = new Chess();
    try { c.loadPgn(pgn); } catch (e) { errors.push(`Game ${i + 1}: could not read the moves (${(e as Error).message.split('\n')[0]}).`); return; }
    const h = c.getHeaders();
    const result = h.Result ?? '*';
    if (!['1-0', '0-1', '1/2-1/2'].includes(result)) { errors.push(`Game ${i + 1}: it has no result yet (still in progress?), so it was skipped.`); return; }
    if (c.history().length < 2) { errors.push(`Game ${i + 1}: too few moves to review.`); return; }
    if (h.Variant && !/standard|from position/i.test(h.Variant)) { errors.push(`Game ${i + 1}: only standard chess is supported.`); return; }
    const sideRes = (me: 'w' | 'b'): string => result === '1/2-1/2' ? (c.isStalemate() ? 'stalemate' : 'agreed') : (result === '1-0') === (me === 'w') ? 'win' : c.isCheckmate() ? 'checkmated' : /time/i.test(h.Termination ?? '') ? 'timeout' : 'resigned';
    const date = (h.UTCDate ?? h.Date ?? '').replace(/\?/g, '01');
    const t = Date.parse(date.replace(/\./g, '-') + (h.UTCTime ? `T${h.UTCTime}Z` : ''));
    ok.push({
      id: `pgn-${hash(pgn)}`,
      url: h.Link ?? (h.Site?.startsWith('http') ? h.Site : ''),
      pgn,
      white: { username: h.White || 'White', rating: +(h.WhiteElo ?? 0) || 0, result: sideRes('w') },
      black: { username: h.Black || 'Black', rating: +(h.BlackElo ?? 0) || 0, result: sideRes('b') },
      timeClass: classFromTc(h.TimeControl),
      timeControl: h.TimeControl ?? '-',
      endTime: Number.isFinite(t) ? Math.round(t / 1000) : Math.round(Date.now() / 1000),
      opening: h.Opening ?? '',
      rated: false,
      platform: 'pgn',
    });
  });
  return { ok, errors };
}

function classFromTc(tc?: string): string {
  if (!tc || tc === '-' ) return 'game';
  if (tc.includes('/')) return 'daily';
  const [b, i] = tc.split('+').map(Number);
  const est = b + 40 * (i || 0);
  return est < 180 ? 'bullet' : est < 480 ? 'blitz' : est < 1500 ? 'rapid' : 'classical';
}
