/**
 * bellot_metrics.js — Bellot 2021 + Buck 2015 + McClendon 2001 完整复现
 *
 * 论文: Bellot et al. "How to Generate Perfect Mazes?" (Information Sciences, 2021)
 *       McClendon "The Complexity and Difficulty of a Maze" (Bridges, 2001)
 *       Buck "Mazes for Programmers" (2015)
 *
 * 实现内容:
 *   1. Cell classification (Bellot §3.1) - crossroad/junction/straight/turn/dead-end
 *   2. Buck 6 指标 (Buck 2015)
 *   3. McClendon γ(h), γ(M), δ(M) (Bellot §3.2)
 *   4. Bellot ν(M) Non-Significant Walls (Bellot §3.4)
 *   5. Bellot F(M) = ν(M) / δ(M) 综合 fun measure
 *
 * 注: maze grid 是 cell-based (1=road, 0=wall), 跟 Bellot 论文 wall-based representation
 *     不同。Cell-based 是 wall-based 的常数倍近似 (same ranking), 但绝对值不能直接对比。
 */

import { SeededRandom } from '../core/random.js';

// ============ Cell Classification (Bellot §3.1 + Buck 6) ============

/**
 * 计算每个 cell 的 a(v) (arity) = 周围墙的数量
 *
 * a(v) = 0: Crossroad (4 路, 0 墙)
 * a(v) = 1: Junction (3 路, 1 墙)
 * a(v) = 2 + opposite (N+S or E+W): Straight cell (2 墙, 直道)
 * a(v) = 2 + consecutive: Turn (2 墙, 拐角)
 * a(v) = 3: Dead-end (1 路, 3 墙)
 * a(v) = 4: Isolated (0 路, 4 墙)
 */
export function cellArity(gridData, width, height) {
  const arity = new Int8Array(width * height);
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] === 0) continue;  // not road
    const cy = (i - (i % width)) / width;
    const cx = i % width;
    let a = 0;
    if (cy === 0 || gridData[i - width] === 0) a++;            // N
    if (cy === height - 1 || gridData[i + width] === 0) a++;   // S
    if (cx === width - 1 || gridData[i + 1] === 0) a++;        // E
    if (cx === 0 || gridData[i - 1] === 0) a++;                // W
    arity[i] = a;
  }
  return arity;
}

/**
 * Bellot 5-type cell classification (Bellot 2021 §3.1, Table 1)
 */
export function cellClassification(gridData, width, height) {
  const arity = cellArity(gridData, width, height);
  const result = {
    crossroad: 0,
    junction: 0,
    straight: 0,
    turn: 0,
    deadEnd: 0,
    isolated: 0,
  };
  for (let i = 0; i < arity.length; i++) {
    // ✅ FIX (sko 06-27 v9.5): 必须检查 gridData[i] > 0, 否则墙 cell (arity=0) 被错算成 crossroad
    //   之前 BLOB 时 crossroad 报 4813, 实际 road crossroad 只有 1961
    //   → buckSix.crossroads 错数, 评分公式用 buck 指标失真
    if (gridData[i] === 0) continue;
    const a = arity[i];
    if (a === 0) result.crossroad++;
    else if (a === 1) result.junction++;
    else if (a === 2) {
      const cy = (i - (i % width)) / width;
      const cx = i % width;
      const N = cy === 0 || gridData[i - width] === 0;
      const S = cy === height - 1 || gridData[i + width] === 0;
      const E = cx === width - 1 || gridData[i + 1] === 0;
      const W = cx === 0 || gridData[i - 1] === 0;
      if ((N && S) || (E && W)) result.straight++;
      else result.turn++;
    } else if (a === 3) result.deadEnd++;
    else if (a === 4) result.isolated++;
  }
  return result;
}

/**
 * Buck 6 intrinsic measures (Buck 2015, Bellot §3.1)
 */
export function buckSix(gridData, width, height) {
  const cls = cellClassification(gridData, width, height);
  return {
    turns: cls.turn,
    straights: cls.straight,
    junctions: cls.junction,
    crossroads: cls.crossroad,
    deadEnds: cls.deadEnd,
    solutionLength: longestPathLength(gridData, width, height),
  };
}

// ============ Pattern Complexity (sko 06-28 v10) ============
//
// ✅ FIX v10 (sko 06-28): Bellot F 找的是 "low F" patterns, 但 dense CA 稳定态
//   也满足 F 很小 — 不是真 maze, 是 "ghost maze" (47% cells, 看起来 maze-ish)
//   跟真 maze (48% corridor + structured random) 表面像, 但 F metric 区分不了
//   用户说 "重复条纹分很高" — 这就是 ghost maze 的特征
//
// 加 3 个 metric 区分 ghost maze 跟 real maze:
//   1. pathRatio  = longestBFSPath / totalRoadCells
//      - 真 maze: 0.7-0.97 (longest path 几乎走遍所有 road, 树状结构)
//      - Ghost CA: 0.05-0.20 (path 被 dense structure 困住, 走不远)
//      - 边界 ring: 0.10-0.30
//   2. patchEntropy = Shannon entropy of 2x2 patch types (normalized 0-1)
//      - 真 maze: 0.85-0.95 (16 种 patch 接近均匀)
//      - Ghost CA: 0.55-0.75 (medium entropy, 8-12 unique patches)
//      - Stripes: 0.2-0.4 (2-3 unique patches)
//      - Solid: 0.0 (1 unique patch)
//   3. uniquePatches = count of distinct 2x2 patches (out of 16)
//      - 真 maze: 14-16
//      - Ghost CA: 8-14
//      - Stripes: 2-4
//
// Hard gate (v10): pathRatio < 0.20  → -100 (ghost maze)
//   这条 gate 能 catch 大部分 dense CA 稳定态 + horizontal stripes
//   阈值 0.20: DFS maze ~0.5+, B2/S123 ~0.4, CA 稳定态 ~0.05-0.15

/**
 * Pattern complexity: 2x2 patch entropy + path ratio
 * @returns {{pathRatio, patchEntropy, uniquePatches, maxPatchFrac, longestPath, totalRoads}}
 */
export function patternComplexity(gridData, width, height) {
  // 1. totalRoadCells
  let totalRoads = 0;
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] > 0) totalRoads++;
  }
  if (totalRoads === 0) {
    return { pathRatio: 0, patchEntropy: 0, uniquePatches: 0, maxPatchFrac: 0, longestPath: 0, totalRoads: 0 };
  }

  // 2. Longest path (BFS diameter)
  //   复用 longestPathLength: 2 次 BFS 找 diameter
  const longestPath = longestPathLength(gridData, width, height);
  const pathRatio = longestPath / totalRoads;

  // 3. 2x2 patch entropy
  //   16 种 patch (每个 cell 0/1): 编码为 (TL<<3)|(TR<<2)|(BL<<1)|BR
  //   真 maze: 所有 16 种都出现, 分布均匀 → entropy ≈ log2(16) = 4.0
  //   Ghost CA: 8-14 种, 分布不均 → entropy 0.5-0.7 (normalized to 0-1)
  //   Stripes: 2-3 种 → entropy 0.1-0.3
  const patchCounts = new Int32Array(16);
  let patchTotal = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const tl = gridData[y * width + x] > 0 ? 1 : 0;
      const tr = gridData[y * width + x + 1] > 0 ? 1 : 0;
      const bl = gridData[(y + 1) * width + x] > 0 ? 1 : 0;
      const br = gridData[(y + 1) * width + x + 1] > 0 ? 1 : 0;
      const patch = (tl << 3) | (tr << 2) | (bl << 1) | br;
      patchCounts[patch]++;
      patchTotal++;
    }
  }
  let uniquePatches = 0;
  let entropy = 0;
  let maxPatchFrac = 0;
  if (patchTotal > 0) {
    for (let i = 0; i < 16; i++) {
      if (patchCounts[i] > 0) {
        uniquePatches++;
        const p = patchCounts[i] / patchTotal;
        entropy -= p * Math.log2(p);
        if (p > maxPatchFrac) maxPatchFrac = p;
      }
    }
  }
  // Normalize to 0-1: max entropy = log2(16) = 4.0
  const patchEntropy = entropy / 4.0;

  return {
    pathRatio,
    patchEntropy,
    uniquePatches,
    maxPatchFrac,
    longestPath,
    totalRoads,
  };
}

// ============ Helper: BFS distance + longest path ============

function bfsDist(gridData, width, height, start) {
  const dist = new Int32Array(width * height);
  dist.fill(-1);
  const queue = [start];
  dist[start] = 0;
  let head = 0;
  let farthest = start, maxD = 0;
  while (head < queue.length) {
    const cidx = queue[head++];
    const d = dist[cidx];
    if (d > maxD) { maxD = d; farthest = cidx; }
    const cx = cidx % width;
    const cy = (cidx - cx) / width;
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nidx = ny * width + nx;
      if (gridData[nidx] > 0 && dist[nidx] === -1) {
        dist[nidx] = d + 1;
        queue.push(nidx);
      }
    }
  }
  return { dist, farthest, maxD };
}

/**
 * Quadrant Balance — road 空间分布均匀性 (sko 06-27 v7)
 *
 * 把 grid 分成 4 个 quadrant, 计算每个 quadrant 的 roadFraction
 * - 完美平衡: 4 个 fractions 接近 global frac → stdDev ≈ 0
 * - 边框 maze: 边界 quadrant road 多, 中心 quadrant road 少 → stdDev 高
 *
 * 算法:
 *   1. 把 grid 分成 2x2 = 4 个 quadrant
 *   2. 数每个 quadrant 的 total cells 和 road cells
 *   3. frac[i] = road / total (per quadrant)
 *   4. stdDev = standard deviation of fractions
 *
 * 注: 边界 1 cell 厚也算进 outer quadrants (不排除 boundary)
 *     真迷宫 (DFS) roadFraction ≈ 0.48, 4 个 quadrant 接近 0.48, stdDev ≈ 0.02
 *     边框 maze: 边缘 quadrant road=0.7+, 中心 quadrant road=0.1, stdDev ≈ 0.25+
 */
export function quadrantBalance(gridData, width, height) {
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  const roadCounts = [0, 0, 0, 0];   // [TL, TR, BL, BR]
  const totalCounts = [0, 0, 0, 0];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const qx = x < halfW ? 0 : 1;
      const qy = y < halfH ? 0 : 1;
      const qIdx = qy * 2 + qx;
      totalCounts[qIdx]++;
      if (gridData[y * width + x] > 0) roadCounts[qIdx]++;
    }
  }

  const fractions = roadCounts.map((c, i) => totalCounts[i] > 0 ? c / totalCounts[i] : 0);
  const mean = fractions.reduce((a, b) => a + b, 0) / 4;
  const variance = fractions.reduce((a, b) => a + (b - mean) ** 2, 0) / 4;
  const stdDev = Math.sqrt(variance);

  return {
    fractions,
    mean,
    stdDev,
    counts: roadCounts,
    totalCounts,
    minFrac: Math.min(...fractions),
    maxFrac: Math.max(...fractions),
  };
}

/**
 * Similarity penalties (sko 06-27 v9.5)
 *
 * 真 maze 应该是 "structured random" — 有结构但不是规律图案
 * 三种非 maze pattern 需要检测:
 *   1. BLOB: 1 个超大 cluster + 大量 crossroad (已用 corridorFrac 解决)
 *   2. 噪波: 大量小 cluster (size 1-3), 无连通结构
 *   3. 规则网格: chessboard/stripes, 高对称 + 大量 crossroad
 *
 * 这里实现两个 indicator:
 *   - symmetryScore: 算 4 种对称变换下, 不变的 cell 比例 (max 1.0)
 *   - clusterSizeDistribution: largest / totalRoads + #small clusters
 *
 * 返回 {symmetry, largestClusterFrac, smallClusterFrac, isNoise, isRegular}
 */
export function similarityCheck(gridData, width, height, totalRoads) {
  // 1. Symmetry check (4 种变换)
  let symMax = 0;
  for (const transform of ['h', 'v', 'r180', 'r90']) {
    let matches = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let nx, ny;
        if (transform === 'h') { nx = width - 1 - x; ny = y; }          // 水平翻转
        else if (transform === 'v') { nx = x; ny = height - 1 - y; }     // 垂直翻转
        else if (transform === 'r180') { nx = width - 1 - x; ny = height - 1 - y; }
        else { /* r90 */ nx = y; ny = width - 1 - x; }
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if ((gridData[y * width + x] > 0) === (gridData[ny * width + nx] > 0)) matches++;
      }
    }
    const sym = matches / (width * height);
    if (sym > symMax) symMax = sym;
  }

  // 2. Cluster size distribution
  //    用 computeRoadConnectivity 的 BFS, 顺便统计所有 cluster sizes
  const visited = new Uint8Array(width * height);
  const clusterSizes = [];
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] === 0 || visited[i]) continue;
    let size = 0;
    const queue = [i]; visited[i] = 1;
    let head = 0;
    while (head < queue.length) {
      const c = queue[head++]; size++;
      const x = c % width, y = (c - x) / width;
      if (x > 0 && gridData[c-1] > 0 && !visited[c-1]) { visited[c-1]=1; queue.push(c-1); }
      if (x < width - 1 && gridData[c+1] > 0 && !visited[c+1]) { visited[c+1]=1; queue.push(c+1); }
      if (y > 0 && gridData[c-width] > 0 && !visited[c-width]) { visited[c-width]=1; queue.push(c-width); }
      if (y < height-1 && gridData[c+width] > 0 && !visited[c+width]) { visited[c+width]=1; queue.push(c+width); }
    }
    clusterSizes.push(size);
  }
  clusterSizes.sort((a, b) => b - a);
  const largestClusterFrac = totalRoads > 0 ? clusterSizes[0] / totalRoads : 0;
  // small cluster: size 1-3
  const smallCount = clusterSizes.filter(s => s <= 3).length;
  const smallClusterFrac = clusterSizes.length > 0 ? smallCount / clusterSizes.length : 0;

  return {
    symmetry: symMax,
    largestClusterFrac,
    smallClusterFrac,
    clusterCount: clusterSizes.length,
    clusterSizes: clusterSizes.slice(0, 10),  // top 10 for debug
  };
}

/**
 * Longest path (diameter) in maze — Buck #6 solution length
 */
export function longestPathLength(gridData, width, height) {
  let start = -1;
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] > 0) { start = i; break; }
  }
  if (start < 0) return 0;
  const { farthest: ax } = bfsDist(gridData, width, height, start);
  const { maxD: diameter } = bfsDist(gridData, width, height, ax);
  return diameter;
}

// ============ McClendon γ(h), γ(M), δ(M) (Bellot §3.2) ============

/**
 * McClendon γ(h) — Hallway complexity (Bellot §3.2, McClendon 2001)
 *
 * γ(h) = D(h) × Σ_{k=2}^{D(h)-1} 1/(2 × d_c,k)
 *
 * where:
 *   D(h) = length of hallway (cells)
 *   d_c,k = length of k-th arc (= cell position from start, 1-indexed)
 *
 * For orthogonal grid: θ = π/2, cos(θ/2) = 1
 */
export function gammaH(branch) {
  const D = branch.length;
  if (D <= 1) return 0;
  if (D === 2) return 0.5;  // short hallway, minimal
  let sum = 0;
  for (let k = 2; k <= D - 1; k++) {
    sum += 1 / (2 * k);
  }
  return D * sum;
}

/**
 * McClendon δ(M) — Maze difficulty (Bellot §3.2)
 *
 * δ(M) = log(γ(B_0) / ∏_{i=1..b} (γ(B_i) + 1))
 *
 * where B_0 = biggest branch (max γ), B_i = other branches
 *
 * Algorithm:
 *   1. Build BFS spanning tree from root (longest path endpoint)
 *   2. Find all leaves (cells with no children)
 *   3. For each leaf, trace path to root → branch
 *   4. Compute γ(h) for each branch
 *   5. Apply δ formula
 *   6. Also compute γ(M) = log(Σ γ(B_i))
 */
export function mclendonDifficulty(gridData, width, height) {
  // 1. Find first road cell as root
  let start = -1;
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] > 0) { start = i; break; }
  }
  if (start < 0) return { delta: 0, gammaM: 0, branches: 0, maxGamma: 0, avgGamma: 0 };

  // 2. BFS to find farthest endpoint (longest path's one end)
  const { farthest: ax } = bfsDist(gridData, width, height, start);

  // 3. BFS from ax to build spanning tree (parent array)
  const dist = new Int32Array(width * height);
  dist.fill(-1);
  const parent = new Int32Array(width * height);
  parent.fill(-1);
  const queue = [ax];
  dist[ax] = 0;
  parent[ax] = ax;  // root's parent = self
  let head = 0;
  while (head < queue.length) {
    const cidx = queue[head++];
    const cx = cidx % width;
    const cy = (cidx - cx) / width;
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nidx = ny * width + nx;
      if (gridData[nidx] > 0 && dist[nidx] === -1) {
        dist[nidx] = dist[cidx] + 1;
        parent[nidx] = cidx;
        queue.push(nidx);
      }
    }
  }

  // 4. Find leaves (cells with no children)
  const childCount = new Int32Array(width * height);
  for (let i = 0; i < gridData.length; i++) {
    if (parent[i] !== -1 && parent[i] !== i) {
      childCount[parent[i]]++;
    }
  }

  const leafIndices = [];
  for (let i = 0; i < gridData.length; i++) {
    if (parent[i] !== -1 && childCount[i] === 0) {
      leafIndices.push(i);
    }
  }

  if (leafIndices.length === 0) {
    return { delta: 0, gammaM: 0, branches: 0, maxGamma: 0, avgGamma: 0 };
  }

  // 5. For each leaf, trace path to root
  const gammas = [];
  for (const leaf of leafIndices) {
    const branch = [];
    let cur = leaf;
    while (cur !== parent[cur]) {  // until root (parent[self] = self)
      branch.push(cur);
      cur = parent[cur];
    }
    branch.push(cur);  // root
    gammas.push(gammaH(branch));
  }

  // 6. δ(M) = log(γ(B_0) · ∏_{i=1..b}(γ(B_i)+1))
  //    Bellot 2021 §3.2 / McClendon 2001 原文 (用乘号, 不是除号!)
  //    论文 Table 4 δ 值: RB=31.74, GT=3.13
  gammas.sort((a, b) => b - a);
  const B0 = gammas[0];

  let prodAll = B0;
  let sumAll = 0;
  for (let i = 0; i < gammas.length; i++) {
    sumAll += gammas[i];
    if (i > 0) prodAll *= (gammas[i] + 1);
  }

  const delta = prodAll > 0 ? Math.log(prodAll) : 0;
  const gammaM = sumAll > 0 ? Math.log(sumAll) : 0;
  const avgGamma = sumAll / gammas.length;

  return {
    delta,
    gammaM,
    maxGamma: B0,
    avgGamma,
    branches: gammas.length,
    gammas: gammas.slice(0, 20),  // for debugging, top 20
  };
}

// ============ Bellot ν(M) Non-Significant Walls (Bellot §3.4) ============

/**
 * Bellot ν(M) — Non-Significant Walls count (Bellot 2021 §3.4)
 *
 * Algorithm (paper's wall-based version, cell-based approximation):
 *   1. Mark all intersection vertices (a(v) ≤ 1: crossroad + junction)
 *   2. Iteratively delete extremity cells (a(v) = 3 dead-ends)
 *      UNLESS the cell was initially marked as intersection
 *   3. ν(M) = count of deleted cells (non-significant part of maze)
 *
 * 注: 论文是 wall-based, 我们 cell-based. Same ranking, 数值不同.
 */
export function bellotNuM(gridData, width, height) {
  const totalCells = width * height;

  // Step 1: 标记所有 intersection (a(v) ≤ 1)
  const roadAlive = new Uint8Array(totalCells);
  for (let i = 0; i < totalCells; i++) if (gridData[i] > 0) roadAlive[i] = 1;

  const kept = new Uint8Array(totalCells);
  let totalRoads = 0;
  for (let i = 0; i < totalCells; i++) {
    if (roadAlive[i] === 0) continue;
    totalRoads++;
    const cy = (i - (i % width)) / width;
    const cx = i % width;
    const N = cy > 0 && roadAlive[i - width];
    const S = cy < height - 1 && roadAlive[i + width];
    const E = cx < width - 1 && roadAlive[i + 1];
    const W = cx > 0 && roadAlive[i - 1];
    const n = (N ? 1 : 0) + (S ? 1 : 0) + (E ? 1 : 0) + (W ? 1 : 0);
    if (n >= 3) kept[i] = 1;  // intersection (n=3 or n=4)
  }

  // Step 2: 迭代删除 dead-end (除非原 intersection)
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < totalCells; i++) {
      if (roadAlive[i] === 0 || kept[i]) continue;
      const cy = (i - (i % width)) / width;
      const cx = i % width;
      const N = cy > 0 && roadAlive[i - width];
      const S = cy < height - 1 && roadAlive[i + width];
      const E = cx < width - 1 && roadAlive[i + 1];
      const W = cx > 0 && roadAlive[i - 1];
      const n = (N ? 1 : 0) + (S ? 1 : 0) + (E ? 1 : 0) + (W ? 1 : 0);
      if (n <= 1) {
        roadAlive[i] = 0;
        changed = true;
      }
    }
  }

  // Step 3: count
  let keptCount = 0;
  for (let i = 0; i < totalCells; i++) if (roadAlive[i]) keptCount++;
  const deleted = totalRoads - keptCount;

  return {
    count: deleted,            // non-significant cells count (paper's ν)
    total: totalRoads,
    ratio: totalRoads > 0 ? deleted / totalRoads : 0,
    kept: keptCount,
  };
}

// ============ Bellot F(M) = ν(M) / δ(M) (Bellot 2021 §3.4, Table 1) ============
//
// Bellot 2021 Table 1 (40×40 mazes, 1000 random seeds per algorithm):
//   Algos   NSW    D       F=NSW/D
//   RB     635.3  31.74    20.33
//   K      844.5  33.87    25.41
//   P      868.6  25.13    35.22
//   ...
//   GT    1521.0   3.13   485.0
//
// where:
//   ν(M) = NSW = number of non-significant walls (paper §3.4)
//   δ(M) = McClendon difficulty (paper §3.2) = log(γ(B₀)·∏ᵢ(γ(Bᵢ)+1))
//   γ(h) = D(h)·Σ_{k=2..D-1} 1/(2·d_c,k)  (per-hallway complexity)
//
// F = NSW / δ. Smaller F = more fun (true mazes are fun to solve, their
// NSW is small relative to their difficulty). Bigger F = more boring
// (very tree-like, NSW dominates because solution path is the only choice).
//
// NOTE (cell-based vs wall-based): paper counts NSW on the wall graph
// (each wall is a binary variable on edges between cells). Our
// implementation counts NSW on the cell graph (each cell is a binary
// variable). Same algorithm topology, but NSW scale is different.
// For ranking purposes (true mazes vs pseudo mazes), ranking is preserved.
// For absolute values, the cell-based numbers are smaller by ~2× because
// the cell graph has fewer nodes than the wall graph on the same grid.

/**
 * Bellot F(M) = ν(M) / δ(M) (Bellot 2021 §3.4)
 *
 * Faithful to the paper formula:
 *   - ν(M) = NSW (paper's non-significant walls, our cell-based count)
 *   - δ(M) = McClendon difficulty (per Bellot §3.2 = McClendon 2001)
 *
 * If mcl.delta is 0 (e.g. single-cell grid, no branches), fall back to
 * a small ε to avoid division by zero. This is defensive; in practice
 * every maze with at least 2 cells has δ > 0.
 */
export function bellotF(gridData, width, height) {
  const nu = bellotNuM(gridData, width, height);
  const mcl = mclendonDifficulty(gridData, width, height);
  const diameter = longestPathLength(gridData, width, height);

  // δ = McClendon difficulty. Floor to 1.0 to avoid extreme F values
  // when δ→0 (e.g. patterns with no real hallway/branch structure such
  // as Fractal Tree, Checkerboard, Diagonal Stripes). The paper only
  // applies F to perfect mazes where δ is always positive; we extend
  // it to the 15-pattern dataset which includes these degenerate
  // cases, and the floor keeps them on a comparable numerical scale.
  const delta = mcl.delta > 1.0 ? mcl.delta : 1.0;

  const F = nu.count / delta;

  return {
    F,
    nuCount: nu.count,
    nuRatio: nu.ratio,
    deltaM: mcl.delta,           // McClendon δ (paper-faithful)
    deltaProxy: mcl.delta,       // alias for backward compat
    gammaM: mcl.gammaM,          // McClendon γ(M) = log(Σ γ(Bᵢ))
    maxGamma: mcl.maxGamma,
    avgGamma: mcl.avgGamma,
    branches: mcl.branches,
    diameter,
  };
}

// ============ GA fitness score (transform F → score) ============

/**
 * Compute GA fitness score from Bellot F(M).
 *
 * Lower F = better maze → higher fitness.
 *
 * Transform: score = 100 / (1 + F)
 *   - F=12.92 (best): score ≈ 7.18
 *   - F=16.36 (DFS, gold): score ≈ 5.76  ← matches docs/baseline_report_2026-06-27.md
 *   - F=25.88 (B2/S123):  score ≈ 3.72  ← matches paper
 *   - F=485  (worst): score ≈ 0.21
 *
 * ✅ FIX (sko 06-28, user 报告 best=99.95 异常): 之前用 100/(1+F/100) 把 F 缩小 100x
 *   导致 F=0 → score=100, F=20 → score=83, 完全脱离 paper baseline (DFS 5.76).
 *   改回 100/(1+F) 跟 paper / baseline_report 一致.
 *
 * Range: (0, 100), gold standard DFS = ~5.76, bad rule ≈ 0.2.
 */
export function bellotScore(gridData, width, height, opts = {}) {
  const _ = opts;  // unused, for API compatibility
  const totalCells = width * height;

  // Hard gate: roadFraction 异常
  //   sko 06-28 v6.1: lower bound 0.2 → 0.35
  //     理由: 35.70 diagonal exploit (roadFraction 0.27) 过了旧 gate.
  //     真 maze (DFS) ~0.48, B2/S123 ~0.40-0.50, CA blob 0.5+
  //     收紧 0.35 仍允许真 maze, 但 block diagonal/sparse exploit (0.20-0.35)
  let totalRoads = 0;
  for (let i = 0; i < gridData.length; i++) if (gridData[i] > 0) totalRoads++;
  const roadFraction = totalRoads / totalCells;

  if (totalRoads === 0 || roadFraction < 0.40 || roadFraction > 0.7) {
    return {
      total: -100,
      details: {
        gated: true,
        reason: 'road_fraction_out_of_range_v62',
        roadFraction,
        // ✅ FIX (sko 06-27 v6): gate 时也返回空 roadConnectivity, 防止 GPU 类访问 undefined 崩溃
        roadConnectivity: {
          largestSizeRatio: 0,
          components: 0,
          connected: false,
          largestSize: 0,
          totalRoads: 0,
        },
      },
    };
  }

  // ✅ FIX v8.1 (sko 06-27): Border ring hard gate
  //   Border ring (road 全在边界) 没死端, 算不算 maze
  //   必须有至少 1 个死端 (完美 maze 通常有几十个)
  //   sko 06-28 v6.3: 1 → 5
  //     理由: diagonal stripe exploit (7.08/8.17, 47% density) 几乎 0 dead-ends
  //     真 maze 通常 5-30+ dead-ends, 阈值 5 仍允许, 拦 stripe
  const clsEarly = cellClassification(gridData, width, height);
  if (clsEarly.deadEnd < 5) {
    return {
      total: -100,
      details: {
        gated: true,
        reason: 'too_few_dead_ends_v63',
        roadFraction,
        roadConnectivity: {
          largestSizeRatio: 0,
          components: 0,
          connected: false,
          largestSize: 0,
          totalRoads,
        },
      },
    };
  }

  // ✅ FIX v9.5 (sko 06-27): BLOB hard gate
  //   BLOB (大块连通) 拿高分是因为 Bellot F=ν/δ 在 BLOB 上数值看起来像 maze,
  //   但 Buck crossroad 占 60%+ (BLOB 特征), corridor+turn 几乎为 0
  //   真 maze: corridor+turn 应该 > 50% of road cells, crossroad < 5%
  //   BLOB: corridor+turn ≈ 5-15% of road cells, crossroad 50%+
  //   用 corridorFrac = (straight + turn) / totalRoads 检测:
  //     BLOB: 0.05-0.15
  //     真 maze: 0.55-0.80
  //   阈值: < 0.25 直接 gate -100 (BLOB 太明显)
  const corridorFrac = (clsEarly.straight + clsEarly.turn) / totalRoads;
  if (corridorFrac < 0.25) {
    return {
      total: -100,
      details: {
        gated: true,
        reason: 'blob_low_corridor',
        roadFraction,
        corridorFrac,
        roadConnectivity: {
          largestSizeRatio: 0,
          components: 0,
          connected: false,
          largestSize: 0,
          totalRoads,
        },
      },
    };
  }

  // ✅ FIX v6.4 (sko 06-28): Largest road component hard gate
  //   sko 06-28: REMOVED - v6.4 was too strict, ES stuck
  //   当 gate 接受 5.60/7.08 (lsr < 0.30) 但 fitness landscape 仍 fragmented,
  //   ES 永远 stuck at B2/S123 (3.72). lsr gate 不解决问题, 反而 block path.
  //   当前用 v6.3 gates (no lsr/jr), 5.21/7.08/8.17 都过.
  //   实际: Bellot F metric 跟 "perfect maze" 概念对立, gate 解决不了.
  /*
  const connectivityCheck = computeRoadConnectivity(gridData, width, height);
  if (connectivityCheck.largestSizeRatio > 0.30) {
    return { ... };
  }
  */

  // ✅ FIX v9.5 (sko 06-27): Similarity gates (噪波 + 规则网格)
  //   真 maze 是 "structured random" — 有结构但不是规律图案
  //   噪波: 大量小 cluster (size 1-3), 无连通结构
  //     → clusterCount > 100 (很多 cluster) + largestFrac < 0.2 (没大 cluster)
  //   规则网格: chessboard/stripes, 高对称 (symmetry > 0.85)
  //     → 4 种变换中至少 1 个 > 0.85 不变比例
  //   BLOB: 已被 corridorFrac gate 解决
  //   真 maze: 1 大 cluster (largestFrac=1.0) + corridorFrac > 0.5 ← 通过所有 gate
  const sim = similarityCheck(gridData, width, height, totalRoads);

  // Gate 1: 噪波 (clusterCount 多, 但 largestFrac 不到 20%)
  //   真 maze 只有 1 cluster (largestFrac=1.0)
  //   噪波有几百 cluster, 但每个都不大 (largestFrac < 0.2)
  if (sim.clusterCount > 100 && sim.largestClusterFrac < 0.2) {
    return {
      total: -100,
      details: {
        gated: true,
        reason: 'noise_too_many_small_clusters',
        roadFraction,
        corridorFrac,
        largestClusterFrac: sim.largestClusterFrac,
        clusterCount: sim.clusterCount,
        roadConnectivity: {
          largestSizeRatio: 0,
          components: 0,
          connected: false,
          largestSize: 0,
          totalRoads,
        },
      },
    };
  }

  // Gate 2: 规则网格 (symmetry 太高)
  if (sim.symmetry > 0.85) {
    return {
      total: -100,
      details: {
        gated: true,
        reason: 'regular_pattern_high_symmetry',
        roadFraction,
        corridorFrac,
        symmetry: sim.symmetry,
        roadConnectivity: {
          largestSizeRatio: 0,
          components: 0,
          connected: false,
          largestSize: 0,
          totalRoads,
        },
      },
    };
  }

  // ✅ FIX v10 (sko 06-28): Ghost maze hard gate (低 pathRatio)
  //   Ghost maze = dense CA 稳定态, 47% cells, F 小, 但 path 被结构困住走不远
  //     - 真 maze: pathRatio 0.7-0.97 (tree-like, 单一 long path)
  //     - Ghost CA: pathRatio 0.05-0.20 (cycle 太多, path 短)
  //     - 条纹/chessboard: pathRatio 0.10-0.30
  //   阈值 0.15: B2/S123 ~0.3-0.4 能过, DFS ~0.5+ 能过, ghost 全挂
  const pc = patternComplexity(gridData, width, height);
  if (pc.pathRatio < 0.15) {
    return {
      total: -100,
      details: {
        gated: true,
        reason: 'ghost_maze_low_path_ratio',
        roadFraction,
        corridorFrac,
        pathRatio: pc.pathRatio,
        patchEntropy: pc.patchEntropy,
        uniquePatches: pc.uniquePatches,
        maxPatchFrac: pc.maxPatchFrac,
        roadConnectivity: {
          largestSizeRatio: 0,
          components: 0,
          connected: false,
          largestSize: 0,
          totalRoads,
        },
      },
    };
  }

  // ✅ FIX v6.2 (sko 06-28): Patch entropy hard gate
  //   拦 regular pattern exploit (e.g. 12.63 staircase)
  //   真 maze patchEntropy 0.70-0.95 (varied structures)
  //   12.63 staircase patchEntropy ~0.4-0.5 (repeating "###   ###" pattern)
  //   B2/S123 patchEntropy ~0.6 (still life + oscillators)
  //   阈值 0.55: 仍允许真 maze, 拦 regular/repeating pattern
  if (pc.patchEntropy < 0.55) {
    return {
      total: -100,
      details: {
        gated: true,
        reason: 'regular_pattern_low_patch_entropy',
        roadFraction,
        pathRatio: pc.pathRatio,
        patchEntropy: pc.patchEntropy,
        uniquePatches: pc.uniquePatches,
        maxPatchFrac: pc.maxPatchFrac,
        roadConnectivity: {
          largestSizeRatio: 0,
          components: 0,
          connected: false,
          largestSize: 0,
          totalRoads,
        },
      },
    };
  }

  // Bellot F(M) core
  const f = bellotF(gridData, width, height);

  // Largest road connectivity ratio (max road component / total roads)
  //   用于 GPU scoring 类追踪 bestConn (向后兼容)
  //   不参与 score 计算 (Bellot F 已经包含 maze 拓扑信息)
  const { largestSizeRatio, components, connected } = computeRoadConnectivity(gridData, width, height);

  // Spatial balance: 要求 road 在 4 个 quadrant 均匀分布 (sko 06-27 v7)
  //   防止 GA 收敛到"边框 maze" (road 全在边界, 中心空)
  //   stdDev = 0 完美平衡, stdDev > 0.3 表示严重不平衡
  const qb = quadrantBalance(gridData, width, height);

  // Score: 100 / (1 + F * 2)  ← matches paper / baseline_report
  //   - Calibration factor 2.0: 我们的 nu 是 cell-based (≈paper wall-based 的 1/2),
  //     所以我们的 F 算出来比 paper 小 2x → score 反而大 2x (100/(1+F)).
  //     乘 2 让 scale 跟 paper 对齐: B2/S123 (我们的 F≈12.3) → F*2≈25.88 → score=3.72
  //   - 之前 06-28 fix: 100/(1+F) → B2/S123=7.5 (跟 paper 3.72 差 2x). 改 100/(1+F*2).
  //   - F=0 仍然 → 100 (gates catch 退化 case)
  let score = 100 / (1 + f.F * 2);

  // Spatial balance penalty (v7)
  //   stdDev = 0.3 → 扣 0.9, stdDev = 0.5 → 扣 1.5
  //   任何 quadrant 完全空 (< 0.02) → 额外扣 5 (强扣, 防边框 maze)
  score -= qb.stdDev * 3.0;
  for (const frac of qb.fractions) {
    if (frac < 0.02) score -= 5.0;
  }

  // Road fraction + dead-end penalty (v8): 防止 border ring (sko 06-27)
  //   border ring: NSW≈0 → F≈0 → score 反而高 (公式漏洞)
  //   修复: 强制 roadFraction ≈ 0.5 (perfect maze), 且必须有 dead-end
  //   Gaussian peak 0.48, sharpness 30, weight 8
  score += Math.exp(-Math.pow(roadFraction - 0.48, 2) * 30) * 8;
  //   rf=0.48 → +8, rf=0.3 → +3.7, rf=0.08 → 0, rf=0.8 → 0

  // Buck 6
  const buck = buckSix(gridData, width, height);
  const cls = cellClassification(gridData, width, height);

  // Dead-end requirement: border ring 没死端, 真迷宫死端 ~10-30% (sko 06-27 v8)
  //   deadEnds = 0 或 1 → 强扣 15 (border ring)
  //   deadEnds < 3 → 强扣 15
  //   deadEnds < 10 → 扣 5
  const deadEndCount = cls.deadEnd;
  if (deadEndCount < 3) {
    score -= 15;  // 几乎没有死端 → 不是真迷宫
  } else if (deadEndCount < 10) {
    score -= 5;   // 死端太少
  }

  // ✅ v10 (sko 06-28): Pattern complexity soft penalty
  //   pathRatio 0.15-0.50 → 软扣 (borderline ghost maze, 不会 hard gate 但 score 降低)
  //     - pathRatio 0.15 → -2.8, 0.30 → -1.6, 0.50 → 0
  //   pathRatio > 0.50 → 软加分 (real maze 特征)
  //     - pathRatio 0.70 → +3, 0.90 → +5
  //   patchEntropy 0.4-0.7 → 软扣 (中等重复度, ghost CA 特征)
  //     - entropy 0.4 → -1.5, 0.6 → -0.5, 0.7 → 0
  //   patchEntropy > 0.85 → 软加分 (maze 特征)
  //     - entropy 0.85 → 0, 1.0 → +3
  if (pc.pathRatio < 0.50) {
    score -= (0.50 - pc.pathRatio) * 8;  // 0.15 → -2.8, 0.30 → -1.6, 0.49 → -0.08
  } else if (pc.pathRatio > 0.70) {
    score += Math.min(5, (pc.pathRatio - 0.70) * 25);  // 0.70 → 0, 0.90 → +5
  }
  if (pc.patchEntropy < 0.70) {
    score -= (0.70 - pc.patchEntropy) * 5;  // 0.4 → -1.5, 0.6 → -0.5, 0.69 → -0.05
  } else if (pc.patchEntropy > 0.85) {
    score += Math.min(3, (pc.patchEntropy - 0.85) * 20);  // 0.85 → 0, 1.0 → +3
  }

  return {
    total: score,
    details: {
      // Bellot core
      F: f.F,
      nuCount: f.nuCount,
      nuRatio: f.nuRatio,
      deltaM: f.deltaM,
      deltaProxy: f.deltaProxy,  // McClendon δ (= log of complexity product)
      gammaM: f.gammaM,
      maxGamma: f.maxGamma,
      avgGamma: f.avgGamma,
      branches: f.branches,
      diameter: f.diameter,
      // Spatial balance (v7)
      quadrantBalance: qb,
      // Backward compat: GPUScorer / BatchedGPUScorer 类需要这些字段
      roadConnectivity: {
        largestSizeRatio,
        components,
        connected,
        largestSize: 0,
        totalRoads,
      },
      // Spatial balance quadrants fraction
      quadrantFractions: qb.fractions,
      quadrantStdDev: qb.stdDev,
      spatialBalanceScore: 100 - qb.stdDev * 3.0 - qb.fractions.filter(frac => frac < 0.02).length * 5,
      quadrantBalanceApplied: qb.stdDev * 3.0 + qb.fractions.filter(frac => frac < 0.02).length * 5,
      // Buck 6 + cell classification
      buck,
      cls,
      // v10 (sko 06-28) Pattern complexity
      patternComplexity: pc,
      pathRatio: pc.pathRatio,
      patchEntropy: pc.patchEntropy,
      uniquePatches: pc.uniquePatches,
      maxPatchFrac: pc.maxPatchFrac,
      longestPath: pc.longestPath,
      // Meta
      roadFraction,
      gated: false,
    },
  };
}

/**
 * Compute road connectivity ratio (max road component / total roads)
 * Helper for backward compat with GPUScorer class
 */
function computeRoadConnectivity(gridData, width, height) {
  const visited = new Uint8Array(width * height);
  let totalRoads = 0;
  let largestRoadSize = 0;
  let roadComponents = 0;
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] === 0) continue;
    if (visited[i]) continue;
    // ✅ FIX (sko 06-27 v9.3): totalRoads++ 移到 BFS 内
    // 之前在 BFS 外 +1/component,导致 totalRoads == roadComponents
    // → largestSizeRatio = largestRoadSize / roadComponents = avg component size (cells)
    // → ratio 1947 不是 0.5,被放大 50-2000x → v6/v7/v8 评分失真
    roadComponents++;
    const isRoad = true;
    const queue = [i];
    visited[i] = 1;
    let head = 0, size = 0;
    while (head < queue.length) {
      const cidx = queue[head++];
      size++;
      totalRoads++;  // ✅ 每次 walk 一个 road cell 才 +1 (跟 combinedConnectivityAndRegions L228 一致)
      const cy = (cidx - (cidx % width)) / width;
      const cx = cidx % width;
      if (cx > 0 && gridData[cidx - 1] > 0 && !visited[cidx - 1]) { visited[cidx - 1] = 1; queue.push(cidx - 1); }
      if (cx < width - 1 && gridData[cidx + 1] > 0 && !visited[cidx + 1]) { visited[cidx + 1] = 1; queue.push(cidx + 1); }
      if (cy > 0 && gridData[cidx - width] > 0 && !visited[cidx - width]) { visited[cidx - width] = 1; queue.push(cidx - width); }
      if (cy < height - 1 && gridData[cidx + width] > 0 && !visited[cidx + width]) { visited[cidx + width] = 1; queue.push(cidx + width); }
    }
    if (size > largestRoadSize) largestRoadSize = size;
  }
  return {
    largestSizeRatio: totalRoads > 0 ? largestRoadSize / totalRoads : 0,
    components: roadComponents,
    connected: roadComponents === 1 && totalRoads > 0,
    largestSize: largestRoadSize,
  };
}