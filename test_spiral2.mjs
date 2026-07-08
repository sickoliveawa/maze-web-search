import { _generateSpiral, mazeQuality } from "./src/metrics/maze_quality.js";
const W = 31, H = 31;
const sp = _generateSpiral(W, H);
console.log("sp.length:", sp.length);
console.log("first 50 cells:", Array.from(sp.slice(0, 50)));
console.log("=== grid ===");
for (let y = 0; y < H; y++) {
  let line = "";
  for (let x = 0; x < W; x++) line += (sp[y * W + x] === 1 ? "#" : ".");
  console.log(line);
}
