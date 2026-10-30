// Explanation record: the machine-readable evidence every explanation is generated from.
// Layers: engine (evals, lines), board (ledger, attacks), formula (classification, confidence),
// interpretation (lesson, tempting). Prose in lesson.ts may only use what is in this record.
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import { winPct } from './classify';
import { pvToSan, uciToMove, NAME, VAL } from './tactics';
import { lineMates, forkAfter, pieceSafety } from './facts';
import { errorFacts, type ErrorFacts } from './diagnose';
import { MOTIF_INFO, SKILL_LABEL, phaseOf, type Motif } from './concepts';
import { ledger, ledgerSentence, SIDE, type Ledger } from './ledger';
import { tokMove } from './words';
import type { MomentCore } from './explain';
import type { Line } from './engine';

export const ENGINE_NAME = 'Stockfish 19 lite (WASM)';
import { ENGINE_NET } from './evalschema';
export { ENGINE_NET };

export type Band = 'best' | 'acceptable' | 'playable' | 'fails' | 'illegal';
export type MechanismId =
  | 'allowed-mate' | 'allowed-fork' | 'allowed-pin' | 'allowed-skewer' | 'allowed-discovered' | 'ignored-attack'
  | 'moved-into-attack' | 'left-undefended' | 'allowed-promotion' | 'allowed-material'
  | 'missed-mate' | 'missed-win' | 'positional';
export type SolutionId = 'stops-mate' | 'saves-piece' | 'removes-attacker' | 'defends-piece' | 'no-loss' | 'mates' | 'wins-material' | 'positional';

export interface ConfidenceParts { stability: number; pvAgreement: number; material: number; motif: number; lineLength: number; nearEqual: number }
export interface Evt { text: string; src: 'engine' | 'rules'; plies: number }
export interface ExplanationRecord {
  v: 1;
  position: { fen: string; sideToMove: 'white' | 'black'; phase: string; legalMoves: number };
  playedMove: { san: string; uci: string; legal: boolean };
  bestMoves: { san: string; uci: string; evalPawns: number | null; mate: number | null; wp: number; pv: string[] }[];
  acceptable: { san: string; uci: string; band: Band; wp: number }[];
  evaluation: { before: number | null; after: number | null; wpBefore: number; wpAfter: number; winningChanceLoss: number };
  materialOutcome: { netChange: number; lost: string[]; exchanged: string[]; won: string[]; finalCheck: boolean; queenTrade: boolean; sentence: string | null };
  bestOutcome: { netChange: number; lost: string[]; won: string[]; sentence: string | null };
  verifiedEvents: Evt[];
  motifs: { id: string; name: string; confidence: number }[];
  mechanism: { id: MechanismId; target?: { sq: Square; type: PieceSymbol } };
  solution: { id: SolutionId; how?: 'defender' | 'block' };
  tempting: { text: string; basis: 'board' | 'answer' } | null;
  playerResponse: string | null;
  recommendedLesson: string;
  primaryConcept: string;
  secondaryConcept: string | null;
  onlyMove: boolean;
  mateIn: number | null; // opponent mates after the played move (moves)
  bestMateIn: number | null; // player mates with the best line (moves)
  confidence: number;
  confidenceParts: ConfidenceParts;
  verify: { screenDepth: number | null; depth: number; sameBest: boolean | null } | null;
  engine: { name: string; net: string; depth: number };
}

/** Internals kept beside the record for prose generation and invariant checks (not stored). */
export interface Evidence { rec: ExplanationRecord; m: MomentCore; f: ErrorFacts; replyL: Ledger; bestL: Ledger }

const opp = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const lossOf = (L: Ledger) => L.lost.map((p) => `${SIDE(p.color).toLowerCase()} ${NAME[p.type]} on ${p.sq}`);
const wonOf = (L: Ledger) => L.won.map((p) => `${SIDE(p.color).toLowerCase()} ${NAME[p.type]} on ${p.sq}`);
const pawns = (l: Line | null | undefined, pov: Color) => (l && l.score.mate === null ? (l.score.cp * (pov === 'w' ? 1 : -1)) / 100 : null);
const mateMoves = (l: Line | null | undefined, pov: Color) => (l && l.score.mate !== null ? l.score.mate * (pov === 'w' ? 1 : -1) : null);

const MOTIF_CONF: Record<Motif, number> = {
  mate: 0.98, 'back-rank': 0.95, 'hanging-piece': 0.92, fork: 0.88, pin: 0.8, skewer: 0.8, 'discovered-attack': 0.8,
  'removing-defender': 0.75, promotion: 0.9, 'ignored-threat': 0.85, material: 0.7, defence: 0.6, positional: 0.3,
};

export const NOTICE: Record<MechanismId, string> = {
  'allowed-mate': 'Before every move, look at every check your opponent could give next. If one of them leads to mate, stop it first.',
  'allowed-fork': 'Before moving, look for squares where an enemy knight or queen could attack two of your pieces at once.',
  'allowed-pin': 'Avoid leaving a piece in front of your king or queen on a line an enemy bishop, rook or queen can reach.',
  'allowed-skewer': 'Keep your king and queen off lines where an enemy long-range piece can attack them with another piece behind.',
  'allowed-discovered': 'Watch enemy pieces that stand in front of their own bishop, rook or queen: when they move, a second attack opens.',
  'ignored-attack': 'Before making your own move, check what is already attacked. An existing threat comes first.',
  'moved-into-attack': 'Before you put a piece on a square, count who attacks that square and who defends it.',
  'left-undefended': 'After choosing a move, ask which of your pieces it leaves attacked, and whether each one is still defended.',
  'allowed-promotion': 'Count how many moves an enemy passed pawn needs to promote, and keep a piece able to stop it.',
  'allowed-material': 'Before you move, check every capture and check your opponent has, two moves deep.',
  'missed-mate': 'Look at every check you can give first. Forcing moves come before quiet moves.',
  'missed-win': 'After every opponent move, ask what it left undefended, then check your captures and checks.',
  positional: 'When there is no tactic, compare plans: improve your worst piece and keep your king and pawns safe.',
};

/** Acceptable win% loss versus the best move by level, tightened in only-move positions. */
export function bandTolerance(level: string, onlyMove: boolean): { acceptable: number; playable: number } {
  const base = level === 'beginner' ? 8 : level === 'intermediate' ? 5 : 3;
  return onlyMove ? { acceptable: Math.min(3, base), playable: Math.min(6, base * 2) } : { acceptable: base, playable: base * 2.5 };
}

export interface BandInput {
  level: string; legal: boolean; isPlayed: boolean; isBest: boolean; wpBest: number; wpPlayed: number; wpCand: number;
  bestMates: boolean; candMates: boolean; onlyMove: boolean;
  /** Material net change for the mover along the candidate's line and along the best line (ledger). */
  candNet?: number | null; bestNet?: number | null;
}
/** Grade a retry attempt: Best / Fully acceptable / Playable / Doesn't solve / Illegal. */
export function bandFor(x: BandInput): Band {
  if (!x.legal) return 'illegal';
  if (x.isPlayed) return 'fails';
  if (x.isBest) return 'best';
  if (x.bestMates && x.candMates) return 'acceptable';
  const tol = bandTolerance(x.level, x.onlyMove);
  const loss = x.wpBest - x.wpCand;
  const gap = Math.max(0, x.wpBest - x.wpPlayed);
  const losesMaterial = x.candNet != null && x.bestNet != null && x.candNet <= x.bestNet - 2;
  if (x.bestMates && !x.candMates) return x.wpCand >= 90 && !losesMaterial ? 'playable' : 'fails';
  if (loss <= tol.acceptable && !losesMaterial) return 'acceptable';
  // Playable: keeps most of what the best move keeps and clearly improves on the game move.
  if (loss <= Math.max(tol.playable, gap * 0.35) && x.wpCand - x.wpPlayed >= gap * 0.5 && !(x.wpBest >= 60 && x.wpCand < 45)) return 'playable';
  return 'fails';
}
/** Whether a band counts as solving the puzzle at this level. Advanced players are asked for more than "playable". */
export const bandSolves = (b: Band, level: string) => b === 'best' || b === 'acceptable' || (b === 'playable' && level !== 'advanced');

function onlyMoveOf(m: MomentCore): boolean {
  const legal = new Chess(m.fenBefore).moves().length;
  if (legal === 1) return true;
  const l2 = m.lines[1];
  if (!l2) return false;
  return m.wpBest - winPct(l2.score, m.color) >= 15;
}

export interface RecordOpts { level: string; response?: string | null; verify?: ExplanationRecord['verify']; depth?: number }

export function buildEvidence(m: MomentCore, o: RecordOpts): Evidence {
  const me = m.color, them = opp(me);
  const c = new Chess(m.fenBefore);
  const legalMoves = c.moves().length;
  const playedLegal = !!uciToMove(new Chess(m.fenBefore), m.playedUci);
  const f = errorFacts(m);
  const rpv = m.reply?.pv ?? [];
  const replyL = ledger(m.fenBefore, [m.playedUci, ...rpv], me, 10);
  const best = m.lines[0];
  const bestL = ledger(m.fenBefore, best?.pv ?? [], me, 10);
  const onlyMove = onlyMoveOf(m);
  const tol = bandTolerance(o.level, onlyMove);
  const acceptable = m.lines.filter((l) => l.pv[0] && l.pv[0] !== m.playedUci).map((l) => {
    const wp = winPct(l.score, me);
    const band: Band = l.pv[0] === m.bestUci ? 'best' : m.wpBest - wp <= tol.acceptable ? 'acceptable' : m.wpBest - wp <= tol.playable ? 'playable' : 'fails';
    return { san: pvToSan(m.fenBefore, [l.pv[0]], 1)[0], uci: l.pv[0], band, wp };
  }).filter((a) => a.band !== 'fails');
  const mateIn = f.mateIn;
  const bestMateIn = f.bestMateIn;
  // ---- mechanism (why the played move failed) ----
  const errMotifs = m.tags.error.map((t) => t.motif);
  let mech: ExplanationRecord['mechanism'] = { id: 'positional' };
  // A target that was only traded evenly is not the reason the move failed; fall back to the material line.
  const tgtTraded = !!f.target && replyL.exchanged.some((x) => x.mine.sq === f.target!.sq && x.mine.type === f.target!.type)
    && !replyL.lost.some((p) => p.sq === f.target!.sq && p.type === f.target!.type);
  const T = tgtTraded ? null : f.target;
  const tgt = T ? { sq: T.sq, type: T.type } : undefined;
  if (mateIn != null) mech = { id: 'allowed-mate' };
  else if (f.allowed && errMotifs.includes('fork') && f.fork) mech = { id: 'allowed-fork', target: tgt };
  else if (f.allowed && errMotifs.includes('pin')) mech = { id: 'allowed-pin', target: tgt };
  else if (f.allowed && errMotifs.includes('skewer')) mech = { id: 'allowed-skewer', target: tgt };
  else if (f.allowed && errMotifs.includes('discovered-attack')) mech = { id: 'allowed-discovered', target: tgt };
  else if (f.allowed && T?.existed) mech = { id: 'ignored-attack', target: tgt };
  else if (f.allowed && T?.moved) mech = { id: 'moved-into-attack', target: tgt };
  else if (f.allowed && T) mech = { id: 'left-undefended', target: tgt };
  else if (f.allowed && errMotifs.includes('promotion')) mech = { id: 'allowed-promotion' };
  else if (f.allowed && replyL.netChange <= -2) mech = { id: 'allowed-material' };
  else if (bestMateIn != null) mech = { id: 'missed-mate' };
  else if (bestL.netChange - replyL.netChange >= 2 && bestL.finalCheck) mech = { id: 'missed-win' };
  // ---- solution (what the best move solves) ----
  let sol: ExplanationRecord['solution'] = { id: 'positional' };
  const bestMv = best ? uciToMove(new Chess(m.fenBefore), best.pv[0]) : null;
  if (mech.id === 'missed-mate' && bestMateIn != null) sol = { id: 'mates' };
  else if (mech.id === 'missed-win') sol = { id: 'wins-material' };
  else if (mech.id === 'allowed-mate') sol = { id: mateMoves(best, me) !== null && mateMoves(best, me)! < 0 ? 'positional' : 'stops-mate' };
  else if (mech.target && bestMv) {
    const stillLost = bestL.lost.some((p) => p.type === mech.target!.type && p.ply <= 4);
    if (bestMv.from === mech.target.sq && !stillLost) sol = { id: 'saves-piece' };
    else if (bestMv.captured && f.target && new Chess(m.fenAfter).attackers(mech.target.sq, them).includes(bestMv.to as Square)) sol = { id: 'removes-attacker' };
    else if (!stillLost && defendsAfter(m.fenBefore, best!.pv[0], mech.target.sq, me)) sol = { id: 'defends-piece', how: defendsAfter(m.fenBefore, best!.pv[0], mech.target.sq, me)! };
    else if (!stillLost && bestL.netChange >= replyL.netChange + 2) sol = { id: 'no-loss' };
  } else if (mech.id !== 'positional' && bestL.netChange > replyL.netChange) sol = { id: 'no-loss' };
  // ---- events (engine lines walked by the ledger) ----
  const events: Evt[] = [];
  const s1 = ledgerSentence(replyL);
  if (s1) events.push({ text: `After the game move: ${s1}.`, src: 'engine', plies: replyL.plies });
  const s2 = ledgerSentence(bestL);
  if (s2) events.push({ text: `After the best move: ${s2}.`, src: 'engine', plies: bestL.plies });
  if (mateIn != null) events.push({ text: `The opponent has a forced mate in ${mateIn}.`, src: 'engine', plies: mateIn * 2 });
  if (bestMateIn != null) events.push({ text: `The best line mates in ${bestMateIn}.`, src: 'engine', plies: bestMateIn * 2 });
  // ---- motifs with confidence ----
  const motifs = [...m.tags.error, ...m.tags.solution].map((t) => {
    let conf = MOTIF_CONF[t.motif];
    if ((t.motif === 'mate' || t.motif === 'back-rank') && !(mateIn != null || bestMateIn != null)) conf *= 0.5;
    if (['hanging-piece', 'fork', 'pin', 'skewer', 'discovered-attack', 'material', 'ignored-threat'].includes(t.motif)) {
      const L = t.role === 'allowed' ? replyL : bestL;
      const net = t.role === 'allowed' ? -L.netChange : L.netChange - replyL.netChange;
      if (net < 2) conf *= 0.6;
    }
    return { id: t.id, name: MOTIF_INFO[t.motif].name, confidence: +conf.toFixed(2) };
  }).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
  // ---- confidence ----
  const near = m.lines.slice(1).filter((l) => Math.abs(m.wpBest - winPct(l.score, me)) <= 2).length;
  const parts: ConfidenceParts = {
    stability: o.verify ? (o.verify.sameBest === false ? 0.6 : 1) : 0.85,
    pvAgreement: (best?.pv.length ?? 0) >= 4 ? 1 : 0.7,
    material: replyL.finalCheck && bestL.finalCheck ? (Math.abs(replyL.netChange - bestL.netChange) >= 2 || mateIn != null || bestMateIn != null ? 1 : 0.6) : 0.4,
    motif: motifs[0]?.confidence ?? 0.3,
    lineLength: Math.max(replyL.plies, 1) <= 4 ? 1 : replyL.plies <= 8 ? 0.85 : 0.7,
    nearEqual: near === 0 ? 1 : near === 1 ? 0.85 : 0.7,
  };
  const vals = Object.values(parts);
  const confidence = +(0.35 * Math.min(...vals) + 0.65 * (vals.reduce((a, b) => a + b, 0) / vals.length)).toFixed(2);
  // ---- interpretation ----
  let tempting: ExplanationRecord['tempting'] = null;
  if (f.appeal.length) tempting = { text: f.appeal[0], basis: o.response === 'attacking' ? 'answer' : 'board' };
  const primary = m.tags.primary;
  const rec: ExplanationRecord = {
    v: 1,
    position: { fen: m.fenBefore, sideToMove: c.turn() === 'w' ? 'white' : 'black', phase: phaseOf(m.fenBefore, m.ply), legalMoves },
    playedMove: { san: m.playedSan, uci: m.playedUci, legal: playedLegal },
    bestMoves: m.lines.slice(0, 5).map((l) => ({ san: pvToSan(m.fenBefore, [l.pv[0]], 1)[0], uci: l.pv[0], evalPawns: pawns(l, me), mate: mateMoves(l, me), wp: +winPct(l.score, me).toFixed(1), pv: pvToSan(m.fenBefore, l.pv, 10) })),
    acceptable,
    evaluation: { before: pawns(best, me), after: pawns(m.reply, me), wpBefore: +m.wpBest.toFixed(1), wpAfter: +m.wpPlayed.toFixed(1), winningChanceLoss: +(m.wpBest - m.wpPlayed).toFixed(1) },
    materialOutcome: { netChange: replyL.netChange, lost: lossOf(replyL), exchanged: replyL.exchanged.map((x) => `${NAME[x.mine.type]} for ${NAME[x.theirs.type]}`), won: wonOf(replyL), finalCheck: replyL.finalCheck, queenTrade: replyL.queenTrade, sentence: s1 },
    bestOutcome: { netChange: bestL.netChange, lost: lossOf(bestL), won: wonOf(bestL), sentence: s2 },
    verifiedEvents: events,
    motifs,
    mechanism: mech,
    solution: sol,
    tempting,
    playerResponse: o.response ?? null,
    recommendedLesson: NOTICE[mech.id],
    primaryConcept: MOTIF_INFO[patternMotif(mech.id, primary.motif, m.tags.solutionTag.motif)].name,
    secondaryConcept: (() => { const pm = patternMotif(mech.id, primary.motif, m.tags.solutionTag.motif); const t = [primary, m.tags.solutionTag, ...m.tags.error].find((x) => x.motif === pm); return t ? SKILL_LABEL[t.skill] ?? null : null; })(),
    onlyMove, mateIn, bestMateIn,
    confidence, confidenceParts: parts,
    verify: o.verify ?? null,
    engine: { name: ENGINE_NAME, net: ENGINE_NET, depth: o.depth ?? best?.depth ?? 0 },
  };
  return { rec, m, f, replyL, bestL };
}

const MECH_MOTIF: Partial<Record<MechanismId, Motif>> = {
  'allowed-mate': 'mate', 'allowed-fork': 'fork', 'allowed-pin': 'pin', 'allowed-skewer': 'skewer', 'allowed-discovered': 'discovered-attack',
  'ignored-attack': 'ignored-threat', 'moved-into-attack': 'hanging-piece', 'left-undefended': 'hanging-piece', 'allowed-promotion': 'promotion',
  'allowed-material': 'material', 'missed-mate': 'mate', positional: 'positional',
};
/** The pattern shown to the player must agree with the mechanism the explanation describes. */
export function patternMotif(mech: MechanismId, primary: Motif, solution: Motif): Motif {
  if (mech === 'missed-win') return primary !== 'positional' ? primary : solution !== 'positional' ? solution : 'material';
  const want = MECH_MOTIF[mech]!;
  if (primary === want) return primary;
  // keep a more specific detector result when it is consistent with the mechanism
  if (want === 'material' && primary !== 'positional' && primary !== 'defence') return primary;
  if (want === 'mate' && primary === 'back-rank') return primary;
  return want;
}

export const buildRecord = (m: MomentCore, o: RecordOpts) => buildEvidence(m, o).rec;

/** After `uci`, is `sq` (our piece) defended by more pieces than before, or no longer attacked? */
function defendsAfter(fen: string, uci: string, sq: Square, me: Color): 'defender' | 'block' | null {
  const before = pieceSafety(fen, me).find((s) => s.sq === sq);
  const c = new Chess(fen);
  if (!uciToMove(c, uci)) return null;
  const after = pieceSafety(c.fen(), me).find((s) => s.sq === sq);
  if (!before || !after) return null;
  return after.defenders.length > before.defenders.length ? 'defender' : after.attackers.length < before.attackers.length ? 'block' : null;
}

/** Re-exported for tests. */
export { lineMates, forkAfter, VAL, tokMove };
