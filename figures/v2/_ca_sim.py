"""
CA simulator for FamilyMask (matches browser BatchedGPUScorer logic).
Used to render real ES-discovered rules.
"""
import json
import numpy as np

def decode_rule(bits, mask_type=None):
    """Decode 1648-bit chromosome into list of Family dicts (sorted by priority)."""
    SLOT, ACTIVE, BIRTH, SURVIVE, PRI = 103, 0, 81, 90, 99
    def in_range(dx, dy, mt):
        if mt and mt.startswith('chebyshev-'):
            N = int(mt.split('-')[1]); return max(abs(dx), abs(dy)) <= N
        if mt and mt.startswith('manhattan-'):
            N = int(mt.split('-')[1]); return abs(dx)+abs(dy) <= N
        return True
    fams = []
    for i in range(16):
        s = i*SLOT
        if bits[s] != 1: continue
        pri = sum(bits[s+PRI+p]<<p for p in range(4))
        pri = max(1, min(16, pri or 1))
        cells = []
        bi = 0
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                if dx==0 and dy==0:
                    bi += 1; continue
                if bits[s+1+bi] == 1 and in_range(dx, dy, mask_type):
                    cells.append((dx, dy))
                bi += 1
        birth = {n for n in range(9) if bits[s+BIRTH+n]==1}
        surv  = {n for n in range(9) if bits[s+SURVIVE+n]==1}
        fams.append({'pri': pri, 'cells': cells, 'birth': birth, 'surv': surv, 'idx': i})
    fams.sort(key=lambda f: f['pri'])
    return fams

def step_ca(grid, fams, W, H, boundary=0):
    """Single step with multi-family priority semantics."""
    new = np.zeros_like(grid)
    for y in range(H):
        for x in range(W):
            cur = grid[y, x]
            for fam in fams:
                cnt = 0
                for (dx, dy) in fam['cells']:
                    nx, ny = x+dx, y+dy
                    if 0 <= nx < W and 0 <= ny < H:
                        cnt += grid[ny, nx]
                    else:
                        cnt += boundary
                if cur == 0:
                    if cnt in fam['birth']:
                        new[y, x] = 1; break
                else:
                    if cnt in fam['surv']:
                        new[y, x] = 1; break
    return new

def init_full_screen(W, H, density=0.15, seed=42):
    rng = np.random.RandomState(seed)
    return (rng.random((H, W)) < density).astype(np.uint8)

def init_patch(W, H, patch_size=10, density=0.40, seed=42):
    """Legacy patch init (10x10 center patch at 0.40 density)."""
    grid = np.zeros((H, W), dtype=np.uint8)
    cx, cy = W//2, H//2
    rng = np.random.RandomState(seed)
    for y in range(cy - patch_size//2, cy + patch_size//2):
        for x in range(cx - patch_size//2, cx + patch_size//2):
            if 0 <= x < W and 0 <= y < H:
                grid[y, x] = 1 if rng.random() < density else 0
    return grid

def run_ca(fams, W=40, H=60, steps=300, init_seed=42, density=0.15,
           init_mode='full', boundary=0, patch_size=10):
    if init_mode == 'full':
        grid = init_full_screen(W, H, density, init_seed)
    else:
        grid = init_patch(W, H, patch_size, density, init_seed)
    snapshots = [grid.copy()]
    for _ in range(steps):
        grid = step_ca(grid, fams, W, H, boundary)
        snapshots.append(grid.copy())
    return grid, snapshots