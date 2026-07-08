/**
 * symmetry.js — 对称性偏置
 *
 * 用途:
 *   真迷宫通常不对称 (CA 涌现的随机性)
 *   高对称 = 可能是 trivial pattern, 不是好迷宫
 *
 * 算法:
 *   4 种对称变换:
 *     - 上下镜像: (x, y) ↔ (x, H-1-y)
 *     - 左右镜像: (x, y) ↔ (W-1-x, y)
 *     - 180° 旋转: (x, y) ↔ (W-1-x, H-1-y)
 *   对每种算相关性 (相同格比例), 取平均
 *
 * 返回:
 *   0-1 (0=完全不对称, 1=完全对称)
 */

function mirrorMatch(grid, transform) {
  let same = 0, total = 0;
  const W = grid.width, H = grid.height;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [tx, ty] = transform(x, y, W, H);
      if (grid.get(x, y) === grid.get(tx, ty)) same++;
      total++;
    }
  }
  return same / total;
}

/**
 * 综合对称性偏置 (4 种对称平均)
 */
export function symmetryBias(grid) {
  const W = grid.width, H = grid.height;

  const upDown = mirrorMatch(grid, (x, y) => [x, H - 1 - y]);
  const leftRight = mirrorMatch(grid, (x, y) => [W - 1 - x, y]);
  const rotate180 = mirrorMatch(grid, (x, y) => [W - 1 - x, H - 1 - y]);
  // 对角镜像 (作为补充)
  const diagonal = mirrorMatch(grid, (x, y) => [y, x]);  // 仅当 W=H

  // 主对角镜像只在正方形有意义, 否则用 0 (中性)
  const diagScore = (W === H) ? diagonal : 0.5;

  return (upDown + leftRight + rotate180 + diagScore) / 4;
}