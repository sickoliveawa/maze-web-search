import { _generateDFSMaze, _generateSpiral, _generateFractalTree, _generateRandomNoise, _generateStripes, mazeQuality } from "./src/metrics/maze_quality.js";
const W = 31, H = 31;
const cases = [];
cases.push({name: "DFS", cat: "true", grid: Array.from(_generateDFSMaze(W, H))});
cases.push({name: "Spiral", cat: "pseudo", grid: Array.from(_generateSpiral(W, H))});
cases.push({name: "Fractal Tree", cat: "pseudo", grid: Array.from(_generateFractalTree(W, H))});
cases.push({name: "Random Noise 50%", cat: "pseudo", grid: Array.from(_generateRandomNoise(W, H, 0.5))});
cases.push({name: "Random Noise 30%", cat: "pseudo", grid: Array.from(_generateRandomNoise(W, H, 0.3))});
cases.push({name: "Horizontal Stripes", cat: "pseudo", grid: Array.from(_generateStripes(W, H))});

for (const c of cases) {
  const g = new Uint8Array(c.grid);
  const r = mazeQuality(g, W, H);
  console.log(JSON.stringify({name: c.name, cat: c.cat, total: r.total.toFixed(4), M_wall_ratio: r.breakdown.M_wall_ratio.toFixed(4), M_connectedness: r.breakdown.M_connectedness.toFixed(4), M_branching: r.breakdown.M_branching.toFixed(4), M_WR_gate: r.breakdown.M_WR_gate.toFixed(4)}));
}
