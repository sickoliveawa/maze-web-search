#!/usr/bin/env python3
"""
regen_fig_top_grids.py (v7.1)
=============================

Render 4 ES-discovered high-scoring mazes + 2 key-feature failure modes for paper v2.4 §5.

Layout (3 cols x 2 rows):
  Row 1: top1 (manhattan-2/mf=2/s=3, 0.7982) | top2 (manhattan-2/mf=1/s=0, 0.7982) | top3 (manhattan-2/mf=4/s=3, 0.7940)
  Row 2: top4 (manhattan-2/mf=4/s=2, 0.7936) | fail1 (chebyshev-4/mf=8/s=0, 0.7578 budget-limit) | fail2 (manhattan-1/mf=4/s=2, 0.5140 rep-limit)

Data source: sweep_2026_07_14_all_v71 (v7.1 weights, 160/160 OK, 8 mask × 5 mf × 4 seed)
ckpt path: ckpt/sweep07_14_all_v71_{mask}_mf{mf}_s{seed}.json
Render: paper/data/_ca_render.py --grid-w 40 --grid-h 60 --steps 300
Visual: wall=ink (dark), path=cream (light) — cmap="gray" (NOT gray_r), per mq convention 0=wall, 1=path
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
OUT = ROOT / "figures" / "v2.4" / "fig_top_grids.png"
OUT.parent.mkdir(parents=True, exist_ok=True)

# v7.1 top 4 (manhattan-2 dominates) + 2 fail modes
PANELS = [
    {"mask": "manhattan-2", "mf": 2, "seed": 3, "tag": "Top 1", "score": 0.7982, "kind": "top",
     "desc": "manhattan-2 / mf=2 / s=3"},
    {"mask": "manhattan-2", "mf": 1, "seed": 0, "tag": "Top 2", "score": 0.7982, "kind": "top",
     "desc": "manhattan-2 / mf=1 / s=0"},
    {"mask": "manhattan-2", "mf": 4, "seed": 3, "tag": "Top 3", "score": 0.7940, "kind": "top",
     "desc": "manhattan-2 / mf=4 / s=3"},
    {"mask": "manhattan-2", "mf": 4, "seed": 2, "tag": "Top 4", "score": 0.7936, "kind": "top",
     "desc": "manhattan-2 / mf=4 / s=2"},
    {"mask": "chebyshev-4", "mf": 8, "seed": 0, "tag": "Fail 1", "score": 0.7578, "kind": "fail",
     "desc": "chebyshev-4 / mf=8 / s=0 (budget-limited)"},
    {"mask": "manhattan-1", "mf": 4, "seed": 2, "tag": "Fail 2", "score": 0.5140, "kind": "fail",
     "desc": "manhattan-1 / mf=4 / s=2 (rep-limited)"},
]

def render_grid(meta):
    """Render ckpt to 40x60 grid via _ca_render.py. Returns (arr_2d, mq_score, path_ratio, alive)."""
    ckpt_name = f"sweep07_14_all_v71_{meta['mask']}_mf{meta['mf']}_s{meta['seed']}.json"
    out_json = TMP_DIR / f"_fig_top_v71_{meta['mask']}_mf{meta['mf']}_s{meta['seed']}.json"
    cmd = [r"C:\Users\sicko\AppData\Local\Programs\Python\Python313\python.exe",
           "paper/data/_ca_render.py",
           "--best-chrom-json", f"ckpt/{ckpt_name}",
           "--mask-type", meta["mask"],
           "--random-seed", str(meta["seed"]), "--s", "0",
           "--grid-w", "40", "--grid-h", "60", "--steps", "300",
           "--init-full-screen", "1",
           "--out", str(out_json)]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT))
    if r.returncode != 0:
        print(f"  ERR ({meta['desc']}): {r.stderr.strip()[:200]}")
        return None
    d = json.load(open(out_json, encoding="utf-8"))
    arr = np.array(d["canvas_grid_2d"], dtype=np.uint8)
    return arr, d.get("orig_mq_score", 0), d.get("canvas_alive_ratio", 0), d.get("canvas_alive_count", 0)

def render():
    fig, axes = plt.subplots(2, 3, figsize=(13, 9))
    paper_bg = "#FBF7ED"
    fig.patch.set_facecolor(paper_bg)

    for ax, meta in zip(axes.flat, PANELS):
        result = render_grid(meta)
        if result is None:
            ax.text(0.5, 0.5, "render err", ha="center", va="center", transform=ax.transAxes)
            ax.set_xticks([]); ax.set_yticks([])
            continue
        arr, mq, alive_ratio, alive = result
        # cmap="gray" (NOT gray_r): 0=wall -> black (ink), 1=path -> white (cream)
        # (per mq.js::countWalls convention 0=墙, 1=走廊; visual we want wall=dark, path=light)
        ax.imshow(arr, cmap="gray", vmin=0, vmax=1, interpolation="nearest", aspect="equal")
        ax.set_xticks([]); ax.set_yticks([])
        is_fail = meta["kind"] == "fail"
        border_color = "#C44135" if is_fail else "#322418"
        border_width = 2.0 if is_fail else 1.0
        for spine in ax.spines.values():
            spine.set_visible(True)
            spine.set_edgecolor(border_color)
            spine.set_linewidth(border_width)
        title_color = "#C44135" if is_fail else "#322418"
        ax.set_title(
            f"{meta['tag']}  mq={meta['score']:.4f}\n{meta['desc']}",
            fontsize=10, color=title_color, fontweight="bold" if is_fail else "normal",
            pad=6,
        )
        ax.set_xlabel(f"alive={alive}  path-ratio={alive_ratio:.2f}", fontsize=8, color="#7A5A3A")

    plt.suptitle(
        "top-4 ckpt (manhattan-2 × 4) + 2 failure modes (chebyshev-4 budget-limit, manhattan-1 rep-limit)\n"
        "Source: 8 mask × 5 mf × 4 seed (160/160 OK), 300-step CA on 40×60 grid\n"
        "Render: wall=ink (dark), path=cream (light) — cmap=gray, NOT gray_r (per mq convention 0=wall, 1=path)",
        fontsize=10, y=0.995,
    )
    plt.tight_layout(rect=[0, 0, 1, 0.97])
    plt.savefig(OUT, dpi=120, bbox_inches="tight", facecolor=paper_bg)
    plt.close()
    print(f"  saved: {OUT} ({OUT.stat().st_size/1024:.1f} KB)")

if __name__ == "__main__":
    render()
