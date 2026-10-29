// Concept tagging: turns verified facts about a position into motif and skill tags.
// A tag is only emitted when the board fact AND the engine line agree (material or mate outcome).
import { Chess, type Color, type Square, type Move } from 'chess.js';
import type { Line } from './engine';
import { materialAlongPv } from './tactics';
import {
  forkAfter, newLineUps, discoveredAfter, isBackRankMate, lineMates, promotionIn, removesDefender, hangingPieces, threatsAgainst, settledMaterial,
} from './facts';
import { hungPiece, type Ply } from './review';

export type Motif =
  | 'mate' | 'back-rank' | 'hanging-piece' | 'fork' | 'pin' | 'skewer' | 'discovered-attack' | 'removing-defender'
  | 'promotion' | 'ignored-threat' | 'material' | 'defence' | 'positional';
export type Role = 'missed' | 'allowed';
export type Skill =
  | 'piece-safety' | 'board-vision' | 'tactics' | 'threat-recognition' | 'calculation' | 'king-safety' | 'defence'
  | 'endgame' | 'opening' | 'positional' | 'time-management';
export type Phase = 'opening' | 'middlegame' | 'endgame';

export interface Tag {
  id: string; // `${role}:${motif}`
  motif: Motif;
  role: Role;
  skill: Skill;
  /** Squares the fact is about (for highlighting and claim checks). */
  squares: Square[];
}

export const MOTIF_INFO: Record<Motif, { name: string; idea: string }> = {
  mate: { name: 'Checkmate', idea: 'a forced sequence that ends in checkmate' },
  'back-rank': { name: 'Back-rank mate', idea: 'a rook or queen mates a king trapped on its first rank by its own pawns' },
  'hanging-piece': { name: 'Hanging piece', idea: 'a piece that is attacked and not defended enough can simply be taken' },
  fork: { name: 'Fork', idea: 'one piece attacks two targets at once, and only one can be saved' },
  pin: { name: 'Pin', idea: 'a piece cannot move without exposing a more valuable piece behind it' },
  skewer: { name: 'Skewer', idea: 'a valuable piece is attacked and, when it moves, the piece behind it falls' },
  'discovered-attack': { name: 'Discovered attack', idea: 'moving one piece uncovers an attack by another piece behind it' },
  'removing-defender': { name: 'Removing the defender', idea: 'capture the piece that guards something, then win what it was guarding' },
  promotion: { name: 'Pawn promotion', idea: 'a pawn reaches the last rank and becomes a queen' },
  'ignored-threat': { name: 'Missed threat', idea: "the opponent's last move created a threat that had to be answered" },
  material: { name: 'Winning material', idea: 'a short forcing sequence that wins material' },
  defence: { name: 'Defensive move', idea: 'the best move here keeps everything safe rather than attacking' },
  positional: { name: 'Positional decision', idea: 'no immediate tactic; the better move improves the position' },
};

export const ROLE_PHRASE: Record<string, string> = {
  'allowed:hanging-piece': 'left a piece hanging',
  'missed:hanging-piece': 'missed a free piece',
  'allowed:fork': 'allowed a fork',
  'missed:fork': 'missed a fork',
  'allowed:pin': 'walked into a pin',
  'missed:pin': 'missed a pin',
  'allowed:skewer': 'allowed a skewer',
  'missed:skewer': 'missed a skewer',
  'allowed:discovered-attack': 'allowed a discovered attack',
  'missed:discovered-attack': 'missed a discovered attack',
  'missed:removing-defender': 'missed removing a defender',
  'allowed:mate': 'allowed a checkmate',
  'missed:mate': 'missed a checkmate',
  'allowed:back-rank': 'allowed a back-rank mate',
  'missed:back-rank': 'missed a back-rank mate',
  'allowed:promotion': 'allowed a pawn to promote',
  'missed:promotion': 'missed a pawn promotion',
  'allowed:ignored-threat': "missed the opponent's threat",
  'allowed:material': 'lost material to a forcing line',
  'missed:material': 'missed a way to win material',
  'missed:defence': 'missed the safe defensive move',
  'missed:positional': 'chose a weaker plan',
};

export const SKILL_LABEL: Record<Skill, string> = {
  'piece-safety': 'Piece safety', 'board-vision': 'Board vision', tactics: 'Tactical awareness', 'threat-recognition': 'Threat recognition',
  calculation: 'Calculation', 'king-safety': 'King safety', defence: 'Defence', endgame: 'Endgames', opening: 'Opening knowledge',
  positional: 'Positional play', 'time-management': 'Time management',
};

const SKILL_OF: Record<string, Skill> = {
  'allowed:hanging-piece': 'piece-safety', 'missed:hanging-piece': 'board-vision',
  'allowed:fork': 'threat-recognition', 'missed:fork': 'tactics', 'allowed:pin': 'threat-recognition', 'missed:pin': 'tactics',
  'allowed:skewer': 'threat-recognition', 'missed:skewer': 'tactics', 'allowed:discovered-attack': 'threat-recognition',
  'missed:discovered-attack': 'tactics', 'missed:removing-defender': 'tactics', 'allowed:mate': 'king-safety', 'missed:mate': 'calculation',
  'allowed:back-rank': 'king-safety', 'missed:back-rank': 'tactics', 'allowed:promotion': 'endgame', 'missed:promotion': 'endgame',
  'allowed:ignored-threat': 'threat-recognition', 'allowed:material': 'calculation', 'missed:material': 'calculation',
  'missed:defence': 'defence', 'missed:positional': 'positional',
};

const ORDER: Motif[] = ['back-rank', 'mate', 'hanging-piece', 'fork', 'pin', 'skewer', 'discovered-attack', 'removing-defender', 'promotion', 'ignored-threat', 'material', 'defence', 'positional'];

function tag(role: Role, motif: Motif, squares: Square[]): Tag {
  const id = `${role}:${motif}`;
  return { id, role, motif, skill: SKILL_OF[id] ?? 'calculation', squares };
}

export interface TagInput {
  ply: Ply;
  best: Line;
  reply?: Line;
  mover: Color;
}

export interface TagResult {
  solution: Tag[]; // what the best move does (role 'missed')
  error: Tag[]; // what the played move allowed (role 'allowed')
  primary: Tag; // the main teaching tag
  solutionTag: Tag; // the idea behind the best move (motif hint)
}

function balanceOf(fen: string, pov: Color): number {
  let s = 0;
  for (const row of new Chess(fen).board()) for (const p of row) if (p) s += (p.color === pov ? 1 : -1) * ({ p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 })[p.type];
  return s;
}

const mateFor = (l: Line | undefined, c: Color) => !!l && l.score.mate !== null && l.score.mate !== 0 && (l.score.mate > 0) === (c === 'w');

export function tagMove({ ply, best, reply, mover }: TagInput): TagResult {
  const enemy: Color = mover === 'w' ? 'b' : 'w';
  const solution: Tag[] = [];
  const error: Tag[] = [];
  const bestFirst = best.pv[0];
  // ---- what the best move does ----
  if (bestFirst && bestFirst !== ply.uci) {
    const swing = materialAlongPv(ply.fenBefore, best.pv, mover, 10);
    const deep = settledMaterial(ply.fenBefore, best.pv, mover, 12);
    // the engine must agree that the line is good for the mover (eval at least the material it claims, minus slack)
    const evalPov = (best.score.cp * (mover === 'w' ? 1 : -1)) / 100;
    const startBal = balanceOf(ply.fenBefore, mover);
    const wins = swing.net >= 2 || swing.mate || (deep.net >= 2 && evalPov >= startBal + deep.net - 2.5);
    const to = bestFirst.slice(2, 4) as Square;
    if (mateFor(best, mover) && Math.abs(best.score.mate!) <= 5) {
      const lm = lineMates(ply.fenBefore, best.pv);
      if (lm && lm.mover === mover && isBackRankMate(ply.fenBefore, best.pv)) solution.push(tag('missed', 'back-rank', [to]));
      solution.push(tag('missed', 'mate', [to]));
    }
    const c = new Chess(ply.fenBefore);
    const fm = (() => { try { return c.move({ from: bestFirst.slice(0, 2), to, promotion: bestFirst[4] }); } catch { return null; } })() as Move | null;
    if (fm && fm.captured && wins && hangingPieces(ply.fenBefore, enemy, 1).some((h) => h.sq === to)) solution.push(tag('missed', 'hanging-piece', [to]));
    const fork = forkAfter(ply.fenBefore, bestFirst);
    if (fork && wins) solution.push(tag('missed', 'fork', [fork.by.sq, ...fork.targets.map((t) => t.sq)]));
    const pins = newLineUps(ply.fenBefore, bestFirst, 'pin');
    if (pins.length && wins) solution.push(tag('missed', 'pin', [pins[0].attacker.sq, pins[0].front.sq, pins[0].behind.sq]));
    const sk = newLineUps(ply.fenBefore, bestFirst, 'skewer');
    if (sk.length && wins) solution.push(tag('missed', 'skewer', [sk[0].attacker.sq, sk[0].front.sq, sk[0].behind.sq]));
    const disc = discoveredAfter(ply.fenBefore, bestFirst);
    if (disc.length && wins) solution.push(tag('missed', 'discovered-attack', [disc[0].slider.sq, disc[0].target.sq]));
    const rd = removesDefender(ply.fenBefore, best.pv);
    if (rd && wins) solution.push(tag('missed', 'removing-defender', [rd.defender.sq, rd.target.sq]));
    const pr = promotionIn(ply.fenBefore, best.pv, mover, 5);
    if (pr && !mateFor(best, enemy) && best.score.cp * (mover === 'w' ? 1 : -1) > 200) solution.push(tag('missed', 'promotion', [pr.sq]));
    if (!solution.length && wins && !swing.mate && !mateFor(best, mover)) solution.push(tag('missed', 'material', [to]));
  }
  // ---- what the played move allowed ----
  if (reply && reply.pv.length) {
    const swing = materialAlongPv(ply.fenBefore, [ply.uci, ...reply.pv], mover, 11);
    const deep = settledMaterial(ply.fenBefore, [ply.uci, ...reply.pv], mover, 13);
    const evalPov = (reply.score.cp * (mover === 'w' ? 1 : -1)) / 100;
    const startBal = balanceOf(ply.fenBefore, mover);
    const loses = swing.net <= -2 || mateFor(reply, enemy) || (deep.net <= -2 && evalPov <= startBal + deep.net + 2.5);
    const r0 = reply.pv[0];
    const rto = r0.slice(2, 4) as Square;
    if (mateFor(reply, enemy) && Math.abs(reply.score.mate!) <= 5) {
      if (isBackRankMate(ply.fenAfter, reply.pv)) error.push(tag('allowed', 'back-rank', [rto]));
      error.push(tag('allowed', 'mate', [rto]));
    }
    const hp = hungPiece(ply, reply, mover);
    if (hp) error.push(tag('allowed', 'hanging-piece', [hp.sq]));
    const fork = forkAfter(ply.fenAfter, r0);
    if (fork && loses) error.push(tag('allowed', 'fork', [fork.by.sq, ...fork.targets.map((t) => t.sq)]));
    const pins = newLineUps(ply.fenAfter, r0, 'pin');
    if (pins.length && loses) error.push(tag('allowed', 'pin', [pins[0].attacker.sq, pins[0].front.sq, pins[0].behind.sq]));
    const sk = newLineUps(ply.fenAfter, r0, 'skewer');
    if (sk.length && loses) error.push(tag('allowed', 'skewer', [sk[0].attacker.sq, sk[0].front.sq, sk[0].behind.sq]));
    const disc = discoveredAfter(ply.fenAfter, r0);
    if (disc.length && loses) error.push(tag('allowed', 'discovered-attack', [disc[0].slider.sq, disc[0].target.sq]));
    const pr = promotionIn(ply.fenAfter, reply.pv, enemy, 4);
    if (pr && loses) error.push(tag('allowed', 'promotion', [pr.sq]));
    // a threat that already existed before the move and was carried out by the reply
    const th = threatsAgainst(ply.fenBefore);
    const threatSqs = th.captures.filter((x) => x.gain >= 2).map((x) => x.sq);
    if (loses && (threatSqs.includes(rto) || th.mates.includes(r0) || !!th.promotions?.includes(r0.slice(0, 4))) && !error.some((t) => t.motif === 'hanging-piece')) error.push(tag('allowed', 'ignored-threat', [rto]));
    if (!error.length && loses && !mateFor(reply, enemy)) error.push(tag('allowed', 'material', [rto]));
  }
  const sort = (a: Tag, b: Tag) => ORDER.indexOf(a.motif) - ORDER.indexOf(b.motif);
  solution.sort(sort); error.sort(sort);
  let solutionTag = solution[0];
  if (!solutionTag) solutionTag = error.length ? tag('missed', 'defence', [best.pv[0]?.slice(2, 4) as Square].filter(Boolean)) : tag('missed', 'positional', []);
  if (!solution.length && error.length) solution.push(solutionTag);
  // primary: the allowed error when the move lost material or allowed mate (that is the lesson), else the missed idea
  const primary = error[0] && error[0].motif !== 'material' ? error[0] : solution[0] && !['positional', 'material', 'defence'].includes(solution[0].motif) ? solution[0] : error[0] ?? solution[0] ?? solutionTag;
  return { solution, error, primary, solutionTag };
}

export function phaseOf(fen: string, plyIndex: number): Phase {
  const board = fen.split(' ')[0];
  const mm = (board.match(/[nbrqNBRQ]/g) ?? []).length;
  if (mm <= 6) return 'endgame';
  if (plyIndex < 20 && mm > 10) return 'opening';
  return 'middlegame';
}
