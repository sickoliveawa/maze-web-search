
import { mazeQuality, _generateDFSMaze, _generateSpiral, _generateFractalTree, _generateRandomNoise, _generateStripes } from '../src/metrics/maze_quality.js';

const W = 31, H = 31;

function bellotF(gridData, width, height) {
  const visited = new Uint8Array(width*height);
  let largest = 0, totalRoads = 0;
  for (let i = 0; i < gridData.length; i++) {
    totalRoads += gridData[i] > 0 ? 1 : 0;
    if (visited[i] || gridData[i] === 0) continue;
    let sz = 0; const q = [i]; visited[i] = 1;
    while (q.length) { const c = q.shift(); sz++;
      const x = c%width, y = (c-x)/width;
      if (x > 0 && gridData[c-1]>0 && !visited[c-1]) { visited[c-1]=1; q.push(c-1); }
      if (x < width-1 && gridData[c+1]>0 && !visited[c+1]) { visited[c+1]=1; q.push(c+1); }
      if (y > 0 && gridData[c-width]>0 && !visited[c-width]) { visited[c-width]=1; q.push(c-width); }
      if (y < height-1 && gridData[c+width]>0 && !visited[c+width]) { visited[c+width]=1; q.push(c+width); }
    }
    if (sz > largest) largest = sz;
  }
  const largestRatio = totalRoads > 0 ? largest / totalRoads : 0;
  if (totalRoads === 0) return { F: 0, d: 0, largestRatio };
  const roadCoords = [];
  for (let i = 0; i < gridData.length; i++) if (gridData[i] > 0) roadCoords.push(i);
  const start = roadCoords[0];
  const dist = new Int32Array(width*height).fill(-1);
  const q = [start]; dist[start] = 0; let far = start;
  while (q.length) { const c = q.shift(); if (dist[c] > dist[far]) far = c;
    const x = c%width, y = (c-x)/width;
    if (x > 0 && gridData[c-1]>0 && dist[c-1]<0) { dist[c-1] = dist[c]+1; q.push(c-1); }
    if (x < width-1 && gridData[c+1]>0 && dist[c+1]<0) { dist[c+1] = dist[c]+1; q.push(c+1); }
    if (y > 0 && gridData[c-width]>0 && dist[c-width]<0) { dist[c-width] = dist[c]+1; q.push(c-width); }
    if (y < height-1 && gridData[c+width]>0 && dist[c+width]<0) { dist[c+width] = dist[c]+1; q.push(c+width); }
  }
  const far2 = far; const d2 = new Int32Array(width*height).fill(-1); d2[far2]=0;
  const q2 = [far2]; let far3 = far2;
  while (q2.length) { const c = q2.shift(); if (d2[c] > d2[far3]) far3 = c;
    const x = c%width, y = (c-x)/width;
    if (x > 0 && gridData[c-1]>0 && d2[c-1]<0) { d2[c-1] = d2[c]+1; q2.push(c-1); }
    if (x < width-1 && gridData[c+1]>0 && d2[c+1]<0) { d2[c+1] = d2[c]+1; q2.push(c+1); }
    if (y > 0 && gridData[c-width]>0 && d2[c-width]<0) { d2[c-width] = d2[c]+1; q2.push(c-width); }
    if (y < height-1 && gridData[c+width]>0 && d2[c+width]<0) { d2[c+width] = d2[c]+1; q2.push(c+width); }
  }
  const d = d2[far3];
  const roadFrac = totalRoads / (width*height);
  const nu = 1 - roadFrac;
  const F = nu / Math.max(0.5, d/200);
  return { F, d, largestRatio, roadFrac };
}

// All generators should produce 1=road convention (bellot style)
function makeDFS(width, height, seed = 42) {
  if (width % 2 === 0) width++; if (height % 2 === 0) height++;
  const grid = new Uint8Array(width*height).fill(1); // 1=wall
  const visited = new Uint8Array(width*height);
  let s = seed;
  const rand = () => { s = (s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
  const carve = (x, y) => {
    visited[y*width+x] = 1; grid[y*width+x] = 0;  // 0=road
    const dirs = [[0,-2],[2,0],[0,2],[-2,0]];
    for (let i = dirs.length-1; i > 0; i--) { const j = Math.floor(rand()*(i+1)); [dirs[i],dirs[j]] = [dirs[j],dirs[i]]; }
    for (const [dx,dy] of dirs) {
      const nx = x+dx, ny = y+dy;
      if (nx <= 0 || nx >= width-1 || ny <= 0 || ny >= height-1) continue;
      if (visited[ny*width+nx]) continue;
      grid[((y+ny)/2)*width + (x+nx)/2] = 0;
      carve(nx, ny);
    }
  };
  carve(1, 1);
  // invert: 0=road → 1=road
  const bellot = new Uint8Array(width*height);
  for (let i = 0; i < grid.length; i++) bellot[i] = grid[i] === 0 ? 1 : 0;
  return bellot;
}

function makePrim(width, height, seed = 42) {
  const cellW = Math.floor(width/2), cellH = Math.floor(height/2);
  const grid = new Uint8Array(width*height).fill(1); // 1=wall
  let s = seed;
  const rand = () => { s = (s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
  const visited = new Uint8Array(cellW*cellH);
  grid[1*width+1] = 0; // 0=road
  visited[0] = 1;
  const walls = [[0,0,1,0],[0,0,0,1]];
  while (walls.length) {
    const idx = Math.floor(rand() * walls.length);
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
  // invert
  const bellot = new Uint8Array(width*height);
  for (let i = 0; i < grid.length; i++) bellot[i] = grid[i] === 0 ? 1 : 0;
  return bellot;
}

function makeKruskal(width, height, seed = 42) {
  const cellW = Math.floor(width/2), cellH = Math.floor(height/2);
  const grid = new Uint8Array(width*height).fill(1);
  let s = seed;
  const rand = () => { s = (s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
  const parent = new Int32Array(cellW*cellH);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const edges = [];
  for (let cy = 0; cy < cellH; cy++) for (let cx = 0; cx < cellW; cx++) {
    if (cx < cellW-1) edges.push([cx, cy, 1, 0]);
    if (cy < cellH-1) edges.push([cx, cy, 0, 1]);
  }
  for (let i = edges.length-1; i > 0; i--) { const j = Math.floor(rand()*(i+1)); [edges[i],edges[j]] = [edges[j],edges[i]]; }
  for (const [cx, cy, dx, dy] of edges) {
    const a = find(cy*cellW+cx), b = find((cy+dy)*cellW+(cx+dx));
    if (a === b) continue;
    parent[a] = b;
    grid[(2*cy+1)*width + (2*cx+1)] = 0;
    grid[(2*(cy+dy)+1)*width + (2*(cx+dx)+1)] = 0;
    grid[(2*cy+1+dy)*width + (2*cx+1+dx)] = 0;
  }
  const bellot = new Uint8Array(width*height);
  for (let i = 0; i < grid.length; i++) bellot[i] = grid[i] === 0 ? 1 : 0;
  return bellot;
}

function makeBinaryTree(width, height, seed = 42) {
  const cellW = Math.floor(width/2), cellH = Math.floor(height/2);
  const grid = new Uint8Array(width*height).fill(1);
  let s = seed;
  const rand = () => { s = (s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
  for (let cy = 0; cy < cellH; cy++) {
    for (let cx = 0; cx < cellW; cx++) {
      grid[(2*cy+1)*width + (2*cx+1)] = 0;
      if (cy > 0 && (cx === cellW-1 || rand() < 0.5)) {
        grid[(2*cy+1-1)*width + (2*cx+1)] = 0;
      } else if (cx < cellW-1) {
        grid[(2*cy+1)*width + (2*cx+1+1)] = 0;
      }
    }
  }
  const bellot = new Uint8Array(width*height);
  for (let i = 0; i < grid.length; i++) bellot[i] = grid[i] === 0 ? 1 : 0;
  return bellot;
}

function makeSidewinder(width, height, seed = 42) {
  const cellW = Math.floor(width/2), cellH = Math.floor(height/2);
  const grid = new Uint8Array(width*height).fill(1);
  let s = seed;
  const rand = () => { s = (s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
  for (let cy = 0; cy < cellH; cy++) {
    let runStart = 0;
    for (let cx = 0; cx < cellW; cx++) {
      grid[(2*cy+1)*width + (2*cx+1)] = 0;
      const atEastBorder = cx === cellW - 1;
      const atNorthRow = cy === 0;
      const closeOut = atEastBorder || (!atNorthRow && rand() < 0.5);
      if (closeOut) {
        if (!atNorthRow) {
          const cellXInRun = runStart + Math.floor(rand()*(cx-runStart+1));
          grid[(2*cy+1-1)*width + (2*cellXInRun+1)] = 0;
        }
        runStart = cx + 1;
      } else {
        grid[(2*cy+1)*width + (2*cx+1+1)] = 0;
      }
    }
  }
  const bellot = new Uint8Array(width*height);
  for (let i = 0; i < grid.length; i++) bellot[i] = grid[i] === 0 ? 1 : 0;
  return bellot;
}

function makeGrowingTree(width, height, seed = 42) {
  const cellW = Math.floor(width/2), cellH = Math.floor(height/2);
  const grid = new Uint8Array(width*height).fill(1);
  let s = seed;
  const rand = () => { s = (s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
  const visited = new Uint8Array(cellW*cellH);
  const active = [];
  const startCx = Math.floor(rand()*cellW), startCy = Math.floor(rand()*cellH);
  visited[startCy*cellW+startCx] = 1;
  grid[(2*startCy+1)*width + (2*startCx+1)] = 0;
  active.push([startCx, startCy]);
  while (active.length) {
    const idx = Math.floor(rand()*active.length);
    const [cx, cy] = active[idx];
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    const candidates = [];
    for (const [dx,dy] of dirs) {
      const nx = cx+dx, ny = cy+dy;
      if (nx>=0 && nx<cellW && ny>=0 && ny<cellH && !visited[ny*cellW+nx]) candidates.push([nx, ny, dx, dy]);
    }
    if (candidates.length === 0) { active.splice(idx, 1); continue; }
    const [nx, ny, dx, dy] = candidates[Math.floor(rand()*candidates.length)];
    visited[ny*cellW+nx] = 1;
    grid[(2*ny+1)*width + (2*nx+1)] = 0;
    grid[(2*cy+1+dy)*width + (2*cx+1+dx)] = 0;
    active.push([nx, ny]);
  }
  const bellot = new Uint8Array(width*height);
  for (let i = 0; i < grid.length; i++) bellot[i] = grid[i] === 0 ? 1 : 0;
  return bellot;
}

function makeCheckerboard(width, height) {
  const g = new Uint8Array(width*height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) g[y*width+x] = (x+y) % 2;
  return g;
}
function makeDiagonalStripes(width, height) {
  const g = new Uint8Array(width*height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) g[y*width+x] = (x+y) % 3 === 0 ? 1 : 0;
  return g;
}
function makeConcentric(width, height) {
  const g = new Uint8Array(width*height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const d = Math.min(x, y, width-1-x, height-1-y);
    g[y*width+x] = (d % 4 < 2) ? 1 : 0;
  }
  return g;
}
function makeHoneycomb(width, height) {
  const g = new Uint8Array(width*height).fill(1);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if ((x%3 === 0) || (y%3 === 0)) g[y*width+x] = 0;
  }
  return g;
}

const patterns = [
  // 6 TRUE — 强制 1=road bellot convention
  { name: 'Recursive Backtrack', type: 'TRUE',   gen: () => makeDFS(W, H, 42) },
  { name: 'Prim',               type: 'TRUE',   gen: () => makePrim(W, H, 42) },
  { name: 'Kruskal',            type: 'TRUE',   gen: () => makeKruskal(W, H, 42) },
  { name: 'Binary Tree',        type: 'TRUE',   gen: () => makeBinaryTree(W, H, 42) },
  { name: 'Sidewinder',         type: 'TRUE',   gen: () => makeSidewinder(W, H, 42) },
  { name: 'Growing Tree',       type: 'TRUE',   gen: () => makeGrowingTree(W, H, 42) },
  // 9 PSEUDO
  { name: 'Spiral',             type: 'PSEUDO', gen: () => _generateSpiral(W, H) },
  { name: 'Fractal Tree',       type: 'PSEUDO', gen: () => _generateFractalTree(W, H) },
  { name: 'Horizontal Stripes', type: 'PSEUDO', gen: () => _generateStripes(W, H) },
  { name: 'Random Noise 50%',   type: 'PSEUDO', gen: () => _generateRandomNoise(W, H, 0.5) },
  { name: 'Random Noise 30%',   type: 'PSEUDO', gen: () => _generateRandomNoise(W, H, 0.30) },
  { name: 'Checkerboard',       type: 'PSEUDO', gen: () => makeCheckerboard(W, H) },
  { name: 'Diagonal Stripes',   type: 'PSEUDO', gen: () => makeDiagonalStripes(W, H) },
  { name: 'Concentric Rings',   type: 'PSEUDO', gen: () => makeConcentric(W, H) },
  { name: 'Honeycomb',          type: 'PSEUDO', gen: () => makeHoneycomb(W, H) },
];

console.log('\n=== maze_quality v4 vs Bellot F: 6 TRUE + 9 PSEUDO (31x31, 1=road convention) ===');
console.log('rank | name                 | type   | mq    | wall_r | M_top | M_div | bellotF | largestR');
console.log('-'.repeat(95));
const results = [];
for (const p of patterns) {
  const data = p.gen();
  const q = mazeQuality(data, W, H);
  const f = bellotF(data, W, H);
  results.push({ name: p.name, type: p.type, mq: q.total,
    wall_ratio: q.breakdown.M_wall_ratio,
    M_topology: q.breakdown.M_topology,
    M_diversity: q.breakdown.M_diversity,
    bellotF: f.F, largestRatio: f.largestRatio });
}
results.sort((a,b) => b.mq - a.mq);
results.forEach((r, i) => {
  console.log(`${String(i+1).padStart(3)} | ${r.name.padEnd(20)} | ${r.type.padEnd(6)} | ${r.mq.toFixed(3)} | ${r.wall_ratio.toFixed(2)}    | ${r.M_topology.toFixed(3)} | ${r.M_diversity.toFixed(3)} | ${r.bellotF.toFixed(3)}  | ${r.largestRatio.toFixed(2)}`);
});

const avg = (arr, key) => arr.length ? arr.reduce((a,r) => a + r[key], 0) / arr.length : 0;
const trueR = results.filter(r => r.type === 'TRUE');
const pseudoR = results.filter(r => r.type === 'PSEUDO');
console.log(`\n=== Discrimination (TRUE vs PSEUDO) ===`);
console.log(`maze_quality: TRUE mean=${avg(trueR,'mq').toFixed(3)}, PSEUDO mean=${avg(pseudoR,'mq').toFixed(3)}, gap=${(avg(trueR,'mq')-avg(pseudoR,'mq')).toFixed(3)}`);
console.log(`Bellot F:     TRUE mean=${avg(trueR,'bellotF').toFixed(3)}, PSEUDO mean=${avg(pseudoR,'bellotF').toFixed(3)}, gap=${(avg(trueR,'bellotF')-avg(pseudoR,'bellotF')).toFixed(3)} (lower=真)`);

// Misclassifications
console.log(`\n=== Misclassifications ===`);
// For maze_quality: PSEUDO with high score (>= some threshold)
const pseudo_high_mq = pseudoR.filter(r => r.mq > 0.5);
console.log(`maze_quality: PSEUDO with mq > 0.5: ${pseudo_high_mq.length} (${pseudo_high_mq.map(r=>r.name).join(', ') || 'none'})`);
// For Bellot F (lower=真): PSEUDO with low F
const pseudo_low_F = pseudoR.filter(r => r.bellotF < 0.5);
console.log(`Bellot F: PSEUDO with F < 0.5: ${pseudo_low_F.length} (${pseudo_low_F.map(r=>r.name).join(', ') || 'none'})`);
