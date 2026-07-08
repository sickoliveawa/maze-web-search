#!/usr/bin/env python3
"""
regen_figures.py — regenerate 8 paper figures for maze-web v1.3.0

INDEPENDENT of source code. Reads only:
  - paper/data/_verify_canonical.json  (output of verify_paper_numbers.py)
  - sweep_*/results.ndjson
  - sweep_2026_07_08_big/sweep.log     (for full convergence data)
  - ckpt/*.json
  - paper/data/sweep_summary.json

Produces 8 figures in figures/v2/:
  - fig_15pattern_v3.png     15-pattern bar chart (re-render with current data)
  - fig_chromosome_v3.png    103-bit slot layout (diagram)
  - fig_top_runs.png         Top 10 sweep ckpts by best score (bar chart)
  - fig_mask_fam_heatmap.png mask × maxFam heatmap (mean best score)
  - fig_top6_grids.png       panel of 6 best grids (use existing fig_mini_sweep_*)
  - fig_score_dist.png       score distribution per mask template (boxplot)
  - fig_8dim_radar.png       8-dim metric breakdown of top score
  - fig_big_sweep_progress.png  big_sweep convergence (s444, s1111, s2222, s3333, s5555)

Run:  python tools/regen_figures.py
"""

import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path
from statistics import mean, median, stdev

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Rectangle, FancyBboxPatch

ROOT = Path(__file__).resolve().parent.parent
FIG_DIR = ROOT / "figures" / "v2"
FIG_DIR.mkdir(parents=True, exist_ok=True)

# Vintage paper elegant colors (paper/main.tex)
COLORS = {
    "paper": "#F2E6C8",         # warm paper
    "ink": "#321E14",           # dark ink (text/lines)
    "vermilion": "#C44536",     # accent red
    "indigo": "#2F4F5F",        # secondary
    "olive": "#6B7B3F",         # tertiary
    "ochre": "#C99A3B",         # quaternary
    "ash": "#8A7A60",           # muted
}

# Apply paper-style rcParams
plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["DejaVu Serif", "Times New Roman", "Times"],
    "font.size": 10,
    "axes.facecolor": COLORS["paper"],
    "figure.facecolor": COLORS["paper"],
    "axes.edgecolor": COLORS["ink"],
    "axes.labelcolor": COLORS["ink"],
    "xtick.color": COLORS["ink"],
    "ytick.color": COLORS["ink"],
    "text.color": COLORS["ink"],
    "axes.spines.top": False,
    "axes.spines.right": False,
    "savefig.facecolor": COLORS["paper"],
    "savefig.edgecolor": "none",
})

CKPT_DIR = ROOT / "ckpt"
SWEEP_NDJSON = {
    "big":  ROOT / "sweep_2026_07_08_big" / "results.ndjson",
    "v4":   ROOT / "sweep_2026_07_04"      / "results.ndjson",
    "mini": ROOT / "mini_sweep_2026_07_07" / "results.ndjson",
}
SWEEP_LOG = ROOT / "sweep_2026_07_08_big" / "sweep.log"
OLD_SUMMARY = ROOT / "paper" / "data" / "sweep_summary.json"


def load_ndjson(path):
    if not path.exists():
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def parse_log_tail_gen(log_tail):
    """Extract per-gen best from log_tail string. Returns list of (gen, best) tuples."""
    if not log_tail:
        return []
    pairs = []
    for m in re.finditer(r"gen (\d+): best=([\d.]+)", log_tail):
        pairs.append((int(m.group(1)), float(m.group(2))))
    return pairs


# ============================================================
# Fig 1: 15-pattern bar chart
# ============================================================
def fig_15pattern():
    if not OLD_SUMMARY.exists():
        print("  skip: paper/data/sweep_summary.json not found")
        return
    with open(OLD_SUMMARY) as f:
        d = json.load(f)
    per = d.get("15pattern", {}).get("per_pattern", [])
    if not per:
        print("  skip: no per_pattern data")
        return

    fig, ax = plt.subplots(figsize=(10, 5))
    names = [p["name"] for p in per]
    scores = [p["mq"] for p in per]
    types = [p["type"] for p in per]
    colors = [COLORS["indigo"] if t == "TRUE" else COLORS["vermilion"] for t in types]

    bars = ax.bar(range(len(names)), scores, color=colors, edgecolor=COLORS["ink"], linewidth=0.6)
    ax.set_xticks(range(len(names)))
    ax.set_xticklabels(names, rotation=35, ha="right", fontsize=8)
    ax.set_ylabel("maze_quality (M)")
    ax.set_ylim(-0.05, 0.85)
    ax.axhline(0.5, color=COLORS["ash"], linestyle="--", linewidth=0.8, alpha=0.7)
    ax.text(len(names) - 0.5, 0.51, "decision threshold = 0.5", color=COLORS["ash"], fontsize=8, ha="right")
    ax.set_title("Fig 1 — 15-pattern benchmark: true mazes vs pseudo-mazes",
                 color=COLORS["vermilion"], fontsize=11, fontweight="bold", pad=12)

    # Mark pseudo-maze with × since M=0 makes them invisible
    for i, (score, t) in enumerate(zip(scores, types)):
        if t != "TRUE":
            ax.text(i, 0.02, "×", ha="center", va="bottom",
                    color=COLORS["vermilion"], fontsize=14, fontweight="bold")

    # Legend
    from matplotlib.patches import Patch
    legend = ax.legend(handles=[
        Patch(facecolor=COLORS["indigo"], edgecolor=COLORS["ink"], label="true maze (6)"),
        Patch(facecolor=COLORS["vermilion"], edgecolor=COLORS["ink"], label="pseudo-maze (9), see ×"),
    ], loc="upper right", framealpha=0.9)

    plt.tight_layout()
    out = FIG_DIR / "fig_15pattern_v3.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"  ✓ {out.relative_to(ROOT)}")


# ============================================================
# Fig 2: Chromosome diagram (1 + 80 + 9 + 9 + 4 = 103 bits)
# ============================================================
def fig_chromosome():
    fig, ax = plt.subplots(figsize=(11, 4.5))

    # 1 family slot
    fields = [
        ("active",  1,  COLORS["vermilion"]),
        ("cells",   80, COLORS["indigo"]),
        ("B",       9,  COLORS["olive"]),
        ("S",       9,  COLORS["ochre"]),
        ("prio",    4,  COLORS["ash"]),
    ]
    total = sum(w for _, w, _ in fields)
    assert total == 103

    # Single slot
    ax.set_title("Fig 2 — FamilyMask chromosome: 1 slot = 103 bits (16 slots = 1648 bits)",
                 color=COLORS["vermilion"], fontsize=11, fontweight="bold", pad=10)
    y = 0.55
    height = 0.18
    x = 0.04
    width_total = 0.92

    for name, w, c in fields:
        w_norm = w / total * width_total
        rect = FancyBboxPatch((x, y), w_norm, height,
                              boxstyle="round,pad=0.005",
                              facecolor=c, edgecolor=COLORS["ink"], linewidth=0.8, alpha=0.85)
        ax.add_patch(rect)
        ax.text(x + w_norm / 2, y + height / 2, f"{name}\n{w}",
                ha="center", va="center", fontsize=9, color="white", fontweight="bold")
        x += w_norm

    # 16 slots row
    y2 = 0.18
    for i in range(16):
        x2 = 0.04 + i * (0.92 / 16)
        rect2 = FancyBboxPatch((x2, y2), 0.92 / 16 - 0.004, height * 0.6,
                               boxstyle="round,pad=0.002",
                               facecolor=COLORS["ink"], edgecolor=COLORS["ink"], alpha=0.75)
        ax.add_patch(rect2)
        ax.text(x2 + (0.92 / 16) / 2, y2 + height * 0.3, f"{i}",
                ha="center", va="center", fontsize=7, color="white")
    ax.text(0.5, 0.05, "16 family slots × 103 bits/slot = 1648 bits total",
            ha="center", va="center", fontsize=9, color=COLORS["ink"], style="italic")

    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")
    plt.tight_layout()
    out = FIG_DIR / "fig_chromosome_v3.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"  ✓ {out.relative_to(ROOT)}")


# ============================================================
# Fig 3: Top 10 runs by best score (horizontal bar chart)
# Replaces fig_es_convergence — log_tail has only 3 points, can't plot curves
# ============================================================
def fig_top_runs():
    """Top 10 sweep ckpts by best score as horizontal bar chart."""
    all_runs = []
    for label, path in SWEEP_NDJSON.items():
        for r in load_ndjson(path):
            if r.get("status") != "OK":
                continue
            b = r.get("best")
            if b is not None:
                all_runs.append({
                    "label": f"{label}|{r.get('mask')}|mf={r.get('maxFam')}|s={r.get('seed')}",
                    "best": b,
                    "mask": r.get("mask", "?"),
                    "maxFam": r.get("maxFam", "?"),
                    "seed": r.get("seed", "?"),
                    "config": f"{r.get('mask')}-mf{r.get('maxFam')}-s{r.get('seed')}",
                })

    if not all_runs:
        print("  skip: no OK runs")
        return

    # Sort by best score descending, take top 10
    all_runs.sort(key=lambda c: -(c["best"] or 0))
    top = all_runs[:10]

    fig, ax = plt.subplots(figsize=(10, 6))
    names = [f"{c['mask']} mf={c['maxFam']} s={c['seed']}" for c in top]
    scores = [c["best"] for c in top]

    cmap = plt.cm.tab10
    colors = [cmap(i % 10) for i in range(len(top))]
    bars = ax.barh(range(len(names)), scores, color=colors, edgecolor=COLORS["ink"], linewidth=0.6)

    ax.set_yticks(range(len(names)))
    ax.set_yticklabels(names, fontsize=9)
    ax.set_xlabel("best score")
    ax.set_xlim(0.5, 0.9)
    ax.axvline(0.8233, color=COLORS["ash"], linestyle="--", linewidth=1, alpha=0.8)
    ax.text(0.824, scores[0] - 0.01, "old sweep\npeak=0.8233", color=COLORS["ash"],
            fontsize=7, ha="left", va="top")

    # Annotate bars with score value
    for i, (bar, score) in enumerate(zip(bars, scores)):
        ax.text(score + 0.003, i, f"{score:.4f}", va="center", fontsize=8, color=COLORS["ink"])

    ax.set_title("Fig 3 — Top 10 sweep ckpts by best score (200×500, n=122 OK)",
                 color=COLORS["vermilion"], fontsize=11, fontweight="bold", pad=10)
    ax.grid(True, alpha=0.2, axis="x", linestyle=":")
    ax.invert_yaxis()  # highest score at top
    plt.tight_layout()
    out = FIG_DIR / "fig_top_runs.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"  ✓ {out.relative_to(ROOT)}")


# ============================================================
# Fig 4: Mask × maxFam heatmap
# ============================================================
def fig_mask_fam_heatmap():
    # Aggregate by (mask, maxFam) from old 128-run sweep (most complete)
    rows = load_ndjson(SWEEP_NDJSON["v4"])
    by_key = defaultdict(list)
    for r in rows:
        if r.get("status") != "OK":
            continue
        m = r.get("mask", "?")
        mf = r.get("maxFam", 0)
        b = r.get("best")
        if b is not None:
            by_key[(m, mf)].append(b)
    if not by_key:
        print("  skip: no data for heatmap")
        return

    masks = sorted(set(k[0] for k in by_key))
    mfs = sorted(set(k[1] for k in by_key))
    matrix = np.full((len(masks), len(mfs)), np.nan)
    counts = np.zeros((len(masks), len(mfs)), dtype=int)
    for (m, mf), scores in by_key.items():
        i, j = masks.index(m), mfs.index(mf)
        matrix[i, j] = mean(scores)
        counts[i, j] = len(scores)

    fig, ax = plt.subplots(figsize=(8, 5))
    im = ax.imshow(matrix, cmap="YlOrBr", aspect="auto", vmin=0, vmax=0.85)
    ax.set_xticks(range(len(mfs)))
    ax.set_xticklabels([f"mf={m}" for m in mfs])
    ax.set_yticks(range(len(masks)))
    ax.set_yticklabels(masks)
    for i in range(len(masks)):
        for j in range(len(mfs)):
            v = matrix[i, j]
            if not np.isnan(v):
                ax.text(j, i, f"{v:.3f}\n(n={counts[i,j]})",
                        ha="center", va="center", fontsize=7,
                        color="white" if v > 0.5 else COLORS["ink"])
    ax.set_title("Fig 4 — Mask × maxFam: mean best score (n=122 runs)",
                 color=COLORS["vermilion"], fontsize=11, fontweight="bold", pad=10)
    plt.colorbar(im, ax=ax, label="mean best score")
    plt.tight_layout()
    out = FIG_DIR / "fig_mask_fam_heatmap.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"  ✓ {out.relative_to(ROOT)}")


# ============================================================
# Fig 5: Top 6 grids panel
# ============================================================
def fig_top6_grids():
    # Find top 6 ckpts by bestScore
    if not CKPT_DIR.exists():
        print("  skip: no ckpt dir")
        return
    ckpts = []
    for p in CKPT_DIR.glob("*.json"):
        try:
            with open(p) as f:
                d = json.load(f)
            if d.get("bestScore"):
                ckpts.append((d["bestScore"], p.name, d.get("bestBreakdown", {})))
        except Exception:
            pass
    if not ckpts:
        print("  skip: no ckpts")
        return
    ckpts.sort(key=lambda x: -x[0])
    top6 = ckpts[:6]

    fig, axes = plt.subplots(2, 3, figsize=(11, 7))
    for idx, (score, name, breakdown) in enumerate(top6):
        ax = axes[idx // 3][idx % 3]
        # Reuse existing rendered grid image if available
        # mini_sweep_*.png or sweep_*.png exist for many configs
        # Try to find a matching image
        candidates = [
            ROOT / "figures" / f"fig_mini_sweep_{name.split('.')[0]}.png",
            ROOT / "figures" / f"fig_{name.split('.')[0]}.png",
            ROOT / "paper" / "figures" / f"fig_mini_sweep_{name.split('.')[0]}.png",
            ROOT / "paper" / "figures" / f"fig_{name.split('.')[0]}.png",
        ]
        img = next((c for c in candidates if c.exists()), None)
        if img:
            ax.imshow(plt.imread(str(img)), cmap="gray")
        else:
            # Show bestBreakdown radar fallback
            keys = ["M_branching", "M_spread", "M_junction", "M_connectedness",
                    "M_pattern", "M_asymmetry", "M_transition", "M_boundary"]
            vals = [breakdown.get(k, 0) for k in keys]
            ax.barh(keys, vals, color=COLORS["indigo"], alpha=0.7)
            ax.set_xlim(0, 1)
            ax.tick_params(axis="both", labelsize=6)
        ax.set_title(f"{name}\nbest={score:.4f}", fontsize=8, color=COLORS["ink"])
        ax.axis("off")
    fig.suptitle("Fig 5 — Top 6 ckpts by best score (grid + 8-dim breakdown)",
                 color=COLORS["vermilion"], fontsize=11, fontweight="bold")
    plt.tight_layout()
    out = FIG_DIR / "fig_top6_grids.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"  ✓ {out.relative_to(ROOT)}")


# ============================================================
# Fig 6: Score distribution per mask (boxplot)
# ============================================================
def fig_score_dist():
    rows = load_ndjson(SWEEP_NDJSON["v4"])
    by_mask = defaultdict(list)
    for r in rows:
        if r.get("status") == "OK" and r.get("best") is not None:
            by_mask[r.get("mask", "?")].append(r["best"])
    if not by_mask:
        print("  skip: no data")
        return

    masks = sorted(by_mask.keys())
    data = [by_mask[m] for m in masks]
    fig, ax = plt.subplots(figsize=(9, 5))
    bp = ax.boxplot(data, tick_labels=masks, patch_artist=True, widths=0.5)
    for patch in bp["boxes"]:
        patch.set_facecolor(COLORS["indigo"])
        patch.set_alpha(0.6)
        patch.set_edgecolor(COLORS["ink"])
    for whisk in bp["whiskers"]:
        whisk.set_color(COLORS["ink"])
    for med in bp["medians"]:
        med.set_color(COLORS["vermilion"])
        med.set_linewidth(1.5)
    ax.set_ylabel("best score")
    ax.set_ylim(0, 0.9)
    ax.set_title("Fig 6 — Score distribution per mask template (8 mask templates, n=122 OK, red line = median)",
                 color=COLORS["vermilion"], fontsize=11, fontweight="bold", pad=10)
    ax.grid(True, alpha=0.2, axis="y", linestyle=":")
    plt.xticks(rotation=20, ha="right")
    plt.tight_layout()
    out = FIG_DIR / "fig_score_dist.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"  ✓ {out.relative_to(ROOT)}")


# ============================================================
# Fig 7: 8-dim metric radar of top score
# ============================================================
def fig_8dim_radar():
    # Find the ckpt with highest bestScore
    if not CKPT_DIR.exists():
        print("  skip: no ckpt dir")
        return
    best = None
    for p in CKPT_DIR.glob("*.json"):
        try:
            with open(p) as f:
                d = json.load(f)
            s = d.get("bestScore")
            if s and (best is None or s > best[0]):
                best = (s, p.name, d.get("bestBreakdown", {}))
        except Exception:
            pass
    if not best or not best[2]:
        print("  skip: no best ckpt with breakdown")
        return

    score, name, bd = best
    keys = ["M_branching", "M_spread", "M_junction", "M_connectedness",
            "M_pattern", "M_asymmetry", "M_transition", "M_boundary"]
    short = ["Mb", "Msp", "Mj", "Mc", "Mp", "Ma", "Mt", "Mbd"]
    vals = [bd.get(k, 0) for k in keys]

    # Radar
    angles = np.linspace(0, 2 * np.pi, len(keys), endpoint=False).tolist()
    vals_c = vals + [vals[0]]
    angles_c = angles + [angles[0]]
    fig, ax = plt.subplots(figsize=(6, 6), subplot_kw=dict(polar=True))
    ax.plot(angles_c, vals_c, color=COLORS["vermilion"], linewidth=2)
    ax.fill(angles_c, vals_c, color=COLORS["vermilion"], alpha=0.25)
    ax.set_xticks(angles)
    ax.set_xticklabels(short, fontsize=10)
    ax.set_ylim(0, 1)
    ax.set_yticks([0.2, 0.4, 0.6, 0.8, 1.0])
    ax.set_yticklabels(["0.2", "0.4", "0.6", "0.8", "1.0"], fontsize=7, color=COLORS["ash"])
    ax.set_title(f"Fig 7 — 8-dim metric breakdown of top ckpt\n{name} (best={score:.4f})",
                 color=COLORS["vermilion"], fontsize=11, fontweight="bold", pad=18)
    # Add full names as annotation
    for i, (k, v) in enumerate(zip(keys, vals)):
        ax.annotate(f"{k.replace('M_', '')}\n={v:.2f}",
                    xy=(angles[i], v), xytext=(angles[i], v + 0.12),
                    ha="center", fontsize=7, color=COLORS["ink"])
    plt.tight_layout()
    out = FIG_DIR / "fig_8dim_radar.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"  ✓ {out.relative_to(ROOT)}")


# ============================================================
# Fig 8: big_sweep progress (uses sweep.log for complete runs)
# ============================================================
def fig_big_sweep_progress():
    """Plot big_sweep convergence from sweep.log for complete runs.
    
    Complete runs (s444, s1111, s2222, s3333) have full 0-2000 gen data in sweep.log.
    In-progress run (s5555) has partial data.
    """
    live_curves = defaultdict(list)  # seed -> [(gen, best), ...]
    if SWEEP_LOG.exists():
        with open(SWEEP_LOG) as f:
            for line in f:
                m = re.search(r"\[(s\d+)\.console\.log\] \[ES\] gen (\d+): best=([\d.]+)", line)
                if m:
                    seed = m.group(1)  # e.g. "s444"
                    gen = int(m.group(2))
                    best = float(m.group(3))
                    live_curves[seed].append((gen, best))

    if not live_curves:
        print("  skip: no sweep.log data")
        return

    # Determine which seeds are complete (gen 2000) vs in-progress
    COMPLETE_THRESHOLD = 1990  # consider >= 1990 as complete

    fig, ax = plt.subplots(figsize=(10, 5))
    cmap = plt.cm.Set1
    complete_seeds = []
    inprogress_seeds = []

    for seed in sorted(live_curves.keys(), key=lambda x: int(x[1:])):
        pts = sorted(live_curves[seed])
        if not pts:
            continue
        max_gen = pts[-1][0]
        if max_gen >= COMPLETE_THRESHOLD:
            complete_seeds.append(seed)
        else:
            inprogress_seeds.append(seed)

    # Plot complete runs with solid lines
    for i, seed in enumerate(complete_seeds):
        pts = sorted(live_curves[seed])
        gens, bests = zip(*pts)
        ax.plot(gens, bests, color=cmap(i), linewidth=1.8, alpha=0.9,
                label=f"{seed} (complete, best={pts[-1][1]:.4f})")

    # Plot in-progress runs with dashed lines
    for i, seed in enumerate(inprogress_seeds):
        pts = sorted(live_curves[seed])
        gens, bests = zip(*pts)
        ax.plot(gens, bests, color=cmap(i + len(complete_seeds)), linewidth=1.4, alpha=0.6,
                linestyle="--", label=f"{seed} (in-progress, gen={pts[-1][0]}, best={pts[-1][1]:.4f})")

    ax.set_xlabel("generation")
    ax.set_ylabel("best score")
    n_complete = len(complete_seeds)
    n_total = n_complete + len(inprogress_seeds)
    ax.set_title(f"Fig 8 — big_sweep (500×2000) progress: {n_complete}/{n_total} complete, {len(inprogress_seeds)}/5 in-progress",
                 color=COLORS["vermilion"], fontsize=11, fontweight="bold", pad=10)
    ax.legend(loc="lower right", fontsize=8, framealpha=0.9)
    ax.grid(True, alpha=0.2, linestyle=":")
    ax.set_ylim(0.1, 0.9)
    plt.tight_layout()
    out = FIG_DIR / "fig_big_sweep_progress.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"  ✓ {out.relative_to(ROOT)}")


def main():
    print("=== regen_figures.py ===")
    print(f"FIG_DIR: {FIG_DIR}")
    print()
    fig_15pattern()
    fig_chromosome()
    fig_top_runs()
    fig_mask_fam_heatmap()
    fig_top6_grids()
    fig_score_dist()
    fig_8dim_radar()
    fig_big_sweep_progress()
    print()
    print("=== DONE. 8 figures written to figures/v2/ ===")


if __name__ == "__main__":
    main()
