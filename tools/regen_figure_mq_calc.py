#!/usr/bin/env python3
"""
regen_figure_mq_calc.py — generate maze_quality calculation flow diagram

INDEPENDENT of source code. Reads only:
  - paper/data/_verify_canonical.json (for canonical M_wall_gate range 0.40-0.60)

Output: figures/v2/fig_mq_calculation_v3.png

Visualizes the 8 sub-metric → 2-level aggregate → soft gate → final score flow
as a vintage paper elegant flow diagram.
"""

import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

ROOT = Path(__file__).resolve().parent.parent
FIG_DIR = ROOT / "figures" / "v2"
FIG_DIR.mkdir(parents=True, exist_ok=True)
OUT = FIG_DIR / "fig_mq_calculation_v3.png"

# Colors
COL = {
    "paper":  "#F2E6C8",
    "ink":    "#321E14",
    "vermilion": "#C44536",
    "indigo": "#2F4F5F",
    "olive":  "#6B7B3F",
    "ochre":  "#C99A3B",
    "ash":    "#8A7A60",
}

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["DejaVu Serif", "Times New Roman", "Times"],
    "font.size": 9,
    "axes.facecolor": COL["paper"],
    "figure.facecolor": COL["paper"],
    "text.color": COL["ink"],
})

fig, ax = plt.subplots(figsize=(13, 7))
ax.set_xlim(0, 13)
ax.set_ylim(0, 7)
ax.axis("off")

# Title
ax.text(6.5, 6.6, "Fig 4 — maze_quality 8-Dim Calculation Flow",
        ha="center", va="center", fontsize=13, fontweight="bold", color=COL["vermilion"])

# Column 1: 8 input sub-metrics
INPUTS = [
    # (label, short, x, y, color)
    (r"$M_b$"   + "\ncorridor dominance",   r"$M_b$",   0.5, 5.0, COL["indigo"]),
    (r"$M_s$"   + "\nlongest-path share",   r"$M_s$",   0.5, 4.2, COL["indigo"]),
    (r"$M_j$"   + "\njunction share",        r"$M_j$",   0.5, 3.4, COL["indigo"]),
    (r"$M_c$"   + "\nlargest-comp share",   r"$M_c$",   0.5, 2.6, COL["indigo"]),
    (r"$M_{bnd}$" + "\nouter-frame suppr.",  r"$M_{bnd}$", 0.5, 1.8, COL["indigo"]),
    (r"$M_p$"   + "\n2×2 patch entropy",   r"$M_p$",   0.5, 0.8, COL["olive"]),
    (r"$M_a$"   + "\nmirror asymmetry",      r"$M_a$",   4.0, 0.8, COL["olive"]),
    (r"$M_t$"   + "\n2×2 adj-pair entropy",  r"$M_t$",   4.0, 1.6, COL["olive"]),
]

# Wait, I have 8 inputs but only 7 rows in my list. Let me fix: 5 topology on left, 3 diversity on right
INPUTS = [
    # topology (left side, 5 inputs)
    (r"$M_b$",   "corridor\ndominance",     0.3, 5.0, COL["indigo"]),
    (r"$M_s$",   "longest-path\nshare",     0.3, 4.0, COL["indigo"]),
    (r"$M_j$",   "junction\nshare",         0.3, 3.0, COL["indigo"]),
    (r"$M_c$",   "largest-comp\nshare",     0.3, 2.0, COL["indigo"]),
    (r"$M_{bnd}$", "outer-frame\nsuppression", 0.3, 1.0, COL["indigo"]),
    # diversity (right side, 3 inputs)
    (r"$M_p$",   "2×2 patch\nentropy",      0.3, 0.2, COL["olive"]),
    (r"$M_a$",   "mirror\nasymmetry",       7.5, 0.2, COL["olive"]),
    (r"$M_t$",   "2×2 adj-pair\nentropy",   7.5, 1.2, COL["olive"]),
]

# Wait, this layout is wrong. Let me redo with clearer geometry:
# Topology inputs on left (5 stacked), Diversity inputs also on left below
# Both flow right to M_topology and M_diversity boxes
# Then min() and M_wall_gate
# Then final score

ax.clear()
ax.set_xlim(0, 14)
ax.set_ylim(0, 8)
ax.axis("off")
ax.text(7, 7.5, "Fig 4 — maze_quality 8-Dim Calculation Flow",
        ha="center", va="center", fontsize=14, fontweight="bold", color=COL["vermilion"])

# === Column A: 5 topology sub-metrics (left top) ===
topo_metrics = [
    (r"$M_b$",   "corridor",       0.5, 5.8),
    (r"$M_s$",   "longest-path",   0.5, 4.8),
    (r"$M_j$",   "junction",       0.5, 3.8),
    (r"$M_c$",   "largest-comp",   0.5, 2.8),
    (r"$M_{bnd}$", "frame-suppr.", 0.5, 1.8),
]
for sym, desc, x, y in topo_metrics:
    box = FancyBboxPatch((x, y - 0.35), 2.0, 0.7,
                         boxstyle="round,pad=0.02",
                         facecolor=COL["indigo"], edgecolor=COL["ink"], alpha=0.85, linewidth=0.8)
    ax.add_patch(box)
    ax.text(x + 1.0, y, sym, ha="center", va="center", fontsize=11, color="white", fontweight="bold")
    ax.text(x + 1.0, y - 0.65, desc, ha="center", va="center", fontsize=7, color=COL["ink"], style="italic")

# === Column B: 3 diversity sub-metrics (left bottom) ===
div_metrics = [
    (r"$M_p$",   "2×2 patch",  0.5, 0.8),
    (r"$M_a$",   "asymmetry",  0.5, 0.0),
    (r"$M_t$",   "2×2 adj",    0.5, -0.8),  # off the chart
]
# Reset diversity on right side instead
div_metrics = [
    (r"$M_p$",   "2×2 patch",  5.5, 5.8),
    (r"$M_a$",   "asymmetry",  5.5, 4.8),
    (r"$M_t$",   "2×2 adj",    5.5, 3.8),
]
for sym, desc, x, y in div_metrics:
    box = FancyBboxPatch((x, y - 0.35), 2.0, 0.7,
                         boxstyle="round,pad=0.02",
                         facecolor=COL["olive"], edgecolor=COL["ink"], alpha=0.85, linewidth=0.8)
    ax.add_patch(box)
    ax.text(x + 1.0, y, sym, ha="center", va="center", fontsize=11, color="white", fontweight="bold")
    ax.text(x + 1.0, y - 0.65, desc, ha="center", va="center", fontsize=7, color=COL["ink"], style="italic")

# === Aggregate boxes ===
# M_topology (from 5)
box1 = FancyBboxPatch((3.2, 3.3), 2.0, 1.4,
                     boxstyle="round,pad=0.04",
                     facecolor=COL["vermilion"], edgecolor=COL["ink"], alpha=0.9, linewidth=1.0)
ax.add_patch(box1)
ax.text(4.2, 4.0, r"$M_{topology}$",
        ha="center", va="center", fontsize=13, color="white", fontweight="bold")
ax.text(4.2, 3.55, "5-dim weighted\ngeometric mean",
        ha="center", va="center", fontsize=7, color="white", style="italic")

# M_diversity (from 3)
box2 = FancyBboxPatch((8.2, 3.3), 2.0, 1.4,
                     boxstyle="round,pad=0.04",
                     facecolor=COL["ochre"], edgecolor=COL["ink"], alpha=0.9, linewidth=1.0)
ax.add_patch(box2)
ax.text(9.2, 4.0, r"$M_{diversity}$",
        ha="center", va="center", fontsize=13, color="white", fontweight="bold")
ax.text(9.2, 3.55, "3-dim weighted\ngeometric mean",
        ha="center", va="center", fontsize=7, color="white", style="italic")

# === Arrows: 5 topology → M_topology, 3 diversity → M_diversity ===
for sym, desc, x, y in topo_metrics:
    arrow = FancyArrowPatch((x + 2.0, y), (3.2, 4.0),
                            arrowstyle="->", mutation_scale=12,
                            color=COL["ink"], linewidth=0.7, alpha=0.7)
    ax.add_patch(arrow)
for sym, desc, x, y in div_metrics:
    arrow = FancyArrowPatch((x + 2.0, y), (8.2, 4.0),
                            arrowstyle="->", mutation_scale=12,
                            color=COL["ink"], linewidth=0.7, alpha=0.7)
    ax.add_patch(arrow)

# === min() balance ===
min_box = FancyBboxPatch((5.5, 1.5), 1.4, 0.9,
                        boxstyle="round,pad=0.04",
                        facecolor=COL["ink"], edgecolor=COL["ink"], alpha=0.9)
ax.add_patch(min_box)
ax.text(6.2, 1.95, r"$\min$", ha="center", va="center", fontsize=16, color="white", fontweight="bold")
ax.text(6.2, 1.55, "balance", ha="center", va="center", fontsize=7, color="white", style="italic")

# Arrows to min()
arrow1 = FancyArrowPatch((4.2, 3.3), (5.7, 2.3),
                        arrowstyle="->", mutation_scale=14,
                        color=COL["vermilion"], linewidth=1.2, alpha=0.85)
ax.add_patch(arrow1)
arrow2 = FancyArrowPatch((9.2, 3.3), (6.7, 2.3),
                        arrowstyle="->", mutation_scale=14,
                        color=COL["ochre"], linewidth=1.2, alpha=0.85)
ax.add_patch(arrow2)

# === M_wall_gate (separate input) ===
wall_box = FancyBboxPatch((11.0, 4.0), 2.0, 0.9,
                         boxstyle="round,pad=0.04",
                         facecolor=COL["ash"], edgecolor=COL["ink"], alpha=0.9)
ax.add_patch(wall_box)
ax.text(12.0, 4.65, r"$M_{wall\_gate}$", ha="center", va="center", fontsize=11, color="white", fontweight="bold")
ax.text(12.0, 4.2, "soft triangle on\n[0.40, 0.60]",
        ha="center", va="center", fontsize=7, color="white", style="italic")

# === Final score ===
final_box = FancyBboxPatch((5.3, -0.2), 2.8, 1.1,
                          boxstyle="round,pad=0.06",
                          facecolor=COL["vermilion"], edgecolor=COL["ink"], alpha=0.95, linewidth=1.5)
ax.add_patch(final_box)
ax.text(6.7, 0.55, r"$M = \min(M_{topo}, M_{div}) \times M_{wall\_gate}$",
        ha="center", va="center", fontsize=11, color="white", fontweight="bold")
ax.text(6.7, 0.05, "final maze_quality score, in [0, 1]",
        ha="center", va="center", fontsize=8, color="white", style="italic")

# Arrows to final
arrow3 = FancyArrowPatch((6.2, 1.5), (6.2, 0.9),
                        arrowstyle="->", mutation_scale=18,
                        color=COL["ink"], linewidth=1.5)
ax.add_patch(arrow3)
arrow4 = FancyArrowPatch((12.0, 4.0), (7.5, 0.9),
                        arrowstyle="->", mutation_scale=18,
                        color=COL["ash"], linewidth=1.5)
ax.add_patch(arrow4)

# Wall-ratio input box (small)
ax.text(12.0, 5.4, "input: $w$ = wall ratio\n(= 1 − roadFrac)",
        ha="center", va="center", fontsize=8, color=COL["ink"], style="italic")
arrow_w = FancyArrowPatch((12.0, 5.1), (12.0, 4.9),
                         arrowstyle="->", mutation_scale=10,
                         color=COL["ink"], linewidth=0.8)
ax.add_patch(arrow_w)

# Bottom: legend
ax.text(7, -1.0,
        "Inputs: 8 sub-metrics in [0,1]  →  2 aggregates  →  min-balance  →  × wall gate  →  final score ∈ [0,1]",
        ha="center", va="center", fontsize=9, color=COL["ink"], style="italic",
        bbox=dict(boxstyle="round,pad=0.3", facecolor=COL["paper"], edgecolor=COL["ink"], linewidth=0.6))

# Footnote
ax.text(7, -1.7,
        r"All sub-metrics: continuous, differentiable. ES-friendly. $\min$ enforces parity; wall gate filters out ``solid block'' and ``empty box'' attractors.",
        ha="center", va="center", fontsize=7, color=COL["ash"], style="italic")

plt.tight_layout()
fig.savefig(OUT, dpi=140, bbox_inches="tight", facecolor=COL["paper"])
plt.close(fig)
print(f"  ✓ {OUT.relative_to(ROOT)}")
