# maze_seal

> **Convert any 0/1 grid into a 2-entry, A↔B-connected maze.**
> **把任意 0/1 网格转换成 2-入口、A↔B 通路连通的迷宫.**

Standalone Python package, no project-specific dependencies. Drop the
folder into any repo and `from maze_seal import ga_to_maze`.

独立的 Python 包, 无项目特定依赖. 把整个目录放到任何 repo 里,
`from maze_seal import ga_to_maze` 就能用.

---

## 📦 What's inside / 这是啥

**Input / 输入**: `numpy.ndarray`, shape `(H, W)`, dtype `uint8`,
`0` = corridor, `1` = wall.

**Output / 输出**: `dict` with —
- `maze` (sealed grid)
- `entry_a`, `entry_b` (two entry coordinates `(y, x)`)
- `path` (full A→B cell sequence)
- `score` (top-2 sum, BFS-distance proxy after greedy)
- diagnostic fields (`border_0`, `meeting_cell`, `top1`, `top2`, `history`)

**Guarantees / 保证**:
- ✅ 2 entries on 4 borders
- ✅ A↔B connected (guaranteed path exists)
- ✅ Path as long as possible (greedy wall removal)
- ✅ Dead-ends and sub-grids preserved (visual richness)
- ✅ Multi-branch OK (cycles, junctions on path allowed)

---

## 📂 Files / 文件清单

```
maze_seal/
├── README.md            ← this file
├── __init__.py          ← public API entry (9 funcs)
├── ga_to_maze.py        ← core algorithm (~615 lines, no external deps)
├── ga_to_maze_io.py     ← .grid.txt format I/O (3 funcs)
└── example.py           ← 4 usage examples
```

**Depends on / 依赖**:
- `numpy` (required / 必须)
- Python 3.10+ (uses `set[tuple]` / `list[tuple]` annotations)

**No dependency on / 不依赖**:
- ❌ matplotlib (visualization, optional)
- ❌ any CA / GA / scoring code
- ❌ any project-specific paths

---

## 🚀 Quickstart / 快速上手

### Option 1: CLI / 命令行试一下

```bash
cd maze_seal
python example.py
# Runs 4 examples (5×9 snake / 7×7 U-shape / I/O round-trip / real GA grid)
```

### Option 2: Python integration / 集成到你的代码

```python
from maze_seal import ga_to_maze, verify_maze, save_grid_txt, load_grid_txt
import numpy as np

# 1. Your raw grid (from GA / CA / anywhere)
g = np.ones((60, 40), dtype=np.uint8)
# ... fill g with your logic ...

# 2. Call seal
result = ga_to_maze(g, verbose=False)

# 3. Check result
if result["ok"]:
    print(f"entry_a: {result['entry_a']}, entry_b: {result['entry_b']}")
    print(f"path:    {len(result['path'])} cells")
    print(f"score:   {result['score']}")
    
    # 4. (Optional) verify
    v = verify_maze(result["maze"], result["entry_a"], result["entry_b"])
    assert v["a_reaches_b"]
    assert v["border_0_off_path"] == 0
    
    # 5. (Optional) save
    save_grid_txt(result["maze"], "output.grid.txt", meta={
        "entry_a": result["entry_a"],
        "entry_b": result["entry_b"],
        "path_length": len(result["path"]),
    })
else:
    print(f"failed: {result['reason']}")
```

### Option 3: Load from `.grid.txt` / 从文件加载

```python
from maze_seal import load_grid_txt, ga_to_maze

g = load_grid_txt("my_grid.grid.txt")
result = ga_to_maze(g)
```

`.grid.txt` format (see `ga_to_maze_io.py` docstring for full spec):
```
# convention: 0=corridor, 1=wall, 4-conn
# shape: 40x60
# entry_a: (19, 39)
# entry_b: (23, 0)
40 60
1111111111...   ← H rows, each W 0/1 chars
...
```

---

## 🔬 Algorithm / 算法原理

### 5-step pipeline / 5 步流水线

```
raw grid g
   │
   ▼
[1] find_border_corridors — scan 4 edges for 0-cells
   │       fail if < 2
   ▼
[2] greedy_wall_removal — maximize top-2 BFS distance
   │       candidate: 1-cell with exactly 2 0-neighbors
   │       loop: pick the candidate that increases score most
   ▼
[3] component filter — restrict border_0 to largest component
   │       (defensive: A↔B must connect across component)
   ▼
[4] BFS 2-pass — find entry pair (A, B)
   │       classical diameter approximation
   │       gate: if BFS(A,B) < 5, fallback to Manhattan-first search
   ▼
[5] Path-aware seal — compute path first, close border after
   │       (a) BFS from A in g (post-greedy)
   │       (b) reconstruct path via parent tree
   │       (c) close border 0-cells NOT on path
   │       (d) verify A↔B still connects (always true)
   ▼
maze, A, B, path
```

> **Note / 注**: A previous v18 had a Step 6 that closed off-path junctions
> (≥3 0-neighbors). v19 removed it — it closed ~10% of corridors in dense
> grids, too aggressive. Call `close_off_path_junctions(maze, path)` manually
> if you want a cleaner tree-like output.
>
> v18 原本有个 Step 6 会关 off-path junctions (≥3 0-neighbors). v19 删了,
> 嫌封太多. 想要更 clean 的图手动调 `close_off_path_junctions()`.

### Why path-aware seal? / 为什么要 path-aware seal

**Old bug (v15)**: closed border cells first, computed path second. On a
1×9 snake (path runs along the border), closing the middle border cells
cut A↔B, fallback picked `(0,0)↔(0,1)` → 2-cell maze. ✗

**Fix (v18+)**: compute path in `g` (post-greedy, before seal), then close
border cells NOT on path. All path cells preserved → A↔B always connects.
On dense grids, only the 2 entries survive as border cells.

老版本 (v15) 先关 border 再算 path, 1×9 snake 整条 path 沿边走, 关中间
border cell 直接切断 A↔B, fallback 选 (0,0)↔(0,1) → 2-cell maze. 新版本
(v18+) 先在 g (post-greedy, 还没 seal) 上算 path, 再关 NOT on path 的
border cell. 所有 path cell 保留 → A↔B 一定连通.

---

## 📚 API reference / API 参考

### `ga_to_maze(g, verbose=False) -> dict`

**Main entry / 主入口**.

| Arg | Type | Default | 说明 |
|---|---|---|---|
| `g` | `np.ndarray` (H, W, uint8) | required | 0/1 grid |
| `verbose` | bool | `False` | print per-step state |

**Returns** (dict):

| key | type | 说明 |
|---|---|---|
| `ok` | bool | 是否成功 (False if < 2 entries) |
| `reason` | str | 失败原因 (success 时为空) |
| `maze` | np.ndarray | sealed grid (same shape as input) |
| `entry_a` | (y, x) | 入口 1 |
| `entry_b` | (y, x) | 入口 2 |
| `path` | list of (y, x) | A→B 完整路径 |
| `score` | int | greedy 后的 top-2 sum (max BFS dist estimate) |
| `border_0` | list | used border cells (restricted to max component) |
| `meeting_cell` | (y, x) | top-2 sum 最大的 cell (诊断) |
| `top1`, `top2` | int | top-1, top-2 BFS distances |
| `history` | list | greedy iteration history |

### `seal_to_maze(g, border_0) -> tuple`

**5-step pipeline core / 5 步流水线核心** (v19 returns 4-tuple).

**Args**:
- `g` (np.ndarray): post-greedy grid
- `border_0` (list of (y, x)): entries

**Returns**: `(maze, entry_a, entry_b, path)`

### `close_off_path_junctions(maze, path, min_degree=3) -> int`

**Optional post-processing / 可选后处理**. Closes 0-cells with ≥`min_degree`
neighbors that are NOT on path.

```python
from maze_seal import ga_to_maze, close_off_path_junctions

result = ga_to_maze(g)
n_closed = close_off_path_junctions(result["maze"], result["path"])
# mutates result["maze"] in place
```

| Arg | Type | Default | 说明 |
|---|---|---|---|
| `maze` | np.ndarray | required | mutated in place |
| `path` | list | required | A→B path, never closed |
| `min_degree` | int | 3 | trigger threshold; 4 = only close 4-way junctions |

**Returns**: number of cells closed (int)

### `verify_maze(g, entry_a, entry_b) -> dict`

**Verify sealed maze / 验证 sealed maze**. Does not modify `g`.

**Returns** (dict):

| key | type | 说明 |
|---|---|---|
| `total_0_cells` | int | maze 里 0-cell 总数 |
| `reachable_from_a` | int | 从 A BFS 能到的 0-cell 数 |
| `sub_grid_cells` | int | 不在主 component 的 0-cell 数 |
| `a_reaches_b` | bool | A↔B 是否连通 |
| `path_length` | int | A→B BFS 距离 |
| `border_0_total` | int | 剩余 border 0-cell 数 |
| `border_0_on_path` | int | 在 path 上的 border 0-cells |
| `border_0_off_path` | int | **应该 = 0** |
| `junctions_on_path` | int | path 上的 3+ junction 数 (info) |
| `junctions_off_path` | int | 不在 path 上的 3+ junction 数 (info) |

### Helpers / 辅助函数

- `count_dead_ends(g) -> int` — count 1-neighbor 0-cells (4-conn)
- `count_junctions(g) -> int` — count ≥3-neighbor 0-cells (4-conn)

### I/O

- `save_grid_txt(g, path, meta=None)` — save grid as `.grid.txt`;
  `meta` dict becomes `# key: value` header comments
- `load_grid_txt(path) -> np.ndarray` — load `.grid.txt` → 0/1 uint8
- `grid_meta(path) -> dict[str, str]` — read only the metadata

---

## ✅ Spec & design choices / Spec 与设计取舍

### Spec (required, confirmed by users / 实际要求, 使用者确认)

| Check | Description |
|---|---|
| 2 entries on border | A, B in 4 edges |
| A↔B connected | path exists (`path_length > 0`) |
| Path as long as possible | BFS 2-pass + gate |
| Dead-ends preserved | 1-neighbor 0-cells kept |
| Sub-grids preserved | unreachable 0-cells kept |
| Multi-branch OK | cycles / junctions on path allowed |

### Design choices (internal / 非 spec, 内部工程选择)

| Decision | Reason |
|---|---|
| Greedy local optimum | 不追求 global optimal, paper 用途足够 |
| BFS distance gate = 5 | snake BFS=8 不杀, 相邻 cell BFS=1-2 杀 |
| Path cells may have 3+ neighbors | 保留 path 形状的代价 |
| Off-path junctions NOT closed in default | v19 起删除, 怕封太多 |

### NOT in spec / 不在 spec 里

- ❌ Result must be a strict tree (no cycle, no junction) — **not required**
- ❌ Result must be a single 0-component — **not required** (sub-grids preserved)
- ❌ Result must have only 2 border 0-cells — **not required** (linear snake keeps all)

---

## ⚠️ Known limitations / 已知 limitation

1. **chebyshev-4_mf8 path=2** — border too fragmented, BFS gate fallback
   picks adjacent cells. Spec still passes (A↔B connected), just short path.
2. **chebyshev dense grid** — chebyshev rule produces fragmented grids;
   sealed output looks noisy (not maze-like). Spec OK, just visually rough.
3. **Junctions on path** — cactus graph, not strict tree. **By design**
   (spec allows multi-branch).
4. **No global optimum guarantee** — greedy is local optimum. Reasonable
   on 12 test grids; theoretically a better solution may exist.

---

## 🔌 Integration / 整合到你的项目

### Option A: Copy the whole folder / 整个目录 copy

Place `maze_seal/` in your project, then:
```python
import sys
sys.path.insert(0, "/path/to/your/project")
from maze_seal import ga_to_maze, verify_maze
```

### Option B: Copy only the two algorithm files / 只 copy 两个算法文件

If you don't need package structure:
```python
# Place files in your_project/seal/
import sys
sys.path.insert(0, "your_project/seal")
from ga_to_maze import ga_to_maze, verify_maze
from ga_to_maze_io import save_grid_txt, load_grid_txt
```

`ga_to_maze.py` has no project-specific dependencies — standalone.

### Option C: Inline key functions / 内联关键函数

The 4 key functions to inline:
1. `find_border_corridors(g) -> list[(y, x)]`
2. `greedy_wall_removal(g, border_0, max_iters=50, verbose=False) -> (g_opt, score, history)`
3. `seal_to_maze(g, border_0) -> (maze, entry_a, entry_b, path)`
4. `ga_to_maze(g, verbose=False) -> dict` (wrapper around above 3)

`seal_to_maze` is the core (BFS 2-pass + path-aware seal). Off-path
junction close is `close_off_path_junctions()`, opt-in.

---

## 🧪 Testing / 测试

```bash
cd maze_seal
python example.py
```

Expected output (abridged):
```
Example 1: 5x9 linear snake
  ok: True
  entry_a: (0, 8)
  entry_b: (0, 0)
  path length: 9 cells
  verify:
    a_reaches_b: True
    border_0_off_path: 0
    ...
```

---

## 📜 Version history / 版本历史

- **v19** (2026-07-16): Removed Step 6 (close off-path junctions); made it
  a separate opt-in function. 12/12 grids pass, sealed ≈ 99% of raw
  (vs 89% in v18).
- **v18** (2026-07-16): Reordered to path-first seal; BFS gate uses
  threshold `< 5`; dropped "tree" docstring.
- **v15** (2026-07-15): Legacy version (close border first, path after).
- 7 bugs fixed since v1 (border leak, candidate unbound, multi-component,
  etc.).

---

## 🔗 Related / 相关

- Main project README: [../README.md](../README.md)
- Algorithm deep-dive: [../GUIDE.md](../GUIDE.md)
- Paper v2.5: shipped separately (not in this repo)

主项目 README: [../README.md](../README.md)
算法详解: [../GUIDE.md](../GUIDE.md)
论文 v2.5: 单独发布 (不在 repo 里)