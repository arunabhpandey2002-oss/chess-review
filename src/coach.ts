// Assembles the coaching layer for one reviewed game: critical moments and the post-game summary.
import type { Color } from 'chess.js';
import type { PosEval } from './engine';
import { winPct, moveAccuracy } from './classify';
import { lineFacts, type Ply, type MoveReview } from './review';
import { materialAlongPv, pvToSan } from './tactics';
import { settledMaterial } from './facts';
import { tagMove, phaseOf, ROLE_PHRASE, SKILL_LABEL, type Phase, type Tag } from './concepts';
import { selectMoments, type Level, type MomentCandidate } from './moments';
import { wpWords, noticeFor, type MomentCore } from './explain';
import { tokMove } from './words';

export interface Moment extends MomentCore { score: number; why: string[]; phase: Phase; clockLeft: number | null; spent: number | null; clockBase?: number | null }

export function parseClock(s?: string): number | null {
  if (!s) return null;
  const p = s.split(':').map(Number);
  if (p.some((x) => !Number.isFinite(x))) return null;
  return p.reduce((a, b) => a * 60 + b, 0);
}

export function parseTimeControl(tc?: string): { base: number; inc: number } | null {
  if (!tc || tc.includes('/') || tc === '-') return null;
  const [b, i] = tc.split('+').map(Number);
  return Number.isFinite(b) ? { base: b, inc: Number.isFinite(i) ? i : 0 } : null;
}

/** Seconds spent on each ply (null when no clock data). */
export function timeSpent(plies: Ply[], tc: { base: number; inc: number } | null): (number | null)[] {
  const last: Record<Color, number | null> = { w: tc?.base ?? null, b: tc?.base ?? null };
  return plies.map((p) => {
    const now = parseClock(p.clock);
    const prev = last[p.color];
    last[p.color] = now;
    if (now == null || prev == null) return null;
    return Math.max(0, Math.round(prev - now + (tc?.inc ?? 0)));
  });
}

const mateFor = (s: { mate: number | null }, c: Color) => s.mate !== null && s.mate !== 0 && (s.mate > 0) === (c === 'w');

/** Every player move that lost real winning chances, tagged. Used for moments and cross-game stats. */
export function playerErrors(plies: Ply[], evals: (PosEval | null)[], reviews: (MoveReview | null)[], me: Color): (MomentCandidate & { tags: ReturnType<typeof tagMove>; i: number })[] {
  const out: (MomentCandidate & { tags: ReturnType<typeof tagMove>; i: number })[] = [];
  plies.forEach((p, i) => {
    const r = reviews[i];
    const before = evals[i], after = evals[i + 1];
    if (!r || p.color !== me || !before?.lines.length || r.isBestMove || r.cls === 'book' || r.cls === 'forced') return;
    if (r.loss < 6) return;
    const best = before.lines[0];
    const reply = after?.lines[0];
    const tags = tagMove({ ply: p, best, reply, mover: me });
    const second = before.lines.find((l, k) => k > 0 && l.pv[0] !== p.uci);
    let tacticPlies: number | null = null;
    if (mateFor(best.score, me) && Math.abs(best.score.mate!) <= 4) tacticPlies = Math.abs(best.score.mate!) * 2 - 1;
    else if (tags.solutionTag.motif !== 'positional' && tags.solutionTag.motif !== 'defence') {
      const sw = materialAlongPv(p.fenBefore, best.pv, me, 10);
      tacticPlies = sw.net >= 2 ? sw.plies : settledMaterial(p.fenBefore, best.pv, me, 12).plies || null;
    }
    if (tacticPlies == null && reply && tags.error.length) {
      const sw = materialAlongPv(p.fenBefore, [p.uci, ...reply.pv], me, 11);
      tacticPlies = sw.net <= -2 ? sw.plies : settledMaterial(p.fenBefore, [p.uci, ...reply.pv], me, 13).plies || null;
    }
    out.push({
      i, ply: i, loss: r.loss, wpBest: r.wpBefore, wpPlayed: r.wpAfter, wpSecond: second ? winPct(second.score, me) : null,
      cls: r.cls, motif: tags.primary.motif, solutionMotif: tags.solutionTag.motif, tacticPlies, tags,
    });
  });
  return out;
}

export function buildMoments(plies: Ply[], evals: (PosEval | null)[], reviews: (MoveReview | null)[], me: Color, level: Level, timeControl?: string): Moment[] {
  const tc = parseTimeControl(timeControl);
  const spentAll = timeSpent(plies, tc);
  const errs = playerErrors(plies, evals, reviews, me);
  const chosen = selectMoments(errs, level, 3);
  return chosen.map((c) => {
    const p = plies[c.i];
    const before = evals[c.i]!;
    const prev = c.i > 0 ? plies[c.i - 1] : null;
    const best = before.lines[0];
    return {
      ply: c.i, moveNumber: p.moveNumber, color: p.color, fenBefore: p.fenBefore, fenAfter: p.fenAfter, playedUci: p.uci, playedSan: p.san,
      bestUci: best.pv[0], bestSan: pvToSan(p.fenBefore, best.pv, 1)[0], lines: before.lines.map((l) => ({ ...l, pv: l.pv.slice(0, 12) })),
      reply: evals[c.i + 1]?.lines[0] ? { ...evals[c.i + 1]!.lines[0], pv: evals[c.i + 1]!.lines[0].pv.slice(0, 12) } : null,
      wpBest: c.wpBest, wpPlayed: c.wpPlayed, loss: c.loss, cls: c.cls, tags: c.tags,
      prevUci: prev?.uci, prevFen: prev?.fenBefore, score: c.score, why: c.why, phase: phaseOf(p.fenBefore, c.i),
      clockLeft: parseClock(p.clock), spent: spentAll[c.i] ?? null, clockBase: tc?.base ?? null,
    };
  });
}

// ---------------- summary ----------------
export interface PhaseStat { phase: Phase; moves: number; accuracy: number | null; mistakes: number; blunders: number; label: string }
export interface GameSummaryView {
  story: string[];
  turning: string | null;
  strongest: string | null;
  improvement: string | null;
  phases: PhaseStat[];
  time: string[];
  action: string;
  errorTags: string[]; // unique tag ids across all the player's errors (for cross-game stats)
  skills: string[];
}

export interface SummaryInput {
  plies: Ply[];
  evals: (PosEval | null)[];
  reviews: (MoveReview | null)[];
  me: Color;
  moments: Moment[];
  opening: string;
  opponent: string;
  resultText: string; // e.g. "You won by resignation"
  timeControl?: string;
}

const mv = (p: Ply) => `${p.moveNumber}${p.color === 'w' ? '.' : '...'}`;

export function buildSummary(x: SummaryInput): GameSummaryView {
  const { plies, evals, reviews, me } = x;
  const n = plies.length;
  const wpMe = evals.map((e) => (e && e.lines.length ? winPct(e.lines[0].score, me) : null));
  // turning point: the biggest single-move swing, in a position that was not already decided
  let tIdx = -1, tLoss = 0;
  reviews.forEach((r, i) => { if (r && r.loss > tLoss && r.wpBefore > 3 && r.wpBefore < 97 && r.cls !== 'book') { tLoss = r.loss; tIdx = i; } });
  let turning: string | null = null;
  if (tIdx >= 0 && tLoss >= 10) {
    const p = plies[tIdx];
    const r = reviews[tIdx]!;
    const mine = p.color === me;
    const before = wpMe[tIdx]!;
    const afterMe = mine ? r.wpAfter : 100 - r.wpAfter;
    turning = `Move ${p.moveNumber}: ${mine ? 'you' : 'your opponent'} played ${tokMove(p.fenBefore, p.san)}, and your position went from ${wpWords(before)} to ${wpWords(afterMe)}.`;
  }
  // strongest decision: a Brilliant/Great move, else the best move that punished an opponent error
  let strongest: string | null = null;
  let sBest = -1;
  reviews.forEach((r, i) => {
    const p = plies[i];
    if (!r || p.color !== me || !r.isBestMove) return;
    let val = r.cls === 'brilliant' ? 100 : r.cls === 'great' ? 80 : 0;
    const prev = i > 0 ? reviews[i - 1] : null;
    if (prev && prev.loss >= 10) val = Math.max(val, prev.loss);
    if (val > sBest && val >= 10) {
      sBest = val;
      const prevPly = i > 0 ? plies[i - 1] : null;
      const why = lineFacts(p.fenBefore, evals[i]?.lines[0], me, prevPly?.move ?? null);
      strongest = `${mv(p)}${tokMove(p.fenBefore, p.san)}${r.cls === 'great' || r.cls === 'brilliant' ? ` (${r.cls === 'great' ? 'the only good move' : 'a sound sacrifice'})` : prev && prev.loss >= 10 ? ', punishing your opponent\'s error' : ''}${why ? `: ${why}` : ''}.`;
    }
  });
  const top = x.moments.slice().sort((a, b) => b.score - a.score)[0];
  const improvement = top
    ? `Move ${top.moveNumber}: ${tokMove(top.fenBefore, top.playedSan)} ${ROLE_PHRASE[top.tags.primary.id] ? `(you ${ROLE_PHRASE[top.tags.primary.id]})` : ''}. ${tokMove(top.fenBefore, top.bestSan)} was much stronger.`
    : null;
  // phases
  const phases: PhaseStat[] = (['opening', 'middlegame', 'endgame'] as Phase[]).map((ph) => {
    const idx = plies.map((p, i) => i).filter((i) => plies[i].color === me && phaseOf(plies[i].fenBefore, i) === ph && reviews[i]);
    const accs = idx.map((i) => moveAccuracy(reviews[i]!.loss));
    const mistakes = idx.filter((i) => reviews[i]!.cls === 'mistake' || reviews[i]!.cls === 'miss').length;
    const blunders = idx.filter((i) => reviews[i]!.cls === 'blunder').length;
    const acc = accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null;
    const label = !idx.length ? 'not reached' : blunders ? 'costly errors' : mistakes ? 'some mistakes' : acc != null && acc >= 85 ? 'strong' : 'solid';
    return { phase: ph, moves: idx.length, accuracy: acc, mistakes, blunders, label };
  });
  // time management
  const tc = parseTimeControl(x.timeControl);
  const spent = timeSpent(plies, tc);
  const time: string[] = [];
  const mine = plies.map((p, i) => i).filter((i) => plies[i].color === me);
  if (!mine.some((i) => spent[i] != null)) time.push('No clock data was recorded for this game.');
  else {
    const vals = mine.map((i) => spent[i]).filter((v): v is number => v != null);
    const avg = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
    time.push(`You used ${Math.round(avg)} seconds per move on average.`);
    const longI = mine.reduce((a, i) => ((spent[i] ?? -1) > (spent[a] ?? -1) ? i : a), mine[0]);
    if (spent[longI] != null && spent[longI]! >= 20) time.push(`Your longest think was ${spent[longI]} seconds, on move ${plies[longI].moveNumber}.`);
    for (const m of x.moments) {
      const s = spent[m.ply];
      if (s != null) time.push(`Before the mistake on move ${m.moveNumber} you spent ${s} second${s === 1 ? '' : 's'}${s < 10 && (m.clockLeft ?? 0) > 60 ? ', with plenty of time left on your clock' : ''}.`);
    }
    if (tc) {
      const limit = Math.max(30, tc.base * 0.1);
      const tt = mine.find((i) => { const c = parseClock(plies[i].clock); return c != null && c < limit; });
      if (tt != null) {
        const after = mine.filter((i) => i >= tt && reviews[i] && ['mistake', 'blunder', 'miss'].includes(reviews[i]!.cls)).length;
        time.push(`You were in time trouble (under ${Math.round(limit)} seconds) from move ${plies[tt].moveNumber}${after ? `, and made ${after} mistake${after > 1 ? 's' : ''} after that` : ''}.`);
      } else time.push('You never got into time trouble.');
    }
  }
  // story
  const story: string[] = [];
  story.push(`You played ${me === 'w' ? 'White' : 'Black'} against ${x.opponent}${x.opening ? ` in the ${x.opening}` : ''}.`);
  const after10 = Math.min(n, 20);
  if (n >= 20 && wpMe[after10] != null) story.push(`After move 10 the position was ${wpWords(wpMe[after10]!)} for you.`);
  if (turning) story.push(`The game turned on ${turning.charAt(0).toLowerCase()}${turning.slice(1)}`);
  story.push(`${x.resultText} on move ${plies[n - 1]?.moveNumber ?? 0}.`);
  // recommended action
  let action: string;
  if (x.moments.length) {
    const t = (top ?? x.moments[0]).tags.primary;
    action = `Retry the ${x.moments.length} position${x.moments.length > 1 ? 's' : ''} below before looking at the answers. Main lesson: ${noticeFor(t).replace(/\.$/, '')}.`;
  } else action = 'No big mistakes to retry in this game. Review another game, or work through your due positions.';
  // tags across all errors (for recurring-error stats)
  const errorTags = new Set<string>();
  const skills = new Set<string>();
  const addTag = (t: Tag) => { if (t.motif !== 'positional' && t.motif !== 'defence') { errorTags.add(t.id); skills.add(SKILL_LABEL[t.skill]); } };
  for (const e of playerErrors(plies, evals, reviews, me)) {
    if (e.loss < 10 || e.wpBest >= 97 || e.wpBest <= 3) continue;
    e.tags.error.forEach(addTag); e.tags.solution.forEach(addTag);
  }
  return { story, turning, strongest, improvement, phases, time, action, errorTags: [...errorTags], skills: [...skills] };
}
