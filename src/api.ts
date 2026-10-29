// Public Chess.com API (CORS-enabled, no auth).
export interface PlayerSide { username: string; rating: number; result: string }
export interface GameSummary {
  id: string;
  url: string;
  pgn: string;
  white: PlayerSide;
  black: PlayerSide;
  timeClass: string;
  timeControl: string;
  endTime: number;
  opening: string;
  rated: boolean;
  /** Where the game came from. Missing means Chess.com (older cached data). */
  platform?: Platform;
}
export type Platform = 'chesscom' | 'lichess' | 'pgn';

const BASE = 'https://api.chess.com/pub/player/';

async function getJson(url: string) {
  const r = await fetch(url);
  if (r.status === 404) throw new Error('not-found');
  if (!r.ok) throw new Error(`Chess.com API error ${r.status}`);
  return r.json();
}

export async function fetchProfile(user: string): Promise<{ username: string; name?: string; avatar?: string; url: string }> {
  return getJson(BASE + encodeURIComponent(user.toLowerCase()));
}

export async function fetchArchives(user: string): Promise<string[]> {
  const j = await getJson(BASE + encodeURIComponent(user.toLowerCase()) + '/games/archives');
  return (j.archives as string[]).slice().sort();
}

export function openingFromPgn(pgn: string): string {
  const m = /\[ECOUrl "([^"]+)"\]/.exec(pgn);
  if (!m) return '';
  const slug = m[1].split('/openings/')[1] ?? '';
  const parts = slug.split('-');
  const out: string[] = [];
  for (const p of parts) {
    if (/^\d/.test(p)) break;
    out.push(p);
  }
  return decodeURIComponent(out.join(' ')).replace(/\s+/g, ' ').trim()
    .replace(/\b(King|Queen|Bishop|Petrov|Alekhine|Bird|Philidor|Owen|Larsen|Morphy)s\b/g, "$1's"); // Kings Pawn -> King's Pawn
}

export async function fetchMonth(url: string): Promise<GameSummary[]> {
  const j = await getJson(url);
  return (j.games as any[])
    .filter((g) => g.rules === 'chess' && g.pgn)
    .map((g) => ({
      id: String(g.url).split('/').pop()!,
      url: g.url,
      pgn: g.pgn,
      white: { username: g.white.username, rating: g.white.rating, result: g.white.result },
      black: { username: g.black.username, rating: g.black.rating, result: g.black.result },
      timeClass: g.time_class,
      timeControl: g.time_control,
      endTime: g.end_time,
      opening: openingFromPgn(g.pgn),
      rated: g.rated,
      platform: 'chesscom' as const,
    }))
    .sort((a, b) => b.endTime - a.endTime);
}

const DRAWS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);
export function resultFor(g: GameSummary, user: string): 'win' | 'loss' | 'draw' {
  const me = g.white.username.toLowerCase() === user.toLowerCase() ? g.white : g.black;
  if (me.result === 'win') return 'win';
  if (DRAWS.has(me.result)) return 'draw';
  return 'loss';
}

export function fmtTimeControl(tc: string, cls: string): string {
  if (!tc || tc === '-' || !/^\d/.test(tc)) return '';
  if (cls === 'daily' || tc.includes('/')) {
    const secs = +tc.split('/')[1];
    const d = Math.round(secs / 86400);
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  const [base, inc] = tc.split('+').map(Number);
  const mins = base / 60;
  const b = mins >= 1 ? `${+mins.toFixed(1)} min` : `${base} sec`;
  return inc ? `${mins >= 1 ? +mins.toFixed(1) : base + 's'} | ${inc}` : b;
}

export const REASONS: Record<string, string> = {
  checkmated: 'checkmate', resigned: 'resignation', timeout: 'time', abandoned: 'abandonment',
  agreed: 'agreement', repetition: 'repetition', stalemate: 'stalemate', insufficient: 'insufficient material',
  '50move': '50-move rule', timevsinsufficient: 'timeout vs insufficient material',
};
