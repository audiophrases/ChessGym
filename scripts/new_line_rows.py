import argparse
import csv
import io
import re
from pathlib import Path

import chess

try:
    from generate_missing_thumbnails import THUMB_DIR, load_piece_images, render_board_png
except ImportError:
    THUMB_DIR = Path(__file__).resolve().parents[1] / "Thumbnails"
    load_piece_images = None
    render_board_png = None


RESULT_TOKENS = {"1-0", "0-1", "1/2-1/2", "*"}
UCI_RE = re.compile(r"^[a-h][1-8][a-h][1-8][qrbnQRBN]?$")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Build ChessGym tabular data rows for a new opening line from UCI, SAN, or PGN move text."
    )
    parser.add_argument("--opening-id", required=True)
    parser.add_argument("--line-name", required=True)
    parser.add_argument("--moves", required=True, help="Move text in UCI, SAN, or PGN notation.")
    parser.add_argument("--drill-side", choices=["white", "black"], default="white")
    parser.add_argument("--line-id", default="", help="Defaults to a slug generated from --line-name.")
    parser.add_argument("--opening-name", default="")
    parser.add_argument("--new-opening", action="store_true", help="Also print a row for the openings tab.")
    parser.add_argument("--start-fen", default="", help="Blank means the normal starting position.")
    parser.add_argument("--notation", choices=["auto", "uci", "san", "pgn"], default="auto")
    parser.add_argument("--line-group", default="")
    parser.add_argument("--line-priority", default="1")
    parser.add_argument("--opening-side", choices=["white", "black"], default="")
    parser.add_argument("--description", default="")
    parser.add_argument("--tags", default="")
    parser.add_argument("--published", default="TRUE")
    parser.add_argument("--book-max-plies", default="")
    parser.add_argument("--allow-transpositions", default="TRUE")
    parser.add_argument("--thumbnail", action="store_true", help="Render Thumbnails/<line_id>.png.")
    return parser.parse_args()


def slugify(value):
    slug = re.sub(r"[^a-z0-9]+", "_", value.strip().lower())
    return slug.strip("_") or "new_line"


def make_board(start_fen):
    return chess.Board(start_fen.strip()) if start_fen.strip() else chess.Board()


def strip_variations(text):
    previous = None
    while previous != text:
        previous = text
        text = re.sub(r"\([^()]*\)", " ", text)
    return text


def tokenize_moves(text):
    text = re.sub(r"(?m)^\s*\[[^\]]+\]\s*$", " ", text)
    text = re.sub(r"\{[^}]*\}", " ", text)
    text = re.sub(r";[^\n\r]*", " ", text)
    text = strip_variations(text)
    tokens = []
    for raw in re.split(r"\s+", text.strip()):
        token = raw.strip()
        if not token:
            continue
        token = re.sub(r"^\d+\.(\.\.)?", "", token)
        token = token.strip()
        if not token or token in RESULT_TOKENS or token.startswith("$"):
            continue
        if re.fullmatch(r"\d+\.(\.\.)?", token):
            continue
        tokens.append(token)
    return tokens


def parse_uci_moves(board, tokens):
    moves = []
    for token in tokens:
        normalized = clean_uci_token(token)
        if not UCI_RE.match(normalized):
            raise ValueError(f"Not a UCI move: {token}")
        move = board.parse_uci(normalized)
        if move not in board.legal_moves:
            raise ValueError(f"Illegal UCI move for position {board.fen()}: {token}")
        moves.append(move)
        board.push(move)
    return moves


def parse_san_moves(board, tokens):
    moves = []
    for token in tokens:
        normalized = re.sub(r"[?!]+$", "", token)
        move = board.parse_san(normalized)
        moves.append(move)
        board.push(move)
    return moves


def parse_moves(text, notation, start_fen):
    tokens = tokenize_moves(text)
    if not tokens:
        raise ValueError("No moves found.")

    if notation == "auto":
        notation = "uci" if all(UCI_RE.match(clean_uci_token(token)) for token in tokens) else "san"
    if notation == "pgn":
        notation = "san"

    board = make_board(start_fen)
    if notation == "uci":
        return parse_uci_moves(board, tokens)
    return parse_san_moves(board, tokens)


def clean_uci_token(token):
    return re.sub(r"[+#?!]+$", "", token.lower().replace("=", ""))


def move_to_uci(move):
    return chess.square_name(move.from_square) + chess.square_name(move.to_square) + (move.promotion and chess.piece_symbol(move.promotion) or "")


def normalize_fen(fen):
    parts = (fen or "").strip().split()
    if len(parts) < 4:
        return (fen or "").strip()
    return " ".join(parts[:4])


def variation_san(start_fen, moves):
    board = make_board(start_fen)
    return board.variation_san(moves)


def rows_to_tsv(rows):
    out = io.StringIO()
    writer = csv.writer(out, dialect="excel-tab", lineterminator="\n")
    writer.writerows(rows)
    return out.getvalue().rstrip()


def build_rows(args, line_id, moves):
    start_fen = args.start_fen.strip()
    moves_pgn = variation_san(start_fen, moves)
    opening_row = [
        args.opening_id,
        args.opening_name or args.opening_id,
        args.opening_side or args.drill_side,
        start_fen,
        args.description,
        args.tags,
        args.published,
        args.book_max_plies,
        args.allow_transpositions,
    ]
    line_row = [
        args.opening_id,
        line_id,
        args.line_name,
        args.line_group,
        args.line_priority,
        args.drill_side,
        start_fen,
        moves_pgn,
    ]
    node_rows = []
    parent_id = ""
    board = make_board(start_fen)
    for index, move in enumerate(moves, start=1):
        node_id = f"{line_id}_{index:03d}"
        fen_before = board.fen()
        board.push(move)
        fen_after = board.fen()
        node_rows.append([
            args.opening_id,
            line_id,
            node_id,
            parent_id,
            move_to_uci(move),
            "",
            "",
            fen_before,
            normalize_fen(fen_before),
            fen_after,
            normalize_fen(fen_after),
        ])
        parent_id = node_id
    return opening_row, line_row, node_rows


def render_thumbnail(line_id, start_fen, moves, drill_side):
    if load_piece_images is None or render_board_png is None:
        raise RuntimeError("Thumbnail renderer is unavailable.")
    board = make_board(start_fen)
    target_plies = max(1, len(moves) // 2)
    for move in moves[:target_plies]:
        board.push(move)
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    out_path = THUMB_DIR / f"{line_id}.png"
    render_board_png(board, out_path, load_piece_images(), flip=drill_side == "black")
    return out_path


def main():
    args = parse_args()
    line_id = args.line_id.strip() or slugify(args.line_name)
    moves = parse_moves(args.moves, args.notation, args.start_fen)
    opening_row, line_row, node_rows = build_rows(args, line_id, moves)

    if args.new_opening:
        print("# openings data")
        print(rows_to_tsv([opening_row]))
        print()

    print("# lines data")
    print(rows_to_tsv([line_row]))
    print()

    print("# nodes data")
    print(rows_to_tsv(node_rows))

    if args.thumbnail:
        out_path = render_thumbnail(line_id, args.start_fen, moves, args.drill_side)
        print()
        print(f"# thumbnail: {out_path}")


if __name__ == "__main__":
    main()
