# Builds src/repertoire.json: opening families you meet, each with its main named variations and one sound reply
# line per variation. Within a family your moves never contradict each other, so the trainer can branch on the
# opponent's choices.
# Sources (no theory typed by hand):
#  - names and ECO codes: lichess-org/chess-openings (CC0), data/*.tsv
#  - move choices: the bundled Lichess database sample public/openings.json (CC0, database.lichess.org,
#    400k rated blitz/rapid/classical games, both players 1800+) = the "lichess" side of the opening explorer
#  - sanity check: native Stockfish; no move of yours in a line may lose more than 0.5 pawns.
# Short reasons per key move come from tools/repertoire-notes.json (checked against the generated SAN).
# Usage: python3 tools/build-repertoire.py [depth=16] [--draft] [--only=family,...]
# Seed lines (ENTRIES) need hand-reviewed reasons in the notes file; extra variations get a reason generated from
# the move itself plus the sample and Stockfish numbers.
import sys, csv, json, chess, chess.engine
DEPTH = int(next((a for a in sys.argv[1:] if a.isdigit()), 16))
DRAFT = '--draft' in sys.argv
SF = '/workspace/stockfish/stockfish-linux-x86-64-universal'
MAX_LOSS, PICK_LOSS = 50, 30            # cp: hard limit for any move of yours; preferred limit when choosing
MIN_GAMES, MIN_SHARE, TARGET_EXTRA, MIN_EXTRA = 40, 0.08, 8, 6

ENTRIES = [  # id, side you play, moves that identify it (must be an exact line in the dataset), lichess names that count as it
  ('reti', 'b', '1. Nf3 d5 2. c4', ["Réti Opening", "Zukertort Opening"]),
  ('kia', 'b', '1. Nf3 d5 2. g3', ["King's Indian Attack"]),
  ('english', 'b', '1. c4', ["English Opening"]),
  ('london', 'b', '1. d4 d5 2. Nf3 Nf6 3. Bf4', ["London System", "Queen's Pawn Game: London System", "Queen's Pawn Game: Accelerated London System", "Indian Defense: Accelerated London System"]),
  ('qg', 'b', '1. d4 d5 2. c4', ["Queen's Gambit", "Queen's Gambit Declined", "Queen's Gambit Accepted", "Slav Defense"]),
  ('italian', 'b', '1. e4 e5 2. Nf3 Nc6 3. Bc4', ["Italian Game", "Giuoco Piano"]),
  ('evans', 'b', '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4', ["Italian Game: Evans Gambit"]),
  ('ruy', 'b', '1. e4 e5 2. Nf3 Nc6 3. Bb5', ["Ruy Lopez"]),
  ('scotch', 'b', '1. e4 e5 2. Nf3 Nc6 3. d4', ["Scotch Game"]),
  ('kings-gambit', 'b', '1. e4 e5 2. f4', ["King's Gambit", "King's Gambit Accepted", "King's Gambit Declined"]),
  ('danish', 'b', '1. e4 e5 2. d4 exd4 3. c3', ["Danish Gambit", "Danish Gambit Accepted", "Danish Gambit Declined"]),
  ('sicilian', 'w', '1. e4 c5', ["Sicilian Defense"]),
  ('french', 'w', '1. e4 e6', ["French Defense"]),
  ('caro-kann', 'w', '1. e4 c6', ["Caro-Kann Defense"]),
  ('scandinavian', 'w', '1. e4 d5', ["Scandinavian Defense"]),
  ('kid', 'w', '1. d4 Nf6 2. c4 g6 3. Nc3', ["King's Indian Defense"]),
  ('pirc', 'w', '1. e4 d6 2. d4 Nf6 3. Nc3 g6', ["Pirc Defense"]),
  # added after looking at sample games: as White, 1.d4 and 2.Nf3; as Black, meet 1.e4 with ...e5
  ('three-knights', 'b', '1. e4 e5 2. Nf3 Nc6 3. Nc3', ["Three Knights Opening", "Four Knights Game"]),
  ('bishops', 'b', '1. e4 e5 2. Bc4', ["Bishop's Opening"]),
  ('wayward-queen', 'b', '1. e4 e5 2. Qh5', ["King's Pawn Game: Wayward Queen Attack"]),
  ('center-game', 'b', '1. e4 e5 2. d4 exd4 3. Qxd4', ["Center Game", "Center Game Accepted"]),
  ('vienna', 'b', '1. e4 e5 2. Nc3', ["Vienna Game"]),
  ('qpg-symmetrical', 'w', '1. d4 d5 2. Nf3 Nf6', ["Queen's Pawn Game"]),
  ('qpg-chigorin', 'w', '1. d4 d5 2. Nf3 Nc6', ["Queen's Pawn Game: Chigorin Variation"]),
  ('indian-knights', 'w', '1. d4 Nf6 2. Nf3', ["Indian Defense"]),
  ('englund', 'w', '1. d4 e5', ["Englund Gambit", "Englund Gambit Declined", "Englund Gambit Complex", "Englund Gambit Complex Declined"]),
  ('mikenas', 'w', '1. d4 Nc6', ["Mikenas Defense"]),
  ('dutch', 'w', '1. d4 f5', ["Dutch Defense"]),
]

# where the most popular sound move runs out of sample data fast, use the next most popular sound move
PREFER = {'reti': {'3': 'e6'},
  # as White he plays 1.d4, 2.Nf3 and 3.Nc3 (from his chess.com games); keep his setup where it's sound
  'qpg-symmetrical': {'4': 'Nc3'}, 'qpg-chigorin': {'4': 'Bf4'}, 'indian-knights': {'4': 'Nc3'},
  'mikenas': {'2': 'Nf3', '4': 'Nc3'}, 'dutch': {'2': 'Nf3', '4': 'Nc3'}}
PREFER_SHARE = 0.03

# Families: id, your side, title, root moves, lichess family names that belong to it, seed lines (built first).
# Extra variations: every named line (lichess chess-openings) of the family that occurs in his games, then the most
# played ones in the sample, up to CAP per family.
FAMILIES = [
  ('f-reti', 'b', 'Réti / Zukertort Opening', '1. Nf3', ["Zukertort Opening", "Réti Opening", "King's Indian Attack"], ['reti', 'kia']),
  ('f-english', 'b', 'English Opening', '1. c4', ["English Opening"], ['english']),
  ('f-qpg-b', 'b', "Queen's Pawn Game (London and others)", '1. d4', ["Queen's Pawn Game", "London System"], ['london']),
  ('f-qg', 'b', "Queen's Gambit", '1. d4 d5 2. c4', ["Queen's Gambit", "Queen's Gambit Declined", "Queen's Gambit Accepted", "Slav Defense"], ['qg']),
  ('f-italian', 'b', 'Italian Game', '1. e4 e5 2. Nf3 Nc6 3. Bc4', ["Italian Game"], ['italian', 'evans']),
  ('f-ruy', 'b', 'Ruy Lopez', '1. e4 e5 2. Nf3 Nc6 3. Bb5', ["Ruy Lopez"], ['ruy']),
  ('f-scotch', 'b', 'Scotch Game', '1. e4 e5 2. Nf3 Nc6 3. d4', ["Scotch Game"], ['scotch']),
  ('f-knights', 'b', 'Three and Four Knights', '1. e4 e5 2. Nf3 Nc6 3. Nc3', ["Three Knights Opening", "Four Knights Game"], ['three-knights']),
  ('f-kings-knight', 'b', "King's Knight Opening", '1. e4 e5 2. Nf3', ["King's Knight Opening"], []),
  ('f-kings-gambit', 'b', "King's Gambit", '1. e4 e5 2. f4', ["King's Gambit", "King's Gambit Accepted", "King's Gambit Declined"], ['kings-gambit']),
  ('f-center', 'b', 'Center Game and Danish Gambit', '1. e4 e5 2. d4', ["Center Game", "Center Game Accepted", "Danish Gambit", "Danish Gambit Accepted", "Danish Gambit Declined"], ['center-game', 'danish']),
  ('f-bishops', 'b', "Bishop's Opening", '1. e4 e5 2. Bc4', ["Bishop's Opening"], ['bishops']),
  ('f-vienna', 'b', 'Vienna Game', '1. e4 e5 2. Nc3', ["Vienna Game"], ['vienna']),
  ('f-kings-pawn', 'b', "King's Pawn Game (Wayward Queen and others)", '1. e4 e5', ["King's Pawn Game"], ['wayward-queen']),
  ('f-qpg-w', 'w', "Queen's Pawn Game", '1. d4', ["Queen's Pawn Game"], ['qpg-symmetrical', 'qpg-chigorin']),
  ('f-indian', 'w', 'Indian Defense (1.d4 Nf6)', '1. d4 Nf6', ["Indian Defense"], ['indian-knights']),
  ('f-kid', 'w', "King's Indian Defense", '1. d4 Nf6 2. c4 g6', ["King's Indian Defense"], ['kid']),
  ('f-englund', 'w', 'Englund Gambit', '1. d4 e5', ["Englund Gambit", "Englund Gambit Declined", "Englund Gambit Complex", "Englund Gambit Complex Declined"], ['englund']),
  ('f-mikenas', 'w', 'Mikenas Defense', '1. d4 Nc6', ["Mikenas Defense"], ['mikenas']),
  ('f-dutch', 'w', 'Dutch Defense', '1. d4 f5', ["Dutch Defense"], ['dutch']),
  ('f-sicilian', 'w', 'Sicilian Defense', '1. e4 c5', ["Sicilian Defense"], ['sicilian']),
  ('f-french', 'w', 'French Defense', '1. e4 e6', ["French Defense"], ['french']),
  ('f-caro', 'w', 'Caro-Kann Defense', '1. e4 c6', ["Caro-Kann Defense"], ['caro-kann']),
  ('f-scandi', 'w', 'Scandinavian Defense', '1. e4 d5', ["Scandinavian Defense"], ['scandinavian']),
  ('f-pirc', 'w', 'Pirc Defense', '1. e4 d6 2. d4 Nf6 3. Nc3 g6', ["Pirc Defense"], ['pirc']),
]
CAP, MIN_VAR_GAMES = 7, 60
by_key = {}
FAMILY_IDEA = {  # families with no hand-written seed line
    'f-kings-knight': "After 1.e4 e5 2.Nf3 Nc6 White skips the main lines (no 3.Bc4, 3.Bb5, 3.d4 or 3.Nc3) and plays a quiet 3.d3, 3.g3 or 3.Be2. "
                      "There is no early threat: develop with ...Nf6, take the centre with ...d5 when it is safe, and you are at least equal.",
}
fam_of = lambda name: name.split(':')[0].strip()
HIS = json.load(open('tools/his-variations.json', encoding='utf-8'))['counts']
class Conflict(Exception): pass

rows = []
for f in 'abcde':
    rows += list(csv.DictReader(open(f'data/{f}.tsv', encoding='utf-8'), delimiter='\t'))
by_pgn = {r['pgn']: r for r in rows}
book = json.load(open('public/openings.json'))
assert book['meta']['licence'] == 'CC0'
key = lambda b: ' '.join(b.fen().split(' ')[:3])
fkey = lambda fen: ' '.join(fen.split(' ')[:3])
def board_of(pgn):
    b = chess.Board()
    for t in pgn.split():
        if not t[0].isdigit(): b.push_san(t)
    return b
for _r in rows: by_key.setdefault(key(board_of(_r['pgn'])), _r)
PIECE = {chess.KNIGHT: 'knight', chess.BISHOP: 'bishop', chess.ROOK: 'rook', chess.QUEEN: 'queen', chess.KING: 'king', chess.PAWN: 'pawn'}
def auto_why(fen, uci, p):
    """A plain reason from the move itself and the numbers behind it (used where no reviewed note exists)."""
    b = chess.Board(fen); m = chess.Move.from_uci(uci); pc = b.piece_at(m.from_square); to = chess.square_name(m.to_square)
    if b.is_castling(m): what = 'Castle: your king is safe and a rook joins the game'
    elif b.is_capture(m): what = f'Take on {to} with the {PIECE[pc.piece_type]}'
    elif pc.piece_type in (chess.KNIGHT, chess.BISHOP) and chess.square_rank(m.from_square) in (0, 7): what = f'Develop the {PIECE[pc.piece_type]} to {to}'
    elif pc.piece_type == chess.PAWN and chess.square_file(m.to_square) in (2, 3, 4, 5): what = f'Pawn to {to}: space and a say in the centre'
    elif pc.piece_type == chess.PAWN: what = f'Pawn to {to}'
    else: what = f'{PIECE[pc.piece_type].capitalize()} to {to}'
    if b.gives_check(m): what += ', with check'
    if p.get('src') == 'engine' or not p.get('games'): tail = "Stockfish's choice; few games reach this position."
    else: tail = f"Most played here ({round(p['share'] * 100)}% of {p['games']:,} games)" + ('.' if p['lossCp'] <= 10 else f", within {p['lossCp'] / 100:.1f} pawns of Stockfish's best.")
    return f'{what}. {tail}'

notes = {} if DRAFT else json.load(open('tools/repertoire-notes.json', encoding='utf-8'))

eng = chess.engine.SimpleEngine.popen_uci(SF)
eng.configure({'Threads': 1, 'Hash': 256})  # one thread: the same depth gives the same line every run
cache = {}
def scores(b, cands, depth=DEPTH):
    """Scores (side to move, centipawns) for each candidate and for the engine's best move, from one multipv search
    over the same root moves so the numbers are comparable. Returns (best_move, best_score, {uci: score})."""
    k = (b.fen(), tuple(sorted(m.uci() for m in cands)), depth)
    if k in cache: return cache[k]
    top = eng.analyse(b, chess.engine.Limit(depth=depth))['pv'][0]
    roots = list(dict.fromkeys([top] + list(cands)))
    infos = eng.analyse(b, chess.engine.Limit(depth=depth), root_moves=roots, multipv=len(roots))
    sc = {i['pv'][0].uci(): i['score'].pov(b.turn).score(mate_score=10000) for i in infos}
    bm = max(sc, key=sc.get)
    r = (chess.Move.from_uci(bm), sc[bm], sc)
    cache[k] = r
    return r

def sample(b):
    e = book['pos'].get(key(b))
    if not e: return 0, []
    total, *mv = e
    out = []
    for uci, w, d, bl in mv:
        m = chess.Move.from_uci(uci)
        if m in b.legal_moves: out.append((m, w + d + bl, w, d, bl))
    return total, out

def build(eid, side, idpgn, names, fixed=None, famwhy=None, famidea='', stay=None):
    fixed = {} if fixed is None else fixed
    row = by_pgn.get(idpgn)
    assert row, f'{eid}: "{idpgn}" is not a line in lichess chess-openings'
    b = chess.Board()
    ident, tb = [], chess.Board()
    for t in idpgn.split():
        if t[0].isdigit(): continue
        ident.append(tb.push_san(t))
    plies = []
    def add_user(m, total, moves, src='db'):
        cands = [m] + [x[0] for x in moves[:6]]
        _, best, sc = scores(b, cands)
        loss = max(0, best - sc[m.uci()])
        alts = []
        for mm, n, w, d, bl in moves[:6]:
            if mm == m: continue
            alts.append({'san': b.san(mm), 'uci': mm.uci(), 'games': n, 'share': round(n / total, 3) if total else 0, 'lossCp': max(0, best - sc[mm.uci()])})
        n = next((x[1] for x in moves if x[0] == m), 0)
        plies.append({'san': b.san(m), 'uci': m.uci(), 'fen': b.fen(), 'mine': True, 'games': n, 'share': round(n / total, 3) if total else 0, 'lossCp': loss, 'evalCp': sc[m.uci()], 'alts': alts, 'src': src})
        return loss
    # identity moves (yours are checked too)
    for m in ident:
        if ('w' if b.turn else 'b') == side:
            if fixed.get(key(b), m.uci()) != m.uci(): raise Conflict(f'needs {b.san(m)} where your line plays {b.san(chess.Move.from_uci(fixed[key(b)]))}')
            total, moves = sample(b)
            add_user(m, total, moves, '')
        else:
            total, moves = sample(b)
            n = next((x[1] for x in moves if x[0] == m), 0)
            plies.append({'san': b.san(m), 'uci': m.uci(), 'fen': b.fen(), 'mine': False, 'games': n, 'share': round(n / total, 3) if total else 0})
        b.push(m)
    idn = len(plies)
    # response line from the sample; if the sample runs thin before MIN_EXTRA plies, Stockfish finishes the line
    while len(plies) - idn < 10:
        total, moves = sample(b)
        mine_turn = ('w' if b.turn else 'b') == side
        extra = len(plies) - idn
        thin = total < MIN_GAMES or not moves
        if thin and extra >= MIN_EXTRA and plies[-1]['mine']: break
        if not mine_turn and extra >= TARGET_EXTRA: break
        if thin:
            m = eng.analyse(b, chess.engine.Limit(depth=DEPTH))['pv'][0]
            pin = [k.split(':', 1)[1] for k in notes.get(eid, {}).get('moves', {}) if k.split(':')[0] == str(len(plies))]
            if pin and mine_turn: m = b.parse_san(pin[0])  # reviewed engine choice, re-checked by the final depth+2 test
            if mine_turn and key(b) in fixed: m = chess.Move.from_uci(fixed[key(b)])  # same move as elsewhere in the family
            if mine_turn: add_user(m, total, moves, 'engine')
            else: plies.append({'san': b.san(m), 'uci': m.uci(), 'fen': b.fen(), 'mine': False, 'games': 0, 'share': 0, 'src': 'engine'})
            b.push(m); continue
        if mine_turn:
            top, best, sc = scores(b, [x[0] for x in moves[:6]])
            pick = next((m for m, n, *_ in moves[:6] if n / total >= MIN_SHARE and best - sc[m.uci()] <= PICK_LOSS), None)
            src = 'db'
            noted = [k.split(':', 1)[1] for k in notes.get(eid, {}).get('moves', {}) if k.split(':')[0] == str(len(plies))]
            if noted:  # the reviewed line in the notes pins the choice so reruns are stable; it must still be common and sound
                pick = b.parse_san(noted[0])
                assert any(x[0] == pick and x[1] / total >= (PREFER_SHARE if PREFER.get(eid, {}).get(str(len(plies))) == noted[0] else MIN_SHARE) for x in moves), f'{eid}: noted move {noted[0]} not common'
                assert best - sc[pick.uci()] <= MAX_LOSS if pick.uci() in sc else True
            elif str(len(plies)) in PREFER.get(eid, {}):
                # his own repertoire choice (from his games), used only when it's in the sample at 3%+ and sound
                try: want = b.parse_san(PREFER[eid][str(len(plies))])
                except ValueError: want = None
                n_want = next((x[1] for x in moves if x[0] == want), 0)
                if want and n_want / total >= PREFER_SHARE:
                    _, best2, sc2 = scores(b, [want] + [x[0] for x in moves[:6]])
                    if best2 - sc2[want.uci()] <= PICK_LOSS: pick = want
            if pick is None: pick, src = top, 'engine'
            if key(b) in fixed:  # the family already has your move for this position
                pick = chess.Move.from_uci(fixed[key(b)]); src = 'db' if any(x[0] == pick for x in moves) else 'engine'
            add_user(pick, total, moves, src)
            b.push(pick)
        else:
            m = moves[0][0]
            if stay and len(plies) == idn and plies[-1]['mine']:
                # the name was given at your move, so it means the opponent then avoids the moves that have names of
                # their own in other families (e.g. "King's Knight Opening: Normal Variation" = not 3.Bc4/3.Bb5/3.d4...)
                def other(mm):
                    b.push(mm); r = by_key.get(key(b)); b.pop()
                    return r is not None and fam_of(r['name']) not in stay
                m = next((x[0] for x in moves if not other(x[0])), m)
                moves = sorted(moves, key=lambda x: x[0] != m)
            plies.append({'san': b.san(m), 'uci': m.uci(), 'fen': b.fen(), 'mine': False, 'games': moves[0][1], 'share': round(moves[0][1] / total, 3), 'src': 'db'})
            b.push(m)
    # end on your move
    while plies and not plies[-1]['mine']: plies.pop()
    # final check deeper
    for p in plies:
        if not p['mine']: continue
        bb = chess.Board(p['fen']); m = chess.Move.from_uci(p['uci'])
        _, best, sc = scores(bb, [m] + [chess.Move.from_uci(a['uci']) for a in p['alts']], depth=DEPTH + 2)
        p['lossCp'] = max(0, best - sc[m.uci()])
        for a2 in p['alts']: a2['lossCp'] = max(0, best - sc[a2['uci']])
        assert p['lossCp'] <= MAX_LOSS, f"{eid}: {p['san']} loses {p['lossCp']}cp"
    end = chess.Board(); [end.push(chess.Move.from_uci(p['uci'])) for p in plies]
    endEval = eng.analyse(end, chess.engine.Limit(depth=DEPTH + 2))['score'].pov(end.turn).score(mate_score=10000) * (1 if ('w' if end.turn else 'b') == side else -1)
    # name of the position the line ends in (longest named prefix)
    bb = chess.Board(); endName = row['eco'] + ' ' + row['name']; sans = []
    for p in plies:
        bb.push(chess.Move.from_uci(p['uci'])); sans.append(p['san'])
        pg = ' '.join((f"{i // 2 + 1}. " if i % 2 == 0 else '') + s for i, s in enumerate(sans))
        if pg in by_pgn: endName = by_pgn[pg]['eco'] + ' ' + by_pgn[pg]['name']
    n = notes.get(eid, {})
    for p in plies:
        if p['mine']: fixed.setdefault(fkey(p['fen']), p['uci'])
    if not n and not DRAFT:  # extra variation: reviewed reasons from the family's seed lines where the position matches, else generated
        for i, p in enumerate(plies):
            if p['mine'] and i >= idn: p['why'] = (famwhy or {}).get((fkey(p['fen']), p['uci'])) or auto_why(p['fen'], p['uci'], p)
        n = {'idea': famidea}
    elif not DRAFT:
        assert n.get('idea'), f'{eid}: no idea note'
        for i, p in enumerate(plies):
            want = n.get('moves', {}).get(f"{i}:{p['san']}")
            if want: p['why'] = want
            elif p['mine'] and i >= idn and famwhy and (fkey(p['fen']), p['uci']) in famwhy: p['why'] = famwhy[(fkey(p['fen']), p['uci'])]
            elif p['mine'] and i >= idn: raise AssertionError(f"{eid}: no reason for ply {i}:{p['san']}")
        extra = set(n.get('moves', {})) - {f"{i}:{p['san']}" for i, p in enumerate(plies)}
        assert not extra, f"{eid}: notes for moves not in the line: {extra}"
    return {'id': eid, 'side': side, 'eco': row['eco'], 'name': row['name'], 'idPgn': idpgn, 'idPlies': idn, 'names': names,
            'idea': n.get('idea', ''), 'endsIn': endName, 'endEvalCp': endEval, 'plies': plies}

ONLY = next((a.split('=', 1)[1].split(',') for a in sys.argv[1:] if a.startswith('--only=')), None)
SEEDS = {e[0]: e for e in ENTRIES}
assert sorted(sum((f[5] for f in FAMILIES), [])) == sorted(SEEDS), 'every seed belongs to exactly one family'
count_at = lambda pgn: (book['pos'].get(key(board_of(pgn))) or [0])[0]
fam_of = lambda name: name.split(':')[0].strip()
def slug(name):
    import re, unicodedata
    t = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', t).strip('-')[:56].strip('-')
def show(r):
    line = ' '.join(((f"{i // 2 + 1}." if i % 2 == 0 else '') + p['san'] + ('*' if p['mine'] else '') + ('(e)' if p.get('src') == 'engine' else '')) for i, p in enumerate(r['plies']))
    print(f"  {r['id'][:34]:34} {r['eco']} {r['count']:>6} | {line} | end {r['endEvalCp']:+}cp | {r['endsIn']}", flush=True)
    for i, p in enumerate(r['plies']):
        if p['mine'] and p['lossCp'] > 30: print(f"     {i}:{p['san']}  share {p['share']:.0%} loss {p['lossCp']}cp")
out, fams, used = [], [], set()
try:
    for fid, side, title, root, prefixes, seeds in FAMILIES:
        if ONLY and fid not in ONLY: continue
        print(fid, title, flush=True)
        fixed, famwhy, vars_, skipped = {}, {}, [], []
        positions = {}  # position key -> variation id whose line passes through it
        def add(r, his=0):
            r['family'] = fid; r['count'] = count_at(r['idPgn']); r['fromGames'] = his
            vars_.append(r); used.add(r['id']); show(r)
            b = chess.Board(); positions.setdefault(key(b), r['id'])
            for p in r['plies']:
                b.push(chess.Move.from_uci(p['uci'])); positions.setdefault(key(b), r['id'])
                if p.get('why'): famwhy.setdefault((fkey(p['fen']), p['uci']), p['why'])
        for sid in seeds:
            e = SEEDS[sid]; add(build(*e, fixed=fixed, famwhy=famwhy))
        idea = vars_[0]['idea'] if vars_ else ''
        idea = idea or FAMILY_IDEA.get(fid, '')
        cands = [r for r in rows if fam_of(r['name']) in prefixes and (r['pgn'] + ' ').startswith(root + ' ')]
        his = sorted([r for r in cands if f"{side}|{r['name']}" in HIS], key=lambda r: -HIS[f"{side}|{r['name']}"])
        pop = sorted([r for r in cands if count_at(r['pgn']) >= MIN_VAR_GAMES], key=lambda r: (-count_at(r['pgn']), r['pgn']))
        seen_names = set()
        for r in his + pop:
            hisn = HIS.get(f"{side}|{r['name']}", 0)
            if r['name'] in seen_names: continue
            seen_names.add(r['name'])
            k = key(board_of(r['pgn']))
            if k in positions:  # already on one of the family's lines: that line covers this name too
                v = next(v for v in vars_ if v['id'] == positions[k])
                if r['name'] not in v['names']: v.setdefault('also', []).append(r['name']); v['names'].append(r['name'])
                continue
            if not hisn and len(vars_) >= CAP: continue
            if hisn and len(vars_) >= CAP + 3: continue
            vid = slug(r['name']); n2 = 2
            while vid in used: vid = f"{slug(r['name'])[:52]}-{n2}"; n2 += 1
            try: add(build(vid, side, r['pgn'], [r['name']], fixed=fixed, famwhy=famwhy, famidea=idea, stay=prefixes), hisn)
            except Conflict as ex: skipped.append({'name': r['name'], 'eco': r['eco'], 'pgn': r['pgn'], 'why': str(ex), 'games': hisn}); print('   skip', r['name'], '-', ex)
            except AssertionError as ex: skipped.append({'name': r['name'], 'eco': r['eco'], 'pgn': r['pgn'], 'why': 'a move of yours in it fails the Stockfish check', 'games': hisn}); print('   skip', r['name'], '-', ex)
        out += vars_
        fams.append({'id': fid, 'side': side, 'name': title, 'root': root, 'familyNames': prefixes, 'idea': idea, 'variations': [v['id'] for v in vars_], 'skipped': [x for x in skipped if x['games']] + [x for x in skipped if not x['games']][:4]})
except Exception:
    eng.quit(); raise
eng.quit()
meta = {'sources': {'names': 'lichess-org/chess-openings (CC0)', 'moves': f"Lichess database sample: {book['meta']['games']} games, {book['meta']['month']}, {book['meta']['speeds']}, both players {book['meta']['minRating']}+ (CC0)", 'check': f'Stockfish depth {DEPTH + 2}: no move of yours loses more than {MAX_LOSS / 100} pawns'}, 'yourGames': HIS and json.load(open('tools/his-variations.json', encoding='utf-8'))['note']}
if not DRAFT and ONLY:  # rebuild of some families: keep the rest of the file
    old = json.load(open('src/repertoire.json', encoding='utf-8'))
    keep = [f for f in old.get('families', []) if f['id'] not in ONLY]
    keep_ids = {v for f in keep for v in f['variations']}
    order = [f[0] for f in FAMILIES]
    fams = sorted(keep + fams, key=lambda f: order.index(f['id']) if f['id'] in order else 99)
    out = [o for o in old['openings'] if o['id'] in keep_ids] + out
if not DRAFT:
    json.dump({'meta': meta, 'families': fams, 'openings': out}, open('src/repertoire.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    print('wrote src/repertoire.json')
