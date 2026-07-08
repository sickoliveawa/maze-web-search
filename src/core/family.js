/**
 * Family · 族 (真正广义的族类规则系统, sko 2026-06-27 设计)
 *
 * 一个 Family = 一组相对当前位置的格子 + 一组 birth 阈值 + 一组 survive 阈值 + 优先级
 *
 * 关键设计 (sko 修正):
 *   - 1 个 family 同时有 birth 和 survive (通过 self 状态分支判定)
 *   - 不再拆成 birth-only + survive-only 两个 family
 *   - 不同 family 有不同 cells 形状 → 每个 family 独立计算自己的 n
 *
 * vs Conway v0.2:
 *   - Conway v0.2 所有 family 共享一个 5x5 模板 + mask
 *   - 新设计每个 family 独立定义 cells 列表
 *
 * 例子:
 *   - 经典 Conway B3/S23 = 1 family:
 *     cells = Moore 8 邻居, birth = [3], survive = [2, 3]
 *   - 不对称规则 = 多个 family, 每个完全不同 cells 形状
 *
 * 染色体编码 (Phase 7):
 *   - cells: 80 bit mask (9x9 中心外的 80 个位置)
 *   - birth: 9 bit mask (B0-B8)
 *   - survive: 9 bit mask (S0-S8)
 *   - priority: 4 bit (1-16)
 *   - active: 1 bit
 */

import { Topology } from './topology.js';

/**
 * 标准 Moore 8 邻居 cells (5x5 中心外的 8 格, 中心 dx=0,dy=0 跳过)
 * B/S 字符串 baseline 用这个
 */
export const MOORE_CELLS = [
  { dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
  { dx: -1, dy:  0 },                   { dx: 1, dy:  0 },
  { dx: -1, dy:  1 }, { dx: 0, dy:  1 }, { dx: 1, dy:  1 },
];

export class Family {
  /**
   * @param {object} opts
   * @param {string} [opts.id]
   * @param {string} [opts.name]
   * @param {number} opts.priority - 1-16, 小=高优先级
   * @param {Array<{dx, dy}>} opts.cells - 任意相对位置列表
   * @param {number[]} opts.birth - set 表达 (如 [3] 或 [3, 6])
   * @param {number[]} opts.survive - set 表达 (如 [2, 3] 或 [1, 2, 3, 4, 5])
   */
  constructor({ id, name, priority, cells, birth, survive } = {}) {
    if (priority === undefined || priority === null) {
      throw new Error('Family: priority required');
    }
    if (!Number.isInteger(priority) || priority < 1 || priority > 16) {
      throw new Error(`Family: invalid priority ${priority} (must be 1-16)`);
    }
    if (!Array.isArray(cells)) {
      throw new Error('Family: cells must be an array');
    }
    if (!Array.isArray(birth) || !Array.isArray(survive)) {
      throw new Error('Family: birth and survive must be arrays');
    }
    // birth/survive 元素必须 0-8 (因为 cells mask 默认 9x9 = 80 cells, 最大 n=80, 但实际很少 > 8)
    // 实际上 birth/survive 可以是任意 0-N 的数, 不强制 0-8
    for (const n of birth) {
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`Family: invalid birth value ${n}`);
      }
    }
    for (const n of survive) {
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`Family: invalid survive value ${n}`);
      }
    }

    this.id = id || `family_${Math.random().toString(36).slice(2, 9)}`;
    this.name = name || 'unnamed';
    this.priority = priority;
    this.cells = cells;  // 浅拷: 调用方可修改原数组
    this.birth = birth;
    this.survive = survive;
  }

  /**
   * 计算 family 在 (cx, cy) 位置 cells 里的活邻居数
   * @param {Grid} grid
   * @param {number} cx
   * @param {number} cy
   * @param {Topology} topology
   * @returns {number} 活邻居数
   */
  countActiveNeighbors(grid, cx, cy, topology) {
    let count = 0;
    for (const { dx, dy } of this.cells) {
      let nx = cx + dx;
      let ny = cy + dy;

      // BOUNDED: 越界跳过; TOROIDAL: wrap
      if (topology.type === 'toroidal') {
        [nx, ny] = topology.wrapToroidal(nx, ny, grid.width, grid.height);
      } else {
        if (!topology.inBounds(nx, ny, grid.width, grid.height)) continue;
      }

      if (grid.get(nx, ny) > 0) count++;
    }
    return count;
  }

  /**
   * 评估单个格子 (返回 0 或 1)
   *
   * 判定流程:
   *   - self=0 (死) → 检查 birth set, n ∈ birth → 出生 (return 1)
   *   - self>0 (活) → 检查 survive set, n ∈ survive → 存活 (return 1)
   *   - 否则 → 不触发 (return 0)
   *
   * 注意: 这个函数只判断"这个 family 是否触发", 不判断"最终生死"
   * 最终生死由 Rule.evaluate() 按 priority 遍历多个 family 后决定
   *
   * @param {Grid} grid
   * @param {number} x
   * @param {number} y
   * @param {Topology} topology
   * @returns {0|1}
   */
  evaluate(grid, x, y, topology) {
    const self = grid.get(x, y);
    const n = this.countActiveNeighbors(grid, x, y, topology);

    if (self === 0) {
      // 死细胞: 检查 birth
      return this.birth.includes(n) ? 1 : 0;
    } else {
      // 活细胞: 检查 survive
      return this.survive.includes(n) ? 1 : 0;
    }
  }

  /**
   * 序列化
   */
  toJSON() {
    return {
      version: '1.0',
      id: this.id,
      name: this.name,
      priority: this.priority,
      cells: this.cells.map(({ dx, dy }) => ({ dx, dy })),
      birth: [...this.birth],
      survive: [...this.survive],
    };
  }

  /**
   * 反序列化
   */
  static fromJSON(obj) {
    return new Family({
      id: obj.id,
      name: obj.name,
      priority: obj.priority,
      cells: obj.cells.map(({ dx, dy }) => ({ dx, dy })),
      birth: [...obj.birth],
      survive: [...obj.survive],
    });
  }
}