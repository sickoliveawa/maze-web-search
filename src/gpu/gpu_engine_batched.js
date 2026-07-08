/**
 * gpu_engine_batched.js — Batched WebGPU CA: 1 dispatch = N rules × M seeds × 1 step
 *
 * 关键设计:
 *   - z-axis dispatch: wid.z = ruleIdx * numSeeds + seedIdx
 *   - cell offset: (ruleIdx * numSeeds + seedIdx) * (W * H)
 *   - rule offset: ruleIdx * MAX_FAMILIES (因为 storage buffer 没有 array<array>)
 *   - 1 cell per u32 word (race-free)
 *
 * 性能:
 *   - 1 dispatch = 1000 rules × 4 seeds × 1 step × 100×60 cells = 24,000,000 cell updates
 *   - 300 steps = 300 dispatches, 但是 1 个大 dispatch 而不是 24000 个小 dispatch
 *   - 预计 10-30× 加速 vs 单 rule 单 dispatch (避免 CPU/GPU command encoder 开销)
 *
 * Memory budget (RTX 4060 8GB):
 *   - 1000 rules × 4 seeds × 100×60 cells × 4 bytes = 96 MB ping-pong = 192 MB total
 *   - 100 rules × 4 seeds × 100×60 cells × 4 bytes = 9.6 MB ping-pong = 19 MB total
 *   - 1000 rule params × 4 families × 6 fields × 4 bytes = 96 KB
 *   - 完全在 budget 内
 */

const MAX_FAMILIES = 16;          // 染色体 16 family slots 全支持 (sko 07-03 改 4→16, 跟 chromosome 对齐)
const MAX_CELLS_PER_FAMILY = 80;  // 9x9 mask = 80 cells

// ========== WGSL Shaders ==========

/**
 * Batched CA step shader
 *
 * Bindings:
 *   0: storage<read>      gridsIn       [numRules * numSeeds * W * H] u32 (1 cell/word)
 *   1: storage<read_write> gridsOut      [numRules * numSeeds * W * H] u32
 *   2: storage<read>      ruleParams    [numRules * MAX_FAMILIES * 6] u32
 *                                          fields per family: cellsMaskLo, cellsMaskHi, cellsMaskHi2, birthMask, surviveMask, priority
 *   3: uniform            uniforms      {W, H, numSeeds, numRules, numActiveFamiliesPerRule[numRules], topologyType, defaultState}
 *
 * Note: numActiveFamiliesPerRule is an array but uniforms must be a single struct.
 * Solution: Pad ruleParams with empty family slots (zero out for inactive).
 */
const BATCHED_CA_STEP_SHADER = /* wgsl */`
struct FamilyParams {
  cellsMaskLo: u32,
  cellsMaskHi: u32,
  cellsMaskHi2: u32,
  birthMask: u32,
  surviveMask: u32,
  priority: u32,
}

struct BatchedUniforms {
  gridWidth: u32,
  gridHeight: u32,
  numSeeds: u32,
  numRules: u32,
  topologyType: u32,
  defaultState: u32,
  numActiveFamilies: u32,    // global cap (MAX_FAMILIES = 16); per-rule filtering via priority==0
  pad0: u32,
}

@group(0) @binding(0) var<storage, read> gridsIn: array<u32>;
@group(0) @binding(1) var<storage, read_write> gridsOut: array<u32>;
@group(0) @binding(2) var<storage, read> ruleParams: array<u32>;  // flat [numRules * MAX_FAMILIES * 6]
@group(0) @binding(3) var<uniform> uniforms: BatchedUniforms;

/**
 * Test if cell (dx, dy) is in family at offset famOffset (where famOffset = famIdx * 6 within a rule)
 */
fn cellInFamilyBatched(dx: i32, dy: i32, famOffset: u32) -> bool {
  if (dx == 0 && dy == 0) { return false; }
  let ddx = dx + 4;
  let ddy = dy + 4;
  var bitIdx = ddy * 9 + ddx;
  if (bitIdx > 40) { bitIdx = bitIdx - 1; }
  var mask: u32;
  if (bitIdx < 32) {
    mask = ruleParams[famOffset + 0u];
  } else if (bitIdx < 64) {
    mask = ruleParams[famOffset + 1u];
  } else {
    mask = ruleParams[famOffset + 2u];
  }
  let bit = u32(bitIdx % 32);
  return ((mask >> bit) & 1u) == 1u;
}

/**
 * Count active neighbors for rule[ruleIdx] at (cx, cy) in seed's grid,
 * restricted to family famIdx's cell mask.
 */
fn countActiveFamilyBatched(cx: i32, cy: i32, ruleIdx: u32, seedIdx: u32, famIdx: u32) -> u32 {
  let cellsPerSeed = uniforms.gridWidth * uniforms.gridHeight;
  let cellOffset = (ruleIdx * uniforms.numSeeds + seedIdx) * cellsPerSeed;
  let famOffset = ruleIdx * ${MAX_FAMILIES}u * 6u + famIdx * 6u;
  var count = 0u;

  for (var dy = -4; dy <= 4; dy = dy + 1) {
    for (var dx = -4; dx <= 4; dx = dx + 1) {
      if (!cellInFamilyBatched(dx, dy, famOffset)) { continue; }
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
      let cellIdx = cellOffset + u32(ny) * uniforms.gridWidth + u32(nx);
      if (gridsIn[cellIdx] > 0u) {
        count = count + 1u;
      }
    }
  }
  return count;
}

/**
 * Get self state at (cx, cy) for rule[ruleIdx] seed[seedIdx]
 */
fn getSelfBatched(cx: i32, cy: i32, ruleIdx: u32, seedIdx: u32) -> u32 {
  let cellsPerSeed = uniforms.gridWidth * uniforms.gridHeight;
  let cellOffset = (ruleIdx * uniforms.numSeeds + seedIdx) * cellsPerSeed;
  if (cx < 0 || cx >= i32(uniforms.gridWidth) || cy < 0 || cy >= i32(uniforms.gridHeight)) {
    return u32(uniforms.defaultState);
  }
  let cellIdx = cellOffset + u32(cy) * uniforms.gridWidth + u32(cx);
  return gridsIn[cellIdx];
}

/**
 * Set cell at (cx, cy) for rule[ruleIdx] seed[seedIdx]
 */
fn setOutBatched(cx: i32, cy: i32, val: u32, ruleIdx: u32, seedIdx: u32) {
  let cellsPerSeed = uniforms.gridWidth * uniforms.gridHeight;
  let cellOffset = (ruleIdx * uniforms.numSeeds + seedIdx) * cellsPerSeed;
  if (cx < 0 || cx >= i32(uniforms.gridWidth) || cy < 0 || cy >= i32(uniforms.gridHeight)) {
    return;
  }
  let cellIdx = cellOffset + u32(cy) * uniforms.gridWidth + u32(cx);
  gridsOut[cellIdx] = val;
}

@compute @workgroup_size(16, 16, 1)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  // wid.z = ruleIdx * numSeeds + seedIdx (combined)
  let combined = wid.z;
  let numSeeds = uniforms.numSeeds;
  let ruleIdx = combined / numSeeds;
  let seedIdx = combined % numSeeds;
  if (ruleIdx >= uniforms.numRules) { return; }

  let baseX = wid.x * 16u + lid.x;
  let baseY = wid.y * 16u + lid.y;
  if (baseX >= uniforms.gridWidth || baseY >= uniforms.gridHeight) { return; }

  // Get self state
  let self_ = getSelfBatched(i32(baseX), i32(baseY), ruleIdx, seedIdx);

  // Iterate families by priority order; first match wins (matches original semantics)
  let ruleOffset = ruleIdx * ${MAX_FAMILIES}u * 6u;
  var matched = 0u;
  var nextVal = 0u;

  for (var fi = 0u; fi < uniforms.numActiveFamilies; fi = fi + 1u) {
    let famOffset = ruleOffset + fi * 6u;
    let priority = ruleParams[famOffset + 5u];
    if (priority == 0u) { continue; }  // inactive family

    // Per-family neighbor count (matches original GPU engine semantics)
    let n = countActiveFamilyBatched(i32(baseX), i32(baseY), ruleIdx, seedIdx, fi);

    var triggered = false;
    // n>31 → mask only has bits 0..31 (shift UB). CPU 行为: n 不在 0..8 范围 → fall through → dead.
    // 旧 GPU 错误地查 birth[0]/survive[0] (safeN=0),跟 CPU 分裂。修复: n>31 时这个 family 不触发。
    if (n <= 31u) {
      if (self_ == 0u) {
        if (((ruleParams[famOffset + 3u] >> n) & 1u) == 1u) {  // birthMask
          triggered = true;
        }
      } else {
        if (((ruleParams[famOffset + 4u] >> n) & 1u) == 1u) {  // surviveMask
          triggered = true;
        }
      }
    }

    if (triggered) {
      matched = 1u;
      nextVal = 1u;
      break;
    }
  }

  // Default: dead cell stays dead; live cell dies if no family matched
  if (matched == 0u && self_ > 0u) {
    nextVal = 0u;
  }

  setOutBatched(i32(baseX), i32(baseY), nextVal, ruleIdx, seedIdx);
}
`;

// ========== JS Engine ==========

export class BatchedGPUEngine {
  constructor() {
    this.device = null;
    this.queue = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.uniformBuffer = null;
    this.uniformSize = 0;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return { ok: true };
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return { ok: false, error: 'WebGPU not supported' };
    }
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { ok: false, error: 'No GPU adapter' };
      this.device = await adapter.requestDevice();
      this.queue = this.device.queue;

      this.device.onuncapturederror = (event) => {
        console.error('[BatchedGPU uncaptured error]', event.error?.message || event);
      };

      const shaderModule = this.device.createShaderModule({ code: BATCHED_CA_STEP_SHADER });
      const compileInfo = await shaderModule.getCompilationInfo();
      if (compileInfo.messages && compileInfo.messages.length > 0) {
        for (const msg of compileInfo.messages) {
          if (msg.type === 'error') {
            console.error('[BatchedGPU shader error]', msg.message, 'line', msg.lineNum, 'col', msg.linePos);
          }
        }
      }

      this.bindGroupLayout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
      });

      this.pipeline = this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
        compute: { module: shaderModule, entryPoint: 'main' },
      });

      // Uniform: BatchedUniforms = 8 u32 = 32 bytes
      this.uniformSize = 32;
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
   * 编码 N 个 rules 为 GPU ruleParams storage buffer
   * @param {Array<object>} rules - [{families, topology, defaultState}, ...]
   * @returns {ArrayBuffer} u32 flat array, size = numRules * MAX_FAMILIES * 6 * 4 bytes
   */
  encodeRules(rules) {
    const numRules = rules.length;
    const totalU32 = numRules * MAX_FAMILIES * 6;
    const arr = new Uint32Array(totalU32);

    for (let r = 0; r < numRules; r++) {
      const rule = rules[r];
      const families = (rule.families || [])
        .filter(f => f && f.cells && f.cells.length > 0)
        .sort((a, b) => a.priority - b.priority)
        .slice(0, MAX_FAMILIES);

      for (let i = 0; i < MAX_FAMILIES; i++) {
        const offset = (r * MAX_FAMILIES + i) * 6;
        if (i < families.length) {
          const fam = families[i];
          let cellsMaskLo = 0, cellsMaskHi = 0, cellsMaskHi2 = 0;
          for (const { dx, dy } of fam.cells) {
            if (dx === 0 && dy === 0) continue;
            if (dx < -4 || dx > 4 || dy < -4 || dy > 4) continue;
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
          arr[offset + 0] = cellsMaskLo;
          arr[offset + 1] = cellsMaskHi;
          arr[offset + 2] = cellsMaskHi2;
          arr[offset + 3] = birthMask;
          arr[offset + 4] = surviveMask;
          arr[offset + 5] = fam.priority || 1;
        } else {
          // Inactive: priority=0, all masks=0
          arr[offset + 0] = 0;
          arr[offset + 1] = 0;
          arr[offset + 2] = 0;
          arr[offset + 3] = 0;
          arr[offset + 4] = 0;
          arr[offset + 5] = 0;
        }
      }
    }

    return arr.buffer;
  }

  /**
   * 跑 N 个 rules × M seeds × steps
   * @param {object} opts
   * @param {Uint32Array} opts.ruleParams - flat [numRules * MAX_FAMILIES * 6] u32
   * @param {Uint8Array} opts.initialGrids - [numRules * numSeeds * W * H] u8
   * @param {number} opts.width
   * @param {number} opts.height
   * @param {number} opts.numSeeds
   * @param {number} opts.numRules
   * @param {number} opts.steps
   * @param {number} opts.topologyType 0=bounded, 1=toroidal
   * @param {number} opts.defaultState
   * @returns {Promise<{finalGrids: Uint8Array, gpuTimeMs: number}>}
   */
  async runBatchedSteps({ ruleParams, initialGrids, width, height, numSeeds, numRules, steps, topologyType = 0, defaultState = 0 }) {
    const cellsPerSeed = width * height;
    const totalCells = numRules * numSeeds * cellsPerSeed;
    const bufferSize = totalCells * 4;

    // Create ping-pong buffers
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
    const ruleBuf = this.device.createBuffer({
      size: ruleParams.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Pack initial grids: 1 cell per u32 word
    const packedInit = new Uint32Array(totalCells);
    for (let i = 0; i < totalCells; i++) {
      packedInit[i] = initialGrids[i] || 0;
    }
    this.queue.writeBuffer(bufA, 0, packedInit);
    this.queue.writeBuffer(ruleBuf, 0, ruleParams);

    // Update uniforms
    const uniformsU32 = new Uint32Array(this.uniformSize / 4);
    uniformsU32[0] = width;
    uniformsU32[1] = height;
    uniformsU32[2] = numSeeds;
    uniformsU32[3] = numRules;
    uniformsU32[4] = topologyType;
    uniformsU32[5] = defaultState;
    uniformsU32[6] = MAX_FAMILIES;
    uniformsU32[7] = 0;
    this.queue.writeBuffer(this.uniformBuffer, 0, uniformsU32);

    const makeBindGroup = (inBuf, outBuf) => this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: inBuf } },
        { binding: 1, resource: { buffer: outBuf } },
        { binding: 2, resource: { buffer: ruleBuf } },
        { binding: 3, resource: { buffer: this.uniformBuffer } },
      ],
    });

    const workgroupCountX = Math.ceil(width / 16);
    const workgroupCountY = Math.ceil(height / 16);
    const workgroupCountZ = numRules * numSeeds;

    const t0 = performance.now();
    for (let step = 0; step < steps; step++) {
      const inBuf = (step % 2 === 0) ? bufA : bufB;
      const outBuf = (step % 2 === 0) ? bufB : bufA;
      const bindGroup = makeBindGroup(inBuf, outBuf);

      const commandEncoder = this.device.createCommandEncoder();
      const passEncoder = commandEncoder.beginComputePass();
      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.dispatchWorkgroups(workgroupCountX, workgroupCountY, workgroupCountZ);
      passEncoder.end();
      this.queue.submit([commandEncoder.finish()]);
    }

    const finalBuf = (steps % 2 === 0) ? bufA : bufB;
    const readCommandEncoder = this.device.createCommandEncoder();
    readCommandEncoder.copyBufferToBuffer(finalBuf, 0, readBuf, 0, bufferSize);
    this.queue.submit([readCommandEncoder.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint32Array(readBuf.getMappedRange());
    const finalGrids = new Uint8Array(totalCells);
    for (let i = 0; i < totalCells; i++) {
      finalGrids[i] = mapped[i] > 0 ? 1 : 0;
    }
    readBuf.unmap();
    const t1 = performance.now();

    bufA.destroy();
    bufB.destroy();
    readBuf.destroy();
    ruleBuf.destroy();

    return {
      finalGrids,
      gpuTimeMs: t1 - t0,
    };
  }

  /**
   * 单 rule 包装器 — 让 renderBestRule 等单 rule 调用也能复用 BatchedGPUEngine
   * 内部走 batched path with numRules=1
   */
  encodeRuleToUniform(rule) {
    const ruleParams = this.encodeRules([rule]);
    return ruleParams;
  }

  async runSteps({ uniformsBuf, initialGrids, width, height, numSeeds = 1, steps }) {
    // uniformsBuf 实际是 flat ruleParams (1 rule × 4 families × 6 u32)
    // initialGrids 是 [numSeeds × W × H]
    const result = await this.runBatchedSteps({
      ruleParams: uniformsBuf,
      initialGrids,
      width,
      height,
      numSeeds,
      numRules: 1,
      steps,
    });
    return result;
  }

  destroy() {
    if (this.uniformBuffer) this.uniformBuffer.destroy();
    if (this.device) this.device.destroy();
  }
}