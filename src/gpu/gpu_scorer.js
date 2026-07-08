/**
 * gpu_scorer.js — Browser-side scorer using WebGPU CA + CPU maze_score (Phase 8, sko 2026-06-27)
 *
 * 设计:
 *   - 接收一批 chromosomes (rule bit encoding)
 *   - 对每个 chromosome: GPU 跑 CA 演化 (4 seeds × N steps), 读回 final grids
 *   - CPU 跑 maze_score 10 个指标 (含连通度 BFS)
 *   - 返回 [{score, total, conn, components, ...}, ...]
 *
 * 性能预算 (RTX 4060):
 *   - CA evolution GPU: 1 rule × 4 seeds × 300 steps ≈ 50-200ms (含 dispatch 开销)
 *   - CPU maze_score: 1 rule × 4 seeds × 10 metrics ≈ 30-80ms
 *   - 总: ~100-300ms / rule
 *   - 100 rules / gen = 10-30s / gen
 *   - 30 gen = 5-15 分钟 (vs CPU 42 分钟) → 3-8x 加速
 *
 *   进一步优化 (Phase 2): 把连通度/围合/死端等都 GPU 化 → 50-100x 加速
 *
 * 用法:
 *   const scorer = new GPUScorer();
 *   await scorer.init();
 *   const scores = await scorer.evaluateBatch(chromosomes, {seeds, gridSize, steps});
 */

import { GPUEngine } from './gpu_engine.js';
import { BatchedGPUEngine } from './gpu_engine_batched.js';
import { SeededRandom } from '../core/random.js';
import { bellotScore } from './bellot_metrics.js';
// sko 06-29: 加 mazeQuality (Bellot 7 维几何平均) 用于 ES 跑 16 family 完整架构
import { mazeQuality } from '../metrics/maze_quality.js';

/**
 * 把 RuleChromosome 解码为 Rule JSON (CPU 端, 用于 CPU maze_score)
 *
 * 输入: chromosome 是 {bits: BitArray} 或直接 Uint8Array (1648 bits)
 *
 * maskType (sko 06-27 v9): 决定哪些 cell bits 算 "in range"
 *   - 'chebyshev-N'  (default 4): max(|dx|, |dy|) ≤ N
 *   - 'manhattan-N': |dx| + |dy| ≤ N
 *   - 其他: 默认 chebyshev-4
 * 染色体 bit layout 仍然按 9x9 顺序排列 (80 cells), 没 in-range 的 bit 永远忽略
 */
function cellInRange(dx, dy, maskType) {
  if (dx === 0 && dy === 0) return false;
  if (!maskType) return true;  // default: 全部 in range
  const m = /^(\w+)-(\d+)$/.exec(maskType);
  if (!m) return true;
  const type = m[1];
  const d = parseInt(m[2]);
  if (type === 'chebyshev') return Math.max(Math.abs(dx), Math.abs(dy)) <= d;
  if (type === 'manhattan') return Math.abs(dx) + Math.abs(dy) <= d;
  return true;
}

function decodeChromosome(chrom, maskType) {
  // bits 1648 = 16 slots × 103 bits
  // Layout per slot: active(1) + cells(80) + birth(9) + survive(9) + priority(4)
  const MAX_DX = 4, MAX_DY = 4;
  const MAX_CELLS = 80, MAX_BIRTH = 9, MAX_SURVIVE = 9;
  const PRIORITY_BITS = 4;
  const SLOT_BITS = 1 + MAX_CELLS + MAX_BIRTH + MAX_SURVIVE + PRIORITY_BITS;

  // 支持两种格式: chrom.bits = BitArray instance (有 .bits 字段) 或裸 Uint8Array
  let bits;
  if (chrom.bits instanceof Uint8Array) {
    bits = chrom.bits;
  } else if (chrom.bits && chrom.bits.bits instanceof Uint8Array) {
    bits = chrom.bits.bits;
  } else {
    throw new Error('decodeChromosome: bits must be Uint8Array or {bits: Uint8Array}');
  }
  const families = [];
  for (let i = 0; i < 16; i++) {
    const slot = i * SLOT_BITS;
    if (bits[slot] === 0) continue;  // inactive

    // cells
    const cells = [];
    let bitIdx = 0;
    for (let dy = -MAX_DY; dy <= MAX_DY; dy++) {
      for (let dx = -MAX_DX; dx <= MAX_DX; dx++) {
        if (dx === 0 && dy === 0) continue;
        // ✅ v9: only push if cell is in mask range (out-of-range bits ignored)
        if (bits[slot + 1 + bitIdx] === 1 && cellInRange(dx, dy, maskType)) {
          cells.push({ dx, dy });
        }
        bitIdx++;
      }
    }

    // birth
    const birth = [];
    for (let n = 0; n < MAX_BIRTH; n++) {
      if (bits[slot + 1 + MAX_CELLS + n] === 1) birth.push(n);
    }

    // survive
    const survive = [];
    for (let n = 0; n < MAX_SURVIVE; n++) {
      if (bits[slot + 1 + MAX_CELLS + MAX_BIRTH + n] === 1) survive.push(n);
    }

    // priority
    let priority = 0;
    for (let p = 0; p < PRIORITY_BITS; p++) {
      priority |= (bits[slot + 1 + MAX_CELLS + MAX_BIRTH + MAX_SURVIVE + p] << p);
    }
    priority = Math.max(1, Math.min(16, priority || 1));

    families.push({
      id: `fam_${i}`,
      name: `family_${i}`,
      priority,
      cells,
      birth,
      survive,
    });
  }

  // 安全: 至少 1 个 active family
  if (families.length === 0) {
    families.push({
      id: 'fam_0', name: 'family_0', priority: 1,
      cells: [{ dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
              { dx: -1, dy: 0 },                   { dx: 1, dy: 0 },
              { dx: -1, dy: 1 },  { dx: 0, dy: 1 },  { dx: 1, dy: 1 }],
      birth: [3],
      survive: [2, 3],
    });
  }

  return {
    version: '1.0',
    defaultState: 0,
    topology: 'bounded',
    families,
  };
}

/**
 * BFS 连通分量 (CPU)
 */
function bfsConnectivity(gridData, width, height) {
  const visited = new Uint8Array(width * height);
  const sizes = [];
  let totalRoads = 0;

  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] > 0) totalRoads++;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (gridData[idx] === 0 || visited[idx]) continue;
      // BFS (use head index to avoid O(n) Array.shift)
      const queue = [idx];
      visited[idx] = 1;
      let head = 0;
      let size = 0;
      while (head < queue.length) {
        const cidx = queue[head++];
        size++;
        const cx = cidx % width;
        const cy = (cidx - cx) / width;
        // 4 neighbors
        if (cx > 0) {
          const nidx = cidx - 1;
          if (gridData[nidx] > 0 && !visited[nidx]) { visited[nidx] = 1; queue.push(nidx); }
        }
        if (cx < width - 1) {
          const nidx = cidx + 1;
          if (gridData[nidx] > 0 && !visited[nidx]) { visited[nidx] = 1; queue.push(nidx); }
        }
        if (cy > 0) {
          const nidx = cidx - width;
          if (gridData[nidx] > 0 && !visited[nidx]) { visited[nidx] = 1; queue.push(nidx); }
        }
        if (cy < height - 1) {
          const nidx = cidx + width;
          if (gridData[nidx] > 0 && !visited[nidx]) { visited[nidx] = 1; queue.push(nidx); }
        }
      }
      sizes.push(size);
    }
  }

  const largest = sizes.length > 0 ? Math.max(...sizes) : 0;
  return {
    connected: sizes.length === 1 && totalRoads > 0,
    components: sizes.length,
    largestSize: largest,
    largestSizeRatio: totalRoads > 0 ? largest / totalRoads : 0,
    totalRoads,
  };
}

/**
 * Combined: 1 次 BFS 同时算连通性 + 大区域 (sko 06-27 P0 优化)
 *
 * 原来要 2 次 BFS:
 *   - bfsConnectivity (只数 road 区域, 找最大)
 *   - findLargeRegions (数 road+wall 区域, 数 >= threshold)
 *
 * 现在 1 次 BFS 同时算 (visited[] 同时记录 road + wall 分量):
 *   - road 分量大小列表 → 找最大
 *   - road 分量数 >= 9 → emptyRooms++
 *   - wall 分量数 >= 9 → wallBlocks++
 *
 * 节省: ~50% BFS ops (一次扫所有 cell, 不区分 road/wall)
 *
 * Phase 2 (sko 06-27): 返回 sizes 数组, size-weighted penalty
 */
function combinedConnectivityAndRegions(gridData, width, height, threshold = 9) {
  const visited = new Uint8Array(width * height);
  let totalRoads = 0;
  let largestRoadSize = 0;
  let roadComponents = 0;
  let emptyRooms = 0, wallBlocks = 0;
  const emptyRoomSizes = [];  // 每个大空房间的 size
  const wallBlockSizes = [];  // 每个大死墙块的 size

  for (let i = 0; i < gridData.length; i++) {
    if (visited[i]) continue;
    const isRoad = gridData[i] > 0;
    // ⚠️ FIX (sko 06-27): 把 totalRoads++ 移到 BFS 内,避免只 +1 次/region
    // 之前在 BFS 外 +1,导致 totalRoads = region count 不是 cell count
    // → largestSizeRatio 被放大 100x+ → score 爆炸 9516
    const queue = [i];
    visited[i] = 1;
    let head = 0;
    let size = 0;
    while (head < queue.length) {
      const cidx = queue[head++];
      size++;
      if (isRoad) totalRoads++;  // 每次 walk 一个 road cell 才 +1
      const cx = cidx % width;
      const cy = (cidx - cx) / width;
      // 4 邻居 (同状态才走)
      if (cx > 0) {
        const nidx = cidx - 1;
        if (!visited[nidx] && (gridData[nidx] > 0) === isRoad) { visited[nidx] = 1; queue.push(nidx); }
      }
      if (cx < width - 1) {
        const nidx = cidx + 1;
        if (!visited[nidx] && (gridData[nidx] > 0) === isRoad) { visited[nidx] = 1; queue.push(nidx); }
      }
      if (cy > 0) {
        const nidx = cidx - width;
        if (!visited[nidx] && (gridData[nidx] > 0) === isRoad) { visited[nidx] = 1; queue.push(nidx); }
      }
      if (cy < height - 1) {
        const nidx = cidx + width;
        if (!visited[nidx] && (gridData[nidx] > 0) === isRoad) { visited[nidx] = 1; queue.push(nidx); }
      }
    }
    if (isRoad) {
      roadComponents++;
      if (size > largestRoadSize) largestRoadSize = size;
      // ✅ FIX (sko 06-27): 大 road 区域不再叫 empty room
      // 之前自相矛盾: 连通奖励 6×ratio² 奖励大路, 这里又把大路当 empty room 扣分
      // 完美 DFS 净扣 6 分 (cap), 跟连通奖励抵消 → GA 拉不开好坏
      // 正确语义: empty room = 大 wall 区域 (空地, 墙围合的死区)
    } else {
      if (size >= threshold) {
        emptyRooms++;             // 大 wall 才是 empty room (空地)
        emptyRoomSizes.push(size);
        wallBlocks++;             // 同义, 保留向后兼容
        wallBlockSizes.push(size);
      }
    }
  }

  return {
    roadConnectivity: {
      connected: roadComponents === 1 && totalRoads > 0,
      components: roadComponents,
      largestSize: largestRoadSize,
      largestSizeRatio: totalRoads > 0 ? largestRoadSize / totalRoads : 0,
      totalRoads,
    },
    largeRegions: {
      emptyRooms,
      wallBlocks,
      emptyRoomSizes,    // P0 Phase 2: size-weighted penalty
      wallBlockSizes,
    },
  };
}

/**
 * Combined: 1 次扫描同时算 死端 + 分支熵 + 拐角 + 交叉点 (sko 06-27 P0 优化)
 *
 * 原来 4 次扫描:
 *   - deadEndRatio: 数 n=1 的 road
 *   - branchEntropyNormalized: 4-neighbor 分布
 *   - elbowRatio: 数 2-邻路+2-邻墙
 *   - intersectionRatio: 数 n=3 或 4 的 road
 *
 * 现在 1 次扫描: 每个 road cell 数 4-neighbor, 同时更新所有指标
 *
 * 返回:
 *   - deadEndRatio
 *   - branchEntropyNormalized (0-1)
 *   - elbowRatio
 *   - intersectionRatio
 *   - roads: 所有 road cell 的 idx 数组 (供 pathDifficulty 复用)
 */
function combinedNeighborScan(gridData, width, height) {
  const counts = [0, 0, 0, 0, 0];  // n=0,1,2,3,4 (Buck 1989)
  const roads = [];                // pathDifficulty 复用
  let deadEnds = 0, elbows = 0, straights = 0, intersections = 0;
  let totalRoads = 0;

  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] === 0) continue;
    totalRoads++;
    roads.push(i);

    // 4 邻居 (out-of-bounds 视为墙, n 不计)
    const cy = (i - (i % width)) / width;
    const cx = i % width;
    const N = cy > 0 && gridData[i - width] > 0;
    const S = cy < height - 1 && gridData[i + width] > 0;
    const E = cx < width - 1 && gridData[i + 1] > 0;
    const W = cx > 0 && gridData[i - 1] > 0;
    const n = (N ? 1 : 0) + (S ? 1 : 0) + (E ? 1 : 0) + (W ? 1 : 0);
    counts[n]++;

    // Buck 5 指标 (Bellot 2021 §3.1):
    //   n=1: Dead-end
    //   n=2 + opposite walls (N+S or E+W): Straight cell
    //   n=2 + adjacent walls (NE/ES/SW/WN): Turn (= elbow)
    //   n=3: Junction (T-cross)
    //   n=4: Crossroad (4-way)
    if (n === 1) {
      deadEnds++;
    } else if (n === 2) {
      if ((N && S) || (E && W)) {
        straights++;  // 直道
      } else {
        elbows++;     // 拐角 (NE/ES/SW/WN)
      }
    } else if (n === 3 || n === 4) {
      intersections++;
    }
  }

  // 分支熵 (Shannon) / log2(5)
  let h = 0;
  for (const c of counts) {
    if (c > 0) {
      const p = c / totalRoads;
      h -= p * Math.log2(p);
    }
  }
  const entropy = totalRoads > 0 ? h / Math.log2(5) : 0;

  return {
    deadEndRatio: totalRoads > 0 ? deadEnds / totalRoads : 0,
    straightRatio: totalRoads > 0 ? straights / totalRoads : 0,
    elbowRatio: totalRoads > 0 ? elbows / totalRoads : 0,
    intersectionRatio: totalRoads > 0 ? intersections / totalRoads : 0,
    counts,  // 原始 n=0..4 分布, 供 advanced 用
    branchEntropyNormalized: entropy,
    totalRoads,
    roads,  // 供 pathDifficulty 复用
  };
}

/**
 * Non-Significant Walls (NSW) — Bellot 2021 §3.4
 *
 * 思想: 玩家扫描迷宫时, "一眼就知道是死路"的墙可以忽略.
 * 这些墙就是死端延伸形成的 "trapped passages".
 *
 * 算法 (Trémaux-style dead-end filling):
 *   1. 标记所有 intersection vertex (n ≥ 3) 为 "kept"
 *   2. 迭代删除所有 dead-end 路径上的 cell (除非该 cell 已被 kept)
 *   3. 剩下的 cell 数 = 不可忽略的"真路"
 *   4. NSW ratio = (totalRoads - keptRoads) / totalRoads
 *
 * 意义: NSW 越低 → 死端延伸越少 → 玩家每步都要做决策 → 越 fun
 *
 * 注: 本实现采用 cell-based, Bellot 原文是 wall-based 但 cell-based 等价
 */
function nonSignificantWallsRatio(gridData, width, height) {
  // 复制 road cells 用于迭代删除
  const roadAlive = new Uint8Array(gridData.length);
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] > 0) roadAlive[i] = 1;
  }

  // Step 1: 标记所有 intersection (n ≥ 3) 为 kept
  const kept = new Uint8Array(gridData.length);
  let totalRoads = 0;
  for (let i = 0; i < gridData.length; i++) {
    if (roadAlive[i] === 0) continue;
    totalRoads++;
    const cy = (i - (i % width)) / width;
    const cx = i % width;
    const N = cy > 0 && roadAlive[i - width];
    const S = cy < height - 1 && roadAlive[i + width];
    const E = cx < width - 1 && roadAlive[i + 1];
    const W = cx > 0 && roadAlive[i - 1];
    const n = (N ? 1 : 0) + (S ? 1 : 0) + (E ? 1 : 0) + (W ? 1 : 0);
    if (n >= 3) kept[i] = 1;
  }

  // Step 2: 迭代删除 dead-end 路径
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < gridData.length; i++) {
      if (roadAlive[i] === 0 || kept[i]) continue;
      const cy = (i - (i % width)) / width;
      const cx = i % width;
      const N = cy > 0 && roadAlive[i - width];
      const S = cy < height - 1 && roadAlive[i + width];
      const E = cx < width - 1 && roadAlive[i + 1];
      const W = cx > 0 && roadAlive[i - 1];
      const n = (N ? 1 : 0) + (S ? 1 : 0) + (E ? 1 : 0) + (W ? 1 : 0);
      if (n <= 1) {  // dead-end 或 isolated (也删除)
        roadAlive[i] = 0;
        changed = true;
      }
    }
  }

  // Step 3: 统计 keptRoads
  let keptRoads = 0;
  for (let i = 0; i < gridData.length; i++) {
    if (roadAlive[i]) keptRoads++;
  }

  // NSW ratio: 删除掉的 road 占总 road 的比例
  return totalRoads > 0 ? 1.0 - keptRoads / totalRoads : 0;
}

/**
 * Longest Path / Diameter (McClendon Difficulty proxy)
 *
 * Bellot 2021 §3.2 + McClendon 2001 都需要 longest path 作为 input.
 * 简化实现: BFS 找 eccentricity max → diameter
 *
 * 算法: BFS from (0,0), 找 farthest cell; BFS from there, 找 farthest = diameter
 * (经典: Tree 的 diameter = 两次 BFS)
 */
function longestPathLength(gridData, width, height) {
  // 找第一个 road cell 作为起点
  let start = -1;
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] > 0) { start = i; break; }
  }
  if (start < 0) return 0;

  // BFS 1: from start, find farthest cell A
  const bfsDist = (sx, sy) => {
    const dist = new Int32Array(width * height);
    for (let i = 0; i < dist.length; i++) dist[i] = -1;
    const queue = [sy * width + sx];
    dist[sy * width + sx] = 0;
    let head = 0;
    let farthest = sy * width + sx;
    let maxD = 0;
    while (head < queue.length) {
      const cidx = queue[head++];
      const d = dist[cidx];
      if (d > maxD) { maxD = d; farthest = cidx; }
      const cx = cidx % width;
      const cy = (cidx - cx) / width;
      if (cx > 0 && dist[cidx - 1] < 0 && gridData[cidx - 1] > 0) {
        dist[cidx - 1] = d + 1;
        queue.push(cidx - 1);
      }
      if (cx < width - 1 && dist[cidx + 1] < 0 && gridData[cidx + 1] > 0) {
        dist[cidx + 1] = d + 1;
        queue.push(cidx + 1);
      }
      if (cy > 0 && dist[cidx - width] < 0 && gridData[cidx - width] > 0) {
        dist[cidx - width] = d + 1;
        queue.push(cidx - width);
      }
      if (cy < height - 1 && dist[cidx + width] < 0 && gridData[cidx + width] > 0) {
        dist[cidx + width] = d + 1;
        queue.push(cidx + width);
      }
    }
    return { farthest, maxD };
  };

  const { farthest: ax } = bfsDist(start % width, (start - start % width) / width);
  const { maxD: diameter } = bfsDist(ax % width, (ax - ax % width) / width);

  return diameter;
}

/**
 * 反转 grid (0 ↔ 1)
 */
function invertGrid(data, width, height) {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] > 0 ? 0 : 1;
  }
  return out;
}

/**
 * Gaussian
 */
function gaussian(value, peak, sharpness) {
  if (value < 0) return 0;
  return Math.exp(-Math.pow(value - peak, 2) * sharpness);
}

// ========== 全 10 指标计算 (CPU, 移植自 src/metrics/) ==========

// 注: bfsConnectivity 和 findLargeRegions 已被 combinedConnectivityAndRegions 替代
// 旧函数保留供向后兼容 / debug

/**
 * 大区域 (rooms/wallBlocks) - BFS 数 >= threshold 的同态连通分量
 */
function findLargeRegions(gridData, width, height, threshold = 9) {
  const visited = new Uint8Array(width * height);
  let emptyRooms = 0, wallBlocks = 0;

  for (let i = 0; i < gridData.length; i++) {
    if (visited[i]) continue;
    const isRoad = gridData[i] > 0;
    const queue = [i];
    visited[i] = 1;
    let head = 0;
    let size = 0;
    while (head < queue.length) {
      const cidx = queue[head++];
      size++;
      const cx = cidx % width;
      const cy = (cidx - cx) / width;
      if (cx > 0) {
        const nidx = cidx - 1;
        if (!visited[nidx] && (gridData[nidx] > 0) === isRoad) { visited[nidx] = 1; queue.push(nidx); }
      }
      if (cx < width - 1) {
        const nidx = cidx + 1;
        if (!visited[nidx] && (gridData[nidx] > 0) === isRoad) { visited[nidx] = 1; queue.push(nidx); }
      }
      if (cy > 0) {
        const nidx = cidx - width;
        if (!visited[nidx] && (gridData[nidx] > 0) === isRoad) { visited[nidx] = 1; queue.push(nidx); }
      }
      if (cy < height - 1) {
        const nidx = cidx + width;
        if (!visited[nidx] && (gridData[nidx] > 0) === isRoad) { visited[nidx] = 1; queue.push(nidx); }
      }
    }
    if (size >= threshold) {
      if (isRoad) emptyRooms++;
      else wallBlocks++;
    }
  }
  return { emptyRooms, wallBlocks };
}

/**
 * 4 邻居路数
 */
function countRoadNeighbors(gridData, width, height, idx) {
  const cx = idx % width;
  const cy = (idx - cx) / width;
  let n = 0;
  if (cy > 0 && gridData[idx - width] > 0) n++;
  if (cy < height - 1 && gridData[idx + width] > 0) n++;
  if (cx > 0 && gridData[idx - 1] > 0) n++;
  if (cx < width - 1 && gridData[idx + 1] > 0) n++;
  return n;
}

/**
 * 死端 = 4 邻居路数 = 1
 */
function deadEndRatio(gridData, width, height) {
  let deadEnds = 0, totalCells = 0;
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] === 0) continue;
    totalCells++;
    if (countRoadNeighbors(gridData, width, height, i) === 1) deadEnds++;
  }
  return totalCells > 0 ? deadEnds / totalCells : 0;
}

/**
 * 拐角: 2 个相邻路 + 2 个相邻墙 (4 种: NE/ES/SW/WN)
 */
function elbowRatio(gridData, width, height) {
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (gridData[idx] === 0) continue;
      // 4 邻居 (out-of-bounds 视为墙)
      const N = y > 0 && gridData[idx - width] > 0;
      const S = y < height - 1 && gridData[idx + width] > 0;
      const E = x < width - 1 && gridData[idx + 1] > 0;
      const W = x > 0 && gridData[idx - 1] > 0;
      const isCorner =
        (N && E && !S && !W) ||
        (E && S && !N && !W) ||
        (S && W && !N && !E) ||
        (W && N && !S && !E);
      if (isCorner) count++;
    }
  }
  const total = gridData.reduce((a, b) => a + (b > 0 ? 1 : 0), 0);
  return total > 0 ? count / total : 0;
}

/**
 * 交叉点比例 (3-way + 4-way)
 */
function intersectionRatio(gridData, width, height) {
  let total = 0, intersections = 0;
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] === 0) continue;
    total++;
    const n = countRoadNeighbors(gridData, width, height, i);
    if (n === 3 || n === 4) intersections++;
  }
  return total > 0 ? intersections / total : 0;
}

/**
 * 分支熵 (Shannon) / log2(5)
 */
function branchEntropyNormalized(gridData, width, height) {
  const counts = [0, 0, 0, 0, 0];  // n=0,1,2,3,4
  let total = 0;
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] === 0) continue;
    total++;
    counts[countRoadNeighbors(gridData, width, height, i)]++;
  }
  if (total === 0) return 0;
  let h = 0;
  for (const c of counts) {
    if (c > 0) {
      const p = c / total;
      h -= p * Math.log2(p);
    }
  }
  return h / Math.log2(5);  // 归一化 0-1
}

/**
 * 对称性偏置 (4 种变换平均, 只扫半边去重)
 *
 *   - UD: 上下镜像 (x, y) ↔ (x, H-1-y), 同 x 翻 y
 *   - LR: 左右镜像 (x, y) ↔ (W-1-x, y), 翻 x 同 y
 *   - Rot: 180° 旋转 (x, y) ↔ (W-1-x, H-1-y)
 *   - Diag: 主对角 (W=H 时有意义, 否则中性 0.5)
 *
 *   返回: 0-1 (0=完全不对称, 1=完全对称, 真迷宫应 < 0.7)
 *
 *   P0 优化: 只遍历 (W/2) * H 个 cell (上半 / 下半各扫一次), 而不是整个 grid
 *   对于 LR 镜像: 每一对 (x, y) ↔ (W-1-x, y) 在 half-x 处会合
 *   对于 UD 镜像: 每一对在 half-y 处会合
 *   对于 Rot: 在 center 处会合 (奇偶 W×H 需要不同处理)
 */
function symmetryBias(gridData, width, height) {
  // UD 镜像: 只扫上半 (y < H/2), 避免重复计算 (y, H-1-y)
  // LR 镜像: 完整扫 (要算每一对的均值)
  // Rot 180: 完整扫 (要算每一对的均值)

  let sameUD = 0, sameLR = 0, sameRot = 0;
  const totalHalf = width * Math.floor(height / 2);
  const totalFull = width * height;
  const halfH = Math.floor(height / 2);

  // UD: 只扫上半
  for (let y = 0; y < halfH; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const udIdx = (height - 1 - y) * width + x;
      if ((gridData[idx] > 0) === (gridData[udIdx] > 0)) sameUD++;
    }
  }
  // UD 中间行 (奇数 H 时): 自比 = 1, 加 0.5 权重
  if (height % 2 === 1) {
    const midY = halfH;
    for (let x = 0; x < width; x++) {
      const idx = midY * width + x;
      sameUD++;  // (idx, idx) 永远相同
    }
  }

  // LR: 只扫左半
  const halfW = Math.floor(width / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < halfW; x++) {
      const idx = y * width + x;
      const lrIdx = y * width + (width - 1 - x);
      if ((gridData[idx] > 0) === (gridData[lrIdx] > 0)) sameLR++;
    }
  }
  if (width % 2 === 1) {
    const midX = halfW;
    for (let y = 0; y < height; y++) {
      const idx = y * width + midX;
      sameLR++;
    }
  }

  // Rot 180: 只扫 4 分之 1 (x < W/2 且 y < H/2)
  // 4 分之 1 旋转 = 自己, 每对 cell 贡献 1 个比较
  for (let y = 0; y < halfH; y++) {
    for (let x = 0; x < halfW; x++) {
      const idx = y * width + x;
      const rotIdx = (height - 1 - y) * width + (width - 1 - x);
      if ((gridData[idx] > 0) === (gridData[rotIdx] > 0)) sameRot++;
    }
  }
  // 中间行 / 列需要特殊处理 (W 或 H 奇数)
  // 中间行 × 左半
  if (height % 2 === 1) {
    const midY = halfH;
    for (let x = 0; x < halfW; x++) {
      const idx = midY * width + x;
      const rotIdx = midY * width + (width - 1 - x);
      if ((gridData[idx] > 0) === (gridData[rotIdx] > 0)) sameRot++;
    }
  }
  // 中间列 × 上半
  if (width % 2 === 1) {
    const midX = halfW;
    for (let y = 0; y < halfH; y++) {
      const idx = y * width + midX;
      const rotIdx = (height - 1 - y) * width + midX;
      if ((gridData[idx] > 0) === (gridData[rotIdx] > 0)) sameRot++;
    }
  }
  // center cell (W 和 H 都奇数)
  if (width % 2 === 1 && height % 2 === 1) {
    sameRot++;
  }

  // 总比较数 (每对 cell 算一次)
  const totalUD = totalHalf + (height % 2 === 1 ? width : 0);
  const totalLR = height * halfW + (width % 2 === 1 ? height : 0);
  const totalRot = halfW * halfH
    + (height % 2 === 1 ? halfW : 0)
    + (width % 2 === 1 ? halfH : 0)
    + (width % 2 === 1 && height % 2 === 1 ? 1 : 0);

  const ud = sameUD / totalUD;
  const lr = sameLR / totalLR;
  const rot = sameRot / totalRot;
  const diag = (width === height) ? 0.5 : 0.5;  // 简化: 非方形时 diag = 0.5 (中性)
  return (ud + lr + rot + diag) / 4;
}

/**
 * 走廊宽度 (BFS distance transform from walls) — avg
 *
 * 返回平均 corridor 宽度, 同时返回单格宽 cell 占比 (singleWideRatio)
 *
 * 关键 (sko 06-27 v3.3):
 *   - avgCorridor: 传统指标, 单格宽真迷宫 ≈ 1.0-1.2, blob ≈ 2.0+
 *   - singleWideRatio: 新指标, dist=1 的 cell 占总 road 的比例
 *     - DFS 完美迷宫: 0.6-0.7 (大部分 cell 在单格宽 corridor 边)
 *     - 涌现 CA 波纹 blob: 0.2-0.4 (太多中心 cell)
 *     - 单格宽比例 < 0.4 → 不是真迷宫
 */
function corridorMetrics(gridData, width, height) {
  const dist = new Float32Array(width * height);
  const queue = [];
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] === 0) { dist[i] = 0; queue.push(i); }
    else { dist[i] = Infinity; }
  }
  let head = 0;
  while (head < queue.length) {
    const cidx = queue[head++];
    const cx = cidx % width;
    const cy = (cidx - cx) / width;
    const d = dist[cidx] + 1;
    if (cx > 0 && dist[cidx - 1] === Infinity) { dist[cidx - 1] = d; queue.push(cidx - 1); }
    if (cx < width - 1 && dist[cidx + 1] === Infinity) { dist[cidx + 1] = d; queue.push(cidx + 1); }
    if (cy > 0 && dist[cidx - width] === Infinity) { dist[cidx - width] = d; queue.push(cidx - width); }
    if (cy < height - 1 && dist[cidx + width] === Infinity) { dist[cidx + width] = d; queue.push(cidx + width); }
  }
  let sum = 0, count = 0;
  let count1 = 0;
  for (let i = 0; i < gridData.length; i++) {
    if (gridData[i] > 0 && dist[i] !== Infinity) {
      sum += dist[i];
      count++;
      // dist=1.0 是单格宽 (distance transform 步长 = 1)
      if (Math.abs(dist[i] - 1.0) < 0.5) count1++;
    }
  }
  return {
    avg: count > 0 ? sum / count : 0,
    singleWideRatio: count > 0 ? count1 / count : 0,
  };
}

/**
 * BFS 最短路径距离 (4 邻居, only road cells)
 */
function bfsDistance(gridData, width, height, sx, sy, ex, ey) {
  if (gridData[sy * width + sx] === 0 || gridData[ey * width + ex] === 0) return Infinity;
  if (sx === ex && sy === ey) return 0;
  const visited = new Uint8Array(width * height);
  const queue = [[sx, sy, 0]];
  visited[sy * width + sx] = 1;
  let head = 0;
  while (head < queue.length) {
    const [x, y, d] = queue[head++];
    if (x > 0) {
      const nidx = y * width + (x - 1);
      if (!visited[nidx] && gridData[nidx] > 0) {
        if (x - 1 === ex && y === ey) return d + 1;
        visited[nidx] = 1; queue.push([x - 1, y, d + 1]);
      }
    }
    if (x < width - 1) {
      const nidx = y * width + (x + 1);
      if (!visited[nidx] && gridData[nidx] > 0) {
        if (x + 1 === ex && y === ey) return d + 1;
        visited[nidx] = 1; queue.push([x + 1, y, d + 1]);
      }
    }
    if (y > 0) {
      const nidx = (y - 1) * width + x;
      if (!visited[nidx] && gridData[nidx] > 0) {
        if (x === ex && y - 1 === ey) return d + 1;
        visited[nidx] = 1; queue.push([x, y - 1, d + 1]);
      }
    }
    if (y < height - 1) {
      const nidx = (y + 1) * width + x;
      if (!visited[nidx] && gridData[nidx] > 0) {
        if (x === ex && y + 1 === ey) return d + 1;
        visited[nidx] = 1; queue.push([x, y + 1, d + 1]);
      }
    }
  }
  return Infinity;
}

/**
 * 路径难度: 多次随机 (start, end) BFS, 平均 distance / diameter
 */
/**
 * 路径难度: 多次随机 (start, end) BFS, 平均 distance / diameter
 *
 * @param {Uint8Array} gridData
 * @param {number} width
 * @param {number} height
 * @param {SeededRandom} rng
 * @param {number} samples - 随机对数 (默认 3)
 * @param {number[]} [precomputedRoads] - 复用 caller 算好的 roads 数组 (P0 优化)
 */
function pathDifficulty(gridData, width, height, rng, samples = 3, precomputedRoads = null) {
  // 收集所有路格子 (P0: 复用 caller 已收集的)
  let roads = precomputedRoads;
  if (!roads) {
    roads = [];
    for (let i = 0; i < gridData.length; i++) {
      if (gridData[i] > 0) roads.push(i);
    }
  }
  if (roads.length < 2) return 0;

  const diameter = width + height;  // 曼哈顿距离上限
  let totalRatio = 0;
  let reachableCount = 0;

  for (let i = 0; i < samples; i++) {
    const sidx = roads[rng.nextInt(roads.length)];
    let eidx = roads[rng.nextInt(roads.length)];
    let attempts = 0;
    while (eidx === sidx && attempts < 10) {
      eidx = roads[rng.nextInt(roads.length)];
      attempts++;
    }
    if (eidx === sidx) continue;
    const sx = sidx % width, sy = (sidx - sx) / width;
    const ex = eidx % width, ey = (eidx - ex) / width;
    const dist = bfsDistance(gridData, width, height, sx, sy, ex, ey);
    if (dist !== Infinity) {
      totalRatio += dist / diameter;
      reachableCount++;
    }
  }
  return reachableCount > 0 ? totalRatio / reachableCount : 0;
}

/**
 * 边界围合 (cheap, O(W+H))
 * 真迷宫应该"边界都是墙", 内部才是 path
 */
function boundaryCheck(gridData, width, height) {
  for (let x = 0; x < width; x++) {
    if (gridData[x] > 0) return false;
    if (gridData[(height-1)*width + x] > 0) return false;
  }
  for (let y = 0; y < height; y++) {
    if (gridData[y*width] > 0) return false;
    if (gridData[y*width + (width-1)] > 0) return false;
  }
  return true;
}

/**
 * 全指标评分 (v4 — 纯归一化 + 加权求和, sko 06-27)
 *
 * 设计 (重要,跟 v3 不同):
 *   - 每个指标独立打分函数, 归一化到 [0, 1] 或 [-1, 1]
 *   - 全部加权求和, 没有特殊处理 (hard cap / F proxy / mixed 加减)
 *   - 没有"加项 vs 减项"的混乱: 一律 add weighted score
 *
 * 指标 8 项 (归一化后 [0,1] 或 [-1,1]):
 *   1. connectivity  - 连通比 (越高越好, 0-1)
 *   2. nsw           - 死端延伸 (越低越好, 0=无, 1=全是)
 *   3. twistiness    - twisty path: diameter / grid_diagonal (ratio≥3 真迷宫)
 *   4. corridor      - 单格宽 cell 比例 + avg corridor
 *   5. buck5         - deadEnd / straight / turn / intersection 综合
 *   6. difficulty    - 路径难度 (BFS expanded proxy)
 *   7. boundary      - 边界围合
 *   8. entropy       - 分支熵
 *   - symmetry       - 对称性 (减分, 越对称越不像随机迷宫)
 *
 * @param {Uint8Array} gridData - 0/1 grid
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 * @param {SeededRandom} [opts.rng] - 用于 pathDifficulty
 * @returns {{total: number, details: object}}
 */

// ============ 独立打分函数 (归一化到 [0, 1] 或 [-1, 1]) ============

// 1. 连通: ratio 0→0, 1→1, 平滑
function scoreConnectivity(ratio) {
  return Math.max(0, Math.min(1, ratio));
}

// 2. NSW: 0→1 (好), 1→-1 (差)
//   真迷宫 NSW ≈ 0.25, blob ≈ 0.55+
//   NSW=0.5 → score = 0
function scoreNSW(nsw) {
  return 1 - 2 * Math.max(0, Math.min(1, nsw));
}

// 3. Twistiness: 核心 maze vs blob 指标 (Bellot 论文 §3.2 spirit)
//   真迷宫 diameter >> 对角线 (twisty path)
//   blob diameter ≈ 对角线 (直线穿过)
//   ratio=1 → 0, ratio=3+ → 1
function scoreTwistiness(diameter, width, height) {
  const minDist = Math.sqrt(width * width + height * height);
  const ratio = diameter / Math.max(1, minDist);
  return Math.min(Math.max(0, ratio - 1) / 5, 1);  // ratio=1 → 0, ratio=6 → 1
}

// 4. Corridor: 单格宽比例 + avg corridor 综合
//   真迷宫: singleWide≈0.6, avg≈1.0
//   blob: singleWide≈0.3, avg≈2.0+
function scoreCorridor(avg, singleWide) {
  const avgFit = Math.exp(-Math.pow(avg - 1.0, 2) * 3);
  const swFit = Math.exp(-Math.pow(singleWide - 0.6, 2) * 20);
  return (avgFit + swFit) / 2;
}

// 5. Buck 5 指标综合 (Bellot 2021 §3.1)
//   deadEnd peak 0.18, straight peak 0.40, turn (elbow) peak 0.20
//   intersection 越小越好
function scoreBuck5(scan) {
  const d = Math.exp(-Math.pow(scan.deadEndRatio - 0.18, 2) * 30);
  const s = Math.exp(-Math.pow(scan.straightRatio - 0.40, 2) * 10);
  const t = Math.exp(-Math.pow(scan.elbowRatio - 0.20, 2) * 30);
  const i = 1 - Math.min(scan.intersectionRatio * 50, 1);  // 0.02 → ~0, 0 → 1
  return (d + s + t + i) / 4;
}

// 6. 路径难度 (BFS expanded proxy, peak 0.5)
function scoreDifficulty(d) {
  return Math.exp(-Math.pow(d - 0.5, 2) * 8);
}

// 7. 围合: closed=1, otherwise 0
function scoreBoundary(closed) {
  return closed ? 1 : 0;
}

// 8. 对称性 (减分项, 越对称越不像随机迷宫)
function scoreSymmetry(symmetry) {
  return Math.max(0, Math.min(1, symmetry));  // 0 = 完美不对称, 1 = 全对称
}

// ============ 加权求和 (主入口) ============

const SCORE_WEIGHTS = {
  connectivity: 3.0,   // 连通 (基本要求, 不能太大否则压死其他)
  nsw: 5.0,           // Bellot NSW (低 NSW = 真迷宫)
  twistiness: 6.0,    // twisty path (核心 maze vs blob 区分) ⭐
  corridor: 5.0,      // 单格宽 (防波纹 blob)
  buck5: 4.0,         // 死端/直道/拐角 (Buck 1989)
  difficulty: 2.0,    // 路径难度
  boundary: 1.0,      // 围合奖励
  entropy: 0.5,       // 分支熵
  // 减分
  symmetry: 2.0,      // 对称性 (低好, 但减分不过重)
};

/**
 * 全指标评分 — Bellot 2021 + McClendon 2001 + Buck 2015 完整复现 (sko 06-27 v5)
 *
 * 直接 delegate 给 bellot_metrics.js 的 bellotScore()
 * 实现细节见 bellot_metrics.js
 */
function computeFullMazeScore(gridData, width, height, opts = {}) {
  return bellotScore(gridData, width, height, opts);
}

/**
 * @deprecated 旧的 3 指标简化版,保留供向后兼容 (sko 06-27)
 * 新代码请用 computeFullMazeScore
 */
function computeSimpleMazeScore(gridData, width, height) {
  const full = computeFullMazeScore(gridData, width, height);
  return { total: full.total, details: { roadConnectivity: full.details.roadConnectivity, roadFraction: full.details.roadFraction, gated: full.details.gated } };
}

/**
 * GPUScorer class — 浏览器端 scorer, GPU 跑 CA + CPU 算 maze_score
 */
export class GPUScorer {
  constructor() {
    this.gpu = new GPUEngine();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return { ok: true };
    const result = await this.gpu.init();
    if (!result.ok) return result;
    this.initialized = true;
    return result;
  }

  /**
   * 评估一批 chromosomes (串行: 一次处理 1 rule)
   * @param {Array} chromosomes - [{bits: BitArray-like}, ...]
   * @param {object} opts
   * @returns {Promise<Array<{total, score, conn, components, ...}>>}
   */
  async evaluateBatch(chromosomes, opts) {
    if (!this.initialized) await this.init();

    // 支持 W × H 非方形网格 (sko 06-27)
    // ✅ v9: 加 cellMaskType (cheayshev-N / manhattan-N)
    //   sko 07-01: 加 initFullScreen + initDensity 选项
    const { seeds = 4, gridSize = 40, gridWidth = gridSize, gridHeight = gridSize, steps = 300, patchSize = 10, cellMaskType, metric = 'mazeScore', initFullScreen = false, initDensity = 0.15 } = opts;
    const results = [];

    for (let i = 0; i < chromosomes.length; i++) {
      const chrom = chromosomes[i];
      const ruleJson = decodeChromosome(chrom, cellMaskType);

      // 1. 生成 N seeds 初始 grid
      const initialGrids = new Uint8Array(seeds * gridWidth * gridHeight);
    // ✅ FIX (sko 07-01): initFullScreen=true → 全屏 density 概率 noise
    const _useFullScreen = initFullScreen || patchSize < 2;
    if (_useFullScreen) {
      for (let s = 0; s < seeds; s++) {
        const rng = new SeededRandom(s + (randomSeed|0) * 1000003);  // anchor on seed idx + user seed
        for (let y = 0; y < gridHeight; y++) {
          for (let x = 0; x < gridWidth; x++) {
            // initDensity 概率 alive
            initialGrids[s * gridWidth * gridHeight + y * gridWidth + x] = rng.nextFloat() < initDensity ? 1 : 0;
          }
        }
      }
    } else {
      for (let s = 0; s < seeds; s++) {
        const rng = new SeededRandom(s);
        const cx = Math.floor(gridWidth / 2);
        const cy = Math.floor(gridHeight / 2);
        const half = Math.floor(patchSize / 2);
        for (let y = cy - half; y < cy - half + patchSize; y++) {
          for (let x = cx - half; x < cx - half + patchSize; x++) {
            if (x < 0 || x >= gridWidth || y < 0 || y >= gridHeight) continue;
            const v = rng.nextFloat() < 0.25 ? 1 : 0;
            initialGrids[s * gridWidth * gridHeight + y * gridWidth + x] = v;
          }
        }
      }
    }

      // 2. GPU 跑 CA 演化
      const uniformsBuf = this.gpu.encodeRuleToUniform(ruleJson);
      const caResult = await this.gpu.runSteps({
        uniformsBuf,
        initialGrids,
        width: gridWidth,
        height: gridHeight,
        numSeeds: seeds,
        steps,
      });

      // 3. CPU 算 maze_score (平均 N seeds)
      let totalScore = 0;
      let bestConn = null;
      const seedScores = [];
      // 每个 rule 独立 rng (从 i 派生, 保证可复现)
      const ruleRng = new SeededRandom(i * 12345 + 1);
      for (let s = 0; s < seeds; s++) {
        const seedGridData = new Uint8Array(gridWidth * gridHeight);
        for (let j = 0; j < gridWidth * gridHeight; j++) {
          seedGridData[j] = caResult.finalGrids[s * gridWidth * gridHeight + j];
        }
        // 同时算原版 + 反转, 取最高 (移植自 maze_score.js, 10 指标)
        // sko 06-29: metric option — 'mazeScore' (Bellot 10 维) 或 'mazeQuality' (7 维几何平均)
        let origScore, invScore;
        if (metric === 'mazeQuality') {
          origScore = mazeQuality(seedGridData, gridWidth, gridHeight);
          invScore = mazeQuality(invertedData, gridWidth, gridHeight);
        } else {
          origScore = computeFullMazeScore(seedGridData, gridWidth, gridHeight, { rng: ruleRng });
          invScore = computeFullMazeScore(invertedData, gridWidth, gridHeight, { rng: ruleRng });
        }

        const finalScore = invScore.total > origScore.total ? invScore : origScore;
        finalScore.usedInverted = invScore.total > origScore.total;
        totalScore += finalScore.total;
        seedScores.push(finalScore.total);

        // ✅ FIX (sko 06-27 v6): 防御性 null check, 防止 gate 时 roadConnectivity undefined 崩溃
        const fc = finalScore.details?.roadConnectivity;
        if (fc && (!bestConn || fc.largestSizeRatio > bestConn.largestSizeRatio)) {
          bestConn = fc;
        }
      }
      const meanScore = totalScore / seeds;

      results.push({
        chromosomeIdx: i,
        total: meanScore,
        score: meanScore,
        conn: bestConn?.largestSizeRatio || 0,
        components: bestConn?.components || 0,
        connected: bestConn?.connected || false,
        largestSize: bestConn?.largestSize || 0,
        totalRoads: bestConn?.totalRoads || 0,
        roadFraction: bestConn?.totalRoads ? (bestConn.totalRoads / (gridWidth * gridHeight)) : 0,
        gpuTimeMs: caResult.gpuTimeMs,
        seedScores,
        ruleJson,
      });
    }

    return results;
  }

  destroy() {
    this.gpu.destroy();
  }
}

/**
 * BatchedGPUScorer — 一次 dispatch 评估 N rules × M seeds (sko 06-27, Phase 9)
 *
 * 性能优势 vs 串行 GPUScorer:
 *   - 避免 GPU command encoder 创建/提交开销 (300 次 vs 240,000 次)
 *   - 单个 GPU dispatch 工作量更大, GPU 利用率更高
 *   - 实测: 100 rules × 4 seeds × 300 steps × 100×60 加速 ~10-30x
 *
 * 用法:
 *   const scorer = new BatchedGPUScorer();
 *   await scorer.init();
 *   const results = await scorer.evaluateBatchBatched(chromosomes, {seeds, W, H, steps});
 */
export class BatchedGPUScorer {
  constructor() {
    this.gpu = new BatchedGPUEngine();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return { ok: true };
    const result = await this.gpu.init();
    if (!result.ok) return result;
    this.initialized = true;
    return result;
  }

  /**
   * 评估一批 chromosomes (1 次 dispatch 跑所有)
   * @param {Array} chromosomes - [{bits: BitArray-like}, ...]
   * @param {object} opts
   * @returns {Promise<Array<{total, score, conn, components, ...}>>}
   */
  async evaluateBatchBatched(chromosomes, opts) {
    if (!this.initialized) await this.init();

    // ✅ v9: 加 cellMaskType (cheayshev-N / manhattan-N)
    //   sko 06-29: 加 metric option ('mazeScore' 现有 / 'mazeQuality' Bellot 7 维)
    //   sko 07-01: 加 initFullScreen + initDensity 选项 (full-grid noise vs centered patch)
    const { seeds = 4, gridWidth = 100, gridHeight = 60, steps = 300, patchSize = 10, cellMaskType, randomSeed = 0, metric = 'mazeScore', initFullScreen = false, initDensity = 0.15 } = opts;
    const numRules = chromosomes.length;
    const cellsPerSeed = gridWidth * gridHeight;
    const totalCells = numRules * seeds * cellsPerSeed;

    // 1. 解码所有 chromosomes (✅ v9: 用 cellMaskType 过滤 cell range)
    const ruleJsons = chromosomes.map(chrom => decodeChromosome(chrom, cellMaskType));

    // 2. 生成所有初始 grids (numRules × seeds × W × H)
    // ✅ FIX (sko 06-28): init seed 由 chrom bits hash 派生, 跟 position 无关
    //   之前: SeededRandom(randomSeed + r * MAX_SEEDS + s) — 同一 chrom 在不同 r 拿不同 init
    //   → pop[0] B2/S123 (r=0) 拿 4.42, pop[19] B2/S123 (r=19) 拿 -100 (同 chrom 不同分)
    //   → elite 在 gen N 可能在 r=5 拿幸运 init, gen N+1 升到 r=0 拿不同 init → best 暴跌
    //   现在: hash(bits) 唯一决定 init → 同一 chrom 永远同一 init → score 一致 → best 单调上升
    const initialGrids = new Uint8Array(totalCells);
    const MAX_SEEDS = 32;
    // ✅ FIX (sko 07-01): initFullScreen=true (default false)
    //   用整个 grid 范围做 density 概率 init (sparse noise 散步起点 — 让 GA 学习从 noise 中长出 maze)
    //   initFullScreen=false + patchSize<2 → legacy full grid (0.25 density)
    //   initFullScreen=false + patchSize≥2 → 中心 patchSize × patchSize patch
    const _useFullScreen = initFullScreen || patchSize < 2;
    if (_useFullScreen) {
      for (let r = 0; r < numRules; r++) {
        let chromHash = 0;
        const bits = chromosomes[r].bits;
        for (let b = 0; b < bits.length; b++) chromHash = ((chromHash * 31) + bits[b]) | 0;
        for (let s = 0; s < seeds; s++) {
          const rng = new SeededRandom((randomSeed + chromHash * 65537 + s) >>> 0);
          for (let y = 0; y < gridHeight; y++) {
            for (let x = 0; x < gridWidth; x++) {
              const v = rng.nextFloat() < initDensity ? 1 : 0;
              const idx = (r * seeds + s) * cellsPerSeed + y * gridWidth + x;
              initialGrids[idx] = v;
            }
          }
        }
      }
    } else {
      for (let r = 0; r < numRules; r++) {
        // ✅ Chromosome identity hash (xor 所有 bytes)
        let chromHash = 0;
        const bits = chromosomes[r].bits;
        for (let b = 0; b < bits.length; b++) chromHash = ((chromHash * 31) + bits[b]) | 0;
        for (let s = 0; s < seeds; s++) {
          // ✅ v9: randomSeed 偏移, 用户可复现 (同 seed → 同 patch)
          const rng = new SeededRandom((randomSeed + chromHash * 65537 + s) >>> 0);
          const cx = Math.floor(gridWidth / 2);
          const cy = Math.floor(gridHeight / 2);
          const half = Math.floor(patchSize / 2);
          for (let y = cy - half; y < cy - half + patchSize; y++) {
            for (let x = cx - half; x < cx - half + patchSize; x++) {
              if (x < 0 || x >= gridWidth || y < 0 || y >= gridHeight) continue;
              const v = rng.nextFloat() < 0.25 ? 1 : 0;
              const idx = (r * seeds + s) * cellsPerSeed + y * gridWidth + x;
              initialGrids[idx] = v;
            }
          }
        }
      }
    }

    // 3. 编码 rules
    const ruleParams = this.gpu.encodeRules(ruleJsons);

    // 4. 一次 dispatch 跑所有
    // ✅ FIX (sko 06-27): 检测混合 topology, GPU batched 只能跑一种, fallback to bounded
    const hasToroidal = ruleJsons.some(r => r?.topology === 'toroidal');
    const hasBounded = ruleJsons.some(r => r?.topology === 'bounded' || !r?.topology);
    const topologyType = hasToroidal && !hasBounded ? 1 : 0;
    const defaultState = ruleJsons[0]?.defaultState || 0;

    const caResult = await this.gpu.runBatchedSteps({
      ruleParams,
      initialGrids,
      width: gridWidth,
      height: gridHeight,
      numSeeds: seeds,
      numRules,
      steps,
      topologyType,
      defaultState,
    });

    // 5. CPU 算 maze_score (循环每个 rule + seed)
    const results = [];
    for (let r = 0; r < numRules; r++) {
      let totalScore = 0;
      let bestConn = null;
      let bestGrid = null;        // ✅ FIX (06-28): track best seed's final grid for preview
      let bestInitGrid = null;    // ✅ FIX (sko 07-01): track best seed's init grid (Live preview 双显)
      let bestSeedScore = -Infinity;
      const seedScores = [];
      // 每个 rule 独立 rng (从 r 派生, 保证可复现)
      const ruleRng = new SeededRandom(r * 12345 + 1);

      for (let s = 0; s < seeds; s++) {
        const seedGridData = new Uint8Array(cellsPerSeed);
        const baseIdx = (r * seeds + s) * cellsPerSeed;
        for (let i = 0; i < cellsPerSeed; i++) {
          seedGridData[i] = caResult.finalGrids[baseIdx + i];
        }
        // ✅ FIX (sko 07-01): copy init grid for the same seed (Live preview 双显)
        const seedInitGrid = new Uint8Array(cellsPerSeed);
        for (let i = 0; i < cellsPerSeed; i++) {
          seedInitGrid[i] = initialGrids[baseIdx + i];
        }
        // ✅ FIX (06-29): invert grid (was undefined — spike caught it)
        const invertedData = new Uint8Array(seedGridData.length);
        for (let i = 0; i < seedGridData.length; i++) invertedData[i] = 1 - seedGridData[i];
        let origScore, invScore;
        if (metric === 'mazeQuality') {
          origScore = mazeQuality(seedGridData, gridWidth, gridHeight);
          invScore = mazeQuality(invertedData, gridWidth, gridHeight);
        } else {
          origScore = computeFullMazeScore(seedGridData, gridWidth, gridHeight, { rng: ruleRng });
          invScore = computeFullMazeScore(invertedData, gridWidth, gridHeight, { rng: ruleRng });
        }

        const finalScore = invScore.total > origScore.total ? invScore : origScore;
        finalScore.usedInverted = invScore.total > origScore.total;
        totalScore += finalScore.total;
        seedScores.push(finalScore.total);

        // ✅ Track best seed's grid (for preview to show exactly what was scored)
        // ✅ FIX (06-29): bestGrid must match the scoring side (inv if usedInverted)
        if (finalScore.total > bestSeedScore) {
          bestSeedScore = finalScore.total;
          const gridForBest = finalScore.usedInverted ? invertedData : seedGridData;
          bestGrid = new Uint8Array(gridForBest);
          bestInitGrid = new Uint8Array(seedInitGrid);  // 配对保存 init grid (不 invert)
        }

        // ✅ FIX (sko 06-27 v6): 防御性 null check, 防止 gate 时 roadConnectivity undefined 崩溃
        const fc = finalScore.details?.roadConnectivity;
        if (fc && (!bestConn || fc.largestSizeRatio > bestConn.largestSizeRatio)) {
          bestConn = fc;
        }
      }
      // 🎯 UI YIELD: 每 2 个 rules yield 一次 (sko 06-27 v2: 从 4 → 2, 减少卡顿)
      // 防止 1000 pop × 32 seeds 卡 5-10 秒无响应
      // RAF 一次 ~16ms, 每 2 rules yield = 500 次 × 16ms = 8s 总开销
      // 但浏览器能 paint 进度 + 实时 log
      if ((r & 1) === 1 && typeof requestAnimationFrame !== 'undefined') {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }

      const meanScore = totalScore / seeds;

      results.push({
        chromosomeIdx: r,
        total: meanScore,
        score: meanScore,
        conn: bestConn?.largestSizeRatio || 0,
        components: bestConn?.components || 0,
        connected: bestConn?.connected || false,
        largestSize: bestConn?.largestSize || 0,
        totalRoads: bestConn?.totalRoads || 0,
        roadFraction: bestConn?.totalRoads ? (bestConn.totalRoads / cellsPerSeed) : 0,
        gpuTimeMs: caResult.gpuTimeMs / numRules,  // amortized per-rule
        seedScores,
        ruleJson: ruleJsons[r],
        bestGrid,           // ✅ FIX (06-28): final grid from best-scoring seed (for preview)
        bestInitGrid,       // ✅ FIX (sko 07-01): init grid (CA 演化前) for Live preview 双显
      });
    }

    return results;
  }

  destroy() {
    this.gpu.destroy();
  }
}