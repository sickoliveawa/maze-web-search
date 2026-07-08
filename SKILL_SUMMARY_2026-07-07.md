# maze-web skill 摘要 (v1.9.0, 2026-07-07)

**完整版位置**: `C:\Users\sicko\AppData\Local\hermes\skills\maze-web\SKILL.md` (26 KB)
**摘要版**: 本文件

---

## 5 个 Hard Rules (速查)

| # | 主题 | 关键 (中文/EN) |
|---|------|------|
| 1 | maze-web **only** GPU 版 | "Don't get distracted by the CPU code" — `src/core/` 是 test-fixture, 浏览器 hot path 只用 WebGPU |
| 2 | Python 还原 GPU 才能证可复现 | Paper figures 必须来自 Python replica of GPU logic, 不能是 Playwright screenshot |
| 3 | seed 不重要，规则加载对就行 | init seed 错了的视觉错几乎总是 rule decode (cellInRange, MAX_FAMILIES, priority) 错，不是 seed 错 |
| 4 | "看着不太对" = dual-interpretation gap | init full-screen + rule byte-identical 但视觉错 → 是 `preview.js::pickBestGrid` 缺了 |
| **5** | **trust algorithm, audit data** | "我相信迷宫算法和es没问题，但是保存数据和重现你要仔细检查并撰写" — 不动 trusted parts, 审计+撰写 |

## 备份规则 (Hard rule #5 衍生)

- **命名约定**: `.<YYYY-MM-DD>_<investigation_reason>.bak`
  - 错: `maze_quality.js.bak`, `maze_quality.js.2026-07-06.bak`
  - 对: `maze_quality.js.2026-07-06_drift_check.bak`, `pre_paper_v2.1.bak`
- **备份 timing**: drift 之后再备份 = 备份的是坏状态。`stat -c '%Y %n' <file>` BEFORE `cp`
- **改动前先备份**: `cp <file> <file>.bak_$(date +%Y%m%d)_pre_<reason>`

---

## 28 个 Gotchas (速查)

### 训练/ES 核心
1. `runES(opts)` decoder pitfall — wide opts object 必须列所有字段
2. Preview tab 不是 Train tab 的 wrapper — 自己 UI + 直接调 `engine.runBatchedSteps()`
3. Train Live preview 是 CA-evolved grid 不是 init grid
4. `usedInverted` flag drives `colorScheme`
5. `renderGrid` shared by Train + Preview — use `drawLiveCells` flag
6. 加 UI control 前先 cross-layer capacity audit
7. Bellot F 双实现 — source of truth = `src/gpu/bellot_metrics.js::bellotF`

### Paper figure / GPU 复现
8. maze-web is GPU-ONLY in browser — mirror `src/gpu/`, not `src/core/rule.js::Rule.evaluate`
9. CA grid visual class ≠ maze_quality score (frame as finding, not failure)
10. `preview.js::pickBestGrid()` 是 GPU pipeline 一部分 — Python replica 必须有

### ckpt / 数据完整性
11. ckpt_server `batchName` filename policy 可静默 shadow 真正 sweep ckpt
12. `train.js:195` gen=500 自动保存 ~4% 失败 (全 chebyshev-1)
13. `results.ndjson` **没有** `bestChromBits` — 不能从 ndjson 单独复现 ckpt 视觉
14. ckpt corruption 解: standalone mini-dispatcher (不用 dispatcher v2 wait_done)
15. `_build_fig_es_grids.py:53` hard-codes `chosen_s=0`

### Init seed 公式 4 种混乱
17. Python mirror 不是 production GPU formula — production 用 `s + rs*1000003`, mirror 用 `(rs + chromHash*65537 + s) >>> 0`
18. Sweep ckpts go stale when scoring code 改 (after sweep)
19. `BatchedGPUEngine` vs `GPUEngine` 两个 engine 别混
20. `mazeQuality()` 返回 `{total, breakdown}` 不是 `total`

### 预览/渲染
21. Preview canvas `drawLiveCells=true` paints LIVE cells DARK (`#1a1a1a`)
22. ckpt replay chain 有 4 不同 init seed formulas + ckpt 不存 chromHash / final grid
23. Post-drift backup ≠ pre-drift backup
24. CDP button text ≠ stable identifier (用 `id="pv-step-10"` 不要 grep 文本)
25. `mazeQuality()` 在 **inv** side at **dark=1** convention sign 错

### 复现 forensic (07-07 latest)
26. Ckpt reproducibility 3 个 failure mode (overwrite / drift / script bug)
27. **ckpt `bestBreakdown` is mq-version-self-consistent but not replayable** — savedAt 跟 ndjson ts 差 49h，bits 不一定是原训 0.81 那条

### Hermes tool quirks (07-07)
28. **Hermes `patch` tool mangles LaTeX `\X` patterns** — `\ref`, `\tt` 被 escape 成字面 CR/Tab
29. **Hermes `terminal` tool blocks multi-line python heredocs** — 用 `write_file` 写脚本，`python script.py` 跑

---

## 25 个 References

### Backup / recurring patterns
- mazeweb-runner-and-state.md — server bring-up, 4-tab SPA
- mazeweb-mazequality-and-es.md — `mazeQuality()` 8-sub-metric
- mazeweb-pitfalls-and-fixes.md — lessons from 2026-07-01

### Visual / Render
- mazeweb-render-fix-2026-07-03.md — color-scheme session log
- mazeweb-ca-grid-rendering.md — companion for dual-pick

### ckpt / Sweep / Dispatcher
- mazeweb-ckpt-server.md — Python stdlib HTTP sidecar
- mazeweb-sweep-dispatcher.md — sweep runner 5 lessons
- mazeweb-sweep-stack-recovery.md — 4-service bring-up
- mazeweb-128-sweep-and-active.md — 128-run + active family
- mazeweb-sweep-integrity-2026-07-06.md — 5/128 corruption recipe
- mazeweb-sweep-ckpt-corruption-resolution-2026-07-06.md — standalone mini-dispatcher
- mazeweb-scoring-drift-2026-07-06.md — mq drift ckpt invalidation
- mazeweb-ckpt-replay-recipe-2026-07-06.md — 4 init seed formulas + chromHash recipe

### Paper figures (multi-version history)
- paper-figure-generation-2026-07-06.md — Playwright recipe
- paper-figure-v0.7-spiral-and-conventions.md
- paper-fig-es-grids-cpu-sim-2026-07-06.md — v1.3 (superseded)
- paper-fig-es-grids-closed-2026-07-06.md — v1.4-v1.5
- paper-fig-es-grids-gpu-replicate-2026-07-06.md — v1.5 GPU logic
- paper-fig-es-grids-dual-pick-2026-07-06.md — v1.6 missing-piece
- paper-fig-es-grids-ckpt-corruption-2026-07-06.md — panel (b) corruption
- paper-fig-es-grids-chosen-s-override-2026-07-06.md — v1.7 `chosen_s=0`
- paper-fig-es-grids-init-seed-formula-2026-07-06.md — v1.8 mirror vs production

### Paper writing
- paper-v0.7-spiral-and-conventions.md
- paper-v1.0-rewrite-skeleton-2026-07-06.md — from-skeleton workflow
- paper-v2.1-update-2026-07-06.md — fig 6 v2 + §6.4 init-seed
- **paper-v1.1-reproducibility-section-2026-07-07.md** — ★ §5.5 + Appendix D forensic ★
- paper-writing-lessons-2026-07-06.md

### Bellot F
- bellotF-source-truth-2026-07-06.md — Bellot F dual-implementation trap

---

## 4 个 Scripts

| 脚本 | 用途 | 触发 |
|------|------|------|
| `verify_byte_match.mjs` | Python vs Node byte-equality (36/36 snapshots match) | GPU↔CPU 镜像验证 |
| `verify_sweep_ckpt_integrity.py` | ckpt server vs ndjson 完整性 (score + time drift) | sweep 完必跑 |
| `build_fig_es_grids_v2_template.py` | v2 fig 6 build script (production formula) | 改 fig 6 |
| **`verify_ckpt_replay_against_saved.py`** | **end-to-end ckpt replay verifier** | **"ckpt 是不是坏了"** 第一动作 |

---

## 3 个 Templates

- `templates/academic_paper_main.tex` — 主 LaTeX 骨架
- `templates/academic_paper_section.tex` — 节模板
- `templates/fig_es_grids_caption.tex` — v1.3 caption (superseded)

---

## Headline Numbers

**Sweep 07-04 (128 runs, ~10h wall, 40×60 grid) — CURRENT**:
- Top: **manhattan-2/mf=8/seed=444 → 0.8233** (active=2/8)
- 6 healthy mask families: mean 0.74-0.78
- chebyshev-4 dead (mean 0.157)
- manhattan-1 stuck in attractor (mean 0.420, std 0.0098)

**Sweep 07-01 (72 runs, 7.77h wall) — superseded**:
- Top: manhattan-3/mf=4/seed=137 → 0.8203

---

## 关键场景速查

| 你说... | 第一动作 |
|---------|---------|
| "ckpt 是不是坏了 / score 是 0 / preview 不对" | `python verify_ckpt_replay_against_saved.py <ckpt>` |
| "sweep 跑完了画图前" | `python verify_sweep_ckpt_integrity.py` |
| "改 fig 6" | 用 `build_fig_es_grids_v2_template.py`, 不改 v1 |
| "改 mq.js / gpu_scorer.js / state.js" | `stat -c '%Y %n'` BEFORE `cp`, 带 `pre_<reason>.bak` |
| "paper 数字哪来的" | `grep "<mask>.*<mf>.*<seed>" sweep_*/results.ndjson`, **从 ndjson 不从 ckpt** |
| "改 paper .tex" | 用 `write_file` 重写, 不用 `patch` (escape bug) |
| "跑 Python 多行" | `write_file` 写 .py, `python script.py`, 不用 heredoc |

---

## 备份完整 (今晚 forensic)

```
E:\doro\maze-web\ckpt\sweep_chebyshev-1_mf8_s333.json.2026-07-06_seeds_check.bak
E:\doro\maze-web\src\state.js.2026-07-06_seeds_check.bak
E:\doro\maze-web\src\tabs\configure.js.2026-07-06_seeds_check.bak
E:\doro\maze-web\src\search\es_searcher.js.2026-07-06_seeds_check.bak
E:\doro\maze-web\src\gpu\gpu_scorer.js.2026-07-06_seeds_check.bak
E:\doro\maze-web\_sweep_runner_2026_07_04.py.2026-07-06_seeds_check.bak
E:\doro\maze-web\src\metrics\maze_quality.js.2026-07-06_drift_check.bak
E:\doro\maze-web\src\core\random.js.2026-07-06_repro_check.bak
E:\doro\maze-web\src\core\grid.js.2026-07-06_repro_check.bak

E:\doro\maze-web\paper\main_v1.0_backup.pdf  (v1.0 18 页)
E:\doro\maze-web\paper\main.pdf  (v1.1 21 页)
E:\doro\maze-web\paper\main_v1.1_with_repro_section.pdf  (副本)
E:\doro\maze-web\paper\main.tex.bak_2026-07-07_repro_section
```

## Forensic scripts (read-only, 可重跑)

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

## Forensic report

**E:\doro\maze-web\REPRO_REPORT.md** — 完整 7-step 调查 + 49h drift 证据 + 5 backup 字段对比

---

## Paper v1.1 信息

- 路径: `E:\doro\maze-web\paper\main.pdf`
- 大小: 1.34 MB, 21 页
- §5.5 (p.15) + 附录 D (p.21): ckpt vs ndjson 49h drift 诚实记录
- v1.0 backup: `main_v1.0_backup.pdf` (18 页)
- source: `main.tex` + `sections/*.tex`
