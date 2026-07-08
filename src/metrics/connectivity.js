/**
 * connectivity.js — 路连通性 (BFS)
 *
 * 关键指标 (Rejbrand 2017 证明迷宫失败的核心):
 *   - Conway Maze (B3/S12345) 跑出来看起来像迷宫, 但 flood-fill 发现
 *     走廊高度不连通 → 不是真迷宫
 *   - 真迷宫必须路连通 (1 个连通分量)
 *
 * 返回:
 *   {
 *     connected: bool,        // 是否单分量
 *     components: number,     // 分量数
 *     largestSize: number,    // 最大分量大小
 *     largestSizeRatio: number,  // 最大分量 / 总路数 (0-1)
 *   }
 */

/**
 * 4 邻居方向 (顺时针: N, E, S, W)
 * 导出供其他 metrics 复用 (dead_ends, regions, path_finder 等)
 */
export const DIRS = [
  [0, -1],   // N
  [1, 0],    // E
  [0, 1],    // S
  [-1, 0],   // W
];

/**
 * 数路 (活) 区域的连通分量
 * @param {Grid} grid
 * @returns {{connected: bool, components: number, largestSize: number, largestSizeRatio: number}}
 */
export function roadConnectivity(grid) {
  const visited = new Uint8Array(grid.data.length);
  const sizes = [];
  const totalRoads = grid.countLive();

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const idx = grid.index(x, y);
      if (grid.data[idx] === 0 || visited[idx]) continue;

      // BFS from (x, y), 只走 4 邻居
      const size = bfsRoad(grid, x, y, visited);
      sizes.push(size);
    }
  }

  const largest = sizes.length > 0 ? Math.max(...sizes) : 0;
  return {
    connected: sizes.length === 1 && totalRoads > 0,
    components: sizes.length,
    largestSize: largest,
    largestSizeRatio: totalRoads > 0 ? largest / totalRoads : 0,
  };
}

/**
 * BFS from (x, y), 标记 visited, 返回分量大小
 */
function bfsRoad(grid, sx, sy, visited) {
  const queue = [[sx, sy]];
  visited[grid.index(sx, sy)] = 1;
  let size = 0;

  while (queue.length > 0) {
    const [x, y] = queue.shift();
    size++;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= grid.width || ny < 0 || ny >= grid.height) continue;
      const nidx = grid.index(nx, ny);
      if (grid.data[nidx] === 0 || visited[nidx]) continue;
      visited[nidx] = 1;
      queue.push([nx, ny]);
    }
  }
  return size;
}