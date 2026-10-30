# Plan v3: trustworthy explanations, batch analysis, analysis workspace

Written 30 Oct 2026 before coding. Brief: `docs/BRIEF_v3_explanations_batch_workspace.md`.

## 1. Audit of the current implementation
| Area | Today | Gap against the brief |
|---|---|---|
| Engine | `engine.ts`: pool of Stockfish 19 lite WASM workers (single-threaded each), MultiPV, depth + movetime. | No cache key with engine/net/config; no pause/stop of a running search; one pool per screen. |
| Per-game review | `main.ts ReviewView`: every position at depth 14/18/22, MultiPV 3; evals cached in localStorage per game+depth. | One game at a time; must stay on the page; no verification pass; cache is per game, not per position. |
| Classification | `classify.ts` win% model, `review.ts` per move with material-along-PV, sacrifice and fork checks. | Fine; reused. |
| Facts | `facts.ts`, `tactics.ts`, `explore.ts`: hanging pieces, threats, forks, pins, skewers, discovered attacks, mates, promotion, removing the defender, settled material. | No ledger that labels each capture as exchange / recapture / sacrifice; claims not checked against the final position. |
| Concepts | `concepts.ts tagMove`: one primary + secondary motif and a skill. | No confidence per motif. |
| Explanations | `explain.ts explainMoment`: sections What happened / Why X works / Why it was tempting / Notice / Pattern; square ground-check. | Not built from a record; contains banned phrases ("no single tactic to name, follow the line", "better because"); levels mostly change numbers; only squares are checked. |
| Retry | `retry.ts judge`: correct / close / wrong / played with a win% tolerance. | No Best / Acceptable / Playable bands, no only-move or material rules. |
| Thinking question | `diagnose.ts`: 5 choices, verdict matches / partly / differs. | Needs 11 choices with learning categories, and "partly" must say which part. |
| Storage | IndexedDB v1: profiles, games, reviews, puzzles. Export/import (validated). | No jobs, eval cache, replays, workspace, reports. |
| Insights | `insights.ts`: recurring tags with 3-game minimum. | Needs anecdote / possible / emerging / stronger levels, opportunity normalisation, supporting games, trend. |
| Explore | `explorer.ts`: "Why is X best?" dialog (two lines, ask chips, try a move). | No tree, no engine controls, can't save a branch. |
| Play it out | `sparring.ts`: plays vs a limited engine, take back, restart, summary. | Take-backs are thrown away; no review or comparison with the original. |

## 2. Reusable components
`EnginePool`, `winPct`/classification, `reviewGame` and `summarize`, `buildMoments`/`selectMoments`, all of `facts.ts`/`tactics.ts`, `tagMove`, `buildHints`, `words.ts` move wording, chessground setup and `legalDests`/`parseTyped` from `ui.ts`, `Trainer` (retry dialog), `Sparring`, `store.ts` helpers, SRS, the validated backup parser, the e2e harnesses.

## 3. Data-model changes and migration
IndexedDB `chess-review` goes from v1 to v2 (additive, no data rewritten):
- `evalcache` {key, fen, ev, at}: key = `fen | engine | net | cfg | d<depth> | mpv<n>`.
- `jobs` {id, batchId, profileKey, gameId, game, myColor, priority, status, stage, posDone, posTotal, error?, result?, createdAt, updatedAt}, index `batchId`.
- `meta` {key, …}: current batch (mode, options, paused, createdAt, finishedAt, summary).
- `replays` {id, profileKey, sourceGameId, sourcePly, startFen, me, tree, outcome, createdAt}: Play it out games, including take-back branches.
- `workspace` {id, tree, orientation, source, updatedAt}: saved analysis boards.
- `reports` {id, puzzleId?, where, kind, note?, record, createdAt}: "Report explanation".
- `Puzzle` gains optional `record` (explanation record), `verify` {depth, screenDepth, stable, engine, net}, `source` ('game' | 'workspace' | 'replay').
Backups become version 2 (adds reports, replays, workspace); version-1 files still import. The old localStorage eval cache stays for the per-game view.

## 4. Explanation-evidence schema (`src/evidence.ts`)
```ts
interface ExplanationRecord {
  v: 1;
  position: { fen; sideToMove: 'white'|'black'; phase; legalMoves: number };
  playedMove: { san; uci; legal: boolean };
  bestMoves: { san; uci; evalPawns; mate: number|null; wp; pv: string[] /*SAN*/ }[];
  acceptable: { san; uci; band: 'best'|'acceptable'|'playable' }[];
  evaluation: { before; after; wpBefore; wpAfter; winningChanceLoss };   // engine layer
  materialOutcome: { netChange; lost: string[]; exchanged: string[]; won: string[]; finalCheck: boolean; line: 'reply'|'best' }; // board layer (ledger)
  bestOutcome: { netChange; won: string[]; lost: string[] };
  verifiedEvents: { text; src: 'engine'|'rules'; plies: number }[];
  motifs: { name; id; confidence: number }[];                           // rules layer
  mechanism: { id; text };                                              // why it failed
  solution: { id; text };                                               // what the best move solves
  tempting: { text; basis: 'board'|'answer' } | null;                   // interpretation layer
  playerResponse: Choice | null;
  recommendedLesson: string; primaryConcept: string; secondaryConcept?: string;
  confidence: number; confidenceParts: { stability; pvAgreement; material; motif; lineLength; nearEqual };
  verify?: { screenDepth; depth; sameBest: boolean };
  engine: { name; net; depth };
}
```
Prose is rendered only from this record (`lesson.ts`). `invariants.ts` re-checks the prose against the record and the board; any failure swaps that section for the concrete-line fallback and is counted in tests.

## 5. Worker and queue architecture
- **Engine:** Stockfish runs in its own Web Workers (WASM). Batch uses its own pool: Light 1 worker, Standard min(2, cores−1), Deep min(3, cores−1); phones (coarse pointer or ≤4 cores) cap at 1 and default to Light.
- **Runner (`batch.ts`):** a main-thread singleton that survives in-app navigation. Per job: Fetching (stored PGN) → Validating (parse, completed-game check, duplicate check) → Analysing pass 1 (screen every position: Light d10 / Standard d12 / Deep d14, MultiPV 2) → pass 2 (critical positions and their after-positions at d16 / d18 / d22, MultiPV 3) → Generating lessons (moments only from verified positions, record + invariants) → Saving (review + puzzles) → Complete. Each position result is written to `evalcache` as soon as it arrives; the job row is updated every few positions.
- **Resume:** on load, jobs left in an active stage go back to Waiting and the runner resumes unless the batch was paused. Cached positions are skipped, so completed work is never repeated.
- **Pause / cancel:** pause stops new work and terminates the pool (frees memory); cancel marks remaining jobs Cancelled. Optional: pause while the tab is hidden; pause on battery (where the Battery API exists).
- **Responsiveness:** the main thread only parses results; it yields between positions; the review UI is not blocked. Measured with a long-task observer in e2e.
- **Priority:** losses 400, draws from a winning position 300, wins with a blunder 200, then length; under 10 moves or aborted last; duplicates (same game id or same move list) skipped. The user can reorder ("Analyse first").

## 6. Workspace information architecture (`?ws=<id>`)
- **Board column:** eval bar, board (legal moves, drag/click, right-click arrows), nav (start, back, forward, end, flip), type-a-move.
- **Side column (one primary action, "Save as puzzle"):**
  1. Engine line: on/off, lines 1–5 (default by level), depth; best lines as clickable moves; threat line (null-move); version label.
  2. Moves: variation tree with kinds game / engine / mine / replay / tried-and-taken-back / imported; promote, delete, undo, redo; comment on the current move.
  3. Ask (behind a disclosure): threat, attacked, undefended, checks/captures, why the engine prefers its move, why my move fails, candidates.
  4. Compare (disclosure): played vs engine best vs current move: eval, win%, material outcome, forcing reply, threats created, risk, main concept.
  5. Copy FEN, copy PGN, load FEN/PGN (disclosure).
- Entry points: review move card ("Analyse"), retry lesson ("Open in analysis"), puzzle list, Play it out end screen, Import page (paste FEN/PGN), and the Analysis tab.

## 7. Risks and migration concerns
- WASM engine is slower than native: batch must default to Light on phones; Deep only for chosen games.
- IndexedDB quota: the eval cache is trimmed (oldest first) past 20 000 positions.
- Explanations get shorter where confidence is low; that is intended but changes copy users have seen.
- Changing `Choice` ids: old saved diagnoses keep their ids (mapped to new categories).
- Two tabs running batches at once: guarded with a lock in `meta` (heartbeat); the second tab shows the queue read-only.
- Play it out evals (depth 12) are weaker than the review's; comparisons re-evaluate both lines at one budget.

## 8. Milestones (small, testable)
Each milestone lists acceptance · chess-correctness tests · performance · accessibility · failure/recovery · privacy · screens.

**M1 Evidence foundation (slice).** Ledger, record, invariants, regression corpus.
Acceptance: record built for every moment; ledger distinguishes exchange / recapture / sacrifice / net gain; prose that fails an invariant never shows. Chess tests: corpus (≥30 cases, all listed motifs), invariants on all test games × 3 levels, native-Stockfish check script. Perf: record build < 5 ms per moment. A11y: n/a. Failure: invariant failure → fallback text. Privacy: none. Screens: retry lesson.

**M2 Lessons v2 (slice).** New sections, level depth, confidence fallback, retry bands, 11-answer questionnaire, Report explanation.
Acceptance: no banned phrases; ≥3 alternatives recognised when they exist; "partly" replaced with "matches part: X, but also Y"; Standard vs Deep same primary concept and best move on test games. Chess tests: bands unit tests (only-move, mate, material), diagnosis-contradiction invariant. Perf: none. A11y: answer chips are buttons in a group with a heading; report is a native select. Failure: missing engine data → fallback. Privacy: reports stay local, exported in backup. Screens: retry dialog, puzzles.

**M3 Queue, cache, two-pass (slice).** Acceptance: survives refresh mid-batch and resumes without repeating cached positions; duplicates skipped; failures don't stop the queue; cancel is clean; versions saved with results. Chess tests: only verified positions create puzzles; completed-game check. Perf: time per game per mode; UI long tasks < 200 ms during a batch. A11y: status in an aria-live region. Failure: worker crash → job retried once, then Failed with a reason. Privacy: no network beyond the game archives. Screens: Games page.

**M4 Batch UI and insights (slice).** "Analyse recent games" panel (5/10/25, since last, pick games), estimate, queue with pause/resume/cancel, batch summary; insights with evidence levels, supporting games and trend. Perf: list renders without jank. A11y: radio group, buttons, progress bar with text. Failure: per-job reasons. Privacy note shown. Screens: Games, History.

**M5 Workspace core (slice).** Tree, engine controls, Ask, Compare, Save as puzzle, copy/load FEN/PGN, keyboard. Acceptance: any FEN/PGN loads; branches never overwritten by engine lines; state survives refresh; puzzle saved from a branch appears in Mistakes to Master. Chess tests: tree unit tests (branch, promote, delete, undo/redo, PGN round-trip). Perf: engine search never blocks the board. A11y: board description, tree is a list of buttons, focus moves sensibly. Failure: bad FEN/PGN → message. Privacy: local only. Screens: new Analysis page, entry buttons.

**M6 Play it out → review and compare (slice).** Take-backs kept as tree branches; Review this game (same pipeline, saved and linked); Compare with original (aligned list, both win% curves, divergences explained with ledger facts and concept repeat/fix). Chess tests: alignment, divergence detection, take-back capture, comparison-fact invariants. Perf: comparison analysis ≤ 1 s per position at the compare budget. A11y: synced stepper with keyboard, curves distinguished by line style as well as colour. Screens: Play it out, review, compare dialog.

**M7 Workspace depth (next).** Multi-game PGN chapters, named positions, play from position as either colour with hints, comments shown back in the review, return to next critical moment.

**M8 Study ecosystem (later).** Opening explorer with sourced stats, repertoire and flashcards, 7-piece tablebase, diagnostic overlays, local studies, read-only sharing that excludes private data by default, optional encrypted sync.

The vertical slice shipped now is M1–M6 plus the parts of M7 that the slice needs.

## 9. Status (30 Oct 2026)
Shipped: M1-M6. Results:
- Regression corpus: 47 distinct lesson positions from 9 test games, both sides. Every case at all 3 levels and all 11 answers passes the invariants (0 violations); mechanism, solution and concept are pinned.
- Native Stockfish depth 22 on the corpus: same best move 39/47; lesson's move within 3% of the best 47/47; played move still an error 47/47 (docs/CORPUS_NATIVE.md).
- Standard vs Deep: docs/STABILITY.md (93% of full-depth lessons found by the two-pass batch, 100% same mechanism).
- Unit tests 176/176; all E2E suites green.

Deferred: synthetic corpus cases for motifs the test games do not contain (skewer, zwischenzug, en passant, promotion, stalemate, repetition, tablebase); opening a batch-analysed game in the full review re-analyses it (no evalcache reuse yet); no multi-tab lock for the batch; backup import drops cached analysis; workspace engine is fixed-depth (no infinite search); no Puzzles-page entry to the board; M7 and M8.
