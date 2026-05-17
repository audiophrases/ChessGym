import json

with open(r"C:/Users/Admin/ChessGym/data/openings.json") as f:
    openings = json.load(f)
with open(r"C:/Users/Admin/ChessGym/data/lines.json") as f:
    lines = json.load(f)
with open(r"C:/Users/Admin/ChessGym/data/nodes.json") as f:
    nodes = json.load(f)

print(f"openings: {len(openings)}")
print(f"lines: {len(lines)}")
print(f"nodes: {len(nodes)}")

print("\n--- Openings (id, side) ---")
for o in openings:
    oid = o["opening_id"]
    side = o["side"]
    print(f"  {oid:45s} side={side}")

print("\n--- Lines fields:", list(lines[0].keys()))
print("--- Nodes fields:", list(nodes[0].keys()))

sides = {}
for l in lines:
    s = l.get("drill_side", "")
    sides[s] = sides.get(s, 0) + 1
print("\n--- drill_side values:", sides)

groups = {}
for l in lines:
    g = l.get("line_group", "")
    groups[g] = groups.get(g, 0) + 1
print("\n--- line_groups:", sorted(groups.keys()))

# Sample a few lines to see full structure
print("\n--- Sample line ---")
print(json.dumps(lines[0], indent=2))

# Show nodes learn_prompt examples
print("\n--- Sample nodes with learn_prompt ---")
for n in nodes:
    if n.get("learn_prompt"):
        print(f"  [{n['line_id']}] move={n['move_uci']} prompt={n['learn_prompt'][:100]}")
        break
