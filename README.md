# maze-web

> Browser WebGPU ES for CA maze rules.
>
> 浏览器内 WebGPU 加速的元胞自动机 (CA) 迷宫规则进化搜索。

演化策略 (ES) 跑在 GPU 上, 单条配置中位 6.9 min 出图; 160 run 全交叉扫描 21.92 h 跑完, 最高分 **0.7982** 来自 `manhattan-2 / mf=2 / seed=3`。

- **FamilyMask 染色体** — 单族 $2^{103}$, 整条染色体 $2^{1648}$ (16 族并行)
- **maze_quality** — `[0,1]` 取值的十维标量 (5 拓扑 + 5 多样性 + 三角墙比门控)
- **Bellot F 复刻** — 同数据集 cell-based, **4/9 误判** (ν=0 类型 sign flip)

---

## 🚀 Quickstart

两个 server, 两个 terminal:

```bash
# Terminal 1: dashboard
python -m http.server 8080
# → http://localhost:8080/

# Terminal 2: checkpoint server
python ckpt_server.py
# → http://127.0.0.1:8088  (saves ckpt across browser reloads)
```

需要 **Edge / Chrome 113+** (WebGPU required).

---

## 📦 这是啥 / What's inside

```
maze-web/
├── src/                     12 .js + 子目录
│   ├── core/                CA grid primitives (Rule / Family / Grid / Random)
│   ├── gpu/                 WebGPU compute shaders + bellot_metrics
│   ├── metrics/             maze_quality 5+5=10 子度量
│   ├── search/              ES loop + 1648-bit chromosome
│   ├── render/              pure-canvas grid renderer
│   ├── tabs/                4 个 tab (configure / train / best / preview)
│   └── presets/             15-pattern generators
│
├── maze_seal/               standalone Python package — 从网格到迷宫后处理
│   ├── __init__.py
│   ├── ga_to_maze.py        BFS 入口 + 贪心拆墙 + path-aware seal
│   ├── ga_to_maze_io.py
│   ├── example.py
│   └── README.md
│
├── tools/                   figure regen + paper 验证脚本
│   ├── regen_figure_mq_calc.py
│   ├── regen_fig_15pat_grids.py
│   ├── regen_fig_top_grids.py
│   ├── regen_fig_sweep_grids_v71.py
│   ├── regen_figures.py     # 批量 regen
│   ├── verify_paper_numbers.py
│   └── PAPER_REGEN_OUTLINE.md
│
├── scripts/                 Node helper scripts (MJS)
│   ├── full_mq_benchmark.mjs
│   ├── full_mq_v2.mjs
│   └── compare_mq_v4_vs_pseudo.mjs
│
├── ckpt/                    160 ES training checkpoints (6.6 MB)
│                             only sweep07_14_all_v71_* (v7.1 主扫)
│
├── sweep_2026_07_14_all_v71/   160-run full sweep ndjson (5.1 MB)
│
├── docs/                    协议文档 (topN 30-seed auto-trigger 等)
│
├── index.html               dashboard 入口
├── ckpt_server.py           ckpt HTTP server
├── package.json
├── CITATION.cff
├── LICENSE                  MIT
├── GUIDE.md                 算法详述 (中文)
├── REPRO_REPORT.md          复现报告
└── README.md                ← 你在读这个
```

---

## 🎯 复现 / Reproduce

### 跑一个 mini sweep (验证 setup OK)

```bash
# 起 server 后打开 http://localhost:8080/
# 进 Train tab, 选 chebyshev-1 / mf=1 / 5 generations → Start
# 几秒后看 Top-1 score
```

### 验证 top1 ckpt

```bash
curl -s "http://127.0.0.1:8088/ckpt/load?name=sweep07_14_all_v71_manhattan-2_mf2_s3.json" \
  | python -c "import json, sys; d=json.loads(sys.stdin.read()); print(f'bestScore={d[\"bestScore\"]:.4f}  mask={d[\"config\"][\"cellMaskType\"]}  mf={d[\"config\"][\"maxFamilies\"]}')"
# → bestScore=0.7982  mask=manhattan-2  mf=2
```

### 跑 maze_seal 后处理

```bash
cd maze_seal
python example.py
# 把任意二值网格 (CA / GAN / 手绘) 转换成符合经典迷宫约定的网格
```

---

## 📊 关键数字 / Headline numbers

| 指标 | 值 |
|---|---|
| 主扫配置 | 8 mask × 5 mf × 4 seed = 160 run |
| 累计耗时 | 21.92 h |
| 最高分 | **0.7982** (manhattan-2 / mf=2 / seed=3) |
| Top 10 全在 manhattan 系列 | 8× manhattan-2 + 2× manhattan-4 |
| 跨系列非偶然概率 | p = 0.0007 (超几何) |
| maze_quality vs 15-pattern | 0/15 误判 |
| Bellot F vs 15-pattern | **4/9 误判** (cell-based, scale ~20×) |

---

## 🔬 算法核心 / Core algorithm

详见 [GUIDE.md](GUIDE.md).

### FamilyMask 染色体 (§2)
经典 Conway B/S 字符串只有 $2^{18}$ 种合法规则, 涌现 1-cell 宽长程连通迷宫概率极低. 本文推广到最多 16 族并行的优先级仲裁染色体:
- 每族独立持有 80 bit cells mask + 9 bit birth + 9 bit survive + 4 bit priority = 103 bit
- 整条染色体 $2^{1648}$
- CA 每步按优先级遍历 active 族, 第一个匹配上的族决定下一态
- 单族情形退化为 B/S 字符串

### maze_quality (§3)
十维标量, `[0,1]` 取值:
- **5 拓扑子度量** (权重 0.20/0.10/0.20/0.40/0.10): 走廊 / 扩散 / 路口 / 连通性 / 外圈
- **5 多样性子度量** (权重 0.20/0.20/0.30/0.15/0.15): 局部块 / 自对称 / 邻接对 / 块唯一性 / 长段占比
- 两侧加权几何聚合 → `min` 强制平衡 → 乘以 `[0.40, 0.60]` 三角墙比门控

### 瓶颈 (§6)
两类互不依赖的失败模式:
- **预算受限** — 偶发高分表明搜索空间表征充分, 瓶颈在评估预算被某个维度吸收
  - 变体 A: 大邻域 (chebyshev-4, 均值 0.2193, 偶发 0.7578)
  - 变体 B: 多族 cap (mf=16, 名义 16 族实际平均仅 6.91 族)
- **表征受限** (manhattan-1) — 4 cells 邻域最高仅 0.5140, 走廊结构无法涌现, 换 mask 模板即可解决

---

## 🌐 Paper

`paper/` 目录**不在这个 repo** — LaTeX 源码 + sections + figures + build artifacts 都跟 repo 分开发布. 最新的正式版是 **v2.5** (9 节, 27 页, 2026-07-17).

如果你要看 paper, 直接联系作者. repo 里能跑通的部分:
- `ckpt/` — 160 个 top result per config (reviewer 可复现 headline table)
- `sweep_2026_07_14_all_v71/results.ndjson` — 完整 160-run 原始数据
- `maze_seal/` — paper §5 后处理流水线的 standalone package
- `tools/regen_figure_mq_calc.py` 等 — paper figs 的 regen 脚本

---

## 🛠️ Tech stack

- **Browser ES** — `src/search/es_searcher.js` (μ+λ ES loop)
- **WebGPU compute shaders** — `src/gpu/` (CA 演化 + maze_quality 评估 single dispatch)
- **IndexedDB persistence** — `src/storage.js`
- **Pure-canvas renderer** — `src/render/grid.js` (60fps grid)
- **Local ckpt HTTP server** — `ckpt_server.py` (Python http.server + JSON POST)
- **Python package** — `maze_seal/` (网格 → 经典迷宫 5 步流水线)

---

## 📜 License & Citation

[MIT](LICENSE) — © 2026 sko (冯卓源)

引用用 [CITATION.cff](CITATION.cff) 或:

```bibtex
@software{mazeweb2026,
  title  = {maze-web: Browser WebGPU ES for CA maze rules},
  author = {Feng, Zhuoyuan (sko)},
  year   = {2026},
  url    = {https://github.com/sickoliveawa/maze-web-search}
}
```

---

## ✅ Verified

- ✅ 160/160 sweep run 全部完成 (0 fail, 0 timeout)
- ✅ top1 ckpt (sweep07_14_all_v71_manhattan-2_mf2_s3) bestScore = 0.7982
- ✅ maze_quality vs 15-pattern 0/15 误判
- ✅ Bellot F cell-based 复刻, 与 paper 方向一致
- ✅ maze_seal 在所有 160 个 ckpt 上通过 spec (≥2 边界入口 + A↔B 通路)
- ✅ src/ 12 个 .js + 子目录全部 `node --check` pass

---

## 🧰 调试 cheatsheet

```bash
# 实时看 sweep 进度
tail -f sweep_2026_07_14_all_v71/results.ndjson

# ckpt server 日志
# (它在 stdout, 用你启动时的那个 terminal 看)

# 清所有 server
# taskkill /F /IM python.exe  # ⚠️ 慎用, 会杀所有 python
```

---

## 📬 联系 / Contact

- GitHub: [@sickoliveawa](https://github.com/sickoliveawa)
- Project: https://github.com/sickoliveawa/maze-web-search

<sub>Built with WebGPU + ES + 一点点执念. Last sweep: 2026-07-14 to 2026-07-16, 21.92 h on a laptop GPU.</sub>