// Level-appropriate, rule-generated explanations and staged hints for a critical moment.
// Pipeline: Stockfish lines -> facts (facts.ts) -> concept tags (concepts.ts) -> templates (here) -> ground check.
// An LLM phrasing layer could later replace `templates` and must pass the same `groundCheck` (see docs/PRODUCT_PLAN.md).
import { Chess, type Color, type Square } from 'chess.js';
import type { Line } from './engine';
import { winPct } from './classify';
import { lineFacts, threatFacts, evalWords, fmtScore, type Ply } from './review';
import { pvToSan, uciToMove } from './tactics';
import { threatsAgainst, nullMove, moveAppeal } from './facts';
import { MOTIF_INFO, type Tag, type TagResult } from './concepts';
import type { Level } from './moments';
import { tokMove, renderText } from './words';
import { tolerance } from './retry';

export interface MomentCore {
  ply: number;
  moveNumber: number;
  color: Color;
  fenBefore: string;
  fenAfter: string;
  playedUci: string;
  playedSan: string;
  bestUci: string;
  bestSan: string;
  lines: Line[]; // MultiPV lines in fenBefore
  reply: Line | null; // engine's best reply after the game move
  wpBest: number;
  wpPlayed: number;
  loss: number;
  cls: string;
  tags: TagResult;
  prevUci?: string; // opponent's previous move (UCI), from the position before it
  prevFen?: string;
}

export type Source = 'engine' | 'rules' | 'formula' | 'estimate';
export interface Section { label: string; text: string; src: Source }
export interface Hint { stage: 1 | 2 | 3 | 4; title: string; text: string; squares?: Square[]; candidates?: string[] }

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const pieceName: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export function wpWords(wp: number): string {
  if (wp >= 90) return 'winning';
  if (wp >= 65) return 'better';
  if (wp > 35) return 'roughly equal';
  if (wp > 10) return 'worse';
  return 'losing';
}

function plyLike(m: MomentCore): Ply {
  return { fenBefore: m.fenBefore, fenAfter: m.fenAfter, uci: m.playedUci, to: m.playedUci.slice(2, 4), from: m.playedUci.slice(0, 2), san: m.playedSan, color: m.color } as unknown as Ply;
}

function prevMove(m: MomentCore) {
  if (!m.prevFen || !m.prevUci) return null;
  return uciToMove(new Chess(m.prevFen), m.prevUci);
}

/** Lines the player could have played that are within the acceptance tolerance. */
export function acceptableLines(m: MomentCore): Line[] {
  const tol = tolerance(m.wpBest, m.wpPlayed);
  return m.lines.filter((l) => l.pv[0] !== m.playedUci && m.wpBest - winPct(l.score, m.color) <= tol);
}

// ---------------- hints ----------------
export function buildHints(m: MomentCore): Hint[] {
  const hints: Hint[] = [];
  const th = threatsAgainst(m.fenBefore);
  let t1: string;
  const t1sq: Square[] = [];
  if (th.inCheck) t1 = 'You are in check. List every legal way out of check (move the king, block, or capture the checking piece) before choosing.';
  else if (th.mates.length) {
    const n = nullMove(m.fenBefore)!;
    const san = pvToSan(n.fen(), [th.mates[0]], 1)[0];
    t1 = `Your opponent threatens checkmate with ${tokMove(n.fen(), san)}. Whatever you play must stop it.`;
    t1sq.push(th.mates[0].slice(2, 4) as Square);
  } else if (th.captures.length) {
    const c = th.captures.slice(0, 2);
    t1 = `Your opponent is threatening to win ${c.map((x) => `your ${pieceName[x.type]} on ${x.sq}`).join(' and ')}: ${c.length > 1 ? 'they are' : 'it is'} attacked and not defended enough.`;
    t1sq.push(...c.map((x) => x.sq));
  } else if (th.promotions?.length) {
    const sq = th.promotions[0].slice(2, 4) as Square;
    t1 = `Your opponent threatens to promote a pawn on ${sq}. Stopping it comes first.`;
    t1sq.push(th.promotions[0].slice(0, 2) as Square, sq);
  } else {
    const pm = prevMove(m);
    t1 = `None of your pieces can be won right away and there is no mate-in-one threat.${pm ? ` Ask what their last move, ${tokMove(m.prevFen!, pm.san)}, changed,` : ' Look'} and check your own checks, captures and threats.`;
  }
  hints.push({ stage: 1, title: "Opponent's threat", text: t1, squares: t1sq });
  const to = m.bestUci.slice(2, 4);
  const f = to.charCodeAt(0) - 97, r = +to[1] - 1;
  const area: Square[] = [];
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    const ff = f + df, rr = r + dr;
    if (ff >= 0 && ff < 8 && rr >= 0 && rr < 8) area.push((String.fromCharCode(97 + ff) + (rr + 1)) as Square);
  }
  hints.push({ stage: 2, title: 'Where to look', text: 'The key move happens in the highlighted area of the board.', squares: area });
  const st = m.tags.solutionTag;
  const info = MOTIF_INFO[st.motif];
  const motifText = st.motif === 'defence'
    ? 'Idea: a defensive move. Deal with the danger first while keeping all your pieces safe.'
    : st.motif === 'positional'
    ? 'Idea: there is no immediate tactic here. Improve your position: a safer king, a better square for a piece, or a stronger pawn structure.'
    : `Idea: ${info.name.toLowerCase()}. ${cap(info.idea)}.`;
  hints.push({ stage: 3, title: 'The idea', text: motifText });
  const cands = new Map<string, string>([[m.bestUci, m.bestSan]]);
  for (const l of m.lines.slice(1, 3)) { const s = pvToSan(m.fenBefore, l.pv, 1)[0]; if (s && cands.size < 2 && l.pv[0] !== m.playedUci) cands.set(l.pv[0], s); }
  cands.set(m.playedUci, m.playedSan);
  const list = [...cands.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  hints.push({ stage: 4, title: 'Candidate moves', text: `Compare these moves: ${list.map(([, s]) => tokMove(m.fenBefore, s)).join(', ')}. You played ${tokMove(m.fenBefore, m.playedSan)} in the game.`, candidates: list.map(([u]) => u) });
  return hints;
}

// ---------------- explanation ----------------
const NOTICE: Record<string, string> = {
  'allowed:hanging-piece': 'Before you move, ask: after this move, which of my pieces are attacked, and is each one defended?',
  'missed:hanging-piece': 'After every opponent move, check whether they left anything undefended that you can take.',
  'missed:fork': 'Look for squares where one of your pieces would attack two things at once, especially with check.',
  'allowed:fork': 'Check whether an enemy knight or queen could jump to a square that attacks two of your pieces at once.',
  'missed:pin': 'Look for enemy pieces standing on one line in front of a more valuable piece: that line is where pins happen.',
  'allowed:pin': 'Avoid lining up a piece in front of your king or queen on a line an enemy bishop, rook or queen can reach.',
  'missed:skewer': 'When the enemy king or queen stands on a line with another piece behind it, look for a skewer.',
  'allowed:skewer': 'Avoid putting your king or queen on the same line as another undefended piece where an enemy long-range piece can attack.',
  'missed:discovered-attack': 'When one of your pieces blocks your own bishop, rook or queen, moving it can unleash a second attack.',
  'allowed:discovered-attack': 'Watch enemy pieces that block a bishop, rook or queen aimed at your pieces: moving them can uncover an attack.',
  'missed:removing-defender': 'Ask which enemy piece is doing the guarding; capturing it can make another piece fall.',
  'allowed:mate': "Before every move, look at all of your opponent's checks. If one of them is mate, stop it first.",
  'missed:mate': 'Always look at every check you can give first. Forcing moves come before quiet moves.',
  'allowed:back-rank': 'If your king is stuck behind its own pawns, make an escape square or keep a rook guarding the back rank.',
  'missed:back-rank': "Is the enemy king stuck on its back rank behind its own pawns? A rook or queen check there can be mate.",
  'allowed:promotion': 'Count how many moves an enemy passed pawn needs to promote, and make sure you can stop it.',
  'missed:promotion': 'Count how many moves your passed pawn needs to promote and whether anything can stop it.',
  'allowed:ignored-threat': 'After your opponent moves, ask: what does that move threaten?',
  'allowed:material': 'Check every capture and every check for both sides, a few moves deep, before moving.',
  'missed:material': 'Check every capture and every check you have before choosing a quiet move.',
  'missed:defence': 'When your opponent has a threat, deal with it first, then look for your own chances.',
  'missed:positional': 'When there is no tactic, compare plans: improve your worst piece and keep your king and pawns safe.',
};

export function noticeFor(t: Tag): string { return NOTICE[t.id] ?? NOTICE['allowed:material']; }

export interface Lesson { sections: Section[]; linePlies: number; grounded: boolean }

export function explainMoment(m: MomentCore, level: Level): Lesson {
  const sections: Section[] = [];
  const P = tokMove(m.fenBefore, m.playedSan);
  const B = tokMove(m.fenBefore, m.bestSan);
  const best = m.lines[0];
  const ply = plyLike(m);
  const nums = (a: number, b: number) => (level === 'beginner' ? '' : level === 'intermediate' ? ` (estimated win chance ${a.toFixed(0)}% to ${b.toFixed(0)}%)` : ` (${fmtScore(best.score)} with best play, ${fmtScore(m.reply?.score)} after your move)`);
  // 1. what happened
  const tf = m.reply ? threatFacts(ply, m.reply, m.color) : null;
  const pm = prevMove(m);
  let s1 = '';
  if (m.cls === 'miss' && pm) s1 = `Your opponent's move ${tokMove(m.prevFen!, pm.san)} gave you a chance, but ${P} did not take it.`;
  else s1 = `In the game you played ${P}.`;
  if (tf) s1 += ` ${cap(tf.text.replace(/^it /, 'this '))}.`;
  s1 += ` Your position went from ${wpWords(m.wpBest)} to ${wpWords(m.wpPlayed)}${nums(m.wpBest, m.wpPlayed)}.`;
  sections.push({ label: 'What happened', text: s1, src: 'rules' });
  // 2. why the best move works
  const bf = lineFacts(m.fenBefore, best, m.color, pm);
  sections.push({
    label: `Why ${m.bestSan} works`,
    text: bf ? `${B} is best because ${bf}.` : `${B} keeps the position ${evalWords(best.score, m.color)}. There is no single tactic to name here, so follow the line below.`,
    src: 'rules',
  });
  // 3. why the game move was tempting
  const appeal = moveAppeal(m.fenBefore, m.playedUci, m.ply);
  if (appeal.length) sections.push({ label: 'Why it was tempting', text: `${P} looked natural because ${appeal.slice(0, 2).join(' and ')}. ${tf ? 'But it overlooked what happens next.' : 'But it was not the strongest choice.'}`, src: 'rules' });
  // 4. what to notice
  sections.push({ label: 'What to notice next time', text: noticeFor(m.tags.primary), src: 'rules' });
  // 5. pattern
  const pi = MOTIF_INFO[m.tags.primary.motif];
  if (level !== 'beginner' || m.tags.primary.motif !== 'positional') sections.push({ label: 'Pattern to remember', text: `${pi.name}: ${pi.idea}.`, src: 'rules' });
  // 6. extra depth for stronger players
  const alts = acceptableLines(m).filter((l) => l.pv[0] !== m.bestUci);
  if (level !== 'beginner' && alts.length) {
    sections.push({ label: 'Also good', text: `${alts.map((l) => tokMove(m.fenBefore, pvToSan(m.fenBefore, l.pv, 1)[0])).join(', ')} would also have kept most of the advantage.`, src: 'engine' });
  }
  if (level === 'advanced' && m.lines[1]) {
    const s = m.lines[1];
    sections.push({ label: 'Engine comparison', text: `Second choice ${tokMove(m.fenBefore, pvToSan(m.fenBefore, s.pv, 1)[0])} scores ${fmtScore(s.score)}, against ${fmtScore(best.score)} for ${B}.`, src: 'engine' });
  }
  // ground check: every square mentioned must come from the board or the engine lines
  const allowed = allowedSquares(m);
  let grounded = true;
  for (const sec of sections) {
    if (!groundCheck(renderText(sec.text, 'words'), allowed)) {
      grounded = false;
      sec.text = `Concrete line: ${B}. See the moves listed below.`;
      sec.src = 'engine';
    }
  }
  return { sections, linePlies: level === 'beginner' ? 3 : level === 'intermediate' ? 5 : 8, grounded };
}

/** Squares that are legitimately part of the position or the engine lines. */
export function allowedSquares(m: MomentCore): Set<string> {
  const s = new Set<string>();
  const addBoard = (fen: string) => { for (const row of new Chess(fen).board()) for (const p of row) if (p) s.add(p.square); };
  addBoard(m.fenBefore); addBoard(m.fenAfter);
  const addPv = (fen: string, pv: string[]) => {
    const c = new Chess(fen);
    for (const u of pv.slice(0, 14)) { const mv = uciToMove(c, u); if (!mv) break; s.add(mv.from); s.add(mv.to); }
  };
  for (const l of m.lines) addPv(m.fenBefore, l.pv);
  if (m.reply) addPv(m.fenAfter, m.reply.pv);
  addPv(m.fenBefore, [m.playedUci]);
  if (m.prevFen && m.prevUci) addPv(m.prevFen, [m.prevUci]);
  const n = nullMove(m.fenBefore);
  if (n) for (const mv of n.moves({ verbose: true })) { s.add(mv.from); s.add(mv.to); }
  return s;
}

/** True when every square named in `text` is in `allowed`. Used for rule templates now and any LLM phrasing later. */
export function groundCheck(text: string, allowed: Set<string>): boolean {
  const sq = text.match(/\b[a-h][1-8]\b/g) ?? [];
  return sq.every((x) => allowed.has(x));
}
