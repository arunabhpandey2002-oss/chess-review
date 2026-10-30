// Material ledger: walks a line move by move and records every capture, then labels each one
// (free capture, equal exchange, recapture, temporary or genuine sacrifice) and checks the total
// against the material actually on the board at the end of the line. Every material claim in an
// explanation must come from here.
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import { VAL, NAME, uciToMove } from './tactics';

export type CaptureKind = 'capture' | 'exchange' | 'recapture' | 'sacrifice-temp' | 'sacrifice-genuine' | 'promotion';
export interface LedgerEvent {
  ply: number; // 1-based within the line
  by: Color;
  piece: PieceSymbol; // capturing piece
  captured?: PieceSymbol; // captured piece (absent for a non-capturing promotion)
  sq: Square;
  san: string;
  kind: CaptureKind;
  promotion?: PieceSymbol;
}
export interface PieceLoss { color: Color; type: PieceSymbol; sq: Square; ply: number }
export interface Ledger {
  pov: Color;
  plies: number; // plies actually walked
  events: LedgerEvent[];
  /** Material change for `pov` (own gains minus own losses), in pawns. */
  netChange: number;
  /** Same number computed from the start and final boards; must equal netChange. */
  boardNet: number;
  finalCheck: boolean;
  lost: PieceLoss[]; // pov pieces lost and not paid back
  won: PieceLoss[]; // opponent pieces won and not paid back
  exchanged: { mine: PieceLoss; theirs: PieceLoss }[];
  queenTrade: boolean;
  /** pov gave material first and got at least as much back by the end of the line. */
  tempSacrifice: boolean;
  /** pov is down material at the end of the line after giving it voluntarily. */
  genuineSacrifice: boolean;
  finalFen: string;
  mate: boolean;
}

const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');
export const SIDE = (c: Color) => (c === 'w' ? 'White' : 'Black');
export const pieceWord = (p: PieceLoss | { color: Color; type: PieceSymbol }) => `${SIDE(p.color).toLowerCase()} ${NAME[p.type]}`;

function mat(c: Chess, color: Color): number {
  let s = 0;
  for (const row of c.board()) for (const p of row) if (p && p.color === color) s += VAL[p.type];
  return s;
}

/**
 * Walk `pv` (UCI) from `fen`. Stops after `maxPlies`, but keeps going (up to 4 more plies) while the
 * last move was a capture, so an exchange is never cut in half.
 */
export function ledger(fen: string, pv: string[], pov: Color, maxPlies = 10): Ledger {
  const c = new Chess(fen);
  const startMine = mat(c, pov), startTheirs = mat(c, other(pov));
  const events: LedgerEvent[] = [];
  let i = 0;
  for (; i < pv.length; i++) {
    const lastCap = events.length && events[events.length - 1].ply === i;
    if (i >= maxPlies && !(lastCap && i < maxPlies + 4)) break;
    const m = uciToMove(c, pv[i]);
    if (!m) break;
    if (m.captured || m.promotion) {
      events.push({ ply: i + 1, by: m.color, piece: m.piece, captured: m.captured, sq: m.flags.includes('e') ? (m.to[0] + m.from[1]) as Square : m.to, san: m.san, kind: m.captured ? 'capture' : 'promotion', promotion: m.promotion });
    }
  }
  const plies = i;
  // Pair each capture with an immediate recapture on the same square.
  for (let k = 1; k < events.length; k++) {
    const a = events[k - 1], b = events[k];
    if (b.captured && a.captured && b.ply === a.ply + 1 && b.sq === a.sq && b.by !== a.by) {
      b.kind = 'recapture';
      if (VAL[a.captured] === VAL[b.captured]) { a.kind = 'exchange'; b.kind = 'exchange'; }
    }
  }
  const mineLost: PieceLoss[] = [], theirsLost: PieceLoss[] = [];
  let promoMine = 0, promoTheirs = 0;
  for (const e of events) {
    if (e.captured) (e.by === pov ? theirsLost : mineLost).push({ color: other(e.by), type: e.captured, sq: e.sq, ply: e.ply });
    if (e.promotion) { if (e.by === pov) promoMine += VAL[e.promotion] - 1; else promoTheirs += VAL[e.promotion] - 1; }
  }
  // Match equal-value losses as exchanges (queen for queen, minor for minor, …).
  const exchanged: Ledger['exchanged'] = [];
  const restMine = [...mineLost], restTheirs = [...theirsLost];
  for (const v of [9, 5, 3, 1]) {
    for (;;) {
      const a = restMine.findIndex((p) => VAL[p.type] === v);
      const b = restTheirs.findIndex((p) => VAL[p.type] === v);
      if (a < 0 || b < 0) break;
      exchanged.push({ mine: restMine[a], theirs: restTheirs[b] });
      restMine.splice(a, 1); restTheirs.splice(b, 1);
    }
  }
  const sum = (xs: PieceLoss[]) => xs.reduce((s, p) => s + VAL[p.type], 0);
  const netChange = sum(theirsLost) - sum(mineLost) + promoMine - promoTheirs;
  const boardNet = (mat(c, pov) - startMine) - (mat(c, other(pov)) - startTheirs);
  // Sacrifice: pov's first material-relevant event is losing material that is not taken back at once.
  let tempSacrifice = false, genuineSacrifice = false;
  let running = 0, minRunning = 0;
  for (const e of events) {
    if (!e.captured) continue;
    running += e.by === pov ? VAL[e.captured] : -VAL[e.captured];
    if (running < minRunning) minRunning = running;
  }
  // A sacrifice needs pov to have put the piece en prise voluntarily: the first capture is by the opponent
  // on a pov move's destination square, and pov does not recapture an equal value straight away.
  const first = events.find((e) => e.captured);
  if (first && first.by !== pov && minRunning <= -2) {
    if (netChange >= 0) tempSacrifice = true;
    else genuineSacrifice = true;
  }
  for (const e of events) if (e.captured && e.by !== pov && (tempSacrifice || genuineSacrifice) && e === first) e.kind = tempSacrifice ? 'sacrifice-temp' : 'sacrifice-genuine';
  // Unmatched losses.
  return {
    pov, plies, events, netChange, boardNet, finalCheck: netChange === boardNet,
    lost: restMine, won: restTheirs, exchanged,
    queenTrade: exchanged.some((x) => x.mine.type === 'q' && x.theirs.type === 'q'),
    tempSacrifice, genuineSacrifice, finalFen: c.fen(), mate: c.isCheckmate(),
  };
}

const ART = (t: PieceSymbol) => (t === 'p' ? 'a pawn' : t === 'q' ? 'the queen' : `a ${NAME[t]}`);
export function amountWords(n: number): string {
  const a = Math.abs(n);
  const W: Record<number, string> = { 0: 'even material', 1: 'a pawn', 2: 'two pawns', 3: 'a piece', 4: 'a piece and a pawn', 5: 'a rook', 9: 'a queen' };
  return W[a] ?? `${a} points of material`;
}

/**
 * One plain sentence describing the captures in the line in the order they happen, from `pov`'s side ("you"),
 * then the material result. A queen trade is always named as a trade, never as a queen won.
 */
export function ledgerSentence(L: Ledger): string | null {
  const caps = L.events.filter((e) => e.captured || e.promotion);
  if (!caps.length) return null;
  const parts: string[] = [];
  const mine = (c: Color) => c === L.pov;
  for (let i = 0; i < caps.length && parts.length < 4; i++) {
    const e = caps[i], n = caps[i + 1];
    if (e.captured && n?.captured && n.ply === e.ply + 1 && n.by !== e.by && VAL[n.captured] === VAL[e.captured]) {
      const mineT = mine(e.by) ? n.captured : e.captured, theirT = mine(e.by) ? e.captured : n.captured;
      parts.push(mineT === 'q' && theirT === 'q' ? 'the queens are traded' : mineT === theirT ? `a pair of ${NAME[mineT]}s is traded` : `your ${NAME[mineT]} is traded for their ${NAME[theirT]}`);
      i++; continue;
    }
    if (e.captured) parts.push(mine(e.by) ? `you take their ${NAME[e.captured]} on ${e.sq}` : `they take your ${NAME[e.captured]} on ${e.sq}`);
    if (e.promotion) parts.push(mine(e.by) ? `you promote to a ${NAME[e.promotion]}` : `they promote to a ${NAME[e.promotion]}`);
  }
  const more = caps.length > 0 && parts.length >= 4 && caps.length > parts.length ? ' and more trades follow' : '';
  const net = L.netChange;
  const tail = net === 0 ? 'material stays level' : net > 0 ? `you end up ${amountWords(net)} ahead` : `you end up ${amountWords(net)} down`;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, then ${parts[parts.length - 1]}` : parts[0];
  return `${list}${more}; ${tail}`;
}

/** What the pov side gives up, in plain words: "your queen for a bishop", "your knight", or an amount. */
export function lossPhrase(L: Ledger): string {
  if (L.lost.length === 1 && L.won.length === 0 && L.netChange === -VAL[L.lost[0].type]) return `your ${NAME[L.lost[0].type]}`;
  if (L.lost.length === 1 && L.won.length === 1 && L.netChange === VAL[L.won[0].type] - VAL[L.lost[0].type]) return `your ${NAME[L.lost[0].type]} for a ${NAME[L.won[0].type]}`;
  return amountWords(L.netChange);
}

export { ART };
