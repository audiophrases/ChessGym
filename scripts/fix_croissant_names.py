"""
Smart Croissant line renamer.
Groups lines by Black's opening setup, then names each by its unique divergence move.
"""
import json, chess, chess.pgn, io, re, shutil
from pathlib import Path
from collections import defaultdict

DATA = Path('C:/Users/Admin/ChessGym/data')
LINES_FILE = DATA / 'lines.json'
lines = json.load(open(LINES_FILE))

def san_list(moves_pgn):
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

def move_with_number(sans, ply):
    """Return e.g. '7...Nbd7' or '7. e4' for the move at ply index."""
    move_num = ply // 2 + 1
    if ply % 2 == 0:
        return f'{move_num}. {sans[ply]}'
    else:
        return f'{move_num}...{sans[ply]}'

# ── Group sub-families by first-move divergence ────────────────────────────
# The groups are already encoded in the line_id suffix: _cr_01, _cr_02, etc.
# Extract the group number from the line_id.
def group_key(line_id):
    m = re.search(r'_cr_(\d+)$', line_id)
    return int(m.group(1)) if m else 0

# Black's setup descriptions by group (based on inspection above)
GROUP_DESC = {
    1:  'vs ...d5 e6',
    2:  'vs ...g6 Modern',
    3:  'vs ...Nf6 g6 KID',
    4:  'vs ...c5 Sicilian',
    5:  'vs ...e6 d5',
    6:  'vs ...Nc6 e5',
    7:  'vs ...d6 e5',
    8:  'vs ...c6 d5',
    9:  'vs ...g6 e5',
    10: 'vs d4 g6',
}

# ── Build san lists for all croissant lines ────────────────────────────────
croissant = [l for l in lines if l['opening_id'] == 'croissant_road_2000']
for l in croissant:
    l['_sans'] = san_list(l.get('moves_pgn', ''))
    l['_group'] = group_key(l['line_id'])

# Group them
by_group = defaultdict(list)
for l in croissant:
    by_group[l['_group']].append(l)

# ── For each line, find the ply where it UNIQUELY diverges from ALL siblings ──
def find_unique_divergence(target, siblings):
    """
    Find the earliest ply where target differs from at least one sibling,
    then verify no other sibling shares that same prefix+move.
    Returns (ply, san) of the most discriminating move.
    """
    target_sans = target['_sans']
    sib_sans = [s['_sans'] for s in siblings if s['line_id'] != target['line_id']]

    if not sib_sans:
        # Only line in group
        return len(target_sans) - 1, target_sans[-1] if target_sans else (0, '?')

    # Find each divergence point vs each sibling
    div_plies = []
    for ss in sib_sans:
        for i, (a, b) in enumerate(zip(target_sans, ss)):
            if a != b:
                div_plies.append(i)
                break
        else:
            div_plies.append(len(min(target_sans, ss, key=len)))

    if not div_plies:
        return len(target_sans) - 1, target_sans[-1] if target_sans else (0, '?')

    # The unique discriminating ply = last divergence (deepest common point)
    # We want the move that sets THIS line apart from the most similar sibling
    ply = max(div_plies)  # deepest divergence = most specific discriminator
    if ply >= len(target_sans):
        ply = len(target_sans) - 1
    return ply, target_sans[ply]

# ── Rename ─────────────────────────────────────────────────────────────────
used_names = {l['line_name'] for l in lines if l['opening_id'] != 'croissant_road_2000'}
# Also track names already assigned in this pass
new_names_assigned = {}

changes = []
for group_num, group_lines in sorted(by_group.items()):
    desc = GROUP_DESC.get(group_num, f'group {group_num}')
    print(f'\n=== Group {group_num}: {desc} ({len(group_lines)} lines) ===')

    for l in group_lines:
        ply, key_san = find_unique_divergence(l, group_lines)
        move_label = move_with_number(l['_sans'], ply)
        candidate = f'Croissant {desc}: {key_san}'

        # Ensure uniqueness
        base = candidate
        suffix = 2
        while candidate in used_names or candidate in new_names_assigned:
            candidate = f'{base} ({suffix})'
            suffix += 1

        print(f'  {l["line_id"]:40s} | {l["line_name"]:45s} → {candidate}')
        new_names_assigned[candidate] = l['line_id']
        changes.append((l['line_id'], candidate))

# ── Apply changes ──────────────────────────────────────────────────────────
print(f'\n\nApplying {len(changes)} renames...')
lid_to_name = dict(changes)
for l in lines:
    if l['line_id'] in lid_to_name:
        l['line_name'] = lid_to_name[l['line_id']]
    # Clean up temp keys
    l.pop('_sans', None)
    l.pop('_group', None)

shutil.copy(LINES_FILE, str(LINES_FILE) + '.bak2')
json.dump(lines, open(LINES_FILE, 'w'), indent=2)
print(f'Saved. {len(changes)} Croissant lines renamed.')
