/**
 * Topology · 拓扑 (BOUNDED / TOROIDAL)
 *
 * 决定边界格子的邻居如何处理:
 *   - BOUNDED: 边界外不算邻居 (Conway 默认, Wikipedia scipython 用)
 *   - TOROIDAL: 边界环绕 (类似经度)
 *
 * 为什么重要:
 *   - 跑 CA 涌现迷宫时, 边界"半截走廊"是常见情况
 *   - BOUNDED + 中央随机 patch 是经典 baseline (B3/S12345 论文用)
 *   - 评分函数必须知道用了哪种拓扑才能正确计算连通性等
 */

export class Topology {
  /**
   * @param {'bounded'|'toroidal'} type
   */
  constructor(type = 'bounded') {
    if (type !== 'bounded' && type !== 'toroidal') {
      throw new Error(`Topology: invalid type "${type}"`);
    }
    this.type = type;
  }

  /**
   * 包装 (x, y) → 有效坐标
   * BOUNDED: 不变 (inBounds 检查)
   * TOROIDAL: mod width/height
   */
  wrap(x, y) {
    if (this.type === 'toroidal') {
      // 调用方需提供 width/height, 但 wrap 本身不知道
      // 所以这里返回原坐标, inBounds 决定越界
      return [x, y];
    }
    return [x, y];
  }

  /**
   * TOROIDAL wrap (需要 width/height)
   */
  wrapToroidal(x, y, width, height) {
    if (this.type !== 'toroidal') return [x, y];
    return [((x % width) + width) % width, ((y % height) + height) % height];
  }

  /**
   * 判断 (x, y) 是否在网格内
   * BOUNDED: 0 <= x < width && 0 <= y < height
   * TOROIDAL: 永远 true (因为 wrap 已经处理)
   */
  inBounds(x, y, width, height) {
    if (this.type === 'bounded') {
      return x >= 0 && x < width && y >= 0 && y < height;
    }
    return true;  // toroidal always in bounds (after wrap)
  }
}