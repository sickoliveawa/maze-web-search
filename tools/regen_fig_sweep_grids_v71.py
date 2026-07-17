#!/usr/bin/env python3
"""
regen_fig_sweep_grids_v71.py
============================

Render the 160-cell v7.1 sweep grid: 8 mask × 5 maxFam × 4 seed = 160 (mask, mf, seed) configs.

Layout: 5 rows (maxFam=1,2,4,8,16) × 8 cols (8 masks)
Each main cell = 1 sub-cell per seed (4 seeds, 4 sub-cells per main cell) = 4×8×5 = 160 sub-cells total
Red border on global peak (manhattan-2/mf=2/s=3, 0.7982).

Data source: sweep_2026_07_14_all_v71 (v7.1 weights, 160/160 OK)
ckpt path: ckpt/sweep07_14_all_v71_{mask}_mf{mf}_s{seed}.json
Render: paper/data/_ca_render.py --grid-w 40 --grid-h 60 --steps 300
Polar fix: use canvas_grid_2d (already polar-correct per ckpt M_wall_ratio check in _ca_render)
Visual: path=ink, wall=cream (cmap="gray", NOT gray_r)
"""
import json, os, subprocess
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(r"E:\doro\maze-web")
CKPT_DIR = ROOT / "ckpt"
TMP_DIR = ROOT / "paper" / "data" / "_tmp_render"
TMP_DIR.mkdir(parents=True, exist_ok=True)
OUT = ROOT / "figures" / "v2.4" / "fig_smallsweep_grids.png"
OUT.parent.mkdir(parents=True, exist_ok=True)

PAPER_BG = "#F2E6CE"
INK = "#32241C"
RED = "#C44135"
WARM_GRAY = "#5C4D3D"

# Load v7.1 sweep data
print("Loading v7.1 sweep results...")
nd_path = ROOT / "sweep_2026_07_14_all_v71" / "results.ndjson"
rows = [json.loads(l) for l in open(nd_path, encoding="utf-8")]
ok = [r for r in rows if r.get("status") == "OK"]
err = [r for r in rows if r.get("status") != "OK"]
print(f"  total: {len(rows)}, OK: {len(ok)}, non-OK: {len(err)}")
if err:
    for r in err[:5]:
        print(f"  ! non-OK: {r.get('mask')} mf={r.get('maxFam')} s={r.get('seed')} status={r.get('status')}")

masks = ["chebyshev-1", "chebyshev-2", "chebyshev-3", "chebyshev-4",
         "manhattan-1", "manhattan-2", "manhattan-3", "manhattan-4"]
max_fams = [1, 2, 4, 8, 16]
seeds = [0, 1, 2, 3]

# Index OK rows
all_cells = {}
for r in ok:
    all_cells[(r["mask"], r["maxFam"], r["seed"])] = r

# Render all 160 cells
print(f"\nRendering 160 cells (4 seeds × 8 mask × 5 maxFam = 160)...")
grid_renders = {}
for m in masks:
    for mf in max_fams:
        for s in seeds:
            cell = all_cells.get((m, mf, s))
            if cell is None:
                grid_renders[(m, mf, s)] = None
                continue
            ckpt = f"sweep07_14_all_v71_{m}_mf{mf}_s{s}.json"
            out = TMP_DIR / f"_fig_smallcell_v71_{m}_mf{mf}_s{s}.json"
            cmd = [r"C:\Users\sicko\AppData\Local\Programs\Python\Python313\python.exe",
                   "paper/data/_ca_render.py",
                   "--best-chrom-json", f"ckpt/{ckpt}",
                   "--mask-type", m,
                   "--random-seed", str(s), "--s", "0",
                   "--grid-w", "40", "--grid-h", "60", "--steps", "300",
                   "--init-full-screen", "1",
                   "--out", str(out)]
            r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT))
            if r.returncode != 0:
                print(f"  ERR ({m}, mf={mf}, s={s}): {r.stderr.strip()[:200]}")
                grid_renders[(m, mf, s)] = None
                continue
            d = json.load(open(out, encoding="utf-8"))
            grid_renders[(m, mf, s)] = d
print(f"  rendered {sum(1 for v in grid_renders.values() if v)}/160 cells")

# Build figure: 5 rows (maxFam) × 8 cols (mask), 4 sub-cells per main cell (seeds)
n_rows, n_cols = len(max_fams), len(masks)
fig = plt.figure(figsize=(22, 14), facecolor=PAPER_BG)
fig.subplots_adjust(left=0.05, right=0.98, top=0.93, bottom=0.04, hspace=0.15, wspace=0.08)

# Global peak: manhattan-2 / mf=2 / s=3 / 0.7982
peak = ("manhattan-2", 2, 3, 0.7982)

for j, mf in enumerate(max_fams):
    for i, m in enumerate(masks):
        # Outer axes for the (m, mf) main cell
        rect = [0.05 + i * (0.98 - 0.05) / n_cols,
                0.04 + (n_rows - 1 - j) * (0.93 - 0.04) / n_rows,  # mf=1 at top
                (0.98 - 0.05) / n_cols * 0.94,
                (0.93 - 0.04) / n_rows * 0.90]
        outer_ax = fig.add_axes(rect)
        outer_ax.set_xticks([]); outer_ax.set_yticks([])
        for sp in outer_ax.spines.values():
            sp.set_color(INK); sp.set_linewidth(0.8)
        outer_ax.set_facecolor(PAPER_BG)

        # 4 sub-cells (seeds) — 2x2 layout within main cell
        for k, s in enumerate(seeds):
            sx = k % 2
            sy = 1 - k // 2  # top row first
            sub_rect = [
                rect[0] + (rect[2] * 0.04) + sx * (rect[2] * 0.46),
                rect[1] + (rect[3] * 0.04) + sy * (rect[3] * 0.46),
                rect[2] * 0.46,
                rect[3] * 0.46,
            ]
            sub_ax = fig.add_axes(sub_rect)
            sub_ax.set_xticks([]); sub_ax.set_yticks([])

            d = grid_renders.get((m, mf, s))
            if d is None:
                sub_ax.text(0.5, 0.5, "err", ha="center", va="center",
                            transform=sub_ax.transAxes, fontsize=8, color=WARM_GRAY)
                for sp in sub_ax.spines.values():
                    sp.set_color(WARM_GRAY); sp.set_linewidth(0.3)
                continue
            # Normalize canvas to a consistent polar convention:
            # we always want 0=wall, 1=corridor so cmap="gray_r" renders
            # wall=ink (dark) and corridor=cream (light) uniformly. The
            # dual_pick stage may have already inverted the grid; undo that
            # inversion here so every panel uses the same polar.
            grid = np.array(d["canvas_grid_2d"], dtype=np.uint8)
            if d.get("used_inverted", False):
                grid = 1 - grid
            # cmap="gray_r": 0 -> black, 1 -> white. So wall=ink, corridor=cream.
            sub_ax.imshow(grid, cmap="gray_r", vmin=0, vmax=1, interpolation="nearest", aspect="equal")
            # Display the ckpt's recorded bestScore (computed at training time on
            # the mq-view, i.e. the grid we are showing). This is more reliable
            # than orig_mq_score/inv_mq_score from _ca_render.py, which can be 0
            # when the proxy scored the wrong-polar raw grid.
            ckpt = json.load(open(CKPT_DIR / f"sweep07_14_all_v71_{m}_mf{mf}_s{s}.json"))
            score = float(ckpt.get("bestScore", 0.0))
            for sp in sub_ax.spines.values():
                sp.set_color(INK); sp.set_linewidth(0.3)
            # Subtle score label
            sub_ax.text(0.95, 0.05, f"{score:.2f}", transform=sub_ax.transAxes,
                        ha="right", va="bottom", fontsize=5, color=INK,
                        bbox=dict(boxstyle="round,pad=0.05", fc="#FBF7ED", ec="none", alpha=0.7))
            # Highlight global peak
            if m == peak[0] and mf == peak[1] and s == peak[2]:
                for sp in sub_ax.spines.values():
                    sp.set_color(RED); sp.set_linewidth(1.5)

# Row labels (maxFam) on left
fig.text(0.012, 0.485, "maxFam →", fontsize=11, color=INK, ha="left", va="center", weight="bold")
for j, mf in enumerate(max_fams):
    y = 0.04 + (n_rows - 1 - j) * (0.93 - 0.04) / n_rows + (0.93 - 0.04) / (2 * n_rows)
    fig.text(0.022, y, f"mf={mf}", fontsize=10, color=INK, ha="left", va="center", weight="bold")

# Col labels (mask) on top
for i, m in enumerate(masks):
    x = 0.05 + i * (0.98 - 0.05) / n_cols + (0.98 - 0.05) / (2 * n_cols)
    fig.text(x, 0.96, m, fontsize=10, color=INK, ha="center", va="top", weight="bold")

# Title
fig.suptitle(
    f"160-run sweep — all 160 (mask × maxFam × seed) configs, 40×60 grid, 300 CA steps\n"
    f"red border = global peak ({peak[0]} / mf={peak[1]} / s={peak[2]}, mq={peak[3]:.4f}); "
    f"n=160, 160/160 OK",
    fontsize=11, color=INK, weight="bold", y=0.995,
)

plt.savefig(OUT, dpi=110, bbox_inches="tight", facecolor=PAPER_BG)
plt.close()
print(f"\nSaved: {OUT} ({OUT.stat().st_size/1024:.1f} KB)")
