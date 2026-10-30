// Opening explorer data: how often each move was played in a position and how those games ended.
// Bundled, free, offline: public/openings.json is built by tools/build-openings.py from a public-domain (CC0)
// sample of rated online games. No network calls beyond this app's own files; nothing about the user is sent.
import { Chess } from 'chess.js';
import { bookKey } from './review';

export interface OpeningMeta { games: number; month: string; minRating: number; speeds: string; maxPly: number; licence: string }
export interface OpeningData { meta: OpeningMeta; pos: Record<string, [number, ...[string, number, number, number][]]> }
export interface ExplorerMove { uci: string; san: string; games: number; share: number; white: number; draws: number; black: number }
export interface ExplorerView { total: number; moves: ExplorerMove[] }

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const KEY = /^[pnbrqkPNBRQK1-8/]{15,71} [wb] (-|K?Q?k?q?)$/;
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 1e9;

/** Strict shape check of the bundled file; anything unexpected is dropped rather than shown. */
export function validateOpenings(raw: unknown): OpeningData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const m = r.meta as Record<string, unknown> | undefined;
  if (!m || !isCount(m.games) || m.games < 1 || typeof m.month !== 'string' || !/^\d{4}-\d{2}$/.test(m.month) || !isCount(m.minRating) || typeof m.speeds !== 'string' || !/^[a-z, ]{1,40}$/.test(m.speeds) || !isCount(m.maxPly) || m.licence !== 'CC0') return null;
  if (!r.pos || typeof r.pos !== 'object' || Array.isArray(r.pos)) return null;
  const pos: OpeningData['pos'] = Object.create(null);
  for (const [k, v] of Object.entries(r.pos as Record<string, unknown>)) {
    if (!KEY.test(k) || !Array.isArray(v) || v.length < 2 || v.length > 21 || !isCount(v[0])) continue;
    const mv: [string, number, number, number][] = [];
    for (const x of v.slice(1)) if (Array.isArray(x) && x.length === 4 && typeof x[0] === 'string' && UCI.test(x[0]) && isCount(x[1]) && isCount(x[2]) && isCount(x[3])) mv.push([x[0], x[1], x[2], x[3]]);
    if (mv.length) pos[k] = [v[0], ...mv];
  }
  return { meta: { games: m.games, month: m.month, minRating: m.minRating, speeds: m.speeds, maxPly: m.maxPly, licence: 'CC0' }, pos };
}

/** Moves recorded for this position, legal ones only, most played first. Null when the sample has no games here. */
export function explore(fen: string, data: OpeningData): ExplorerView | null {
  const e = data.pos[bookKey(fen)];
  if (!e) return null;
  const [total, ...rows] = e;
  let c: Chess;
  try { c = new Chess(fen); } catch { return null; }
  const legal = new Map(c.moves({ verbose: true }).map((m) => [m.from + m.to + (m.promotion ?? ''), m.san]));
  const moves = rows.filter(([u]) => legal.has(u)).map(([uci, w, d, b]) => {
    const games = w + d + b;
    return { uci, san: legal.get(uci)!, games, share: total ? games / total : 0, white: w / games, draws: d / games, black: b / games };
  }).sort((a, b) => b.games - a.games);
  return moves.length ? { total, moves } : null;
}

/** Name of the latest named opening along the path to this position (fens from the start to the current one). */
export function openingName(fens: string[], book: Record<string, string> | null): { eco: string; name: string; exact: boolean } | null {
  if (!book) return null;
  for (let i = fens.length - 1; i >= 0; i--) {
    const v = book[bookKey(fens[i])];
    if (typeof v === 'string' && v.includes('|')) {
      const [eco, name] = v.split('|');
      if (/^[A-E]\d\d$/.test(eco) && name) return { eco, name, exact: i === fens.length - 1 };
    }
  }
  return null;
}

/** Whole-percent split that always sums to 100 (largest remainder), so the three numbers never disagree with the bar. */
export function pct3(a: number, b: number, c: number): [number, number, number] {
  const s = a + b + c;
  if (s <= 0) return [0, 0, 0];
  const raw = [a, b, c].map((x) => (x / s) * 100);
  const fl = raw.map(Math.floor);
  let left = 100 - fl.reduce((x, y) => x + y, 0);
  raw.map((x, i) => [x - fl[i], i] as const).sort((x, y) => y[0] - x[0]).forEach(([, i]) => { if (left > 0) { fl[i]++; left--; } });
  return fl as [number, number, number];
}

let loading: Promise<{ data: OpeningData | null; book: Record<string, string> | null }> | null = null;
export function loadOpenings() {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const get = (f: string) => fetch(`${base}${f}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  loading ??= Promise.all([get('openings.json'), get('book.json')]).then(([d, b]) => ({ data: validateOpenings(d), book: b && typeof b === 'object' ? (b as Record<string, string>) : null }))
    .then((r) => { if (!r.data) loading = null; return r; }); // try again next time after a failed load
  return loading;
}
