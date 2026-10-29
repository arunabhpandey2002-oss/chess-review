// Plain-English move descriptions, generated only from chess.js Move objects
// (piece, from, to, captured, promotion, flags, SAN check/mate marks).
import { Chess, type Move } from 'chess.js';
import { uciToMove, formatPv } from './tactics';

const PIECE: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const side = (c: string) => (c === 'w' ? 'White' : 'Black');

/** True when the SAN needed a from-file/rank to say which piece moved. */
function disambiguated(m: Move): boolean {
  if (m.piece === 'p' || m.piece === 'k') return false;
  const core = m.san.replace(/[+#]/g, '').replace('x', '').slice(1);
  return core.length > 2;
}

export interface Words { full: string; imperative: string; gerund: string }

/** Describe one move. Every word comes from the move object. */
export function describe(m: Move): Words {
  const who = side(m.color);
  const mate = m.san.includes('#');
  const check = !mate && m.san.includes('+');
  const tail = mate ? ', checkmate' : check ? ' with check' : '';
  const promo = m.promotion ? ` and promotes to a ${PIECE[m.promotion]}` : '';
  const promoBase = m.promotion ? ` and promote to a ${PIECE[m.promotion]}` : '';
  const promoGer = m.promotion ? ` and promoting to a ${PIECE[m.promotion]}` : '';
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  if (m.flags.includes('k') || m.flags.includes('q')) {
    const w = m.flags.includes('k') ? 'kingside' : 'queenside';
    return { full: `${who} castles ${w}${tail}`, imperative: `Castle ${w}${tail}`, gerund: `castling ${w}${tail}` };
  }
  const name = m.piece === 'p' ? `${m.from[0]}-pawn` : PIECE[m.piece] + (disambiguated(m) ? ` on ${m.from}` : '');
  if (m.captured) {
    const ep = m.flags.includes('e');
    const target = ep ? `the pawn en passant on ${m.to}` : `the ${PIECE[m.captured]} on ${m.to}`;
    const t2 = mate ? ', checkmate' : check ? ', giving check' : '';
    return {
      full: `${who}'s ${name} takes ${target}${promo}${tail}`,
      imperative: `Take ${target} with the ${name}${promoBase}${t2}`,
      gerund: `taking ${target} with the ${name}${promoGer}${t2}`,
    };
  }
  if (m.piece === 'p') {
    return {
      full: `${who} pushes the ${name} to ${m.to}${promo}${tail}`,
      imperative: `Push the ${name} to ${m.to}${promoBase}${tail}`,
      gerund: `pushing the ${name} to ${m.to}${promoGer}${tail}`,
    };
  }
  if (check || mate) {
    const g = mate ? 'checkmate' : 'check';
    return {
      full: `${who}'s ${name} gives ${g} on ${m.to}`,
      imperative: `Give ${g} on ${m.to} with the ${name}`,
      gerund: `giving ${g} on ${m.to} with the ${name}`,
    };
  }
  const v = m.piece === 'k' ? ['moves', 'Move', 'moving'] : ['brings', 'Bring', 'bringing'];
  return {
    full: `${who} ${v[0]} the ${name} to ${m.to}`,
    imperative: cap(`${v[1]} the ${name} to ${m.to}`),
    gerund: `${v[2]} the ${name} to ${m.to}`,
  };
}

function movesFromSan(fen: string, sans: string[]): Move[] {
  const c = new Chess(fen);
  const out: Move[] = [];
  for (const s of sans) { try { out.push(c.move(s)); } catch { break; } }
  return out;
}

export function movesFromUci(fen: string, pv: string[], max = 99): Move[] {
  const c = new Chess(fen);
  const out: Move[] = [];
  for (const u of pv.slice(0, max)) { const m = uciToMove(c, u); if (!m) break; out.push(m); }
  return out;
}

/** Numbered list items: "White ...; Black ..." per full move, first `max` plies. */
export function lineItems(fen: string, pv: string[], max = 5): string[] {
  const ms = movesFromUci(fen, pv, max);
  const items: string[] = [];
  let cur: string[] = [];
  for (const m of ms) {
    if (m.color === 'w' && cur.length) { items.push(cur.join('; ')); cur = []; }
    cur.push(describe(m).full);
    if (m.color === 'b') { items.push(cur.join('; ')); cur = []; }
  }
  if (cur.length) items.push(cur.join('; '));
  return items;
}

// ---- tokens embedded in explanation text, rendered per display mode ----
// ⟦L|fen|san,san⟧ = a move sequence; ⟦M|fen|san⟧ = one move.
export const tokLine = (fen: string, sans: string[]) => `⟦L|${fen}|${sans.join(',')}⟧`;
export const tokMove = (fen: string, san: string) => `⟦M|${fen}|${san}⟧`;

export type TextMode = 'words' | 'san';
/** `seen` (optional) glosses each move once: the first mention gets the plain-English words, later ones just the move name. */
export function renderText(text: string, mode: TextMode, seen?: Set<string>): string {
  return text.replace(/⟦([LM])\|([^|]*)\|([^⟧]*)⟧/g, (_, kind: string, fen: string, body: string) => {
    const sans = body ? body.split(',') : [];
    if (kind === 'M') {
      if (mode === 'san') return sans[0];
      if (seen) { const k = `${fen}|${sans[0]}`; if (seen.has(k)) return sans[0]; seen.add(k); }
      const m = movesFromSan(fen, sans)[0];
      return m ? `${m.san} (${describe(m).gerund})` : sans[0];
    }
    if (mode === 'san') return formatPv(fen, sans);
    const ms = movesFromSan(fen, sans);
    const parts = ms.map((m) => describe(m).full);
    if (parts.length > 1) parts[parts.length - 1] = 'then ' + parts[parts.length - 1];
    return parts.join(', ');
  });
}
