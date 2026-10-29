# Chess Review

A static web app that does a Chess.com-style game review in the browser.
Enter a Chess.com username (or use `?user=NAME`), pick a game, and Stockfish 19 (WASM lite, single-threaded) reviews every move.

Live: https://arunabhpandey2002-oss.github.io/chess-review/

## Any Chess.com player can use it
- Open the site and type a username with the "Change" link, or share a link like `https://arunabhpandey2002-oss.github.io/chess-review/?user=hikaru`.
- With no `?user=`, it opens on Arunabh-pandey.
- Games come straight from Chess.com's free public API (`api.chess.com/pub/player/NAME/games/...`), called from the visitor's own browser. No login, key or server is needed, and only public games are shown.
- The engine runs on the visitor's own device. Nothing is uploaded anywhere. Results are cached in the browser's localStorage.

## Run locally
    npm install
    npm run build      # outputs dist/
    npx vite preview   # http://localhost:4173

`dist/` must be served over http(s); opening index.html from disk will not load the engine.

## Classification (Lichess win% model)
win% = 50 + 50*(2/(1+exp(-0.00368208*cp)) - 1), cp clamped to ±1000, mate = 100/0.
Loss = win% before (best move) minus win% after the played move, from the mover's side.
- Best: engine top move (or same eval). Excellent: loss < 2. Good: < 5. Inaccuracy: < 10. Mistake: < 20. Blunder: >= 20.
- Book: position is in the lichess chess-openings set.
- Great: best move, and the 2nd-best move is >= 15 win% worse (not in check, not a recapture/obvious capture, 2nd-best win% <= 80).
- Brilliant: loss <= 2, a real material sacrifice (net >= 2 along the PV), still >= 50% after, and the position was not already completely won.
- Miss: opponent just erred (>= 10%), and this move fails to punish it (loss >= 10).
- Decided positions (<= 3% or >= 97%): a move that newly hangs a piece of >= 3 points that the engine takes is a Blunder.
Accuracy uses the Lichess per-move formula 103.1668*exp(-0.04354*loss) - 3.1669 and its volatility-weighted/harmonic game mean.

## Deploy updates (GitHub Pages)
    git add -A && git commit -m "your change" && git push
    npm run deploy

`npm run deploy` builds the site and pushes `dist/` to the `gh-pages` branch, which GitHub Pages serves. The site updates within a minute or two.
`base: './'` in vite.config.ts means the build also works on any other static host (Netlify, Vercel) without changes.

## Licences
Stockfish (GPLv3) and chessground (GPLv3) are bundled, so the distributed site is GPLv3; publish this source alongside it.
Not affiliated with Chess.com.
