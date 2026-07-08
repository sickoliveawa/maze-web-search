import { _generateSpiral, mazeQuality } from "./src/metrics/maze_quality.js";
const W = 31, H = 31;
const sp = _generateSpiral(W, H);
const r = mazeQuality(sp, W, H);
console.log("=== _generateSpiral grid (1=wall #, 0=corridor .) ===");
for (let y = 0; y < H; y++) {
  let line = "";
  for (let x = 0; x < W; x++) line += (sp[y * W + x] === 1 ? "#" : ".");
  console.log(line);
}
console.log("=== score ===");
console.log(JSON.stringify({total: r.total, M_wall_ratio: r.breakdown.M_wall_ratio, M_connectedness: r.breakdown.M_connectedness, M_branching: r.breakdown.M_branching, M_junction: r.breakdown.M_junction, M_asymmetry: r.breakdown.M_asymmetry}, null, 2));
