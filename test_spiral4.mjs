import { _generateSpiral } from "./src/metrics/maze_quality.js?v={1783322453.1519766}";
const W = 31, H = 31;
const sp = _generateSpiral(W, H);
let row_counts = [];
for (let y = 0; y < H; y++) {
  let c1 = 0, c0 = 0;
  for (let x = 0; x < W; x++) { if (sp[y * W + x] === 1) c1++; else c0++; }
  row_counts.push([y, c1, c0]);
}
console.log("rows with 0 in middle:");
for (const [y, c1, c0] of row_counts) {
  if (c0 < 10) console.log(`  row ${y}: 1s=${c1} 0s=${c0}`);
}
