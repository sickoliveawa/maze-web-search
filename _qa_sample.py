import json

with open('paper/data/_grids.json', 'r') as f:
    grids = json.load(f)

W, H = grids['W'], grids['H']

def print_grid(name, data):
    print(f"\n=== {name} ===")
    for y in range(H):
        row = ''
        for x in range(W):
            row += '#' if data[y*W + x] else '.'
        print(row)

# Sample 5: 1 TRUE + 4 PSEUDO
samples = [
    ('true', 'Recursive Backtrack (DFS)'),
    ('pseudo', 'Horizontal Stripes'),
    ('pseudo', 'Spiral'),
    ('pseudo', 'Honeycomb'),
    ('pseudo', 'Concentric Rings'),
]

for section, name in samples:
    print_grid(name, grids[section][name])
