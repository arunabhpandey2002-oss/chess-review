// Small shared UI helpers.
import { Chess } from 'chess.js';
import type { Source } from './explain';

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const SRC_LABEL: Record<Source, string> = {
  engine: 'Engine',
  formula: 'Classification (formula)',
  rules: 'Explanation (generated from rules)',
  estimate: 'Estimate',
};
const SRC_TIP: Record<Source, string> = {
  engine: 'Comes straight from the chess engine running in your browser.',
  formula: 'Computed from the engine evaluation with a fixed formula (win chance and move labels).',
  rules: 'Written by rules from facts checked on the board and in the engine line. No AI text generator is used.',
  estimate: 'A rough estimate; treat it as a guide, not a measurement.',
};
const SRC_SHORT: Record<Source, string> = { engine: 'Engine', formula: 'Formula', rules: 'Rule-based', estimate: 'Estimate' };
/** A small, quiet source tag; the full wording is in the tooltip and for screen readers. */
export const srcChip = (s: Source) => `<span class="src src-q src-${s}" title="${esc(SRC_LABEL[s])}: ${esc(SRC_TIP[s])}" aria-label="Source: ${esc(SRC_LABEL[s])}" tabindex="0">${esc(SRC_SHORT[s])}</span>`;
/** One quiet line of sources for a whole card (each source once; full wording in the tooltip). */
export const srcTags = (srcs: Source[]) => {
  const u = [...new Set(srcs)];
  return u.length ? `<span class="src-line">${u.map(srcChip).join('')}</span>` : '';
};
/** Header bar for a dialog: title, optional subtitle, and the close button at the top right (sticky in overlays). */
export const dlgHead = (title: string, sub: string, closeId: string, closeLabel = 'Close') =>
  `<div class="dlg-head"><div class="dlg-title"><h2>${esc(title)}</h2>${sub ? `<p class="muted">${sub}</p>` : ''}</div>` +
  `<button class="btn ghost dlg-close" id="${closeId}" aria-label="${esc(closeLabel)}"><span aria-hidden="true">✕</span><span class="lbl">${esc(closeLabel)}</span></button></div>`;

export function reducedMotion(): boolean {
  const pref = localStorage.getItem('cr-motion');
  if (pref === 'reduce') return true;
  if (pref === 'full') return false;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
export function applyMotionClass() { document.documentElement.classList.toggle('reduce-motion', reducedMotion()); }

const NAMES: Record<string, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
/** Screen-reader description of a position. */
export function boardDescription(fen: string): string {
  const c = new Chess(fen);
  const side = (col: 'w' | 'b') => {
    const items: string[] = [];
    for (const t of ['k', 'q', 'r', 'b', 'n', 'p']) {
      const sqs: string[] = [];
      for (const row of c.board()) for (const p of row) if (p && p.color === col && p.type === t) sqs.push(p.square);
      if (sqs.length) items.push(`${NAMES[t]}${sqs.length > 1 ? 's' : ''} ${sqs.join(', ')}`);
    }
    return items.join('; ');
  };
  return `Chess board. ${c.turn() === 'w' ? 'White' : 'Black'} to move${c.inCheck() ? ', in check' : ''}. White: ${side('w')}. Black: ${side('b')}.`;
}

export function legalDests(fen: string): Map<string, string[]> {
  const c = new Chess(fen);
  const m = new Map<string, string[]>();
  for (const mv of c.moves({ verbose: true })) {
    const a = m.get(mv.from) ?? [];
    if (!a.includes(mv.to)) a.push(mv.to);
    m.set(mv.from, a);
  }
  return m;
}

/** Parse typed SAN ("Nf3", "nf3", "exd5") or UCI ("g1f3", "e7e8q") into a UCI string, or null. */
export function parseTyped(fen: string, text: string): string | null {
  const t = text.trim().replace(/[!?]+$/, '').replace(/0/g, 'O');
  if (!t) return null;
  const c = new Chess(fen);
  const legal = c.moves({ verbose: true });
  const u = t.toLowerCase().replace(/[-x\s]/g, '');
  const byUci = legal.find((m) => m.from + m.to + (m.promotion ?? '') === u || (m.from + m.to === u && (!m.promotion || m.promotion === 'q')));
  if (byUci) return byUci.from + byUci.to + (byUci.promotion ?? '');
  const norm = (s: string) => s.replace(/[+#]/g, '');
  let m = legal.find((x) => norm(x.san) === norm(t));
  if (!m && /^[kqrbn]/.test(t) && !/^b[a-h]?x?[a-h][1-8]/.test(t)) {
    const up = t.charAt(0).toUpperCase() + t.slice(1);
    m = legal.find((x) => norm(x.san) === norm(up));
  }
  if (!m && /^b/.test(t)) m = legal.find((x) => norm(x.san) === norm('B' + t.slice(1))) ?? legal.find((x) => norm(x.san) === norm(t));
  return m ? m.from + m.to + (m.promotion ?? '') : null;
}

export function fmtDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
export function fmtWhen(ms: number, now = Date.now()): string {
  const d = ms - now;
  if (d <= 0) return 'now';
  const m = Math.round(d / 60000);
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h} h`;
  const days = Math.round(h / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}
