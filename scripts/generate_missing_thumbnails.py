import argparse
import io
import json
from pathlib import Path

import chess
import chess.pgn
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
THUMB_DIR = ROOT / "Thumbnails"
PIECE_DIR = ROOT / "pieces"

LIGHT = (240, 217, 181)
DARK = (181, 136, 99)
BORDER = (60, 60, 60)
SQUARE = 88
MARGIN = 12
BOARD_SIZE = SQUARE * 8
CANVAS_SIZE = BOARD_SIZE + MARGIN * 2

PIECE_MAP = {
    "P": "white-pawn.png",
    "N": "white-knight.png",
    "B": "white-bishop.png",
    "R": "white-rook.png",
    "Q": "white-queen.png",
    "K": "white-king.png",
    "p": "black-pawn.png",
    "n": "black-knight.png",
    "b": "black-bishop.png",
    "r": "black-rook.png",
    "q": "black-queen.png",
    "k": "black-king.png",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Generate ChessGym thumbnails for missing or selected lines/openings.")
    parser.add_argument("--refresh-lines", choices=["missing", "all"], default="missing")
    parser.add_argument("--line-ids", default="", help="Comma-separated line_id list to regenerate (overwrites existing).")
    parser.add_argument("--skip-lines", action="store_true")
    parser.add_argument("--skip-openings", action="store_true")
    return parser.parse_args()


def load_dataset(name):
    path = DATA_DIR / f"{name}.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def load_openings():
    return load_dataset("openings")


def load_lines():
    return load_dataset("lines")


def existing_thumbnail_ids():
    return {p.stem for p in THUMB_DIR.glob("*.png")}


def parse_game(moves_pgn: str):
    game = chess.pgn.read_game(io.StringIO(moves_pgn or ""))
    if game is None:
        return []
    return list(game.mainline_moves())


def board_at_mid_position(start_fen: str, moves_pgn: str, thumb_ply=None):
    board = chess.Board(start_fen.strip()) if (start_fen or "").strip() else chess.Board()
    moves = parse_game(moves_pgn)
    if not moves:
        return board

    if thumb_ply is None or str(thumb_ply).strip() == "":
        target_plies = max(1, len(moves) // 2)
    else:
        try:
            target_plies = max(0, min(len(moves), int(thumb_ply)))
        except (TypeError, ValueError):
            target_plies = max(1, len(moves) // 2)
    for mv in moves[:target_plies]:
        if mv in board.legal_moves:
            board.push(mv)
        else:
            break
    return board


def is_black_study(row):
    side = (row.get("drill_side") or "").strip().lower()
    return side.startswith("b")


def load_piece_images():
    out = {}
    for symbol, filename in PIECE_MAP.items():
        path = PIECE_DIR / filename
        img = Image.open(path).convert("RGBA").resize((SQUARE, SQUARE), Image.LANCZOS)
        out[symbol] = img
    return out


def render_board_png(board: chess.Board, out_path: Path, piece_imgs, flip=False):
    img = Image.new("RGB", (CANVAS_SIZE, CANVAS_SIZE), (245, 245, 245))
    draw = ImageDraw.Draw(img)

    draw.rectangle([MARGIN - 2, MARGIN - 2, MARGIN + BOARD_SIZE + 1, MARGIN + BOARD_SIZE + 1], outline=BORDER, width=2)

    for rank in range(8):
        for file in range(8):
            x0 = MARGIN + file * SQUARE
            y0 = MARGIN + rank * SQUARE
            color = LIGHT if (rank + file) % 2 == 0 else DARK
            draw.rectangle([x0, y0, x0 + SQUARE, y0 + SQUARE], fill=color)

            if flip:
                sq = chess.square(7 - file, rank)
            else:
                sq = chess.square(file, 7 - rank)

            piece = board.piece_at(sq)
            if piece:
                pimg = piece_imgs[piece.symbol()]
                img.paste(pimg, (x0, y0), pimg)

    img.save(out_path, format="PNG", optimize=True)


def main():
    args = parse_args()

    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    openings = load_openings()
    lines = load_lines()
    existing = existing_thumbnail_ids()
    piece_imgs = load_piece_images()

    selected_line_ids = {item.strip() for item in args.line_ids.split(",") if item.strip()}
    known_line_ids = {(row.get("line_id") or "").strip() for row in lines}
    unknown_selected = sorted(selected_line_ids - known_line_ids)
    if unknown_selected:
        print(f"Warning: unknown line_ids ignored: {', '.join(unknown_selected)}")

    target_lines = []
    if not args.skip_lines:
        for row in lines:
            line_id = (row.get("line_id") or "").strip()
            if not line_id:
                continue
            if selected_line_ids:
                if line_id in selected_line_ids:
                    target_lines.append(row)
            elif args.refresh_lines == "all" or line_id not in existing:
                target_lines.append(row)

    target_openings = []
    if not args.skip_openings:
        for row in openings:
            opening_id = (row.get("opening_id") or "").strip()
            if not opening_id:
                continue
            if opening_id not in existing:
                target_openings.append(row)

    print(f"Line thumbnails to render: {len(target_lines)}")
    print(f"Opening thumbnails to render: {len(target_openings)}")

    created = 0
    failed = []

    for row in target_lines:
        line_id = row["line_id"].strip()
        try:
            board = board_at_mid_position(row.get("start_fen", ""), row.get("moves_pgn", ""), row.get("thumb_ply"))
            out_path = THUMB_DIR / f"{line_id}.png"
            flip = is_black_study(row)
            render_board_png(board, out_path, piece_imgs, flip=flip)
            created += 1
            print(f"+ line {line_id} ({'black' if flip else 'white'} view)")
        except Exception as exc:
            failed.append((line_id, str(exc)))
            print(f"! line {line_id}: {exc}")

    lines_by_opening = {}
    for row in lines:
        opening_id = (row.get("opening_id") or "").strip()
        if opening_id:
            lines_by_opening.setdefault(opening_id, []).append(row)

    def line_complexity(row):
        return len(parse_game(row.get("moves_pgn", "")))

    for opening in target_openings:
        opening_id = opening["opening_id"].strip()
        try:
            candidates = sorted(lines_by_opening.get(opening_id, []), key=line_complexity, reverse=True)
            rep = candidates[0] if candidates else None
            board = board_at_mid_position(rep.get("start_fen", ""), rep.get("moves_pgn", "")) if rep else board_at_mid_position(opening.get("starting_fen", ""), "")
            out_path = THUMB_DIR / f"{opening_id}.png"
            render_board_png(board, out_path, piece_imgs, flip=False)
            created += 1
            print(f"+ opening {opening_id}")
        except Exception as exc:
            failed.append((opening_id, str(exc)))
            print(f"! opening {opening_id}: {exc}")

    print(f"Created/updated: {created}")
    print(f"Failed: {len(failed)}")
    if failed:
        for item_id, err in failed:
            print(f"  - {item_id}: {err}")


if __name__ == "__main__":
    main()
