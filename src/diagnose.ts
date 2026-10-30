// "Why did you err?" coach. The player says what they were thinking; we compare that with what the board
// and the engine line actually show, and say so in a few grounded sentences. Nothing here is guessed:
// every sentence comes from chess.js facts on the real position or from the stored Stockfish line.
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import { VAL, uciToMove, pvToSan } from './tactics';
import { pieceSafety, threatsAgainst, nullMove, forkAfter, pinsAgainst, lineMates, settledMaterial, moveAppeal } from './facts';
import { MOTIF_INFO } from './concepts';
import { allowedSquares, groundCheck, type MomentCore, type Source } from './explain';
import { tokMove } from './words';

export type Choice = 'no-see' | 'misjudged' | 'stopped-early' | 'assumed-recapture' | 'attacking' | 'thought-safe' | 'missed-better' | 'too-fast' | 'time' | 'dont-remember' | 'other';
/** The thinking questionnaire. Old saved ids (no-see, thought-safe, attacking, missed-better, time) keep their meaning. */
export const CHOICES: { id: Choice; label: string; category: string }[] = [
  { id: 'no-see', label: "I didn't notice their threat", category: 'Threat awareness' },
  { id: 'misjudged', label: 'I noticed it but misjudged it', category: 'Evaluation' },
  { id: 'stopped-early', label: 'I stopped calculating too early', category: 'Calculation depth' },
  { id: 'assumed-recapture', label: 'I assumed I could recapture', category: 'Calculation depth' },
  { id: 'attacking', label: 'I was focused on my own attack', category: 'Opponent-threat awareness' },
  { id: 'thought-safe', label: 'I thought the piece was defended', category: 'Piece safety' },
  { id: 'missed-better', label: "I didn't consider another move", category: 'Forcing-move discipline' },
  { id: 'too-fast', label: 'I moved too quickly', category: 'Decision process' },
  { id: 'time', label: 'I was low on time', category: 'Time management' },
  { id: 'dont-remember', label: "I don't remember", category: '' },
  { id: 'other', label: 'Something else', category: '' },
];
export const categoryOf = (c: Choice) => CHOICES.find((x) => x.id === c)?.category ?? '';

export type Cause = 'missed-threat' | 'misjudged-safety' | 'tunnel-vision' | 'missed-chance' | 'time' | 'unclear';
export const CAUSE_LABEL: Record<Cause, string> = {
  'missed-threat': 'Missed their threat',
  'misjudged-safety': 'Misjudged piece safety',
  'tunnel-vision': 'Focused on your own attack',
  'missed-chance': 'Missed a better move',
  time: 'Time pressure or a guess',
  unclear: 'Positional choice',
};
/** Which cause each answer claims, so we can say whether the facts agree. */
const CLAIM: Record<Choice, Cause> = {
  'no-see': 'missed-threat', misjudged: 'misjudged-safety', 'stopped-early': 'missed-threat', 'assumed-recapture': 'misjudged-safety', attacking: 'tunnel-vision',
  'thought-safe': 'misjudged-safety', 'missed-better': 'missed-chance', 'too-fast': 'time', time: 'time', 'dont-remember': 'unclear', other: 'unclear',
};
/** What each cause looks like on the board, for "matches part: X, but also Y". */
const CAUSE_PART: Record<Cause, string> = {
  'missed-threat': 'there was a threat to deal with', 'misjudged-safety': 'the piece was not as safe as it looked', 'tunnel-vision': 'your move did aim at something',
  'missed-chance': 'a stronger move was available', time: 'the clock was short', unclear: 'the move was a positional choice',
};

export type Verdict = 'matches' | 'partly' | 'differs' | 'unchecked';
export interface DiagLine { text: string; src: Source }
export interface Diagnosis { choice: Choice; cause: Cause; verdict: Verdict; lines: DiagLine[]; t: number; summary?: string; category?: string }

const NAME: Record<PieceSymbol, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const opp = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const pc = (c: Chess, sq: Square) => { const p = c.get(sq); return p ? `${NAME[p.type]} on ${sq}` : sq; };
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const pts = (n: number) => `${n} point${n === 1 ? '' : 's'}`;
export const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export interface ClockFacts { left: number | null; spent: number | null; base: number | null }
/** Clock facts stored on a moment by buildMoments (null when the game had no clock data). */
export function clockOf(core: MomentCore): ClockFacts | null {
  const x = core as MomentCore & { clockLeft?: number | null; spent?: number | null; clockBase?: number | null };
  if (x.clockLeft == null && x.spent == null) return null;
  return { left: x.clockLeft ?? null, spent: x.spent ?? null, base: x.clockBase ?? null };
}

/** Everything the diagnosis may say, computed once from the position and the engine lines. */
export interface ErrorFacts {
  me: Color;
  played: string; // token for the game move
  best: string; // token for the engine's move
  appeal: string[]; // literal attractions of the game move (captures, check, attacks)
  threatBefore: { mate: string | null; targets: { sq: Square; type: PieceSymbol; by: Square[] }[] };
  allowed: boolean; // the game move let the opponent win material or mate (engine line)
  mateIn: number | null; // opponent mates in n moves after the game move
  loss: number; // material the opponent wins along the reply line (points, >= 0)
  reply: string | null; // token for the opponent's best reply
  target: { sq: Square; type: PieceSymbol; byPiece: string; existed: boolean; moved: boolean; defenders: string[]; attackers: number; cheaper: string | null; defenderAttacked: string | null; defenderPinned: string | null } | null;
  fork: string[] | null; // pieces the reply forks
  bestMateIn: number | null;
  bestGain: number; // material gain along the best line versus the game line
  bestIdea: string; // motif name behind the best move
  missedChance: boolean;
  clock: ClockFacts | null;
}

export function errorFacts(m: MomentCore, clock?: ClockFacts | null): ErrorFacts {
  const me = m.color, them = opp(me);
  const before = new Chess(m.fenBefore);
  const after = new Chess(m.fenAfter);
  const mv = uciToMove(new Chess(m.fenBefore), m.playedUci);
  const rpv = m.reply?.pv ?? [];
  // what they already threatened before the move (null move = "if I passed")
  const tb = threatsAgainst(m.fenBefore);
  const n = nullMove(m.fenBefore);
  const mateUci = tb.mates[0] ?? null;
  const threatBefore = {
    mate: mateUci && n ? tokMove(n.fen(), pvToSan(n.fen(), [mateUci], 1)[0]) : null,
    targets: tb.captures.map((t) => ({ sq: t.sq, type: t.type, by: before.attackers(t.sq, them) })),
  };
  const mate = lineMates(m.fenAfter, rpv, 11);
  const mateIn = mate && mate.mover === them ? Math.ceil(mate.plies / 2) : null;
  const playedNet = settledMaterial(m.fenBefore, [m.playedUci, ...rpv], me, 13).net;
  const best = m.lines[0];
  const bm = best ? lineMates(m.fenBefore, best.pv, 11) : null;
  const bestMateIn = bm && bm.mover === me ? Math.ceil(bm.plies / 2) : null;
  const bestNet = best ? settledMaterial(m.fenBefore, best.pv, me, 12).net : 0;
  const loss = Math.max(0, -playedNet);
  const allowed = mateIn != null || playedNet <= -2;
  // the first piece of ours the reply line captures
  let target: ErrorFacts['target'] = null;
  const walk = new Chess(m.fenAfter);
  for (let i = 0; i < Math.min(rpv.length, 6); i++) {
    const x = uciToMove(walk, rpv[i]);
    if (!x) break;
    if (x.color === them && x.captured && x.captured !== 'p' || (x.color === them && x.captured && i === 0)) {
      const sq = x.to;
      const safety = pieceSafety(m.fenAfter, me).find((s) => s.sq === sq);
      if (!safety) break; // the piece was not on that square yet when we moved
      const pins = pinsAgainst(m.fenAfter, me);
      const cheapest = safety.attackers.filter((s) => after.get(s)!.type !== 'k').reduce<Square | null>((a, s) => (!a || VAL[after.get(s)!.type] < VAL[after.get(a)!.type] ? s : a), null);
      const defAttacked = safety.defenders.find((d) => after.attackers(d, them).length > 0 && after.get(d)!.type !== 'k') ?? null;
      const defPinned = safety.defenders.find((d) => pins.some((p) => p.front.sq === d && p.absolute)) ?? null;
      target = {
        sq, type: x.captured, byPiece: pc(after, x.from as Square),
        existed: tb.captures.some((t) => t.sq === sq) && mv?.from !== sq && mv?.to !== sq,
        moved: mv?.to === sq,
        defenders: safety.defenders.map((d) => pc(after, d)),
        attackers: safety.attackers.length,
        cheaper: cheapest && VAL[after.get(cheapest)!.type] < VAL[x.captured] ? pc(after, cheapest) : null,
        defenderAttacked: defAttacked ? pc(after, defAttacked) : null,
        defenderPinned: defPinned ? pc(after, defPinned) : null,
      };
      break;
    }
  }
  const fk = rpv[0] ? forkAfter(m.fenAfter, rpv[0]) : null;
  return {
    me,
    played: tokMove(m.fenBefore, m.playedSan),
    best: tokMove(m.fenBefore, m.bestSan),
    appeal: moveAppeal(m.fenBefore, m.playedUci, m.ply).filter((a) => /captures|check|attacks/.test(a)),
    threatBefore, allowed, mateIn, loss,
    reply: rpv[0] ? tokMove(m.fenAfter, pvToSan(m.fenAfter, [rpv[0]], 1)[0]) : null,
    target,
    fork: fk && fk.targets.every((t) => t.color === me) ? fk.targets.map((t) => `${NAME[t.type]} on ${t.sq}`) : null,
    bestMateIn,
    bestGain: Math.max(0, bestNet - playedNet),
    bestIdea: MOTIF_INFO[m.tags.solutionTag.motif]?.name.toLowerCase() ?? 'a better move',
    missedChance: bestMateIn != null || bestNet - playedNet >= 2,
    clock: clock ?? null,
  };
}

/** What actually went wrong, from the facts alone. */
export function actualCause(f: ErrorFacts): Cause {
  if (f.allowed) {
    if (f.target?.existed || (f.mateIn != null && f.threatBefore.mate)) return 'missed-threat';
    if (f.target && f.target.defenders.length > 0) return 'misjudged-safety';
    if (f.appeal.length) return 'tunnel-vision';
    return 'missed-threat';
  }
  if (f.missedChance) return 'missed-chance';
  return 'unclear';
}

/** Short on time: under 10% of the starting clock (min 20 s), or the move took 3 seconds or less. */
export function shortOnTime(c: ClockFacts | null): boolean | null {
  if (!c || (c.left == null && c.spent == null)) return null;
  const lim = Math.max(20, (c.base ?? 0) * 0.1);
  return (c.left != null && c.left <= lim) || (c.spent != null && c.spent <= 3);
}

// ---- sentences, each backed by one fact ----
function sThreat(f: ErrorFacts): DiagLine | null {
  const t = f.target;
  if (t?.existed) return { text: `Before ${f.played}, their ${t.byPiece} already attacked your ${NAME[t.type]} on ${t.sq}, and your move did not deal with it.`, src: 'rules' };
  if (f.mateIn != null && f.threatBefore.mate) return { text: `Before ${f.played}, they were already threatening checkmate with ${f.threatBefore.mate}.`, src: 'rules' };
  if (t?.moved) return { text: `${f.played} put your ${NAME[t.type]} on ${t.sq}, where their ${t.byPiece} can take it.`, src: 'rules' };
  return null;
}
function sSafety(f: ErrorFacts): DiagLine | null {
  const t = f.target;
  if (!t) return null;
  const piece = `your ${NAME[t.type]} on ${t.sq}`;
  if (!t.defenders.length) return { text: `After ${f.played}, ${piece} had no defenders.`, src: 'rules' };
  const why: string[] = [];
  if (t.cheaper) why.push(`it can be taken by their ${t.cheaper}, which is worth less`);
  if (t.attackers > t.defenders.length) why.push(`it was attacked ${t.attackers} times and defended only ${t.defenders.length === 1 ? 'once' : `${t.defenders.length} times`}`);
  if (t.defenderPinned) why.push(`your ${t.defenderPinned} was pinned to the king, so it could not recapture`);
  else if (t.defenderAttacked) why.push(`your ${t.defenderAttacked} was itself attacked`);
  const by = `defended ${t.defenders.length === 1 ? 'only ' : ''}by your ${list(t.defenders)}`;
  return { text: why.length ? `${cap(piece)} was ${by}, but ${why.length > 1 ? `${why.slice(0, -1).join(', ')}, and ${why[why.length - 1]}` : why[0]}.` : `${cap(piece)} was ${by}, and the engine still finds a way to win it.`, src: why.length ? 'rules' : 'engine' };
}
function sPunish(f: ErrorFacts): DiagLine | null {
  if (f.mateIn != null) return { text: `After ${f.played}, they have checkmate in ${f.mateIn}${f.reply ? `, starting with ${f.reply}` : ''}.`, src: 'engine' };
  if (f.fork && f.reply) return { text: `Their reply ${f.reply} attacks your ${list(f.fork)} at once.`, src: 'rules' };
  if (f.loss >= 2) return { text: `After ${f.played}, the engine's line${f.reply ? ` (${f.reply} first)` : ''} wins ${pts(f.loss)} of material for them.`, src: 'engine' };
  return null;
}
function sBest(f: ErrorFacts): DiagLine {
  if (f.bestMateIn != null) return { text: `${f.best} was available and leads to checkmate in ${f.bestMateIn}.`, src: 'engine' };
  if (f.bestGain >= 2) return { text: f.allowed ? `${f.best} was stronger: it keeps ${pts(f.bestGain)} of material that the game line loses.` : `${f.best} was stronger (${f.bestIdea}): it gains ${pts(f.bestGain)} more material than the game line.`, src: 'engine' };
  return { text: `The engine preferred ${f.best} (${f.bestIdea}).`, src: 'engine' };
}
function sClock(f: ErrorFacts): DiagLine | null {
  const c = f.clock;
  if (!c || (c.left == null && c.spent == null)) return null;
  const parts: string[] = [];
  if (c.left != null) parts.push(`you had ${fmtClock(c.left)} left`);
  if (c.spent != null) { const sp = Math.round(c.spent); parts.push(`spent ${sp} second${sp === 1 ? '' : 's'} on the move`); }
  return { text: `By the game clock, ${parts.join(' and ')}.`, src: 'rules' };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The main fact behind the actual cause (used when the answer was something else). */
function core(f: ErrorFacts, cause: Cause): DiagLine[] {
  const out: (DiagLine | null)[] = [];
  if (cause === 'missed-threat') out.push(sThreat(f), sPunish(f));
  else if (cause === 'misjudged-safety') out.push(sSafety(f), sPunish(f));
  else if (cause === 'tunnel-vision') out.push(f.appeal.length ? { text: `${f.played}: ${f.appeal[0]}.`, src: 'rules' } : null, sThreat(f) ?? sSafety(f), sPunish(f));
  else out.push(sBest(f));
  return out.filter((x): x is DiagLine => !!x).slice(0, 2);
}

export function diagnose(m: MomentCore, choice: Choice, clock?: ClockFacts | null, now = Date.now()): Diagnosis {
  const f = errorFacts(m, clock);
  const actual = actualCause(f);
  const lines: DiagLine[] = [];
  let verdict: Verdict;
  let cause: Cause = actual;
  const noThreat = !f.allowed && !f.threatBefore.mate && !f.threatBefore.targets.length;
  switch (choice) {
    case 'no-see':
      if (actual === 'missed-threat') { verdict = 'matches'; lines.push(...core(f, actual)); }
      else if (f.allowed) { verdict = 'partly'; lines.push(...core(f, actual)); }
      else {
        verdict = 'differs';
        lines.push({ text: noThreat ? `There was no threat to miss: they attacked nothing they could win, and after ${f.played} the engine finds no way for them to win material.` : `After ${f.played} the engine finds no way for them to win material or mate.`, src: 'engine' }, sBest(f));
      }
      break;
    case 'thought-safe':
      if (actual === 'misjudged-safety') { verdict = 'matches'; lines.push(...core(f, actual)); }
      else if (f.allowed) { verdict = f.target && !f.target.defenders.length ? 'differs' : 'partly'; lines.push(...[sSafety(f), sPunish(f)].filter((x): x is DiagLine => !!x).slice(0, 2)); if (!lines.length) lines.push(...core(f, actual)); }
      else { verdict = 'partly'; lines.push({ text: `You were right that you were safe: after ${f.played} the engine finds no way for them to win material or mate.`, src: 'engine' }, sBest(f)); }
      break;
    case 'attacking':
      if (!f.appeal.length) { verdict = 'differs'; lines.push({ text: `${f.played} did not capture, give check or attack a new piece.`, src: 'rules' }, ...core(f, actual).slice(0, 1)); }
      else {
        verdict = actual === 'tunnel-vision' || !f.allowed ? 'matches' : 'partly';
        lines.push({ text: `${f.played}: ${f.appeal[0]}.`, src: 'rules' });
        lines.push(...(f.allowed ? core(f, actual).filter((l) => !l.text.startsWith(`${f.played}:`)) : [sBest(f)]).slice(0, 1));
      }
      break;
    case 'missed-better':
      verdict = actual === 'missed-chance' ? 'matches' : f.allowed ? 'partly' : 'matches';
      lines.push(sBest(f));
      if (f.allowed) lines.push(...core(f, actual).slice(0, 1));
      break;
    case 'misjudged':
      if (f.allowed && f.target && (f.target.defenders.length || f.target.cheaper)) { verdict = 'matches'; lines.push(...[sSafety(f), sPunish(f)].filter((x): x is DiagLine => !!x).slice(0, 2)); }
      else if (f.allowed) { verdict = 'partly'; lines.push(...core(f, actual)); }
      else { verdict = 'differs'; lines.push({ text: `After ${f.played} the engine finds no way for them to win material or mate.`, src: 'engine' }, sBest(f)); }
      break;
    case 'stopped-early': {
      const firstLoss = lossPly(m);
      if (f.allowed && (f.mateIn != null ? f.mateIn >= 2 : firstLoss >= 3)) { verdict = 'matches'; lines.push({ text: f.mateIn != null ? `The mate takes ${f.mateIn} moves, so it only shows up if you look several moves ahead.` : `The material is lost ${Math.ceil(firstLoss / 2)} moves into the engine line, beyond a short calculation.`, src: 'engine' }, ...core(f, actual).slice(0, 1)); }
      else if (f.allowed) { verdict = 'partly'; lines.push({ text: `The loss comes right away, on their first reply, so it was visible without a long calculation.`, src: 'engine' }, ...core(f, actual).slice(0, 1)); }
      else { verdict = f.missedChance ? 'matches' : 'differs'; lines.push(sBest(f)); }
      break;
    }
    case 'assumed-recapture': {
      const t = f.target;
      if (f.allowed && t && t.defenders.length && (t.defenderPinned || t.defenderAttacked || t.cheaper || t.attackers > t.defenders.length)) { verdict = 'matches'; lines.push(...[sSafety(f), sPunish(f)].filter((x): x is DiagLine => !!x).slice(0, 2)); }
      else if (f.allowed && t && !t.defenders.length) { verdict = 'differs'; lines.push({ text: `There was no recapture: after ${f.played}, nothing defended your ${NAME[t.type]} on ${t.sq}.`, src: 'rules' }, ...[sPunish(f)].filter((x): x is DiagLine => !!x)); }
      else if (f.allowed) { verdict = 'partly'; lines.push(...core(f, actual)); }
      else { verdict = 'differs'; lines.push({ text: `After ${f.played} the engine finds no way for them to win material or mate.`, src: 'engine' }, sBest(f)); }
      break;
    }
    case 'too-fast': {
      const sp = f.clock?.spent;
      if (sp == null) { verdict = 'unchecked'; lines.push({ text: 'No move times were recorded for this game, so the speed of the move cannot be checked.', src: 'rules' }); }
      else if (sp <= 5) { verdict = 'matches'; cause = actual === 'unclear' ? 'time' : actual; lines.push(sClock(f)!); }
      else { verdict = 'differs'; lines.push({ text: `${sClock(f)!.text.replace(/\.$/, '')}, which is not a rushed move.`, src: 'rules' }); }
      lines.push(...core(f, actual).slice(0, 1));
      break;
    }
    case 'dont-remember': case 'other':
      verdict = 'unchecked';
      lines.push(...core(f, actual));
      break;
    case 'time': {
      const short = shortOnTime(f.clock);
      const ck = sClock(f);
      if (short == null) { verdict = 'unchecked'; lines.push({ text: 'No clock times were recorded for this game, so time pressure cannot be checked.', src: 'rules' }); }
      else if (short) { verdict = 'matches'; cause = 'time'; lines.push(ck!); }
      else { verdict = 'differs'; lines.push({ text: `${ck!.text.replace(/\.$/, '')}, so the clock was not short.`, src: 'rules' }); }
      lines.push(...core(f, actual).slice(0, 1));
      break;
    }
  }
  // Every sentence must name only squares that exist in the position or the lines.
  const allowedSq = allowedSquares(m);
  const safe = lines.filter((l) => groundCheck(l.text.replace(/⟦[^⟧]*⟧/g, ''), allowedSq));
  return { choice, cause, verdict: verdict!, lines: safe.slice(0, 3), t: now, summary: verdictSummary(choice, verdict!, actual), category: categoryOf(choice) };
}

/** First ply (1-based, after the game move) at which the reply line takes our material. */
function lossPly(m: MomentCore): number {
  const c = new Chess(m.fenAfter);
  const pv = m.reply?.pv ?? [];
  for (let i = 0; i < Math.min(pv.length, 12); i++) {
    const x = uciToMove(c, pv[i]);
    if (!x) break;
    if (x.captured && x.color !== m.color) return i + 1;
  }
  return 99;
}

/** One specific sentence instead of a vague "Partly". */
export function verdictSummary(choice: Choice, v: Verdict, actual: Cause): string {
  const claimed = CAUSE_PART[CLAIM[choice]];
  if (v === 'matches') return 'That matches the board';
  if (v === 'unchecked') return choice === 'dont-remember' || choice === 'other' ? 'Here is what the board shows' : 'This cannot be checked from the game record';
  if (v === 'differs') return `The board says otherwise: ${CAUSE_PART[actual]}`;
  return CLAIM[choice] === actual ? `Matches part: ${claimed}, but the details differ` : `Matches part: ${claimed}, but also ${CAUSE_PART[actual]}`;
}

export const VERDICT_LABEL: Record<Verdict, string> = { matches: 'That matches the board', partly: 'Matches part of it', differs: 'The board says otherwise', unchecked: 'Here is what the board shows' };
export const claimOf = (c: Choice) => CLAIM[c];

/** Top causes across saved diagnoses (for the home panel). */
export function topCauses(ds: { cause: Cause }[], max = 3): { cause: Cause; label: string; n: number }[] {
  const m = new Map<Cause, number>();
  for (const d of ds) m.set(d.cause, (m.get(d.cause) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([cause, n]) => ({ cause, label: CAUSE_LABEL[cause], n }));
}
