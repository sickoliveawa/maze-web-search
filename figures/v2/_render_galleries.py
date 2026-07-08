"""
Generate 6 true mazes + 9 pseudo mazes as PNG.
Same Python implementations as browser _gen_grids.mjs + my fixed _generateSpiral.
"""
import os, json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.colors import LinearSegmentedColormap

OUT = r'E:/doro/maze-web/figures/v2'
os.makedirs(OUT, exist_ok=True)

# Warm paper palette
PAPER = '#f4ead8'  # warm paper background
INK = '#2c1f17'    # dark ink
CINNABAR = '#b8412f'

plt.rcParams.update({
    'font.family': 'serif', 'font.serif': ['Times New Roman', 'DejaVu Serif'],
    'font.size': 8, 'axes.facecolor': PAPER, 'figure.facecolor': PAPER,
    'savefig.facecolor': PAPER, 'pdf.fonttype': 42, 'ps.fonttype': 42,
    'axes.edgecolor': INK, 'text.color': INK,
})

W = H = 31

def rng_lcg(seed):
    s = [seed]
    def f():
        s[0] = (s[0] * 1103515245 + 12345) & 0x7fffffff
        return s[0] / 0x7fffffff
    return f

def make_dfs(W, H, seed=42):
    if W % 2 == 0: W += 1
    if H % 2 == 0: H += 1
    grid = np.ones((H, W), dtype=np.uint8)
    visited = np.zeros((H, W), dtype=np.uint8)
    rand = rng_lcg(seed)
    def carve(x, y):
        visited[y, x] = 1; grid[y, x] = 0
        dirs = [(0,-2),(2,0),(0,2),(-2,0)]
        # shuffle
        for i in range(len(dirs)-1, 0, -1):
            j = int(rand() * (i+1))
            dirs[i], dirs[j] = dirs[j], dirs[i]
        for dx, dy in dirs:
            nx, ny = x+dx, y+dy
            if nx <= 0 or nx >= W-1 or ny <= 0 or ny >= H-1: continue
            if visited[ny, nx]: continue
            grid[(y+ny)//2, (x+nx)//2] = 0
            carve(nx, ny)
    carve(1, 1)
    bellot = 1 - grid  # corridor=1, wall=0
    return bellot

def make_prim(W, H, seed=42):
    cellW, cellH = W//2, H//2
    g = np.ones((H, W), dtype=np.uint8)
    rand = rng_lcg(seed)
    v = np.zeros((cellH, cellW), dtype=np.uint8)
    g[1, 1] = 0; v[0, 0] = 1
    walls = [[0, 0, 1, 0], [0, 0, 0, 1]]
    while walls:
        idx = int(rand() * len(walls))
        cx, cy, dx, dy = walls.pop(idx)
        if v[cy+dy, cx+dx]: continue
        g[(2*cy+1+dy), (2*cx+1+dx)] = 0
        g[(2*(cy+dy)+1), (2*(cx+dx)+1)] = 0
        v[cy+dy, cx+dx] = 1
        for ddx, ddy in [(1,0),(-1,0),(0,1),(0,-1)]:
            ncx, ncy = cx+dx+ddx, cy+dy+ddy
            if 0 <= ncx < cellW and 0 <= ncy < cellH and not v[ncy, ncx]:
                walls.append([cx+dx, cy+dy, ddx, ddy])
    return 1 - g

def make_kruskal(W, H, seed=42):
    cellW, cellH = W//2, H//2
    g = np.ones((H, W), dtype=np.uint8)
    rand = rng_lcg(seed)
    parent = np.arange(cellW * cellH)
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    edges = []
    for cy in range(cellH):
        for cx in range(cellW):
            if cx < cellW - 1: edges.append((cx, cy, 1, 0))
            if cy < cellH - 1: edges.append((cx, cy, 0, 1))
    # shuffle
    for i in range(len(edges)-1, 0, -1):
        j = int(rand() * (i+1))
        edges[i], edges[j] = edges[j], edges[i]
    for cx, cy, dx, dy in edges:
        a = find(cy * cellW + cx)
        b = find((cy+dy) * cellW + (cx+dx))
        if a == b: continue
        parent[a] = b
        g[2*cy+1, 2*cx+1] = 0
        g[2*(cy+dy)+1, 2*(cx+dx)+1] = 0
        g[2*cy+1+dy, 2*cx+1+dx] = 0
    return 1 - g

def make_binary_tree(W, H, seed=42):
    cellW, cellH = W//2, H//2
    g = np.ones((H, W), dtype=np.uint8)
    rand = rng_lcg(seed)
    for cy in range(cellH):
        for cx in range(cellW):
            g[2*cy+1, 2*cx+1] = 0
            if cy > 0 and (cx == cellW-1 or rand() < 0.5):
                g[2*cy, 2*cx+1] = 0
            elif cx < cellW - 1:
                g[2*cy+1, 2*cx+2] = 0
    return 1 - g

def make_sidewinder(W, H, seed=42):
    cellW, cellH = W//2, H//2
    g = np.ones((H, W), dtype=np.uint8)
    rand = rng_lcg(seed)
    for cy in range(cellH):
        run_start = 0
        for cx in range(cellW):
            g[2*cy+1, 2*cx+1] = 0
            close = cx == cellW-1 or (cy > 0 and rand() < 0.5)
            if close:
                if cy > 0:
                    x = run_start + int(rand() * (cx - run_start + 1))
                    g[2*cy, 2*x+1] = 0
                run_start = cx + 1
            else:
                g[2*cy+1, 2*cx+2] = 0
    return 1 - g

def make_growing_tree(W, H, seed=42):
    cellW, cellH = W//2, H//2
    g = np.ones((H, W), dtype=np.uint8)
    rand = rng_lcg(seed)
    v = np.zeros((cellH, cellW), dtype=np.uint8)
    sx = int(rand() * cellW); sy = int(rand() * cellH)
    v[sy, sx] = 1; g[2*sy+1, 2*sx+1] = 0
    active = [(sx, sy)]
    while active:
        i = int(rand() * len(active))
        cx, cy = active[i]
        cands = []
        for dx, dy in [(1,0),(-1,0),(0,1),(0,-1)]:
            nx, ny = cx+dx, cy+dy
            if 0 <= nx < cellW and 0 <= ny < cellH and not v[ny, nx]:
                cands.append((nx, ny, dx, dy))
        if not cands:
            active.pop(i); continue
        nx, ny, dx, dy = cands[int(rand() * len(cands))]
        v[ny, nx] = 1
        g[2*ny+1, 2*nx+1] = 0
        g[2*cy+1+dy, 2*cx+1+dx] = 0
        active.append((nx, ny))
    return 1 - g

def make_spiral(W, H):
    """FIXED: concentric spiral with single path inward (corridor=0, wall=1)."""
    g = np.ones((H, W), dtype=np.uint8)
    # outer border stays wall
    layer = 0
    while layer * 2 + 4 < W and layer * 2 + 4 < H:
        x1, y1 = layer+1, layer+1
        x2, y2 = W-2-layer, H-2-layer
        # top row
        for x in range(x1, x2+1): g[y1, x] = 0
        # right col
        for y in range(y1+1, y2+1): g[y, x2] = 0
        # bottom row
        for x in range(x2-1, x1-1, -1): g[y2, x] = 0
        # left col
        for y in range(y2-1, y1, -1): g[y, x1] = 0
        layer += 2
    g[1, 1] = 0  # entrance
    return g

def make_fractal_tree(W, H, depth=4):
    g = np.zeros((H, W), dtype=np.uint8)
    cx, cy = W//2, H//2
    rand = rng_lcg(12345)
    def draw(x, y, ang, length, d):
        if d <= 0 or length < 1: return
        ex = int(round(x + np.cos(ang) * length))
        ey = int(round(y + np.sin(ang) * length))
        for t in np.linspace(0, 1, max(2, int(length/0.5))):
            px = int(round(x + (ex-x)*t)); py = int(round(y + (ey-y)*t))
            if 0 <= px < W and 0 <= py < H: g[py, px] = 1
        draw(ex, ey, ang - (0.3 + rand()*0.4), length*(0.6 + rand()*0.2), d-1)
        draw(ex, ey, ang + (0.3 + rand()*0.4), length*(0.6 + rand()*0.2), d-1)
    draw(cx, cy, -np.pi/2, H*0.4, depth)
    return g

def make_noise(W, H, density=0.5, seed=42):
    rand = rng_lcg(seed)
    g = np.zeros((H, W), dtype=np.uint8)
    for i in range(H*W): g.flat[i] = 1 if rand() < density else 0
    return g

def make_stripes_h(W, H):
    g = np.zeros((H, W), dtype=np.uint8)
    g[::3, :] = 1
    return g

def make_checkerboard(W, H):
    g = np.zeros((H, W), dtype=np.uint8)
    for y in range(H):
        for x in range(W): g[y, x] = (x+y) % 2
    return g

def make_diagonal(W, H):
    g = np.zeros((H, W), dtype=np.uint8)
    for y in range(H):
        for x in range(W): g[y, x] = 1 if (x+y) % 3 == 0 else 0
    return g

def make_concentric(W, H):
    g = np.zeros((H, W), dtype=np.uint8)
    for y in range(H):
        for x in range(W):
            d = min(x, y, W-1-x, H-1-y)
            g[y, x] = 1 if (d % 4 < 2) else 0
    return g

def make_honeycomb(W, H):
    g = np.ones((H, W), dtype=np.uint8)
    for y in range(H):
        for x in range(W):
            if x % 3 == 0 or y % 3 == 0: g[y, x] = 0
    return g

# Build all 15 patterns
true_mazes = {
    'Recursive Backtrack (DFS)': make_dfs(W, H, 42),
    "Kruskal's": make_kruskal(W, H, 42),
    "Prim's": make_prim(W, H, 42),
    'Growing Tree': make_growing_tree(W, H, 42),
    'Sidewinder': make_sidewinder(W, H, 42),
    'Binary Tree': make_binary_tree(W, H, 42),
}
pseudo_mazes = {
    'Spiral': make_spiral(W, H),
    'Fractal Tree': make_fractal_tree(W, H),
    'Horizontal Stripes': make_stripes_h(W, H),
    'Random Noise 50%': make_noise(W, H, 0.5),
    'Random Noise 30%': make_noise(W, H, 0.30),
    'Checkerboard': make_checkerboard(W, H),
    'Diagonal Stripes': make_diagonal(W, H),
    'Concentric Rings': make_concentric(W, H),
    'Honeycomb': make_honeycomb(W, H),
}

# ============ Render TRUE maze gallery (6) ============
fig, axes = plt.subplots(2, 3, figsize=(7.5, 5.0))
for ax, (name, grid) in zip(axes.flat, true_mazes.items()):
    ax.imshow(grid, cmap='Greys', interpolation='nearest', vmin=0, vmax=1)
    ax.set_title(name, fontsize=8, pad=4, color=INK)
    ax.set_xticks([]); ax.set_yticks([])
    for spine in ax.spines.values(): spine.set_edgecolor(INK); spine.set_linewidth(0.6)
fig.suptitle('True Mazes (six classical generators, 31×31, corridor = light, wall = dark)',
             fontsize=9, y=0.98, color=INK)
fig.text(0.5, 0.005, 'Recursive backtracker / Kruskal / Prim / Growing tree / Sidewinder / Binary tree',
         ha='center', fontsize=6, style='italic', color='#6a5a48')
plt.tight_layout(rect=[0, 0.02, 1, 0.95])
plt.savefig(f'{OUT}/fig_true_mazes.png', dpi=200, bbox_inches='tight')
plt.savefig(f'{OUT}/fig_true_mazes.pdf', bbox_inches='tight')
plt.close()
print('saved fig_true_mazes')

# ============ Render PSEUDO maze gallery (9) ============
fig, axes = plt.subplots(3, 3, figsize=(7.5, 7.5))
for ax, (name, grid) in zip(axes.flat, pseudo_mazes.items()):
    ax.imshow(grid, cmap='Greys', interpolation='nearest', vmin=0, vmax=1)
    ax.set_title(name, fontsize=8, pad=4, color=INK)
    ax.set_xticks([]); ax.set_yticks([])
    for spine in ax.spines.values(): spine.set_edgecolor(INK); spine.set_linewidth(0.6)
fig.suptitle('Pseudo-Mazes (nine non-maze attractors used as negative controls)',
             fontsize=9, y=0.99, color=INK)
plt.tight_layout(rect=[0, 0, 1, 0.97])
plt.savefig(f'{OUT}/fig_pseudo_mazes.png', dpi=200, bbox_inches='tight')
plt.savefig(f'{OUT}/fig_pseudo_mazes.pdf', bbox_inches='tight')
plt.close()
print('saved fig_pseudo_mazes')

# Save all grids as JSON for reference
data = {
    'W': W, 'H': H,
    'true': {k: v.tolist() for k, v in true_mazes.items()},
    'pseudo': {k: v.tolist() for k, v in pseudo_mazes.items()},
}
with open(f'{OUT}/maze_grids.json', 'w') as f:
    json.dump(data, f)
print('saved maze_grids.json')