// The "Analyse recent games" panel on the Games page: options, live progress, pause/resume/cancel and the batch summary.
import type { GameSummary } from './api';
import type { Book } from './review';
import type { Level } from './moments';
import { batch, planBatch, estimateSeconds, workersFor, MODES, STAGE_LABEL, type Mode, type Job } from './batch';
import { recurringErrors, evidenceLevel, EVIDENCE_LABEL } from './insights';
import * as store from './store';
import type { StoredReview } from './store';
import { $, esc } from './ui';

export interface BatchCtx { pk: string; user: string; level: Level; rating: number | null; games: () => GameSummary[]; loadMore: () => Promise<boolean>; book: () => Book | null; openGame: (id: string) => void; train: () => void }

const mins = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} seconds` : `${Math.round(s / 60)} minutes`);
const phone = () => matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 2) <= 4;

export async function renderBatchPanel(el: HTMLElement, c: BatchCtx) {
  let open = false;
  let unsub: (() => void) | null = null;
  const draw = async () => {
    if (!el.isConnected) { unsub?.(); return; }
    const m = batch.meta;
    const active = m && !m.cancelled && !m.finishedAt;
    if (active) return drawRun();
    if (m && m.finishedAt && !m.cancelled && !localStorage.getItem(`cr-batch-seen:${m.batchId}`)) return drawSummary();
    if (!open) {
      el.innerHTML = `<div class="batch-row"><button class="btn" id="b-open" aria-expanded="false">Analyse recent games</button><span class="muted small">Runs in the background on this device; you can keep browsing.</span></div>`;
      $('#b-open', el).onclick = () => { open = true; void draw(); };
      return;
    }
    const reviewed = new Set((await store.byProfile<StoredReview>('reviews', c.pk)).map((r) => r.gameId));
    const lastEnd = m?.finishedAt ? Math.floor(m.createdAt / 1000) : 0;
    const defMode: Mode = phone() ? 'light' : 'standard';
    el.innerHTML = `
      <form class="card batch-form" id="b-form">
        <h2>Analyse recent games</h2>
        <fieldset><legend>Games</legend>
          ${[5, 10, 25].map((n, i) => `<label><input type="radio" name="b-n" value="${n}"${i === 1 ? ' checked' : ''}> Last ${n}</label>`).join('')}
          ${lastEnd ? '<label><input type="radio" name="b-n" value="since"> Since last batch</label>' : ''}
        </fieldset>
        <label class="b-mode">Depth <select id="b-mode">${(Object.keys(MODES) as Mode[]).map((k) => `<option value="${k}"${k === defMode ? ' selected' : ''}>${MODES[k].label} · check depth ${MODES[k].verify}</option>`).join('')}</select></label>
        <p class="small" id="b-est" aria-live="polite"></p>
        <p class="muted small">Every position is checked once, then the critical ones again, deeper; only those can become lessons. Everything runs and stays in this browser. Only finished games are analysed: never use this during a game you are playing.</p>
        <div class="tr-after"><button class="btn primary" id="b-start">Start</button><button class="btn ghost" type="button" id="b-close">Not now</button></div>
      </form>`;
    const pickNow = () => {
      const v = (el.querySelector<HTMLInputElement>('input[name="b-n"]:checked')?.value) ?? '10';
      const n = v === 'since' ? 100 : +v;
      return planBatch(c.games(), c.user, reviewed, n, v === 'since' ? lastEnd : undefined);
    };
    const est = () => {
      const mode = $<HTMLSelectElement>('#b-mode', el).value as Mode;
      const { pick, skipped } = pickNow();
      const already = skipped.filter((s) => s.why === 'already reviewed').length;
      $('#b-est', el).textContent = pick.length
        ? `${pick.length} game${pick.length === 1 ? '' : 's'}, about ${mins(estimateSeconds(pick, mode, workersFor(mode)))} on this device (${workersFor(mode)} engine thread${workersFor(mode) === 1 ? '' : 's'}).${already ? ` ${already} already reviewed, skipped.` : ''}`
        : `Nothing new to analyse${already ? `: ${already} of these games are already reviewed` : ''}.`;
      $<HTMLButtonElement>('#b-start', el).disabled = !pick.length;
    };
    el.querySelectorAll('input, select').forEach((x) => x.addEventListener('change', est));
    $('#b-close', el).onclick = () => { open = false; void draw(); };
    $('#b-form', el).onsubmit = async (e) => {
      e.preventDefault();
      const v = (el.querySelector<HTMLInputElement>('input[name="b-n"]:checked')?.value) ?? '10';
      if (v === '25') { $('#b-est', el).textContent = 'Loading older games…'; for (let i = 0; i < 6 && c.games().length < 30; i++) if (!(await c.loadMore())) break; }
      const { pick } = pickNow();
      if (!pick.length) { est(); return; }
      open = false;
      await batch.start({ pk: c.pk, user: c.user, games: pick, mode: $<HTMLSelectElement>('#b-mode', el).value as Mode, level: c.level, rating: c.rating, book: c.book() });
    };
    est();
  };

  const drawRun = () => {
    const m = batch.meta!;
    const jobs = batch.jobs;
    const done = jobs.filter((j) => j.status === 'done' || j.status === 'skipped' || j.status === 'failed').length;
    const cur = jobs.find((j) => j.status === 'running');
    const opp = (j: Job) => (j.myColor === 'w' ? j.game.black.username : j.game.white.username);
    const frac = jobs.length ? (done + (cur && cur.posTotal ? cur.posDone / cur.posTotal : 0)) / jobs.length : 0;
    const status = batch.held && !m.paused ? `Waiting while a game review uses the engine · ${done} of ${jobs.length} done` : m.paused ? `Paused after ${done} of ${jobs.length} games.` : cur ? `Game ${done + 1} of ${jobs.length}: vs ${cur.myColor === 'w' ? cur.game.black.username : cur.game.white.username} · ${STAGE_LABEL[cur.stage]}${cur.posTotal ? ` ${cur.posDone}/${cur.posTotal}` : ''}` : batch.running ? 'Starting…' : `Waiting · ${done} of ${jobs.length} done`;
    const existing = el.querySelector('.batch-run');
    const list = `<ol class="b-jobs">${jobs.map((j) => `<li class="bj-${j.status}"><span>${esc(opp(j))}</span> <span class="muted small">${j.status === 'done' ? `${j.result?.moments ?? 0} lesson${j.result?.moments === 1 ? '' : 's'} · ${Math.round((j.result?.ms ?? 0) / 1000)} s` : j.status === 'running' ? esc(STAGE_LABEL[j.stage]) : j.status === 'queued' ? 'waiting' : esc(j.error || j.status)}</span>${j.status === 'done' ? ` <button class="link" data-open="${esc(j.gameId)}">Open</button>` : ''}</li>`).join('')}</ol>`;
    if (existing) {
      $('#b-status', el).textContent = status;
      $<HTMLElement>('.b-bar i', el).style.width = `${Math.round(frac * 100)}%`;
      $('.b-bar', el).setAttribute('aria-valuenow', String(Math.round(frac * 100)));
      $('#b-list', el).innerHTML = list;
      $('#b-pause', el).textContent = m.paused ? 'Resume' : 'Pause';
    } else {
      el.innerHTML = `
        <div class="card batch-run">
          <div class="b-head"><h2>Analysing ${jobs.length} games · ${esc(MODES[m.mode].label)}</h2>
            <div><button class="btn" id="b-pause">${m.paused ? 'Resume' : 'Pause'}</button> <button class="btn ghost" id="b-cancel">Cancel</button></div></div>
          <div class="b-bar" role="progressbar" aria-label="Batch progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(frac * 100)}"><i style="width:${Math.round(frac * 100)}%"></i></div>
          <p class="small" id="b-status" role="status" aria-live="polite">${esc(status)}</p>
          <details><summary class="small">Queue</summary><div id="b-list">${list}</div></details>
          <p class="muted small">You can keep using the app; if you close or refresh the page, the batch picks up where it stopped.</p>
        </div>`;
      $('#b-pause', el).onclick = () => (batch.meta?.paused ? batch.resume() : batch.pause());
      $('#b-cancel', el).onclick = () => batch.cancel();
    }
    el.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => (b.onclick = () => c.openGame(b.dataset.open!)));
  };

  const drawSummary = async () => {
    const m = batch.meta!;
    const jobs = batch.jobs;
    const ok = jobs.filter((j) => j.status === 'done');
    const lessons = ok.reduce((s, j) => s + (j.result?.moments ?? 0), 0);
    const ms = ok.reduce((s, j) => s + (j.result?.ms ?? 0), 0);
    const skipped = jobs.filter((j) => j.status === 'skipped' || j.status === 'failed');
    const ids = new Set(ok.map((j) => j.gameId));
    const reviews = (await store.byProfile<StoredReview>('reviews', c.pk)).filter((r) => ids.has(r.gameId));
    const top = recurringErrors(reviews)[0];
    const ev = top ? evidenceLevel(top.games, top.of) : null;
    el.innerHTML = `
      <div class="card batch-done">
        <h2>Batch finished</h2>
        <p>${ok.length} game${ok.length === 1 ? '' : 's'} analysed in ${mins(ms / 1000)} · ${lessons} new position${lessons === 1 ? '' : 's'} to train${skipped.length ? ` · ${skipped.length} skipped` : ''}.</p>
        ${top && ev ? `<p class="small"><b>${esc(EVIDENCE_LABEL[ev])}:</b> ${esc(top.phrase)} in ${top.games} of these ${top.of} games. <span class="src src-estimate">Estimate</span></p>` : ''}
        ${skipped.length ? `<p class="muted small">${skipped.map((j) => esc(`${j.myColor === 'w' ? j.game.black.username : j.game.white.username}: ${j.error ?? j.status}`)).join(' · ')}</p>` : ''}
        <div class="tr-after">${lessons ? '<button class="btn primary" id="b-train">Train these positions</button>' : ''}<button class="btn ghost" id="b-dismiss">Dismiss</button></div>
      </div>`;
    const t = el.querySelector<HTMLButtonElement>('#b-train'); if (t) t.onclick = c.train;
    $('#b-dismiss', el).onclick = () => { localStorage.setItem(`cr-batch-seen:${m.batchId}`, '1'); void draw(); };
  };

  let pending = 0;
  unsub = batch.on(() => { if (pending) return; pending = requestAnimationFrame(() => { pending = 0; void draw(); }); });
  await batch.load(c.pk);
  await draw();
}
