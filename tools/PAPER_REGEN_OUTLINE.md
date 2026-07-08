# Paper v1.3.0 Rewrite — Subagent Brief

**Mission:** Rewrite `paper/sections/05-experiments.tex`, `06-discussion.tex`, `07-conclusion.tex` using NEW `big_sweep` data + 8 regenerated figures. The existing v1.2.1 paper cited old 200×500 sweep numbers; we now have a 500×2000 sweep (`sweep_2026_07_08_big`) in progress (2/5 runs complete, 1/5 in progress, 2/5 pending) that supersedes them.

---

## 🚨 CRITICAL CONSTRAINTS

1. **DO NOT read `src/` source code.** Source-code-independent = "verification method" requirement. The only files you may read are:
   - `paper/sections/*.tex` (the paper itself, for style reference and existing content)
   - `paper/data/_verify_canonical.{json,md}` (the verification method output)
   - `paper/data/sweep_summary.json` (15-pattern benchmark, pre-computed)
   - `tools/verify_paper_numbers.py` and `tools/regen_figures.py` (read these to understand what they output, but you don't need to modify them)
   - `figures/v2/fig_*.png` (the 8 regenerated figures)
   - Existing `figures/fig_mini_sweep_*.png` and `paper/figures/fig_*.png` (pre-rendered grid images)
2. **Every number in your new text MUST appear in `paper/data/_verify_canonical.{json,md}`.** If a number isn't there, it's not allowed.
3. **Style is fixed:** vintage paper elegant (warm paper + vermilion + Times serif + 5 specimen-card boxes). Use the existing `templates/academic_paper_style.tex` if you need a reference.
4. **Output:** 3 new `.tex` files (replacing 05/06/07) + recompile to `paper/main_v1.3.pdf` (separate from `main_v1.2.pdf`).

---

## 🛠 STEP 1: Run the tools (no code reading needed)

```bash
cd E:/doro/maze-web
python tools/verify_paper_numbers.py   # writes paper/data/_verify_canonical.{json,md}
"C:/Users/sicko/AppData/Local/Programs/Python/Python313/python.exe" tools/regen_figures.py
# writes 8 figures/v2/fig_*.png
```

Then read `paper/data/_verify_canonical.md` end-to-end. This is your **single source of truth**.

---

## 📊 STEP 2: Headline numbers to use

From `_verify_canonical.md` "Headline Numbers" section:

| Field | Value |
|---|---|
| `big_sweep_status` | "PARTIAL: 2/5 runs complete (s444, s1111), s2222 in progress (~30% done), s3333/s6666 pending" |
| `big_sweep_top_score` | 0.8195 |
| `big_sweep_top_config` | `{mask: 'manhattan-2', maxFam: 8, seed: 444}` |
| `old_128run_top_score` | 0.823277 (manhattan-2, mf8, s444) — for comparison, "old sweep" |
| `chromosome_bits_per_family` | 103 |
| `chromosome_total_bits_16fam` | 1648 |
| `search_space_per_family` | "2^103 (single family); 2^1648 (full 16-family chromosome)" |

---

## 📊 STEP 3: Ablation numbers to use

From `_verify_canonical.md` "Family Cap Ablation" section:
- mf=1: 0.6984
- mf=2: 0.6688
- mf=4: 0.6382
- mf=8: 0.6306

From "Mask Template Ablation":
- chebyshev-1: 0.7726
- chebyshev-2: 0.7438
- chebyshev-3: 0.7764
- chebyshev-4: 0.1573 (THE smoking gun: 9×9 search space, fails)
- manhattan-1: 0.4205 (4-neighbor, no corridor context)
- manhattan-2: 0.7777
- manhattan-3: 0.7714
- manhattan-4: 0.7517

---

## 📊 STEP 4: 15-pattern benchmark

From `_verify_canonical.md`:

| Metric | maze_quality | Bellot F |
|---|---|---|
| true mazes mean | 0.711 | 100.882 |
| pseudo-mazes mean | 0.000 | 292.205 |
| gap | +0.711 | -191.323 |
| misclassifications | 0/9 | 2/9 (Spiral F=11.85 < DFS F=15.33; 3× F=0 patterns) |

**Smoking gun:** Bellot F ranks Spiral (pseudo, F=11.85) BELOW DFS (true, F=15.33) — i.e., Bellot F says "Spiral is more maze-like than DFS", which is the wrong sign.

---

## 🖼 STEP 5: 8 figures to embed

All in `figures/v2/`:

| File | Use in section | Caption idea |
|---|---|---|
| `fig_15pattern_v3.png` | §2 (related) or §6 (discussion) | "15-pattern benchmark: maze_quality vs Bellot F" |
| `fig_chromosome_v3.png` | §3 (FamilyMask) | "FamilyMask chromosome: 103 bits per slot, 16 slots = 1648 bits" |
| `fig_es_convergence.png` | §5 (experiments) | "ES convergence: top 8 runs by final best score" |
| `fig_mask_fam_heatmap.png` | §5 | "Mask × maxFam heatmap: mean best score (n=128 runs from 200×500 sweep)" |
| `fig_top6_grids.png` | §6 (discussion) | "Top 6 ckpts: grid + 8-dim breakdown" |
| `fig_score_dist.png` | §5 | "Score distribution per mask template (n=122 OK runs)" |
| `fig_8dim_radar.png` | §6 | "8-dim metric breakdown of top ckpt" |
| `fig_big_sweep_progress.png` | §5 (new section or part of §5.3) | "big_sweep (500×2000) progress: 2/5 complete, 1/5 in progress" |

**Style requirement:** use vintage paper elegant frame. See existing `paper/figures/fig_*.png` for the style.

---

## 📝 STEP 6: §5 Experiments rewrite — required structure

The new §5 should be restructured as:

1. **§5.1 Setup** (shorter) — describes pop=500, gens=2000, 8 distance templates, 4 family caps, 5 seeds (only 2 done in big_sweep; old 200×500 sweep had pop=200, gens=500, 4 seeds, n=128 total)
2. **§5.2 Big Sweep Results (500×2000)** — partial, n=2/5, best=0.8195 (manhattan-2/mf8/s444), comparison with old 200×500 best=0.8233
3. **§5.3 Old Sweep Statistics (200×500, n=128)** — use the full ablation numbers (mf=1..8, mask templates). This is the n=128 sweep already in `paper/data/sweep_summary.json`.
4. **§5.4 Mask × Family Ablation** — heatmap discussion. chebyshev-4 (0.157) and manhattan-1 (0.420) are the two failure modes — different mechanisms (search space too big vs spatial context too small).
5. **§5.5 Discussion** — "two attractor classes": (i) budget-limited (chebyshev-4, 2^103 search space vs 10^5 budget) vs (ii) representation-limited (manhattan-1, 4-neighbor can't carry corridor context)

**Required to reference:** Fig 3 (convergence), Fig 4 (heatmap), Fig 6 (distribution), Fig 8 (big_sweep progress), and the smoke-gun numbers from §5.4.

---

## 📝 STEP 7: §6 Discussion rewrite — required structure

1. **§6.1 Family Capacity Paradox** — mf=1 (0.6984) > mf=8 (0.6306) on mean, but mf=8 owns the global max (0.8233). "均值降 / 峰值升" — a classic exploration/exploitation trade-off with multi-family search.
2. **§6.2 Failure Mode Separation** — chebyshev-4 (search-space failure: 2^103 vs 10^5 budget) vs manhattan-1 (representation failure: 4-neighbor insufficient). These are MECHANISTICALLY different, not just "low-scoring".
3. **§6.3 Bellot F Smoking Gun** — 4/9 pseudo-mazes misclassified by Bellot F (including Spiral F=11.85 < DFS F=15.33). maze_quality has 0/9. This is the core contribution: a metric that gets the right answer.
4. **§6.4 What big_sweep tells us** — 2/5 done, max=0.8195 < old max=0.8233. Discuss: bigger pop×gens didn't strictly dominate, suggests the 200×500 sweep was already near saturation for manhattan-2/mf8.

**Required to reference:** Fig 1 (15-pattern), Fig 5 (top 6 grids), Fig 7 (8-dim radar).

---

## 📝 STEP 8: §7 Conclusion rewrite

1. FamilyMask: 2^103 per family, 2^1648 total — 16 families × 103 bits
2. maze_quality: 0/9 misclassifications on 15-pattern benchmark, vs Bellot F 2/9
3. Big sweep: 2/5 done, best=0.8195 — v1.3.1 hotfix pending when s2222/s3333/s6666 complete
4. The "偶发突破" insight: mf=8 has the worst mean but owns the global max

---

## 🔨 STEP 9: Recompile and ship

After writing the 3 .tex files:

```bash
cd E:/doro/maze-web/paper
xelatex -interaction=nonstopmode main_v1.3.tex
xelatex -interaction=nonstopmode main_v1.3.tex
# Output: main_v1.3.pdf (with 8 new figures embedded)
```

(Note: paper template `main.tex` includes `\input{sections/05-experiments}` etc. — to ship v1.3, copy `main_v1.2.tex` to `main_v1.3.tex` and change the `\title` if needed. Or just keep `main_v1.2.tex` and replace the .tex files in `sections/` — your call, but document which.)

---

## ✅ STEP 10: Verification before commit

Before committing, manually cross-check:

- [ ] Every number in your new §5/§6/§7 appears in `paper/data/_verify_canonical.md`
- [ ] No number in `_verify_canonical.md` is contradicted by your text
- [ ] All 8 figures from `figures/v2/` are referenced (or omit any that don't fit)
- [ ] 2^103 and 2^1648 are used (not 2^824) — the typo fix from v1.2.1 must NOT regress
- [ ] "big_sweep PARTIAL n=2/5" is clearly disclosed (don't claim "fully completed")
- [ ] Vintage paper elegant style preserved
- [ ] Recompile produces 0 LaTeX errors

---

## 📋 DELIVERABLE

Report back to me (the parent hermes agent) with:
1. List of files modified
2. Confirmation that all numbers cross-check against `_verify_canonical.md`
3. Path to `paper/main_v1.3.pdf` (or wherever you output the new PDF)
4. Recompile log tail (last 5 lines)
5. Any deviations from this outline + reason

The parent agent will then review, commit, and send to user.
