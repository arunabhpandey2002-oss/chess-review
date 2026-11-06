// The two screens after "Play it out": a review of the replay (same pipeline as a real game) and the comparison with the game.
import { Chessground } from 'chessground';
import type { Key } from 'chessground/types';
import type { Color } from 'chess.js';
import type { PosEval } from './engine';
import { parseGame, reviewGame, type MoveReview, type Ply } from './review';
import { buildMoments, type Moment } from './coach';
import { CLS_META, type Cls } from './classify';
import type { Level } from './moments';
import { lessonFor } from './lesson';
import { VTree } from './tree';
import { renderText } from './words';
import { $, esc, srcChip, srcTags } from './ui';
import { CONCEPT_LABEL, type Comparison } from './compare';

export interface ReplayReview { plies: Ply[]; reviews: (MoveReview | null)[]; moments: Moment[]; counts: Partial<Record<Cls, number>>; mine: number }

export function analyseReplay(start: string, ucis: string[], evals: (PosEval | null)[], me: Color, level: Level): ReplayReview {
  const t = new VTree(start);
  let id = t.root.id;
  for (const u of ucis) { const n = t.add(id, u, 'replay', { record: false }); if (!n) break; id = n.id; }
  const { plies } = parseGame(t.pgn());
  const reviews = reviewGame({ plies, evals, book: null });
  const moments = plies.length ? buildMoments(plies, evals, reviews, me, level) : [];
  const counts: Partial<Record<Cls, number>> = {};
  let mine = 0;
  plies.forEach((p, i) => { const r = reviews[i]; if (p.color !== me || !r) return; mine++; counts[r.cls] = (counts[r.cls] ?? 0) + 1; });
  return { plies, reviews, moments, counts, mine };
}

const plural = (n: number, w: string) => `${n} ${n === 1 ? w : w.endsWith('y') ? `${w.slice(0, -1)}ies` : `${w}s`}`;

export function renderReplayReview(el: HTMLElement, d: ReplayReview, o: { level: Level; nt: boolean; hasOriginal: boolean; onCompare: () => void; onAgain: () => void; onSave?: (m: Moment) => Promise<boolean> }) {
  const good = (d.counts.best ?? 0) + (d.counts.excellent ?? 0) + (d.counts.great ?? 0) + (d.counts.brilliant ?? 0);
  const bad = (['inaccuracy', 'mistake', 'miss', 'blunder'] as Cls[]).filter((c) => d.counts[c]).map((c) => plural(d.counts[c]!, CLS_META[c].label.toLowerCase()));
  const txt = (t: string) => esc(renderText(t, o.nt ? 'san' : 'words'));
  el.innerHTML = `
    <h3>Review of your replay</h3>
    <p class="small">${d.mine ? `Your ${plural(d.mine, 'move')}: ${good} best or excellent${bad.length ? `, ${bad.join(', ')}` : ', no inaccuracies or worse'}.` : 'You did not play a move yet.'} ${srcChip('engine')} <span class="muted">Depth 12, saved on this device.</span></p>
    ${d.moments.length ? `<div class="rr-list">${d.moments.map((m, i) => {
      const L = lessonFor(m, { level: o.level });
      const pick = L.sections.filter((s) => s.id === 'happened' || s.id === 'best');
      return `<div class="rr-item"><b>${esc(`${m.moveNumber}${m.color === 'w' ? '.' : '...'}${m.playedSan}`)}</b> <span class="muted">→ better ${esc(m.bestSan)}</span>
        ${pick.map((s) => `<p class="small">${txt(s.text)} ${srcChip(s.src)}</p>`).join('')}
        ${o.onSave ? `<button class="btn sm" data-save="${i}">Save as puzzle</button>` : ''}</div>`;
    }).join('')}</div>` : '<p class="muted small">No critical moments: none of your replay moves lost a clear, teachable amount.</p>'}
    <div class="tr-after">${o.hasOriginal ? '<button class="btn primary" id="sp-compare">Compare with original</button>' : ''}<button class="btn ghost" id="sp-again">Play again</button></div>`;
  const cb = el.querySelector<HTMLButtonElement>('#sp-compare'); if (cb) cb.onclick = o.onCompare;
  $('#sp-again', el).onclick = o.onAgain;
  el.querySelectorAll<HTMLButtonElement>('[data-save]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    const ok = await o.onSave!(d.moments[+b.dataset.save!]);
    b.textContent = ok ? 'Saved to Practice' : 'Could not save';
  }));
}

const W = 600, H = 120;
function graph(cmp: Comparison, k: number): string {
  const n = Math.max(1, cmp.rows.length);
  const xy = (i: number, wp: number) => `${((i / n) * W).toFixed(1)},${(((100 - wp) / 100) * H).toFixed(1)}`;
  const path = (c: (number | null)[]) => c.map((wp, i) => (wp == null ? null : xy(i, wp))).filter(Boolean).join(' ');
  const div = cmp.divergences.map((d) => `<line class="cg-div" x1="${(((d.k - 1) / n) * W).toFixed(1)}" x2="${(((d.k - 1) / n) * W).toFixed(1)}" y1="0" y2="${H}"/>`).join('');
  const dots = cmp.slips.filter((s) => s.line !== 'taken-back').map((s) => {
    const c = s.line === 'original' ? cmp.curves.original : cmp.curves.replay;
    const wp = c[s.k]; if (wp == null) return '';
    const [x, y] = xy(s.k, wp).split(',');
    return `<circle class="cg-dot cg-${s.line}" cx="${x}" cy="${y}" r="4.5"><title>${esc(`${s.line === 'original' ? 'Game' : 'Replay'} ${s.label}: −${Math.round(s.loss)}%`)}</title></circle>`;
  }).join('');
  const x = ((k / n) * W).toFixed(1);
  return `<svg class="cmp-graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Your win chance in the game (dashed) and in your replay (solid), move by move">
    <line class="cg-mid" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/>${div}
    <polyline class="cg-line cg-original" points="${path(cmp.curves.original)}"/>
    <polyline class="cg-line cg-replay" points="${path(cmp.curves.replay)}"/>
    ${dots}<line class="cg-cur" x1="${x}" x2="${x}" y1="0" y2="${H}"/></svg>`;
}

export function renderCompare(el: HTMLElement, cmp: Comparison, o: { nt: boolean; onBack: () => void; onAgain: () => void }) {
  let k = cmp.divergences[0]?.k ?? 0;
  const orientation = cmp.me === 'w' ? 'white' : 'black';
  const byMove = new Map<string, { label: string; original?: string; replay?: string; tb: string[] }>();
  for (const s of cmp.slips) {
    const num = s.label.match(/^\d+\.+/)![0];
    const row = byMove.get(num) ?? { label: num, tb: [] };
    const cell = `${s.san} <span class="loss">−${Math.round(s.loss)}%</span> <span class="muted">${esc(CONCEPT_LABEL[s.concept])}</span>`;
    if (s.line === 'taken-back') row.tb.push(cell); else row[s.line] = cell;
    byMove.set(num, row);
  }
  const rows = [...byMove.values()];
  el.innerHTML = `
    <h3>Compare with original</h3>
    ${cmp.divergences.map((d) => `<p class="cmp-sum">${esc(d.text)} ${srcTags(['engine', 'rules'])}</p>`).join('') || `<p class="cmp-sum">${esc(cmp.summary)}</p>`}
    <div class="cmp-graph-wrap" id="cmp-graph">${graph(cmp, k)}</div>
    <p class="cmp-key small muted"><span class="k-orig"></span> Game <span class="k-rep"></span> Your replay · dots are slips of 8% or more</p>
    <div class="cmp-step">
      <div class="cmp-boards">
        <figure><figcaption>Game</figcaption><div class="cmp-board" id="cmp-b1"></div><div class="cmp-mv" id="cmp-m1"></div></figure>
        <figure><figcaption>Your replay</figcaption><div class="cmp-board" id="cmp-b2"></div><div class="cmp-mv" id="cmp-m2"></div></figure>
      </div>
      <div class="cmp-nav"><button class="btn" id="cmp-prev" aria-label="Previous move">‹</button><span id="cmp-at" aria-live="polite"></span><button class="btn" id="cmp-next" aria-label="Next move">›</button></div>
    </div>
    <h4>Slips in both lines</h4>
    ${rows.length ? `<table class="cmp-table"><thead><tr><th>Move</th><th>Game</th><th>Replay</th>${rows.some((r) => r.tb.length) ? '<th>Taken back</th>' : ''}</tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${r.original ?? '–'}</td><td>${r.replay ?? '–'}</td>${rows.some((x) => x.tb.length) ? `<td>${r.tb.join('<br>') || '–'}</td>` : ''}</tr>`).join('')}</tbody></table>` : '<p class="muted small">No slips of 8% or more in either line.</p>'}
    ${cmp.repeated.length || cmp.fixed.length ? `<p class="small">${cmp.fixed.length ? `Not repeated in the replay: ${esc(cmp.fixed.map((c) => CONCEPT_LABEL[c]).join(', '))}. ` : ''}${cmp.repeated.length ? `Repeated from the game: ${esc(cmp.repeated.map((c) => CONCEPT_LABEL[c]).join(', '))}.` : ''} ${srcChip('rules')}</p>` : ''}
    <div class="tr-after"><button class="btn" id="cmp-back">Back to review</button><button class="btn ghost" id="sp-again">Play again</button></div>`;
  const cfg = { viewOnly: true, coordinates: false, orientation, animation: { enabled: false }, drawable: { enabled: false, visible: false } } as const;
  const b1 = Chessground($('#cmp-b1', el), { ...cfg, fen: cmp.startFen });
  const b2 = Chessground($('#cmp-b2', el), { ...cfg, fen: cmp.startFen });
  const at = (line: 'orig' | 'replay', i: number) => { for (let j = Math.min(i, cmp.rows.length) - 1; j >= 0; j--) { const m = cmp.rows[j][line]; if (m) return m; } return null; };
  const show = () => {
    const a = at('orig', k), b = at('replay', k);
    b1.set({ fen: a?.fenAfter ?? cmp.startFen, lastMove: a ? [a.uci.slice(0, 2) as Key, a.uci.slice(2, 4) as Key] : undefined });
    b2.set({ fen: b?.fenAfter ?? cmp.startFen, lastMove: b ? [b.uci.slice(0, 2) as Key, b.uci.slice(2, 4) as Key] : undefined });
    const r = cmp.rows[k - 1];
    const wp = (c: (number | null)[]) => (c[k] == null ? '' : ` · ${Math.round(c[k]!)}%`);
    $('#cmp-m1', el).textContent = r?.orig ? `${r.orig.label}${wp(cmp.curves.original)}` : k ? 'game ended' : 'start';
    $('#cmp-m2', el).textContent = r?.replay ? `${r.replay.label}${wp(cmp.curves.replay)}` : k ? 'replay ended' : 'start';
    $('#cmp-at', el).textContent = k ? `Move ${r?.label ?? ''} (${k} of ${cmp.rows.length})${r && !r.shared ? '' : ' · same position'}` : 'Shared starting position';
    $('#cmp-graph', el).innerHTML = graph(cmp, k);
    $<HTMLButtonElement>('#cmp-prev', el).disabled = k <= 0;
    $<HTMLButtonElement>('#cmp-next', el).disabled = k >= cmp.rows.length;
  };
  $('#cmp-prev', el).onclick = () => { k = Math.max(0, k - 1); show(); };
  $('#cmp-next', el).onclick = () => { k = Math.min(cmp.rows.length, k + 1); show(); };
  el.querySelector('.cmp-step')!.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'ArrowLeft') { k = Math.max(0, k - 1); show(); ke.preventDefault(); }
    if (ke.key === 'ArrowRight') { k = Math.min(cmp.rows.length, k + 1); show(); ke.preventDefault(); }
  });
  $('#cmp-back', el).onclick = o.onBack;
  $('#sp-again', el).onclick = o.onAgain;
  show();
  void o.nt;
}
