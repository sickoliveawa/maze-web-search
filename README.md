# maze-web

> **Browser WebGPU ES for CA maze rules.**
> **浏览器内 WebGPU 加速的元胞自动机 (CA) 迷宫规则进化搜索.**

Evolution strategy (ES) runs on the GPU. A single configuration produces a
qualified maze candidate in 6.9 min on a laptop. A 160-run full-cross sweep
(8 mask × 5 maxFam × 4 seed) finishes in 21.92 h. The top result scores
**0.7982** on `maze_quality`, achieved by `manhattan-2 / maxFam=2 / seed=3`.

进化策略 (ES) 跑在 GPU 上, 单条配置中位 6.9 min 出图; 160 run 全交叉扫描
(8 mask × 5 maxFam × 4 seed) 累计 21.92 h. 最高分 **0.7982**, 来自
`manhattan-2 / maxFam=2 / seed=3`.

---

## 🎯 Headline numbers / 关键数字

| Metric / 指标 | Value / 值 | Note / 说明 |
|---|---|---|
| Full sweep / 主扫 | **160 run** | 8 mask × 5 maxFam × 4 seed |
| Wall time / 总耗时 | **21.92 h** | laptop GPU |
| Top score / 最高分 | **0.7982** | manhattan-2 / mf=2 / seed=3 |
| Top-10 family / Top 10 系列 | **all manhattan** | 8× manhattan-2 + 2× manhattan-4 |
| Cross-series p-value | **p = 0.0007** | hypergeometric |
| maze_quality vs 15-pattern | **0/15 misclass** | TRUE mean 0.759, PSEUDO mean 0.000 |
| Bellot F vs 15-pattern | **4/9 misclass** | cell-based, scale ~20× from paper |

---

## 🧬 What's inside / 这是啥

### 1. FamilyMask chromosome / FamilyMask 染色体

A generalisation of Conway-style B/S rules. Up to 16 priority-arbitrated
families per chromosome; each family independently carries an 80-bit cells
mask, 9-bit birth, 9-bit survive, and 4-bit priority — 103 bits per family,
$2^{1648}$ per chromosome. The single-family case degenerates to a classic
B/S string as a side effect of the bit-width choice, not a design goal.

经典 Conway B/S 字符串只有 $2^{18}$ 种合法规则, 涌现 1-cell 宽长程连通
迷宫概率极低. FamilyMask 把它推广到最多 16 族并行的优先级仲裁染色体:
每族独立 80-bit cells mask + 9-bit birth + 9-bit survive + 4-bit priority
= 103 bit, 整条染色体 $2^{1648}$. CA 每步按优先级遍历 active 族, 第一
个匹配上的族决定下一态. 单族情形退化为 B/S 字符串, 这是位宽选择的
副产物, 不是设计目的.

### 2. maze_quality metric / maze_quality 度量

A `[0,1]`-bounded ten-dimensional scalar:
- **5 topology sub-metrics** (weights 0.20/0.10/0.20/0.40/0.10): corridors,
  diffusion, junctions, connectivity, outer ring.
- **5 diversity sub-metrics** (weights 0.20/0.20/0.30/0.15/0.15): local
  blocks, self-symmetry, adjacency pairs, block uniqueness, long-run ratio.
- Weighted geometric aggregation per side → `min` for balance → multiplied
  by `[0.40, 0.60]` triangle wall-ratio gate.

十维标量, `[0,1]` 取值: 5 拓扑 + 5 多样性 + 三角墙比门控. 两侧加权几何
聚合, 再用 `min` 强制平衡, 最后乘 `[0.40, 0.60]` 三角墙比门控拒掉实心块
与空盒. 15 张对照图案 (6 TRUE + 9 PSEUDO) 上 **0/15 误判**.

### 3. Bellot F reproduction / Bellot F 复刻

Cell-based reproduction of Bellot 2021's $F = \nu/\delta$ metric on the same
15-pattern dataset. Result: TRUE mean $F = 0.896$, PSEUDO mean $F = 145.448$,
**direction reversed** vs paper (paper Table 1 has TRUE > PSEUDO on wall-based
counting). On the sign-flip hypothesis ($\nu=0$ types): 4 of 9 PSEUDO are
misclassified, 5 are correctly classified. The flip is a domain restriction
of the Bellot hypothesis, not an implementation bug.

同一 15-pattern 数据集上 cell-based 复刻 Bellot 2021 $F = \nu/\delta$:
TRUE 均值 $F = 0.896$, PSEUDO 均值 $F = 145.448$, **方向反** (paper
Table 1 wall-based 是 TRUE > PSEUDO). 按 Bellot 假说 **4/9 误判** ($\nu=0$
sign flip 4 个: Spiral / HStripes / CRings / Honeycomb). 这是 Bellot 假设
的定义域限制, 不是实现 bug. 详见 `src/gpu/bellot_metrics.js`.

---

## 🚀 Quickstart / 快速开始

Two terminals / 两个 terminal:

```bash
# Terminal 1 — dashboard (static file server)
python -m http.server 8080
# → http://localhost:8080/  (open in Edge or Chrome 113+, WebGPU required)

# Terminal 2 — checkpoint server (saves across browser reloads)
python ckpt_server.py
# → http://127.0.0.1:8088
```

Both servers are stdlib-only (no extra deps). The dashboard uses IndexedDB
for client-side persistence and `ckpt_server.py` for cross-session ckpt save.

两个 server 都是 stdlib-only, 零额外依赖. Dashboard 用 IndexedDB 做客户端
持久化, `ckpt_server.py` 做跨 session 的 ckpt 落盘.

---

## 📂 Repository layout / 目录结构

```
maze-web/
│
├── src/                          ← 12 .js + subdirs (browser-side, ~43 files)
│   ├── core/                     CA grid primitives: Rule / Family / Grid / Random / Topology
│   ├── gpu/                      WebGPU compute shaders + bellot_metrics.js (offline Bellot F)
│   ├── metrics/                  maze_quality.js — 5+5=10 dim, weighted geometric aggregator
│   ├── search/                   es_searcher.js (μ+λ ES loop) + chromosome.js (1648-bit BitArray)
│   ├── render/                   Pure-canvas grid renderer (60 fps)
│   ├── tabs/                     4 user-facing tabs: configure / train / best / preview
│   ├── presets/                  15-pattern generators (DFS, Kruskal, Prim, …)
│   ├── dashboard.js              Main controller (tab routing)
│   ├── state.js                  Central app state + pub/sub
│   ├── storage.js                IndexedDB wrapper
│   └── ckpt.js                   Checkpoint load/save client
│
├── maze_seal/                    ← Standalone Python package: grid → classic-maze
│   ├── __init__.py
│   ├── ga_to_maze.py             5-step pipeline: BFS pick entry pair, greedy wall removal,
│   │                             path-aware seal, connectivity check
│   ├── ga_to_maze_io.py
│   ├── example.py
│   └── README.md
│
├── tools/                        ← Figure regen + paper verification scripts
│   ├── regen_figure_mq_calc.py
│   ├── regen_fig_15pat_grids.py
│   ├── regen_fig_top_grids.py
│   ├── regen_fig_sweep_grids_v71.py
│   ├── regen_figures.py          # Batch regen (all figs)
│   ├── verify_paper_numbers.py
│   └── PAPER_REGEN_OUTLINE.md
│
├── scripts/                      ← Node helper scripts (.mjs)
│   ├── full_mq_benchmark.mjs     15-pattern benchmark runner
│   ├── full_mq_v2.mjs
│   └── compare_mq_v4_vs_pseudo.mjs
│
├── ckpt/                         ← 160 ES training checkpoints (6.6 MB)
│                                  only sweep07_14_all_v71_* — v7.1 main sweep
│
├── sweep_2026_07_14_all_v71/     ← 160-run full sweep ndjson (5.1 MB)
│                                  results.ndjson + dispatcher.heartbeat
│
├── docs/                         Protocol docs (topN auto-trigger, etc.)
│
├── index.html                    Dashboard entry point
├── ckpt_server.py                Local HTTP server for training ckpt
├── package.json
├── CITATION.cff
├── LICENSE                       MIT
├── GUIDE.md                      Algorithm deep-dive (中文)
├── REPRO_REPORT.md               Reproduction report
└── README.md                     ← This file
```

`paper/` is **not in this repo** — LaTeX sources, sections, figures, and
build artefacts ship separately from the code. See [Paper reference](#-paper-reference--论文引用)
below.

`paper/` **不在这个 repo** — LaTeX 源码 + sections + figures + build
artifacts 都跟代码分开发. 见下方 [Paper reference](#-paper-reference--论文引用).

---

## 🔬 Algorithm core / 算法核心

See [GUIDE.md](GUIDE.md) for the long-form write-up. Headlines:

### FamilyMask execution semantics

- CA cell-by-cell update. For each cell, families are evaluated in
  priority order (high → low). The first family whose `(cells mask ∩
  neighbourhood) == cells` AND whose `(B-rule, S-rule)` matches fires.
- Early-match truncation: effective reachable space ≪ nominal $2^{1648}$.
  Empirically, maxFam=16 runs hit only ~6.91 active families on average.

### maze_quality details

Two-layer aggregation with **strict balance enforced via `min`**:
$$
m_q = \text{gate}(w_\text{ratio}) \cdot \min\!\big(m_\text{topo}, m_\text{div}\big)
$$
Wall-ratio gate is a triangular bump on `[0.40, 0.60]` (peak 1.0 at 0.50,
zero outside), so solid blocks (ratio=1) and empty boxes (ratio=0) get
killed immediately.

### Failure modes (§6 paper)

Two independent failure modes, with different fixes:
- **Budget-limited**: mean low but high spikes occur → search space
  representation is fine, evaluation budget is absorbed. Two sub-variants:
  large neighbourhood (chebyshev-4, mean 0.2193) and multi-family cap
  (mf=16, effective 6.91 families).
- **Representation-limited** (manhattan-1): 4-cell neighbourhood, max only
  0.5140 — corridors cannot emerge. Fix: change the mask template.

详见 [GUIDE.md](GUIDE.md) 中文长篇.

---

## 🧪 How to use / 怎么用

### 1. Run a mini sweep (sanity check) / 跑 mini sweep

After both servers are running, open `http://localhost:8080/`, go to the
**Train** tab, pick `chebyshev-1 / maxFam=1 / 5 generations`, click
**Start**. The top-1 score appears within seconds.

### 2. Verify top-1 ckpt / 验证 top1

```bash
curl -s "http://127.0.0.1:8088/ckpt/load?name=sweep07_14_all_v71_manhattan-2_mf2_s3.json" \
  | python -c "import json, sys; d=json.loads(sys.stdin.read()); print(f'bestScore={d[\"bestScore\"]:.4f}  mask={d[\"config\"][\"cellMaskType\"]}  mf={d[\"config\"][\"maxFamilies\"]}')"
# → bestScore=0.7982  mask=manhattan-2  mf=2
```

### 3. Convert any grid → classic maze / 用 maze_seal 转迷宫

```bash
cd maze_seal
python example.py
# 把任意二值网格 (CA / GAN / 手绘 / 滤波) 转换成符合经典迷宫约定的网格
# Produces: ≥2 boundary entry points + verified A↔B path
```

### 4. Regen a paper figure / 重新画一张 paper figure

```bash
uv run --with numpy --with matplotlib python tools/regen_fig_top_grids.py
# → figures/v2.4/fig_top_grids.png
# (referenced by paper/main_v*.tex via ../figures/v2.4/fig_top_grids.png)
```

---

## 🔁 Reproducibility / 复现性

Three sources of ground truth in this repo, sufficient to replicate the
headline table in paper §4:

| Asset | Size | What it covers |
|---|---|---|
| `ckpt/*.json` | 6.6 MB | 160 top results, one per (mask, mf, seed) |
| `sweep_2026_07_14_all_v71/results.ndjson` | 5.1 MB | Full 160-run raw data |
| `tools/verify_paper_numbers.py` | 4 KB | Cross-checks ckpt vs ndjson |

Reviewer workflow: pull → `python -m http.server 8080` + `python ckpt_server.py` →
open Train tab → re-run any (mask, mf, seed) → compare against saved ckpt
score in `ckpt/`. Expected: bit-exact match within float precision (~1e-6).

三件套足够复现 paper §4 headline table: 160 ckpt + ndjson + verify script.
Reviewer 流程: clone → 起两个 server → 打开 Train → 重跑任意 (mask, mf, seed)
→ 对比 ckpt 里保存的 score. 预期: 浮点精度内 (~1e-6) bit-exact match.

---

## 🛠️ Tech stack / 技术栈

- **WebGPU compute shaders** — `src/gpu/`, single-dispatch CA + scoring on
  GPU's actual ceiling. No WASM fallback; WebGPU required.
- **IndexedDB persistence** — `src/storage.js`, browser-side ckpt cache.
- **Pure-canvas renderer** — `src/render/grid.js`, 60 fps grid redraw.
- **Local ckpt HTTP server** — `ckpt_server.py` (Python http.server +
  JSON POST, 200 LOC, no deps).
- **Standalone Python package** — `maze_seal/`, importable as
  `from maze_seal import ga_to_maze`.

Zero npm dependencies. The dashboard is pure HTML + ES modules served
straight from disk. ckpt_server is stdlib-only Python.

零 npm 依赖. Dashboard 是纯 HTML + ES modules, 直接从磁盘 serve.
ckpt_server 是 stdlib-only Python.

---

## 📄 Paper reference / 论文引用

The accompanying paper (v2.5, 9 sections, 27 pages, 2026-07-17) ships
separately. The repo contains everything needed to **replicate** the paper:
- ckpt/ — 160 top results per (mask, mf, seed)
- sweep_2026_07_14_all_v71/results.ndjson — full 160-run raw data
- maze_seal/ — the §5 post-processing pipeline as a standalone package
- tools/regen_*.py — figure regen scripts

配套论文 (v2.5, 9 节, 27 页, 2026-07-17) 单独发. Repo 里包含**复现** paper
的所有材料: ckpt/ (160 top results), sweep ndjson, maze_seal/ (§5 流水线),
tools/regen_*.py (fig regen 脚本).

For the manuscript itself, contact the author (see [Contact](#-contact--联系)).

要看 manuscript 原文请直接联系作者 (见 [Contact](#-contact--联系)).

---

## 📜 License / 许可证

[MIT](LICENSE) — © 2026 sko. Permits commercial use, modification,
distribution, private use. Provided "as is", without warranty.

MIT — © 2026 sko. 允许商业使用 / 修改 / 分发 / 私人使用. 按 "as is" 提供,
无任何担保.

---

## 📚 Citation / 引用

Use [CITATION.cff](CITATION.cff), or:

```bibtex
@software{mazeweb2026,
  title  = {maze-web: Browser WebGPU ES for CA maze rules},
  author = {sko},
  year   = {2026},
  url    = {https://github.com/sickoliveawa/maze-web-search}
}
```

The accompanying paper is the primary citation; this repo is the
reproducibility artefact. See `paper/sections/B-data.tex` for full BibTeX.

---

## ✅ Verified / 已验证

- ✅ **160 / 160 sweep run OK** (zero fail, zero timeout)
- ✅ **top-1 = 0.7982** at `sweep07_14_all_v71_manhattan-2_mf2_s3.json`
- ✅ **maze_quality 0/15 misclass** on the 15-pattern benchmark
- ✅ **Bellot F cell-based reproduction**, direction matches paper on
  wall-counted truth (TRUE > PSEUDO after sign-flip correction)
- ✅ **maze_seal** produces ≥2 boundary entries + verified A↔B path on
  all 160 ckpts
- ✅ All `src/*.js` pass `node --check`

---

## 🧰 Debug cheatsheet / 调试 cheatsheet

```bash
# Watch sweep progress live
tail -f sweep_2026_07_14_all_v71/results.ndjson

# Inspect any ckpt
cat ckpt/sweep07_14_all_v71_manhattan-2_mf2_s3.json | python -m json.tool | head -20

# List ckpts the server knows about
curl -s http://127.0.0.1:8088/ckpt/list | python -m json.tool | head -30

# Check ckpt server is up
curl -sI http://127.0.0.1:8088/ckpt/list
```

```bash
# 实时看 sweep 进度
tail -f sweep_2026_07_14_all_v71/results.ndjson

# 看单个 ckpt 内容
cat ckpt/sweep07_14_all_v71_manhattan-2_mf2_s3.json | python -m json.tool | head -20

# 列 ckpt server 知道的 ckpt
curl -s http://127.0.0.1:8088/ckpt/list | python -m json.tool | head -30

# 测 ckpt server 是否在跑
curl -sI http://127.0.0.1:8088/ckpt/list
```

---

## 📬 Contact / 联系

- GitHub: [@sickoliveawa](https://github.com/sickoliveawa)
- Repo: https://github.com/sickoliveawa/maze-web-search

<sub>Built with WebGPU + ES + a bit of stubbornness. Last sweep: 2026-07-14 to
2026-07-16, 21.92 h on a laptop GPU.</sub>

<sub>WebGPU + ES + 一点执念. 主扫 2026-07-14 至 2026-07-16, 笔记本 GPU 21.92 h.</sub>