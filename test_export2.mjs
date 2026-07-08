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

// Convention: 0 = wall, 1 = corridor (uniform)
function invert(g) {
  const out = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = g[i] === 0 ? 1 : 0;
  return out;
}

const true_grids = {};
const pseudo_grids = {};
const scores = {};

// TRUE — all 6 use bellot convention (0=wall, 1=corridor) — direct
{
  const g = _generateDFSMaze(W, H);
  true_grids["Recursive Backtrack (DFS)"] = gridToJson(g);
  scores["DFS"] = mazeQuality(g, W, H).total;
}

// PSEUDO — old generators used (1=wall, 0=corridor), so INVERT
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
// Static pseudo — built directly in bellot convention
function mkCheckerboard() {
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y*W+x] = (x + y) % 2;  // 0/1 alternating
  return g;
}
function mkDiagonal() {
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y*W+x] = ((x + 2*y) % 3 === 0) ? 1 : 0;
  return g;
}
function mkConcentricSquares() {
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = Math.min(x, W-1-x), dy = Math.min(y, H-1-y);
    const d = Math.min(dx, dy);
    g[y*W+x] = (d % 2 === 0) ? 1 : 0;
  }
  return g;
}
function mkSquareGrid() {
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (y % 3 === 0 || x % 3 === 0) g[y*W+x] = 0;
    else g[y*W+x] = 1;
  }
  return g;
}

pseudo_grids["Checkerboard"] = gridToJson(mkCheckerboard());
scores["Checkerboard"] = mazeQuality(new Uint8Array(mkCheckerboard()), W, H).total;
pseudo_grids["Diagonal Stripes"] = gridToJson(mkDiagonal());
scores["Diagonal Stripes"] = mazeQuality(new Uint8Array(mkDiagonal()), W, H).total;
pseudo_grids["Concentric Squares"] = gridToJson(mkConcentricSquares());
scores["Concentric Squares"] = mazeQuality(new Uint8Array(mkConcentricSquares()), W, H).total;
pseudo_grids["Square Grid"] = gridToJson(mkSquareGrid());
scores["Square Grid"] = mazeQuality(new Uint8Array(mkSquareGrid()), W, H).total;

const out = {W, H, true: true_grids, pseudo: pseudo_grids, scores};
writeFileSync("figures/v2/maze_grids.json", JSON.stringify(out, null, 0));
console.log("Wrote figures/v2/maze_grids.json");
console.log("=== 15-pattern scores (maze_quality, 0=wall, 1=corridor) ===");
console.log("TRUE:");
console.log("  DFS: " + scores["DFS"].toFixed(4));
console.log("PSEUDO:");
for (const k of Object.keys(scores)) {
  if (k !== "DFS") console.log("  " + k + ": " + scores[k].toFixed(4));
}
console.log("\n=== verification ===");
let trueMean = scores["DFS"];
let pseudoScores = Object.entries(scores).filter(([k, _]) => k !== "DFS").map(([_, v]) => v);
let pseudoMean = pseudoScores.reduce((a, b) => a + b, 0) / pseudoScores.length;
let gap = trueMean - pseudoMean;
let pseudoMax = Math.max(...pseudoScores);
let pseudoAbove05 = pseudoScores.filter(s => s > 0.05).length;
console.log("TRUE mean: " + trueMean.toFixed(4));
console.log("PSEUDO mean: " + pseudoMean.toFixed(4));
console.log("GAP: " + gap.toFixed(4));
console.log("PSEUDO max: " + pseudoMax.toFixed(4));
console.log("PSEUDO > 0.05 (false positives): " + pseudoAbove05 + "/" + pseudoScores.length);
