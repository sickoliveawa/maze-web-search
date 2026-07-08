/**
 * Grid · 网格 (Uint8Array)
 *
 * Conway v0.2 grid 经验:
 *   - Uint8Array(0/1) 比 Set<number> 快 100x, 内存省 50x
 *   - 双缓冲 step() 不修改原 grid, 返回新 grid (避免副作用)
 *
 * 这里增强:
 *   - clone() 快速复制
 *   - 中央随机 patch (Wikipedia scipython baseline 用)
 *   - 全随机 (其他用途)
 *   - toJSON/fromJSON (持久化)
 */

import { SeededRandom } from './random.js';

export class Grid {
  /**
   * @param {number} width
   * @param {number} height
   * @param {Uint8Array|number} [dataOrDefault=0] - 已有数据 或 默认值
   */
  constructor(width, height, dataOrDefault = 0) {
    if (!Number.isInteger(width) || width <= 0) {
      throw new Error(`Grid: invalid width ${width}`);
    }
    if (!Number.isInteger(height) || height <= 0) {
      throw new Error(`Grid: invalid height ${height}`);
    }
    this.width = width;
    this.height = height;

    if (dataOrDefault instanceof Uint8Array) {
      if (dataOrDefault.length !== width * height) {
        throw new Error(`Grid: data length ${dataOrDefault.length} != ${width * height}`);
      }
      this.data = new Uint8Array(dataOrDefault);  // 复制避免共享
    } else {
      this.data = new Uint8Array(width * height);
      if (dataOrDefault !== 0) {
        this.data.fill(dataOrDefault);
      }
    }
  }

  /**
   * 索引: (x, y) → array index
   * 内存布局: row-major (y * width + x)
   */
  index(x, y) {
    return y * this.width + x;
  }

  /**
   * 读 (x, y)
   */
  get(x, y) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return 0;  // 边界外默认 0
    }
    return this.data[this.index(x, y)];
  }

  /**
   * 写 (x, y) = v (越界忽略)
   */
  set(x, y, v) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.data[this.index(x, y)] = v;
  }

  /**
   * 全填
   */
  fill(v) {
    this.data.fill(v);
  }

  /**
   * 统计活细胞数
   */
  countLive() {
    let c = 0;
    for (let i = 0; i < this.data.length; i++) {
      if (this.data[i] > 0) c++;
    }
    return c;
  }

  /**
   * 克隆 (深拷贝)
   */
  clone() {
    return new Grid(this.width, this.height, new Uint8Array(this.data));
  }

  /**
   * 序列化
   */
  toJSON() {
    return {
      version: '1.0',
      width: this.width,
      height: this.height,
      data: Array.from(this.data),  // Uint8Array → 普通数组
    };
  }

  /**
   * 反序列化
   */
  static fromJSON(obj) {
    return new Grid(obj.width, obj.height, new Uint8Array(obj.data));
  }

  // ========== 工厂方法 ==========

  /**
   * 全随机 grid (Bernoulli, density = 活细胞比例)
   * @param {number} width
   * @param {number} height
   * @param {number} density - [0, 1]
   * @param {SeededRandom} rng
   */
  static random(width, height, density, rng) {
    const g = new Grid(width, height);
    for (let i = 0; i < g.data.length; i++) {
      if (rng.nextFloat() < density) g.data[i] = 1;
    }
    return g;
  }

  /**
   * 中央随机 patch (Wikipedia scipython baseline)
   * 初始化: 中央 patchSize x patchSize 区域随机 (density=0.25), 周围全死
   * @param {number} width
   * @param {number} height
   * @param {number} patchSize - 中央 patch 边长 (偶数)
   * @param {SeededRandom} rng
   */
  static patch(width, height, patchSize, rng) {
    const g = new Grid(width, height, 0);  // 全死
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    const half = Math.floor(patchSize / 2);
    for (let y = cy - half; y < cy - half + patchSize; y++) {
      for (let x = cx - half; x < cx - half + patchSize; x++) {
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        if (rng.nextFloat() < 0.25) g.set(x, y, 1);  // 25% 密度 (scipython 用 0.25 ≈ 0.75 死)
      }
    }
    return g;
  }

  /**
   * 从 cells 列表构造 (用于测试 / preset)
   * @param {number} width
   * @param {number} height
   * @param {Array<[x, y]>} liveCells
   */
  static fromCells(width, height, liveCells) {
    const g = new Grid(width, height, 0);
    for (const [x, y] of liveCells) g.set(x, y, 1);
    return g;
  }
}