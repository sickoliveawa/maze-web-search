import { _generateSpiral } from "./src/metrics/maze_quality.js";
const W = 31, H = 31;
const sp = _generateSpiral(W, H);
// Print each row
for (let y = 0; y < H; y++) {
  let cells = [];
  for (let x = 0; x < W; x++) cells.push(sp[y * W + x]);
  console.log(`row ${y}: count_1=${cells.filter(c => c === 1).length} count_0=${cells.filter(c => c === 0).length}`);
  if (y < 4) console.log("  cells:", cells.slice(0, 10).join(""), "...", cells.slice(-10).join(""));
}
