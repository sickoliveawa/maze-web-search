/**
 * Chromosome · 染色体接口 (sko 2026-06-27)
 *
 * 用途:
 *   编码 Rule → 用于遗传算法 / 爬山 / 模拟退火等搜索算法
 *
 * 设计原则:
 *   - 接口稳定 (decode 必须能还原 Rule)
 *   - mutate / crossover 必须返回新对象 (不可变)
 *
 * 实现:
 *   - RuleChromosome: 16 family slot 编码 (固定长)
 *   - 未来: DirectChromosome / HierarchicalChromosome / ...
 */

/**
 * 染色体接口
 *
 * 所有染色体必须实现:
 *   - encode(): 序列化为 BitArray (供 GA 用)
 *   - decode(): 反序列化为 Rule
 *   - mutate(rate): 变异, 返回新 Chromosome
 *   - crossover(other): 与 other 交叉, 返回新 Chromosome
 *
 * @typedef {Object} Chromosome
 * @property {number[]} bits - bit 数组
 * @property {function(): Rule} decode
 * @property {function(number): Chromosome} mutate
 * @property {function(Chromosome): Chromosome} crossover
 */

/**
 * BitArray · 位数组 (Uint8Array of 0/1)
 *
 * 简单实现: Uint8Array(0/1) 而不是 BigInt 位图
 * 优点: 易调试, 易 slice/concat
 * 缺点: 内存大 (1 byte per bit)
 *
 * 对于 16 family × (80+9+9+4+1) bits = 1648 bits = 206 bytes
 * Uint8Array 实现可行, 性能不是瓶颈
 */
export class BitArray {
  /**
   * @param {number} length - bit 数
   */
  constructor(length) {
    this.bits = new Uint8Array(length);
  }

  /**
   * 静态: 从字符串 "01010101..." 创建
   */
  static fromString(s) {
    const bits = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      bits[i] = s[i] === '1' ? 1 : 0;
    }
    return new BitArray(bits.length).fromBits(bits);
  }

  /**
   * 复制现有 bits
   */
  fromBits(bits) {
    this.bits = new Uint8Array(bits);
    return this;
  }

  /**
   * 长度
   */
  get length() {
    return this.bits.length;
  }

  /**
   * 取一位
   */
  get(i) {
    return this.bits[i];
  }

  /**
   * 设一位
   */
  set(i, v) {
    this.bits[i] = v ? 1 : 0;
  }

  /**
   * 翻转一位
   */
  flip(i) {
    this.bits[i] = this.bits[i] ? 0 : 1;
  }

  /**
   * 切片
   */
  slice(start, end) {
    const sub = new BitArray(end - start);
    sub.bits = this.bits.slice(start, end);
    return sub;
  }

  /**
   * 拼接
   */
  concat(other) {
    const combined = new BitArray(this.length + other.length);
    combined.bits.set(this.bits, 0);
    combined.bits.set(other.bits, this.length);
    return combined;
  }

  /**
   * 复制
   */
  clone() {
    const c = new BitArray(this.length);
    c.bits = new Uint8Array(this.bits);
    return c;
  }

  /**
   * 转字符串
   */
  toString() {
    return Array.from(this.bits).join('');
  }
}