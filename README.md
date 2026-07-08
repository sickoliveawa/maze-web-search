# maze-web

Browser-based dashboard for **FamilyMask** (multi-family CA rule encoding) +
**maze_quality** (8-dimensional maze quality metric), with WebGPU-accelerated
evolution-strategy training.

The accompanying paper is in `paper/main_v1.2.tex` (Chinese with English abstract).

## Quickstart

```bash
cd maze-web
python -m http.server 8087

# open in Edge / Chrome 113+ (WebGPU required):
#   http://127.0.0.1:8087/index.html
```

Optional: run the checkpoint server in a second terminal to persist training
runs across browser reloads.

```bash
python ckpt_server.py     # listens on http://127.0.0.1:8088
```

## What this repo contains

```
maze-web/
├── README.md                ← this file
├── LICENSE                  ← MIT
├── CITATION.cff             ← paper citation metadata
├── index.html               ← single-page dashboard shell
├── package.json
├── ckpt_server.py           ← local HTTP server for training checkpoints
├── qq_text_sender.py        ← helper for sending files via QQ bot
│
├── src/                     ← all browser-side JS
│   ├── dashboard.js         ← main controller (tab routing)
│   ├── state.js             ← central app state + pub/sub
│   ├── storage.js           ← IndexedDB wrapper
│   ├── ckpt.js              ← checkpoint load/save client
│   │
│   ├── core/                ← Rule / Family / Grid / Topology / Random / B/S compat
│   │   ├── rule.js
│   │   ├── family.js
│   │   ├── grid.js
│   │   ├── topology.js
│   │   ├── random.js
│   │   └── bs_compat.js
│   │
│   ├── gpu/                 ← WebGPU compute shaders + scorers
│   │   ├── gpu_engine.js            ← single-rule engine (used by Preview)
│   │   ├── gpu_engine_batched.js    ← batched engine (1 dispatch = N rules × K seeds)
│   │   ├── gpu_scorer.js            ← batched scorer (CA + mazeQuality on GPU)
│   │   └── bellot_metrics.js        ← GPU Bellot F = ν/δ metric
│   │
│   ├── metrics/             ← maze-quality + sub-metrics
│   │   ├── maze_quality.js          ← 8-submetric weighted geometric aggregator
│   │   ├── connectivity.js
│   │   ├── symmetry.js
│   │   └── branch_entropy.js
│   │
│   ├── search/              ← ES loop + chromosome encoding
│   │   ├── es_searcher.js           ← main (μ+λ) ES loop
│   │   ├── chromosome.js            ← 1648-bit BitArray
│   │   └── rule_chromosome.js       ← Rule ↔ chromosome encode/decode
│   │
│   ├── render/
│   │   └── grid.js          ← pure-canvas grid renderer
│   │
│   ├── tabs/                ← 4 user-facing tabs
│   │   ├── configure.js     ← full ESConfig form
│   │   ├── train.js         ← Start/Stop + live progress + log
│   │   ├── best.js          ← IndexedDB batch list + breakdown
│   │   └── preview.js       ← preset + step slider + scoring
│   │
│   ├── presets/
│   │   └── presets.js       ← M4 SOTA + DFS + Conway (auto-generated)
│   │
│   └── utils/
│
├── paper/                   ← LaTeX source + figures for the paper
│   ├── main_v1.2.tex        ← entry point (xelatex, 2 passes)
│   ├── main_v1.2.pdf
│   ├── sections/            ← 8 numbered .tex chapters (00-abstract … 08-appendix)
│   ├── figures/             ← all PDF + PNG figures (fig_*.{pdf,png}, fig_*_meta.json)
│   ├── data/                ← sweep summary + reproducibility audit data
│   ├── tables/
│   └── _backup/             ← older paper revisions (.bak) — kept for reference
│
├── scripts/                 ← Node helper scripts (MJS) for offline CA grid rendering
│   ├── full_mq_benchmark.mjs     ← 15-pattern benchmark runner
│   ├── full_mq_v2.mjs            ← v2 benchmark (used for figures)
│   ├── compare_mq_v4_vs_pseudo.mjs
│   ├── _gen_grids.mjs
│   ├── _ca_snapshots.mjs
│   ├── _top4_cfg.mjs
│   ├── _verify_best_rule.mjs
│   └── _debug_inv.mjs
│
├── test_*.mjs               ← tiny export / spiral / bench sanity tests
│
├── _diag_*.py               ← diagnostic scripts (kept for reference;
│                                not part of the public API)
├── _verify_*.py
├── _sweep_runner_2026_07_04.py     ← runner for the 128-run sweep
├── _mini_sweep_4configs.py         ← 4-config mini-sweep template
├── _big_sweep_500x2000.py          ← 500pop×2000gen runner (5 seeds)
├── _fill_missing_ma1.py            ← fills 6 missing ndjson entries
├── _paper_v2_verify.py             ← paper claim verification
├── _paper_claims_verify.py
└── _test_fill_path.py              ← smoke test for GPU eval path
```

## Reproducing the headline numbers

### 15-pattern benchmark (maze_quality vs Bellot F)

```bash
node scripts/full_mq_benchmark.mjs
node scripts/compare_mq_v4_vs_pseudo.mjs
# → produces paper/figures/fig_true_mazes.pdf + fig_pseudo_mazes.pdf
#   and console output matching Table 1 in paper §4
```

### 128-run ES sweep (the headline experiment)

```bash
python _sweep_runner_2026_07_04.py
# → writes results.ndjson to a sweep_2026_07_04/ dir (gitignored)
# → each run = 200pop × 500gen on 40×60 grid, 300 CA steps
# → total wall time ≈ 14 h
```

To verify any saved checkpoint against its saved score (sanity test for
the save → parse → decode → GPU eval chain):

```bash
python _paper_v2_verify.py
# → loads 6 panel ckpts from sweep, re-evaluates, confirms 1e-8 float match
```

### 500pop × 2000gen search (highest-score run)

```bash
python _big_sweep_500x2000.py
# → 5 seeds × ~67 min each = ~5.5 h
# → writes sweep_2026_07_08_big/results.ndjson (gitignored)
```

## Building the paper

```bash
cd paper
xelatex main_v1.2.tex    # pass 1
xelatex main_v1.2.tex    # pass 2 (resolves \ref + table of contents)
# → main_v1.2.pdf
```

## What's new in maze-web vs the Python maze-es reference

- **state.js** — single state container with subscribe/emit (replaces the
  Python project's `/api/*` server round-trips)
- **storage.js** — IndexedDB persistence for saved batches (replaces the
  Python project's Node server files)
- **render/grid.js** — pure-canvas grid renderer
- **4 tabs** — Configure / Train / Best / Preview
- **gpu_scorer.js** — full batched WebGPU scorer (CA evolution + 8 sub-metric
  evaluation in a single dispatch, on the GPU's actual ceiling)
- **bellot_metrics.js** — faithful Bellot 2021 F = ν/δ implementation on GPU

## License

MIT — see [LICENSE](LICENSE).

## Citation

See [CITATION.cff](CITATION.cff) or use the BibTeX entry in
`paper/sections/08-appendix.tex`.

## Verified

- All 22 JS source files pass `node --check`.
- M4 SOTA chromosome decoded correctly: 1 family, 14 cells, B=[0,1,3], S=[1..8].
- `mazeQuality(M4 saved grid) = 0.766863` (bit-exact match with Python reference).
- 6/6 paper headline checkpoints reproduce saved score to 1e-8 float precision
  (see `_paper_v2_verify.py`).
- Save → parse → decode chain verified byte-equal across 8 checkpoints
  (disk == server GET == browser load).
