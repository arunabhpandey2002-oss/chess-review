# Stability (native Stockfish, 2026-10-30)

Games: 9, both sides. Screen depth 12 (MultiPV 2) vs check depth 18 (MultiPV 3); game.pgn uses depth 20.

| Check | Result |
|---|---|
| Critical moves (≥8% loss at depth 18) also flagged at depth 12 | 66/74 (89%) |
| Flagged positions where the best move is the same at both depths | 57/75 (76%) |
| Full-depth lessons that the two-pass batch also picks | 40/43 (93%) |
| … of those, same error mechanism in the lesson | 40/40 (100%) |
| Depth 20 vs 22 (game.pgn): same lesson positions | 5/5 (100%) |
| Depth 20 vs 22: same best move / same mechanism | 4/5, 5/5 |
