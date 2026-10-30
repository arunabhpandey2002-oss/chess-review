// Fact-checking for generated explanations. Every rule reads the prose (with move tokens) and compares it
// with the evidence record, the board, and the engine lines. Any violation makes the caller fall back to the concrete line.
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import { pvToSan, uciToMove, NAME } from './tactics';
import { lineMates } from './facts';
import { amountWords, lossPhrase } from './ledger';
import type { Evidence, ExplanationRecord } from './evidence';

export interface Violation { rule: string; detail: string; section?: string }

export const BANNED = [
  'the engine prefers another move', 'there is no single tactic', 'follow the line below', 'this move is inaccurate',
  'loses material.', 'was a mistake because it was bad', 'as an ai', 'obviously', 'clearly winning for no reason',
];
const TOK = /⟦([LM])\|([^|]*)\|([^⟧]*)⟧/g;
const TYPE: Record<string, PieceSymbol> = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
const key = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
const opp = (c: Color): Color => (c === 'w' ? 'b' : 'w');

/** Every known engine/game line as (fen → remaining SAN) suffixes, plus all positions along them. */
function known(ev: Evidence) {
  const { m } = ev;
  const seqs: { fen: string; sans: string[] }[] = [];
  const positions: string[] = [m.fenBefore, m.fenAfter];
  const add = (fen: string, pv: string[]) => {
    const sans = pvToSan(fen, pv, 16);
    const c = new Chess(fen);
    for (let i = 0; i < sans.length; i++) {
      seqs.push({ fen: key(c.fen()), sans: sans.slice(i) });
      try { c.move(sans[i]); } catch { break; }
      positions.push(c.fen());
    }
  };
  add(m.fenBefore, [m.playedUci, ...(m.reply?.pv ?? [])]);
  for (const l of m.lines) add(m.fenBefore, l.pv);
  if (m.prevFen && m.prevUci) add(m.prevFen, [m.prevUci]);
  return { seqs, positions };
}

export function tokens(text: string) {
  const out: { kind: string; fen: string; sans: string[] }[] = [];
  for (const x of text.matchAll(TOK)) out.push({ kind: x[1], fen: x[2], sans: x[3].split(',').filter(Boolean) });
  return out;
}
export const stripTokens = (text: string) => text.replace(TOK, (_, k, _f, b) => (k === 'M' ? `«${b}»` : '«line»'));

export function checkSection(text: string, ev: Evidence, sectionId = ''): Violation[] {
  const v: Violation[] = [];
  const { rec, m, replyL, bestL } = ev;
  const me = m.color, them = opp(me);
  const K = known(ev);
  // 1-2. every move token is legal and comes from the game or an engine line
  for (const t of tokens(text)) {
    const c = new Chess(t.fen);
    for (const s of t.sans) { try { c.move(s); } catch { v.push({ rule: 'illegal-move', detail: `${s} from ${t.fen}` }); break; } }
    const ok = K.seqs.some((q) => q.fen === key(t.fen) && t.sans.every((s, i) => q.sans[i] === s));
    if (!ok) v.push({ rule: 'move-not-in-line', detail: t.sans.join(' ') });
  }
  const s = stripTokens(text);
  const low = s.toLowerCase();
  // 3. banned shallow phrases
  for (const b of BANNED) if (low.includes(b)) v.push({ rule: 'banned-phrase', detail: b });
  if (sectionId === 'notice') return v;
  // 4. mate claims
  const mateNs = [...s.matchAll(/mate in (\d+)/g)].map((x) => +x[1]);
  for (const n of mateNs) if (n !== rec.mateIn && n !== rec.bestMateIn) v.push({ rule: 'mate-claim', detail: `mate in ${n}` });
  if (/\bmate\b/i.test(s.replace(/«[^»]*»/g, '')) && rec.mateIn == null && rec.bestMateIn == null && !/stops the mate/.test(s)) v.push({ rule: 'mate-claim', detail: 'mentions mate without an engine mate' });
  if (/stops the mate/.test(s)) {
    const b = m.lines[0];
    const lm = b ? lineMates(m.fenBefore, b.pv, 11) : null;
    if (rec.mateIn == null || (lm && lm.mover === them) || (b && b.score.mate !== null && (me === 'w' ? b.score.mate < 0 : b.score.mate > 0))) v.push({ rule: 'mate-claim', detail: 'best move does not stop the mate' });
  }
  // 5. queen won vs exchanged
  for (const x of s.matchAll(/\b(win|wins|won|winning|lose|loses|lost) (?:the|your|their|a) queen\b/gi)) {
    const lostQ = replyL.lost.some((p) => p.type === 'q') || bestL.lost.some((p) => p.type === 'q');
    const wonQ = replyL.won.some((p) => p.type === 'q') || bestL.won.some((p) => p.type === 'q');
    if (!(/win|won/i.test(x[1]) ? wonQ || lostQ : lostQ)) v.push({ rule: 'queen-claim', detail: x[0] });
  }
  // 6. captured-piece claims must match a ledger event
  const evs = [...replyL.events, ...bestL.events];
  for (const x of s.matchAll(/they (?:take|win) your (\w+) on ([a-h][1-8])/g)) {
    if (!evs.some((e) => e.by === them && e.captured === TYPE[x[1]] && e.sq === x[2])) v.push({ rule: 'capture-claim', detail: x[0] });
  }
  for (const x of s.matchAll(/you (?:take|win) their (\w+) on ([a-h][1-8])/g)) {
    if (!evs.some((e) => e.by === me && e.captured === TYPE[x[1]] && e.sq === x[2])) v.push({ rule: 'capture-claim', detail: x[0] });
  }
  if (/the queens are traded/.test(s) && !evs.some((e, i) => e.captured === 'q' && evs[i + 1]?.captured === 'q')) v.push({ rule: 'queen-claim', detail: 'queen trade not in ledger' });
  // 7. material amounts must equal the ledger
  const nets = [replyL.netChange, bestL.netChange];
  for (const x of s.matchAll(/end up (.+?) (ahead|down)/g)) {
    if (!nets.some((n) => (x[2] === 'ahead' ? n > 0 : n < 0) && amountWords(n) === x[1])) v.push({ rule: 'material-amount', detail: x[0] });
  }
  for (const x of s.matchAll(/It loses (.+?)\./g)) if (!(replyL.netChange < 0 && (amountWords(replyL.netChange) === x[1] || lossPhrase(replyL) === x[1]))) v.push({ rule: 'material-amount', detail: x[0] });
  
  if (/material stays level/.test(s) && !nets.includes(0)) v.push({ rule: 'material-amount', detail: 'material stays level' });
  // 8. "your/their <piece> on <sq>" must exist there in some position of the game or engine lines
  for (const x of s.matchAll(/\b(your|their) (pawn|knight|bishop|rook|queen|king) on ([a-h][1-8])/g)) {
    const col = x[1] === 'your' ? me : them;
    const ok = K.positions.some((f) => { const p = new Chess(f).get(x[3] as Square); return !!p && p.color === col && p.type === TYPE[x[2]]; });
    if (!ok) v.push({ rule: 'piece-on-square', detail: x[0] });
  }
  // 9. attack / defence claims
  for (const x of s.matchAll(/your (\w+) on ([a-h][1-8]) was already attacked/g)) {
    if (!new Chess(m.fenBefore).attackers(x[2] as Square, them).length) v.push({ rule: 'attack-claim', detail: x[0] });
  }
  if (/nothing defends it|has no defender/.test(s) && (ev.f.target?.defenders.length ?? 1) > 0) v.push({ rule: 'defence-claim', detail: 'says undefended' });
  if (/you lose nothing|no way to win material/.test(s) && (bestL.lost.length > 0 || bestL.netChange < 0)) v.push({ rule: 'solution-claim', detail: 'best line still loses material' });
  // 10. forced / only move
  if (/\bonly move\b|\bforced\b(?! mate)/.test(s) && !rec.onlyMove) v.push({ rule: 'forced-claim', detail: 'says forced or only move' });
  // 11. sacrifice
  if (/sacrific/.test(low) && !(replyL.tempSacrifice || replyL.genuineSacrifice || bestL.tempSacrifice || bestL.genuineSacrifice)) v.push({ rule: 'sacrifice-claim', detail: 'no sacrifice in the ledger' });
  // 12. the recommended move must solve the stated problem: if it "moves your X off sq", the X must not be lost early in the best line
  for (const x of s.matchAll(/moves your (\w+) off ([a-h][1-8])/g)) {
    if (bestL.lost.some((p) => p.type === TYPE[x[1]] && p.ply <= 4)) v.push({ rule: 'solution-claim', detail: x[0] });
  }
  return v;
}

/** Structural checks on the record itself. */
export function checkRecord(rec: ExplanationRecord, ev: Evidence): Violation[] {
  const v: Violation[] = [];
  const c = new Chess(rec.position.fen);
  if ((c.turn() === 'w' ? 'white' : 'black') !== rec.position.sideToMove) v.push({ rule: 'side-to-move', detail: rec.position.sideToMove });
  if (rec.position.legalMoves !== c.moves().length) v.push({ rule: 'legal-count', detail: String(rec.position.legalMoves) });
  if (!rec.playedMove.legal || !uciToMove(new Chess(rec.position.fen), rec.playedMove.uci)) v.push({ rule: 'illegal-move', detail: rec.playedMove.uci });
  if (rec.bestMoves[0] && rec.bestMoves[0].uci !== ev.m.bestUci) v.push({ rule: 'best-mismatch', detail: rec.bestMoves[0].uci });
  if (rec.materialOutcome.queenTrade && rec.materialOutcome.lost.some((x) => x.endsWith(`queen on ${x.slice(-2)}`)) && !rec.materialOutcome.won.some((x) => / queen /.test(x))) {
    // a traded queen must never be counted only as lost
    if (ev.replyL.lost.filter((p) => p.type === 'q').length > ev.replyL.won.filter((p) => p.type === 'q').length) v.push({ rule: 'queen-trade', detail: 'queen trade counted as loss' });
  }
  for (const p of ev.replyL.lost) {
    if (p.color !== ev.m.color) v.push({ rule: 'ledger-color', detail: `${NAME[p.type]} ${p.sq}` });
  }
  if (rec.confidence < 0 || rec.confidence > 1) v.push({ rule: 'confidence-range', detail: String(rec.confidence) });
  return v;
}
