// "Why is this best?": compare the engine's move with the game move using only board facts (chess.js)
// and the stored Stockfish lines. Pure functions; the UI is in explorer.ts.
import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js';
import type { PosEval, Score } from './engine';
import type { Source } from './explain';
import { winPct } from './classify';
import { VAL, uciToMove, pvToSan } from './tactics';
import { nullMove, threatsAgainst, settledMaterial } from './facts';
import { describe, tokMove } from './words';
import { fmtScore } from './review';

export interface Fact { text: string; src: Source }
const NAME: Record<PieceSymbol, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const opp = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const sideName = (c: Color) => (c === 'w' ? 'White' : 'Black');
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "your"/"their" from the point of view of `viewer` (the side whose move we are explaining). */
const own = (c: Color, viewer: Color) => (c === viewer ? 'your' : 'their');
const pieceAt = (c: Chess, sq: Square, viewer: Color) => { const p = c.get(sq)!; return `${own(p.color, viewer)} ${NAME[p.type]} on ${sq}`; };

interface Threat { sq: Square; type: PieceSymbol; gain: number }
/** What the opponent of `color` could win right now in `fen` (whoever is to move), plus mate-in-one moves. */
export function threatsTo(fen: string, color: Color): { captures: Threat[]; mates: string[] } {
  const c = new Chess(fen);
  let f = fen;
  if (c.turn() !== color) { const n = nullMove(fen); if (!n) return { captures: [], mates: [] }; f = n.fen(); }
  const t = threatsAgainst(f);
  return { captures: t.captures, mates: t.mates };
}

/** Plain facts about what one move changes. Every sentence is checked on the board. */
export function moveFacts(fenBefore: string, uci: string, viewer: Color): string[] {
  const before = new Chess(fenBefore);
  const c = new Chess(fenBefore);
  const m = uciToMove(c, uci);
  if (!m) return [];
  const me = m.color, them = opp(me);
  const out: string[] = [];
  if (c.isCheckmate()) return ['it is checkmate'];
  if (m.captured) out.push(`it takes ${own(them, viewer)} ${NAME[m.captured]} on ${m.to}`);
  if (m.san.includes('+')) out.push('it gives check');
  // defends a piece that is under attack
  const defended: Square[] = [];
  for (const row of c.board()) for (const p of row) {
    if (!p || p.color !== me || p.type === 'k' || p.square === m.to) continue;
    const att = c.attackers(p.square, them);
    if (!att.length) continue;
    if (c.attackers(p.square, me).includes(m.to) && !before.attackers(p.square, me).includes(m.from)) {
      defended.push(p.square);
      out.push(`it defends ${own(me, viewer)} ${NAME[p.type]} on ${p.square}, which ${list(att.map((s) => pieceAt(c, s, viewer)))} ${att.length > 1 ? 'attack' : 'attacks'}`);
    }
  }
  // moves a piece out of attack
  const tb = threatsTo(fenBefore, me), ta = threatsTo(c.fen(), me);
  if (tb.captures.some((t) => t.sq === m.from) && !ta.captures.some((t) => t.sq === m.to)) out.push(`it moves ${own(me, viewer)} ${NAME[m.piece]} on ${m.from} out of danger`);
  // threats it stops (other than the ones already named)
  for (const t of tb.captures) if (t.sq !== m.from && !defended.includes(t.sq) && !ta.captures.some((x) => x.sq === t.sq) && c.get(t.sq)?.color === me)
    out.push(`it stops the threat to ${own(me, viewer)} ${NAME[t.type]} on ${t.sq}`);
  if (tb.mates.length && !ta.mates.length) out.push(`it stops ${own(them, viewer)} threat of mate in one`);
  // new attacks by the moved piece
  const att: string[] = [];
  for (const row of c.board()) for (const p of row) {
    if (!p || p.color !== them || p.type === 'k') continue;
    const by = c.attackers(p.square, me);
    if (!by.includes(m.to) || (m.captured && p.square === m.to)) continue;
    if (before.attackers(p.square, me).includes(m.from) && m.piece !== 'p') continue;
    const undefended = c.attackers(p.square, them).length === 0;
    if (p.type === 'p' && !undefended) continue;
    att.push(`${own(them, viewer)} ${NAME[p.type]} on ${p.square}${undefended ? ' (undefended)' : ''}`);
  }
  if (att.length) out.push(`it attacks ${list(att.slice(0, 2))}`);
  // files for rooks and queens
  if ((m.piece === 'r' || m.piece === 'q') && m.from[0] !== m.to[0]) {
    const file = m.to[0];
    let mine = 0, theirs = 0;
    for (let r = 1; r <= 8; r++) { const p = c.get(`${file}${r}` as Square); if (p?.type === 'p') p.color === me ? mine++ : theirs++; }
    if (!mine && !theirs) out.push(`it puts the ${NAME[m.piece]} on the open ${file}-file`);
    else if (!mine) out.push(`it puts the ${NAME[m.piece]} on the half-open ${file}-file`);
  }
  if (m.flags.includes('k') || m.flags.includes('q')) out.push('it castles, moving the king to safety');
  return out;
}

/** Threats against the mover that are still there (or new) after a move. */
export function threatsLeft(fenBefore: string, uci: string, viewer: Color): { still: string[]; created: string[]; mate: boolean } {
  const c = new Chess(fenBefore);
  const m = uciToMove(c, uci);
  if (!m) return { still: [], created: [], mate: false };
  const me = m.color;
  const tb = threatsTo(fenBefore, me), ta = threatsTo(c.fen(), me);
  const still: string[] = [], created: string[] = [];
  for (const t of ta.captures) {
    const p = c.get(t.sq)!;
    const by = c.attackers(t.sq, opp(me)).map((s) => pieceAt(c, s, viewer));
    const def = c.attackers(t.sq, me).length;
    const txt = `${own(me, viewer)} ${NAME[p.type]} on ${t.sq} is attacked by ${list(by)}${def ? '' : ' and has no defender'}`;
    (tb.captures.some((x) => x.sq === t.sq) && t.sq !== m.to ? still : created).push(txt);
  }
  return { still, created, mate: ta.mates.length > 0 };
}

export interface Step { fenBefore: string; fenAfter: string; uci: string; san: string; tok: string; text: string }
/** One step per move of a line, each with a plain-English description and the facts it changes. */
export function stepLine(fen: string, pv: string[], viewer: Color, max = 6): Step[] {
  const c = new Chess(fen);
  const out: Step[] = [];
  for (const u of pv.slice(0, max)) {
    const fb = c.fen();
    const mv: Move | null = uciToMove(c, u);
    if (!mv) break;
    const facts = moveFacts(fb, u, viewer).filter((f) => !f.startsWith('it takes') && f !== 'it gives check');
    const head = describe(mv).full;
    out.push({ fenBefore: fb, fenAfter: c.fen(), uci: u, san: mv.san, tok: tokMove(fb, mv.san), text: `${head}${facts.length ? `: ${facts.slice(0, 2).join('; ')}` : ''}.` });
  }
  return out;
}

export interface Side {
  uci: string; san: string; tok: string;
  score: Score; wp: number; // mover POV
  facts: string[]; // what the move does
  reply: { uci: string; tok: string; facts: string[] } | null; // opponent's best answer
  material: number; // settled material for the mover along the line (points)
  left: { still: string[]; created: string[]; mate: boolean };
  line: string[]; // UCI from fenBefore, starting with this move
}

export interface Explore {
  fen: string; mover: Color; same: boolean;
  best: Side; played: Side;
  gap: number; // win% points between best and played (mover POV)
  verdict: Fact; // honest size of the difference
  compare: Fact[]; // why the best move is better, concretely
  threat: Fact; // what was threatened before the move
  alternatives: { uci: string; tok: string; score: Score; wp: number }[];
}

function side(fen: string, line: string[], score: Score, mover: Color): Side {
  const c = new Chess(fen);
  const mv = uciToMove(c, line[0])!;
  const afterFen = c.fen();
  const r = line[1];
  return {
    uci: line[0], san: mv.san, tok: tokMove(fen, mv.san), score, wp: winPct(score, mover),
    facts: moveFacts(fen, line[0], mover),
    reply: r && uciToMove(new Chess(afterFen), r) ? { uci: r, tok: tokMove(afterFen, pvToSan(afterFen, [r], 1)[0]), facts: moveFacts(afterFen, r, mover) } : null,
    material: settledMaterial(fen, line, mover, 12).net,
    left: threatsLeft(fen, line[0], mover),
    line,
  };
}

export function threatText(fen: string, viewer: Color): Fact {
  const c = new Chess(fen);
  const me = c.turn();
  if (c.inCheck()) return { text: `${sideName(me)} was in check, so the move had to deal with that first.`, src: 'rules' };
  const t = threatsTo(fen, me);
  const parts: string[] = [];
  if (t.mates.length) { const n = nullMove(fen)!; parts.push(`${own(opp(me), viewer)} side threatened checkmate with ${tokMove(n.fen(), pvToSan(n.fen(), [t.mates[0]], 1)[0])}`); }
  for (const x of t.captures.slice(0, 3)) {
    const by = c.attackers(x.sq, opp(me)).map((s) => pieceAt(c, s, viewer));
    const def = c.attackers(x.sq, me).map((s) => pieceAt(c, s, viewer));
    parts.push(`${own(me, viewer)} ${NAME[x.type]} on ${x.sq} was attacked by ${list(by)} and ${def.length ? `defended only by ${list(def)}` : 'had no defender'}`);
  }
  if (!parts.length) return { text: 'Nothing was directly threatened: no piece could be won at once and there was no mate in one.', src: 'rules' };
  return { text: `Before the move, ${parts.join('; ')}.`, src: 'rules' };
}

const pct = (x: number) => `${Math.round(x)}%`;

/** An engine score from the mover's side (+ is good for the mover), e.g. "+2.8". */
export function povScore(s: Score, mover: Color): string {
  if (mover === 'w' || !s) return fmtScore(s);
  return fmtScore({ ...s, cp: -s.cp, mate: s.mate === null ? null : s.mate === 0 ? 0 : -s.mate });
}

/** How big the difference really is, said plainly. Numbers are rounded the same way they are shown. */
export function gapVerdict(best: Side, played: Side, mover: Color): Fact {
  const bw = Math.round(best.wp), pw = Math.round(played.wp);
  const gap = bw - pw;
  const both = (lo: number, hi: number) => (best.wp <= lo && played.wp <= lo) || (best.wp >= hi && played.wp >= hi);
  const size = gap < 3 || both(5, 95) ? 'tiny' : gap < 10 ? 'modest' : gap < 20 ? 'clear' : 'big';
  const state = best.wp <= 25 && played.wp <= 25 ? ` ${sideName(mover)} is losing either way.` : best.wp >= 75 && played.wp >= 75 ? ` ${sideName(mover)} is winning either way.` : '';
  const less = gap <= 0 ? 'about the same' : `${gap} point${gap === 1 ? '' : 's'} less`;
  return { text: `The difference is ${size}. ${best.tok} keeps the win chance at ${bw}% (${povScore(best.score, mover)}); ${played.tok} gives ${pw}% (${povScore(played.score, mover)}), ${less}.${state}`, src: 'engine' };
}

export function buildExplore(fen: string, playedUci: string, before: PosEval, after: PosEval | null): Explore | null {
  const mover = new Chess(fen).turn();
  const b = before.lines[0];
  if (!b?.pv.length) return null;
  const same = b.pv[0] === playedUci;
  const pl = before.lines.find((l) => l.pv[0] === playedUci);
  const pLine = pl ? pl.pv : [playedUci, ...(after?.lines[0]?.pv ?? [])];
  const pScore = pl ? pl.score : after?.lines[0]?.score ?? b.score;
  const best = side(fen, b.pv, b.score, mover);
  const played = side(fen, pLine, pScore, mover);
  const compare: Fact[] = [];
  if (!same) {
    // 1. threats the game move left that the best move dealt with
    const fixed = played.left.still.filter((s) => !best.left.still.includes(s));
    if (fixed.length) {
      const sq = /on ([a-h][1-8])/.exec(fixed[0])?.[1];
      const how = best.facts.find((f) => sq && f.includes(` on ${sq}`) && !f.startsWith('it attacks'));
      compare.push({ text: `After ${played.tok}, ${fixed[0]}. ${how ? `${best.tok} ${how.startsWith('it defends') ? 'defends it' : how.startsWith('it moves') ? 'moves it out of danger' : how.replace(/^it /, '')}.` : `${best.tok} deals with that.`}`, src: 'rules' });
    }
    const made = played.left.created.filter((s) => !best.left.created.includes(s) && !best.left.still.includes(s));
    if (made.length) compare.push({ text: `${played.tok} creates a new target: ${made[0]}.`, src: 'rules' });
    if (played.left.mate && !best.left.mate) compare.push({ text: `After ${played.tok} they threaten mate in one; after ${best.tok} they do not.`, src: 'rules' });
    if (!compare.length) compare.push({ text: `No immediate threat or capture separates ${best.tok} from ${played.tok}; the engine's edge shows further into its line.`, src: 'engine' });
    // 2. replies
    if (best.reply && played.reply) {
      if (best.reply.uci === played.reply.uci) {
        const shared = played.reply.facts.filter((f) => best.reply!.facts.includes(f));
        compare.push({ text: `Their best reply is ${played.reply.tok} in both cases${shared.length ? ` (${shared[0]})` : ''}, so the difference is in the rest of the position, not the reply.`, src: 'engine' });
      }
      else {
        compare.push({ text: `After ${played.tok}, their best reply is ${played.reply.tok}${played.reply.facts.length ? `: ${played.reply.facts.slice(0, 2).join('; ')}` : ''}.`, src: 'engine' });
        const legal = !!uciToMove(new Chess(stepLine(fen, [best.uci], mover)[0].fenAfter), played.reply.uci);
        compare.push({ text: `After ${best.tok}, ${legal ? `the engine prefers ${best.reply.tok} instead` : `${played.reply.tok} is not possible, and the engine answers ${best.reply.tok}`}${best.reply.facts.length ? `: ${best.reply.facts.slice(0, 2).join('; ')}` : ''}.`, src: 'engine' });
      }
    }
    // 3. material along each line (only when clearly in the best move's favour)
    const dm = best.material - played.material;
    if (dm >= 2) compare.push({ text: `Along the engine lines, ${sideName(mover)} ends up ${dm} points of material better off after ${best.tok} than after ${played.tok}.`, src: 'engine' });
    // 4. what the game move did instead
    if (played.facts.length) {
      const away = played.reply?.facts.find((f) => f.includes('out of danger'));
      compare.push({ text: `${played.tok} does do something: ${played.facts.slice(0, 2).join('; ')}${away && played.reply ? `, but ${played.reply.tok} simply ${away.replace(/^it /, '')}` : ''}.`, src: 'rules' });
    }
  }
  const alternatives = before.lines.slice(1).map((l) => { const s = pvToSan(fen, l.pv, 1)[0]; return { uci: l.pv[0], tok: tokMove(fen, s), score: l.score, wp: winPct(l.score, mover) }; });
  const close = alternatives.filter((a) => best.wp - a.wp < 3 && a.uci !== playedUci);
  const verdict = gapVerdict(best, played, mover);
  if (!same && close.length) verdict.text += ` ${cap(list(close.map((a) => a.tok)))} ${close.length > 1 ? 'are' : 'is'} almost as good, so ${best.tok} is not the only good move.`;
  return { fen, mover, same, best, played, gap: best.wp - played.wp, verdict, compare: compare.slice(0, 5), threat: threatText(fen, mover), alternatives };
}

/** "What if I play X?": the engine's answer for a move tried on the board. */
export function whatIf(fen: string, uci: string, ev: PosEval, bestWp: number): { tok: string; wp: number; score: Score | null; facts: Fact[] } | null {
  const c = new Chess(fen);
  const mover = c.turn();
  const mv = uciToMove(c, uci);
  if (!mv) return null;
  const tok = tokMove(fen, mv.san);
  const facts: Fact[] = [];
  const mf = moveFacts(fen, uci, mover);
  if (mf.length) facts.push({ text: `${tok}: ${mf.slice(0, 3).join('; ')}.`, src: 'rules' });
  if (c.isCheckmate()) return { tok, wp: 100, score: null, facts: [{ text: `${tok} is checkmate.`, src: 'rules' }] };
  if (c.isDraw()) return { tok, wp: 50, score: null, facts: [{ text: `${tok} ends the game in a draw.`, src: 'rules' }] };
  const l = ev.lines[0];
  if (!l) return { tok, wp: 50, score: null, facts };
  const wp = winPct(l.score, mover);
  const d = Math.round(bestWp - wp);
  facts.push({ text: `Engine: ${povScore(l.score, mover)}, win chance ${pct(wp)} (${d <= 1 ? 'as good as the best move' : `${d} points less than the best move`}).`, src: 'engine' });
  const r = l.pv[0];
  if (r) {
    const fa = c.fen();
    const rtok = tokMove(fa, pvToSan(fa, [r], 1)[0]);
    const rf = moveFacts(fa, r, mover);
    facts.push({ text: `Their best reply is ${rtok}${rf.length ? `: ${rf.slice(0, 2).join('; ')}` : ''}.`, src: 'engine' });
  }
  const left = threatsLeft(fen, uci, mover);
  if (left.still.length || left.created.length) facts.push({ text: `After ${tok}, ${(left.still[0] ?? left.created[0])}.`, src: 'rules' });
  return { tok, wp, score: l.score, facts };
}
