"""
Fix two issues in lines.json:
1. Generic "Line N" names → auto-generate from opening + divergence move
2. Duplicate names between _cr_ and _crm_ lines → append " · Mastery" to crm versions
"""
import json, re, chess, chess.pgn, io, shutil
from pathlib import Path
from collections import defaultdict

DATA = Path('C:/Users/Admin/ChessGym/data')
LINES_FILE = DATA / 'lines.json'

lines = json.load(open(LINES_FILE))

# ── Helpers ────────────────────────────────────────────────────────────────

def parse_moves(moves_pgn):
    """Return list of chess.Move from a moves_pgn string."""
    try:
        game = chess.pgn.read_game(io.StringIO(moves_pgn))
        return list(game.mainline_moves()) if game else []
    except:
        return []

def san_sequence(moves_pgn):
    """Return list of SAN strings."""
    try:
        game = chess.pgn.read_game(io.StringIO(moves_pgn))
        board = game.board()
        sans = []
        for m in game.mainline_moves():
            sans.append(board.san(m))
            board.push(m)
        return sans
    except:
        return []

def divergence_name(line, all_lines_same_opening):
    """
    Find the move where this line diverges from its siblings and
    build a descriptive name: e.g. 'Nf3 d5 line' or '...Bg4 variation'
    """
    my_pgn = line.get('moves_pgn', '')
    my_sans = san_sequence(my_pgn)
    if not my_sans:
        return None

    # Find sibling lines (same opening, not this line, not generic-named)
    siblings = [
        l for l in all_lines_same_opening
        if l['line_id'] != line['line_id']
        and not re.match(r'^Line \d+$', l.get('line_name', '').strip())
    ]

    if not siblings:
        # No named siblings — use last 2 moves as name
        tail = my_sans[-2:] if len(my_sans) >= 2 else my_sans
        return ' '.join(tail) + ' line'

    # Find the ply where this line first differs from ANY sibling
    diverge_ply = len(my_sans)  # default: no divergence found
    for sib in siblings:
        sib_sans = san_sequence(sib.get('moves_pgn', ''))
        for i, (m, s) in enumerate(zip(my_sans, sib_sans)):
            if m != s:
                diverge_ply = min(diverge_ply, i)
                break

    # Use the move AT divergence point (the key branching move)
    if diverge_ply < len(my_sans):
        key_move = my_sans[diverge_ply]
        # Add context: the move before too if available
        if diverge_ply > 0:
            prev_move = my_sans[diverge_ply - 1]
            return f'{prev_move} {key_move} line'
        return f'{key_move} line'

    # Fallback: last move
    return my_sans[-1] + ' line'

def opening_short(opening_id):
    """Shorten opening_id to human prefix."""
    mapping = {
        'croissant_road_2000': 'Croissant',
        'scotch_game': 'Scotch',
        'london_system': 'London',
        'sicilian_defense': 'Sicilian',
        'albin_countergambit': 'Albin',
        'danish_gambit': 'Danish',
        'italian_game': 'Italian',
        'queens_gambit_declined': 'QGD',
        'scandinavian_defense': 'Scandinavian',
        'queen_s_gambit_accepted': 'QGA',
        'vienna_game': 'Vienna',
    }
    return mapping.get(opening_id, opening_id.replace('_', ' ').title())

# ── Group lines by opening ─────────────────────────────────────────────────
by_opening = defaultdict(list)
for l in lines:
    by_opening[l['opening_id']].append(l)

# ── Fix 1: Generic "Line N" names ─────────────────────────────────────────
fixed_names = 0
used_names = {l['line_name'].strip() for l in lines if not re.match(r'^Line \d+$', l.get('line_name','').strip())}

for line in lines:
    name = line.get('line_name', '').strip()
    if not name or re.match(r'^Line \d+$', name):
        siblings = by_opening[line['opening_id']]
        prefix = opening_short(line['opening_id'])
        div = divergence_name(line, siblings)
        if div:
            candidate = f'{prefix}: {div}'
        else:
            candidate = f'{prefix} variation'

        # Ensure uniqueness — append suffix if needed
        base = candidate
        suffix = 2
        while candidate in used_names:
            candidate = f'{base} ({suffix})'
            suffix += 1

        print(f'  RENAME [{line["line_id"]}]: "{name}" → "{candidate}"')
        line['line_name'] = candidate
        used_names.add(candidate)
        fixed_names += 1

print(f'\nFixed {fixed_names} generic names')

# ── Fix 2: Duplicate names on _crm_ lines ─────────────────────────────────
# Build name → line_id map for _cr_ (base) lines
cr_name_to_id = {}
for l in lines:
    lid = l.get('line_id', '')
    if '_cr_' in lid and '_crm_' not in lid:
        cr_name_to_id[l['line_name'].strip()] = lid

fixed_dups = 0
for line in lines:
    lid = line.get('line_id', '')
    if '_crm_' not in lid:
        continue
    name = line['line_name'].strip()
    if name in cr_name_to_id:
        new_name = name + ' · Mastery'
        # ensure uniqueness
        base = new_name
        suffix = 2
        while new_name in used_names:
            new_name = f'{base} ({suffix})'
            suffix += 1
        print(f'  DEDUP [{lid}]: "{name}" → "{new_name}"')
        line['line_name'] = new_name
        used_names.add(new_name)
        fixed_dups += 1

print(f'Fixed {fixed_dups} duplicate names\n')

# ── Save ──────────────────────────────────────────────────────────────────
shutil.copy(LINES_FILE, str(LINES_FILE) + '.bak')
json.dump(lines, open(LINES_FILE, 'w'), indent=2)
print(f'Saved {LINES_FILE}')
print(f'Total fixes: {fixed_names + fixed_dups}')
