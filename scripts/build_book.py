import chess, csv, json, io, chess.pgn
book={}
named={}
for f in 'abcde':
    for row in csv.DictReader(open(f'data/{f}.tsv'),delimiter='\t'):
        g=chess.pgn.read_game(io.StringIO(row['pgn']))
        b=g.board()
        for mv in g.mainline_moves():
            b.push(mv)
            k=' '.join(b.fen().split()[:3])
            book.setdefault(k,'')
        k=' '.join(b.fen().split()[:3])
        nm=row['eco']+'|'+row['name']
        # prefer shortest name for a transposition (most general) only if none set
        if not book[k] or len(nm)<len(book[k]): book[k]=nm
json.dump(book,open('public/book.json','w'),separators=(',',':'))
print(len(book))
