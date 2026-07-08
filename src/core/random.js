/**
 * SeededRandom · 种子化伪随机数生成器 (mulberry32)
 *
 * 用途: 32 seed 评估必须可重现 —— 同一 seed 跑多次必须得到相同的迷宫
 * 算法: mulberry32 (32-bit state, 2^32 周期, 速度够快)
 *
 * 引用: https://stackoverflow.com/a/47593316 (mulberry32 reference)
 */

export class SeededRandom {
  /**
   * @param {number} seed - 32-bit 整数种子 (0 - 2^32)
   */
  constructor(seed) {
    this.state = seed >>> 0;  // 强制转 uint32
  }

  /**
   * 生成下一个 32-bit 整数 [0, 2^32)
   */
  next() {
    let t = (this.state = (this.state + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  }

  /**
   * 生成 [0, 1) 浮点数
   */
  nextFloat() {
    return this.next() / 0x100000000;  // / 2^32
  }

  /**
   * 生成 [0, max) 整数
   */
  nextInt(max) {
    return Math.floor(this.nextFloat() * max);
  }

  /**
   * Bernoulli 试验: 以 p 概率返回 true
   * @param {number} p - 概率 [0, 1]
   */
  nextBool(p = 0.5) {
    return this.nextFloat() < p;
  }

  /**
   * 从数组中随机选一个元素
   */
  pick(arr) {
    return arr[this.nextInt(arr.length)];
  }
}

/**
 * 工厂: 用给定 seed 创建 RNG
 */
export function makeRng(seed) {
  return new SeededRandom(seed);
}