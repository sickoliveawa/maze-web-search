/**
 * branch_entropy.js — 分支熵 (Shannon)
 *
 * 用途:
 *   每个路格子看 4 邻居活数 (0-4)
 *   统计分布, 算 Shannon 熵
 *
 * 评分:
 *   高熵 = 多分支 (理想)
 *   低熵 = 都是死端或直线 (差)
 *
 * 最大值: log2(5) ≈ 2.32 (5 个 bucket)
 */

import { DIRS } from './connectivity.js';

/**
 * 4 邻居路数 (0-4)
 */
function countRoadNeighbors(grid, x, y) {
  let n = 0;
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx >= grid.width || ny < 0 || ny >= grid.height) continue;
    if (grid.get(nx, ny) > 0) n++;
  }
  return n;
}

/**
 * 分支熵 (Shannon)
 * @returns {number} 0-2.32
 */
export function branchEntropy(grid) {
  const counts = [0, 0, 0, 0, 0];  // n=0,1,2,3,4
  let total = 0;

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (grid.get(x, y) === 0) continue;
      const n = countRoadNeighbors(grid, x, y);
      counts[n]++;
      total++;
    }
  }

  if (total === 0) return 0;

  let h = 0;
  for (const c of counts) {
    if (c > 0) {
      const p = c / total;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

/**
 * 归一化到 0-1 (除以 log2(5))
 */
export function normalizedBranchEntropy(grid) {
  return branchEntropy(grid) / Math.log2(5);
}