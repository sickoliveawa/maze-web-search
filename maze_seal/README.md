# maze_seal — 把 raw CA grid 转换成 2-入口迷宫

> 一个独立的 Python 包,把任意 0/1 网格 (raw GA 输出) 转换成一个有 2 个入口、连通 A↔B path 的迷宫.

---

## 目录

- [这是什么](#这是什么)
- [文件清单](#文件清单)
- [快速上手](#快速上手)
- [算法原理](#算法原理)
- [API 参考](#api-参考)
- [Spec 与设计取舍](#spec-与设计取舍)
- [已知 limitation](#已知-limitation)
- [整合到你的项目](#整合到你的项目)

---

## 这是什么

**输入**: 一个 `numpy.ndarray`, 形状 `(H, W)`, dtype `uint8`, 值 `0` = corridor, `1` = wall.

**输出**: 一个 dict, 包含:
- `maze` (sealed grid) — 只保留 2 个入口和它们之间的 path
- `entry_a`, `entry_b` — 两个入口的 `(y, x)` 坐标
- `path` — 从 A 到 B 的完整 cell 序列
- `score` (top-2 sum, greedy 后的 BFS 距离估计)
- `border_0` / `meeting_cell` / `top1` / `top2` / `history` — 诊断信息

**核心特性**:
- ✅ 2 个入口都在 4 条边上
- ✅ A↔B 一定有连通的 path
- ✅ Path 尽量长 (greedy 拉长)
- ✅ 保留 dead-ends 和 unreachable sub-grids (视觉丰富度)
- ✅ Multi-branched 结构 (cycles, path 上的 junction) 允许

**约定**:
- `0` = corridor (通行)
- `1` = wall (阻挡)
- 4-连接 (上下左右)
- BFS 把 1 当作不可通过

---

## 文件清单

把这个目录整个发给她, 她解压后 `cd maze_seal && python example.py` 就能跑.

```
maze_seal/
├── README.md           ← 你正在看的 (详细说明)
├── __init__.py         ← 公开 API 入口 (9 个 funcs)
├── _ga_to_maze.py      ← 核心算法 (615 行, 无外部依赖)
├── _ga_to_maze_io.py   ← .grid.txt 格式 I/O (3 个 funcs)
└── example.py          ← 4 个使用示例
```

**依赖**:
- `numpy` (必须)
- Python 3.10+ (用了 `set[tuple]` / `list[tuple]` 类型注解)

**不依赖**:
- ❌ matplotlib (画图用, 可选)
- ❌ 任何 CA / GA / 评分代码
- ❌ 任何项目特定的文件路径

---

## 快速上手

### 方式 1: 命令行试一下

```bash
cd maze_seal
python example.py
```

会跑 4 个示例 (5×9 snake / 7×7 U-shape / I/O round-trip / 真实 GA grid).

### 方式 2: 集成到你的代码

```python
from maze_seal import ga_to_maze, verify_maze, save_grid_txt, load_grid_txt
import numpy as np

# 1. 你的 raw grid (来自 GA / CA / 任何地方)
g = np.ones((60, 40), dtype=np.uint8)
# ... 你自己的逻辑填 g ...

# 2. 调用 seal
result = ga_to_maze(g, verbose=False)

# 3. 检查结果
if result["ok"]:
    print(f"entry_a: {result['entry_a']}, entry_b: {result['entry_b']}")
    print(f"path:    {len(result['path'])} cells")
    print(f"score:   {result['score']}")
    
    # 4. (可选) 验证结果
    v = verify_maze(result["maze"], result["entry_a"], result["entry_b"])
    assert v["a_reaches_b"]
    assert v["border_0_off_path"] == 0
    
    # 5. (可选) 存盘
    save_grid_txt(
        result["maze"],
        "output.grid.txt",
        meta={
            "entry_a": result["entry_a"],
            "entry_b": result["entry_b"],
            "path_length": len(result["path"]),
        },
    )
else:
    print(f"failed: {result['reason']}")
```

### 方式 3: 从 .grid.txt 文件加载

```python
from maze_seal import load_grid_txt, ga_to_maze

g = load_grid_txt("my_grid.grid.txt")
result = ga_to_maze(g)
```

`.grid.txt` 格式说明 (在 `_ga_to_maze_io.py` 顶部 docstring):
```
# convention: 0=corridor, 1=wall, 4-conn
# shape: 40x60
# entry_a: (19, 39)
# entry_b: (23, 0)
40 60
1111111111...   ← H 行, 每行 W 个 0/1 字符
...
```

---

## 算法原理

### 总流程 (5 步, v19 删了原来的 Step 6)

```
raw grid g
   │
   ▼
[1] find_border_corridors: 扫 4 条边找 0-cells
   │       fail if < 2
   ▼
[2] greedy_wall_removal: 贪心拆墙, 拉长 path
   │       objective: 最大化 top-2 sum (BFS 距离)
   │       wall candidate: 1-cell 周围正好 2 个 0-neighbor
   │       loop: 试每个 candidate, 选让 score 最大的, 拆掉, repeat
   ▼
[3] 限制 border_0 到最大 0-component
   │       (防御: A↔B 必须连通)
   ▼
[4] BFS 2-pass 找 entry pair (A, B)
   │       经典 diameter approximation
   │       gate: if BFS(A, B) < 5, fallback 到 Manhattan-first 搜索
   ▼
[5] Path-aware seal: 算 path 在前, 关 border 在后
   │       (a) BFS from A in g (post-greedy)
   │       (b) 沿 parent tree 重建 path
   │       (c) 关掉 NOT on path 的 border 0-cells
   │       (d) 验证 A↔B 仍连通 (总是 true)
   ▼
maze, A, B, path
```

**注**: v18 原本有一个 "Step 6" 关 off-path junctions (≥3 0-neighbors). v19 删了 — 它在稠密 grid 里关掉 ~10% 的 corridor, 太多. **如果想要 clean 一点的图, 可以单独调用 `close_off_path_junctions(maze, path)`** (已暴露为 public function).

### Step 1 — find_border_corridors

扫 4 条边, 找 0-cells:

```python
border_0 = []
for x in range(W):
    if g[0, x] == 0: border_0.append((0, x))      # top
    if g[H-1, x] == 0: border_0.append((H-1, x))  # bottom
for y in range(H):
    if g[y, 0] == 0: border_0.append((y, 0))      # left
    if g[y, W-1] == 0: border_0.append((y, W-1))  # right
return sorted(set(border_0))
```

如果 `< 2` 个, return `ok=False`.

### Step 2 — greedy_wall_removal (拉长 path)

**目标**: 让两个入口之间的 path 尽量长.

**BFS dists**: 从每个 entry 出发 BFS, 得到 `dists[i]` = 从 entry i 到每个 0-cell 的距离.

**Top-2 sum**: 对每个 0-cell c, 算 `score(c) = top-1 + top-2` 距离 (排除 c 自己是 entry 的 dist=0).
全局 `score = max over c of score(c)` = "两个 entry 之间的最长 path 长度" 的估计.

**Wall candidate**: 1-cell 周围有**正好 2 个** 0-neighbor (4-连接, 任意方向). 拆掉这种墙, 2 条 corridor 合并成 1 条. **不会直接产生 3+ junction** (因为墙只有 2 个 0-neighbor).

**Greedy loop**:
- 对每个 candidate wall, 试着拆掉, 重算 score
- 选让 score 最大的那个, 真拆掉
- 重复, 直到没有任何 wall 能让 score 增加

⚠️ 局部最优, 不保证全局最优. 但对 paper 用途 OK.

### Step 3 — Component filter (防御性)

如果 border 上有 0-cells 在**不同的** 0-component, A↔B 没法跨 component 连通.

→ BFS from `border_0[0]`, 找最大 component, 把 `border_0` 限制到那个 component 里的 border cells.

### Step 4 — BFS 2-Pass 找 entry pair

经典 diameter 算法 (对 tree 精确, 对 general graph 是下界 approximation):

1. 从任意 border 0-cell 出发 BFS, 找到**最远**的 0-cell = `far_cell`
2. 从 `far_cell` 出发 BFS, 找到**最远**的 0-cell = `end_cell`
3. `entry_a = far_cell` (如果在 border, 否则用 d1 上最远的 border)
4. `entry_b = end_cell` (如果在 border, 否则用 d2 上最远的 border)
5. 退化处理: 如果 `entry_a == entry_b`, 取 d2 上次远的

**BFS distance gate** (防退化):
- 计算 `BFS(entry_a, entry_b)`
- 如果 `< 5`, 说明这俩 cell 在图上**太近** (e.g. (59,2)↔(59,3) 隔 1 个 wall, BFS=1-2)
- 调 `_find_connected_entry_pair`: 用 Manhattan 距离优先 + BFS tiebreaker 找更好的 pair
- **阈值 5 是关键**: 1×9 snake BFS=8 不触发 (snake 完整保留), 但相邻 cell BFS=1-2 触发 (改选远点)

### Step 5 — Path-Aware Seal (核心 fix)

**最关键的一步**.

**老版本 (v15) 的 bug**: 先关 border cells, 再算 path. 对 1×9 snake (path 本身沿着边走), 关掉中间的 border cells 直接把 A↔B 切断, fallback 选 (0,0)↔(0,1) → 2-cell maze. ✗

**新版本 (v18+) 的正确顺序**:
1. 在 `g` (post-greedy, 还没 seal) 上, 从 `entry_a` BFS, 拿 parent tree
2. 沿 parent tree 重建 path: `entry_b → ... → entry_a` (反向走 parent)
3. `path_set = set(path)`
4. 复制 `g` → `maze`
5. 关掉**不在 path 上**的 border 0-cells (not entry_a, not entry_b, not in path_set)

**为什么这样是对的**:
- 路径上所有的 cell 都在 `path_set` 里 → 全部保留
- 不在路径上的 border cells 关掉 (这些是 noise / 不在主 path 上的分支入口)
- A↔B 通过 `path_set` 仍 4-连通, 因为 path 链完整

**对 1×9 snake**: path = 整条 snake, 全部 9 个 cell 都在 path 上 → 全部保留 → 9-cell maze ✓

**对稠密 grid (e.g. top1)**: path 是从 (19,39) 到 (23,0) 的 BFS 最短路, 不经过其他 border cells → 21 个原始 border cells 只剩 A 和 B ✓

### 可选 Step — close_off_path_junctions (v19 暴露, 默认不跑)

v18 原本有个 Step 6 会关掉 off-path junctions (≥3 0-neighbors). v19 删了, 因为它在稠密 grid 里关掉 ~10% 的 corridor, 太多.

如果想要更"clean" 的图 (类似树状), 可以单独调用:

```python
from maze_seal import ga_to_maze, close_off_path_junctions

result = ga_to_maze(g)
# 单独再跑一次 (可选)
n_closed = close_off_path_junctions(result["maze"], result["path"])
print(f"closed {n_closed} extra junctions")
```

**参数**:
- `maze`: 会 in-place 修改
- `path`: A→B path (这些 cell 不会动)
- `min_degree` (default 3): 触发关闭的最小邻居数. 用 4 更保守 (只关四方路口).

---

## API 参考

### `ga_to_maze(g, verbose=False) -> dict`

**主入口**. 把 raw grid 转换成 sealed maze.

**Args**:
- `g` (np.ndarray, shape `(H, W)`, dtype `uint8`): 0/1 grid
- `verbose` (bool, default `False`): 是否打印每步状态

**Returns** (dict):
| key | type | 说明 |
|-----|------|------|
| `ok` | bool | 是否成功 (False if < 2 entries) |
| `reason` | str | 失败原因 (success 时为空) |
| `maze` | np.ndarray | sealed grid (same shape as input) |
| `entry_a` | (y, x) | 入口 1 |
| `entry_b` | (y, x) | 入口 2 |
| `path` | list of (y, x) | A→B 完整路径 |
| `score` | int | 贪心后的 top-2 sum (max BFS 距离估计) |
| `border_0` | list of (y, x) | 用到的 border cells (被限制到最大 component) |
| `meeting_cell` | (y, x) | top-2 sum 最大时的 cell (诊断用) |
| `top1`, `top2` | int | top-1, top-2 BFS 距离 |
| `history` | list | greedy 迭代历史 |

### `seal_to_maze(g, border_0) -> tuple`

**5 步 pipeline 的核心**. v18 之前返回 5-tuple 含 `closed_junctions`, v19 改成 4-tuple.

**Args**:
- `g` (np.ndarray): post-greedy grid
- `border_0` (list of (y, x)): entries

**Returns**: `(maze, entry_a, entry_b, path)`

### `close_off_path_junctions(maze, path, min_degree=3) -> int`

**可选 post-processing**. 关闭不在 path 上、邻居数 ≥ `min_degree` 的 0-cells.

```python
from maze_seal import ga_to_maze, close_off_path_junctions

result = ga_to_maze(g)
n = close_off_path_junctions(result["maze"], result["path"])
# 改 result["maze"] in place
```

**Args**:
- `maze` (np.ndarray): 会 in-place 修改
- `path` (list of (y, x)): A→B path, 不会被关
- `min_degree` (int, default 3): 触发关闭的最小邻居数

**Returns**: 关掉的 cell 数 (int)

### `verify_maze(g, entry_a, entry_b) -> dict`

**验证 sealed maze**. 不修改 g.

**Returns** (dict):
| key | type | 说明 |
|-----|------|------|
| `total_0_cells` | int | maze 里 0-cell 总数 |
| `reachable_from_a` | int | 从 A BFS 能到的 0-cell 数 |
| `sub_grid_cells` | int | 不在主 component 的 0-cell 数 (sub-grids) |
| `a_reaches_b` | bool | A↔B 是否连通 |
| `path_length` | int | A→B BFS 距离 (cells) |
| `border_0_total` | int | 剩余 border 0-cell 数 |
| `border_0_on_path` | int | 在 path 上的 border 0-cells |
| `border_0_off_path` | int | 不在 path 上的 border 0-cells (**应该 = 0**) |
| `junctions_on_path` | int | path 上的 3+ junction 数 (info only) |
| `junctions_off_path` | int | 不在 path 上的 3+ junction 数 (默认 ga_to_maze 不关, 只 info) |

### `count_dead_ends(g) -> int`

数 0-cells with exactly 1 0-neighbor (4-conn). 即"死胡同"数量.

### `count_junctions(g) -> int`

数 0-cells with ≥3 0-neighbors (4-conn). 即"分叉点"数量.

### I/O

- `save_grid_txt(g, path, meta=None)`: 把 grid 存为 `.grid.txt` 格式. `meta` dict 会变成 `# key: value` 注释.
- `load_grid_txt(path) -> np.ndarray`: 加载 `.grid.txt` → 0/1 uint8 array.
- `grid_meta(path) -> dict[str, str]`: 只读 metadata (注释行).

---

## Spec 与设计取舍

### Spec (实际要求, 由使用者确认)

| 检查项 | 描述 |
|--------|------|
| 2 entries on border | A, B 在 4 条边上 |
| A↔B 连通 | 有 path (`path_length > 0`) |
| Path 尽量长 | BFS 2-pass + gate 优化 |
| 保留 dead-ends | 1-neighbor 0-cells 保留 |
| 保留 sub-grids | unreachable 0-cells 保留 |
| 多分枝结构 OK | cycles / path 上的 junctions 允许 |

### Design choice (非 spec, 内部工程选择)

| 决定 | 原因 |
|------|------|
| Greedy local optimum | 不追求 global optimal, 反正 paper 用途 |
| BFS distance gate 阈值 5 | 经验值: snake BFS=8 不杀, 相邻 cell BFS=1-2 杀 |
| Path cell 可能有 3+ 邻居 | 保留 path 形状的代价, spec 允许 |
| 不在 default flow 里关 off-path junction | v19 删了, 怕用户嫌封太多. 想要的话手动 `close_off_path_junctions()` |

### 不在 spec 里 (虽然早期 docstring 写过)

- ❌ Result 必须是严格 tree (无 cycle, 无 junction) — **没要求**
- ❌ Result 必须 single 0-component — **没要求** (sub-grids 保留作为 noise)
- ❌ Result 必须只有 2 个 border 0-cells — **没要求** (linear snake 全部保留)

---

## 已知 Limitation

1. **chebyshev-4_mf8 path=2**: 边太碎, BFS gate fallback 选到相邻 cell. spec 仍 pass (A↔B 连通), 但 path 短.
2. **chebyshev dense grid**: chebyshev rule 出的图本身就碎, sealed 后看着像噪点 (不是迷宫). spec 兼容, 只是视觉差.
3. **path 上有 junction**: 仙人掌图, 不是严格 tree. **有意为之** (spec 允许多分枝).
4. **不追求 global optimal**: greedy 是 local optimum. 对 12 个测试 grid 都给出合理结果, 但理论上可能存在更优解.

---

## 整合到你的项目

### 选项 A: 整个 copy 过去

把 `maze_seal/` 整个目录放到你的项目里, 然后:

```python
import sys
sys.path.insert(0, "/path/to/your/project")
from maze_seal import ga_to_maze, verify_maze
```

### 选项 B: 只 copy `_ga_to_maze.py` + `_ga_to_maze_io.py`

如果你的项目不需要 package 结构, 直接 copy 这两个文件:

```python
# 假设你放在 your_project/seal/
import sys
sys.path.insert(0, "your_project/seal")
from _ga_to_maze import ga_to_maze, verify_maze
from _ga_to_maze_io import save_grid_txt, load_grid_txt
```

⚠️ 注意: `_ga_to_maze.py` 不依赖任何项目特定代码, 可以独立使用.

### 选项 C: 内联到你现有代码

如果你想 inline 到你的 codebase, 关键的 4 个函数是:

1. `find_border_corridors(g)` → list of (y, x)
2. `greedy_wall_removal(g, border_0, max_iters=50, verbose=False)` → (g_opt, score, history)
3. `seal_to_maze(g, border_0)` → `(maze, entry_a, entry_b, path)` (4-tuple, v19 起)
4. `ga_to_maze(g, verbose=False)` → dict (上面 3 步的 wrapper, 加 component filter)

`seal_to_maze` 是核心, 包含 BFS 2-pass + path-aware seal. Off-path junction close 是 `close_off_path_junctions()`, 默认不跑, 需要时单独调.

---

## 测试

跑 4 个 example:
```bash
cd maze_seal
python example.py
```

期望输出 (截取):
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

## 版本

- **v19** (2026-07-16): 删除 Step 6 (close off-path junctions), 改为独立可选 function. 12/12 grids pass, sealed ≈ 99% of raw (vs 89% in v18).
- v18 (2026-07-16): 重排为 path-first seal, BFS gate 改用 BFS<5 阈值, 删 "tree" docstring
- v15 (2026-07-15): 旧版 (close border 在前, path 在后)
- 7 bugs fixed since v1 (border leak, candidate unbound, multi-component, etc.)
