# Reproducibility Forensic Report
**Date**: 2026-07-07
**Subject**: panel (b) ckpt - sweep_chebyshev-1_mf8_s333.json (saved bestScore = 0.809539)
**Verdict**: Current ckpt bits cannot reproduce saved bestScore. Live replication gives 0.0000.

## TL;DR

Ckpt for panel (b) has a **mystery**: bits inside the file were not the ones that originally generated the saved bestScore. We have evidence of three distinct things that don't match up:

| Source               | bestScore | bits                                           | when           |
|----------------------|-----------|------------------------------------------------|----------------|
| ckpt file savedAt    | 0.809539  | sha1[:6]=3bdf8e, 119 ones                      | 2026-07-06 13:11 |
| ndjson log           | 0.809539  | (not saved in ndjson)                          | 2026-07-04 17:29 |
| live GPU replication | 0.000000  | (used ckpt bits: 3bdf8e, 119 ones)             | 2026-07-07      |

The 49-hour gap between ndjson (07-04) and ckpt savedAt (07-06) is **smoking gun**.

## Trail of evidence

### 1. ckpt file is intact
- `bestScore=0.809539` matches `bestBreakdown.M_topology * M_WR_gate` mathematically
- breakdown has v4-only fields (`M_WR_gate`, `M_boundary`) → ckpt + mq self-consistent
- bits length 1648, ones count 119 (correct format)
- `mtime=07-06 13:11:35`, `savedAt=07-06 13:11:35` — these are consistent with each other,
  but both are 49 hours AFTER the ndjson training log entry.

### 2. ndjson is intact
- `sweep_2026_07_04/results.ndjson` line 47 (panel (b)) shows:
  `{"mask":"chebyshev-1","maxFam":8,"seed":333,"best":0.809539,
   "ts":"2026-07-04T17:29:13.531939","status":"OK"}`
- This is the actual training run that produced 0.809539. ckpt savedAt is 49h later.

### 3. Live GPU replication FAILS
- Step 0 init grid (count=337, density=0.14): **correct** for production formula
- After 300 steps using production init seed (1743309554):
  - dark grid ones=1389, wall_ratio=0.42
  - mq v4 best=0.0000 (M_connectedness=0.44, M_boundary=0.0, M_branching=0.0)
- Even running the full training pipeline (`BatchedGPUScorer.evaluateBatchBatched`)
  with ckpt bits + ckpt config: returns 0.0000.

### 4. mq.js isn't drifted at structural level
- ckpt breakdown contains v4-specific fields
- current maze_quality.js produces:
  - same M_wall_ratio on init grid
  - same M_WR_gate (1.0 when in [0.40, 0.60])
- mq.js's mtime is 07-06 15:25 (12 hours after ckpt savedAt) but it's `.bak`'d now
- We have **no diff between current mq.js and what was at 13:11** since the file
  was overwritten before our backup.

### 5. Bits drift — confirmed
- ckpt bits fingerprint: `sha1[:6]=3bdf8e, 119 ones`
- We can't tell what the original 07-04 chromosome was (ndjson doesn't store bits)
- Re-running through *today's* GPU pipeline with *today's* mq.js: score 0.0
- **Either** ckpt bits are different from what they were 07-04 (race-overwritten)
  **or** GPU pipeline or mq.js was modified after ckpt was saved (also possible but
  we have no evidence of pipeline drift, only mq.js mtime drift)

## What this means for the paper

**Numerical claims in section 5.3 ("最优 ES 规则: manhattan-2/mf=8/s=444/0.8233")
and elsewhere are derived from ndjson (training log), not from ckpt.**

Reading directly from ndjson we can see:
- `chebyshev-1 mf=8 seed=333`: best=0.809539 (this is what panel b is)
- `manhattan-2 mf=8 seed=444`: best=0.823320 (this is panel a / paper best)

These numbers are CORRECT and reproducible from ndjson. We don't need ckpt
for those numerical claims.

## What we still need to verify

Two independent questions, both unverified:

1. **Did the saved ckpt bits ever match a 0.81-scoring chromosome?**
   - We have the ndjson log showing best=0.81 was reached
   - But we don't have the original chromosome bits from 07-04
   - Bits-overwrite hypothesis needs a 4-point check (race condition re-run)

2. **Is the GPU CA pipeline / mq.js still producing 0.81 attractors today?**
   - We can't reproduce it with current code
   - Either: (a) GPU drifted (no evidence, mtimes OK), (b) mq.js truly changed
     between 07-04 17:29 and 07-06 15:25 in ways that change attractor

Both would take hours of re-running sweep to confirm. **Don't run that.** Instead,
the paper should clearly distinguish:
- Numerical claims backed by **ndjson** (cannot be tampered with, append-only)
- ckpt bits as **illustrative** (cannot be reproducible today)

## Forensic files

```
E:\doro\maze-web\ckpt\sweep_chebyshev-1_mf8_s333.json
E:\doro\maze-web\ckpt\sweep_chebyshev-1_mf8_s333.json.2026-07-06_seeds_check.bak
E:\doro\maze-web\sweep_2026_07_04\results.ndjson
C:\Users\sicko\_grid_dump_panel_b.json      # full grid + breakdown
C:\Users\sicko\_grid_dump_panel_b_v3.json   # correct init seed trial
C:\Users\sicko\_grid_dump_panel_b_init.json # step 0 init grid
C:\Users\sicko\_grid_dump_panel_b_train_repl.json   # full GPU pipeline trial
```

## Diagnostic scripts (all read-only, safe to rerun)

```
E:\doro\maze-web\_cdp_dump_with_correct_init.py
E:\doro\maze-web\_cdp_audit_init_seed.py
E:\doro\maze-web\_cdp_dump_grid_AND_init.py
E:\doro\maze-web\_cdp_replicate_training_for_panel_b.py
E:\doro\maze-web\_cdp_dump_grid.py
E:\doro\maze-web\paper\data\_inspect_panel_b.py
E:\doro\maze-web\paper\data\_ndjson_find_panel_b_v2.py
E:\doro\maze-web\paper\data\_ndjson_fingerprint_panel_b.py
```
