// Openings you meet most and one sound reply line for each (data built offline by tools/build-repertoire.py:
// names/ECO from lichess-org/chess-openings, move choices from the CC0 Lichess database sample, every one of your
// moves checked with Stockfish). Pure functions here; the page lives in openings-page.ts.
import { Chess } from 'chess.js';
import raw from './repertoire.json';
import { bookKey, type Book } from './review';
import type { SrsState } from './srs';

export interface RepAlt { san: string; uci: string; games: number; share: number; lossCp: number }
export interface RepPly { san: string; uci: string; fen: string; mine: boolean; games: number; share: number; lossCp?: number; evalCp?: number; alts?: RepAlt[]; why?: string; src?: 'db' | 'engine' }
export interface RepEntry { id: string; side: 'w' | 'b'; eco: string; name: string; idPgn: string; idPlies: number; names: string[]; idea: string; endsIn: string; endEvalCp: number; plies: RepPly[] }
export interface RepMeta { sources: { names: string; moves: string; check: string } }

/** Hard limit the build enforces for any move of yours (centipawns). */
export const MAX_LOSS = 50;
/** An alternative counts as "also fine" when it is this sound and at least this common. */
const ALT_OK_LOSS = 30, ALT_OK_SHARE = 0.05;

/** Replays every line from the start: drops an entry whose moves, positions or SAN don't match, or that breaks the limits. */
export function validateRepertoire(x: unknown): { meta: RepMeta; openings: RepEntry[] } {
  const r = x as { meta?: RepMeta; openings?: RepEntry[] };
  const out: RepEntry[] = [];
  for (const e of Array.isArray(r?.openings) ? r.openings : []) {
    try {
      if (!/^[a-z-]{2,20}$/.test(e.id) || (e.side !== 'w' && e.side !== 'b') || !/^[A-E]\d\d$/.test(e.eco) || !e.name || !e.idea) continue;
      const c = new Chess();
      let ok = e.plies.length >= e.idPlies + 6 && e.plies[e.plies.length - 1].mine;
      for (const p of e.plies) {
        if (!ok) break;
        if (c.fen() !== p.fen || (c.turn() === e.side) !== p.mine) { ok = false; break; }
        const m = c.move({ from: p.uci.slice(0, 2), to: p.uci.slice(2, 4), promotion: p.uci[4] });
        if (m.san !== p.san) ok = false;
        if (p.mine && (typeof p.lossCp !== 'number' || p.lossCp > MAX_LOSS)) ok = false;
      }
      if (ok && !out.some((o) => o.id === e.id)) out.push(e);
    } catch { /* illegal move: drop the entry */ }
  }
  return { meta: r?.meta ?? { sources: { names: '', moves: '', check: '' } }, openings: out };
}

export const REPERTOIRE = validateRepertoire(raw);
export const OPENINGS = REPERTOIRE.openings;
export const openingById = (id: string | null | undefined) => OPENINGS.find((o) => o.id === id) ?? null;

/** Move text with numbers, e.g. "1. e4 c5 2. Nf3". */
export function moveText(plies: Pick<RepPly, 'san'>[], from = 0): string {
  return plies.slice(from).map((p, k) => { const i = from + k; return i % 2 === 0 ? `${i / 2 + 1}. ${p.san}` : (k === 0 ? `${(i + 1) / 2}... ${p.san}` : p.san); }).join(' ');
}

/** One move with its number: "3. g3" or "2... e6". */
export const moveLabel = (i: number, san: string) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : `${(i + 1) / 2}... ${san}`);

export type Judgement =
  | { kind: 'book' }
  | { kind: 'alt-ok'; san: string; lossCp: number; share: number }
  | { kind: 'alt-weak'; san: string; lossCp: number; share: number }
  | { kind: 'other'; san: string };

/** How a move you tried compares with the line's move at ply i. */
export function judgeMove(e: RepEntry, i: number, uci: string): Judgement {
  const p = e.plies[i];
  if (uci === p.uci) return { kind: 'book' };
  let san = uci;
  try { san = new Chess(p.fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { /* illegal */ }
  const a = p.alts?.find((x) => x.uci === uci);
  if (!a) return { kind: 'other', san };
  return a.lossCp <= ALT_OK_LOSS && a.share >= ALT_OK_SHARE ? { kind: 'alt-ok', san: a.san, lossCp: a.lossCp, share: a.share } : { kind: 'alt-weak', san: a.san, lossCp: a.lossCp, share: a.share };
}

/** A gentle explanation for a move that isn't the one in this line. */
export function wrongText(j: Judgement): string {
  const pct = (s: number) => `${Math.round(s * 100)}%`;
  const pawns = (cp: number) => (cp / 100).toFixed(1);
  if (j.kind === 'alt-ok') return `${j.san} is also played (${pct(j.share)} of games) and it's fine — but this line uses a different move. Try again.`;
  if (j.kind === 'alt-weak') return j.lossCp > ALT_OK_LOSS
    ? `${j.san} is played in ${pct(j.share)} of games, but Stockfish rates it about ${pawns(j.lossCp)} pawns worse than the best move here. Try again.`
    : `${j.san} is playable but rare here (${pct(j.share)} of games). Look for the main move. Try again.`;
  if (j.kind === 'book') return '';
  return `${j.san} isn't the move in this line, and it's rarely played here. Think about the idea of the opening and try again.`;
}

// ---------------- your games ----------------
export interface GameLike { id: string; pgn: string; myColor: 'w' | 'b'; result: 'win' | 'loss' | 'draw' }
export interface Detected { eco: string; name: string; plies: number; entry: RepEntry | null }

const sanList = (pgn: string): string[] | null => {
  try { const c = new Chess(); c.loadPgn(pgn); return c.history(); } catch { return null; }
};

/** The game's opening by longest-prefix match against the named positions (book.json), plus the practice entry it belongs to. */
export function detectOpening(pgn: string, myColor: 'w' | 'b', book: Book | null): Detected | null {
  const sans = sanList(pgn);
  if (!sans) return null;
  const c = new Chess();
  let best: { eco: string; name: string; plies: number } | null = null;
  for (let i = 0; i < Math.min(sans.length, 40); i++) {
    c.move(sans[i]);
    const v = book?.[bookKey(c.fen())];
    if (typeof v === 'string' && v.includes('|')) { const [eco, name] = v.split('|'); best = { eco, name, plies: i + 1 }; }
    else if (book && v === undefined) break; // left the book: nothing further down can be named
  }
  return best ? { ...best, entry: entryFor(sans, best.name, myColor) } : null;
}

/** Most specific practice entry for these moves: first by the identifying moves, then by the opening's name. */
export function entryFor(sans: string[], name: string, myColor: 'w' | 'b'): RepEntry | null {
  const mine = OPENINGS.filter((o) => o.side === myColor);
  let pick: RepEntry | null = null;
  for (const o of mine) {
    const id = o.plies.slice(0, o.idPlies).map((p) => p.san);
    if (id.every((s, i) => sans[i] === s) && (!pick || o.idPlies > pick.idPlies)) pick = o;
  }
  if (pick) return pick;
  let len = 0;
  for (const o of mine) for (const n of o.names) {
    if ((name === n || name.startsWith(n + ':') || name.startsWith(n + ',')) && n.length > len) { pick = o; len = n.length; }
  }
  return pick;
}

export interface FacedRow { key: string; label: string; eco: string; entry: RepEntry | null; myColor: 'w' | 'b'; games: number; wins: number; draws: number; losses: number; score: number; struggling: boolean }

/** Family name ("Sicilian Defense" from "Sicilian Defense: Najdorf Variation"). */
export const family = (name: string) => name.split(':')[0].trim();

/** Openings you face most, with your score (win 1, draw ½). Struggling: under 45% across 3 or more games. */
export function facedStats(games: GameLike[], book: Book | null): FacedRow[] {
  const rows = new Map<string, FacedRow>();
  const seen = new Set<string>();
  for (const g of games) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    const d = detectOpening(g.pgn, g.myColor, book);
    if (!d) continue;
    const label = d.entry ? d.entry.name : family(d.name);
    const key = `${g.myColor}|${d.entry ? d.entry.id : label}`;
    const r = rows.get(key) ?? { key, label, eco: d.entry ? d.entry.eco : d.eco, entry: d.entry, myColor: g.myColor, games: 0, wins: 0, draws: 0, losses: 0, score: 0, struggling: false };
    r.games++;
    if (g.result === 'win') r.wins++; else if (g.result === 'draw') r.draws++; else r.losses++;
    rows.set(key, r);
  }
  return [...rows.values()].map((r) => {
    const score = (r.wins + r.draws / 2) / r.games;
    return { ...r, score, struggling: r.games >= 3 && score < 0.45 };
  }).sort((a, b) => b.games - a.games || a.score - b.score || a.label.localeCompare(b.label));
}

// ---------------- progress ----------------
export interface OpeningProgress { key: string; profileKey: string; openingId: string; srs: SrsState }
export const progressKey = (pk: string, id: string) => `${pk}|opening|${id}`;
