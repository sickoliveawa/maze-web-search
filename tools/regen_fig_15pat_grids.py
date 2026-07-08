#!/usr/bin/env python3
"""
regen_fig_15pat_grids.py
========================

Generate the canonical 5x3 grid figures for the 15-pattern benchmark.

For each pattern (6 true + 9 pseudo) at 31x31 resolution, render the actual
maze image AND its score (mq or Bellot F) as a label, in the layout:

  Row 1: true1   true2   true3
  Row 2: true4   true5   true6
  Row 3: pseudo1 pseudo2 pseudo3
  Row 4: pseudo4 pseudo5 pseudo6
  Row 5: pseudo7 pseudo8 pseudo9

Outputs:
  ../figures/v2/fig_15pat_grid_mq.png      - 15 mazes + maze_quality labels
  ../figures/v2/fig_15pat_grid_bellot.png  - 15 mazes + Bellot F labels
                                              (4 misclassifications highlighted)

Source data:
  ../paper/data/_grids.json         - 15 maze grids (31x31, 0/1)
  ../paper/data/sweep_summary.json  - mq and Bellot F scores per pattern
"""

import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
import numpy as np

# --- Paths ---
ROOT = Path(__file__).resolve().parent.parent
GRID_FILE = ROOT / "paper" / "data" / "_grids.json"
SCORE_FILE = ROOT / "paper" / "data" / "sweep_summary.json"
OUT_DIR = ROOT / "figures" / "v2"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# --- Load data ---
grids = json.load(open(GRID_FILE, encoding="utf-8"))
sweep = json.load(open(SCORE_FILE, encoding="utf-8"))
per_pat = {p["name"]: p for p in sweep["15pattern"]["per_pattern"]}

TRUE = grids["true"]
PSEUDO = grids["pseudo"]

# --- Helpers ---
def grid_to_img(flat, W, H, scale=8):
    """Convert flat 0/1 grid to (H, W) int8 ndarray; rescale for visibility."""
    arr = np.array(flat, dtype=np.uint8).reshape(H, W)
    return arr

def render_fig(score_key, title, out_path, highlight_low_bellot=False):
    """Render a 5x3 grid of mazes with scores."""
    # Pattern order: 6 true first (alphabetical), then 9 pseudo (alphabetical)
    true_names = sorted(TRUE.keys())
    pseudo_names = sorted(PSEUDO.keys())
    all_names = true_names + pseudo_names  # 6 + 9 = 15

    # _grids.json uses "Recursive Backtrack (DFS)" but per_pattern uses
    # "Recursive Backtrack". Map grid names -> per_pattern names.
    def per_name(grid_name):
        return grid_name.replace(" (DFS)", "")

    nrows, ncols = 5, 3

    fig, axes = plt.subplots(nrows, ncols, figsize=(8.5, 13.5))
    fig.suptitle(title, fontsize=12, y=0.995)

    for idx, name in enumerate(all_names):
        r, c = idx // ncols, idx % ncols
        ax = axes[r, c]
        # Grid source
        flat = TRUE[name] if name in TRUE else PSEUDO[name]
        img = grid_to_img(flat, grids["W"], grids["H"])
        # Render
        ax.imshow(img, cmap="gray_r", vmin=0, vmax=1, interpolation="nearest")
        ax.set_xticks([])
        ax.set_yticks([])
        for spine in ax.spines.values():
            spine.set_visible(False)
        # Label: pattern name + score
        score = per_pat[per_name(name)][score_key]
        # Type label
        is_true = name in TRUE
        type_lbl = "TRUE" if is_true else "PSEUDO"
        # Misclass highlight for Bellot
        color = "black"
        weight = "normal"
        if highlight_low_bellot and score_key == "bellotF":
            # Bellot misclassifies 4/9 pseudo (Spiral F=11.85, 3x F=0) as "more maze-like"
            if name in ("Spiral", "Horizontal Stripes", "Concentric Rings", "Honeycomb"):
                color = "#c44135"  # vermilion — paper palette
                weight = "bold"
        elif score_key == "mq":
            if is_true:
                color = "#3a5f3a"
            else:
                color = "#7a3a3a"
        # Compose label
        if score_key == "mq":
            lbl = f"{name}\n{type_lbl}\nmq = {score:.3f}"
        else:
            lbl = f"{name}\n{type_lbl}\nF = {score:.2f}"
        ax.set_xlabel(lbl, fontsize=8, color=color, fontweight=weight)
        # Border color for misclass
        if highlight_low_bellot and name in ("Spiral", "Horizontal Stripes", "Concentric Rings", "Honeycomb"):
            for spine in ax.spines.values():
                spine.set_visible(True)
                spine.set_edgecolor("#c44135")
                spine.set_linewidth(2.0)

    # Remove unused cells (last row has only 0 cells, since 15 = 5*3)
    for idx in range(len(all_names), nrows * ncols):
        r, c = idx // ncols, idx % ncols
        axes[r, c].axis("off")

    plt.tight_layout(rect=[0, 0, 1, 0.99])
    plt.savefig(out_path, dpi=100, bbox_inches="tight", facecolor="#f6f1e6")
    plt.close()
    print(f"  saved: {out_path} ({out_path.stat().st_size/1024:.1f} KB)")

# --- Render ---
print("Generating fig_15pat_grid_mq.png ...")
render_fig(
    score_key="mq",
    title="15-pattern benchmark - maze_quality score (TRUE mean 0.711, PSEUDO mean 0.000, gap +0.711)",
    out_path=OUT_DIR / "fig_15pat_grid_mq.png",
)

print("Generating fig_15pat_grid_bellot.png ...")
render_fig(
    score_key="bellotF",
    title="15-pattern benchmark - Bellot F score (4/9 pseudo misclassified, boxed in vermilion)",
    out_path=OUT_DIR / "fig_15pat_grid_bellot.png",
    highlight_low_bellot=True,
)
print("done.")
