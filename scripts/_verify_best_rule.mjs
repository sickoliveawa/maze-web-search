// 用 Node.js 跑 ES best rule 验证 CA simulator
// 加载 src 里所有必要模块
import { mazeQuality, _generateSpiral, _generateDFSMaze, _generateFractalTree, _generateRandomNoise, _generateStripes } from '../src/metrics/maze_quality.js';
import { Family } from '../src/core/family.js';
import { Rule } from '../src/core/rule.js';
import { Topology } from '../src/core/topology.js';
import fs from 'node:fs';

function decodeFamilies(bits, maskType) {
  const MAX_DX=4, MAX_DY=4, MAX_CELLS=80, MAX_BIRTH=9, MAX_SURVIVE=9, PRI=4;
  const SLOT = 1+MAX_CELLS+MAX_BIRTH+MAX_SURVIVE+PRI;
  const ACTIVE=0, BIRTH=1+MAX_CELLS, SURVIVE=1+MAX_CELLS+MAX_BIRTH, PRIO=1+MAX_CELLS+MAX_BIRTH+MAX_SURVIVE;
  const inRange = (dx,dy,mt) => {
    if (mt?.startsWith?.('chebyshev-')) { const N = parseInt(mt.split('-')[1]); return Math.max(Math.abs(dx), Math.abs(dy)) <= N; }
    if (mt?.startsWith?.('manhattan-')) { const N = parseInt(mt.split('-')[1]); return Math.abs(dx)+Math.abs(dy) <= N; }
    return true;
  };
  const fams = [];
  for (let i = 0; i < 16; i++) {
    const s = i*SLOT;
    if (bits[s] === 0) continue;
    const cells = [];
    let bi = 0;
    for (let dy = -MAX_DY; dy <= MAX_DY; dy++) for (let dx = -MAX_DX; dx <= MAX_DX; dx++) {
      if (dx === 0 && dy === 0) { bi++; continue; }
      if (bits[s+1+bi] === 1 && inRange(dx, dy, maskType)) cells.push({dx, dy});
      bi++;
    }
    const birth = []; for (let n = 0; n < MAX_BIRTH; n++) if (bits[s+BIRTH+n]===1) birth.push(n);
    const surv = [];  for (let n = 0; n < MAX_SURVIVE; n++) if (bits[s+SURVIVE+n]===1) surv.push(n);
    let p = 0; for (let pp = 0; pp < PRI; pp++) p |= (bits[s+PRIO+pp] << pp);
    p = Math.max(1, Math.min(16, p || 1));
    fams.push(new Family({ id: `fam_${i}`, name: `fam_${i}`, priority: p, cells, birth, survive: surv }));
  }
  fams.sort((a,b) => a.priority - b.priority);
  return fams;
}

// Multi-family CA step (matches gpu_engine_batched.js)
function stepCA(grid, fams, W, H, boundary=0) {
  const newGrid = new Uint8Array(grid.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y*W+x;
      const cur = grid[idx];
      for (const fam of fams) {
        let cnt = 0;
        for (const {dx, dy} of fam.cells) {
          const nx = x+dx, ny = y+dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) cnt += grid[ny*W+nx];
          else cnt += boundary;
        }
        if (cur === 0) {
          if (fam.birth.includes(cnt)) { newGrid[idx] = 1; break; }
        } else {
          if (fam.survive.includes(cnt)) { newGrid[idx] = 1; break; }
        }
      }
    }
  }
  return newGrid;
}

function initFullScreen(W, H, density, seed) {
  let s = seed >>> 0 || 1;
  function nextFloat() { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  const grid = new Uint8Array(W*H);
  for (let i = 0; i < grid.length; i++) grid[i] = nextFloat() < density ? 1 : 0;
  return grid;
}

const ckpt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const bits = ckpt.bestChromBits;
const cfg = ckpt.config;
const maskType = cfg.cellMaskType;
const fams = decodeFamilies(bits, maskType);
console.log(`rule: ${cfg.cellMaskType} mf=${cfg.maxFamilies} s=${cfg.randomSeed} score=${ckpt.bestScore.toFixed(4)}`);
console.log(`active families: ${fams.length}`);
for (const f of fams) {
  console.log(`  pri=${String(f.priority).padStart(2)} cells=${f.cells.length} B=${JSON.stringify(f.birth)} S=${JSON.stringify(f.survive)}`);
}

// withInvert: try both original AND inverted, take max score
let best_q = { total: -1 };
let best_grid = null;
let best_label = '';
let best_density = 0;
for (const sd of [444, 42, 1, 2, 3, 17, 99, 100, 20260627]) {
  let grid = initFullScreen(cfg.gridW, cfg.gridH, cfg.initDensity, sd);
  for (let s = 0; s < cfg.caSteps; s++) grid = stepCA(grid, fams, cfg.gridW, cfg.gridH, 0);
  const live = Array.from(grid).reduce((a,b)=>a+b, 0);
  const density = live / grid.length;
  const q = mazeQuality(grid, cfg.gridW, cfg.gridH);
  // Try inverted too
  const invGrid = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) invGrid[i] = grid[i] === 0 ? 1 : 0;
  const qInv = mazeQuality(invGrid, cfg.gridW, cfg.gridH);
  const dualScore = Math.max(q.total, qInv.total);
  console.log(`seed=${sd} live=${live}=${density.toFixed(3)} mq=${q.total.toFixed(4)} (inv=${qInv.total.toFixed(4)}) dual=${dualScore.toFixed(4)} wr=${q.breakdown.M_wall_ratio.toFixed(3)}`);
  if (dualScore > best_q.total) {
    best_q = q.total > qInv.total ? q : qInv;
    best_grid = q.total > qInv.total ? grid : invGrid;
    best_label = q.total > qInv.total ? 'ori' : 'inv';
    best_density = q.total > qInv.total ? density : 1 - density;
  }
  // Save final-eval grid (use last seed 444 for snapshot)
  if (sd === 444) {
    fs.writeFileSync(`/tmp/best_grid_${maskType}_ori.json`, JSON.stringify({grid: Array.from(grid), W: cfg.gridW, H: cfg.gridH, seed: sd, mq: q.total, breakdown: q.breakdown}));
    fs.writeFileSync(`/tmp/best_grid_${maskType}_inv.json`, JSON.stringify({grid: Array.from(invGrid), W: cfg.gridW, H: cfg.gridH, seed: sd, mq: qInv.total, breakdown: qInv.breakdown}));
  }
}
console.log(`\nbest dual: ${best_q.total.toFixed(4)} (${best_label}) density=${best_density.toFixed(3)}`);