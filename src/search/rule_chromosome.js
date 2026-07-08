/**
 * RuleChromosome · Rule 的定长染色体编码 (Phase 7)
 *
 * 编码 (固定 16 family slot):
 *   每个 slot:
 *     - active: 1 bit (是否启用)
 *     - cells: 80 bits (5x5 中心外的 80 格 mask, 默认 9x9 = 80)
 *     - birth: 9 bits (B0-B8 set 表达)
 *     - survive: 9 bits (S0-S8 set 表达)
 *     - priority: 4 bits (1-16)
 *   共 103 bits × 16 slots = 1648 bits
 *
 * 关键设计:
 *   - 16 slot 固定, 可启用 0-16 个 family
 *   - cells mask 9x9 默认 (80 bits), 实际常用 5x5 (24 bits) 集中在 mask 中心
 *   - 未来可扩展到任意 cells 列表 (变长编码)
 *
 * 跟 Conway v0.2 chromosome 对比:
 *   - Conway v0.2: 28 元素 (4 个数值 + 24 bit mask), 用于 5x5 对称规则搜索
 *   - 新 RuleChromosome: 1648 bits, 用于真正的"广义族类"搜索
 */

import { BitArray } from './chromosome.js';
import { Family, MOORE_CELLS } from '../core/family.js';
import { Rule } from '../core/rule.js';
import { Topology } from '../core/topology.js';
import { SeededRandom } from '../core/random.js';

/**
 * cellInRange — 检查 (dx, dy) 是否在 cellMaskType 范围内
 *   跟 src/gpu/gpu_scorer.js:43-49 的 cellInRange 完全等价
 *   用途: 跟 train path (gpu_scorer.decodeChromosome) 的 cellInRange filter 一致
 *     否则 preview path 会解出 out-of-range cells (e.g. manhattan-1 下 push (2,0)),
 *     BatchedGPUEngine.encodeRules 会把 out-of-range cells 编到 cellsMask,
 *     GPU shader 误用 → attractor 错
 */
function cellInRange(dx, dy, type) {
  if (!type) return true;
  if (type === 'chebyshev-1') return Math.max(Math.abs(dx), Math.abs(dy)) <= 1;
  if (type === 'chebyshev-2') return Math.max(Math.abs(dx), Math.abs(dy)) <= 2;
  if (type === 'chebyshev-3') return Math.max(Math.abs(dx), Math.abs(dy)) <= 3;
  if (type === 'chebyshev-4') return Math.max(Math.abs(dx), Math.abs(dy)) <= 4;
  if (type === 'manhattan-1') return Math.abs(dx) + Math.abs(dy) <= 1;
  if (type === 'manhattan-2') return Math.abs(dx) + Math.abs(dy) <= 2;
  if (type === 'manhattan-3') return Math.abs(dx) + Math.abs(dy) <= 3;
  if (type === 'manhattan-4') return Math.abs(dx) + Math.abs(dy) <= 4;
  return true;
}

/**
 * 染色体参数
 */
export const CHROM_PARAMS = {
  MAX_DX: 4,           // 9x9 cells mask (中心 ±4)
  MAX_DY: 4,
  MAX_CELLS: 9 * 9 - 1,  // 80 cells (中心外)
  MAX_BIRTH: 9,         // B0-B8 = 9 bits
  MAX_SURVIVE: 9,       // S0-S8 = 9 bits
  PRIORITY_BITS: 4,     // priority 1-16
  ACTIVE_BITS: 1,       // active flag
  MAX_FAMILIES: 16,
};

/**
 * bits per slot
 */
const SLOT_BITS =
  CHROM_PARAMS.ACTIVE_BITS +
  CHROM_PARAMS.MAX_CELLS +
  CHROM_PARAMS.MAX_BIRTH +
  CHROM_PARAMS.MAX_SURVIVE +
  CHROM_PARAMS.PRIORITY_BITS;
// = 1 + 80 + 9 + 9 + 4 = 103

const TOTAL_BITS = SLOT_BITS * CHROM_PARAMS.MAX_FAMILIES;
// = 103 * 16 = 1648 bits

/**
 * slot 内部布局 (LSB → MSB):
 *   [0..0]                  active (1 bit)
 *   [1..80]                 cells mask (80 bits)
 *   [81..89]                birth (9 bits)
 *   [90..98]                survive (9 bits)
 *   [99..102]               priority (4 bits)
 */
const ACTIVE_OFFSET = 0;
const CELLS_OFFSET = 1;
const BIRTH_OFFSET = 1 + CHROM_PARAMS.MAX_CELLS;       // 81
const SURVIVE_OFFSET = BIRTH_OFFSET + CHROM_PARAMS.MAX_BIRTH;  // 90
const PRIORITY_OFFSET = SURVIVE_OFFSET + CHROM_PARAMS.MAX_SURVIVE; // 99

export class RuleChromosome {
  /**
   * @param {BitArray} bits - 1648 bit 数组
   */
  constructor(bits) {
    if (!(bits instanceof BitArray)) {
      throw new Error('RuleChromosome: bits must be BitArray');
    }
    if (bits.length !== TOTAL_BITS) {
      throw new Error(`RuleChromosome: bits length ${bits.length} != ${TOTAL_BITS}`);
    }
    this.bits = bits;
  }

  /**
     * 静态: 从 Rule 编码
     */
    static fromRule(rule) {
      const bits = new BitArray(TOTAL_BITS);
      const families = rule.families;

      for (let i = 0; i < CHROM_PARAMS.MAX_FAMILIES; i++) {
        const slot = i * SLOT_BITS;
        if (i < families.length) {
          const fam = families[i];
          // active = 1
          bits.set(slot + ACTIVE_OFFSET, 1);

          // cells mask
          const cellsSet = new Set(fam.cells.map(({ dx, dy }) => `${dx},${dy}`));
          let cellBit = 0;
          for (let dy = -CHROM_PARAMS.MAX_DY; dy <= CHROM_PARAMS.MAX_DY; dy++) {
            for (let dx = -CHROM_PARAMS.MAX_DX; dx <= CHROM_PARAMS.MAX_DX; dx++) {
              if (dx === 0 && dy === 0) continue;  // 跳过中心
              if (cellsSet.has(`${dx},${dy}`)) {
                bits.set(slot + CELLS_OFFSET + cellBit, 1);
              }
              cellBit++;
            }
          }

          // birth bits
          for (const n of fam.birth) {
            if (n >= 0 && n < CHROM_PARAMS.MAX_BIRTH) {
              bits.set(slot + BIRTH_OFFSET + n, 1);
            }
          }

          // survive bits
          for (const n of fam.survive) {
            if (n >= 0 && n < CHROM_PARAMS.MAX_SURVIVE) {
              bits.set(slot + SURVIVE_OFFSET + n, 1);
            }
          }

          // priority (4 bit)
          const pri = Math.max(1, Math.min(16, fam.priority));
          for (let p = 0; p < CHROM_PARAMS.PRIORITY_BITS; p++) {
            bits.set(slot + PRIORITY_OFFSET + p, (pri >> p) & 1);
          }
        } else {
          // 闲置 slot, active=0
          bits.set(slot + ACTIVE_OFFSET, 0);
        }
      }

      return new RuleChromosome(bits);
    }

    /**
     * 修正 decode: 如果没有 active family, 抛错前先尝试激活第一个 slot
     *
     * 安全修复 (sko 2026-06-27): 变异可能导致所有 family 都 inactive
     * → 在 evaluateRule 前自动修复 (强制激活 slot 0)
     */
    _ensureActive() {
      let hasActive = false;
      for (let i = 0; i < CHROM_PARAMS.MAX_FAMILIES; i++) {
        const slot = i * SLOT_BITS;
        if (this.bits.get(slot + ACTIVE_OFFSET) === 1) {
          hasActive = true;
          break;
        }
      }
      if (!hasActive) {
        // 强制激活 slot 0
        this.bits.set(0 + ACTIVE_OFFSET, 1);
        // 给个简单的 birth/survive
        this.bits.set(0 + BIRTH_OFFSET + 3, 1);  // birth[3]
        this.bits.set(0 + SURVIVE_OFFSET + 2, 1);  // survive[2]
        this.bits.set(0 + SURVIVE_OFFSET + 3, 1);  // survive[3]
      }
      return this;
    }

  /**
   * 随机染色体 (sko 决定 Phase 7 后)
   */
  static random(rng) {
    const bits = new BitArray(TOTAL_BITS);

    // 随机启用 1-4 个 family
    const numActive = 1 + rng.nextInt(4);
    const activeSlots = new Set();
    while (activeSlots.size < numActive) {
      activeSlots.add(rng.nextInt(CHROM_PARAMS.MAX_FAMILIES));
    }

    for (let i = 0; i < CHROM_PARAMS.MAX_FAMILIES; i++) {
      const slot = i * SLOT_BITS;
      const isActive = activeSlots.has(i);
      bits.set(slot + ACTIVE_OFFSET, isActive ? 1 : 0);

      if (isActive) {
        // 随机 cells: 30% 概率置 1
        for (let b = 0; b < CHROM_PARAMS.MAX_CELLS; b++) {
          bits.set(slot + CELLS_OFFSET + b, rng.nextFloat() < 0.3 ? 1 : 0);
        }
        // 随机 birth (1-3 个)
        const birthCount = 1 + rng.nextInt(3);
        for (let b = 0; b < birthCount; b++) {
          const n = rng.nextInt(CHROM_PARAMS.MAX_BIRTH);
          bits.set(slot + BIRTH_OFFSET + n, 1);
        }
        // 随机 survive (1-4 个)
        const survCount = 1 + rng.nextInt(4);
        for (let b = 0; b < survCount; b++) {
          const n = rng.nextInt(CHROM_PARAMS.MAX_SURVIVE);
          bits.set(slot + SURVIVE_OFFSET + n, 1);
        }
        // 随机 priority 1-16
        const pri = 1 + rng.nextInt(16);
        for (let p = 0; p < CHROM_PARAMS.PRIORITY_BITS; p++) {
          bits.set(slot + PRIORITY_OFFSET + p, (pri >> p) & 1);
        }
      }
    }

    return new RuleChromosome(bits);
  }

  /**
   * 从 B/S 字符串编码 (1 family, Moore 8 邻居)
   */
  static fromBS(bs) {
    return RuleChromosome.fromRule(Rule.fromBS(bs));
  }

  /**
   * 解码为 Rule
   *
   * @param {string} [cellMaskType] - 'manhattan-1..4' / 'chebyshev-1..4' / undefined
   *   跟 train path (gpu_scorer.decodeChromosome) 的 cellInRange filter 一致
   *   undefined = 不过滤 (旧行为, 兼容 backward)
   *
   * 安全: 如果没有 active family, 自动修复 (激活 slot 0 with 默认 B/S)
   * 这避免了变异产生"空规则"的 crash
   */
  decode(cellMaskType) {
    this._ensureActive();

    const families = [];

    for (let i = 0; i < CHROM_PARAMS.MAX_FAMILIES; i++) {
      const slot = i * SLOT_BITS;
      if (this.bits.get(slot + ACTIVE_OFFSET) === 0) continue;

      // 解码 cells
      const cells = [];
      let cellBit = 0;
      for (let dy = -CHROM_PARAMS.MAX_DY; dy <= CHROM_PARAMS.MAX_DY; dy++) {
        for (let dx = -CHROM_PARAMS.MAX_DX; dx <= CHROM_PARAMS.MAX_DX; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (this.bits.get(slot + CELLS_OFFSET + cellBit) === 1
              && cellInRange(dx, dy, cellMaskType)) {  // ✅ FIX (sko 07-08): filter out-of-range cells
            cells.push({ dx, dy });
          }
          cellBit++;
        }
      }

      // 解码 birth
      const birth = [];
      for (let n = 0; n < CHROM_PARAMS.MAX_BIRTH; n++) {
        if (this.bits.get(slot + BIRTH_OFFSET + n) === 1) birth.push(n);
      }

      // 解码 survive
      const survive = [];
      for (let n = 0; n < CHROM_PARAMS.MAX_SURVIVE; n++) {
        if (this.bits.get(slot + SURVIVE_OFFSET + n) === 1) survive.push(n);
      }

      // 解码 priority
      let priority = 0;
      for (let p = 0; p < CHROM_PARAMS.PRIORITY_BITS; p++) {
        priority |= (this.bits.get(slot + PRIORITY_OFFSET + p) << p);
      }
      priority = Math.max(1, Math.min(16, priority || 1));

      families.push(new Family({
        id: `fam_${i}`,
        name: `family_${i}`,
        priority,
        cells,
        birth,
        survive,
      }));
    }

    if (families.length === 0) {
      throw new Error('RuleChromosome.decode: no active families');
    }

    return new Rule({
      families,
      topology: new Topology('bounded'),
      defaultState: 0,
    });
  }

  /**
   * 变异 (翻转一定比例的 bits, rate=0.05 默认)
   * 返回新 Chromosome (不可变)
   */
  mutate(rate = 0.05, rng = new SeededRandom(0)) {
    const newBits = this.bits.clone();
    for (let i = 0; i < TOTAL_BITS; i++) {
      if (rng.nextFloat() < rate) {
        newBits.flip(i);
      }
    }
    return new RuleChromosome(newBits);
  }

  /**
   * 单点交叉 (uniform crossover)
   * 返回新 Chromosome (不可变)
   */
  crossover(other, rng = new SeededRandom(0)) {
    const newBits = new BitArray(TOTAL_BITS);
    for (let i = 0; i < TOTAL_BITS; i++) {
      // 50% 概率选 self, 50% 选 other
      const source = rng.nextBool() ? this.bits : other.bits;
      newBits.set(i, source.get(i));
    }
    return new RuleChromosome(newBits);
  }

  /**
   * 序列化为对象 (用于 JSON)
   */
  toJSON() {
    return { bits: this.bits.toString() };
  }

  /**
   * 反序列化
   */
  static fromJSON(obj) {
    return new RuleChromosome(BitArray.fromString(obj.bits));
  }
}

/**
 * 导出常量
 */
export const TOTAL_CHROM_BITS = TOTAL_BITS;