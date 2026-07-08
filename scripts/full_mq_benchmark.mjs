
import { mazeQuality, _generateDFSMaze, _generateSpiral, _generateFractalTree, _generateRandomNoise, _generateStripes } from '../src/metrics/maze_quality.js';
import { SeededRandom } from '../src/core/random.js';

const W = 31, H = 31;

// Port generators from compare_pseudo_vs_true.mjs
function generateRecursiveBacktracking(width, height, rng) {
  const cellW = Math.floor(width / 2), cellH = Math.floor(height / 2);
  const visited = new Uint8Array(cellW * cellH);
  const grid = new Uint8Array(width * height).fill(1);  // 1=wall
  const carve = (cx, cy) => {
    visited[cy * cellW + cx] = 1;
    grid[(2*cy+1) * width + (2*cx+1)] = 0;
    const dirs = [[0,-1],[1,0],[0,1],[-1,0]];
    for (let i = dirs.length-1; i > 0; i--) { const j = Math.floor(rng.next()*(i+1)); [dirs[i],dirs[j]] = [dirs[j],dirs[i]]; }
    for (const [dx,dy] of dirs) {
      const nx = cx+dx, ny = cy+dy;
      if (nx < 0 || nx >= cellW || ny < 0 || ny >= cellH) continue;
      if (visited[ny*cellW+nx]) continue;
      grid[(2*cy + 1 + dy) * width + (2*cx + 1 + dx)] = 0;
      carve(nx, ny);
    }
  };
  carve(0, 0);
  return grid;  // 0=road, 1=wall (DFS internal convention)
}

function generatePrim(width, height, rng) {
  const cellW = Math.floor(width/2), cellH = Math.floor(height/2);
  const grid = new Uint8Array(width*height).fill(1);
  const visited = new Uint8Array(cellW*cellH);
  grid[1*width+1] = 0;
  visited[0] = 1;
  const walls = [[0,0,1,0],[0,0,0,1]];
  while (walls.length) {
    const idx = Math.floor(rng.next() * walls.length);
    const [cx, cy, dx, dy] = walls.splice(idx, 1)[0];
    if (visited[(cy+dy)*cellW + (cx+dx)]) continue;
    grid[(2*cy + 1 + dy) * width + (2*cx + 1 + dx)] = 0;
    grid[(2*(cy+dy)+1) * width + (2*(cx+dx)+1)] = 0;
    visited[(cy+dy)*cellW + (cx+dx)] = 1;
    for (const [ddx, ddy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const ncx = cx+dx+ddx, ncy = cy+dy+ddy;
      if (ncx>=0 && ncx<cellW && ncy>=0 && ncy<cellH && !visited[ncy*cellW+ncx]) walls.push([cx+dx, cy+dy, ddx, ddy]);
    }
  }
  return grid;
}

function generateKruskal(width, height, rng) {
  const cellW = Math.floor(width/2), cellH = Math.floor(height/2);
  const grid = new Uint8Array(width*height).fill(1);
  const parent = new Int32Array(cellW*cellH);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const edges = [];
  for (let cy = 0; cy < cellH; cy++) for (let cx = 0; cx < cellW; cx++) {
    if (cx < cellW-1) edges.push([cx, cy, 1, 0]);
    if (cy < cellH-1) edges.push([cx, cy, 0, 1]);
  }
  // Fisher-Yates
  for (let i = edges.length-1; i > 0; i--) { const j = Math.floor(rng.next()*(i+1)); [edges[i],edges[j]] = [edges[j],edges[i]]; }
  for (const [cx, cy, dx, dy] of edges) {
    const a = find(cy*cellW+cx), b = find((cy+dy)*cellW+(cx+dx));
    if (a === b) continue;
    parent[a] = b;
    grid[(2*cy+1)*width + (2*cx+1)] = 0;
    grid[(2*(cy+dy)+1)*width + (2*(cx+dx)+1)] = 0;
    grid[(2*cy+1+dy)*width + (2*cx+1+dx)] = 0;
  }
  return grid;
}

function generateBinaryTree(width, height, rng) {
  const cellW = Math.floor(width/2), cellH = Math.floor(height/2);
  const grid = new Uint8Array(width*height).fill(1);
  for (let cy = 0; cy < cellH; cy++) {
    for (let cx = 0; cx < cellW; cx++) {
      grid[(2*cy+1)*width + (2*cx+1)] = 0;
      // NE bias: pick top OR right
      if (cy > 0 && (cx === cellW-1 || rng.next() < 0.5)) {
        grid[(2*cy+1-1)*width + (2*cx+1)] = 0;
      } else if (cx < cellW-1) {
        grid[(2*cy+1)*width + (2*cx+1+1)] = 0;
      }
    }
  }
  return grid;
}

function generateSidewinder(width, height, rng) {
  const cellW = Math.floor(width/2), cellH = Math.floor(height/2);
  const grid = new Uint8Array(width*height).fill(1);
  for (let cy = 0; cy < cellH; cy++) {
    let runStart = 0;
    for (let cx = 0; cx < cellW; cx++) {
      grid[(2*cy+1)*width + (2*cx+1)] = 0;
      const atEastBorder = cx === cellW - 1;
      const atNorthRow = cy === 0;
      const closeOut = atEastBorder || (!atNorthRow && rng.next() < 0.5);
      if (closeOut) {
        if (!atNorthRow) {
          const cellXInRun = runStart + Math.floor(rng.next()*(cx-runStart+1));
          grid[(2*cy+1-1)*width + (2*cellXInRun+1)] = 0;
        }
        runStart = cx + 1;
      } else {
        grid[(2*cy+1)*width + (2*cx+1+1)] = 0;
      }
    }
  }
  return grid;
}

function generateGrowingTree(width, height, rng) {
  const cellW = Math.floor(width/2), cellH = Math.floor(height/2);
  const grid = new Uint8Array(width*height).fill(1);
  const visited = new Uint8Array(cellW*cellH);
  const active = [];
  const startCx = Math.floor(rng.next()*cellW), startCy = Math.floor(rng.next()*cellH);
  visited[startCy*cellW+startCx] = 1;
  grid[(2*startCy+1)*width + (2*startCx+1)] = 0;
  active.push([startCx, startCy]);
  while (active.length) {
    const idx = Math.floor(rng.next()*active.length);
    const [cx, cy] = active[idx];
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    const candidates = [];
    for (const [dx,dy] of dirs) {
      const nx = cx+dx, ny = cy+dy;
      if (nx>=0 && nx<cellW && ny>=0 && ny<cellH && !visited[ny*cellW+nx]) candidates.push([nx, ny, dx, dy]);
    }
    if (candidates.length === 0) { active.splice(idx, 1); continue; }
    const [nx, ny, dx, dy] = candidates[Math.floor(rng.next()*candidates.length)];
    visited[ny*cellW+nx] = 1;
    grid[(2*ny+1)*width + (2*nx+1)] = 0;
    grid[(2*cy+1+dy)*width + (2*cx+1+dx)] = 0;
    active.push([nx, ny]);
  }
  return grid;
}

function generateCheckerboard(width, height) {
  const g = new Uint8Array(width*height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) g[y*width+x] = (x+y) % 2;
  return g;
}
function generateDiagonalStripes(width, height) {
  const g = new Uint8Array(width*height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) g[y*width+x] = (x+y) % 3 === 0 ? 1 : 0;
  return g;
}
function generateConcentric(width, height) {
  const g = new Uint8Array(width*height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const d = Math.min(x, y, width-1-x, height-1-y);
    g[y*width+x] = (d % 4 < 2) ? 1 : 0;
  }
  return g;
}
function generateHoneycomb(width, height) {
  const g = new Uint8Array(width*height).fill(1);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if ((x%3 === 0) || (y%3 === 0)) g[y*width+x] = 0;
  }
  return g;
}

// =========== Run ============
const patterns = [
  // 6 TRUE
  { name: 'Recursive Backtrack', type: 'TRUE', gen: () => {
    const seedRng = (() => { let s = 42; return { next: () => { s = (s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; }}; })();
    return generateRecursiveBacktracking(W, H, seedRng);
  }},
  { name: 'Prim', type: 'TRUE', gen: () => {
    const seedRng = (() => { let s = 42; return { next: () => { s = (s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; }}; })();
    return generatePrim(W, H, seedRng);
  }},
  { name: 'Kruskal', type: 'TRUE', gen: () => {
    const seedRng = (() => { let s = 42; return { next: () => { s = (s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; }}; })();
    return generateKruskal(W, H, seedRng);
  }},
  { name: 'Binary Tree', type: 'TRUE', gen: () => {
    const seedRng = (() => { let s = 42; return { next: () => { s = (s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; }}; })();
    return generateBinaryTree(W, H, seedRng);
  }},
  { name: 'Sidewinder', type: 'TRUE', gen: () => {
    const seedRng = (() => { let s = 42; return { next: () => { s = (s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; }}; })();
    return generateSidewinder(W, H, seedRng);
  }},
  { name: 'Growing Tree', type: 'TRUE', gen: () => {
    const seedRng = (() => { let s = 42; return { next: () => { s = (s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; }}; })();
    return generateGrowingTree(W, H, seedRng);
  }},
  // 7 PSEUDO
  { name: 'Spiral', type: 'PSEUDO', gen: () => _generateSpiral(W, H) },
  { name: 'Fractal Tree', type: 'PSEUDO', gen: () => _generateFractalTree(W, H) },
  { name: 'Horizontal Stripes', type: 'PSEUDO', gen: () => _generateStripes(W, H) },
  { name: 'Random Noise 50%', type: 'PSEUDO', gen: () => _generateRandomNoise(W, H, 0.5) },
  { name: 'Random Noise 30%', type: 'PSEUDO', gen: () => _generateRandomNoise(W, H, 0.30) },
  { name: 'Checkerboard', type: 'PSEUDO', gen: () => generateCheckerboard(W, H) },
  { name: 'Diagonal Stripes', type: 'PSEUDO', gen: () => generateDiagonalStripes(W, H) },
  { name: 'Concentric Rings', type: 'PSEUDO', gen: () => generateConcentric(W, H) },
  { name: 'Honeycomb', type: 'PSEUDO', gen: () => generateHoneycomb(W, H) },
];

console.log('\n=== maze_quality v4 on 6 TRUE + 9 PSEUDO (31x31) ===');
console.log('name                  | type   | mq   | wall_r | M_top | M_div | WR_gate');
console.log('-'.repeat(85));
const results = [];
for (const p of patterns) {
  let data = p.gen();
  // Most generators output 0=road (DFS internal) — need to invert to bellot convention (1=road)
  // Check convention by counting
  const c0 = Array.from(data.slice(0, 100)).filter(x => x === 0).length;
  if (c0 > 50) {
    // likely 0=road (DFS internal), invert
    const inv = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) inv[i] = data[i] > 0 ? 0 : 1;
    data = inv;
  }
  const q = mazeQuality(data, W, H);
  results.push({ name: p.name, type: p.type, mq: q.total, 
    M_topology: q.breakdown.M_topology, M_diversity: q.breakdown.M_diversity,
    M_WR_gate: q.breakdown.M_WR_gate, wall_ratio: q.breakdown.M_wall_ratio });
  console.log(`${p.name.padEnd(22)} | ${p.type.padEnd(6)} | ${q.total.toFixed(3)} | ${q.breakdown.M_wall_ratio.toFixed(2)}    | ${q.breakdown.M_topology.toFixed(3)} | ${q.breakdown.M_diversity.toFixed(3)} | ${q.breakdown.M_WR_gate.toFixed(2)}`);
}

const avg = (arr, key) => arr.length ? arr.reduce((a,r) => a + r[key], 0) / arr.length : 0;
const trueR = results.filter(r => r.type === 'TRUE');
const pseudoR = results.filter(r => r.type === 'PSEUDO');
console.log(`\nmaze_quality: TRUE mean=${avg(trueR,'mq').toFixed(3)}, PSEUDO mean=${avg(pseudoR,'mq').toFixed(3)}, gap=${(avg(trueR,'mq')-avg(pseudoR,'mq')).toFixed(3)}`);
console.log(`n_true=${trueR.length}, n_pseudo=${pseudoR.length}`);
