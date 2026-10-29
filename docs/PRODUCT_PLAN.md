# Chess Review: Product Plan

Goal: turn a game review into a learning loop. Analyze a game, pick up to three teachable moments, let the player retry them, explain the idea, save them as personal puzzles, and bring them back on a schedule.

Constraints: static site, free, local-first. No accounts, no backend, no LLM key. Stockfish runs in the visitor's browser.

## 1. Critique of the review-only product (before this release)
- It labelled every move, but did not say which 2-3 moments mattered. Players skimmed and forgot.
- "Best move" was shown immediately, so there was no active recall. Seeing the answer is not learning it.
- Explanations were per move and generic. They did not connect the error to a reusable idea ("you left the queen undefended").
- Nothing persisted except a cache. No history, no recurring patterns, no reason to come back.
- Chess.com only. Lichess players and PGN files were locked out.
- Colours alone carried meaning (red/green), which fails for colour-blind players.

## 2. Prioritized roadmap
| Priority | Item | Status |
|---|---|---|
| P0 | Post-game summary (story, turning point, strongest decision, main improvement, phases, time, one action) | Shipped |
| P0 | Up to 3 critical moments, level-aware | Shipped |
| P0 | Guided retry: hidden eval, 4 staged hints, tolerance, play-out | Shipped |
| P0 | Personal puzzles + "Mistakes to Master" with SM-2-lite queue | Shipped |
| P0 | Grounded rule-based explanations with source labels | Shipped |
| P1 | Lichess username import, PGN paste/upload | Shipped |
| P1 | History with recurring-error counts and small-sample note | Shipped |
| P1 | Export / import / delete-all of local data | Shipped |
| P1 | Accessibility: keyboard moves, Okabe-Ito colours + icons, reduced motion, aria labels | Shipped |
| P2 | Optional LLM phrasing behind `groundCheck` (bring-your-own key) | Designed, not built |
| P2 | Opening repertoire drills from repeated book deviations | Next |
| P2 | Endgame technique drills (convert a won position against the engine) | Next |
| P3 | Optional sync (user-owned file in Drive/Dropbox) | Later |

## 3. User flows
1. Review: open site → enter username (Chess.com or Lichess) or paste PGN → pick a finished game → engine analyses (about 40 s) → summary and critical moments appear above the move list.
2. Retry: click "Retry position" → board in a dialog, eval hidden → play a move (drag, click, or type SAN/UCI) → feedback → hints 1-4 if needed → solved or "Show answer" → explanation, best line, optional 3-move play-out vs engine → result saved.
3. Train: "Mistakes to Master" tab shows the due count → "Train N due" runs a session one position at a time → each result reschedules the puzzle.
4. Return visit: home shows due count, 1-2 due positions and one insight once 3+ games are reviewed.
5. Data: "Your data" tab: what leaves the device, export JSON, import JSON, delete everything, explanation level, motion setting.

## 4. Information architecture
- Top tabs: Games (home) · Mistakes to Master (due badge) · History · Import · Your data.
- Game page: header → Game summary card + Critical moments list → board, eval graph, move list (existing review).
- Retry is a modal dialog over the game page or inside a training session; it never navigates away.
- URLs: `?user=&site=chesscom|lichess&game=ID&ply=N`, `?view=puzzles|train|history|import|data`, `&tag=` filter, `&p=` single puzzle.

## 5. Wireframes
Desktop (≥ 980 px):
```
[Logo] Games | Mistakes to Master (3) | History | Import | Your data      [user · site · Change]
[‹ Games]  White (r) vs Black (r) · result · time control · date        [depth ▾] [source ↗]
┌ Game summary ──────────────── [level ▾] ┐ ┌ Critical moments ──────────────┐
│ Story (3-4 sentences)    [Explanation]  │ │ [mini] Move 10 · Blunder        │
│ Turning point · Strongest · Improvement │ │  Discovered attack  [Retry][Show]│
│ By phase [Estimate] · Time              │ │ [mini] Move 15 ...              │
│ ▶ Do this next: one action              │ │ [mini] Move 42 ...              │
└─────────────────────────────────────────┘ └─────────────────────────────────┘
[ board + eval bar ]                       [ move panel · graph · move list ]
```
Retry dialog: board left (typed-move box under it), prompt, status line, hint cards, [Hint n of 4] [Show answer] [Back].

Mobile (390 px): one column. Tabs scroll; summary, then moments, then board. Retry dialog is full screen: board on top at full width, typed-move box, prompt, hints, buttons wrap.

## 6. Data models (IndexedDB `chess-review` v1)
- `profiles {key: "platform:user", platform, username, createdAt}`
- `games {key: "profileKey|gameId", profileKey, game: GameSummary(pgn, players, result, timeControl, platform), myColor, savedAt}`
- `reviews {key, profileKey, gameId, platform, url, white, black, myColor, result, opening, endTime, accuracy, errorTags[], moments[{ply, tag, moveNumber}], story, reviewedAt}`
- `puzzles {id: "profileKey|gameId|ply", profileKey, gameId, gameUrl, phase, core: MomentCore(fenBefore, played, best, lines, reply, wp, tags), srs: SrsState, createdAt}`
- `SrsState {ease, interval(days), reps, lapses, due, retired, history[{t, solved, attempts, hints, revealed, close, quality, failure}]}`
- Engine evals stay in localStorage (existing cache). Export = one JSON file `{app: "chess-review", version, profiles, games, reviews, puzzles}`.

## 7. Grounded explanation architecture
Pipeline: Stockfish lines → fact extractor (`facts.ts`) → concept tags (`concepts.ts`) → level templates (`explain.ts`) → `groundCheck`.
- Facts are computed with chess.js on real positions: hanging pieces (attacked by lower value or undefended), forks, absolute and relative pins, skewers, discovered attacks, mate in one, back-rank mate, promotion threats, removed defenders, material along the line settled at a quiet point.
- Tags: each moment gets `missed:<motif>` (what the best move did) and `allowed:<motif>` (what the played move permitted), with a primary teaching tag.
- Templates: beginner, intermediate, advanced variants per tag. Every sentence is built from a fact; if no fact supports a claim, the text falls back to the concrete line ("after Ne5, dxe4 Nxc6 wins a piece").
- `groundCheck(text, allowedSquares)` rejects any text that names a square not present in the position or lines. Today it guards the templates; later an optional LLM could rephrase a template and its output would only be shown if it passes the same check, else the template is shown.
- UI labels: Engine (Stockfish), Classification (formula), Explanation (generated from rules), Estimate.

## 8. Algorithms
Critical moments (`moments.ts`, `coach.ts`):
- Candidates: the player's own non-best moves with win% loss ≥ 6, not book/forced.
- Skip: loss below level minimum (10/8/6), already decided (best ≥ 97 and played ≥ 80, or best ≤ 5), beginner positional nitpicks under 15.
- Score = min(loss, 60) × motif weight(level) × clarity(gap to 2nd-best, 0.6-1.0) × short-tactic bonus 1.15 (positional 0.75) × miss bonus 1.1.
- Take the top 3, never within 2 plies of each other, shown in game order.
Recurring errors (`insights.ts`):
- Over the last 20 reviewed games, count each error tag once per game (loss ≥ 10, position not decided, excluding vague positional/defence tags).
- Insight shown only with ≥ 3 games and a tag in ≥ 2 of them. Confidence: < 5 games low, < 15 medium, else high, always shown with the sample size.
SRS (`srs.ts`): quality 0-5 from attempts and hints; failure returns in 10 minutes, a second failure within a day returns tomorrow; successes 1-2 days, then 3-6, then interval × ease; retired after 4 clean solves at ≥ 21 days; a new failure with the same tag reactivates retired puzzles.
Retry acceptance (`retry.ts`): a move is correct if within tolerance of the best win% (30% of the best-vs-played gap, clamped 3-8), or keeps a forced mate; "close" if it recovers half the gap; the game move is never accepted.

## 9. Milestones
- M1 (done): learning slice: summary, moments, retry, puzzles, SRS, local store, Lichess/PGN, accessibility, tests.
- M2: insights depth: per-tag trend chart, phase accuracy over time, "calculation vs concept" failure split shown on History.
- M3: drills from patterns: opening deviation drills, endgame conversion drills.
- M4: optional LLM phrasing behind `groundCheck`, bring-your-own key, off by default.

## 10. Acceptance criteria
- Summary appears above the review for every finished game with story, turning point, strongest decision, main improvement, phases, time notes, one action.
- At most 3 moments; none in decided positions; none on consecutive moves.
- Retry hides the eval, accepts drag, click and typed moves, rejects the game move, offers 4 hints, records attempts and hints.
- Every moment becomes a puzzle due immediately; results move its due date per the SRS rules.
- Home shows due count and up to 2 due positions; an insight only with ≥ 3 games.
- All data can be exported, re-imported and deleted; nothing is sent anywhere except requests to Chess.com/Lichess public APIs.
- Works at 390 px with no horizontal scroll; usable by keyboard only; meaning never by colour alone.

## 11. Testing strategy
- Unit (Vitest, 48 tests): fact extractor on known FENs (hanging, fork, pin, skewer, discovered, mate, back rank), retry tolerance and judging, SRS quality and schedule, moment scoring and selection, groundCheck, recurring errors, PGN/Lichess import, typed moves, IndexedDB store (fake-indexeddb), coach output on two real games with cached evals.
- E2E (Playwright, `test/e2e-learn.mjs`, 26 checks): summary on 186131916376, three moments on 186092857180, retry with hints and solve, puzzle saved, due queue and session, home panel, Lichess EricRosen import and review, mobile layout, no console errors. Runs against local preview or the live URL (`BASE=`).
- Existing `test/e2e.mjs` regression for the review page.

## 12. Sustainability
- Cost: zero servers. Vercel static hosting free tier; engine runs on the visitor's device; public APIs need no key.
- Privacy: no accounts, no tracking; data in IndexedDB; export and delete on one page.
- Maintenance: pure TypeScript modules with unit tests; deterministic explanations (no model drift, no API bill).
- Risks: Chess.com/Lichess API changes (isolated in `api.ts`, `sources.ts`); browser storage can be cleared (export reminder); WASM engine is slower on old phones (depth selector).
