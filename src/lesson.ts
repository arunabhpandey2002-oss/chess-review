// Lesson prose, generated only from an ExplanationRecord (evidence.ts) and checked by invariants.ts.
import { Chess, type Square } from 'chess.js';
import { pvToSan, uciToMove, NAME } from './tactics';
import { moveAppeal } from './facts';
import { tokMove, tokLine } from './words';
import { fmtScore } from './review';
import { winPct } from './classify';
import { MOTIF_INFO } from './concepts';
import { amountWords, lossPhrase } from './ledger';
import { buildEvidence, patternMotif, type Evidence, type ExplanationRecord, type RecordOpts } from './evidence';
import { checkSection, type Violation } from './invariants';
import { wpWords, type MomentCore, type Source } from './explain';

export interface LessonSection { id: string; label: string; text: string; src: Source; fallback?: boolean }
export interface RecordLesson { sections: LessonSection[]; linePlies: number; grounded: boolean; record: ExplanationRecord; violations: Violation[]; lowConfidence: boolean }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const LOW = 0.6;

function replyLine(ev: Evidence, plies: number): string {
  const { m } = ev;
  const sans = pvToSan(m.fenAfter, m.reply?.pv ?? [], plies);
  return sans.length ? tokLine(m.fenAfter, sans) : '';
}
function bestLine(ev: Evidence, plies: number, from = 0): string {
  const { m } = ev;
  const pv = m.lines[0]?.pv ?? [];
  const c = new Chess(m.fenBefore);
  for (let i = 0; i < from; i++) if (!uciToMove(c, pv[i])) return '';
  const sans = pvToSan(c.fen(), pv.slice(from), plies);
  return sans.length ? tokLine(c.fen(), sans) : '';
}
const pieceAt = (fen: string, sq: string) => { const p = new Chess(fen).get(sq as Square); return p ? NAME[p.type] : null; };

function whyFailed(ev: Evidence, level: string): string {
  const { rec, m, f, replyL } = ev;
  const P = f.played, R = f.reply ?? '';
  const t = f.target;
  const tail = rec.materialOutcome.sentence ? `: ${rec.materialOutcome.sentence}` : '';
  const short = level === 'beginner';
  switch (rec.mechanism.id) {
    case 'allowed-mate': return `After ${P}, they have a forced mate in ${rec.mateIn}: ${replyLine(ev, short ? Math.min(3, rec.mateIn! * 2 - 1) : rec.mateIn! * 2 - 1)}.`;
    case 'allowed-fork': return `After ${P}, ${R} attacks your ${f.fork!.join(' and your ')} at the same time, and you cannot save both${tail}.`;
    case 'allowed-pin': case 'allowed-skewer': {
      const tag = m.tags.error.find((x) => x.motif === (rec.mechanism.id === 'allowed-pin' ? 'pin' : 'skewer'));
      const c = new Chess(m.fenAfter); const r0 = m.reply?.pv[0]; if (r0) uciToMove(c, r0);
      const [, front, behind] = tag?.squares ?? [];
      const fp = front ? c.get(front as Square) : null, bp = behind ? c.get(behind as Square) : null;
      if (fp && bp && fp.color === m.color && bp.color === m.color) {
        return rec.mechanism.id === 'allowed-pin'
          ? `After ${P}, ${R} pins your ${NAME[fp.type]} on ${front} to your ${NAME[bp.type]} on ${behind}${tail}.`
          : `After ${P}, ${R} attacks your ${NAME[fp.type]} on ${front}, and when it moves your ${NAME[bp.type]} on ${behind} is exposed${tail}.`;
      }
      return `After ${P}, they have ${R}${tail}.`;
    }
    case 'allowed-discovered': return `After ${P}, ${R} moves one piece and uncovers an attack from another${tail}.`;
    case 'ignored-attack': return `Your ${NAME[t!.type]} on ${t!.sq} was already attacked before ${P}, and ${P} did not deal with it${tail}.`;
    case 'moved-into-attack': return `${P} put your ${NAME[t!.type]} on ${t!.sq}, where their ${t!.byPiece} can take it` +
      (t!.defenders.length && t!.cheaper ? `. It is defended, but their ${t!.cheaper} is worth less than your ${NAME[t!.type]}, so the trade still costs you` : t!.defenders.length ? `, and it is not defended enough` : `, and nothing defends it`) + `${tail}.`;
    case 'left-undefended': return `After ${P}, your ${NAME[t!.type]} on ${t!.sq} ${t!.defenders.length ? 'is not defended enough' : 'has no defender'}, and their ${t!.byPiece} takes it${tail}.`;
    case 'allowed-promotion': return `After ${P}, their pawn gets through to promote: ${replyLine(ev, short ? 3 : 6)}.`;
    case 'allowed-material': return `After ${P}, they have a forcing line, ${replyLine(ev, short ? 3 : Math.min(8, Math.max(3, replyL.plies)))}${tail}.`;
    case 'missed-mate': return `${P} let a forced mate go. ${f.best} starts a mate in ${rec.bestMateIn}.`;
    case 'missed-win': return '';
    default: return '';
  }
}

function whyBest(ev: Evidence, level: string): string {
  const { rec, m, f, bestL } = ev;
  const B = f.best;
  const t = rec.mechanism.target;
  const keep = bestL.lost.length === 0 && bestL.netChange >= 0 ? ', and you lose nothing' : rec.bestOutcome.sentence ? `; ${rec.bestOutcome.sentence}` : '';
  switch (rec.solution.id) {
    case 'stops-mate': return `${B} stops the mate: after it, the engine finds no forced mate for them.`;
    case 'saves-piece': return `${B} moves your ${NAME[t!.type]} off ${t!.sq} before it can be taken${keep}.`;
    case 'removes-attacker': return `${B} captures the piece that was attacking your ${NAME[t!.type]} on ${t!.sq}${keep}.`;
    case 'defends-piece': return `${B} ${rec.solution.how === 'defender' ? 'adds a defender to' : 'blocks or reduces the attack on'} your ${NAME[t!.type]} on ${t!.sq}${keep}.`;
    case 'no-loss': return bestL.lost.length === 0 && bestL.netChange >= 0 ? `After ${B}, they have no way to win material in the engine line.` : `After ${B}, ${rec.bestOutcome.sentence ?? 'the position holds'}.`;
    case 'mates': return `${B} starts a forced mate in ${rec.bestMateIn}: ${bestLine(ev, level === 'beginner' ? 3 : rec.bestMateIn! * 2 - 1)}.`;
    case 'wins-material': {
      const ap = moveAppeal(m.fenBefore, m.bestUci, m.ply)[0];
      return `${B}${ap ? ` works because ${ap}` : ' is the strongest move'}; after it, ${rec.bestOutcome.sentence}.`;
    }
    default: {
      const gap = rec.bestMoves[1] ? rec.bestMoves[0].wp - rec.bestMoves[1].wp : null;
      const stable = rec.verify?.sameBest ? 'consistently prefers' : 'prefers';
      return `The engine ${stable} ${B}, but the advantage comes from several positional factors rather than one immediate tactic.` +
        (gap != null && level !== 'beginner' ? ` Its next choice scores ${gap.toFixed(0)} win-chance ${Math.round(gap) === 1 ? 'point' : 'points'} lower.` : '') + ` Explore the line to see how the position develops.`;
    }
  }
}

/** "went from better to roughly equal", or for an unchanged label "was already worse and got harder". */
export function moveWords(a: number, b: number): string {
  const wa = wpWords(a), wb = wpWords(b);
  if (wa !== wb) return `Your position went from ${wa} to ${wb}`;
  return b < a ? `Your position stayed ${wa}, with less margin` : `Your position stayed ${wa}`;
}

function whatHappened(ev: Evidence, level: string): string {
  const { rec, m, f } = ev;
  const nums = level === 'beginner' ? '' : level === 'intermediate'
    ? ` (estimated win chance ${rec.evaluation.wpBefore.toFixed(0)}% to ${rec.evaluation.wpAfter.toFixed(0)}%)`
    : ` (${fmtScore(m.lines[0]?.score)} with best play, ${fmtScore(m.reply?.score)} after your move)`;
  let s = `You played ${f.played}.`;
  const net = rec.materialOutcome.netChange;
  if (rec.mateIn != null) s += ` It allows a forced mate.`;
  else if (rec.mechanism.id === 'missed-mate') s += ` It missed a forced mate.`;
  else if (rec.mechanism.id === 'missed-win') s += rec.bestOutcome.netChange > 0 ? ` It missed a chance to end up ${amountWords(rec.bestOutcome.netChange)} ahead.` : ` It missed a line that keeps more material.`;
  else if (net < 0 && rec.materialOutcome.finalCheck) s += ` It loses ${lossPhrase(ev.replyL)}.`;
  return `${s} ${moveWords(m.wpBest, m.wpPlayed)}${nums}.`;
}

/** Build the lesson for a moment. Every section is checked; a failed check replaces it with a concrete-line fallback. */
export function lessonFor(m: MomentCore, o: RecordOpts): RecordLesson {
  const ev = buildEvidence(m, o);
  const { rec, f } = ev;
  const level = o.level;
  const low = rec.confidence < LOW || rec.mechanism.id === 'positional';
  const sections: LessonSection[] = [];
  sections.push({ id: 'happened', label: 'What happened', text: whatHappened(ev, level), src: 'engine' });
  const wf = whyFailed(ev, level);
  if (wf && !low) sections.push({ id: 'failed', label: 'Why it failed', text: wf, src: 'rules' });
  else if (low && m.reply?.pv.length) sections.push({ id: 'failed', label: 'Why it failed', text: `The engine line after your move: ${replyLine(ev, level === 'beginner' ? 3 : 6)}.`, src: 'engine' });
  if (rec.tempting && (level !== 'beginner' || rec.tempting.basis === 'answer') && !low) {
    sections.push({ id: 'tempting', label: 'Why it was tempting', text: rec.tempting.basis === 'answer' ? `You said you were focused on your own plan, and ${f.played} does look active: ${rec.tempting.text}.` : `A plausible reason ${f.played} looked attractive is that ${rec.tempting.text}.`, src: 'estimate' });
  }
  sections.push({ id: 'best', label: `Why ${m.bestSan} works`, text: whyBest(ev, low ? 'positional' : level), src: 'rules' });
  if (level !== 'beginner' && m.lines[0]?.pv[1]) {
    sections.push({ id: 'reply', label: 'Their best answer', text: `After ${f.best}, their best reply is ${bestLine(ev, level === 'advanced' ? 4 : 2, 1)}.`, src: 'engine' });
  }
  sections.push({ id: 'notice', label: 'What to notice next time', text: rec.recommendedLesson, src: 'rules' });
  const pi = MOTIF_INFO[patternMotif(rec.mechanism.id, m.tags.primary.motif, m.tags.solutionTag.motif)];
  if (!low) sections.push({ id: 'pattern', label: 'Pattern', text: level === 'beginner' ? `${pi.name}: ${pi.idea}.` : `${pi.name}${rec.secondaryConcept ? ` · ${rec.secondaryConcept}` : ''}: ${pi.idea}.`, src: 'rules' });
  const alts = rec.acceptable.filter((a) => a.uci !== m.bestUci && a.band !== 'fails');
  if (level !== 'beginner' && alts.length) {
    sections.push({ id: 'alts', label: 'Also good', text: `${alts.map((a) => tokMove(m.fenBefore, a.san)).join(', ')} ${alts.length === 1 ? 'also keeps' : 'also keep'} most of the advantage.`, src: 'engine' });
  }
  if (level === 'advanced') {
    const l2 = m.lines[1];
    if (l2) sections.push({ id: 'compare', label: 'Engine comparison', text: `Second choice ${tokMove(m.fenBefore, pvToSan(m.fenBefore, l2.pv, 1)[0])} scores ${fmtScore(l2.score)} (${winPct(l2.score, m.color).toFixed(0)}%), against ${fmtScore(m.lines[0].score)} for ${f.best}.`, src: 'engine' });
    const p = rec.confidenceParts;
    const why = [p.stability < 1 ? (rec.verify?.sameBest === false ? 'the best move changed between depths' : 'checked at one depth only') : 'same best move at both depths',
      p.nearEqual < 1 ? 'other moves are nearly as good' : null, p.material < 1 ? 'the material result is not clear-cut' : null].filter(Boolean);
    sections.push({ id: 'confidence', label: 'How sure this is', text: `${rec.confidence >= 0.8 ? 'High' : rec.confidence >= LOW ? 'Medium' : 'Low'} confidence (${why.join(', ')}; depth ${rec.engine.depth}).`, src: 'formula' });
  }
  // invariant checks; any failure falls back to the concrete line
  const violations: Violation[] = [];
  for (const s of sections) {
    const v = checkSection(s.text, ev, s.id);
    if (v.length) {
      violations.push(...v.map((x) => ({ ...x, section: s.id })));
      s.text = s.id === 'happened' ? `You played ${f.played}. ${moveWords(m.wpBest, m.wpPlayed)}.` : `Concrete line: ${bestLine(ev, 4)}.`;
      s.src = 'engine'; s.fallback = true;
    }
  }
  return { sections, linePlies: level === 'beginner' ? 3 : level === 'intermediate' ? 5 : 8, grounded: violations.length === 0, record: rec, violations, lowConfidence: low };
}
