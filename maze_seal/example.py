"""example.py — minimal usage of the maze_seal package.

Run from inside the maze_seal/ directory:
    python example.py

Or import from anywhere:
    from maze_seal import ga_to_maze, save_grid_txt, verify_maze
"""
import json
import os
import sys
import tempfile

# Allow running this file directly: `python example.py` from inside maze_seal/
# Must come BEFORE the import below. We add the PARENT of this directory so
# Python can find the `maze_seal` package.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np

from maze_seal import ga_to_maze, verify_maze, save_grid_txt, load_grid_txt, grid_meta

# ============================================================================
# Example 1: build a 5x9 linear snake (already a "true maze") and seal it.
# ============================================================================
print("=" * 60)
print("Example 1: 5x9 linear snake (top row is a single corridor)")
print("=" * 60)

g = np.ones((5, 9), dtype=np.uint8)
for x in range(9):
    g[0, x] = 0  # top row = snake

result = ga_to_maze(g, verbose=False)
print(f"  ok:           {result['ok']}")
print(f"  entry_a:      {result['entry_a']}")
print(f"  entry_b:      {result['entry_b']}")
print(f"  path length:  {len(result['path'])} cells")
print(f"  score:        {result['score']}")
print(f"  sealed cells: {int((result['maze'] == 0).sum())}")
print()

# Verify
v = verify_maze(result["maze"], result["entry_a"], result["entry_b"])
print("  verify:")
for k, val in v.items():
    print(f"    {k}: {val}")

# ============================================================================
# Example 2: a denser grid with branches and loops.
# ============================================================================
print()
print("=" * 60)
print("Example 2: 7x7 grid with a U-shape and a center branch")
print("=" * 60)

g2 = np.ones((7, 7), dtype=np.uint8)
# Outer ring: top row, bottom row, left col, right col
g2[0, :] = 0
g2[-1, :] = 0
g2[:, 0] = 0
g2[:, -1] = 0
# A center branch sticking up
g2[3, 3] = 0
g2[2, 3] = 0

result2 = ga_to_maze(g2, verbose=False)
print(f"  ok:           {result2['ok']}")
print(f"  entry_a:      {result2['entry_a']}")
print(f"  entry_b:      {result2['entry_b']}")
print(f"  path length:  {len(result2['path'])} cells")
print(f"  score:        {result2['score']}")

# ============================================================================
# Example 3: save/load via .grid.txt
# ============================================================================
print()
print("=" * 60)
print("Example 3: round-trip via .grid.txt")
print("=" * 60)

import tempfile
import os

with tempfile.TemporaryDirectory() as tmpdir:
    out_path = os.path.join(tmpdir, "example.grid.txt")
    save_grid_txt(
        result["maze"],
        out_path,
        meta={
            "source": "example 1 (5x9 snake)",
            "entry_a": result["entry_a"],
            "entry_b": result["entry_b"],
            "path_length": len(result["path"]),
            "score": result["score"],
        },
    )
    print(f"  saved to: {out_path}")
    print(f"  file size: {os.path.getsize(out_path)} bytes")

    # Reload
    g_loaded = load_grid_txt(out_path)
    assert np.array_equal(g_loaded, result["maze"]), "roundtrip mismatch"
    print(f"  loaded shape: {g_loaded.shape}, match: True")

    # Read metadata
    meta = grid_meta(out_path)
    print(f"  metadata: {meta}")

# ============================================================================
# Example 4: real GA output (60x40 grid from sweep).
# Comment out if you don't have the checkpoint file AND `_ca_render` module.
# ============================================================================
print()
print("=" * 60)
print("Example 4: real GA ckpt (60x40)")
print("=" * 60)

ckpt_path = r"E:\doro\maze-web\ckpt\sweep07_14_all_v71_manhattan-2_mf2_s3.json"
if not os.path.exists(ckpt_path):
    print(f"  SKIP: {ckpt_path} not found")
else:
    # Replay the CA to get the raw grid. `_ca_render` is in the parent project
    # (not in this package), so import it dynamically.
    try:
        from _ca_render import run_ca
    except ImportError:
        print("  SKIP: _ca_render module not in path (only relevant for the parent project)")
    else:
        ckpt = json.load(open(ckpt_path))
        cfg = ckpt["config"]
        g_raw, _ = run_ca(
            bits_list=ckpt["bestChromBits"],
            random_seed=cfg["randomSeed"],
            s=0,
            mask_type=cfg.get("cellMaskType"),
            W=cfg["gridW"], H=cfg["gridH"],
            steps=cfg.get("caSteps", 300),
            init_full_screen=cfg.get("initFullScreen", 1),
            init_density=cfg.get("initDensity", 0.5),
            patch_size=cfg.get("initPatchSize", 5),
        )
        result4 = ga_to_maze(g_raw, verbose=True)
        print(f"\n  result:")
        print(f"    ok:           {result4['ok']}")
        print(f"    entry_a:      {result4['entry_a']}")
        print(f"    entry_b:      {result4['entry_b']}")
        print(f"    path length:  {len(result4['path'])} cells")
        print(f"    score:        {result4['score']}")
