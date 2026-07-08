# Fig 6 v2 Checkpoint Replay Verification — 2026-07-07

## Summary

Re-ran the verifier on the **two ckpts that fig 6 v2 actually uses** (mf=2),
not the mf=8 ckpts a previous subagent incorrectly tested.

**Result: BOTH panels MISMATCH (0.0000 live score).**

---

## Panel Details

### Panel C — `sweep_chebyshev-2_mf2_s333.json`
| Field | Value |
|-------|-------|
| saved bestScore | 0.8080 |
| live best | **0.0000** |
| delta | −0.8080 |
| **Verdict** | **MISMATCH** |

Key breakdown deltas (largest):
- M_boundary: live=0.0000 vs saved=1.0000 (delta=−1.0000)
- M_connectedness: live=0.0600 vs saved=0.9755 (delta=−0.9155)
- M_topology: live=0.0000 vs saved=0.8463 (delta=−0.8463)
- M_spread: live=0.0267 vs saved=0.5605 (delta=−0.5339)
- M_branching: live=0.1253 vs saved=0.5976 (delta=−0.4722)
- M_asymmetry: live=0.5000 vs saved=1.0000 (delta=−0.5000)

Canvas state: 750/2400 dark-grid ones vs saved bitsOnes=51/1648 — **completely different occupancy**.

### Panel F — `sweep_manhattan-1_mf2_s444.json`
| Field | Value |
|-------|-------|
| saved bestScore | 0.4240 |
| live best | **0.0000** |
| delta | −0.4240 |
| **Verdict** | **MISMATCH** |

Key breakdown deltas (largest):
- M_branching: live=0.1253 vs saved=0.6754 (delta=−0.5500)
- M_junction: live=0.8611 vs saved=0.1485 (delta=+0.7126)
- M_connectedness: live=0.0600 vs saved=0.5253 (delta=−0.4653)
- M_boundary: live=0.0000 vs saved=0.4211 (delta=−0.4211)
- M_topology: live=0.0000 vs saved=0.4283 (delta=−0.4283)
- M_asymmetry: live=0.5000 vs saved=1.0000 (delta=−0.5000)

Canvas state: same 750/2400 dark-grid ones vs saved bitsOnes=25/1648 — **completely different occupancy**.

---

## Shared Symptoms (both panels)

1. **mq_dark = 0.0000, mq_inv = 0.0000** — scoring function returns zeros; the canvas state does not match the checkpoint's evolved grid at any meaningful level
2. **M_boundary = 0.0000 live** for both — boundary metric broken or evaluates to zero regardless of grid state
3. **M_asymmetry always 0.5000** regardless of ckpt — asymmetry metric appears to have a constant fallback value
4. **dark-grid ones always 750/2400 (0.3125)** — the replay produces the same canvas for both completely different checkpoints, suggesting the 30-step replay path is not faithfully reproducing the ckpt-specific evolution
5. **chromHash mismatch**: Python computes different hashes than the ckpt's stored `chromHash` (e.g. 521755195 vs whatever JS computed at save time) — indicating either hash algorithm mismatch or the bits are already diverged at init

---

## Mode Classification

Both panels exhibit **Mode C** (figure is broken / non-reproducible):
- The live replay produces a canvas with ~750 dark cells for both panels regardless of checkpoint
- The saved checkpoints expect ~51 (panel c) and ~25 (panel f) dark cells respectively
- This is not a scoring drift issue (gotcha #18) — it's a **canvas state divergence** from step 0
- The fact that both mf=2 and mf=8 ckpts fail the same way (all zeros) suggests a systematic regression in the replay pipeline, not a specific checkpoint corruption

---

## Recommendation

**Option (c) — widen §5.5 scope to include figure reproducibility:**

The paper currently states reproducibility is demonstrated for "panel b only." Since panels c and f (the other two figure panels) are also non-reproducible under the current browser/GPU stack, §5.5 should be updated to acknowledge:

1. Panels b, c, f all fail to reproduce with current browser GPU
2. The figure-as-shipped uses panels b/c/f but only panel b is reproducible
3. Or: rebuild fig 6 v2 with checkpoints that actually replay correctly (mf=2 ckpts that pass the verifier)

**Immediate action**: Do not tighten §5.5 to 44h — the figure itself is already broken, so the timeline tightening is insufficient. The paper needs either (i) a note that fig 6 v2 is historical and not reproducible, or (ii) a rebuild of the figure with valid checkpoints.

---

## Raw Verifier Outputs

Dumped grids:
- `C:\Users\sicko\_grid_dump_sweep_chebyshev-2_mf2_s333_20260707_105816.json`
- `C:\Users\sicko\_grid_dump_sweep_manhattan-1_mf2_s444_20260707_105816.json`
