import { _generateDFSMaze, _generateSpiral, _generateFractalTree, _generateRandomNoise, _generateStripes, mazeQuality } from "./src/metrics/maze_quality.js";
import { writeFileSync } from "fs";
const W = 31, H = 31;

function gridToJson(g) {
  const out = [];
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < W; x++) row.push(g[y * W + x]);
    out.push(row);
  }
  return out;
}

const true_grids = {};
const pseudo_grids = {};
const scores = {};

// 6 true (need to be inverted so 0=wall like JSON convention)
// _generateDFSMaze returns 1=road, 0=wall (bellot). JSON convention is 0=wall, 1=road. Same!
{
  const g = _generateDFSMaze(W, H);
  true_grids["Recursive Backtrack (DFS)"] = gridToJson(g);
  scores["DFS"] = mazeQuality(g, W, H).total;
}

// For pseudo, the original JS uses 1=wall, 0=corridor (Spiral, Fractal, Noise, Stripes).
// But paper convention is 0=wall, 1=corridor. INVERT all pseudo so they match paper.
function invert(g) {
  const out = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = g[i] === 0 ? 1 : 0;
  return out;
}

{
  const g = invert(_generateSpiral(W, H));
  pseudo_grids["Spiral"] = gridToJson(g);
  scores["Spiral"] = mazeQuality(g, W, H).total;
}
{
  const g = invert(_generateFractalTree(W, H));
  pseudo_grids["Sparse Dendrite"] = gridToJson(g);
  scores["Sparse Dendrite"] = mazeQuality(g, W, H).total;
}
{
  const g = invert(_generateRandomNoise(W, H, 0.5));
  pseudo_grids["Random Noise 50%"] = gridToJson(g);
  scores["Random Noise 50%"] = mazeQuality(g, W, H).total;
}
{
  const g = invert(_generateRandomNoise(W, H, 0.3));
  pseudo_grids["Random Noise 30%"] = gridToJson(g);
  scores["Random Noise 30%"] = mazeQuality(g, W, H).total;
}
{
  const g = invert(_generateStripes(W, H));
  pseudo_grids["Horizontal Stripes"] = gridToJson(g);
  scores["Horizontal Stripes"] = mazeQuality(g, W, H).total;
}
// Static pseudo that don't depend on JS generators
pseudo_grids["Checkerboard"] = [];
for (let y = 0; y < H; y++) {
  const row = [];
  for (let x = 0; x < W; x++) row.push((x + y) % 2);
  pseudo_grids["Checkerboard"].push(row);
}
pseudo_grids["Diagonal Stripes"] = [];
for (let y = 0; y < H; y++) {
  const row = [];
  for (let x = 0; x < W; x++) row.push((x + 2*y) % 3 === 0 ? 1 : 0);
  pseudo_grids["Diagonal Stripes"].push(row);
}
pseudo_grids["Concentric Squares"] = [];
for (let y = 0; y < H; y++) {
  const row = [];
  for (let x = 0; x < W; x++) {
    const dx = Math.min(x, W-1-x), dy = Math.min(y, H-1-y);
    const d = Math.min(dx, dy);
    row.push(d % 2 === 0 ? 1 : 0);
  }
  pseudo_grids["Concentric Squares"].push(row);
}
pseudo_grids["Square Grid"] = [];
for (let y = 0; y < H; y++) {
  const row = [];
  for (let x = 0; x < W; x++) {
    if (y % 3 === 0) row.push(0);
    else if (x % 3 === 0) row.push(0);
    else row.push(1);
  }
  pseudo_grids["Square Grid"].push(row);
}

const out = {W, H, true: true_grids, pseudo: pseudo_grids, scores};
writeFileSync("figures/v2/maze_grids.json", JSON.stringify(out, null, 0));
console.log("Wrote figures/v2/maze_grids.json");
console.log("Scores:", JSON.stringify(scores, null, 2));
