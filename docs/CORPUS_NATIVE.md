# Corpus check against native Stockfish (depth 22)

Each lesson in `test/corpus/lessons.json` was re-analysed with native Stockfish at depth 22, MultiPV 3.

- Same best move: **39/47**
- Lesson's best move is the engine's best or within 3% win chance of it: **47/47**
- The played move is still an error (loses ≥ 5% win chance): **47/47**

| Case | Lesson's best | Depth 22 | Loss (corpus → depth 22) | Still an error |
|---|---|---|---|---|
| g_186091686462:6.Bf4 | exd5 | same | 31 → 31 | yes |
| g_186091686462:8.O-O | Qh5+ | same | 15 → 19 | yes |
| g_186091686462:4...e6 | dxe4 | same | 26 → 25 | yes |
| g_186091686462:7...Qf6 | Nf6 | same | 18 → 23 | yes |
| g_186091686462:9...Qxf4 | Bd6 | equal (≤3%) | 34 → 32 | yes |
| g_186091686462:5...bxa6 | dxe4 | same | 10 → 8 | yes |
| g_186091999252:4.dxc5 | d5 | equal (≤3%) | 10 → 10 | yes |
| g_186091999252:7.O-O | Qd5 | same | 9 → 8 | yes |
| g_186091999252:7...Rb8 | e6 | same | 17 → 14 | yes |
| g_186091999252:3...c5 | e6 | equal (≤3%) | 13 → 14 | yes |
| g_186091999252:1...a5 | Nf6 | equal (≤3%) | 7 → 6 | yes |
| g_186092195766:4...Bd6 | d5 | same | 39 → 41 | yes |
| g_186092278740:11.Qxc3 | bxc3 | same | 44 → 43 | yes |
| g_186092278740:16.Qxb7 | Bg5 | same | 33 → 33 | yes |
| g_186092278740:19.Be2 | Rxe7 | same | 95 → 95 | yes |
| g_186092278740:7...d5 | Nxd4 | same | 20 → 22 | yes |
| g_186092278740:10...Bxc3+ | Ba5 | same | 29 → 29 | yes |
| g_186092278740:18...Rfe8 | Qxe1+ | same | 94 → 96 | yes |
| g_186092857180:10.Rg1 | Ne5 | same | 36 → 37 | yes |
| g_186092857180:15.exd5 | Qe3 | same | 79 → 79 | yes |
| g_186092857180:42.Rb1 | Rxg4 | same | 86 → 90 | yes |
| g_186092857180:8...Nh5 | dxe4 | same | 41 → 40 | yes |
| g_186092857180:25...Rxf2 | Qb7 | same | 59 → 64 | yes |
| g_186092857180:41...g4 | h2 | same | 85 → 92 | yes |
| g_186129697074:7.Ng5 | Bxc6 | same | 36 → 44 | yes |
| g_186129697074:13.Qd1 | Qd3 | same | 38 → 45 | yes |
| g_186129697074:21.Qxd6 | Qg4+ | same | 24 → 25 | yes |
| g_186129697074:6...Bd6 | e4 | same | 18 → 23 | yes |
| g_186129697074:9...Nxd4 | h6 | same | 36 → 42 | yes |
| g_186129697074:21...Rad8 | Rae8 | same | 28 → 26 | yes |
| g_186129697074:20...Qb5 | Rae8 | equal (≤3%) | 82 → 89 | yes |
| g_186131483068:5.d3 | d4 | same | 11 → 11 | yes |
| g_186131483068:10.Bg5 | Be3 | equal (≤3%) | 10 → 14 | yes |
| g_186131483068:12.Nd5 | Be3 | equal (≤3%) | 14 → 15 | yes |
| g_186131483068:17.Qd2 | Qe2 | same | 7 → 8 | yes |
| g_186131483068:4...f5 | c5 | same | 15 → 17 | yes |
| g_186132691608:6.Qd3 | Bd3 | same | 68 → 71 | yes |
| g_186132691608:8.O-O-O | Bf4 | same | 55 → 55 | yes |
| g_186132691608:10.Qxb4 | Qa5 | same | 46 → 46 | yes |
| g_186132691608:3...Qf6 | Nf6 | same | 17 → 19 | yes |
| g_186132691608:5...h6 | Bd6 | same | 15 → 18 | yes |
| g_186132691608:7...Nc6 | hxg5 | same | 52 → 55 | yes |
| game:13.c3 | Rc1 | same | 44 → 44 | yes |
| game:6.f3 | Be2 | same | 12 → 13 | yes |
| game:10.Qe3 | Be2 | same | 9 → 8 | yes |
| game:8...Bxd2+ | Bc5 | equal (≤3%) | 19 → 19 | yes |
| game:10...Qd6 | Nd4 | same | 9 → 10 | yes |
