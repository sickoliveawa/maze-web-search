#!/usr/bin/env python3
"""
regen_fig_top_grids.py
======================

Render the 6 ES-discovered high-scoring + key-feature mazes as a 3x2 grid
for paper v2.0 §5 ("key feature mazes from sweep").

Layout (3 cols x 2 rows):
  Row 1: top1 (manhattan-2/mf8/s444, 0.8233) | top2 (chebyshev-1/mf8/s333, 0.8095) | top3 (chebyshev-2/mf2/s333, 0.8080)
  Row 2: top5 (manhattan-4/mf1/s111, 0.7999) | fail1 (chebyshev-4/mf1/s111, 0.4244) | fail2 (manhattan-1/mf2/s444, 0.4240)

Top 1-3 + top 5 = "ES high-score mazes" (corridor-dominated, looks like real mazes)
Fail 1-2 = "key-feature failure modes" (chebyshev-4 stuck, manhattan-1 dead end)
"""

import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
GRID_DIR = ROOT / "paper" / "data" / "_top_grids"
OUT = ROOT / "figures" / "v2" / "fig_top_grids.png"
OUT.parent.mkdir(parents=True, exist_ok=True)

# Order and metadata
PANELS = [
    { "ckpt": "sweep_manhattan-2_mf8_s444",  "tag": "Top 1", "score": 0.8233, "kind": "top",  "desc": "manhattan-2 / mf=8 / s444" },
    { "ckpt": "sweep_chebyshev-1_mf8_s333",  "tag": "Top 2", "score": 0.8095, "kind": "top",  "desc": "chebyshev-1 / mf=8 / s333" },
    { "ckpt": "sweep_chebyshev-2_mf2_s333",  "tag": "Top 3", "score": 0.8080, "kind": "top",  "desc": "chebyshev-2 / mf=2 / s333" },
    { "ckpt": "sweep_manhattan-4_mf1_s111",  "tag": "Top 5", "score": 0.7999, "kind": "top",  "desc": "manhattan-4 / mf=1 / s111" },
    { "ckpt": "sweep_chebyshev-4_mf1_s111",  "tag": "Fail 1", "score": 0.4244, "kind": "fail", "desc": "chebyshev-4 / mf=1 / s111" },
    { "ckpt": "sweep_manhattan-1_mf2_s444",  "tag": "Fail 2", "score": 0.4240, "kind": "fail", "desc": "manhattan-1 / mf=2 / s444" },
]

def load_grid(name):
    p = GRID_DIR / f"panel_{name}.json"
    d = json.load(open(p, encoding="utf-8"))
    W, H = d["W"], d["H"]
    flat = d["grid_2d"]
    arr = np.array(flat, dtype=np.uint8).reshape(H, W)
    return arr, d

def render():
    fig, axes = plt.subplots(2, 3, figsize=(11, 7.5))
    paper_bg = "#FBF7ED"
    fig.patch.set_facecolor(paper_bg)
    for ax, meta in zip(axes.flat, PANELS):
        arr, d = load_grid(meta["ckpt"])
        # Render: 0 = wall (black), 1 = path (white)
        # We use gray_r so 0 -> black, 1 -> white
        ax.imshow(arr, cmap="gray_r", vmin=0, vmax=1, interpolation="nearest", aspect="equal")
        ax.set_xticks([])
        ax.set_yticks([])
        # border
        is_fail = meta["kind"] == "fail"
        border_color = "#C44135" if is_fail else "#322418"
        border_width = 2.0 if is_fail else 1.0
        for spine in ax.spines.values():
            spine.set_visible(True)
            spine.set_edgecolor(border_color)
            spine.set_linewidth(border_width)
        # title: tag + score + desc
        title_color = "#C44135" if is_fail else "#322418"
        ax.set_title(
            f"{meta['tag']}  score={meta['score']:.4f}\n{meta['desc']}",
            fontsize=10, color=title_color, fontweight="bold" if is_fail else "normal",
            pad=6
        )
        # maze_quality breakdown
        mq = d.get("alive", "?")
        ratio = d.get("ratio", 0)
        ax.set_xlabel(f"alive={mq}  path-ratio={ratio:.2f}", fontsize=8, color="#7A5A3A")

    plt.suptitle(
        "ES-discovered mazes (top-4) and key-feature failure modes (bottom-right 2)\n"
        "Source: sweep_2026_07_04 ES run, 1648-bit FamilyMask chromosome, 300-step CA on 40x60 grid",
        fontsize=11, y=0.995
    )
    plt.tight_layout(rect=[0, 0, 1, 0.97])
    plt.savefig(OUT, dpi=100, bbox_inches="tight", facecolor=paper_bg)
    plt.close()
    print(f"  saved: {OUT} ({OUT.stat().st_size/1024:.1f} KB)")

if __name__ == "__main__":
    render()
