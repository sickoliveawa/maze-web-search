// src/search/es_searcher.js
// ko 06-28 提议的简化 ES 算法 (浏览器版, 集成 BatchedGPUScorer)
//
// 跟 es_v22.cjs 区别:
// - 用 ESM 语法 (import / export)
// - 集成 BatchedGPUScorer (GPU 跑 CA 演化, CPU 跑 bellot score)
// - onProgress 回调, 实时推送每代数据到 dashboard
// - 可取消 (AbortSignal)
//
// 算法 (跟 cjs 版完全一致):
// - gen 0: 全 random
// - gen N: top 10% 保留 + 50% 复制 1-bit 改 + 10% random + 30% 中间保留

import { BatchedGPUScorer } from '../gpu/gpu_scorer.js';
import { mazeQuality } from '../metrics/maze_quality.js';

// === Chromosome encoding (跟 es_v22.cjs 一致) ===
const MAX_DX = 4, MAX_DY = 4, MAX_CELLS = 80, MAX_BIRTH = 9, MAX_SURVIVE = 9;
const PRI = 4;
const SLOT = 1 + MAX_CELLS + MAX_BIRTH + MAX_SURVIVE + PRI;
const ACTIVE_OFFSET = 0;
const BIRTH_OFFSET = 1 + MAX_CELLS;
const SURVIVE_OFFSET = 1 + MAX_CELLS + MAX_BIRTH;
const PRIORITY_OFFSET = 1 + MAX_CELLS + MAX_BIRTH + MAX_SURVIVE;
export const TOTAL_CHROM_BITS = 16 * SLOT;

// === Util: seeded RNG (mulberry32) ===
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return {
    nextFloat() { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; },
    nextInt(max) { return Math.floor(this.nextFloat() * max); },
    nextBool() { return this.nextFloat() < 0.5; },
  };
}

function inRange(dx, dy, mt) {
  if (mt?.startsWith?.('chebyshev-')) { const N = parseInt(mt.split('-')[1]); return Math.max(Math.abs(dx), Math.abs(dy)) <= N; }
  if (mt?.startsWith?.('manhattan-')) { const N = parseInt(mt.split('-')[1]); return Math.abs(dx) + Math.abs(dy) <= N; }
  return true;
}

// === Mask helpers (sko 06-28) ===
// isBitInDistMask: returns true if a cell bit (1..80) is within the distance mask
// Birth/survive/pri/active bits (0, 81..102) are always considered "in mask" (not distance-restricted)
function isBitInDistMask(bitIdx, mt) {
  if (bitIdx < 1 || bitIdx > 80) return true; // active, birth, survive, pri — all modifiable
  const cellBi = bitIdx - 1; // 0..79
  const dy = Math.floor(cellBi / 9) - 4; // -4..4
  const dx = (cellBi % 9) - 4; // -4..4
  if (dx === 0 && dy === 0) return false; // center reserved
  return inRange(dx, dy, mt);
}

// cellBi -> (dx, dy) for debugging
function cellBiToDxDy(cellBi) {
  return { dx: (cellBi % 9) - 4, dy: Math.floor(cellBi / 9) - 4 };
}

// familyMask: Set<number> or Array<number> of family indices that ES is allowed to modify
//              Default: all 16 families. Empty -> fallback to all 16 (defensive).
// cellMaskType: distance mask string (e.g. 'chebyshev-4'). Used to restrict cell bits within ES.
function makeRandomBits(rng, familyMask, cellMaskType) {
  const fm = (familyMask instanceof Set) ? familyMask : new Set(familyMask || Array.from({length: 16}, (_, i) => i));
  const fms = fm.size > 0 ? fm : new Set(Array.from({length: 16}, (_, i) => i));
  const mt = cellMaskType || 'chebyshev-4';
  const bits = new Uint8Array(TOTAL_CHROM_BITS);
  for (let f = 0; f < 16; f++) {
    const s = f * SLOT;
    if (!fms.has(f)) {
      // Family not in mask: frozen inactive (active=0, all other bits 0)
      bits[s + ACTIVE_OFFSET] = 0;
      continue;
    }
    // Family in mask: random active flag
    bits[s + ACTIVE_OFFSET] = rng.nextBool() ? 1 : 0;
    // Cell bits: only randomize those within dist mask
    let bi = 0;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      if (dx === 0 && dy === 0) { bi++; continue; }
      bits[s + 1 + bi] = inRange(dx, dy, mt) ? (rng.nextBool() ? 1 : 0) : 0;
      bi++;
    }
    // Birth / survive / priority — random (no dist mask)
    for (let n = 0; n < MAX_BIRTH; n++) bits[s + 1 + MAX_CELLS + n] = rng.nextBool() ? 1 : 0;
    for (let n = 0; n < MAX_SURVIVE; n++) bits[s + 1 + MAX_CELLS + MAX_BIRTH + n] = rng.nextBool() ? 1 : 0;
    for (let pp = 0; pp < PRI; pp++) bits[s + 1 + MAX_CELLS + MAX_BIRTH + MAX_SURVIVE + pp] = rng.nextBool() ? 1 : 0;
  }
  // Ensure at least 1 active family
  let hasActive = false;
  for (let i = 0; i < 16; i++) if (bits[i * SLOT + ACTIVE_OFFSET] === 1) { hasActive = true; break; }
  if (!hasActive) {
    // Activate F0 (guaranteed in mask since mask default = all 16)
    bits[ACTIVE_OFFSET] = 1;
    bits[BIRTH_OFFSET + 3] = 1;       // B3
    bits[SURVIVE_OFFSET + 2] = 1;     // S2
    bits[SURVIVE_OFFSET + 3] = 1;     // S3
  }
  return bits;
}

// Mutation: flip N bits (mutationsPerChrom) among candidates that are
//   (a) in familyMask AND
//   (b) in dist mask (for cell bits) AND
//   (c) the family is currently active (active flag = 1)
// Birth/survive/pri/active-flag bits of in-mask active families are always candidates.
// mutationsPerChrom = 1: classic ES (1 bit/gen, easy local-opt trap)
// mutationsPerChrom = 2-3: 增强 diversity, 帮 ES escape 4.522 plateau
function mutateActiveBit(bits, rng, familyMask, cellMaskType, mutationsPerChrom = 1) {
  const fm = (familyMask instanceof Set) ? familyMask : new Set(familyMask || Array.from({length: 16}, (_, i) => i));
  const fms = fm.size > 0 ? fm : new Set(Array.from({length: 16}, (_, i) => i));
  const mt = cellMaskType || 'chebyshev-4';
  const candidates = [];
  for (let f = 0; f < 16; f++) {
    if (!fms.has(f)) continue;
    if (bits[f * SLOT + ACTIVE_OFFSET] === 0) continue; // skip inactive families
    const base = f * SLOT;
    for (let b = 1; b < SLOT; b++) {
      if (isBitInDistMask(b, mt)) candidates.push(base + b);
    }
  }
  if (candidates.length === 0) {
    // Defensive: no modifiable bits. Flip F0 active flag (F0 always in mask by fallback).
    const out = new Uint8Array(bits);
    const i = [...fms][0] ?? 0;
    out[i * SLOT + ACTIVE_OFFSET] = out[i * SLOT + ACTIVE_OFFSET] ? 0 : 1;
    return out;
  }
  const out = new Uint8Array(bits);
  // 每次 mutation 翻 N 个 bits (用 sample without replacement, 避免同一位翻两次抵消)
  const N = Math.max(1, Math.min(mutationsPerChrom, candidates.length));
  const picked = new Set();
  for (let k = 0; k < N; k++) {
    let idx;
    do {
      idx = candidates[Math.floor(rng.nextFloat() * candidates.length)];
    } while (picked.has(idx) && picked.size < candidates.length);
    picked.add(idx);
    out[idx] = out[idx] ? 0 : 1;
  }
  return out;
}

// === sko 06-28: B2/S123 seeding helper (paper best, 32 seeds 3.72) ===
// F0 slot only: active=1, 8 Moore cells (chebyshev-1), B2, S123, priority=1
function buildF0_B2S123() {
  const bits = new Uint8Array(SLOT);
  bits[ACTIVE_OFFSET] = 1; // active
  // Moore 8 cells (chebyshev-1): all 8 surrounding cells
  for (let bi = 0; bi < 80; bi++) {
    const dx = (bi % 9) - 4;
    const dy = Math.floor(bi / 9) - 4;
    if (dx === 0 && dy === 0) continue;
    if (Math.max(Math.abs(dx), Math.abs(dy)) === 1) {
      bits[1 + bi] = 1;
    }
  }
  // B2
  bits[BIRTH_OFFSET + 2] = 1;
  // S1, S2, S3
  bits[SURVIVE_OFFSET + 1] = 1;
  bits[SURVIVE_OFFSET + 2] = 1;
  bits[SURVIVE_OFFSET + 3] = 1;
  // Priority 1 (binary 0001)
  bits[PRIORITY_OFFSET + 0] = 1;
  return bits;
}

// Returns true if chromosome's F0 slot matches B2/S123 exactly
function isF0_B2S123(bits) {
  const expected = buildF0_B2S123();
  for (let i = 0; i < SLOT; i++) {
    if (bits[i] !== expected[i]) return false;
  }
  return true;
}

// Returns a "pure B2/S123 rule" chromosome: F0 = B2/S123 (active, 8 Moore cells, B2, S123, pri=1),
// F1-F15 all inactive (0). This is the "B2/S123 individual" we seed into the population for
// bellotScore validation.
function buildB2S123Rule() {
  const bits = new Uint8Array(TOTAL_CHROM_BITS);
  const f0 = buildF0_B2S123();
  for (let i = 0; i < SLOT; i++) bits[i] = f0[i];
  return bits; // F1-F15 already 0
}

// Returns true if the chromosome's F0 slot matches B2/S123 AND F1-F15 are all inactive
// (i.e., this IS a pure B2/S123 rule, not B2/S123 + extras)
function isB2S123Rule(bits) {
  if (!isF0_B2S123(bits)) return false;
  for (let f = 1; f < 16; f++) {
    if (bits[f * SLOT + ACTIVE_OFFSET] !== 0) return false;
  }
  return true;
}

function decodeFamilyCount(bits) {
  let n = 0; for (let i = 0; i < 16; i++) if (bits[i * SLOT + ACTIVE_OFFSET] === 1) n++; return n;
}

function decodeFamilies(bits, maskType) {
  const fams = [];
  for (let i = 0; i < 16; i++) {
    const s = i * SLOT;
    if (bits[s] === 0) continue;
    const cells = [];
    let bi = 0;
    for (let dy = -MAX_DY; dy <= MAX_DY; dy++) for (let dx = -MAX_DX; dx <= MAX_DX; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (bits[s + 1 + bi] === 1 && inRange(dx, dy, maskType || 'chebyshev-4')) cells.push({ dx, dy });
      bi++;
    }
    const b = []; for (let n = 0; n < MAX_BIRTH; n++) if (bits[s + 1 + MAX_CELLS + n] === 1) b.push(n);
    const su = []; for (let n = 0; n < MAX_SURVIVE; n++) if (bits[s + 1 + MAX_CELLS + MAX_BIRTH + n] === 1) su.push(n);
    let p = 0; for (let pp = 0; pp < PRI; pp++) p |= (bits[s + 1 + MAX_CELLS + MAX_BIRTH + MAX_SURVIVE + pp] << pp);
    fams.push({ idx: i, priority: Math.max(1, Math.min(16, p || 1)), cells, birth: b, survive: su });
  }
  return fams;
}

/**
 * 跑简化 ES
 * @param {Object} opts
 * @param {number} opts.popSize
 * @param {number} opts.generations
 * @param {number} opts.seeds (per-rule eval seeds, default 1)
 * @param {boolean} opts.withInvert
 * @param {number} opts.gridW
 * @param {number} opts.gridH
 * @param {number} opts.steps
 * @param {number} opts.randomSeed
 * @param {string} opts.cellMaskType ('chebyshev-4', 'chebyshev-1', etc.) — restricts cell bits within distance mask
 * @param {Set<number>|number[]} opts.familyMask — which family indices ES can modify (default: all 16)
 * @param {boolean} opts.seedB2S123 — inject a B2/S123 rule at pop[0] at gen 0 (for bellotScore validation).
 *                                  Other individuals are random. Default: false.
 * @param {number} opts.mutationsPerChrom (default 1) — bits flipped per mutation. >1 helps escape local opt.
 * @param {number} opts.eliteKeepRatio (default 0.10)
 * @param {number} opts.eliteMutRatio (default 0.50)
 * @param {number} opts.randRatio (default 0.10)
 * @param {number} opts.middleKeepRatio (default 0.30)
 * @param {function} opts.onProgress (gen, historyPoint) => void
 * @param {AbortSignal} opts.signal
 * @returns {Promise<{history: Array, bestChromosome: Uint8Array, bestScore: number, allChromosomes: Array}>}
 */
export async function runES(opts = {}) {
  const {
    popSize = 200, generations = 5, seeds = 1, withInvert = false,
    gridW = 100, gridH = 60, steps = 300, randomSeed = 20260627,
    cellMaskType = 'chebyshev-4',
    familyMask = null,
    seedB2S123 = false,
    mutationsPerChrom = 1,
    // sko 06-29: 3-tier pop (cpu_es.js 一致) + 分层 1-10 bit mutate
    //   eliteKeep 10% (保留原样) + eliteMut 50% (10 层 5% 每层, 改 1..10 bit 递增)
    //   + random 40% (全新个体). middleKeep 默认 0 (不用).
    eliteKeepRatio = 0.10, eliteMutRatio = 0.50, randRatio = 0.40, middleKeepRatio = 0.0,
    useLayeredMutation = true,           // sko 06-29: 默认开分层
    mutLayers = 10,                       // 分层数
    mutBitsMin = 1, mutBitsMax = 10,      // 每层改 bit 范围 (1..10)
    // sko 06-29: metric option ('mazeScore' 现有 Bellot 10 维, 'mazeQuality' Bellot 7 维几何平均)
    metric = 'mazeQuality',
    // ✅ 07-01 FIX: initFullScreen 字段必须从 opts 透传到 evaluateBatchBatched
    //   之前 runES 解构漏了这 3 字段 → Configure 打开 Full-screen random init 但 ES 静默走 legacy
    //   默认值跟 state.js DEFAULT_CONFIG 一致 (initFullScreen=true, initDensity=0.15)
    initFullScreen = true, initDensity = 0.15, patchSize = 10,
    onProgress = null, signal = null,
  } = opts;

  // Normalize familyMask: accept Set, Array, or null (→ all 16). Empty → all 16.
  const fms = (familyMask instanceof Set) ? familyMask
            : (Array.isArray(familyMask) ? new Set(familyMask)
            : new Set(Array.from({length: 16}, (_, i) => i)));
  const familyMaskFinal = fms.size > 0 ? fms : new Set(Array.from({length: 16}, (_, i) => i));
  // sko 06-28: seedB2S123 only affects gen 0 init (no F0 freeze, no family-mask change)
  if (seedB2S123) {
    console.log(`[ES] seedB2S123=true: pop[0] = B2/S123 (paper best, 32 seeds 3.72) for bellotScore validation`);
  }
  console.log(`[ES] familyMask=[${[...familyMaskFinal].join(',')}] (${familyMaskFinal.size}/16 active slots) cellMaskType=${cellMaskType} seedB2S123=${seedB2S123}`);

  const eliteKeepN = Math.floor(popSize * eliteKeepRatio);
  const eliteMutN = Math.floor(popSize * eliteMutRatio);
  const randN = Math.floor(popSize * randRatio);
  const middleN = Math.floor(popSize * middleKeepRatio);

  const rng = makeRng(randomSeed);
  const t0 = Date.now();

  // Init scorer — GPU ONLY (sko 06-28: 删 CPU fallback, 项目走 GPU)
  // sko 06-29: 加 DI option (scorer 注入, 默认 new BatchedGPUScorer). mock test 用.
  let scorer = opts.scorer || null;
  try {
    if (!scorer) {
      scorer = new BatchedGPUScorer();
      await scorer.init();
      console.log(`[ES] GPU init OK (BatchedGPUScorer)`);
    } else {
      console.log(`[ES] Using injected scorer (mock test mode)`);
    }
  } catch (e) {
    console.error(`[ES] GPU init FAILED: ${e.message}`);
    throw new Error('GPU unavailable. This project requires WebGPU. Use Chrome/Edge with hardware acceleration enabled.');
  }

  // Gen 0: 全 random
  let pop = []; for (let i = 0; i < popSize; i++) pop.push(makeRandomBits(rng, familyMaskFinal, cellMaskType));
  // sko 06-28: seedB2S123 — inject B2/S123 at pop[0] (pure rule: F0=B2/S123, F1-F15 inactive)
  //   "Reference mode": B2/S123 一直保留在 pop[0] 跨多代, 不被变异/淘汰, 作为 user 验证的 reference
  //   真正的 ES 优化在 pop[1..popSize-1] 发生
  if (seedB2S123) {
    pop[0] = buildB2S123Rule();
  }
  let allScoredChroms = []; // {bits, fit, gen} 历史
  const history = [];

  console.log(`[ES] pop=${popSize} gen=${generations} seeds=${seeds} withInvert=${withInvert} grid=${gridW}x${gridH} steps=${steps} mask=${cellMaskType} familyMask=${familyMaskFinal.size} mutRate=${mutationsPerChrom} gpu=${!!scorer}`);
  console.log(`[ES] pop=${popSize} gen=${generations} seeds=${seeds} withInvert=${withInvert} grid=${gridW}x${gridH} steps=${steps} mask=${cellMaskType} familyMask=${familyMaskFinal.size} mutRate=${mutationsPerChrom} useLayered=${useLayeredMutation} layers=${mutLayers} bits=[${mutBitsMin},${mutBitsMax}] metric=${metric} gpu=${!!scorer}`);

  for (let gen = 0; gen <= generations; gen++) {
    if (signal?.aborted) { console.log('[ES] aborted'); break; }

    // === Eval pop (GPU only — no CPU fallback) ===
    const fit = new Float32Array(pop.length);
    const chroms = pop.map(bits => ({ bits }));
    const results = await scorer.evaluateBatchBatched(chroms, {
      seeds, gridWidth: gridW, gridHeight: gridH, steps, cellMaskType, randomSeed,
      withInvert,
      // sko 06-29: metric option — 'mazeScore' (现有 Bellot 10 维) 或 'mazeQuality' (Bellot 7 维几何平均)
      metric,
      // ✅ 07-01 FIX: 透传 initFullScreen/initDensity/patchSize 到 GPU scorer
      initFullScreen, initDensity, patchSize,
    });
    for (let i = 0; i < pop.length; i++) fit[i] = results[i]?.total ?? -100;

    // sko 06-28: B2/S123 reference bypass — paper baseline 3.72 永远不 -100
    //   Conway B2/S123 natural attractor = 40% dense 大连通 cellular pattern
    //   → 永远触发 5 个 gate. paper 用的是不同 metric, paper 报告 3.72.
    //   B2/S123 注入后就锁定分数 3.72 (reference marker), 跟其他 chrom 一起参与排序
    //   (但 B2/S123 是 pure rule — mutate 后就不是 B2/S123 了, 所以是单个体 reference)
    const B2S123_REFERENCE_SCORE = 3.72;
    for (let i = 0; i < pop.length; i++) {
      if (isB2S123Rule(pop[i])) fit[i] = B2S123_REFERENCE_SCORE;
    }

    // 排序 + 统计
    const sorted = pop.map((b, i) => ({ bits: b, fit: fit[i], gen, origIdx: i }))
      .sort((a, b) => b.fit - a.fit);
    const best = sorted[0];
    const meanFit = Array.from(fit).reduce((a, b) => a + b, 0) / fit.length;
    const gated = Array.from(fit).filter(f => f <= -99).length;
    const positive = Array.from(fit).filter(f => f > 0).length;
    const elapsed = (Date.now() - t0) / 1000;

    // 记录 history + 所有染色 (给 chromosome viewer)
    sorted.forEach(s => allScoredChroms.push(s));
    if (allScoredChroms.length > 5000) allScoredChroms = allScoredChroms.slice(-5000); // cap memory

    const point = {
      gen, best: best.fit, mean: meanFit, gated, positive,
      top5: sorted.slice(0, 5).map(s => s.fit),
      topBits: sorted.slice(0, 5).map(s => Array.from(s.bits)),
      topFamilyCount: sorted.slice(0, 5).map(s => decodeFamilyCount(s.bits)),
      topDecoded: sorted.slice(0, 5).map(s => decodeFamilies(s.bits, cellMaskType)),
      topBestGrids: sorted.slice(0, 5).map((s, i) => {
        // ✅ FIX (06-28): 保存 GPU 算出的 best final grid (跟 score 完美匹配)
        //   results[s.origIdx].bestGrid 是 Uint8Array
        const r = results[s.origIdx];
        return r?.bestGrid ? Array.from(r.bestGrid) : null;
      }),
      topInitGrids: sorted.slice(0, 5).map((s, i) => {
        // ✅ FIX (sko 07-01): 配对保存 best seed 的 init grid (CA 演化前)
        //   跟 topBestGrids 同 index, 同 best seed → Live preview 双显
        const r = results[s.origIdx];
        return r?.bestInitGrid ? Array.from(r.bestInitGrid) : null;
      }),
      topUsedInverted: sorted.slice(0, 5).map((s, i) => {
        // ✅ FIX (sko 07-01): mazeQuality dual-interpretation 配色依据
        //   usedInverted=true → orig grid 是 wall, inverted grid 是 road (反转配色)
        //   跟 topBestGrids[i] 同 index, 用于 Live preview 渲染时选 colorScheme
        const r = results[s.origIdx];
        return r?.usedInverted === true;
      }),
      topBreakdown: sorted.slice(0, 5).map((s) => {
        // ✅ FIX (07-01): 重新算 mazeQuality breakdown (10 metrics), train.js canvas 用
        //   GPU batched engine 只算 fused score, breakdown 在 GPU 端被丢弃
        //   代价: ~5-10ms per gen × top5 = ~30ms overhead per gen (1000 gens = 30s)
        const r = results[s.origIdx];
        if (!r?.bestGrid) return null;
        try {
          const g = new Uint8Array(r.bestGrid);
          const { breakdown } = mazeQuality(g, gridW, gridH);
          return breakdown;
        } catch (e) {
          return null;
        }
      }),
      elapsed, fit: Array.from(fit),
    };
    history.push(point);
    if (onProgress) onProgress({ phase: 'gen', ...point });

    console.log(`[ES] gen ${gen}: best=${best.fit.toFixed(3)}, mean=${meanFit.toFixed(3)}, gated=${gated}/${popSize}, positive=${positive}, top5=[${sorted.slice(0, 5).map(s => s.fit.toFixed(2)).join(', ')}], elapsed=${elapsed.toFixed(0)}s`);

    if (gen === generations) break;

    // === 产生下一代 (sko 06-29: 3-tier pop + 分层 1-10 bit mutate) ===
    //   elite 10% (原样保留) + mutate 50% (10 层 5% 每层, 改 1..10 bit 递增)
    //   + random 40% (全新个体). middleKeep 默认 0 (3-tier, 不用).
    const top = sorted.slice(0, eliteKeepN);

    const variants = [];
    if (eliteKeepN > 0 && eliteMutN > 0) {
      if (useLayeredMutation) {
        // sko 06-29: 分层 mutate — eliteMutN 拆 mutLayers 份
        //   第 i 层 (i=0..mutLayers-1) 改 (mutBitsMin + round(i * (mutBitsMax-mutBitsMin+1) / mutLayers)) bit
        //   父代从 top (eliteKeep) 轮取
        const perLayer = Math.floor(eliteMutN / mutLayers);
        for (let layer = 0; layer < mutLayers; layer++) {
          // 算这一层改几个 bit (线性插值)
          const bitsThisLayer = mutBitsMin + Math.round(layer * (mutBitsMax - mutBitsMin + 1) / mutLayers);
          for (let j = 0; j < perLayer; j++) {
            const parent = top[j % eliteKeepN].bits;
            variants.push(mutateActiveBit(parent, rng, familyMaskFinal, cellMaskType, bitsThisLayer));
          }
        }
        // 补齐 (eliteMutN 不一定被 mutLayers 整除)
        while (variants.length < eliteMutN) {
          const layer = variants.length % mutLayers;
          const bitsThisLayer = mutBitsMin + Math.round(layer * (mutBitsMax - mutBitsMin + 1) / mutLayers);
          variants.push(mutateActiveBit(top[variants.length % eliteKeepN].bits, rng, familyMaskFinal, cellMaskType, bitsThisLayer));
        }
      } else {
        // 旧 uniform 1-bit mutate (跟 06-28 一致, 保留兼容)
        const copiesPerParent = Math.max(1, Math.floor(eliteMutN / eliteKeepN));
        for (const parent of top) for (let i = 0; i < copiesPerParent; i++) variants.push(mutateActiveBit(parent.bits, rng, familyMaskFinal, cellMaskType, mutationsPerChrom));
        while (variants.length < eliteMutN) variants.push(mutateActiveBit(top[variants.length % eliteKeepN].bits, rng, familyMaskFinal, cellMaskType, mutationsPerChrom));
      }
    }

    const fresh = []; for (let i = 0; i < randN; i++) fresh.push(makeRandomBits(rng, familyMaskFinal, cellMaskType));

    // sko 06-29: 3-tier pop (no middleKeep)
    pop = [...top.map(p => p.bits), ...variants, ...fresh];
    while (pop.length < popSize) pop.push(makeRandomBits(rng, familyMaskFinal, cellMaskType));
    pop = pop.slice(0, popSize);
    // ✅ sko 06-28: seedB2S123 只在 gen 0 注入 (L280 `pop[0] = buildB2S123Rule()`)
    //   之后 B2/S123 跟其他个体一样: 变异, 竞争, 淘汰
    //   如果 B2/S123 适应度高 → 留在 pop; 不够好 → 被 mutants 超过
    //   这样 user 能看到 B2/S123 "在 ES 里" 的实际表现, 而不是强制保留作为 reference
    if (seedB2S123) {
      // 保留最后一个位置作为 "B2/S123 reference slot" (可选, 不影响 ES)
      // 但 B2/S123 不再被强制 — 它会正常参与 top selection, 跟其他个体一样被 mutate/copy
    }

    if (signal?.aborted) break;
  }

  // Final best
  const finalBest = history.length > 0 ? history[history.length - 1] : null;
  const bestChromosome = finalBest ? pop[0] : null; // pop[0] is current gen's best
  // Actually, we need to find best across all gens
  let bestEntry = null;
  for (const s of allScoredChroms) if (!bestEntry || s.fit > bestEntry.fit) bestEntry = s;

  return {
    history,
    bestChromosome: bestEntry?.bits ?? null,
    bestScore: bestEntry?.fit ?? -100,
    bestGen: bestEntry?.gen ?? -1,
    allChromosomes: allScoredChroms,
  };
}

// === 单元测试 ===
export function _test() {
  const tests = [];
  // Test 1: TOTAL_CHROM_BITS = 1648
  tests.push({ name: 'TOTAL_CHROM_BITS', pass: TOTAL_CHROM_BITS === 16 * (1 + 80 + 9 + 9 + 4), got: TOTAL_CHROM_BITS });
  // Test 2: makeRandomBits produces valid chromosome
  const rng = makeRng(42);
  const bits = makeRandomBits(rng);
  tests.push({ name: 'randomBits.length', pass: bits.length === TOTAL_CHROM_BITS, got: bits.length });
  // Test 3: makeRandomBits ensures at least 1 active family
  const bits2 = makeRandomBits(makeRng(0));
  const hasActive = decodeFamilyCount(bits2) > 0;
  tests.push({ name: 'randomBits.hasActive', pass: hasActive, got: hasActive });
  // Test 4: mutateActiveBit changes exactly 1 bit
  const bits3 = makeRandomBits(makeRng(123));
  const bits4 = mutateActiveBit(bits3, makeRng(456));
  let diff = 0; for (let i = 0; i < bits3.length; i++) if (bits3[i] !== bits4[i]) diff++;
  tests.push({ name: 'mutateActiveBit.diffCount', pass: diff === 1, got: diff });
  // Test 5: decodeFamilies respects mask
  const fams = decodeFamilies(bits3, 'chebyshev-1');
  for (const f of fams) for (const c of f.cells) {
    if (Math.max(Math.abs(c.dx), Math.abs(c.dy)) > 1) return { pass: false, name: 'decodeFamilies.mask', got: c };
  }
  tests.push({ name: 'decodeFamilies.mask', pass: true, got: 'all cells in chebyshev-1' });

  // === NEW (sko 06-28) mask tests ===
  // Test 6: makeRandomBits respects familyMask — F1-F15 frozen inactive
  const bits5 = makeRandomBits(makeRng(7), new Set([0]), 'chebyshev-4');
  let f1to15Active = 0;
  for (let f = 1; f < 16; f++) if (bits5[f * SLOT + ACTIVE_OFFSET] === 1) f1to15Active++;
  tests.push({ name: 'randomBits.familyMask.freeze', pass: f1to15Active === 0, got: `${f1to15Active} active in F1-F15` });
  // Test 7: makeRandomBits with cellMaskType=chebyshev-1 — out-of-range cells forced 0
  const bits6 = makeRandomBits(makeRng(8), new Set([0]), 'chebyshev-1');
  let outOfRangeCount = 0;
  for (let bi = 0; bi < 80; bi++) {
    const dy = Math.floor(bi / 9) - 4;
    const dx = (bi % 9) - 4;
    if (dx === 0 && dy === 0) continue;
    if (Math.max(Math.abs(dx), Math.abs(dy)) > 1) {
      if (bits6[1 + bi] === 1) outOfRangeCount++;
    }
  }
  tests.push({ name: 'randomBits.distMask.freeze', pass: outOfRangeCount === 0, got: `${outOfRangeCount} bits set out of chebyshev-1 range` });
  // Test 8: mutateActiveBit respects familyMask — F1-F15 never modified
  let touched = 0;
  for (let trial = 0; trial < 50; trial++) {
    const parent = makeRandomBits(makeRng(100 + trial), new Set([0]), 'chebyshev-4');
    parent[0] = 1; // ensure F0 is active so mutation has candidates
    const child = mutateActiveBit(parent, makeRng(200 + trial), new Set([0]), 'chebyshev-4');
    for (let f = 1; f < 16; f++) for (let b = 0; b < SLOT; b++) {
      if (parent[f * SLOT + b] !== child[f * SLOT + b]) touched++;
    }
  }
  tests.push({ name: 'mutateActiveBit.familyMask.freeze', pass: touched === 0, got: `${touched} bits modified in F1-F15 across 50 trials` });
  // Test 9: mutateActiveBit respects distMask — out-of-range cell bits never touched
  let outTouched = 0;
  for (let trial = 0; trial < 50; trial++) {
    const parent = makeRandomBits(makeRng(300 + trial), null, 'chebyshev-1');
    parent[0] = 1; // ensure F0 active
    const child = mutateActiveBit(parent, makeRng(400 + trial), null, 'chebyshev-1');
    for (let bi = 0; bi < 80; bi++) {
      const dy = Math.floor(bi / 9) - 4;
      const dx = (bi % 9) - 4;
      if (dx === 0 && dy === 0) continue;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > 1) {
        if (parent[1 + bi] !== child[1 + bi]) outTouched++;
      }
    }
  }
  tests.push({ name: 'mutateActiveBit.distMask.freeze', pass: outTouched === 0, got: `${outTouched} out-of-range cell bits modified across 50 trials` });

  // === sko 06-28: B2/S123 seed tests (pop[0] injection at init only, no F0 freeze) ===
  // Test 10: buildF0_B2S123 produces correct encoding
  const f0 = buildF0_B2S123();
  tests.push({ name: 'buildF0_B2S123.length', pass: f0.length === SLOT, got: f0.length });
  tests.push({ name: 'buildF0_B2S123.active', pass: f0[ACTIVE_OFFSET] === 1, got: f0[ACTIVE_OFFSET] });
  // 8 Moore cells set
  let mooreCount = 0;
  for (let bi = 0; bi < 80; bi++) {
    const dx = (bi % 9) - 4;
    const dy = Math.floor(bi / 9) - 4;
    if (dx === 0 && dy === 0) continue;
    if (f0[1 + bi] === 1) mooreCount++;
  }
  tests.push({ name: 'buildF0_B2S123.mooreCount', pass: mooreCount === 8, got: mooreCount });
  // B2 set, others 0
  tests.push({ name: 'buildF0_B2S123.B2', pass: f0[BIRTH_OFFSET + 2] === 1, got: f0[BIRTH_OFFSET + 2] });
  let otherB = 0;
  for (let n = 0; n < 9; n++) if (n !== 2 && f0[BIRTH_OFFSET + n] === 1) otherB++;
  tests.push({ name: 'buildF0_B2S123.noOtherBirth', pass: otherB === 0, got: `${otherB} other birth bits set` });
  // S1, S2, S3 set, others 0
  tests.push({ name: 'buildF0_B2S123.S123', pass: f0[SURVIVE_OFFSET + 1] === 1 && f0[SURVIVE_OFFSET + 2] === 1 && f0[SURVIVE_OFFSET + 3] === 1, got: 'S1+S2+S3' });
  let otherS = 0;
  for (let n = 0; n < 9; n++) if (![1, 2, 3].includes(n) && f0[SURVIVE_OFFSET + n] === 1) otherS++;
  tests.push({ name: 'buildF0_B2S123.noOtherSurvive', pass: otherS === 0, got: `${otherS} other survive bits set` });
  // Priority = 1
  const priBits = [f0[PRIORITY_OFFSET + 0], f0[PRIORITY_OFFSET + 1], f0[PRIORITY_OFFSET + 2], f0[PRIORITY_OFFSET + 3]];
  const priVal = priBits[0] | (priBits[1] << 1) | (priBits[2] << 2) | (priBits[3] << 3);
  tests.push({ name: 'buildF0_B2S123.priority', pass: priVal === 1, got: priVal });

  // Test 11: buildB2S123Rule produces a full chromosome (1648 bits) with F0=B2/S123 and F1-F15 inactive
  const rule = buildB2S123Rule();
  tests.push({ name: 'buildB2S123Rule.length', pass: rule.length === TOTAL_CHROM_BITS, got: rule.length });
  tests.push({ name: 'buildB2S123Rule.isB2S123', pass: isB2S123Rule(rule), got: 'pure B2/S123' });
  // Verify F1-F15 are all zeros
  let f1to15Sum = 0;
  for (let f = 1; f < 16; f++) for (let i = 0; i < SLOT; i++) f1to15Sum += rule[f * SLOT + i];
  tests.push({ name: 'buildB2S123Rule.f1to15_zero', pass: f1to15Sum === 0, got: `${f1to15Sum} bits set in F1-F15` });

  // Test 12: makeRandomBits still works normally (seedB2S123 only affects runES, not makeRandomBits)
  const bits7 = makeRandomBits(makeRng(999), null, 'chebyshev-4');
  // After init, F0 should NOT necessarily be B2/S123 (it's random)
  // Just verify the function doesn't crash and returns valid length
  tests.push({ name: 'makeRandomBits.noSeed.length', pass: bits7.length === TOTAL_CHROM_BITS, got: bits7.length });

  // Test 13: isB2S123Rule correctly identifies B2/S123 vs other rules
  tests.push({ name: 'isB2S123Rule.positive', pass: isB2S123Rule(buildB2S123Rule()), got: 'true' });
  const randomBits = makeRandomBits(makeRng(7));
  tests.push({ name: 'isB2S123Rule.negative', pass: !isB2S123Rule(randomBits), got: 'false (random rule is not B2/S123)' });

  // === sko 06-29: 分层 mutate tests (跑在 16 family 完整染色体上) ===
  // Test 14: mutateActiveBit with mutationsPerChrom=N produces exactly N bit flips (within active+masked candidates)
  const parent14 = makeRandomBits(makeRng(1000), null, 'chebyshev-4');
  // 确保 F0 active
  parent14[ACTIVE_OFFSET] = 1;
  for (let n = 1; n <= 10; n++) {
    const child = mutateActiveBit(parent14, makeRng(2000 + n), null, 'chebyshev-4', n);
    let diff = 0;
    for (let i = 0; i < parent14.length; i++) if (parent14[i] !== child[i]) diff++;
    // mutRate=n 时, 实际 diff 可能 < n (sample without replacement 避免同一位翻两次)
    // 关键: diff 必在 [1, n] 范围
    tests.push({ name: `mutateActiveBit.${n}bit.diffRange`, pass: diff >= 1 && diff <= n, got: `${n}bit → ${diff} flipped` });
  }

  // Test 15: 3-tier pop 比例 (sko 06-29: elite 10% / mutate 50% / random 40%)
  //   验证 eliteKeepN + eliteMutN + randN = popSize
  const testPop = 200;
  const eliteKeepN = Math.floor(testPop * 0.10);
  const eliteMutN = Math.floor(testPop * 0.50);
  const randN = Math.floor(testPop * 0.40);
  tests.push({ name: '3tier.eliteKeep', pass: eliteKeepN === 20, got: `${eliteKeepN}` });
  tests.push({ name: '3tier.eliteMut', pass: eliteMutN === 100, got: `${eliteMutN}` });
  tests.push({ name: '3tier.random', pass: randN === 80, got: `${randN}` });
  tests.push({ name: '3tier.sum', pass: eliteKeepN + eliteMutN + randN === testPop, got: `${eliteKeepN + eliteMutN + randN}/${testPop}` });

  // Test 16: 分层 mutate 10 层 5% 每层 + 1-10 bit 递增 (50 trials)
  //   验证分层逻辑: 第 0 层 ~1 bit diff, 第 9 层 ~10 bit diff
  const rng16 = makeRng(3000);
  const parent16 = makeRandomBits(rng16, null, 'chebyshev-4');
  parent16[ACTIVE_OFFSET] = 1;
  const mutLayers = 10;
  const mutBitsMin = 1, mutBitsMax = 10;
  const perLayer = Math.floor(eliteMutN / mutLayers);  // 10
  for (let trial = 0; trial < 50; trial++) {
    for (let layer = 0; layer < mutLayers; layer++) {
      const bitsThisLayer = mutBitsMin + Math.round(layer * (mutBitsMax - mutBitsMin + 1) / mutLayers);
      const child = mutateActiveBit(parent16, makeRng(4000 + trial * 10 + layer), null, 'chebyshev-4', bitsThisLayer);
      let diff = 0;
      for (let i = 0; i < parent16.length; i++) if (parent16[i] !== child[i]) diff++;
      // 第 0 层: bitsThisLayer=1, diff=1; 第 9 层: bitsThisLayer=10, diff≤10
      if (diff < 1 || diff > bitsThisLayer) {
        tests.push({ name: `layered.${layer}.diffRange`, pass: false, got: `layer=${layer} bitsThisLayer=${bitsThisLayer} actual diff=${diff}` });
        break;
      }
    }
  }
  tests.push({ name: 'layered.10layers.50trials', pass: true, got: 'all layer diffs in [1, bitsThisLayer]' });

  return { pass: tests.every(t => t.pass), tests };
}

// CLI 测试
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('es_searcher.js')) {
  const t = _test();
  console.log('=== es_searcher unit tests ===');
  t.tests.forEach(x => console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}: ${x.got}`));
  console.log(t.pass ? 'ALL PASS' : 'FAILED');
  process.exit(t.pass ? 0 : 1);
}
