"""ChessGym local admin sidecar.

Run:  python scripts/admin_server.py
Then: open http://localhost:8787/?admin=1

Serves the static app at / and exposes editing endpoints under /admin/api/*.
Reads and writes data/*.json. No authentication: only bind to localhost.
"""
import json
import os
import re
import subprocess
import sys
import threading
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import chess
import chess.pgn

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
THUMB_DIR = ROOT / "Thumbnails"

sys.path.insert(0, str(ROOT / "scripts"))
from generate_missing_thumbnails import (  # noqa: E402
    board_at_mid_position,
    load_piece_images,
    parse_game,
    render_board_png,
)
from new_line_rows import parse_moves, slugify, variation_san, move_to_uci  # noqa: E402
from rebuild_node_fens import rebuild_node_fens  # noqa: E402

HOST = "127.0.0.1"
PORT = 8787
ALLOWED_ORIGINS = {f"http://{HOST}:{PORT}", f"http://localhost:{PORT}"}

OPENING_HEADERS = ["opening_id", "opening_name", "side", "starting_fen", "description", "tags", "published", "book_max_plies_game_mode", "allow_transpositions"]
LINE_HEADERS = ["opening_id", "line_id", "line_name", "line_group", "line_priority", "drill_side", "start_fen", "elo", "moves_pgn", "thumb_ply"]
NODE_HEADERS = ["opening_id", "line_id", "node_id", "parent_node_id", "move_uci", "learn_prompt", "mistake_map", "fen_before", "fen_key", "fen_after", "fen_after_key"]

DATA_LOCK = threading.Lock()
PIECE_IMAGES = None


def piece_images():
    global PIECE_IMAGES
    if PIECE_IMAGES is None:
        PIECE_IMAGES = load_piece_images()
    return PIECE_IMAGES


def load_dataset(name):
    path = DATA_DIR / f"{name}.json"
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def save_dataset(name, rows, headers=None):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / f"{name}.json"
    if headers:
        normalized = []
        for row in rows:
            ordered = {key: str(row.get(key, "") or "") for key in headers}
            for key, value in row.items():
                if key not in ordered:
                    ordered[key] = "" if value is None else str(value)
            normalized.append(ordered)
        rows = normalized
    payload = json.dumps(rows, indent=2, ensure_ascii=False) + "\n"
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(payload)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp_path, path)


def find_index(rows, **criteria):
    for index, row in enumerate(rows):
        if all(str(row.get(key, "") or "") == str(value or "") for key, value in criteria.items()):
            return index
    return -1


def render_thumbnail(thumbnail_id, start_fen, moves_pgn, drill_side, thumb_ply=None, flip=None):
    board = board_at_mid_position(start_fen, moves_pgn, thumb_ply)
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    out_path = THUMB_DIR / f"{thumbnail_id}.png"
    resolved_flip = (drill_side or "").strip().lower().startswith("b") if flip is None else bool(flip)
    render_board_png(board, out_path, piece_images(), flip=resolved_flip)
    return out_path


def refresh_node_fens(openings, lines, nodes):
    result = rebuild_node_fens(openings, lines, nodes)
    if result["warnings"]:
        # Keep writes permissive for commentary-only edits, but leave clues in the sidecar console.
        for warning in result["warnings"]:
            print(f"FEN warning: {warning}", file=sys.stderr)
    return result


def fen_warnings(result):
    return list((result or {}).get("warnings") or [])


def create_line(payload):
    line_in = payload.get("line") or {}
    moves_text = (payload.get("moves") or "").strip()
    notation = payload.get("notation") or "auto"
    create_opening = bool(payload.get("create_opening"))
    opening_in = payload.get("opening") or {}
    if not moves_text:
        raise ValueError("Moves are required.")
    opening_id = (line_in.get("opening_id") or "").strip()
    line_name = (line_in.get("line_name") or "").strip()
    line_id = (line_in.get("line_id") or "").strip() or slugify(line_name)
    drill_side = (line_in.get("drill_side") or "white").strip().lower()
    if drill_side not in ("white", "black"):
        drill_side = "white"
    if not opening_id:
        raise ValueError("opening_id is required.")
    if not line_name:
        raise ValueError("line_name is required.")
    start_fen = (line_in.get("start_fen") or "").strip()

    moves = parse_moves(moves_text, notation, start_fen)
    if not moves:
        raise ValueError("No legal moves parsed.")
    moves_pgn = variation_san(start_fen, moves)

    with DATA_LOCK:
        openings = load_dataset("openings")
        lines = load_dataset("lines")
        nodes = load_dataset("nodes")

        if find_index(lines, opening_id=opening_id, line_id=line_id) != -1:
            raise ValueError(f"Line already exists: {opening_id}/{line_id}")

        opening_exists = find_index(openings, opening_id=opening_id) != -1
        if not opening_exists and not create_opening:
            raise ValueError(f"Opening does not exist: {opening_id}. Set create_opening to add it.")

        if not opening_exists and create_opening:
            openings.append({
                "opening_id": opening_id,
                "opening_name": (opening_in.get("opening_name") or opening_id).strip(),
                "side": (opening_in.get("side") or drill_side).strip(),
                "starting_fen": (opening_in.get("starting_fen") or start_fen).strip(),
                "description": opening_in.get("description") or "",
                "tags": opening_in.get("tags") or "",
                "published": opening_in.get("published") or "TRUE",
                "book_max_plies_game_mode": opening_in.get("book_max_plies_game_mode") or "",
                "allow_transpositions": opening_in.get("allow_transpositions") or "TRUE",
            })

        lines.append({
            "opening_id": opening_id,
            "line_id": line_id,
            "line_name": line_name,
            "line_group": (line_in.get("line_group") or "").strip(),
            "line_priority": (line_in.get("line_priority") or "1").strip(),
            "drill_side": drill_side,
            "start_fen": start_fen,
            "elo": (line_in.get("elo") or "").strip(),
            "moves_pgn": moves_pgn,
        })

        parent = ""
        for index, move in enumerate(moves, start=1):
            node_id = f"{line_id}_{index:03d}"
            nodes.append({
                "opening_id": opening_id,
                "line_id": line_id,
                "node_id": node_id,
                "parent_node_id": parent,
                "move_uci": move_to_uci(move),
                "learn_prompt": "",
                "mistake_map": "",
            })
            parent = node_id

        rebuild_result = refresh_node_fens(openings, lines, nodes)
        save_dataset("openings", openings, OPENING_HEADERS)
        save_dataset("lines", lines, LINE_HEADERS)
        save_dataset("nodes", nodes, NODE_HEADERS)

    thumb_path = render_thumbnail(line_id, start_fen, moves_pgn, drill_side)
    return {
        "opening_id": opening_id,
        "line_id": line_id,
        "line_name": line_name,
        "nodes_written": len(moves),
        "thumbnail": str(thumb_path.relative_to(ROOT)).replace("\\", "/"),
        "fen_warnings": fen_warnings(rebuild_result),
    }


def update_node(node_id, fields):
    allowed = {"learn_prompt", "mistake_map", "move_uci", "parent_node_id"}
    warnings = []
    with DATA_LOCK:
        openings = load_dataset("openings")
        lines = load_dataset("lines")
        nodes = load_dataset("nodes")
        index = find_index(nodes, node_id=node_id)
        if index == -1:
            raise ValueError(f"Node not found: {node_id}")
        for key, value in fields.items():
            if key in allowed:
                nodes[index][key] = "" if value is None else str(value)
        if any(key in fields for key in ("move_uci", "parent_node_id")):
            warnings = fen_warnings(refresh_node_fens(openings, lines, nodes))
        save_dataset("nodes", nodes, NODE_HEADERS)
        return nodes[index], warnings


def update_opening(opening_id, fields):
    allowed = {"opening_name", "side", "starting_fen", "description", "tags", "published", "book_max_plies_game_mode", "allow_transpositions"}
    warnings = []
    with DATA_LOCK:
        openings = load_dataset("openings")
        index = find_index(openings, opening_id=opening_id)
        if index == -1:
            raise ValueError(f"Opening not found: {opening_id}")
        for key, value in fields.items():
            if key in allowed:
                openings[index][key] = "" if value is None else str(value)
        save_dataset("openings", openings, OPENING_HEADERS)
        if "starting_fen" in fields:
            lines = load_dataset("lines")
            nodes = load_dataset("nodes")
            warnings = fen_warnings(refresh_node_fens(openings, lines, nodes))
            save_dataset("nodes", nodes, NODE_HEADERS)
        return openings[index], warnings


def update_line(line_id, fields):
    allowed = {"line_name", "line_group", "line_priority", "drill_side", "elo", "start_fen", "moves_pgn", "thumb_ply"}
    warnings = []
    with DATA_LOCK:
        openings = load_dataset("openings")
        lines = load_dataset("lines")
        index = find_index(lines, line_id=line_id)
        if index == -1:
            raise ValueError(f"Line not found: {line_id}")
        for key, value in fields.items():
            if key in allowed:
                lines[index][key] = "" if value is None else str(value)
        save_dataset("lines", lines, LINE_HEADERS)
        if "start_fen" in fields:
            nodes = load_dataset("nodes")
            warnings = fen_warnings(refresh_node_fens(openings, lines, nodes))
            save_dataset("nodes", nodes, NODE_HEADERS)
        return lines[index], warnings


def rebuild_all_fens():
    with DATA_LOCK:
        openings = load_dataset("openings")
        lines = load_dataset("lines")
        nodes = load_dataset("nodes")
        result = refresh_node_fens(openings, lines, nodes)
        save_dataset("nodes", nodes, NODE_HEADERS)
        return {**result, "fen_warnings": fen_warnings(result)}


def regenerate_thumbnail(line_id, thumb_ply_override=None):
    with DATA_LOCK:
        lines = load_dataset("lines")
    index = find_index(lines, line_id=line_id)
    if index == -1:
        raise ValueError(f"Line not found: {line_id}")
    line = lines[index]
    thumb_ply = thumb_ply_override if thumb_ply_override is not None else line.get("thumb_ply")
    out_path = render_thumbnail(line_id, line.get("start_fen", ""), line.get("moves_pgn", ""), line.get("drill_side", "white"), thumb_ply)
    return {"line_id": line_id, "thumbnail": str(out_path.relative_to(ROOT)).replace("\\", "/"), "thumb_ply": str(thumb_ply or "")}


def regenerate_opening_thumbnail(opening_id, line_id=None, thumb_ply_override=None):
    with DATA_LOCK:
        openings = load_dataset("openings")
        lines = load_dataset("lines")
    opening_index = find_index(openings, opening_id=opening_id)
    if opening_index == -1:
        raise ValueError(f"Opening not found: {opening_id}")
    opening = openings[opening_index]
    candidates = [line for line in lines if (line.get("opening_id") or "") == opening_id]
    selected_line = None
    if line_id:
        selected_line = next((line for line in candidates if (line.get("line_id") or "") == line_id), None)
        if selected_line is None:
            raise ValueError(f"Line not found in opening {opening_id}: {line_id}")
    elif candidates:
        selected_line = sorted(candidates, key=lambda line: len(parse_game(line.get("moves_pgn", ""))), reverse=True)[0]

    if selected_line:
        thumb_ply = thumb_ply_override if thumb_ply_override is not None else selected_line.get("thumb_ply")
        out_path = render_thumbnail(
            opening_id,
            selected_line.get("start_fen", ""),
            selected_line.get("moves_pgn", ""),
            selected_line.get("drill_side", "white"),
            thumb_ply,
            flip=False,
        )
        return {
            "opening_id": opening_id,
            "line_id": selected_line.get("line_id", ""),
            "thumbnail": str(out_path.relative_to(ROOT)).replace("\\", "/"),
            "thumb_ply": str(thumb_ply or ""),
        }

    out_path = render_thumbnail(opening_id, opening.get("starting_fen", ""), "", "white", None, flip=False)
    return {
        "opening_id": opening_id,
        "line_id": "",
        "thumbnail": str(out_path.relative_to(ROOT)).replace("\\", "/"),
        "thumb_ply": "",
    }


def git_commit(message):
    msg = (message or "").strip() or f"chessgym admin: edits {datetime.now().isoformat(timespec='seconds')}"
    cmds = [
        ["git", "add", "data", "Thumbnails"],
        ["git", "commit", "-m", msg],
    ]
    output = []
    for cmd in cmds:
        result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        output.append({
            "cmd": " ".join(cmd),
            "code": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        })
        if result.returncode != 0 and "nothing to commit" not in (result.stdout + result.stderr).lower():
            break
    return {"steps": output}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send_json(self, status, body):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON body: {exc}")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/admin/api/data":
            try:
                self._send_json(200, {
                    "openings": load_dataset("openings"),
                    "lines": load_dataset("lines"),
                    "nodes": load_dataset("nodes"),
                    "mistake_templates": load_dataset("mistake_templates"),
                })
            except Exception as exc:
                self._send_json(500, {"error": str(exc)})
            return
        if path == "/admin/api/health":
            self._send_json(200, {"ok": True, "root": str(ROOT)})
            return
        if path.startswith("/admin/api/"):
            self._send_json(404, {"error": "Not found"})
            return
        return super().do_GET()

    def _origin_allowed(self):
        for header in ("Origin", "Referer"):
            value = self.headers.get(header)
            if not value:
                continue
            try:
                parsed = urlparse(value)
            except ValueError:
                return False
            base = f"{parsed.scheme}://{parsed.netloc}"
            if base in ALLOWED_ORIGINS:
                return True
            return False
        # Same-origin browser POSTs always send Origin or Referer; tools like
        # curl that don't are acceptable since the listener is bound to loopback.
        return True

    def _route_write(self, method):
        path = urlparse(self.path).path
        if not self._origin_allowed():
            self._send_json(403, {"error": "Forbidden origin"})
            return
        try:
            if path == "/admin/api/line" and method == "POST":
                payload = self._read_json()
                self._send_json(200, {"ok": True, "result": create_line(payload)})
                return
            match = re.match(r"^/admin/api/node/([^/]+)$", path)
            if match and method == "PATCH":
                payload = self._read_json()
                node, warnings = update_node(match.group(1), payload)
                self._send_json(200, {"ok": True, "node": node, "fen_warnings": warnings})
                return
            match = re.match(r"^/admin/api/line/([^/]+)$", path)
            if match and method == "PATCH":
                payload = self._read_json()
                line, warnings = update_line(match.group(1), payload)
                self._send_json(200, {"ok": True, "line": line, "fen_warnings": warnings})
                return
            match = re.match(r"^/admin/api/opening/([^/]+)$", path)
            if match and method == "PATCH":
                payload = self._read_json()
                opening, warnings = update_opening(match.group(1), payload)
                self._send_json(200, {"ok": True, "opening": opening, "fen_warnings": warnings})
                return
            match = re.match(r"^/admin/api/thumbnail/([^/]+)$", path)
            if match and method == "POST":
                payload = self._read_json()
                override = payload.get("thumb_ply") if isinstance(payload, dict) else None
                self._send_json(200, {"ok": True, "result": regenerate_thumbnail(match.group(1), override)})
                return
            match = re.match(r"^/admin/api/opening-thumbnail/([^/]+)$", path)
            if match and method == "POST":
                payload = self._read_json()
                override = payload.get("thumb_ply") if isinstance(payload, dict) else None
                line_id = payload.get("line_id") if isinstance(payload, dict) else None
                self._send_json(200, {"ok": True, "result": regenerate_opening_thumbnail(match.group(1), line_id, override)})
                return
            if path == "/admin/api/git/commit" and method == "POST":
                payload = self._read_json()
                self._send_json(200, {"ok": True, "result": git_commit(payload.get("message", ""))})
                return
            if path == "/admin/api/fens/rebuild" and method == "POST":
                self._send_json(200, {"ok": True, "result": rebuild_all_fens()})
                return
            self._send_json(404, {"error": "Not found"})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def do_POST(self):
        self._route_write("POST")

    def do_PATCH(self):
        self._route_write("PATCH")


def main():
    print(f"ChessGym admin sidecar serving {ROOT}")
    print(f"Open http://{HOST}:{PORT}/?admin=1")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
