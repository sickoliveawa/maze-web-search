import json

with open('paper/data/_grids.json', 'r') as f:
    grids = json.load(f)

with open('C:/Users/sicko/_qa_ grids.txt', 'w') as f:
    f.write(f"W={grids['W']} H={grids['H']}\n")
    f.write(f"TRUE: {list(grids['true'].keys())}\n")
    f.write(f"PSEUDO: {list(grids['pseudo'].keys())}\n")
    for name, data in grids['true'].items():
        f.write(f"TRUE {name}: len={len(data)}, sum={sum(data)}\n")
    for name, data in grids['pseudo'].items():
        f.write(f"PSEUDO {name}: len={len(data)}, sum={sum(data)}\n")

print("done")
