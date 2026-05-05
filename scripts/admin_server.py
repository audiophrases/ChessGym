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
from uuid import uuid4

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
LINE_HEADERS = ["opening_id", "line_id", "line_name", "line_group", "drill_side", "start_fen", "tags", "moves_pgn", "thumb_ply"]
NODE_HEADERS = ["opening_id", "line_id", "node_id", "parent_node_id", "move_uci", "learn_prompt", "mistake_map", "fen_before", "fen_key", "fen_after", "fen_after_key"]
SUGGESTION_STATUSES = {"pending", "done", "archived"}

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


def render_thumbnail(thumbnail_id, start_fen, moves_pgn, drill_side, thumb_ply=None, flip=None, fen=None):
    if fen and str(fen).strip():
        try:
            board = chess.Board(str(fen).strip())
        except ValueError as exc:
            raise ValueError(f"Invalid FEN: {exc}")
    else:
        board = board_at_mid_position(start_fen, moves_pgn, thumb_ply)
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    out_path = THUMB_DIR / f"{thumbnail_id}.png"
    resolved_flip = (drill_side or "").strip().lower().startswith("b") if flip is None else bool(flip)
    render_board_png(board, out_path, piece_images(), flip=resolved_flip)
    return out_path


def optional_bool(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y", "black"}


def refresh_node_fens(openings, lines, nodes):
    result = rebuild_node_fens(openings, lines, nodes)
    if result["warnings"]:
        # Keep writes permissive for commentary-only edits, but leave clues in the sidecar console.
        for warning in result["warnings"]:
            print(f"FEN warning: {warning}", file=sys.stderr)
    return result


def fen_warnings(result):
    return list((result or {}).get("warnings") or [])


def get_opening(openings, opening_id):
    index = find_index(openings, opening_id=opening_id)
    if index == -1:
        return -1, None
    return index, openings[index]


def split_tag_values(value):
    return [tag.strip() for tag in re.split(r"[;,]", str(value or "")) if tag.strip()]


def merge_tag_values(*values):
    merged = []
    seen = set()
    for value in values:
        for tag in split_tag_values(value):
            key = tag.lower()
            if key in seen:
                continue
            seen.add(key)
            merged.append(tag)
    return ",".join(merged)


def utc_now_iso():
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def text_field(source, key, limit=4000):
    value = source.get(key)
    if value is None:
        return ""
    return str(value).strip()[:limit]


def load_suggestions():
    return load_dataset("suggestions")


def save_suggestions(rows):
    save_dataset("suggestions", rows)


def normalize_suggestion(payload, request_meta=None):
    request_meta = request_meta or {}
    now = utc_now_iso()
    suggestion = {
        "id": text_field(payload, "id", 80) or uuid4().hex,
        "status": "pending",
        "created_at": text_field(payload, "created_at", 40) or now,
        "updated_at": now,
        "opening_id": text_field(payload, "opening_id", 160),
        "opening_name": text_field(payload, "opening_name", 240),
        "source_line_id": text_field(payload, "source_line_id", 160),
        "source_line_name": text_field(payload, "source_line_name", 240),
        "line_name": text_field(payload, "line_name", 240),
        "line_id": text_field(payload, "line_id", 160),
        "drill_side": text_field(payload, "drill_side", 16),
        "start_fen": text_field(payload, "start_fen", 240),
        "current_fen": text_field(payload, "current_fen", 240),
        "moves_text": text_field(payload, "moves_text", 8000),
        "notation": text_field(payload, "notation", 24) or "auto",
        "comment": text_field(payload, "comment", 4000),
        "contact": text_field(payload, "contact", 240),
        "source_url": text_field(payload, "source_url", 800) or request_meta.get("source_url", ""),
        "user_agent": text_field(payload, "user_agent", 400) or request_meta.get("user_agent", ""),
    }
    if suggestion["drill_side"] not in ("white", "black"):
        suggestion["drill_side"] = ""
    if suggestion["notation"] not in ("auto", "uci", "san"):
        suggestion["notation"] = "auto"
    if not suggestion["moves_text"] and not suggestion["comment"]:
        raise ValueError("Suggestion needs moves or a comment.")
    return suggestion


def create_suggestion(payload, request_meta=None):
    suggestion = normalize_suggestion(payload, request_meta)
    with DATA_LOCK:
        suggestions = load_suggestions()
        existing_ids = {row.get("id", "") for row in suggestions}
        while suggestion["id"] in existing_ids:
            suggestion["id"] = uuid4().hex
        suggestions.append(suggestion)
        save_suggestions(suggestions)
    return suggestion


def suggestion_sort_timestamp(row):
    try:
        raw = (row.get("created_at") or "1970-01-01T00:00:00Z").replace("Z", "+00:00")
        return datetime.fromisoformat(raw).timestamp()
    except (TypeError, ValueError):
        return 0


def list_suggestions():
    suggestions = load_suggestions()
    status_order = {"pending": 0, "done": 1, "archived": 2}
    return sorted(
        suggestions,
        key=lambda row: (
            status_order.get(row.get("status", "pending"), 0),
            -suggestion_sort_timestamp(row),
        ),
    )


def update_suggestion(suggestion_id, fields):
    suggestion_id = (suggestion_id or "").strip()
    if not suggestion_id:
        raise ValueError("Suggestion id is required.")
    allowed = {"status", "admin_note"}
    with DATA_LOCK:
        suggestions = load_suggestions()
        index = find_index(suggestions, id=suggestion_id)
        if index == -1:
            raise ValueError(f"Suggestion not found: {suggestion_id}")
        for key, value in fields.items():
            if key not in allowed:
                continue
            if key == "status":
                status = str(value or "").strip().lower()
                if status not in SUGGESTION_STATUSES:
                    raise ValueError(f"Unknown suggestion status: {status}")
                suggestions[index]["status"] = status
            else:
                suggestions[index][key] = "" if value is None else str(value)[:4000]
        suggestions[index]["updated_at"] = utc_now_iso()
        save_suggestions(suggestions)
        return suggestions[index]


def delete_suggestion(suggestion_id):
    suggestion_id = (suggestion_id or "").strip()
    if not suggestion_id:
        raise ValueError("Suggestion id is required.")
    with DATA_LOCK:
        suggestions = load_suggestions()
        index = find_index(suggestions, id=suggestion_id)
        if index == -1:
            raise ValueError(f"Suggestion not found: {suggestion_id}")
        del suggestions[index]
        save_suggestions(suggestions)
    return {"id": suggestion_id}


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
            "drill_side": drill_side,
            "start_fen": start_fen,
            "tags": (line_in.get("tags") or "").strip(),
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
    allowed = {"line_name", "line_group", "drill_side", "start_fen", "tags", "moves_pgn", "thumb_ply"}
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


def move_line_to_opening(line_id, target_opening_id, source_opening_id=None):
    target_opening_id = (target_opening_id or "").strip()
    source_opening_id = (source_opening_id or "").strip()
    if not target_opening_id:
        raise ValueError("target_opening_id is required.")

    with DATA_LOCK:
        openings = load_dataset("openings")
        lines = load_dataset("lines")
        nodes = load_dataset("nodes")

        _, target = get_opening(openings, target_opening_id)
        if target is None:
            raise ValueError(f"Target opening not found: {target_opening_id}")

        matches = [
            (index, line)
            for index, line in enumerate(lines)
            if (line.get("line_id") or "") == line_id
            and (not source_opening_id or (line.get("opening_id") or "") == source_opening_id)
        ]
        if not matches:
            source_note = f" in opening {source_opening_id}" if source_opening_id else ""
            raise ValueError(f"Line not found{source_note}: {line_id}")
        if len(matches) > 1:
            raise ValueError(f"Line ID is not unique; choose a source opening before moving: {line_id}")

        _, line = matches[0]
        source_opening_id = line.get("opening_id", "") or source_opening_id
        if source_opening_id == target_opening_id:
            raise ValueError("Line is already in the target opening.")

        line["opening_id"] = target_opening_id
        nodes_moved = 0
        for node in nodes:
            if (node.get("line_id") or "") == line_id and (
                not source_opening_id or (node.get("opening_id") or "") == source_opening_id
            ):
                node["opening_id"] = target_opening_id
                nodes_moved += 1

        rebuild_result = refresh_node_fens(openings, lines, nodes)
        save_dataset("lines", lines, LINE_HEADERS)
        save_dataset("nodes", nodes, NODE_HEADERS)

    return {
        "line_id": line_id,
        "source_opening_id": source_opening_id,
        "target_opening_id": target_opening_id,
        "nodes_moved": nodes_moved,
        "fen_warnings": fen_warnings(rebuild_result),
    }


def merge_openings(source_opening_id, target_opening_id, merge_metadata=True):
    source_opening_id = (source_opening_id or "").strip()
    target_opening_id = (target_opening_id or "").strip()
    if not source_opening_id:
        raise ValueError("source opening is required.")
    if not target_opening_id:
        raise ValueError("target_opening_id is required.")
    if source_opening_id == target_opening_id:
        raise ValueError("Source and target openings must be different.")

    with DATA_LOCK:
        openings = load_dataset("openings")
        lines = load_dataset("lines")
        nodes = load_dataset("nodes")

        source_index, source = get_opening(openings, source_opening_id)
        if source is None:
            raise ValueError(f"Source opening not found: {source_opening_id}")
        _, target = get_opening(openings, target_opening_id)
        if target is None:
            raise ValueError(f"Target opening not found: {target_opening_id}")

        source_line_ids = {
            line.get("line_id", "")
            for line in lines
            if (line.get("opening_id") or "") == source_opening_id and line.get("line_id")
        }
        target_line_ids = {
            line.get("line_id", "")
            for line in lines
            if (line.get("opening_id") or "") == target_opening_id and line.get("line_id")
        }
        conflicts = sorted(source_line_ids & target_line_ids)
        if conflicts:
            preview = ", ".join(conflicts[:5])
            suffix = f" (+{len(conflicts) - 5} more)" if len(conflicts) > 5 else ""
            raise ValueError(f"Cannot merge openings with duplicate line_id values: {preview}{suffix}")

        if merge_metadata:
            target["tags"] = merge_tag_values(target.get("tags"), source.get("tags"))
            for field in ("description", "side", "starting_fen", "published", "book_max_plies_game_mode", "allow_transpositions"):
                if not target.get(field) and source.get(field):
                    target[field] = source.get(field)

        lines_moved = 0
        for line in lines:
            if (line.get("opening_id") or "") == source_opening_id:
                line["opening_id"] = target_opening_id
                lines_moved += 1

        nodes_moved = 0
        for node in nodes:
            if (node.get("opening_id") or "") == source_opening_id or (node.get("line_id") or "") in source_line_ids:
                node["opening_id"] = target_opening_id
                nodes_moved += 1

        del openings[source_index]
        rebuild_result = refresh_node_fens(openings, lines, nodes)
        save_dataset("openings", openings, OPENING_HEADERS)
        save_dataset("lines", lines, LINE_HEADERS)
        save_dataset("nodes", nodes, NODE_HEADERS)

    return {
        "source_opening_id": source_opening_id,
        "target_opening_id": target_opening_id,
        "lines_moved": lines_moved,
        "nodes_moved": nodes_moved,
        "fen_warnings": fen_warnings(rebuild_result),
    }


def rebuild_all_fens():
    with DATA_LOCK:
        openings = load_dataset("openings")
        lines = load_dataset("lines")
        nodes = load_dataset("nodes")
        result = refresh_node_fens(openings, lines, nodes)
        save_dataset("nodes", nodes, NODE_HEADERS)
        return {**result, "fen_warnings": fen_warnings(result)}


def regenerate_thumbnail(line_id, thumb_ply_override=None, fen=None, flip=None):
    with DATA_LOCK:
        lines = load_dataset("lines")
    index = find_index(lines, line_id=line_id)
    if index == -1:
        raise ValueError(f"Line not found: {line_id}")
    line = lines[index]
    thumb_ply = thumb_ply_override if thumb_ply_override is not None else line.get("thumb_ply")
    out_path = render_thumbnail(
        line_id,
        line.get("start_fen", ""),
        line.get("moves_pgn", ""),
        line.get("drill_side", "white"),
        thumb_ply,
        flip=flip,
        fen=fen,
    )
    return {"line_id": line_id, "thumbnail": str(out_path.relative_to(ROOT)).replace("\\", "/"), "thumb_ply": str(thumb_ply or "")}


def regenerate_opening_thumbnail(opening_id, line_id=None, thumb_ply_override=None, fen=None, flip=None):
    with DATA_LOCK:
        openings = load_dataset("openings")
        lines = load_dataset("lines")
    opening_index = find_index(openings, opening_id=opening_id)
    if opening_index == -1:
        raise ValueError(f"Opening not found: {opening_id}")
    opening = openings[opening_index]

    if fen and str(fen).strip():
        out_path = render_thumbnail(opening_id, "", "", opening.get("side", "white"), None, flip=flip, fen=fen)
        return {
            "opening_id": opening_id,
            "line_id": "",
            "thumbnail": str(out_path.relative_to(ROOT)).replace("\\", "/"),
            "thumb_ply": "",
        }

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
            flip=flip,
        )
        return {
            "opening_id": opening_id,
            "line_id": selected_line.get("line_id", ""),
            "thumbnail": str(out_path.relative_to(ROOT)).replace("\\", "/"),
            "thumb_ply": str(thumb_ply or ""),
        }

    out_path = render_thumbnail(opening_id, opening.get("starting_fen", ""), "", opening.get("side", "white"), None, flip=flip)
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

    def end_headers(self):
        if urlparse(self.path).path.startswith("/Thumbnails/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

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
        if path == "/admin/api/suggestions":
            try:
                self._send_json(200, {"ok": True, "suggestions": list_suggestions()})
            except Exception as exc:
                self._send_json(500, {"error": str(exc)})
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
            if path == "/admin/api/suggestions" and method == "POST":
                payload = self._read_json()
                request_meta = {
                    "source_url": self.headers.get("Referer", ""),
                    "user_agent": self.headers.get("User-Agent", ""),
                }
                self._send_json(200, {"ok": True, "suggestion": create_suggestion(payload, request_meta)})
                return
            match = re.match(r"^/admin/api/suggestions/([^/]+)$", path)
            if match and method == "PATCH":
                payload = self._read_json()
                self._send_json(200, {"ok": True, "suggestion": update_suggestion(match.group(1), payload)})
                return
            if match and method == "DELETE":
                self._send_json(200, {"ok": True, "result": delete_suggestion(match.group(1))})
                return
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
            match = re.match(r"^/admin/api/line/([^/]+)/move$", path)
            if match and method == "POST":
                payload = self._read_json()
                if not isinstance(payload, dict):
                    payload = {}
                result = move_line_to_opening(
                    match.group(1),
                    payload.get("target_opening_id", ""),
                    payload.get("source_opening_id", ""),
                )
                self._send_json(200, {"ok": True, "result": result, "fen_warnings": result.get("fen_warnings", [])})
                return
            match = re.match(r"^/admin/api/opening/([^/]+)$", path)
            if match and method == "PATCH":
                payload = self._read_json()
                opening, warnings = update_opening(match.group(1), payload)
                self._send_json(200, {"ok": True, "opening": opening, "fen_warnings": warnings})
                return
            match = re.match(r"^/admin/api/opening/([^/]+)/merge$", path)
            if match and method == "POST":
                payload = self._read_json()
                if not isinstance(payload, dict):
                    payload = {}
                result = merge_openings(
                    match.group(1),
                    payload.get("target_opening_id", ""),
                    payload.get("merge_metadata", True) is not False,
                )
                self._send_json(200, {"ok": True, "result": result, "fen_warnings": result.get("fen_warnings", [])})
                return
            match = re.match(r"^/admin/api/thumbnail/([^/]+)$", path)
            if match and method == "POST":
                payload = self._read_json()
                if not isinstance(payload, dict):
                    payload = {}
                override = payload.get("thumb_ply")
                fen = payload.get("fen")
                flip = optional_bool(payload.get("flip"))
                self._send_json(200, {"ok": True, "result": regenerate_thumbnail(match.group(1), override, fen, flip)})
                return
            match = re.match(r"^/admin/api/opening-thumbnail/([^/]+)$", path)
            if match and method == "POST":
                payload = self._read_json()
                if not isinstance(payload, dict):
                    payload = {}
                override = payload.get("thumb_ply")
                line_id = payload.get("line_id")
                fen = payload.get("fen")
                flip = optional_bool(payload.get("flip"))
                self._send_json(200, {"ok": True, "result": regenerate_opening_thumbnail(match.group(1), line_id, override, fen, flip)})
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

    def do_DELETE(self):
        self._route_write("DELETE")


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
