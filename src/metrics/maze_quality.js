/**
 * maze_quality.js — 7 sub-metric + 2-level aggregation (sko 06-29 新设计)
 *
 * 设计原则 (跟 bellotScore 5 hard gate 完全不同):
 *   1. **没有 hard gate** — 所有 sub-metric ∈ [0, 1] 平滑连续
 *   2. **有梯度 (gradient)** — 任一 sub-metric 提升 → M_maze 提升, ES 可学
 *   3. **2-level 聚合** — 抗 fractal 反例 (fractal topology 高但 diversity 低)
 *
 * 7 sub-metric:
 *   M_branching : 4-conn degree Shannon entropy (复用 normalizedBranchEntropy)
 *   M_spread    : pathRatio = longestPath / totalRoads (复用 patternComplexity)
 *   M_junction  : junction count / total (复用 cellClassification)
 *   M_solve     : spatial balance (复用 quadrantBalance)
 *   M_pattern   : 2x2 patch Shannon entropy (复用 patternComplexity)
 *   M_asymmetry : 1 - symmetry (复用 symmetryBias)
 *   M_transition: 2x2 patch pair (current, right) Shannon entropy (新)
 *
 * 2-level aggregation (sko 06-29 v2 — weighted geo mean, 提升瓶颈权重):
 *   M_topology  = M_branching^0.20 × M_spread^0.20 × M_junction^0.20 × M_connectedness^0.40
 *     (C 权重 2x: ES 06-29 发现 M_connectedness=0.28 是主要瓶颈, 4-geom-mean 太温和)
 *
 *   M_diversity = M_pattern^0.25 × M_asymmetry^0.25 × M_transition^0.50
 *     (T 权重 2x: M_transition=0.34 是次要瓶颈, 3-geom-mean 同样太温和)
 *
 *   M_maze      = sqrt(M_topology × M_diversity)
 *
 * 期望评分 (跟 v1 一样, 但梯度更陡):
 *   - DFS 完美 maze:           M_maze ≈ 0.92
 *   - 5.60 capture (visual):   M_maze ≈ 0.83
 *   - 7.08 web:                M_maze ≈ 0.69
 *   - 5.21 noise:              M_maze ≈ 0.56
 *   - 35.70 diagonal line:     M_maze ≈ 0.28 (M_topology 拉低, 有梯度)
 *   - 螺旋反例:                M_maze ≈ 0.21
 *   - Fractal tree:            M_maze ≈ 0.41 (M_diversity 拉低, 抗重复)
 *   - Random noise:            M_maze ≈ 0.50 (有梯度, 不卡 0)
 *
 * 重要: 不替代 bellotScore, 跟它并行存在. bellotScore 留着做 calibration 对比.
 */

import { normalizedBranchEntropy } from './branch_entropy.js';
import { cellClassification, similarityCheck } from '../gpu/bellot_metrics.js';
import { quadrantBalance, patternComplexity } from '../gpu/bellot_metrics.js';
import { symmetryBias } from './symmetry.js';
import { DIRS } from './connectivity.js';

// ============ 7 sub-metric 各自计算 (全部 [0, 1] 平滑) ============

/**
 * M_branching: corridor-dominant-ness
 *   真 maze 特征: 大部分 cell = corridor (degree 2, 90%+), 少量 dead-end + junction
 *   noise / blob: degree 分布均匀 (各 20-25%)
 *   formula: corridor_count / total_roads  (不是 entropy, 是 dominant ratio)
 *   - 真 maze: 0.85+ 满分
 *   - blob / dense: 0.5 中
 *   - noise: 0.3 低
 *   - spiral: 0.95+ 高
 *   - fractal: 0.4-0.6 中
 *   注意: spiral 也会 0.95+, 但被 M_spread 拒 (longestPath/V=1)
 */
function mBranching(gridData, width, height) {
  const counts = [0, 0, 0, 0, 0];
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (gridData[idx] === 0) continue;
      let n = 0;
      if (y > 0 && gridData[idx - width] > 0) n++;
      if (y < height - 1 && gridData[idx + width] > 0) n++;
      if (x > 0 && gridData[idx - 1] > 0) n++;
      if (x < width - 1 && gridData[idx + 1] > 0) n++;
      counts[n]++;
      total++;
    }
  }
  if (total === 0) return 0;
  // corridor = degree 2, dominant ratio
  // 0.85+ 满分 (用 1 - exp(-(ratio-0.5)/0.15) 让 < 0.5 衰减到 0)
  const ratio = counts[2] / total;
  return Math.min(1, Math.max(0, (ratio - 0.4) / 0.5));
}

/**
 * M_spread: pathRatio = longestPath / totalRoads
 *   - 真 maze: 0.5-0.97 (树状, 1 条 long path 走遍 road)
 *   - ghost CA: 0.05-0.20 (cycle 太多, path 短)
 *   - spiral: 0.9+ (1 条 line 走完所有)
 *   - linear: 0.95+ (1 条对角线)
 *   - 反螺旋要再乘 spread factor (longestPath 不能占 80%+ nodes)
 *     实际上 spread = 1 - longestPath/V 才是 spread, 不是 pathRatio
 *   - 改用: M_spread = 1 - max(0, longestPath/V - 0.5) / 0.5
 *     longestPath/V = 0.5 → 1.0 (满分)
 *     longestPath/V = 0.7 → 0.6
 *     longestPath/V = 0.9 → 0.2
 *     longestPath/V = 1.0 → 0.0
 *   这样 35.70 diagonal (longestPath=27, V=100, ratio=0.27) → 满分
 *      spiral (longestPath=600, V=600) → 0
 *      真 DFS (longestPath=0.5*V) → 1
 *      ghost CA (longestPath=0.1*V) → 1
 *   - 但 ghost 会被 M_junction 拉低 (没 junction = 0)
 *   - spiral 也会被 M_branching 拉低 (几乎全 degree=2 → H 低)
 */
function mSpread(gridData, width, height, totalRoads) {
  // 调用 patternComplexity 拿 longestPath
  const pc = patternComplexity(gridData, width, height);
  if (totalRoads === 0) return 0;
  const ratio = pc.longestPath / totalRoads;
  // 0.3-0.5 是好, 0.5+ 是 spiral/linear 反例
  if (ratio <= 0.5) return Math.min(1, ratio / 0.3);  // 0 → 0, 0.3 → 1, 0.5 → 1
  // > 0.5 衰减
  return Math.max(0, 1 - (ratio - 0.5) / 0.5);  // 0.5 → 1, 0.75 → 0.5, 1.0 → 0
}

/**
 * M_junction: junction count / total
 *   - junction = cell with degree 3 (1 wall + 3 roads)
 *   - 真 maze: 5-15% junction (适中)
 *   - 没 junction = 死线, 全 junction = blob
 *   - 公式: bell curve, peak 0.10
 *     ratio = 0 → 0, ratio = 0.10 → 1, ratio = 0.20 → 0.5, ratio = 0.30 → 0
 */
function mJunction(gridData, width, height) {
  const cls = cellClassification(gridData, width, height);
  const totalRoads = cls.crossroad + cls.junction + cls.straight + cls.turn + cls.deadEnd + cls.isolated;
  if (totalRoads === 0) return 0;
  const ratio = (cls.junction + cls.crossroad) / totalRoads;
  // Bell curve peak 0.10, half-width 0.10
  return Math.exp(-Math.pow((ratio - 0.10) / 0.10, 2));
}

/**
 * M_connectedness: largest cluster / total roads (linear, no clip)
 *   sko 07-08 v6: 之前有 `/ 0.8` clip 让 0.80+ 都饱和到 1.0
 *     实际 ES 跑出来 largest/totalRoads 都在 0.92-1.00 之间, clip 之后没区分度
 *     改成纯线性, 0.92 → 0.92 (不饱和), 0.50 → 0.50
 *   - 真 maze: 1 cluster, 100% 全部连通 → 1.0
 *   - noise: 多 cluster, largest < 5% total → 0.05
 *   - fractal: 1 connected tree → 高
 *   - spiral: 1 connected path → 1.0
 *   备份: src/metrics/maze_quality.js.bak_2026-07-08_connectedness_uncap
 */
function mConnectedness(gridData, width, height) {
  // First count totalRoads (all road cells)
  let totalRoads = 0;
  for (let i = 0; i < gridData.length; i++) if (gridData[i] > 0) totalRoads++;
  if (totalRoads === 0) return 0;
  // Then BFS to find largest cluster
  const visited = new Uint8Array(width * height);
  let largestSize = 0;
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] === 0 || visited[i]) continue;
    const queue = [i]; visited[i] = 1;
    let head = 0, size = 0;
    while (head < queue.length) {
      const c = queue[head++]; size++;
      const x = c % width, y = (c - x) / width;
      if (x > 0 && gridData[c-1] > 0 && !visited[c-1]) { visited[c-1]=1; queue.push(c-1); }
      if (x < width - 1 && gridData[c+1] > 0 && !visited[c+1]) { visited[c+1]=1; queue.push(c+1); }
      if (y > 0 && gridData[c-width] > 0 && !visited[c-width]) { visited[c-width]=1; queue.push(c-width); }
      if (y < height - 1 && gridData[c+width] > 0 && !visited[c+width]) { visited[c+width]=1; queue.push(c+width); }
    }
    if (size > largestSize) largestSize = size;
  }
  // v6: 纯线性 largestSize / totalRoads, 无 clip (0.92 → 0.92, 不再饱和到 1.0)
  return largestSize / totalRoads;
}

/**
 * M_boundary: outer ring alive count → 1.0 (closed) → 0.0 (all open)
 *   sko 06-29: 真 maze 必须是封闭的, 外圈应该是墙. 之前 0.7591 grid 外圈 96.9% 活
 *     (top 93%, bot 100%, left 100%, right 95%) → M_connectedness=1.0 全靠外圈撑
 *   真 maze: 1-4 个 entry/exit cell, 其余 dead
 *   - alive <= 4 (entry + exit): 1.0 (perfect closed maze)
 *   - alive >= 64 (most open): 0.0 (exploit)
 *   - in between: linear decay
 */
function mBoundary(gridData, width, height) {
  let alive = 0;
  for (let x = 0; x < width; x++) {
    if (gridData[x] > 0) alive++;
    if (gridData[(height-1)*width + x] > 0) alive++;
  }
  for (let y = 0; y < height; y++) {
    if (gridData[y*width] > 0) alive++;
    if (gridData[y*width + width - 1] > 0) alive++;
  }
  // 4 corners counted twice; dedupe by subtracting 4 if all 4 are alive
  if (alive <= 4) return 1.0;
  if (alive >= 80) return 0.0;
  return Math.max(0, 1 - (alive - 4) / 76);
}

/**
 * M_pattern: 2x2 patch Shannon entropy 归一化
 *   - 16 种 patch, log2(16) = 4
 *   - 真 maze: 0.85-0.95
 *   - stripes: 0.2-0.4
 *   - solid: 0
 *   - 复用 patternComplexity
 */
function mPattern(gridData, width, height) {
  const pc = patternComplexity(gridData, width, height);
  return pc.patchEntropy;  // 已经在 [0, 1]
}

/**
 * M_asymmetry: 翻转后 road cell 不变性 (vs random baseline 0.5)
 *   similarityCheck 算的是 wall + road cell 总 match, baseline 0.75 (wall 100% match)
 *   这里只算 road cell match, baseline 0.5 (random)
 *   - 真 maze: 翻转后 50% road 重合 (random) → M_asymmetry = 1 (满分)
 *   - fractal: 翻转后 100% road 重合 (自对称) → M_asymmetry = 0
 *   - noise: 50% (random) → 1 (跟 DFS 一样, 没法靠这区分)
 *   - stripes: 100% (周期) → 0
 *   formula: M_asymmetry = max(0, 1 - (maxMatch - 0.5) / 0.5) = max(0, 2*(1-maxMatch))
 *   maxMatch ∈ [0.5, 1.0], 0.5 → 1.0, 1.0 → 0
 *   ⚠️ 跟 noise 区分需要 M_connectedness (M_asymmetry 1.0 一样, M_connectedness 0.05 vs 1.0)
 */
function mAsymmetry(gridData, width, height) {
  let totalRoad = 0;
  for (let i = 0; i < gridData.length; i++) if (gridData[i] > 0) totalRoad++;
  if (totalRoad === 0) return 0;
  let maxMatch = 0;
  // 3 个 transform: hflip, vflip, r180 (r90 在非方形 grid 越界, 跳过)
  for (const transform of ['h', 'v', 'r180']) {
    let matches = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let nx, ny;
        if (transform === 'h') { nx = width - 1 - x; ny = y; }
        else if (transform === 'v') { nx = x; ny = height - 1 - y; }
        else { nx = width - 1 - x; ny = height - 1 - y; }
        if (gridData[y * width + x] > 0 && gridData[ny * width + nx] > 0) matches++;
      }
    }
    const sym = matches / totalRoad;
    if (sym > maxMatch) maxMatch = sym;
  }
  // 2-threshold:
  //   maxMatch < 0.55: 纯 random noise (低分, 但被 M_connectedness 救)
  //   0.55-0.85: 真 maze (connected, 不自相似) → 满分 1
  //   > 0.85: 自相似 / 周期 (拒, 衰减)
  if (maxMatch < 0.55) return 0.5;
  if (maxMatch < 0.85) return 1.0;
  return Math.max(0, 1 - (maxMatch - 0.85) / 0.15);
}

/**
 * M_transition: 2x2 patch pair (current, right) Shannon entropy
 *   - 2x2 = 4 bits, 16 种
 *   - pair (a, b) where b 左 2 cell = a 右 2 cell
 *   - 实际有效 pair < 256 (受 overlap 限制)
 *   - 真 maze: pair 分布均匀, H 高
 *   - fractal: 重复 pair, H 低
 *   - horizontal stripes: pair 少, H 低
 *   - random: H 高
 *   - 归一化除以 log2(256) = 8
 */
function mTransition(gridData, width, height) {
  if (width < 2 || height < 1) return 0;
  const pairCounts = new Map();
  let total = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      // 2x2 patch 1 (current)
      const a = (gridData[y*width + x] > 0 ? 1 : 0) << 3
              | (gridData[y*width + x + 1] > 0 ? 1 : 0) << 2
              | (gridData[(y+1)*width + x] > 0 ? 1 : 0) << 1
              | (gridData[(y+1)*width + x + 1] > 0 ? 1 : 0);
      // 2x2 patch 2 (right): column x+1, x+2
      if (x + 2 >= width) continue;
      const b = (gridData[y*width + x + 1] > 0 ? 1 : 0) << 3
              | (gridData[y*width + x + 2] > 0 ? 1 : 0) << 2
              | (gridData[(y+1)*width + x + 1] > 0 ? 1 : 0) << 1
              | (gridData[(y+1)*width + x + 2] > 0 ? 1 : 0);
      const key = a * 16 + b;
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      total++;
    }
  }
  if (total === 0) return 0;
  let h = 0;
  for (const c of pairCounts.values()) {
    if (c > 0) {
      const p = c / total;
      h -= p * Math.log2(p);
    }
  }
  return h / 8.0;  // log2(256) = 8
}

// ============ 2-level 聚合 ============

/**
 * M_maze: 7 sub-metric 2-level 聚合, 输出 [0, 1]
 *
 * 7 sub-metric:
 *   M_branching   : corridor-dominant (degree 2 ratio)
 *   M_spread      : pathRatio smoothed
 *   M_junction    : Bell curve peak 0.10
 *   M_connectedness: largest cluster / total
 *   M_pattern     : 2x2 patch entropy
 *   M_asymmetry   : 1 - 2*(road_flip_match - 0.5)
 *   M_transition  : 2x2 patch pair entropy
 *
 * 2-level:
 *   M_topology  = 1 - (1 - B)(1 - S)(1 - J)(1 - C)  (4 概率或)
 *   M_diversity = (P × A × T)^(1/3)  (3 几何平均)
 *   M_maze      = (M_topology × M_diversity)^(1/2)
 */
export function mazeQuality(gridData, width, height) {
  // 0. 计算 totalRoads (给 mSpread 用)
  let totalRoads = 0;
  for (let i = 0; i < gridData.length; i++) if (gridData[i] > 0) totalRoads++;
  if (totalRoads === 0) {
    return {
      total: 0,
      breakdown: {
        M_branching: 0, M_spread: 0, M_junction: 0, M_connectedness: 0,
        M_connectedness_raw: 0,
        M_pattern: 0, M_asymmetry: 0, M_transition: 0,
        M_topology: 0, M_diversity: 0,
      },
    };
  }

  // 1. 8 sub-metric (sko 06-29 v4: 加 mBoundary 修复外圈 exploit)
  // 07-01: mC squaring was tried but reverted — only swapped attractors (old "nested frames"
  // → new "empty-box frame"), didn't push ES toward real maze topology. User prefers honest
  // linear metric. M_connectedness_raw preserved for diagnostic / future re-tuning.
  const mB = mBranching(gridData, width, height);
  const mS = mSpread(gridData, width, height, totalRoads);
  const mJ = mJunction(gridData, width, height);
  const mC_raw = mConnectedness(gridData, width, height);
  const mC = mC_raw;  // linear (07-01 reverted)
  const mP = mPattern(gridData, width, height);
  const mA = mAsymmetry(gridData, width, height);
  const mT = mTransition(gridData, width, height);
  const mBnd = mBoundary(gridData, width, height);  // ← 新增

  // 2. M_topology: weighted 5-几何平均 (sko 07-08 v5 — 视觉 vs 评分一致性 fix)
  //   之前 v4: B/S/J 0.10, C 0.40, Bnd 0.30  → 边界墙 (mBnd=1) + 连通 (mC=1) 拉分太重
  //   导致 manhattan-2/mf=8 (boundary=1.00, connectedness=0.92, branching=0.55) 排到 #1
  //   但视觉上是"几条长通道 + 大片空旷",branching/junction 偏低, 缺"迷宫感"
  //   v5 重新分配: B 0.20, S 0.15, J 0.20, C 0.30, Bnd 0.15  (sum = 1.0)
  //   branching/junction 权重 + (0.10→0.20), boundary 权重 - (0.30→0.15)
  //   connectedness 权重 - (0.40→0.30)
  //   实测: chebyshev-1/chebyshev-2 升到 #1/#2, manhattan-2 从 #1 跌到 #3
  //         失败案例 (WR_gate 锁住) 排名不变
  //   备份: src/metrics/maze_quality.js.bak_2026-07-08_topology_weight
  const mTopology = Math.pow(mB, 0.20) * Math.pow(mS, 0.15) * Math.pow(mJ, 0.20) * Math.pow(mC, 0.30) * Math.pow(mBnd, 0.15);

  // 3. M_diversity: weighted 3-几何平均 (sko 06-29 v2 — 提升 M_transition 权重)
  //   v1: 均匀 1/3, M_transition=0.34 被 mA=1.0 拉回到 0.57
  //   v2: T 权重 0.50 (2x), 0.34 → mDiv 降低, ES 看到梯度
  //   0.25+0.25+0.50 = 1.0 (归一化)
  const mDiversity = Math.pow(mP, 0.25) * Math.pow(mA, 0.25) * Math.pow(mT, 0.50);

  // 4. M_maze: sko 06-29 v3 — min(mTop, mDiv) (代替 sqrt(mTop * mDiv))
  //   原因: geometric mean 允许 "topology 0.69, diversity 0.05 → M_maze 0.19"
  //   这种 mode collapse 让 ES exploit 单边 (高 C, 低 P/T).
  //   min 强制 balance: 短板决定分数, 强制 ES 同步提升两边.
  //   这不是 hard gate (没阈值), 是结构性 balance.
  //   v2 best (0.3601): mTop=0.69, mDiv=0.19 → v3 = 0.19 (暴跌)
  //   v1 best (0.5550): mTop=0.48, mDiv=0.57 → v3 = 0.48 (略降)
  //   DFS gold: mTop=1, mDiv=1 → v3 = 1.0 (满分)
  //   效果: 阻止 degenerate 解, ES 必须真提升 P/T 才能爬 score
  const mMazeBase = Math.min(mTopology, mDiversity);
  // 07-01 (sko): wall-ratio gate breaks "frame + cavity" attractor (~5% walls → gate≈0).
  // Triangle: 1.0 in [0.30, 0.45], linear ramp out, hard 0 outside.
  const m_WR_gate = wallRatioGate(gridData);
  const mMaze = mMazeBase * m_WR_gate;

  return {
    total: mMaze,
    breakdown: {
      M_branching: mB, M_spread: mS, M_junction: mJ,
      M_connectedness: mC,        // linear (07-01 reverted — was squared but didn't help)
      M_connectedness_raw: mC_raw,  // same as M_connectedness now, kept for diagnostic
      M_pattern: mP, M_asymmetry: mA, M_transition: mT, M_boundary: mBnd,
      M_topology: mTopology, M_diversity: mDiversity,
      M_wall_ratio: countWalls(gridData) / gridData.length,
      M_WR_gate: m_WR_gate,
    },
  };
}

/**
 * wallRatioGate — 07-02 (sko v2): soft bell-shaped density score. NOT a hard gate.
 * Mirrors maze-es/src/maze_es/metrics/maze_quality.py:wallRatioGate.
 *
 * Per user: "只要不是 0 或 1 就有分,0.4-0.6 分最高" — any non-extreme density
 * gets some credit; the maze-typical band 0.4-0.6 is the maximum.
 *
 * Shape (triangular peak over [0.40, 0.60], linear falloff to 0 at extremes):
 *   ratio = 0 / 1               → 0.0  (empty / solid)
 *   0 → 0.40                    → linear ramp 0 → 1
 *   0.40 → 0.60                 → 1.0  (peak — maze-typical)
 *   0.60 → 1.0                  → linear ramp 1 → 0
 *
 * Replaces the hard-trapezoid [0.40, 0.60] that killed frame/cavity (3-8% wall).
 * With the soft bell, ES gets gradient across the whole density range.
 *
 * M4 SOTA (0.487) → 1.0 ✓
 * frame+cavity (~0.05) → 0.125 (gradient signal preserved)
 */
function wallRatioGate(gridData) {
  const total = gridData.length;
  if (total === 0) return 0.0;
  const ratio = countWalls(gridData) / total;
  if (ratio <= 0.0 || ratio >= 1.0) return 0.0;
  if (ratio < 0.40) return ratio / 0.40;             // 0→0, 0.40→1
  if (ratio > 0.60) return (1.0 - ratio) / 0.40;     // 0.60→1, 1.0→0
  return 1.0;                                        // 0.40–0.60 peak
}

function countWalls(gridData) {
  // Convention: 0 = wall, 1 = corridor (matches _generateDFSMaze bellot output)
  // countWalls counts the NON-corridor cells (i.e., 0-valued cells = walls)
  let n = 0;
  for (let i = 0; i < gridData.length; i++) if (gridData[i] === 0) n++;
  return n;
}

// ============ 单元测试 ============

/**
 * 测试用: 生成真 DFS perfect maze (recursive backtracker)
 * 返回 Uint8Array (1=road, 0=wall) — bellot convention
 * 内部调用 _maze_dfs.js (grid.set 0=road) 然后 invert
 */
export function _generateDFSMaze(W, H, seed = 42) {
  // 强制奇数
  if (W % 2 === 0) W++;
  if (H % 2 === 0) H++;
  // 简单 inline DFS — 不依赖 _maze_dfs.js (避免 ES module 路径问题)
  const grid = new Uint8Array(W * H);
  for (let i = 0; i < grid.length; i++) grid[i] = 1;  // 1=wall initially (DFS convention)
  const visited = new Uint8Array(W * H);
  // LCG RNG
  let s = seed;
  function rand() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }
  function nextInt(n) { return Math.floor(rand() * n); }

  function carve(x, y) {
    visited[y * W + x] = 1;
    grid[y * W + x] = 0;  // 0=road (DFS internal)
    const dirs = [[0, -2], [2, 0], [0, 2], [-2, 0]];
    // Fisher-Yates
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = nextInt(i + 1);
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx <= 0 || nx >= W - 1 || ny <= 0 || ny >= H - 1) continue;
      if (visited[ny * W + nx]) continue;
      grid[((y + ny) / 2) * W + (x + nx) / 2] = 0;
      carve(nx, ny);
    }
  }
  carve(1, 1);
  // Invert: DFS 0=road → bellot 1=road
  const bellot = new Uint8Array(W * H);
  for (let i = 0; i < grid.length; i++) bellot[i] = grid[i] === 0 ? 1 : 0;
  return bellot;
}

/**
 * 测试用: 生成 spiral
 */
/**
 * 生成同心螺旋迷宫 (1 = 墙, 0 = 通道):
 *   - 外圈 border 是墙 (1)
 *   - 内部是宽度 1 的螺旋通道 (0), 从外圈 (layer 0) 顺时针向中心盘旋
 *   - 单条 1-cell 宽长廊, 起点外圈入口, 终点中心
 *   - 这是迷宫反例: 有 1 条贯穿全图的 path 但没有 branching/junction
 */
export function _generateSpiral(W, H) {
  // 连续 Archimedean 螺旋 (true single-stroke Archimedean-like spiral, 0 = wall, 1 = corridor)
  // 与 _generateDFSMaze (bellot convention: 0=wall, 1=corridor) 保持一致
  // 参数: r(t) = R * (1 - t / T), t ∈ [0, T]   T = turns * 2π
  // 起点: r = R, theta = 0  (右, (cx+R, cy))
  // 终点: r = 0, theta = T  (中心)
  // R = min(cx, cy) - 1 (留 1 cell 给 border)
  const data = new Uint8Array(W * H).fill(0);  // 初始全 wall (0=wall)
  // 外圈保留 wall border
  for (let x = 0; x < W; x++) { data[x] = 0; data[(H - 1) * W + x] = 0; }
  for (let y = 0; y < H; y++) { data[y * W] = 0; data[y * W + (W - 1)] = 0; }
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  // R 留 2 cell 给 border (避免 spiral 太靠边)
  const R = Math.min(cx, cy) - 2;
  // 8 圈让 wall_ratio 落在 0.40-0.60 (maze 范围), 不被 WR_gate 拒
  const turns = 8;
  const T = turns * 2 * Math.PI;
  const nPoints = 8000;
  for (let i = 0; i < nPoints; i++) {
    const t = (i / nPoints) * T;
    const r = R * (1 - t / T);
    const x = Math.round(cx + r * Math.cos(t));
    const y = Math.round(cy + r * Math.sin(t));
    if (x > 0 && x < W - 1 && y > 0 && y < H - 1) {
      data[y * W + x] = 1;  // corridor
    }
  }
  return data;
}

/**
 * 测试用: 生成 fractal tree (NOT self-symmetric — 用随机角度)
 */
export function _generateFractalTree(W, H, depth = 4) {
  const data = new Uint8Array(W * H);
  const cx = Math.floor(W / 2);
  const cy = Math.floor(H / 2);
  // LCG
  let s = 12345;
  function rand() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }
  function drawBranch(x, y, angle, len, d) {
    if (d <= 0 || len < 1) return;
    const dx = Math.cos(angle) * len;
    const dy = Math.sin(angle) * len;
    const ex = Math.round(x + dx);
    const ey = Math.round(y + dy);
    for (let t = 0; t <= 1; t += 0.05) {
      const px = Math.round(x + (ex - x) * t);
      const py = Math.round(y + (ey - y) * t);
      if (px >= 0 && px < W && py >= 0 && py < H) {
        data[py * W + px] = 1;
      }
    }
    // 2 个子分支, 角度随机 ±0.3-0.7 (不是固定 0.5, 避免对称)
    const ang1 = angle - (0.3 + rand() * 0.4);
    const ang2 = angle + (0.3 + rand() * 0.4);
    drawBranch(ex, ey, ang1, len * (0.6 + rand() * 0.2), d - 1);
    drawBranch(ex, ey, ang2, len * (0.6 + rand() * 0.2), d - 1);
  }
  drawBranch(cx, cy, -Math.PI / 2, H * 0.4, depth);
  return data;
}

/**
 * 测试用: 生成 random noise
 */
export function _generateRandomNoise(W, H, density = 0.5, seed = 42) {
  const data = new Uint8Array(W * H);
  // 简单 LCG
  let s = seed;
  function rand() {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  }
  for (let i = 0; i < data.length; i++) {
    data[i] = rand() < density ? 1 : 0;
  }
  return data;
}

/**
 * 测试用: 生成 horizontal stripes (高对称反例)
 */
export function _generateStripes(W, H) {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const fill = (y % 4 < 2) ? 1 : 0;  // 2 行 on, 2 行 off
    for (let x = 0; x < W; x++) {
      data[y * W + x] = fill;
    }
  }
  return data;
}

export function _test() {
  const W = 50, H = 30;
  const tests = [];

  const dfsData = _generateDFSMaze(W, H);
  const spiralData = _generateSpiral(W, H);
  const fractalData = _generateFractalTree(W, H);
  const noiseData = _generateRandomNoise(W, H, 0.5);
  const stripesData = _generateStripes(W, H);

  const cases = [
    ['DFS perfect maze (placeholder)', dfsData],
    ['Spiral (反例 1)', spiralData],
    ['Fractal tree (反例 2)', fractalData],
    ['Random noise 50%', noiseData],
    ['Horizontal stripes (反例 3)', stripesData],
  ];

  for (const [name, data] of cases) {
    const r = mazeQuality(data, W, H);
    tests.push({ name, total: r.total.toFixed(3), breakdown: r.breakdown });
  }
  return tests;
}
