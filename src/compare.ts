// "Compare with original": the game continuation and a played-out replay from the same position, aligned
// by move, with divergence points, both win-chance curves, both sides' mistakes and grounded explanations.
import { Chess, type Color } from 'chess.js';
import { winPct } from './classify';
import { uciToMove, NAME } from './tactics';
import { ledger, amountWords, type Ledger } from './ledger';
import type { Score } from './engine';

export type LineId = 'original' | 'replay' | 'taken-back';
export interface LineIn { id: LineId; ucis: string[]; /** evals[k] = eval after k plies (white POV); evals[0] = start. */ evals: (Score | null)[] }
export interface Mv { k: number; uci: string; san: string; label: string; fenBefore: string; fenAfter: string; mine: boolean; wpBefore: number | null; wpAfter: number | null; loss: number | null }
export interface Slip { line: LineId; k: number; label: string; san: string; loss: number; concept: Concept; detail: string }
export type Concept = 'piece-safety' | 'king-safety' | 'missed-chance' | 'positional';
export const CONCEPT_LABEL: Record<Concept, string> = { 'piece-safety': 'piece-safety', 'king-safety': 'king-safety', 'missed-chance': 'missed-chance', positional: 'positional' };
export interface Divergence { k: number; label: string; origSan: string | null; replaySan: string | null; wpBefore: number | null; origEnd: number | null; replayEnd: number | null; origL: Ledger; replayL: Ledger; text: string }
export interface Row { k: number; label: string; orig: Mv | null; replay: Mv | null; shared: boolean }
export interface Comparison { me: Color; startFen: string; rows: Row[]; divergences: Divergence[]; curves: { original: (number | null)[]; replay: (number | null)[] }; slips: Slip[]; repeated: Concept[]; fixed: Concept[]; summary: string }

export const SLIP_MIN = 8; // same threshold as the play-out summary
const key = (fen: string) => fen.split(' ').slice(0, 4).join(' ');

export function moveLabel(fenBefore: string, san: string): string {
  const [, side, , , , full] = fenBefore.split(' ');
  return `${full}${side === 'w' ? '.' : '...'}${san}`;
}

/** Walk a line, attaching SAN, positions and the mover's win chance before and after each move. */
export function walk(startFen: string, line: LineIn, me: Color): Mv[] {
  const c = new Chess(startFen);
  const out: Mv[] = [];
  for (let k = 0; k < line.ucis.length; k++) {
    const fenBefore = c.fen();
    const mover = c.turn();
    const mv = uciToMove(c, line.ucis[k]);
    if (!mv) break;
    const b = line.evals[k], a = line.evals[k + 1];
    const wpBefore = b ? winPct(b, mover) : null, wpAfter = a ? winPct(a, mover) : (c.isCheckmate() ? 100 : null);
    out.push({ k: k + 1, uci: line.ucis[k], san: mv.san, label: moveLabel(fenBefore, mv.san), fenBefore, fenAfter: c.fen(), mine: mover === me,
      wpBefore: wpBefore == null ? null : mePov(wpBefore, mover, me), wpAfter: wpAfter == null ? null : mePov(wpAfter, mover, me),
      loss: wpBefore != null && wpAfter != null ? Math.max(0, wpBefore - wpAfter) : null });
  }
  return out;
}
const mePov = (wp: number, mover: Color, me: Color) => (mover === me ? wp : 100 - wp);

/** What kind of error a slip was, from the actual continuation that followed it (not a guess). */
export function slipConcept(startFen: string, mvs: Mv[], i: number, me: Color): { concept: Concept; detail: string } {
  const m = mvs[i];
  const follow = mvs.slice(i, i + 7).map((x) => x.uci);
  const L = ledger(m.fenBefore, follow, me, 6);
  const end = mvs[Math.min(mvs.length - 1, i + 6)];
  if (L.mate || (end && new Chess(end.fenAfter).isCheckmate() && new Chess(end.fenAfter).turn() === me)) return { concept: 'king-safety', detail: 'it allowed a mating attack' };
  if (L.lost.length || L.netChange <= -2) {
    const p = L.lost[0];
    return { concept: 'piece-safety', detail: p ? `the ${NAME[p.type]} on ${p.sq} was lost ${p.ply <= 2 ? 'on the next move' : `${pliesWords(p.ply - 1)} later`}` : `${amountWords(L.netChange)} was lost in the next moves` };
  }
  return { concept: 'positional', detail: 'no material was lost right away; the position got worse' };
}
const pliesWords = (plies: number) => { const mv = Math.max(1, Math.round(plies / 2)); return mv === 1 ? 'one move' : mv === 2 ? 'two moves' : `${mv} moves`; };

export function compareLines(startFen: string, me: Color, original: LineIn, replay: LineIn, takenBack: LineIn[] = []): Comparison {
  const O = walk(startFen, original, me), R = walk(startFen, replay, me);
  const n = Math.max(O.length, R.length);
  const rows: Row[] = [];
  const divergences: Divergence[] = [];
  let shared = true;
  for (let k = 0; k < n; k++) {
    const o = O[k] ?? null, r = R[k] ?? null;
    const same = !!o && !!r && (o.uci === r.uci || key(o.fenAfter) === key(r.fenAfter));
    const before = k === 0 ? true : !!O[k - 1] && !!R[k - 1] && key(O[k - 1].fenAfter) === key(R[k - 1].fenAfter);
    if (before && !same && o && r) divergences.push(divergenceAt(startFen, me, O, R, k));
    shared = same;
    rows.push({ k: k + 1, label: ((o ?? r)!.label.match(/^\d+\.+/) ?? [''])[0], orig: o, replay: r, shared });
  }
  const slips: Slip[] = [];
  const addSlips = (line: LineId, mvs: Mv[]) => mvs.forEach((m, i) => {
    if (!m.mine || m.loss == null || m.loss < SLIP_MIN) return;
    const c = slipConcept(startFen, mvs, i, me);
    slips.push({ line, k: m.k, label: m.label, san: m.san, loss: m.loss, concept: c.concept, detail: c.detail });
  });
  addSlips('original', O); addSlips('replay', R);
  for (const t of takenBack) addSlips('taken-back', walk(startFen, t, me));
  slips.sort((a, b) => a.k - b.k || (a.line < b.line ? -1 : 1));
  const firstDiv = divergences[0]?.k ?? 0;
  const oc = new Set(slips.filter((s) => s.line === 'original' && s.k >= firstDiv).map((s) => s.concept));
  const rc = new Set(slips.filter((s) => s.line === 'replay' && s.k >= firstDiv).map((s) => s.concept));
  const repeated = [...oc].filter((c) => rc.has(c));
  const fixed = [...oc].filter((c) => !rc.has(c));
  const curve = (mvs: Mv[], line: LineIn) => [line.evals[0] ? winPct(line.evals[0], me) : null, ...mvs.map((m) => m.wpAfter)];
  const cmp: Comparison = { me, startFen, rows, divergences, curves: { original: curve(O, original), replay: curve(R, replay) }, slips, repeated, fixed, summary: '' };
  for (const d of divergences) d.text = divergenceText(d, cmp, R);
  cmp.summary = divergences.length ? divergences[0].text : O.length && R.length ? 'The replay followed the game exactly.' : 'Nothing to compare yet.';
  return cmp;
}

function divergenceAt(startFen: string, me: Color, O: Mv[], R: Mv[], k: number): Divergence {
  const o = O[k], r = R[k];
  const origL = ledger(o.fenBefore, O.slice(k, k + 7).map((x) => x.uci), me, 6);
  const replayL = ledger(r.fenBefore, R.slice(k, k + 7).map((x) => x.uci), me, 6);
  const last = (xs: Mv[]) => { for (let i = xs.length - 1; i >= 0; i--) if (xs[i].wpAfter != null) return xs[i].wpAfter; return null; };
  return { k: k + 1, label: o.label, origSan: o.san, replaySan: r.san, wpBefore: o.mine ? o.wpBefore : r.wpBefore, origEnd: last(O), replayEnd: last(R), origL, replayL, text: '' };
}

const pct = (x: number | null) => (x == null ? '?' : `${Math.round(x)}%`);

/** One grounded paragraph per divergence: what each line did with material, the win chance, and whether the error type repeated. */
export function divergenceText(d: Divergence, cmp: Comparison, R: Mv[]): string {
  const repLabel = moveLabel(R[d.k - 1].fenBefore, d.replaySan!);
  const parts: string[] = [`You diverged at ${d.label} → ${repLabel}.`];
  const lostO = d.origL.lost[0];
  let orig = '';
  if (lostO) orig = `In the original you lost the ${NAME[lostO.type]} ${lostO.ply <= 2 ? 'on the next move' : `${pliesWords(lostO.ply - 1)} later`}`;
  else if (d.origL.netChange < 0) orig = `In the original you ended up ${amountWords(d.origL.netChange)} down`;
  else if (d.origL.netChange > 0) orig = `In the original you came out ${amountWords(d.origL.netChange)} ahead`;
  else orig = 'In the original material stayed level';
  let rep: string;
  if (d.replayL.netChange >= 0 && d.origL.netChange < 0) rep = 'here you kept material';
  else if (d.replayL.lost[0]) rep = `here you lost the ${NAME[d.replayL.lost[0].type]} instead`;
  else if (d.replayL.netChange > 0) rep = `here you came out ${amountWords(d.replayL.netChange)} ahead`;
  else rep = 'here material also stayed level';
  const wp = d.wpBefore != null && d.replayEnd != null ? ` and your win chance ${d.replayEnd >= d.wpBefore ? 'rose' : 'fell'} from ${pct(d.wpBefore)} to ${pct(d.replayEnd)}` : '';
  parts.push(`${orig}; ${rep}${wp}${d.origEnd != null ? ` (the original ended at ${pct(d.origEnd)})` : ''}.`);
  const after = cmp.slips.filter((s) => s.line === 'replay' && s.k >= d.k);
  if (after.length) {
    const worst = after.reduce((a, b) => (b.loss > a.loss ? b : a));
    const same = cmp.slips.some((s) => s.line === 'original' && s.k >= d.k && s.concept === worst.concept);
    parts.push(`You still slipped ${after.length === 1 ? 'once' : `${after.length} times`}; the biggest was ${worst.label} (−${Math.round(worst.loss)}%), ${same ? `the same ${CONCEPT_LABEL[worst.concept]} pattern as in the game` : `a ${CONCEPT_LABEL[worst.concept]} error, different from the game`}.`);
  } else parts.push(`You made no slip of ${SLIP_MIN}% or more after that.`);
  if (cmp.fixed.length) parts.push(`The ${cmp.fixed.map((c) => CONCEPT_LABEL[c]).join(' and ')} error from the game did not come back.`);
  return parts.join(' ');
}

/** Facts in the comparison text must match the data: used by tests and as a runtime guard. */
export function checkComparison(cmp: Comparison): string[] {
  const bad: string[] = [];
  for (const d of cmp.divergences) {
    for (const x of d.text.matchAll(/from (\d+)% to (\d+)%/g)) {
      if (d.wpBefore == null || Math.round(d.wpBefore) !== +x[1] || d.replayEnd == null || Math.round(d.replayEnd) !== +x[2]) bad.push(`win chance ${x[0]}`);
    }
    for (const x of d.text.matchAll(/In the original you lost the (\w+)/g)) if (!d.origL.lost.some((p) => NAME[p.type] === x[1])) bad.push(x[0]);
    if (/here you kept material/.test(d.text) && d.replayL.netChange < 0) bad.push('kept material');
    for (const x of d.text.matchAll(/biggest was (\S+) \(−(\d+)%\)/g)) if (!cmp.slips.some((s) => s.line === 'replay' && s.label === x[1] && Math.round(s.loss) === +x[2])) bad.push(x[0]);
    for (const x of d.text.matchAll(/the same ([\w-]+) pattern/g)) if (!cmp.slips.some((s) => s.line === 'original' && s.concept === x[1])) bad.push(x[0]);
    if (!cmp.rows.some((r) => r.orig?.label === d.label)) bad.push(`divergence label ${d.label}`);
  }
  return bad;
}
