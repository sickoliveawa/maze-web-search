"""Compose final paper figures from real canvas screenshots."""
import os, json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.image as mpimg
from matplotlib.patches import Rectangle

OUT = r'E:/doro/maze-web/figures/v2'
PAPER = '#f4ead8'; INK = '#2c1f17'; CINNABAR = '#b8412f'
SAGE = '#6b7a5c'; GRAY_MID = '#7a6a58'; GRAY_LIGHT = '#a89888'

plt.rcParams.update({
    'font.family': 'serif', 'font.serif': ['Times New Roman', 'DejaVu Serif'],
    'font.size': 9, 'axes.facecolor': PAPER, 'figure.facecolor': PAPER,
    'savefig.facecolor': PAPER, 'pdf.fonttype': 42, 'ps.fonttype': 42,
    'axes.edgecolor': INK, 'text.color': INK, 'xtick.color': INK, 'ytick.color': INK,
    'axes.spines.top': False, 'axes.spines.right': False,
})

# === Figure: Real ES-evolved CA grids (4 best + 2 broken) ===
fig, axes = plt.subplots(2, 3, figsize=(8.0, 5.5))
panels = [
    ('grid_best_overall.png',   'manhattan-2  mf=8  s=444\n0.8233 (overall best)', True),
    ('grid_best_cheb2.png',     'chebyshev-2  mf=2  s=333\n0.8080 (#2)', True),
    ('grid_best_mh4.png',       'manhattan-4  mf=1  s=111\n0.7999 (#4)', True),
    ('grid_best_cheb1.png',     'chebyshev-1  mf=8  s=333\n0.7452 (cheb-1 peak)', True),
    ('grid_broken_cheb4.png',   'chebyshev-4  mf=8  s=444\n0.4288 — search-space failure', False),
    ('grid_stuck_mh1.png',      'manhattan-1  mf=8  s=444\n0.4205 — neighborhood too small', False),
]
for ax, (fn, title, is_best) in zip(axes.flat, panels):
    fp = f'{OUT}/{fn}'
    if os.path.exists(fp):
        img = mpimg.imread(fp)
        ax.imshow(img)
    ax.set_title(title, fontsize=7.5, loc='left', color=INK if is_best else CINNABAR, pad=3)
    ax.set_xticks([]); ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_edgecolor(INK if is_best else CINNABAR)
        spine.set_linewidth(0.7 if is_best else 1.0)
fig.suptitle('CA grids evolved by ES — best four (sage frames) vs two failure modes (cinnabar frames)\nWebGPU evolution strategy · 40×60 grid · 300 CA steps · preview tab step-through',
             fontsize=9, y=0.99, color=INK)
plt.tight_layout(rect=[0, 0, 1, 0.96])
plt.savefig(f'{OUT}/fig_es_grids.png', dpi=200, bbox_inches='tight')
plt.savefig(f'{OUT}/fig_es_grids.pdf', bbox_inches='tight')
plt.close()
print('saved fig_es_grids')

# === Figure: Sweep summary (4-panel) — keep previous good version ===
# already saved fig_sweep_summary.png

# === Figure: True maze gallery + Pseudo maze gallery (using rendered galleries) ===
# already saved

print('\nAll paper figures ready in', OUT)
for f in sorted(os.listdir(OUT)):
    if f.endswith('.png'):
        sz = os.path.getsize(f'{OUT}/{f}')
        print(f'  {f:45s} {sz/1024:.1f} KB')