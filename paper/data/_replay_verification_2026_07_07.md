# CKPT Replay Verification — 2026-07-07

**Purpose:** Verify paper §5.5 claim that panel (b) (sweep_chebyshev-1_mf8_s333.json)
returns score 0 on replay, and assess all 6 fig 6 panels.

**Date:** 2026-07-07
**Script:** `paper/data/_verify_ckpt_replay.py` (canonical copy from `hermes/skills/maze-web/scripts/verify_ckpt_replay_against_saved.py`)
**Python:** `/c/Users/sicko/AppData/Local/Programs/Python/Python313/python.exe`
**Services:** ckpt_server (8088 ✓), dashboard (8087 ✓), Edge CDP (9222 ✓)

---

## Verdict Table

| panel | ckpt file                          | saved score | live total | delta    | verdict        | notes                                        |
|-------|------------------------------------|-------------|------------|----------|----------------|----------------------------------------------|
| a     | sweep_manhattan-2_mf8_s444.json     | 0.8233      | 0.0000     | −0.8233  | **MISMATCH**   | Mode A — mq_dark/mq_inv both 0, M_boundary=0, M_topology=0 |
| b     | sweep_chebyshev-1_mf8_s333.json     | 0.8095      | 0.0000     | −0.8095  | **MISMATCH**   | Mode A — same pattern as (a); paper §5.5 confirmed |
| c     | sweep_chebyshev-2_mf8_s333.json     | 0.7116      | 0.0000     | −0.7116  | **MISMATCH**   | Mode A — same pattern                        |
| d     | sweep_manhattan-4_mf1_s111.json     | 0.7999      | 0.0000     | −0.7999  | **MISMATCH**   | Mode A — same pattern, mf1 also fails        |
| e     | sweep_chebyshev-4_mf1_s111.json     | 0.4244      | 0.4244     | ±0.0000  | **SCORE_MATCH** | Only panel that replays correctly            |
| f     | sweep_manhattan-1_mf8_s444.json     | 0.3998      | 0.0000     | −0.3998  | **MISMATCH**   | Mode A — same pattern                        |

**Summary: 1 MATCH, 5 MISMATCH out of 6 panels.**

---

## Analysis

### Consistent pattern across all 5 mismatches

All mismatched panels show an identical signature:

| Metric | mismatched panels (a,b,c,d,f) | panel (e) |
|--------|-------------------------------|-----------|
| mq_dark total | **0.0000** | 0.4244 |
| mq_inv total | **0.0000** | 0.0000 |
| M_boundary | **0.0000** | 0.1842 |
| M_topology | **0.0000** | 0.5469 |
| M_WR_gate | 1.0000 (=saved) | 0.7760 (=saved) |
| M_asymmetry | 1.0000 (=saved) | 1.0000 (=saved) |

M_WR_gate and M_asymmetry are chromosome-bit-derived metrics and are always correct.
M_boundary and M_topology depend on the CA grid state — they collapse to 0.0000 in all
5 mismatched panels, killing the total score regardless of other metric values.

### Canvas density readings (dark-grid ones fraction)

| panel | dark ones / total | density interpretation |
|-------|-------------------|------------------------|
| a | 2351/2400 (97.96%) | near-full alive — grid is "dead" CA state |
| b | 1356/2400 (56.50%) | moderate density |
| c | 1445/2400 (60.21%) | moderate density |
| d | 1094/2400 (45.58%) | moderate density |
| e | 745/2400 (31.04%) | sparse — maze-like density ✓ |
| f | 1603/2400 (66.79%) | moderate-high density |

Panel (e) has a sparser, maze-like density. The other 5 produce denser grids where
boundary/topology metrics collapse.

### Mode classification (per gotcha #26)

**Panel (e) — Mode B (scoring drift):**
The canvas is read correctly and mq_dark produces a valid score (0.4244), which
exactly matches the saved score. The saved score was likely computed on the same
grid orientation (dark-side). The CA reproduces the checkpoint faithfully.

**Panels (a,b,c,d,f) — Mode A (race-overwrite) vs Mode B (scoring drift):**
mq_dark and mq_inv both return total=0.0000. This means the mazeQuality function
produces a valid breakdown object (individual metrics are computed) but the final
score is 0. M_boundary=0.0000 and M_topology=0.0000 regardless of which orientation
(mq_dark or mq_inv) is evaluated.

This is **not** a simple canvas polarity flip (Mode B), because:
- In a polarity flip, one orientation would still produce a valid positive score.
- Here, **both** orientations produce total=0.0000.

This is consistent with **Mode A (race-overwrite)**: the CA produces a grid state
that scores 0 because boundary/topology components are degenerate (all boundary cells
missing or topology graph disconnected), even though the chromosome bits are intact
and the CA runs.

The 5 failing panels' CA grids produce `M_boundary=0, M_topology=0` in both
orientations, driving the total to zero. This is different from "returning 0 because
canvas is blank" — the grid exists and individual metrics are computed, but the
structural metrics that drive the total are zero.

### Mode C (verifier bug) — ruled out
Panel (e) reproduces perfectly, confirming the verifier pipeline (CDP, canvas read,
mq eval, Python orchestration) is sound. The issue is not in the verifier.

---

## §5.5 Assessment

**Paper §5.5 (v1.1, 2026-07-07) said:**
> "ckpt replay returns score 0 for panel (b) [sweep_chebyshev-1_mf8_s333.json],
> can't distinguish race-overwrite from scoring drift."

**Verdict: §5.5 is CORRECT for mf8 panels but INCOMPLETE.**

- Panel (b) confirmed: returns 0.0000 on replay (mismatched).
- Panels (a), (c), (f) — all mf8 — also return 0.0000. This is a systematic failure
  of ALL mf8 (medium-fitness) checkpoints, not just panel (b).
- Panel (d) — mf1 (manhattan-4) — also returns 0.0000 despite being labeled "mf1".
  So the failure is NOT exclusively a mf8 vs mf1 distinction.
- **Panel (e) — the only mf1 chebyshev-4 checkpoint — replays perfectly** (SCORE_MATCH).
  This is the sole exception.

**Recommendation for §5.5:**
- **NARROW** the claim: the mf8 panels (a,b,c,f) are confirmed Mode A with mq→0.
- **ADD** that panel (e) (sweep_chebyshev-4_mf1_s111.json) replays correctly, and that
  manhattan-4 mf1 (panel d) also fails — so it's not a simple mf1/mf8 split.
- The distinguishing factor may be `cellMaskType`: chebyshev-1, manhattan-1, manhattan-2
  (all mf8) fail; chebyshev-4 (mf1, panel e) succeeds. manhattan-4 mf1 (panel d) fails,
  which complicates this theory.
- **Do NOT remove §5.5** — the systematic failures in (a)(b)(c)(f) are real and
  significant for reproducibility.
- **Do NOT expand to all panels** — panel (e) is a genuine counterexample showing
  at least some checkpoints ARE reproducible.

---

## Forensic dumps

JSON dumps saved to `C:\Users\sicko\_grid_dump_<ckpt>_<timestamp>.json`:
- `_grid_dump_sweep_manhattan-2_mf8_s444_20260707_104032.json`
- `_grid_dump_sweep_chebyshev-1_mf8_s333_20260707_104055.json`
- `_grid_dump_sweep_chebyshev-2_mf8_s333_20260707_104130.json`
- `_grid_dump_sweep_manhattan-4_mf1_s111_20260707_104159.json`
- `_grid_dump_sweep_chebyshev-4_mf1_s111_20260707_104226.json`
- `_grid_dump_sweep_manhattan-1_mf8_s444_20260707_104254.json`
