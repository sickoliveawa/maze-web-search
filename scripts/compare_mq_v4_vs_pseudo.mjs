
/**
 * compare_mq_v4_vs_pseudo.mjs — 用 maze_quality v4 (maze-web 实际版本) 跑 13-pattern
 */
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

const patterns = [
  { name: 'Recursive Backtrack (DFS)', type: 'TRUE',   gen: () => _generateDFSMaze(W, H, 42) },
  { name: 'Spiral',                    type: 'PSEUDO', gen: () => _generateSpiral(W, H) },
  { name: 'Fractal Tree',              type: 'PSEUDO', gen: () => _generateFractalTree(W, H) },
  { name: 'Horizontal Stripes',        type: 'PSEUDO', gen: () => _generateStripes(W, H) },
  { name: 'Random Noise 50%',          type: 'PSEUDO', gen: () => _generateRandomNoise(W, H, 0.5) },
  { name: 'Random Noise 30%',          type: 'PSEUDO', gen: () => _generateRandomNoise(W, H, 0.30) },
  { name: 'All Dead',                  type: 'PSEUDO', gen: () => new Uint8Array(W*H) },
  { name: 'All Alive',                 type: 'PSEUDO', gen: () => new Uint8Array(W*H).fill(1) },
];

const results = [];
for (const p of patterns) {
  const data = p.gen();
  const inv = new Uint8Array(W*H);
  for (let i = 0; i < data.length; i++) inv[i] = data[i] > 0 ? 0 : 1;
  const q_ori = mazeQuality(data, W, H);
  const q_inv = mazeQuality(inv, W, H);
  const mq = Math.max(q_ori.total, q_inv.total);
  const bestQ = q_ori.total >= q_inv.total ? q_ori : q_inv;
  const f = bellotF(data, W, H);
  results.push({
    name: p.name, type: p.type, mq,
    M_topology: bestQ.breakdown.M_topology,
    M_diversity: bestQ.breakdown.M_diversity,
    M_WR_gate: bestQ.breakdown.M_WR_gate,
    wall_ratio: bestQ.breakdown.M_wall_ratio,
    bellotF: f.F, diam: f.d, largestRatio: f.largestRatio,
  });
}

results.sort((a, b) => b.mq - a.mq);

console.log('\n=== maze_quality v4 vs Bellot F: 8-pattern benchmark (31x31) ===');
console.log('rank | name                       | type   | mq    | WR_gate | wall_r | M_top | M_div | bellotF | largestRatio');
console.log('-'.repeat(120));
results.forEach((r, i) => {
  console.log(
    `${String(i+1).padStart(3)} | ${r.name.padEnd(26)} | ${r.type.padEnd(6)} | ${r.mq.toFixed(3)} | ${r.M_WR_gate.toFixed(2)}    | ${r.wall_ratio.toFixed(2)}   | ${r.M_topology.toFixed(3)} | ${r.M_diversity.toFixed(3)} | ${r.bellotF.toFixed(3)}  | ${r.largestRatio.toFixed(2)}`
  );
});

const trueR = results.filter(r => r.type === 'TRUE');
const pseudoR = results.filter(r => r.type === 'PSEUDO');
const avg = (arr, key) => arr.length ? arr.reduce((a,r) => a + r[key], 0) / arr.length : 0;
const trueM = avg(trueR, 'mq'), pseudoM = avg(pseudoR, 'mq');
const trueF = avg(trueR, 'bellotF'), pseudoF = avg(pseudoR, 'bellotF');
console.log('\n=== Discrimination (TRUE vs PSEUDO) ===');
console.log(`maze_quality: TRUE=${trueM.toFixed(3)} PSEUDO=${pseudoM.toFixed(3)} gap=${(trueM-pseudoM).toFixed(3)}`);
console.log(`Bellot F:     TRUE=${trueF.toFixed(3)} PSEUDO=${pseudoF.toFixed(3)} gap=${(trueF-pseudoF).toFixed(3)}`);
if ((trueF-pseudoF) !== 0) {
  console.log(`Ratio: maze_quality gap is ${Math.abs((trueM-pseudoM)/(trueF-pseudoF)).toFixed(2)}x Bellot F gap`);
}
