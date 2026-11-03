// Openings you meet most and one sound reply line for each (data built offline by tools/build-repertoire.py:
// names/ECO from lichess-org/chess-openings, move choices from the CC0 Lichess database sample, every one of your
// moves checked with Stockfish). Pure functions here; the page lives in openings-page.ts.
import { Chess } from 'chess.js';
import raw from './repertoire.json';
import { bookKey, type Book } from './review';
import type { SrsState } from './srs';

export interface RepAlt { san: string; uci: string; games: number; share: number; lossCp: number }
export interface RepPly { san: string; uci: string; fen: string; mine: boolean; games: number; share: number; lossCp?: number; evalCp?: number; alts?: RepAlt[]; why?: string; src?: 'db' | 'engine' }
export interface RepEntry {
  id: string; side: 'w' | 'b'; eco: string; name: string; idPgn: string; idPlies: number; names: string[]; idea: string; endsIn: string; endEvalCp: number; plies: RepPly[];
  /** Family this variation belongs to, how many sample games reach its position, how many of your games had this name, other names its line passes through. */
  family?: string; count?: number; fromGames?: number; also?: string[];
}
export interface RepSkipped { name: string; eco: string; pgn: string; why: string; games: number }
export interface RepFamily { id: string; side: 'w' | 'b'; name: string; root: string; familyNames: string[]; idea: string; variations: string[]; skipped: RepSkipped[] }
export interface RepMeta { sources: { names: string; moves: string; check: string; yourGames?: string } }

/** Hard limit the build enforces for any move of yours (centipawns). */
export const MAX_LOSS = 50;
/** An alternative counts as "also fine" when it is this sound and at least this common. */
const ALT_OK_LOSS = 30, ALT_OK_SHARE = 0.05;

const posKey = (fen: string) => fen.split(' ').slice(0, 3).join(' ');

/** Replays every line from the start: drops an entry whose moves, positions or SAN don't match, or that breaks the limits.
 *  Within a family, a variation that answers a position differently from an earlier one is dropped too (the drill
 *  branches on the opponent's moves only, so your move for a position must be the same in every variation). */
export function validateRepertoire(x: unknown): { meta: RepMeta; openings: RepEntry[]; families: RepFamily[] } {
  const r = x as { meta?: RepMeta; openings?: RepEntry[]; families?: RepFamily[] };
  const out: RepEntry[] = [];
  for (const e of Array.isArray(r?.openings) ? r.openings : []) {
    try {
      if (!/^[a-z0-9-]{2,60}$/.test(e.id) || e.id.startsWith('f-') || (e.side !== 'w' && e.side !== 'b') || !/^[A-E]\d\d$/.test(e.eco) || !e.name || !e.idea) continue;
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
  const families: RepFamily[] = [];
  for (const f of Array.isArray(r?.families) ? r.families : []) {
    if (!f || !/^f-[a-z0-9-]{1,40}$/.test(f.id) || (f.side !== 'w' && f.side !== 'b') || !f.name || families.some((g) => g.id === f.id)) continue;
    const mine = new Map<string, string>();
    const vars: string[] = [];
    for (const id of Array.isArray(f.variations) ? f.variations : []) {
      const e = out.find((o) => o.id === id);
      if (!e || e.side !== f.side || (e.family && e.family !== f.id)) continue;
      const clash = e.plies.some((p) => p.mine && mine.has(posKey(p.fen)) && mine.get(posKey(p.fen)) !== p.uci);
      if (clash) continue;
      for (const p of e.plies) if (p.mine) mine.set(posKey(p.fen), p.uci);
      e.family = f.id;
      vars.push(id);
    }
    if (vars.length) families.push({ ...f, idea: f.idea || out.find((o) => o.id === vars[0])!.idea, variations: vars, skipped: Array.isArray(f.skipped) ? f.skipped : [], familyNames: Array.isArray(f.familyNames) ? f.familyNames : [] });
  }
  // old data without families: one family per line
  for (const e of out) if (!families.some((f) => f.variations.includes(e.id))) {
    e.family = `f-${e.id}`.slice(0, 43);
    families.push({ id: e.family, side: e.side, name: e.name, root: e.idPgn, familyNames: e.names, idea: e.idea, variations: [e.id], skipped: [] });
  }
  return { meta: r?.meta ?? { sources: { names: '', moves: '', check: '' } }, openings: out, families };
}

export const REPERTOIRE = validateRepertoire(raw);
export const OPENINGS = REPERTOIRE.openings;
export const FAMILIES = REPERTOIRE.families;
export const openingById = (id: string | null | undefined) => OPENINGS.find((o) => o.id === id) ?? null;
export const familyById = (id: string | null | undefined) => FAMILIES.find((f) => f.id === id) ?? null;
export const familyOf = (e: RepEntry) => FAMILIES.find((f) => f.id === e.family) ?? null;
export const variationsOf = (f: RepFamily) => f.variations.map((id) => openingById(id)!).filter(Boolean);

/** How often each variation is met, as a share of the family (sample games reaching its position; at least 1). */
export function variationWeights(f: RepFamily): Map<string, number> {
  const vs = variationsOf(f);
  const w = vs.map((v) => Math.max(1, v.count ?? 1));
  const sum = w.reduce((a, b) => a + b, 0);
  return new Map(vs.map((v, i) => [v.id, w[i] / sum]));
}

/** The variation the trainer plays next in this family: the opponent's choices follow how often each variation is
 *  played. Variations due for review come first, then ones you haven't practised, then the rest. */
export function pickVariation(f: RepFamily, srsOf: (id: string) => SrsState | undefined, now: number, rand: () => number = Math.random, exclude?: string): RepEntry | null {
  const vs = variationsOf(f).filter((v) => v.id !== exclude || f.variations.length === 1);
  const due = vs.filter((v) => { const s = srsOf(v.id); return s && s.due <= now; });
  const fresh = vs.filter((v) => !srsOf(v.id));
  const pool = due.length ? due : fresh.length ? fresh : vs;
  const w = pool.map((v) => Math.max(1, v.count ?? 1));
  let x = rand() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) { x -= w[i]; if (x < 0) return pool[i]; }
  return pool[pool.length - 1] ?? null;
}

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
  let pick: RepEntry | null = mine.find((o) => o.name === name) ?? mine.find((o) => o.names.includes(name)) ?? null;
  if (pick) return pick;
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

/** The family for an opening name (or moves) when no single line fits it. */
export function familyFor(sans: string[], name: string, myColor: 'w' | 'b'): RepFamily | null {
  const e = entryFor(sans, name, myColor);
  if (e) return familyOf(e);
  let pick: RepFamily | null = null, len = 0;
  for (const f of FAMILIES) if (f.side === myColor) for (const n of f.familyNames) {
    if ((family(name) === n || name === n) && n.length > len) { pick = f; len = n.length; }
  }
  return pick;
}

export interface FacedRow {
  key: string; label: string; eco: string; entry: RepEntry | null; family: RepFamily | null; myColor: 'w' | 'b';
  games: number; wins: number; draws: number; losses: number; score: number; struggling: boolean;
  /** Set when the trainer's line for this family answers differently from what you played (e.g. "needs Nc6 where your line plays Nf6"). */
  differs?: string;
}

/** Family name ("Sicilian Defense" from "Sicilian Defense: Najdorf Variation"). */
export const family = (name: string) => name.split(':')[0].trim();

/** Openings you face most, by their exact lichess name, with your score (win 1, draw ½). Struggling: under 45% across 3 or more games. */
export function facedStats(games: GameLike[], book: Book | null): FacedRow[] {
  const rows = new Map<string, FacedRow>();
  const seen = new Set<string>();
  for (const g of games) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    const d = detectOpening(g.pgn, g.myColor, book);
    if (!d) continue;
    const key = `${g.myColor}|${d.name}`;
    let r = rows.get(key);
    if (!r) {
      const sans = sanList(g.pgn) ?? [];
      const fam = d.entry ? familyOf(d.entry) : familyFor(sans, d.name, g.myColor);
      const sk = fam?.skipped.find((x) => x.name === d.name);
      const exact = d.entry && (d.entry.name === d.name || d.entry.names.includes(d.name));
      r = { key, label: d.name, eco: d.eco, entry: d.entry, family: fam, myColor: g.myColor, games: 0, wins: 0, draws: 0, losses: 0, score: 0, struggling: false, differs: !exact && sk ? sk.why : undefined };
    }
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
