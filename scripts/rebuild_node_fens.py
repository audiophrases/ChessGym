"""Recompute durable FEN fields for every ChessGym node.

The app can derive these values at runtime, but storing them in data/nodes.json
lets game mode look up known repertoire positions directly and makes future
node-id removal much easier.
"""
import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

import chess

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"

FEN_FIELDS = ["fen_before", "fen_key", "fen_after", "fen_after_key"]


def normalize_fen(fen):
    parts = (fen or "").strip().split()
    if len(parts) < 4:
        return (fen or "").strip()
    return " ".join(parts[:4])


def board_from_fen(fen):
    value = (fen or "").strip()
    if not value or value == "start":
        return chess.Board()
    return chess.Board(value)


def move_to_uci(move):
    return chess.square_name(move.from_square) + chess.square_name(move.to_square) + (
        chess.piece_symbol(move.promotion) if move.promotion else ""
    )


def normalize_uci(value):
    normalized = (value or "").strip().lower()
    normalized = normalized.replace("=", "")
    normalized = re.sub(r"[+#?!]+$", "", normalized)
    return normalized


def clear_node_fens(node):
    for field in FEN_FIELDS:
        node[field] = ""


def set_node_fens(node, before_fen, after_fen):
    node["fen_before"] = before_fen
    node["fen_key"] = normalize_fen(before_fen)
    node["fen_after"] = after_fen
    node["fen_after_key"] = normalize_fen(after_fen)


def sorted_node_rows(nodes):
    return sorted(nodes, key=lambda row: ((row.get("node_id") or ""), (row.get("move_uci") or "")))


def rebuild_node_fens(openings, lines, nodes):
    """Mutate nodes with fen_before/fen_key/fen_after/fen_after_key values."""
    openings_by_id = {row.get("opening_id", ""): row for row in openings}
    nodes_by_line = defaultdict(list)
    for node in nodes:
        nodes_by_line[node.get("line_id", "")].append(node)

    warnings = []
    written = 0

    for node in nodes:
        clear_node_fens(node)

    for line in lines:
        line_id = line.get("line_id", "")
        if not line_id:
            continue
        line_nodes = nodes_by_line.get(line_id, [])
        if not line_nodes:
            continue

        by_node_id = {}
        children_by_parent = defaultdict(list)
        roots = []
        for node in line_nodes:
            node_id = node.get("node_id", "")
            if node_id:
                by_node_id[node_id] = node
            parent_id = node.get("parent_node_id", "") or ""
            if parent_id:
                children_by_parent[parent_id].append(node)
            else:
                roots.append(node)

        opening = openings_by_id.get(line.get("opening_id", ""), {})
        start_fen = line.get("start_fen") or opening.get("starting_fen") or ""
        try:
            start_board = board_from_fen(start_fen)
        except ValueError as exc:
            warnings.append(f"{line_id}: invalid start FEN {start_fen!r}: {exc}")
            continue

        visited = set()

        def walk(node, board):
            nonlocal written
            node_id = node.get("node_id", "")
            node_key = node_id or id(node)
            if node_key in visited:
                warnings.append(f"{line_id}/{node_id}: cycle or duplicate node reference skipped")
                return
            visited.add(node_key)

            before_fen = board.fen()
            uci = normalize_uci(node.get("move_uci"))
            try:
                move = chess.Move.from_uci(uci)
            except ValueError:
                warnings.append(f"{line_id}/{node_id}: invalid UCI {uci!r}")
                return
            if move not in board.legal_moves:
                warnings.append(f"{line_id}/{node_id}: illegal UCI {uci!r} for {before_fen}")
                return

            next_board = board.copy(stack=False)
            next_board.push(move)
            set_node_fens(node, before_fen, next_board.fen())
            node["move_uci"] = move_to_uci(move)
            written += 1

            for child in sorted_node_rows(children_by_parent.get(node_id, [])):
                walk(child, next_board.copy(stack=False))

        for root in sorted_node_rows(roots):
            walk(root, start_board.copy(stack=False))

        orphaned = [
            node for node in line_nodes
            if node.get("parent_node_id") and node.get("parent_node_id") not in by_node_id
        ]
        for node in sorted_node_rows(orphaned):
            warnings.append(
                f"{line_id}/{node.get('node_id', '')}: missing parent {node.get('parent_node_id', '')!r}"
            )

    return {"nodes_written": written, "warnings": warnings}


def load_json(path):
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path, rows):
    path.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def parse_args():
    parser = argparse.ArgumentParser(description="Rebuild ChessGym node FEN columns in data/nodes.json.")
    parser.add_argument("--data-dir", default=str(DATA_DIR), help="Directory containing openings/lines/nodes JSON files.")
    parser.add_argument("--check", action="store_true", help="Report whether nodes.json would change without writing.")
    return parser.parse_args()


def main():
    args = parse_args()
    data_dir = Path(args.data_dir)
    openings = load_json(data_dir / "openings.json")
    lines = load_json(data_dir / "lines.json")
    nodes_path = data_dir / "nodes.json"
    nodes = load_json(nodes_path)
    before = json.dumps(nodes, indent=2, ensure_ascii=False) + "\n"

    result = rebuild_node_fens(openings, lines, nodes)
    after = json.dumps(nodes, indent=2, ensure_ascii=False) + "\n"
    changed = before != after

    if args.check:
        print(f"nodes_written={result['nodes_written']} changed={str(changed).lower()}")
    else:
        save_json(nodes_path, nodes)
        print(f"nodes_written={result['nodes_written']} -> {nodes_path.relative_to(ROOT)}")

    for warning in result["warnings"]:
        print(f"warning: {warning}")

    if args.check and changed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
