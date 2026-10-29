// Turns per-position engine evaluations into per-move classifications + explanations.
import { Chess, type Move, type Color } from 'chess.js';
import type { PosEval, Score } from './engine';
import { winPct, T, type Cls, gameAccuracy } from './classify';
import {
  material, NAME, VAL, pvToSan, formatPv, materialAlongPv, sacrifice, forkTargets, isRecapture, isObviousCapture, hangingAfter, uciToMove, winnableTargets,
} from './tactics';
import { tokLine, tokMove } from './words';

export interface Ply {
  index: number; // 1-based ply
  color: Color;
  san: string;
  uci: string;
  from: string;
  to: string;
  fenBefore: string;
  fenAfter: string;
  move: Move;
  legalCount: number;
  moveNumber: number;
  clock?: string;
}

export interface MoveReview {
  cls: Cls;
  loss: number; // win% lost by the mover
  wpBefore: number; // mover POV, best play
  wpAfter: number; // mover POV after the played move
  bestUci: string | null;
  bestSan: string | null;
  bestPvSan: string; // formatted
  playedPvSan: string; // opponent's best reply line after the played move
  bestPv: string[]; // UCI, from fenBefore
  playedPv: string[]; // UCI reply line, from fenAfter
  fenBefore: string;
  fenAfter: string;
  explanation: string;
  scoreAfter: Score | null; // white POV
  isBestMove: boolean;
}

export type Book = Record<string, string>;
export const bookKey = (fen: string) => fen.split(' ').slice(0, 3).join(' ');

export function parseGame(pgn: string): { plies: Ply[]; startFen: string; headers: Record<string, string> } {
  const c = new Chess();
  c.loadPgn(pgn);
  const headers = c.getHeaders();
  const comments = c.getComments();
  const clockByFen = new Map<string, string>();
  for (const cm of comments) {
    const m = /%clk\s+([0-9:.]+)/.exec(cm.comment);
    if (m) clockByFen.set(cm.fen, m[1]);
  }
  const hist = c.history({ verbose: true });
  const startFen = hist.length ? hist[0].before : c.fen();
  const plies: Ply[] = [];
  const walker = new Chess(startFen);
  hist.forEach((m, i) => {
    const legalCount = walker.moves().length;
    const moveNumber = +walker.fen().split(' ')[5];
    walker.move(m.san);
    plies.push({
      index: i + 1, color: m.color, san: m.san, uci: m.from + m.to + (m.promotion ?? ''),
      from: m.from, to: m.to, fenBefore: m.before, fenAfter: m.after, move: m, legalCount, moveNumber,
      clock: clockByFen.get(m.after),
    });
  });
  return { plies, startFen, headers };
}

/** Evaluation for terminal positions (no engine needed). */
export function terminalEval(fen: string): PosEval | null {
  const c = new Chess(fen);
  if (c.isCheckmate()) {
    const whiteMated = c.turn() === 'w';
    return { lines: [{ score: { cp: whiteMated ? -100000 : 100000, mate: 0 }, pv: [], depth: 0 }], depth: 0, terminal: 'checkmate' };
  }
  if (c.isStalemate() || c.isInsufficientMaterial() || c.isThreefoldRepetition() || c.isDrawByFiftyMoves()) {
    return { lines: [{ score: { cp: 0, mate: null }, pv: [], depth: 0 }], depth: 0, terminal: c.isStalemate() ? 'stalemate' : 'draw' };
  }
  return null;
}

/** Cancel out equal piece types captured by both sides so only the net trade is described. */
function netPieces(gained: string[], lost: string[]): [string[], string[]] {
  const g = [...gained], l = [...lost];
  for (let i = g.length - 1; i >= 0; i--) {
    const j = l.indexOf(g[i]);
    if (j >= 0) { l.splice(j, 1); g.splice(i, 1); }
  }
  return [g, l];
}

const side = (c: Color) => (c === 'w' ? 'White' : 'Black');
const pieceList = (ps: string[]) => {
  const sorted = [...ps].sort((a, b) => VAL[b as keyof typeof VAL] - VAL[a as keyof typeof VAL]);
  const names = sorted.map((p) => NAME[p as keyof typeof NAME]);
  if (names.length === 1) return `a ${names[0]}`.replace('a queen', 'the queen');
  const counts = new Map<string, number>();
  names.forEach((n) => counts.set(n, (counts.get(n) ?? 0) + 1));
  return [...counts].map(([n, k]) => (k > 1 ? `${k} ${n}s` : n === 'queen' ? 'the queen' : `a ${n}`)).join(' and ');
};

export function fmtScore(s: Score | null | undefined): string {
  if (!s) return '';
  if (s.mate !== null) {
    if (s.mate === 0) return s.cp > 0 ? '1-0' : '0-1';
    return (s.mate > 0 ? '+' : '-') + 'M' + Math.abs(s.mate);
  }
  const v = s.cp / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
}

export function evalWords(s: Score, pov: Color): string {
  void pov;
  if (s.mate !== null && s.mate !== 0) return `a forced mate in ${Math.abs(s.mate)} for ${s.mate > 0 ? 'White' : 'Black'}`;
  const a = Math.abs(s.cp);
  const who = s.cp > 0 ? 'White' : 'Black';
  const txt = fmtScore(s);
  if (a < 40) return `equal (${txt})`;
  if (a < 120) return `slightly better for ${who} (${txt})`;
  if (a < 300) return `clearly better for ${who} (${txt})`;
  return `winning for ${who} (${txt})`;
}

/** Engine eval from pov in pawns (mates mapped to +/-100). */
export function povPawns(s: Score, pov: Color): number {
  const cp = pov === 'w' ? s.cp : -s.cp;
  return Math.max(-100, Math.min(100, cp / 100));
}

export function balance(fen: string, pov: Color): number {
  const c = new Chess(fen);
  return material(c, pov) - material(c, pov === 'w' ? 'b' : 'w');
}

/** What makes a given line good for `pov`, in concrete terms. Claims are only made when the
 *  engine evaluation agrees with the material outcome of the line. */
export function lineFacts(fen: string, line: { score: Score; pv: string[] } | undefined, pov: Color, prev: Move | null): string | null {
  if (!line || !line.pv.length) return null;
  const s = line.score;
  const c = new Chess(fen);
  const first = uciToMove(c, line.pv[0]);
  if (!first) return null;
  if (c.isCheckmate()) return `it is checkmate`;
  if (s.mate !== null && s.mate !== 0) {
    const forPov = (s.mate > 0) === (pov === 'w');
    if (forPov) return `it forces mate in ${Math.abs(s.mate)} (${tokLine(fen, pvToSan(fen, line.pv, Math.min(line.pv.length, 7)))})`;
    return `it resists the longest, though ${side(pov === 'w' ? 'b' : 'w')} still has mate in ${Math.abs(s.mate)}`;
  }
  const fork = forkTargets(fen, line.pv[0]);
  const swing = materialAlongPv(fen, line.pv, pov);
  const e = povPawns(s, pov);
  const consistent = e >= balance(fen, pov) + swing.net - 2.5;
  const parts: string[] = [];
  if (fork && consistent) {
    const names = fork.slice(0, 3).map((t) => (t === 'k' ? 'king' : NAME[t]));
    parts.push(`the ${NAME[first.piece]} forks the ${names.join(' and ')}`);
  }
  if (first.captured && swing.plies <= 1) {
    parts.push(isRecapture(prev, line.pv[0]) ? `it recaptures the ${NAME[first.captured]}` : `it takes the ${NAME[first.captured]} on ${first.to}`);
  } else if (swing.net >= 1 && consistent) {
    const [ng, nl] = netPieces(swing.gained, swing.lost);
    const g = ng.length ? pieceList(ng) : 'material';
    const l = nl.length ? ` for ${pieceList(nl)}` : '';
    parts.push(`it wins ${g}${l} (${tokLine(fen, swing.sans)})`);
  } else if (first.captured && swing.net >= 0) {
    parts.push(isRecapture(prev, line.pv[0]) ? `it recaptures the ${NAME[first.captured]}` : `it takes the ${NAME[first.captured]} on ${first.to} without losing material`);
  }
  if (!parts.length && first.san.includes('+')) parts.push('it gives check');
  return parts.length ? parts.join(', and ') : null;
}

/** What goes wrong after the played move: mate allowed or material lost (measured from before the move). */
export function threatFacts(ply: Ply, reply: { score: Score; pv: string[] } | undefined, mover: Color): { text: string; net: number; hung: boolean } | null {
  if (!reply) return null;
  const opp: Color = mover === 'w' ? 'b' : 'w';
  const s = reply.score;
  if (s.mate !== null && s.mate !== 0 && (s.mate > 0) === (opp === 'w')) {
    const line = tokLine(ply.fenAfter, pvToSan(ply.fenAfter, reply.pv, Math.min(reply.pv.length, 7)));
    return { text: `it allows mate in ${Math.abs(s.mate)} (${line})`, net: 0, hung: false };
  }
  if (!reply.pv.length) return null;
  const swing = materialAlongPv(ply.fenBefore, [ply.uci, ...reply.pv], mover, 11);
  const e = povPawns(s, mover);
  const consistent = e <= balance(ply.fenBefore, mover) + swing.net + 2.5;
  if (swing.net <= -2 && consistent) {
    const hang = hangingAfter(ply.fenAfter, mover);
    const replySan = pvToSan(ply.fenAfter, reply.pv, 1)[0];
    if (hang && reply.pv[0].slice(2, 4) === hang.sq && VAL[hang.type] >= 3) {
      return { text: `it leaves the ${NAME[hang.type]} on ${hang.sq} hanging, and ${tokMove(ply.fenAfter, replySan)} wins it`, net: swing.net, hung: true };
    }
    const [nl, ng] = netPieces(swing.lost, swing.gained);
    const g = nl.length ? pieceList(nl) : 'material';
    const l = ng.length ? ` for ${pieceList(ng)}` : '';
    const seq = tokLine(ply.fenBefore, swing.sans);
    return { text: `${side(opp)} wins ${g}${l} (${seq})`, net: swing.net, hung: false };
  }
  return null;
}

/** A piece (>= minor) left en prise by the played move that the engine's reply actually takes for >= 3 net. */
export function hungPiece(ply: Ply, reply: { score: Score; pv: string[] } | undefined, mover: Color) {
  if (!reply || !reply.pv.length) return null;
  const h = hangingAfter(ply.fenAfter, mover);
  if (!h || VAL[h.type] < 3 || reply.pv[0].slice(2, 4) !== h.sq) return null;
  // Only count pieces this move put en prise (not ones that were already hanging).
  if (h.sq !== ply.to) {
    const parts = ply.fenBefore.split(' ');
    parts[1] = parts[1] === 'w' ? 'b' : 'w';
    parts[3] = '-';
    try {
      const flipped = new Chess(parts.join(' '));
      if (!flipped.inCheck() && winnableTargets(flipped, mover, 3).some((t) => t.sq === h.sq)) return null;
    } catch { return null; }
  }
  const swing = materialAlongPv(ply.fenBefore, [ply.uci, ...reply.pv], mover, 11);
  if (swing.mate || swing.net > -3) return null;
  return { ...h, replySan: tokMove(ply.fenAfter, pvToSan(ply.fenAfter, reply.pv, 1)[0]) };
}

export interface ReviewInput {
  plies: Ply[];
  evals: (PosEval | null)[]; // index 0..n (position before ply 1 .. after last ply)
  book: Book | null;
}

export function reviewGame({ plies, evals, book }: ReviewInput): (MoveReview | null)[] {
  const out: (MoveReview | null)[] = [];
  let inBook = !!book;
  const losses: (number | null)[] = [];
  for (let i = 0; i < plies.length; i++) {
    const p = plies[i];
    const before = evals[i];
    const after = evals[i + 1];
    if (inBook && !(book && book[bookKey(p.fenAfter)] !== undefined)) inBook = false;
    if (!before || !after || !before.lines.length || !after.lines.length) {
      out.push(null);
      losses.push(null);
      continue;
    }
    const mover = p.color;
    const opp = side(mover === 'w' ? 'b' : 'w');
    const prevMove = i > 0 ? plies[i - 1].move : null;
    const best = before.lines[0];
    const wpBest = winPct(best.score, mover);
    const playedLine = before.lines.find((l) => l.pv[0] === p.uci);
    // Played move counts as "best" if it is the engine's top move, or a MultiPV line with the identical score.
    const isBestMove = best.pv[0] === p.uci || (!!playedLine && playedLine.score.cp === best.score.cp);
    // Score after the move: its MultiPV score if available (same search), else the eval of the resulting position.
    const scoreAfter: Score = best.pv[0] === p.uci ? best.score : playedLine ? playedLine.score : after.lines[0].score;
    const wpAfter = winPct(scoreAfter, mover);
    const loss = isBestMove ? 0 : Math.max(0, wpBest - wpAfter);
    losses.push(loss);

    const bestSan = best.pv.length ? pvToSan(p.fenBefore, best.pv, 1)[0] ?? null : null;
    const bestPvSan = formatPv(p.fenBefore, pvToSan(p.fenBefore, best.pv, 10));
    const reply = after.lines[0];
    const playedPvSan = reply && reply.pv.length ? formatPv(p.fenAfter, pvToSan(p.fenAfter, reply.pv, 10)) : '';
    const threats = isBestMove ? null : threatFacts(p, reply, mover);

    let cls: Cls;
    if (inBook) cls = 'book';
    else if (p.legalCount === 1) cls = 'forced';
    else if (isBestMove) cls = 'best';
    else if (loss < T.excellent) cls = 'excellent';
    else if (loss < T.good) cls = 'good';
    else if (loss < T.inaccuracy) cls = 'inaccuracy';
    else if (loss < T.mistake) cls = 'mistake';
    else cls = 'blunder';

    // Decided positions: win% barely moves, so also flag moves that simply hang material.
    let decidedNote = '';
    const hang = !isBestMove && (wpBest <= 3 || wpBest >= 97) ? hungPiece(p, reply, mover) : null;
    const stillMating = scoreAfter.mate !== null && (scoreAfter.mate > 0) === (mover === 'w');
    if (!['book', 'forced', 'best'].includes(cls) && hang && !stillMating) {
      const losing = wpBest <= 3;
      const target: Cls = losing ? 'blunder' : 'mistake';
      if (CLS_RANK[target] > CLS_RANK[cls]) {
        cls = target;
        decidedNote = losing
          ? ` The game was already lost, but this gives away the ${NAME[hang.type]} for nothing.`
          : ` The position is still winning, but this gives away the ${NAME[hang.type]} for nothing.`;
      }
    }

    // Brilliant: a sound sacrifice that is the best or near-best move.
    let sac: ReturnType<typeof sacrifice> = null;
    if ((cls === 'best' || cls === 'excellent') && loss <= T.excellent) {
      sac = sacrifice(p.fenBefore, p.uci);
      if (sac && wpAfter >= 50 && wpBest < 97) cls = 'brilliant';
      else sac = null;
    }
    // Great: the only good move.
    if (cls === 'best' && before.lines.length > 1) {
      const wp2 = winPct(before.lines[1].score, mover);
      const inCheck = new Chess(p.fenBefore).inCheck();
      if (wpBest - wp2 >= T.great && wp2 <= 80 && !inCheck && !isRecapture(prevMove, p.uci) && !isObviousCapture(p.fenBefore, p.uci)) cls = 'great';
    }
    // Miss: failed to punish the opponent's error.
    let missed = false;
    if (i > 0 && ['inaccuracy', 'mistake', 'blunder'].includes(cls) && loss >= T.missCur && !decidedNote) {
      const prevLoss = losses[i - 1];
      const prevBefore = evals[i - 1];
      if (prevLoss != null && prevLoss >= T.missPrev && prevBefore && prevBefore.lines.length) {
        const wpBeforeOppError = winPct(prevBefore.lines[0].score, mover);
        // There was a real chance (best play gains >= missGain over the pre-error position),
        // and the move gave it back without dropping much below the pre-error level.
        if (wpBest - wpBeforeOppError >= T.missGain && wpAfter >= wpBeforeOppError - 10) { cls = 'miss'; missed = true; }
      }
    }

    // ---------- explanation (only engine + board facts) ----------
    const bestFacts = lineFacts(p.fenBefore, best, mover, prevMove);
    const afterWords = evalWords(scoreAfter, mover);
    const bestWords = evalWords(best.score, mover);
    const P = tokMove(p.fenBefore, p.san);
    const B = bestSan ? tokMove(p.fenBefore, bestSan) : '';
    let ex = '';
    if (evals[i + 1]?.terminal === 'checkmate') {
      ex = `${P} is checkmate.`;
    } else if (cls === 'book') {
      const name = book?.[bookKey(p.fenAfter)];
      ex = `${P} is a known opening move${name ? ` (${name.split('|')[1]})` : ''}.`;
      if (!isBestMove && bestSan) ex += ` The engine's top choice here is ${B}.`;
    } else if (cls === 'forced') {
      ex = `${P} was the only legal move.`;
    } else if (cls === 'brilliant' && sac) {
      const pf = best.pv[0] === p.uci ? bestFacts : lineFacts(p.fenBefore, playedLine ?? { score: scoreAfter, pv: [p.uci, ...(reply?.pv ?? [])] }, mover, prevMove);
      ex = `${P} offers the ${NAME[sac.type]} on ${sac.sq}, and it is the engine's ${best.pv[0] === p.uci ? 'top' : 'near-top'} choice. ${pf ? cap(pf) + '. ' : ''}The position stays ${afterWords}.`;
    } else if (cls === 'great') {
      const second = before.lines[1];
      const sSan = pvToSan(p.fenBefore, second.pv, 1)[0];
      ex = `${P} is the only good move here${bestFacts ? `: ${bestFacts}` : ''}. The next best, ${tokMove(p.fenBefore, sSan)}, leaves the position ${evalWords(second.score, mover)} instead of ${bestWords}.`;
    } else if (cls === 'best') {
      const pf = best.pv[0] === p.uci ? bestFacts : lineFacts(p.fenBefore, playedLine ?? { score: scoreAfter, pv: [p.uci, ...(reply?.pv ?? [])] }, mover, prevMove);
      ex = `${P} is ${best.pv[0] === p.uci ? "the engine's top move" : 'as strong as the top move'}${pf ? `: ${pf}` : ''}. The position is ${best.pv[0] === p.uci ? bestWords : afterWords}.`;
    } else if (cls === 'excellent' || cls === 'good') {
      ex = `${P} is ${cls === 'excellent' ? 'almost as strong as' : 'playable, but a little weaker than'} ${B}. The position is ${afterWords}.`;
      if (bestFacts) ex += ` ${bestSan} was best because ${bestFacts}.`;
    } else {
      const label = { inaccuracy: 'an inaccuracy', mistake: 'a mistake', blunder: 'a blunder', miss: 'a missed chance' }[cls as 'miss'];
      let why = hang && decidedNote
        ? `${P} is ${label}: it leaves the ${NAME[hang.type]} on ${hang.sq} hanging, and ${hang.replySan} takes it.${threats && threats.text.startsWith('it allows mate') ? ` It also ${threats.text.slice(3)}.` : ''}`
        : threats
        ? `${P} is ${label}: ${threats.text}.`
        : `${P} is ${label}: the position goes from ${bestWords} to ${afterWords}.`;
      if (missed) why = `${opp}'s last move was an error, but ${P} does not punish it${threats ? `, and ${threats.text}` : ''}. The position goes from ${bestWords} to ${afterWords}.`;
      ex = why + decidedNote + ` Best was ${B}${bestFacts ? `, because ${bestFacts}` : `, keeping the position ${bestWords}`}.`;
    }

    out.push({
      cls, loss, wpBefore: wpBest, wpAfter, bestUci: best.pv[0] ?? null, bestSan, bestPvSan, playedPvSan, bestPv: best.pv, playedPv: reply?.pv ?? [], fenBefore: p.fenBefore, fenAfter: p.fenAfter,
      explanation: ex, scoreAfter, isBestMove,
    });
  }
  return out;
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const CLS_RANK: Record<Cls, number> = {
  brilliant: 0, great: 0, best: 0, book: 0, forced: 0, excellent: 1, good: 2, inaccuracy: 3, mistake: 4, miss: 4, blunder: 5,
};

export function summarize(plies: Ply[], evals: (PosEval | null)[], reviews: (MoveReview | null)[]) {
  const wpWhite = evals.map((e) => (e && e.lines.length ? winPct(e.lines[0].score, 'w') : 50));
  const losses = reviews.map((r) => (r ? r.loss : null));
  const [accW, accB] = gameAccuracy(wpWhite, losses);
  const counts: Record<'w' | 'b', Record<string, number>> = { w: {}, b: {} };
  reviews.forEach((r, i) => {
    if (!r) return;
    const c = plies[i].color;
    counts[c][r.cls] = (counts[c][r.cls] ?? 0) + 1;
  });
  return { accW, accB, counts };
}
