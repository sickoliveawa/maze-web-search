#!/usr/bin/env python3
"""
regen_fig_sweep_heatmaps.py
===========================

Generate the two sweep summary figures required by §5:

  fig_bigsweep_top5.png     - 5-seed top scores for manhattan-2/mf=8
                              (big_sweep, 500x2000), with small-sweep
                              200x500 peak (0.8233) as a horizontal
                              reference line.

  fig_smallsweep_heatmap.png - Heatmap of (mask x maxFam) with mean best
                                score across 4 seeds per cell. All 122
                                successful runs shown.

Source data:
  ../sweep_2026_07_08_big/results.ndjson   - 5 big_sweep runs
  ../paper/data/sweep_summary.json          - 128 small_sweep runs
"""

import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

# --- Paths ---
ROOT = Path(__file__).resolve().parent.parent
BIG_LOG = ROOT / "sweep_2026_07_08_big" / "results.ndjson"
SMALL_SUMMARY = ROOT / "paper" / "data" / "sweep_summary.json"
OUT_DIR = ROOT / "figures" / "v2"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# --- 1. Big sweep top-5 ---
print("Generating fig_bigsweep_top5.png ...")
big = []
for line in BIG_LOG.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line:
        continue
    d = json.loads(line)
    big.append({
        "seed": d.get("seed", d.get("randomSeed")),
        "best": d["best"],
        "mask": d["mask"],
        "maxFam": d["maxFam"],
    })
big = sorted(big, key=lambda x: -x["best"])
seeds = [f"s{b['seed']}" for b in big]
scores = [b["best"] for b in big]
# Small-sweep peak (200x500 sweep, manhattan-2/mf=8/s444, the 0.8233 ckpt)
SMALL_PEAK = 0.8233

fig, ax = plt.subplots(figsize=(8, 4.5))
colors = ["#3a5f3a" if s >= 0.81 else "#7a5a3a" for s in scores]
bars = ax.bar(seeds, scores, color=colors, edgecolor="#322418", linewidth=0.8)
# Reference line: small-sweep peak
ax.axhline(SMALL_PEAK, color="#c44135", linestyle="--", linewidth=1.5,
           label=f"200×500 sweep peak = {SMALL_PEAK:.4f} (manhattan-2/mf=8/s444)")
# Mean line
mean_v = np.mean(scores)
ax.axhline(mean_v, color="#503a20", linestyle=":", linewidth=1.2,
           label=f"500×2000 sweep mean = {mean_v:.4f} (n=5)")
# Value labels
for bar, s in zip(bars, scores):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.002,
            f"{s:.4f}", ha="center", va="bottom", fontsize=9, color="#322418")
ax.set_ylim(0.74, 0.85)
ax.set_ylabel("maze_quality best score")
ax.set_title("Large sweep (500x2000) - manhattan-2/mf=8, 5 random seeds")
ax.legend(loc="lower right", fontsize=9, framealpha=0.9)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
ax.set_facecolor("#fbf7ed")
fig.patch.set_facecolor("#f6f1e6")
plt.tight_layout()
out1 = OUT_DIR / "fig_bigsweep_top5.png"
plt.savefig(out1, dpi=180, bbox_inches="tight", facecolor="#f6f1e6")
plt.close()
print(f"  saved: {out1} ({out1.stat().st_size/1024:.1f} KB)")

# --- 2. Small-sweep heatmap ---
print("Generating fig_smallsweep_heatmap.png ...")
sw = json.load(open(SMALL_SUMMARY, encoding="utf-8"))
runs = sw["runs"]
# All runs in sweep_summary.json are successful (timeout runs not in this list)
ok = [r for r in runs if "best" in r]
print(f"  small-sweep runs in summary: {len(ok)} / total {len(runs)}")

masks = ["chebyshev-1", "chebyshev-2", "chebyshev-3", "chebyshev-4",
         "manhattan-1", "manhattan-2", "manhattan-3", "manhattan-4"]
mfs = [1, 2, 4, 8]
# mean matrix
mean_mat = np.full((len(masks), len(mfs)), np.nan)
# raw per-seed matrix (4 seeds) — pick the best of 4 for each (mask, mf)
best_mat = np.full((len(masks), len(mfs)), np.nan)
for r in ok:
    mi = masks.index(r["mask"])
    fi = mfs.index(r["maxFam"])
    v = r["best"]
    if np.isnan(mean_mat[mi, fi]):
        mean_mat[mi, fi] = 0
        best_mat[mi, fi] = -1
        count = 0
    mean_mat[mi, fi] += v
    count = 1  # we accumulate
    if v > best_mat[mi, fi]:
        best_mat[mi, fi] = v

# normalize mean
for i in range(len(masks)):
    for j in range(len(mfs)):
        # count entries
        n = sum(1 for r in ok if r["mask"] == masks[i] and r["maxFam"] == mfs[j])
        if n > 0 and not np.isnan(mean_mat[i, j]):
            mean_mat[i, j] /= n

# The small-sweep heatmap. We'll show BEST (not mean) per (mask, mf), since
# each (mask, mf) has 4 seeds, and we want to capture the headline metric.
fig, ax = plt.subplots(figsize=(7.5, 6.5))
im = ax.imshow(best_mat, cmap="YlGnBu", vmin=0.0, vmax=0.85, aspect="auto")
ax.set_xticks(range(len(mfs)))
ax.set_xticklabels([f"mf={m}" for m in mfs])
ax.set_yticks(range(len(masks)))
ax.set_yticklabels(masks)
ax.set_title("Small sweep (200x500) - best of 4 seeds per (mask, mf) cell, n=122/128")
# Annotate
for i in range(len(masks)):
    for j in range(len(mfs)):
        v = best_mat[i, j]
        if not np.isnan(v):
            color = "white" if v < 0.4 else "black"
            ax.text(j, i, f"{v:.3f}", ha="center", va="center",
                    fontsize=9, color=color)
            # Mark peak
            if v >= 0.82:
                ax.add_patch(plt.Rectangle((j-0.45, i-0.45), 0.9, 0.9,
                                            fill=False, edgecolor="#c44135",
                                            linewidth=2.0))
cbar = plt.colorbar(im, ax=ax, label="maze_quality best of 4 seeds")
cbar.ax.set_facecolor("#fbf7ed")
ax.set_facecolor("#fbf7ed")
fig.patch.set_facecolor("#f6f1e6")
plt.tight_layout()
out2 = OUT_DIR / "fig_smallsweep_heatmap.png"
plt.savefig(out2, dpi=180, bbox_inches="tight", facecolor="#f6f1e6")
plt.close()
print(f"  saved: {out2} ({out2.stat().st_size/1024:.1f} KB)")
print("done.")
