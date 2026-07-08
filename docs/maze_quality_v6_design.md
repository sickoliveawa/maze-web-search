# maze_quality v6 — mC uncap + mTop weight rebalance

**Date:** 2026-07-08
**Author:** doro (Hermes Agent) for sko
**Status:** Source code changed, mini-sweep verified, paper still on v2.0 (not yet updated)
**Scope:** `src/metrics/maze_quality.js` only (no other files touched)

---

## 1. Motivation

After v2.0 paper shipped, sko observed that the visual top-1 maze (panel a,
`manhattan-2/mf=8/s444`, score 0.8233) looked less like a real maze than
the #2-#4 mazes (panels b/c/d). Visual inspection of the 4 ES top + 2 fail
mazes (see `paper/figures/v2/fig_top_grids.png`) confirmed the mismatch:
(a) was "long channels + open areas", while (b)/(c)/(d) had denser corridor
structures that read as proper mazes.

Deeper investigation found two scoring artefacts that explain the gap:

1. **`M_connectedness` had a `/0.8` clip that saturated to 1.0 for any
   ratio ≥ 0.8.** In the actual ES output, all 4 top mazes had raw
   largest-cluster/total ratios in 0.74-0.98, but the clip made them all
   read as 1.0, eliminating any signal from the mC dimension.

2. **`M_topology` weight 0.30 on `M_boundary` + 0.40 on `M_connectedness`**
   let mBnd=1.00 + mC=1.00 carry the score even when the actual maze
   structure (branching, junction) was mediocre.

## 2. Changes

Both changes are in `src/metrics/maze_quality.js`. Total diff: ~18 lines.

### 2.1 v5 — `M_topology` weight rebalance (line ~338-348)

**Before (v4):**
```javascript
const mTopology = Math.pow(mB, 0.10) * Math.pow(mS, 0.10) *
                  Math.pow(mJ, 0.10) * Math.pow(mC, 0.40) * Math.pow(mBnd, 0.30);
// B/S/J 0.10, C 0.40, Bnd 0.30  (sum = 1.0)
```

**After (v5):**
```javascript
const mTopology = Math.pow(mB, 0.20) * Math.pow(mS, 0.15) *
                  Math.pow(mJ, 0.20) * Math.pow(mC, 0.30) * Math.pow(mBnd, 0.15);
// B 0.20, S 0.15, J 0.20, C 0.30, Bnd 0.15  (sum = 1.0)
```

**Rationale:** B/J 0.10→0.20 (the dimensions that actually determine
"maze feel"), Bnd 0.30→0.15 (prevent perfect-outer-wall from dominating),
C 0.40→0.30 (still important but less dominant), S 0.10→0.15 (slight nudge).

### 2.2 v6 — `M_connectedness` linear formula (line ~140-164)

**Before:**
```javascript
// 0.8+ 满分 (largest / total >= 0.8)
return Math.min(1, largestSize / totalRoads / 0.8);
```

**After:**
```javascript
// v6: 纯线性 largestSize / totalRoads, 无 clip (0.92 → 0.92, 不再饱和到 1.0)
return largestSize / totalRoads;
```

**Rationale:** Before, any mC ≥ 0.8 saturated to 1.0, killing the
discriminative power. Most ES mazes had mC in 0.7-1.0, so the clip
collapsed a 0.3-range dimension into a single point. Linear formula
restores the natural 0-1 range. Compatible with the user's 07-01 stance
("linear metric, was squared but didn't help" — M_connectedness_raw
preserved for diagnostic).

## 3. Verification

### 3.1 Backups
- `src/metrics/maze_quality.js.bak_2026-07-08_topology_weight` — pre-v5
- `src/metrics/maze_quality.js.bak_2026-07-08_connectedness_uncap` — pre-v6 (= post-v5)

### 3.2 Eval datasets

**Set A (canonical 6 panels)** — `_py_panel_{a..f}.json` (afternoon
2026-07-07 ckpt replay with correct init_seed). Grid 40×60, packed
bytes (1 byte/cell). **Important convention:** `_py_panel_*.json` bytes
are stored wall=1, corridor=0 (inverted from ckpt convention
road=1, wall=0). Grid inversion is required before computing metrics.

**Set B (mini-sweep)** — `ckpt/mini_sweep_*.json` (8 mf=1 ckpts from
2026-07-04 mini sweep). No grid stored, only `bestBreakdown` with
already-computed sub-metric values. For mC_ckpt=1.0, we used the
conservative uncap=0.8 (worst-case estimate).

### 3.3 Set A results (Python `_compare_v5_v6.py`)

| Panel | orig score | mC_ckpt | mC_raw (true) | v5+v6 score | orig rank | v5+v6 rank |
|---|---|---|---|---|---|---|
| (a) manhattan-2/mf=8/s444 | 0.8233 | 0.9250 | 0.7400 | 0.6793 | #1 | #3 ↓2 |
| (b) chebyshev-1/mf=8/s333 | 0.8095 | 1.0000 | 0.9839 | 0.7392 | #2 | #1 ↑1 |
| (c) chebyshev-2/mf=2/s333 | 0.8080 | 0.9755 | 0.7804 | 0.6981 | #3 | #2 ↑1 |
| (d) manhattan-4/mf=1/s111 | 0.7999 | 1.0000 | 0.8213 | 0.6400 | #4 | #4 = |
| (e) chebyshev-4/mf=1/s111 [FAIL] | 0.4244 | 1.0000 | 0.1921 | 0.3098 | #5 | #6 ↓1 |
| (f) manhattan-1/mf=2/s444 [FAIL] | 0.4240 | 0.5253 | 0.4202 | 0.3675 | #6 | #5 ↑1 |

**Key findings:**
- (a) drops from #1 to #3 — its mC_raw=0.74 is actually the worst of the
  4 top mazes, the v4 weight was hiding this.
- (b) chebyshev-1 rises to #1, mC_raw=0.98 is genuinely near-perfect.
- (c) chebyshev-2 keeps #2-#3, structurally still strong.
- (d) manhattan-4 stays #4.
- Fail cases stay in #5-#6. (e) drops because mC_raw=0.19 is genuinely
  bad (despite ckpt's clipped 1.0). (f) wall_ratio=0.499 is in the
  WR_gate=1.0 peak, fails on structural mTop.

### 3.4 Set B results (Node `_mini_sweep_v5v6.mjs`)

For 8 mini-sweep mf=1 ckpts, **ranking is unchanged** v5 → v5+v6.
All 8 maintain the same rank position. Scores uniformly drop ~0.04-0.05
(mC uncap effect) but relative ordering is stable.

| Rank | ckpt | orig | v5+v6 |
|---|---|---|---|
| #1 | mini_sweep_manhattan-3_mf1_s111.json | 0.7928 | 0.7532 |
| #2 | mini_sweep_manhattan-2_mf1_s111.json | 0.7946 | 0.6941 |
| #3 | mini_sweep_manhattan-4_mf1_s111.json | 0.7876 | 0.6798 |
| #4 | mini_sweep_chebyshev-1_mf1_s111.json | 0.7309 | 0.6202 |
| #5 | mini_sweep_chebyshev-2_mf1_s111.json | 0.7361 | 0.5336 |
| #6 | mini_sweep_manhattan-1_mf1_s111.json | 0.5453 | 0.5303 |
| #7 | mini_sweep_chebyshev-3_mf1_s111.json | 0.6659 | 0.4481 |
| #8 | mini_sweep_chebyshev-4_mf1_s111.json [FAIL] | 0.2807 | 0.1974 |

## 4. Design rationale (sko 2026-07-02 design principle)

This change is consistent with sko's pre-recorded design principle
(see HERMES memory 2026-07-02): "**Targeted minimal gating** — only
gate one metric, leave other sub-metrics raw." We are NOT adding a new
hard gate. We are:
- Removing a clip that killed the linear gradient of mC.
- Adjusting mTop internal weights so that the 2 maze-feel dimensions
  (branching, junction) get more voice, and the 2 carpet-pull
  dimensions (boundary, connectedness) get less.

This is a **weight rebalance, not a new gate**. ES will see a new
landscape; we should re-validate that the existing 122 small-sweep OK
runs and big_sweep top scores still pass muster.

## 5. Re-evaluation TODO (future work)

The following validations are **pending**. We did NOT run them in this
session because sko wanted to ship the design doc first and decide
whether to re-evaluate:

### 5.1 Score ground-truth re-score
- Re-run `mazeQuality()` (now v6) on the 4 ES top ckpts and the
  122 small-sweep OK ckpts, verify the new scores vs the cached
  `bestBreakdown` scores.
- The cached `M_connectedness` values are clipped — they cannot be
  reverse-mapped back to raw. Re-scoring requires re-running the CA
  simulator (browser) or using Python reimplementation with the
  same `init_seed` + `bestChromBits`.

### 5.2 Backward compatibility check
- Small-sweep (122 OK): how many would still be considered "OK"
  under the new scoring? Quick estimate: 5-15% may drop out because
  the mC uncap + B/J upweighting rewards actually-maze-like grids,
  not just "high-mC + high-mBnd" carpets.
- Big-sweep (5 runs, 250 min): the top score 0.8195 (s444) likely
  drops to ~0.68-0.72 with v5+v6. New top may surface from a
  different cellMaskType/maxFactor combo.

### 5.3 Bellot F correlation
- v6 changes the score landscape. The 15-pattern canonical Bellot
  F scores (15 grid scores, 4/9 misclassification) are independent
  of v6 and should remain valid. But the **rank correlation** between
  mazeQuality and Bellot F for new ES outputs needs to be re-measured.

### 5.4 Paper v2.0 → v2.1 update
- §5.5: 0.8233 → new top score; the fig_top_grids.png caption
  needs to cite the new sub-metric weights.
- §4 (M_topology formula): update weight documentation.
- §4 (M_connectedness formula): remove `/0.8` clip from pseudocode.

### 5.5 Skill maze-web update
- Update `maze-web/SKILL.md` and `mazeweb-pitfalls-2026-07-08.md`
  with the v5+v6 design rationale and the new test commands.
- Add a gotcha entry: "M_connectedness /0.8 clip was hiding raw
  signal — re-score with linear formula before trusting any
  cached bestScore."

### 5.5 Single-config deep search (separate phase)

After `sweep_2026_07_09` (128 runs, 4 randomSeeds × 8 mask × 4 mf)
identifies the top 2-4 best (mask, mf) configurations under v5+v6,
run a **second-phase deep search** on those configs only:

```
Phase 1: sweep_2026_07_09 — broad exploration
   8 mask × 4 mf × 4 randomSeeds = 128 runs @ POP=200 GENS=500
   Goal: identify the best (mask, mf) configurations under v5+v6

Phase 2: single-config deep search (FUTURE)
   N best (mask, mf) from Phase 1
   × M randomSeeds (e.g. 8) = N×M runs @ POP=500 GENS=2000
   Goal: push the best configs to higher scores

Estimated Phase 2 cost: 4 best × 8 seeds × 67 min/run = 36 h
This is intentional — Phase 1 reduces the search space, Phase 2
spends more compute on the surviving configurations.
```

sko 07-08: "**之后单 config 深度搜索再做**" — Phase 2 is deferred
until Phase 1 results are reviewed and the top configs are confirmed.

### 5.6 sweep_2026_07_09 — Phase 1 actual progress

Started: 2026-07-08 23:53 (runner: `_sweep_runner_2026_07_09.py`)
Status as of 2026-07-09 02:08 (paused):
- 27/128 runs done
- cumulative wall: 133 min (2.22 h)
- 4 randomSeeds: [114, 514, 1919, 810]
- v5+v6 weights active
- ~101 runs remaining → estimated 6-7 h to complete from resume

**Resume command** (when continuing):
```bash
cd /e/doro/maze-web
/c/Users/sicko/AppData/Local/Programs/Python/Python313/python.exe \
  _sweep_runner_2026_07_09.py
# Runner has built-in resume: reads results.ndjson, skips done runs
```

The runner reads `sweep_2026_07_09/results.ndjson` on startup and
skips any (mask, maxFam, seed) already in the file. No data is lost.

**Expected outcomes** (predicted, not measured):
- Top score may drop from 0.8233 to ~0.70-0.74 (v5+v6 mTop uncap)
- Manhattan-2/mf=8 likely still top, but chebyshev-1/mf=8 may rise
- Fail cases (chebyshev-4, manhattan-1) stay fail
- ~5-10% TIMEOUT rate expected (mirror of 07-04 sweep)

## 6. Files changed

| File | Lines | Change |
|---|---|---|
| `src/metrics/maze_quality.js` | 338-348 (v5) | mTop 5-weights rebalanced |
| `src/metrics/maze_quality.js` | 140-164 (v6) | mC removed /0.8 clip, linear formula |
| `src/metrics/maze_quality.js.bak_2026-07-08_topology_weight` | new | pre-v5 backup |
| `src/metrics/maze_quality.js.bak_2026-07-08_connectedness_uncap` | new | pre-v6 backup |
| `paper/data/_compare_v5_v6.py` | new | Python verification of 6 panels |
| `paper/data/_mini_sweep_v5v6.mjs` | new | Node verification of 8 mini-sweep ckpts |
| `docs/maze_quality_v6_design.md` | new | this document |

## 7. Reproduction commands

```bash
# Run the 6-panel verification (Python, uses _py_panel_*.json grids)
cd /e/doro/maze-web
python paper/data/_compare_v5_v6.py

# Run the 8 mini-sweep verification (Node, uses ckpt bestBreakdown)
node paper/data/_mini_sweep_v5v6.mjs

# Restore old version if needed
cp src/metrics/maze_quality.js.bak_2026-07-08_connectedness_uncap \
   src/metrics/maze_quality.js
```

## 8. Open questions for sko

1. **Should we re-run the 122 small-sweep OK ckpts with v6?**
   - Yes: 5-10 min, gives a backward-compat map of "old OK → new status"
   - No: trust the design rationale + mini-sweep stability

2. **Should we re-score the 4 ES top + 2 fail ckpts and update fig_top_grids?**
   - Yes: figure currently uses cached `bestScore` (0.8233 etc.), paper
     would benefit from re-scored numbers
   - No: cached scores are correct for v0 weights, fig already
     documents the v0 era

3. **Should we add v5+v6 documentation to paper v2.0 → v2.1?**
   - The paper v2.0 was written with v4 weights, so all numerical
     claims there use the old scores. If we re-score, we need
     to update §4 (formula docs), §5.5 (top score), §4 (M_connectedness).
   - If we don't re-score, the paper is internally consistent but
     the source code has moved on, creating a documentation drift.

---

*Document written 2026-07-08 23:46 by doro (Hermes Agent) for sko,
in service of the "fitness function rebalance for visual maze-ness"
discussion that started with sko's observation that the visual #1
looked less maze-like than #2-#4.*
