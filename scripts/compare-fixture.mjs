// Builds test/compare.fixture.json: a game continuation vs a replay that diverges, keeps material, then slips once.
import { readFileSync, writeFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { engine } from './sf.mjs';
const g = new Chess(); g.loadPgn(readFileSync('test/g_186092857180.pgn', 'utf8'));
const hist = g.history({ verbose: true });
const k = hist.findIndex((m, i) => i === 28 && m.san === 'exd5');
if (k < 0) throw new Error('exd5 not found');
const startFen = hist[k].before;
const original = hist.slice(k, k + 14).map((m) => m.from + m.to + (m.promotion ?? ''));
const sf = await engine();
const evalsOf = async (fen, ucis) => {
  const c = new Chess(fen); const out = [(await sf.analyse(c.fen(), 14, 1)).lines[0]?.score ?? null];
  for (const u of ucis) { c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); out.push(c.isGameOver() ? (c.isCheckmate() ? { cp: c.turn() === 'w' ? -100000 : 100000, mate: 0 } : { cp: 0, mate: null }) : (await sf.analyse(c.fen(), 14, 1)).lines[0]?.score ?? null); }
  return out;
};
// replay: best move, engine play for 3 more of my moves, then my worst non-losing-everything move (a slip), then engine play
const c = new Chess(startFen); const me = c.turn(); const replay = []; let mine = 0;
while (replay.length < 14 && !c.isGameOver()) {
  let u;
  if (c.turn() === me && mine === 3) {
    const cands = [];
    for (const m of c.moves({ verbose: true })) { const t = new Chess(c.fen()); t.move(m); const s = (await sf.analyse(t.fen(), 10, 1)).lines[0]?.score; if (s) cands.push({ u: m.from + m.to + (m.promotion ?? ''), cp: me === 'w' ? s.cp : -s.cp }); }
    cands.sort((a, b) => b.cp - a.cp);
    // a clear slip that is not the very worst move: the one closest to 250 cp below best
    const wp = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    const best = wp(cands[0].cp);
    u = cands.reduce((a, b) => (Math.abs(best - wp(b.cp) - 25) < Math.abs(best - wp(a.cp) - 25) ? b : a)).u;
  } else u = (await sf.analyse(c.fen(), 14, 1)).lines[0].pv[0];
  if (c.turn() === me) mine++;
  c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
  replay.push(u);
}
// a taken-back attempt: the game move again, then one reply
const takenBack = original.slice(0, 2);
const fx = { startFen, me, original: { ucis: original, evals: await evalsOf(startFen, original) }, replay: { ucis: replay, evals: await evalsOf(startFen, replay) }, takenBack: { ucis: takenBack, evals: await evalsOf(startFen, takenBack) } };
sf.quit();
writeFileSync('test/compare.fixture.json', JSON.stringify(fx));
console.log(JSON.stringify({ startFen, original, replay }));
