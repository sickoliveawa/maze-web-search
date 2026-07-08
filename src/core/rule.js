/**
 * Rule · 规则 = 多个 family + 拓扑 + 默认状态
 *
 * 关键设计 (sko 2026-06-27):
 *   - 1 个 Rule 包含 1-16 个 family
 *   - 每个 family 同时有 cells + birth + survive + priority
 *   - 判定流程: 按 priority 升序遍历 family, 第一个触发的 family 决定生死
 *   - 都不触发 → defaultState
 *
 * vs Conway v0.2:
 *   - Conway v0.2 Rule = 单一 RuleTable, 所有 family 共享一个 5x5 模板
 *   - 新 Rule 没有"共享模板"概念, 每个 family 完全独立
 *
 * 兼容 B/S 字符串:
 *   - Rule.fromBS('B3/S23') → 1 个 family (Moore 8 邻居 + birth=[3] + survive=[2,3])
 */

import { Family, MOORE_CELLS } from './family.js';
import { Topology } from './topology.js';
import { parseBS } from './bs_compat.js';

export class Rule {
  /**
   * @param {object} opts
   * @param {Family[]} opts.families - 1-16 个 family
   * @param {Topology} [opts.topology] - 默认 BOUNDED
   * @param {0|1} [opts.defaultState] - 不匹配时返回, 默认 0 (死)
   */
  constructor({ families, topology, defaultState } = {}) {
    if (!Array.isArray(families)) {
      throw new Error('Rule: families must be an array');
    }
    if (families.length === 0) {
      throw new Error('Rule: at least 1 family required');
    }
    if (families.length > 16) {
      throw new Error(`Rule: too many families ${families.length} (max 16)`);
    }
    for (const f of families) {
      if (!(f instanceof Family)) {
        throw new Error('Rule: all families must be Family instances');
      }
    }

    this.families = families;
    this.topology = topology || new Topology('bounded');
    this.defaultState = defaultState === 1 ? 1 : 0;

    // 缓存按 priority 排序的 families
    this._sortedFamilies = [...families].sort((a, b) => a.priority - b.priority);
  }

  /**
   * 按 priority 升序的 families
   */
  get sortedFamilies() {
    return this._sortedFamilies;
  }

  /**
   * 评估单个格子 (核心算法)
   *
   * 流程:
   *   1. 读 self = grid.get(x, y)
   *   2. 按 priority 升序遍历 family
   *   3. 每个 family 独立计算自己 cells 里的活邻居数 n
   *   4. self=0 检查 birth, self>0 检查 survive
   *   5. 第一个匹配的 family 决定生死
   *   6. 都不匹配 → defaultState
   */
  evaluate(grid, x, y) {
    const self = grid.get(x, y);
    for (const fam of this._sortedFamilies) {
      const n = fam.countActiveNeighbors(grid, x, y, this.topology);
      if (self === 0) {
        if (fam.birth.includes(n)) return 1;
      } else {
        if (fam.survive.includes(n)) return self;
      }
    }
    return this.defaultState;
  }

  /**
   * 活跃 family 数 (排除被禁用的)
   */
  get activeFamilyCount() {
    return this.families.length;
  }

  // ========== 工厂方法 ==========

  /**
   * B/S 字符串 → Rule (sko 2026-06-27 设计)
   *
   * ⭐ 1 个 family 就够了!
   *
   * 经典规则全部是 1 个 family:
   *   - "B3/S23" → Conway Life
   *   - "B3/S12345" → Conway Maze
   *   - "B2/S123" → Rejbrand 推荐
   *   - "B36/S23" → HighLife (set 精确表达 B36 不连续)
   *
   * 不用拆成 birth-only + survive-only 两个 family (sko 修正)
   */
  static fromBS(bs, opts = {}) {
    const { birth, survive } = parseBS(bs);

    // Moore 8 邻居
    const family = new Family({
      id: 'bs_main',
      name: `${bs} (Moore)`,
      priority: 1,
      cells: MOORE_CELLS,
      birth,
      survive,
    });

    return new Rule({
      families: [family],
      topology: opts.topology || new Topology('bounded'),
      defaultState: opts.defaultState !== undefined ? opts.defaultState : 0,
    });
  }

  /**
   * 随机 Rule (Phase 1 测试用, 简单版本)
   * - 1 个 family, Moore 8 邻居
   * - 随机 birth/survive set
   * Phase 7 GA 会用 RuleChromosome.encode/decode 替代
   *
   * @param {SeededRandom} rng
   */
  static random(rng) {
    // 随机选 birth set (从 [0..8] 中选 1-3 个数)
    const birthCount = 1 + rng.nextInt(3);
    const birth = [];
    while (birth.length < birthCount) {
      const n = rng.nextInt(9);
      if (!birth.includes(n)) birth.push(n);
    }

    // 随机选 survive set
    const surviveCount = 1 + rng.nextInt(4);
    const survive = [];
    while (survive.length < surviveCount) {
      const n = rng.nextInt(9);
      if (!survive.includes(n)) survive.push(n);
    }

    const family = new Family({
      id: 'random_bs',
      name: 'random B/S',
      priority: 1,
      cells: MOORE_CELLS,
      birth,
      survive,
    });

    return new Rule({ families: [family], topology: new Topology('bounded'), defaultState: 0 });
  }

  /**
   * 序列化
   */
  toJSON() {
    return {
      version: '1.0',
      defaultState: this.defaultState,
      topology: this.topology.type,
      families: this.families.map(f => f.toJSON()),
    };
  }

  /**
   * 反序列化
   */
  static fromJSON(obj) {
    return new Rule({
      defaultState: obj.defaultState,
      topology: new Topology(obj.topology),
      families: obj.families.map(f => Family.fromJSON(f)),
    });
  }
}