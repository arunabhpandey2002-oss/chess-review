# Builds public/openings.json: move counts and results for early positions, from the free public
# Lichess game database (CC0, database.lichess.org). Streams the start of one monthly file; nothing else is downloaded.
# Usage: python3 tools/build-openings.py [games=400000] [month=2025-09]
import sys, io, json, re, time, urllib.request
import zstandard, chess
TARGET = int(sys.argv[1]) if len(sys.argv) > 1 else 400000
MONTH = sys.argv[2] if len(sys.argv) > 2 else '2025-09'
URL = f'https://database.lichess.org/standard/lichess_db_standard_rated_{MONTH}.pgn.zst'
MAX_PLY, MIN_POS, MIN_MOVE, TOP = 20, 25, 3, 8
MIN_ELO = 1800
key = lambda b: ' '.join(b.fen().split(' ')[:3])
stats = {}  # key -> {uci: [w, d, b]}
TOK = re.compile(r'\{[^}]*\}|\([^)]*\)|\d+\.(\.\.)?|\$\d+|[!?]+')
res_idx = {'1-0': 0, '1/2-1/2': 1, '0-1': 2}

def add(h, moves):
    r = res_idx.get(h.get('Result'))
    if r is None: return False
    ev = h.get('Event', '')
    if 'Rated' not in ev or 'Bullet' in ev or 'Correspondence' in ev: return False
    try:
        if int(h.get('WhiteElo', 0)) < MIN_ELO or int(h.get('BlackElo', 0)) < MIN_ELO: return False
    except ValueError: return False
    sans = [t for t in TOK.sub(' ', moves).split() if t not in ('1-0', '0-1', '1/2-1/2', '*')][:MAX_PLY]
    if len(sans) < 2: return False
    b = chess.Board()
    for s in sans:
        try: m = b.parse_san(s)
        except ValueError: return True
        d = stats.setdefault(key(b), {})
        c = d.setdefault(m.uci(), [0, 0, 0]); c[r] += 1
        b.push(m)
    return True

t0 = time.time(); n = seen = 0
req = urllib.request.Request(URL, headers={'User-Agent': 'opening-stats-builder'})
with urllib.request.urlopen(req) as resp:
    text = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(resp), encoding='utf-8', errors='replace')
    h, moves = {}, []
    for line in text:
        if line.startswith('['):
            if moves:
                seen += 1
                if add(h, ' '.join(moves)): n += 1
                h, moves = {}, []
                if n >= TARGET: break
                if seen % 100000 == 0: print(f'{seen} read, {n} kept, {len(stats)} positions, {time.time()-t0:.0f}s', flush=True)
            m = re.match(r'\[(\w+) "(.*)"\]', line)
            if m: h[m.group(1)] = m.group(2)
        elif line.strip():
            moves.append(line.strip())
pos = {}
for k, d in stats.items():
    tot = sum(sum(v) for v in d.values())
    if tot < MIN_POS: continue
    mv = sorted(((u, *v) for u, v in d.items() if sum(v) >= MIN_MOVE), key=lambda x: -(x[1] + x[2] + x[3]))[:TOP]
    if mv: pos[k] = [tot] + [list(x) for x in mv]
out = {'meta': {'games': n, 'month': MONTH, 'minRating': MIN_ELO, 'speeds': 'blitz, rapid, classical', 'maxPly': MAX_PLY, 'licence': 'CC0'}, 'pos': pos}
json.dump(out, open('public/openings.json', 'w'), separators=(',', ':'))
print(f'done: {n} games, {len(pos)} positions, {time.time()-t0:.0f}s')
