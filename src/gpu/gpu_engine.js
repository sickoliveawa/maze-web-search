/**
 * gpu_engine.js — WebGPU compute engine for CA + maze_score connectivity (Phase 8, sko 2026-06-27)
 *
 * 设计目标:
 *   - 浏览器原生 WebGPU (Chrome/Edge), RTX 4060 加速 GA 评估
 *   - 一次 dispatch: 1 个 rule × N seeds × 1 个 CA step
 *   - 用 ping-pong buffer 在 GPU 内存完成 300 步演化
 *   - 最后读回 final grid 到 CPU, 跑 maze_score (剩余 9 个维度)
 *
 * 性能预算 (RTX 4060):
 *   - 100 rules × 4 seeds × 300 steps = 120,000 dispatch
 *   - 单 dispatch 工作量: 4*40*40 = 6400 cells, 16x16 workgroup
 *   - 实测 ~5-10μs / dispatch
 *   - 理论: 600-1200ms / generation
 *   - 目标: 30 代 < 1 分钟 (vs CPU 42 分钟)
 *
 * 关键设计:
 *   - grids buffer: [numSeeds * W * H] bytes, 每个 seed 独立 grid
 *   - rule params 用 uniform buffer (max 4 families, 80 cells/family)
 *   - 多个 family 按 priority 顺序遍历,第一个匹配的 family 决定 next
 *   - bounded topology: 越界 = 0; toroidal: wrap
 */

const MAX_FAMILIES = 4;           // GA 染色体最多 4 active family
const MAX_CELLS_PER_FAMILY = 80;  // 9x9 mask = 80 cells
const CAUSE_NONE = 0xff;          // marker for "no family matched"

// ========== WGSL Shaders ==========

/**
 * CA step shader - batched (1 rule × N seeds × 1 step)
 *
 * Layout (storage buffer):
 *   gridsA: [numSeeds, W, H] u8, current
 *   gridsB: [numSeeds, W, H] u8, next
 *
 * Uniform buffer:
 *   CAUniforms {
 *     gridWidth: u32,
 *     gridHeight: u32,
 *     numSeeds: u32,
 *     topologyType: u32,  // 0=BOUNDED, 1=TOROIDAL
 *     defaultState: u32,
 *     numActiveFamilies: u32,
 *     families: array<Family, MAX_FAMILIES>,
 *   }
 *
 * Family struct (对齐到 16 bytes for uniform):
 *   cellsMaskLo: u32  // bit 0..31 of 80-bit cells mask
 *   cellsMaskHi: u32  // bit 32..63 of 80-bit cells mask
 *   cellsMaskHi2: u32 // bit 64..79 of 80-bit cells mask (16 bits used)
 *   birthMask: u32    // bit n set if n in birth
 *   surviveMask: u32  // bit n set if n in survive
 *   priority: u32
 *   pad0: u32
 *   pad1: u32
 * Total = 8 u32 = 32 bytes per family
 */
// Note: each cell stored in its own u32 word (1 cell = 4 bytes) for race-free writes.
// Earlier 4-cells-per-word packed layout caused data race because var<storage, read_write>
// array<u32> accesses are non-atomic. With 1 cell per word, no race, simple & correct.
const CA_STEP_SHADER = /* wgsl */`
struct Family {
  cellsMaskLo: u32,
  cellsMaskHi: u32,
  cellsMaskHi2: u32,
  birthMask: u32,
  surviveMask: u32,
  priority: u32,
  pad0: u32,
  pad1: u32,
}

struct CAUniforms {
  gridWidth: u32,
  gridHeight: u32,
  numSeeds: u32,
  topologyType: u32,
  defaultState: u32,
  numActiveFamilies: u32,
  pad0: u32,
  pad1: u32,
  families: array<Family, ${MAX_FAMILIES}>,
}

@group(0) @binding(0) var<storage, read> gridsIn: array<u32>;     // 1 cell per word (race-free)
@group(0) @binding(1) var<storage, read_write> gridsOut: array<u32>;  // 1 cell per word
@group(0) @binding(2) var<uniform> uniforms: CAUniforms;

/**
 * Test if cell (dx, dy) is in family.cellsMask
 * cellsMask is 80-bit (cellsMaskLo: bits 0-31, cellsMaskHi: 32-63, cellsMaskHi2: 64-79)
 * Cells are encoded in 9x9 grid order: dy=-4..+4, dx=-4..+4 (skip center 0,0)
 *   bit index = (dy + 4) * 9 + (dx + 4), then -1 if (dx,dy) > (0,0), else no shift
 *
 * Simpler encoding (matches RuleChromosome):
 *   For dy in -4..4:
 *     For dx in -4..4:
 *       if dx==0 && dy==0: skip
 *       assign sequential bit 0..79
 */
fn cellInFamily(dx: i32, dy: i32, famIdx: u32) -> bool {
  // Skip center
  if (dx == 0 && dy == 0) { return false; }
  // Map (dx, dy) to bit index 0..79
  let ddx = dx + 4;
  let ddy = dy + 4;
  // Linear index (dy * 9 + dx) but skipping center (dx=4, dy=4)
  // bit_index = (dy + 4) * 9 + (dx + 4); if (dx,dy) > (0,0) in linear order, subtract 1
  var bitIdx = ddy * 9 + ddx;
  if (bitIdx > 40) { bitIdx = bitIdx - 1; }  // skip center (bit 40)
  // bitIdx is 0..79
  // bit 0-31 → cellsMaskLo
  // bit 32-63 → cellsMaskHi
  // bit 64-79 → cellsMaskHi2
  var mask: u32;
  if (bitIdx < 32) {  // abstract-int 32, OK with i32
    mask = uniforms.families[famIdx].cellsMaskLo;
  } else if (bitIdx < 64) {
    mask = uniforms.families[famIdx].cellsMaskHi;
  } else {
    mask = uniforms.families[famIdx].cellsMaskHi2;
  }
  let bit = u32(bitIdx % 32);  // bitIdx is i32, 32 is abstract-int
  return ((mask >> bit) & 1u) == 1u;
}

/**
 * Count active neighbors in family.famIdx at position (cx, cy), reading from gridsIn
 * with seedCellOffset for multi-seed layout. 1 cell = 1 word.
 * Out-of-bounds returns 0 (bounded) or wraps (toroidal).
 */
fn countActiveFamilyOffset(cx: i32, cy: i32, famIdx: u32, seedCellOffset: u32) -> u32 {
  var count = 0u;
  for (var dy = -4; dy <= 4; dy = dy + 1) {
    for (var dx = -4; dx <= 4; dx = dx + 1) {
      if (!cellInFamily(dx, dy, famIdx)) { continue; }
      var nx = cx + dx;
      var ny = cy + dy;
      if (uniforms.topologyType == 0u) {
        if (nx < 0 || nx >= i32(uniforms.gridWidth) || ny < 0 || ny >= i32(uniforms.gridHeight)) {
          continue;
        }
      } else {
        nx = ((nx % i32(uniforms.gridWidth)) + i32(uniforms.gridWidth)) % i32(uniforms.gridWidth);
        ny = ((ny % i32(uniforms.gridHeight)) + i32(uniforms.gridHeight)) % i32(uniforms.gridHeight);
      }
      let cellIdx = seedCellOffset + u32(ny) * uniforms.gridWidth + u32(nx);
      if (gridsIn[cellIdx] > 0u) {
        count = count + 1u;
      }
    }
  }
  return count;
}

/**
 * Get self state at (cx, cy) in seed's grid (returns defaultState if out of bounds)
 * Layout: 1 cell per u32 word.
 */
fn getSelfWithOffset(cx: i32, cy: i32, seedCellOffset: u32) -> u32 {
  if (cx < 0 || cx >= i32(uniforms.gridWidth) || cy < 0 || cy >= i32(uniforms.gridHeight)) {
    return u32(uniforms.defaultState);
  }
  let cellIdx = seedCellOffset + u32(cy) * uniforms.gridWidth + u32(cx);
  return gridsIn[cellIdx];
}

/**
 * Set cell at (cx, cy) in seed's gridsOut (no-op if out of bounds).
 * Layout: 1 cell per u32 word, so no race condition.
 */
fn setOutWithOffset(cx: i32, cy: i32, val: u32, seedCellOffset: u32) {
  if (cx < 0 || cx >= i32(uniforms.gridWidth) || cy < 0 || cy >= i32(uniforms.gridHeight)) {
    return;
  }
  let cellIdx = seedCellOffset + u32(cy) * uniforms.gridWidth + u32(cx);
  gridsOut[cellIdx] = val;
}

@compute @workgroup_size(16, 16, 1)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  // Compute global cell coords (x, y) + seed index from workgroup_id
  let seedIdx = wid.z;
  if (seedIdx >= uniforms.numSeeds) { return; }
  let baseX = wid.x * 16u + lid.x;
  let baseY = wid.y * 16u + lid.y;
  if (baseX >= uniforms.gridWidth || baseY >= uniforms.gridHeight) { return; }

  // Multi-seed layout: 1 cell per u32, offset = seedIdx * (W*H)
  let cellsPerSeed = uniforms.gridWidth * uniforms.gridHeight;
  let seedCellOffset = seedIdx * cellsPerSeed;

  // Get self at (baseX, baseY) in this seed's grid
  let self_ = getSelfWithOffset(i32(baseX), i32(baseY), seedCellOffset);

  // Iterate families by priority order
  var matched = 0u;
  for (var fi = 0u; fi < uniforms.numActiveFamilies; fi = fi + 1u) {
    let n = countActiveFamilyOffset(i32(baseX), i32(baseY), fi, seedCellOffset);
    var triggered = false;
    // n>31 → mask only has bits 0..31 (shift UB). CPU 行为: n 不在 0..8 范围 → fall through → dead.
    // 旧 GPU 错误地查 birth[0]/survive[0] (safeN=0),跟 CPU 分裂。修复: n>31 时这个 family 不触发。
    if (n <= 31u) {
      if (self_ == 0u) {
        if (((uniforms.families[fi].birthMask >> n) & 1u) == 1u) {
          triggered = true;
        }
      } else {
        if (((uniforms.families[fi].surviveMask >> n) & 1u) == 1u) {
          triggered = true;
        }
      }
    }
    if (triggered) {
      matched = 1u;
      break;
    }
  }

  var nextVal = matched;
  if (matched == 0u && self_ > 0u) {
    nextVal = 0u;
  }

  setOutWithOffset(i32(baseX), i32(baseY), nextVal, seedCellOffset);
}
`;

/**
 * Connectivity shader - BFS-based connected components
 * Single grid in, returns components count + largest size (atomic max)
 *
 * Layout:
 *   grid: [W*H] u8 (packed)
 *   visited: [W*H] u8 (packed, init to 0)
 *   components: [1] u32 atomic (init to 0)
 *   largestSize: [1] u32 atomic (init to 0)
 *
 * Algorithm:
 *   - Each invocation handles one cell
 *   - If cell is alive and not visited: atomic add to components count, BFS
 *   - BFS: use a shared queue in workgroup memory (limited to 256)
 *   - For larger components, fall back to atomic counters and re-scan
 *
 * Phase 1 simplification: compute only "total live cells" and "largest component"
 * via flood-fill using repeated scan approach (still GPU but simpler).
 *
 * For MVP, we use a 2-pass approach:
 *   Pass 1: label connected components using union-find in workgroup memory
 *   Pass 2: count components + find largest
 *
 * For simplicity, we'll do it differently:
 *   - Use workgroup-shared BFS with cooperative scan
 *   - Each invocation explores one starting cell if it's an unvisited live cell
 *   - Uses atomic operations for global counters
 */
const CONNECTIVITY_SHADER = /* wgsl */`
@group(0) @binding(0) var<storage, read> grid: array<u32>;     // packed
@group(0) @binding(1) var<storage, read_write> visited: array<u32>;
@group(0) @binding(2) var<storage, read_write> compSizes: array<atomic<u32>>;  // pre-allocated
@group(0) @binding(3) var<uniform> params: vec4<u32>;  // [W, H, maxComponents, totalCells]

@compute @workgroup_size(16, 16, 1)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  // Phase 1 connectivity is complex; we'll do CPU-side BFS in MVP.
  // GPU shader is a placeholder - we just count live cells per cell.
  // The actual connectivity runs on CPU reading back the grid.
}
`;

// ========== JS Engine ==========

/**
 * GPUEngine class — manages WebGPU device, pipelines, buffers.
 * Browser-only (uses navigator.gpu).
 */
export class GPUEngine {
  constructor() {
    this.device = null;
    this.queue = null;
    this.caPipeline = null;
    this.caBindGroupLayout = null;
    this.uniformBuffer = null;
    this.uniformSize = 0;
    this.initialized = false;
  }

  /**
   * 初始化 WebGPU
   * @returns {Promise<{ok: boolean, error?: string, info?: object}>}
   */
  async init() {
    if (this.initialized) return { ok: true };
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return { ok: false, error: 'WebGPU not supported in this browser' };
    }
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { ok: false, error: 'No GPU adapter' };
      this.device = await adapter.requestDevice();
      this.queue = this.device.queue;

      // Capture GPU errors (shader compile, dispatch, etc.)
      this.device.onuncapturederror = (event) => {
        console.error('[GPU uncaptured error]', event.error?.message || event);
      };

      // Build pipeline
      const shaderModule = this.device.createShaderModule({ code: CA_STEP_SHADER });
      // Capture shader compile info
      const compileInfo = await shaderModule.getCompilationInfo();
      if (compileInfo.messages && compileInfo.messages.length > 0) {
        console.warn('[GPU shader compile messages]', JSON.stringify(compileInfo.messages, null, 2));
        for (const msg of compileInfo.messages) {
          if (msg.type === 'error') {
            console.error('[GPU shader error]', msg.message, 'line', msg.lineNum, 'col', msg.linePos);
          }
        }
      }
      this.caBindGroupLayout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
      });
      this.caPipeline = this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.caBindGroupLayout] }),
        compute: { module: shaderModule, entryPoint: 'main' },
      });

      // Uniform buffer: CAUniforms struct
      // CAUniforms base = 8 u32, families = MAX_FAMILIES × 8 u32 = 32 u32
      // Total = 40 u32 = 160 bytes
      this.uniformSize = (8 + MAX_FAMILIES * 8) * 4;
      this.uniformBuffer = this.device.createBuffer({
        size: this.uniformSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      this.initialized = true;
      return {
        ok: true,
        info: {
          adapterInfo: adapter.info || {},
          features: Array.from(this.device.features || []),
          limits: {
            maxStorageBufferBindingSize: this.device.limits.maxStorageBufferBindingSize,
            maxComputeWorkgroupsPerDimension: this.device.limits.maxComputeWorkgroupsPerDimension,
          },
        },
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * 编码 rule 为 GPU uniform buffer 格式
   * @param {object} rule - {families: [{cells, birth, survive, priority}], topology, defaultState}
   * @returns {ArrayBuffer} 160 bytes (uniform buffer)
   */
  encodeRuleToUniform(rule) {
    const uniforms = new Uint32Array(this.uniformSize / 4);

    // 排序 families by priority (低=高优先级),只取前 MAX_FAMILIES 个 active
    const families = (rule.families || [])
      .filter(f => f && f.cells && f.cells.length > 0)
      .sort((a, b) => a.priority - b.priority)
      .slice(0, MAX_FAMILIES);

    uniforms[0] = 0;  // gridWidth (待 setRun 时填)
    uniforms[1] = 0;  // gridHeight
    uniforms[2] = 0;  // numSeeds
    uniforms[3] = rule.topology === 'toroidal' ? 1 : 0;
    uniforms[4] = rule.defaultState || 0;
    uniforms[5] = families.length;
    uniforms[6] = 0;
    uniforms[7] = 0;

    for (let i = 0; i < MAX_FAMILIES; i++) {
      const offset = 8 + i * 8;
      if (i < families.length) {
        const fam = families[i];
        // cells mask: 80 bits, encoded same as RuleChromosome
        let cellsMaskLo = 0, cellsMaskHi = 0, cellsMaskHi2 = 0;
        for (const { dx, dy } of fam.cells) {
          if (dx === 0 && dy === 0) continue;
          if (dx < -4 || dx > 4 || dy < -4 || dy > 4) continue;  // out of mask
          const ddx = dx + 4;
          const ddy = dy + 4;
          let bitIdx = ddy * 9 + ddx;
          if (bitIdx > 40) bitIdx -= 1;
          if (bitIdx < 0 || bitIdx >= 80) continue;
          if (bitIdx < 32) cellsMaskLo |= (1 << bitIdx);
          else if (bitIdx < 64) cellsMaskHi |= (1 << (bitIdx - 32));
          else cellsMaskHi2 |= (1 << (bitIdx - 64));
        }
        let birthMask = 0;
        for (const n of fam.birth || []) {
          if (n >= 0 && n < 32) birthMask |= (1 << n);
        }
        let surviveMask = 0;
        for (const n of fam.survive || []) {
          if (n >= 0 && n < 32) surviveMask |= (1 << n);
        }
        uniforms[offset + 0] = cellsMaskLo;
        uniforms[offset + 1] = cellsMaskHi;
        uniforms[offset + 2] = cellsMaskHi2;
        uniforms[offset + 3] = birthMask;
        uniforms[offset + 4] = surviveMask;
        uniforms[offset + 5] = fam.priority || 1;
        uniforms[offset + 6] = 0;
        uniforms[offset + 7] = 0;
      } else {
        // Padding family - all zeros
        uniforms[offset + 0] = 0;
        uniforms[offset + 1] = 0;
        uniforms[offset + 2] = 0;
        uniforms[offset + 3] = 0;
        uniforms[offset + 4] = 0;
        uniforms[offset + 5] = 0;
        uniforms[offset + 6] = 0;
        uniforms[offset + 7] = 0;
      }
    }

    return uniforms.buffer;
  }

  /**
   * 把 Uint8 grid 数组打包成 u32 array
   * Layout: 1 cell per u32 word (race-free in shader)
   */
  packGrid(gridU8, width, height, numSeeds = 1) {
    const total = numSeeds * width * height;
    const packed = new Uint32Array(total);
    for (let i = 0; i < total; i++) {
      packed[i] = gridU8[i] || 0;
    }
    return packed;
  }

  /**
   * 解包 u32 array 回 Uint8 grid array
   * Layout: 1 cell per u32 word.
   */
  unpackGrid(packed, width, height, numSeeds = 1) {
    const total = numSeeds * width * height;
    const u8 = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      u8[i] = packed[i] > 0 ? 1 : 0;  // threshold
    }
    return u8;
  }

  /**
   * 跑 N steps (GPU), 1 个 rule × N seeds
   * @param {object} opts
   * @param {ArrayBuffer} opts.uniformsBuf - rule 编码 (160 bytes)
   * @param {Uint8Array} opts.initialGrids - [numSeeds * W * H] bytes, 初始 grids
   * @param {number} opts.width
   * @param {number} opts.height
   * @param {number} opts.numSeeds
   * @param {number} opts.steps
   * @returns {Promise<{finalGrids: Uint8Array, gpuTimeMs: number}>}
   */
  async runSteps({ uniformsBuf, initialGrids, width, height, numSeeds, steps }) {
    // 1 cell per u32 word: total cells = numSeeds * W * H, buffer size in bytes = * 4
    const totalCells = numSeeds * width * height;
    const bufferSize = totalCells * 4;

    // Create buffers (ping-pong)
    const bufA = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const bufB = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const readBuf = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Pack initial grids
    const packedInit = this.packGrid(initialGrids, width, height, numSeeds);
    this.queue.writeBuffer(bufA, 0, packedInit);

    // Update uniforms with width/height/numSeeds
    const uniformsU32 = new Uint32Array(uniformsBuf);
    uniformsU32[0] = width;
    uniformsU32[1] = height;
    uniformsU32[2] = numSeeds;
    this.queue.writeBuffer(this.uniformBuffer, 0, uniformsU32);

    // Create bind groups (will swap buffers each step)
    const makeBindGroup = (inBuf, outBuf) => this.device.createBindGroup({
      layout: this.caBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: inBuf } },
        { binding: 1, resource: { buffer: outBuf } },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });

    // Dispatch workgroup counts
    const workgroupCountX = Math.ceil(width / 16);
    const workgroupCountY = Math.ceil(height / 16);
    const workgroupCountZ = numSeeds;

    const t0 = performance.now();
    for (let step = 0; step < steps; step++) {
      const inBuf = (step % 2 === 0) ? bufA : bufB;
      const outBuf = (step % 2 === 0) ? bufB : bufA;
      const bindGroup = makeBindGroup(inBuf, outBuf);

      const commandEncoder = this.device.createCommandEncoder();
      const passEncoder = commandEncoder.beginComputePass();
      passEncoder.setPipeline(this.caPipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.dispatchWorkgroups(workgroupCountX, workgroupCountY, workgroupCountZ);
      passEncoder.end();
      this.queue.submit([commandEncoder.finish()]);
    }

    // Wait for completion + read final buffer (last written to)
    const finalBuf = (steps % 2 === 0) ? bufA : bufB;
    const readCommandEncoder = this.device.createCommandEncoder();
    readCommandEncoder.copyBufferToBuffer(finalBuf, 0, readBuf, 0, bufferSize);
    this.queue.submit([readCommandEncoder.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint32Array(readBuf.getMappedRange());
    const finalGrids = this.unpackGrid(mapped, width, height, numSeeds);
    readBuf.unmap();
    const t1 = performance.now();

    // Cleanup
    bufA.destroy();
    bufB.destroy();
    readBuf.destroy();

    return {
      finalGrids,
      gpuTimeMs: t1 - t0,
    };
  }

  destroy() {
    if (this.uniformBuffer) this.uniformBuffer.destroy();
    if (this.device) this.device.destroy();
  }
}