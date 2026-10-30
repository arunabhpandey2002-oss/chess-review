# rook-i.e. mistakes

(Display name: "rook-i.e. mistakes". The Vercel project and URL stay `rook-ie-mistakes`, because dots are not allowed there.)

A static web app that reviews your chess games in the browser and turns your mistakes into training.
Enter a username or paste a PGN, pick a finished game, and the in-browser engine reviews every move.

## Learning loop
- Game summary at the top: story, turning point, strongest decision, main improvement, phase performance, time notes and one recommended action.
- Up to 3 critical moments, chosen for your level (beginner under 1000, intermediate 1000-1800, advanced over 1800; switchable).
- Retry each moment with the eval hidden: drag, click or type a move, 4 staged hints, then the explanation.
- Why-you-erred coach: before the answer, tap what you were thinking (missed their threat, thought it was safe, attacking something else, missed a better move, short on time). The app checks that against the board facts and the engine line and says whether it matches, in 1-3 sourced sentences. Answers are saved, and the home panel shows your top causes.
- Play it out: from any moment (list or lesson), play the rest of the game against the engine set near your rating (UCI_Elo from 1320; below that skill 0 with a shallow search). Take back, restart, resign or stop. You get the result plus up to two engine-checked takeaways: whether you kept the advantage and your biggest slip with the better move.
- Why is this best? From any move card, Explore shows the best move and the game move side by side: what each one changes on the board (attacks, defences, threats stopped or left), the opponent's best reply, and an honest size of the gap. Step through both engine lines with arrows, tap questions (the threat, why not my move, their reply, other moves), or try any move and get the engine's eval and reply. Engine and board facts only; no AI text.
- Decided positions: when the mover was already under 10% or over 90% win chance before and after, the card says "... in a lost/won position" and explains that grades compare with the best move, not who is winning.
- Analyse my recent games: queue the last 5, 10 or 25 games, games since the last batch, or picked games. Light, Standard or Deep. It shows an estimate first, runs in the background with pause, resume and cancel, survives a refresh, skips duplicates and unfinished games, and caches positions by engine version and settings. Pass 1 screens every position; pass 2 re-checks the critical ones deeper, and only verified positions become lessons and puzzles. It waits while a full review or the analysis board needs the engine.
- Analysis board: open any lesson (or paste a PGN/FEN on Import) with the exact position. Variation tree (game line, engine lines, your moves, take-backs), undo/redo, make main line, delete, 1-5 engine lines at depth 12/16/20, Ask about a move, Compare with main line, Save as puzzle, copy/load FEN and PGN, keyboard arrows. Saved locally.
- After Play it out: Review this game (same pipeline, saved and linked to the source moment) and Compare with original: both win% curves on one graph, mistakes aligned by move, a synced step-through, and each divergence explained with win% before and after, the board and material facts, and whether the same error came back. Take-backs are kept as variations.
- Every explanation is built from a checked evidence record (engine facts, material ledger, board facts) and passes invariant checks before it shows; low-confidence positions fall back to the line itself. "Something wrong with this explanation?" saves a local report (incorrect, unclear, too advanced).
- Every moment is saved as a personal puzzle in "Mistakes to Master" and scheduled with spaced repetition (SM-2 style).
- History shows recurring error types once you have reviewed a few games, with the sample size.
- Explanations are generated from rules on verified engine facts, not by an AI model. Labels show the source: Engine, Classification (formula), Explanation (generated from rules), Estimate.
- All your data stays in this browser (IndexedDB). "Your data" lets you export, import or delete it.

Design and roadmap: docs/PRODUCT_PLAN.md.

## Tests
    npm test                      # Vitest unit tests (test/unit)
    node test/e2e-learn.mjs       # Playwright E2E of the learning loop; BASE=https://... to run against a deployment
    node test/e2e-explore.mjs     # Playwright E2E of Explore and decided-position wording (desktop + phone)
    node test/e2e-coach.mjs       # Playwright E2E of the why-you-erred coach and Play it out (desktop + phone)
    npm run test:layout           # Playwright layout check: overflow, clipped text, tiny text on 5 screen sizes
    node test/e2e-xss.mjs         # Security check: script injection via URL, PGN and backup files
    node test/e2e-batch.mjs       # Batch queue: estimate, run, refresh mid-batch and resume, cancel, summary, responsiveness
    node test/e2e-workspace.mjs   # Analysis board: lesson to board, tree, engine lines, Ask, compare, save as puzzle, refresh
    node test/e2e-replay.mjs      # Play it out, take-backs, Review this game, Compare with original
    npx tsx test/build-corpus.ts  # Rebuild the explanation regression corpus (test/corpus/lessons.json)
    npx tsx test/verify-corpus.ts # Re-check the corpus with native Stockfish (writes docs/CORPUS_NATIVE.md)
    npx tsx test/stability.ts     # Standard vs Deep stability (writes docs/STABILITY.md)
    node test/e2e-csp.mjs         # Runs the app under the production security headers (CSP) locally

Live: https://rook-ie-mistakes.vercel.app/ (the old https://chess-review-ashen.vercel.app/ still works)

## Anyone can use it
- Open the site and type a username with the "Change" link, or share a link like `https://rook-ie-mistakes.vercel.app/?user=hikaru`.
- With no `?user=`, it opens on Arunabh-pandey. Add `&site=lichess` to load games from the second supported source.
- Games come straight from public game archives, called from the visitor's own browser. No login, key or server is needed, and only public games are shown.
- The engine runs on the visitor's own device. Nothing is uploaded anywhere. Results are cached in the browser's localStorage.

## Run locally
    npm install
    npm run build      # outputs dist/
    npx vite preview   # http://localhost:4173

`dist/` must be served over http(s); opening index.html from disk will not load the engine.

## Classification (win% model)
win% = 50 + 50*(2/(1+exp(-0.00368208*cp)) - 1), cp clamped to ±1000, mate = 100/0.
Loss = win% before (best move) minus win% after the played move, from the mover's side.
- Best: engine top move (or same eval). Excellent: loss < 2. Good: < 5. Inaccuracy: < 10. Mistake: < 20. Blunder: >= 20.
- Book: position is in the bundled openings set.
- Great: best move, and the 2nd-best move is >= 15 win% worse (not in check, not a recapture/obvious capture, 2nd-best win% <= 80).
- Brilliant: loss <= 2, a real material sacrifice (net >= 2 along the PV), still >= 50% after, and the position was not already completely won.
- Miss: opponent just erred (>= 10%), and this move fails to punish it (loss >= 10).
- Decided positions (<= 3% or >= 97%): a move that newly hangs a piece of >= 3 points that the engine takes is a Blunder.
Accuracy uses the per-move formula 103.1668*exp(-0.04354*loss) - 3.1669 and its volatility-weighted/harmonic game mean.

## Deploy updates (Vercel)
Hosted on Vercel as the project `rook-ie-mistakes` (renamed from `chess-review`; the GitHub repo is still `chess-review`). `vercel.json` sets the build: `npm ci`, `npm run build`, output `dist`.

- **Automatic (once Git is connected):** push to `main` and Vercel builds and deploys production. Pushes to other branches get preview URLs.
    git add -A && git commit -m "your change" && git push
- **Manual:** `npm run deploy` runs `vercel --prod`. It needs the Vercel CLI (`npm i -g vercel`) and a one-time `vercel login` and `vercel link --project rook-ie-mistakes`.

To turn on automatic deploys: on GitHub, open Settings, Applications, Vercel, Configure, and add `chess-review` to the repositories Vercel can access. Then in Vercel open the project, Settings, Git, and connect `arunabhpandey2002-oss/chess-review` to the `rook-ie-mistakes` project.

Legacy: the site used to be on GitHub Pages (`npm run deploy:gh-pages-legacy`, `gh-pages` branch). Pages is off now that the repo is private.

`base: './'` in vite.config.ts means the build also works on any other static host.

## Security
- Everything outside the app (usernames, PGN headers, backups, URL params) is escaped before it reaches the page; links from outside data must be plain http(s).
- Backup files are parsed with a checker: unknown or dangerous keys (`__proto__`, `constructor`) are dropped, fields are type-checked, HTML brackets are stripped, files over 50 MB are refused.
- `vercel.json` sends a strict Content-Security-Policy (scripts only from this site plus `wasm-unsafe-eval` for the engine; network only to the two public game APIs), `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, a referrer policy and a Permissions-Policy.
- No third-party scripts, fonts or CDNs; the engine (JS + WASM) is self-hosted. No secrets are needed or stored.

## Licences
Stockfish (GPLv3) and chessground (GPLv3) are bundled, so the distributed site is GPLv3; publish this source alongside it.
