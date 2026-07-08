import { writeFileSync, readFileSync } from "fs";
const W = 31, H = 31;
const data = JSON.parse(readFileSync("figures/v2/maze_grids.json", "utf-8"));

// Inline JS implementations of 5 more true mazes (Kruskal, Prim, GrowingTree, Sidewinder, BinaryTree)
// Each follows bellot convention: 0=wall, 1=corridor

// LCG RNG
let s = 42;
function rand() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }
function nextInt(n) { return Math.floor(rand() * n); }

function gridToJson(g) {
  const out = [];
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < W; x++) row.push(g[y * W + x]);
    out.push(row);
  }
  return out;
}

// --- Kruskal's ---
function makeKruskal() {
  // Odd dimensions for cell/wall alternation
  const gW = W % 2 === 0 ? W + 1 : W;
  const gH = H % 2 === 0 ? H + 1 : H;
  const grid = new Uint8Array(gW * gH).fill(0);  // 0=wall
  // Union-find
  const parent = new Int32Array(gW * gH).fill(-1);
  for (let y = 1; y < gH; y += 2) for (let x = 1; x < gW; x += 2) parent[y * gW + x] = y * gW + x;
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  // Walls list (between two cells)
  const walls = [];
  for (let y = 1; y < gH; y += 2) for (let x = 1; x < gW; x += 2) {
    if (x + 2 < gW) walls.push([x, y, x + 2, y]);
    if (y + 2 < gH) walls.push([x, y, x, y + 2]);
  }
  // Shuffle
  for (let i = walls.length - 1; i > 0; i--) {
    const j = nextInt(i + 1);
    [walls[i], walls[j]] = [walls[j], walls[i]];
  }
  for (const [x1, y1, x2, y2] of walls) {
    const a = y1 * gW + x1, b = y2 * gW + x2;
    if (find(a) !== find(b)) {
      union(a, b);
      // Knock wall
      const wx = (x1 + x2) / 2, wy = (y1 + y2) / 2;
      grid[wy * gW + wx] = 1;  // corridor
      grid[y1 * gW + x1] = 1;
      grid[y2 * gW + x2] = 1;
    }
  }
  return grid;
}

// --- Prim's ---
function makePrim() {
  const gW = W % 2 === 0 ? W + 1 : W;
  const gH = H % 2 === 0 ? H + 1 : H;
  const grid = new Uint8Array(gW * gH).fill(0);
  const inMaze = new Uint8Array(gW * gH).fill(0);
  const walls = [];
  function addCellWalls(cx, cy) {
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx > 0 && nx < gW - 1 && ny > 0 && ny < gH - 1) {
        walls.push([cx, cy, nx, ny]);
      }
    }
  }
  const startX = 1, startY = 1;
  inMaze[startY * gW + startX] = 1;
  grid[startY * gW + startX] = 1;
  addCellWalls(startX, startY);
  while (walls.length > 0) {
    const idx = nextInt(walls.length);
    const [x1, y1, x2, y2] = walls.splice(idx, 1)[0];
    if (inMaze[y2 * gW + x2]) continue;
    inMaze[y2 * gW + x2] = 1;
    const wx = (x1 + x2) / 2, wy = (y1 + y2) / 2;
    grid[wy * gW + wx] = 1;
    grid[y1 * gW + x1] = 1;
    grid[y2 * gW + x2] = 1;
    addCellWalls(x2, y2);
  }
  return grid;
}

// --- Growing Tree (random of recent) ---
function makeGrowingTree() {
  const gW = W % 2 === 0 ? W + 1 : W;
  const gH = H % 2 === 0 ? H + 1 : H;
  const grid = new Uint8Array(gW * gH).fill(0);
  const visited = new Uint8Array(gW * gH).fill(0);
  const cells = [];
  const sx = 1, sy = 1;
  cells.push([sx, sy]);
  visited[sy * gW + sx] = 1;
  grid[sy * gW + sx] = 1;
  while (cells.length > 0) {
    const idx = nextInt(cells.length);  // pure random = Prim-like
    const [cx, cy] = cells[idx];
    const neighbors = [];
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx > 0 && nx < gW - 1 && ny > 0 && ny < gH - 1 && !visited[ny * gW + nx]) {
        neighbors.push([nx, ny]);
      }
    }
    if (neighbors.length === 0) {
      cells.splice(idx, 1);
    } else {
      const [nx, ny] = neighbors[nextInt(neighbors.length)];
      visited[ny * gW + nx] = 1;
      const wx = (cx + nx) / 2, wy = (cy + ny) / 2;
      grid[wy * gW + wx] = 1;
      grid[cy * gW + cx] = 1;
      grid[ny * gW + nx] = 1;
      cells.push([nx, ny]);
    }
  }
  return grid;
}

// --- Sidewinder ---
function makeSidewinder() {
  const gW = W % 2 === 0 ? W + 1 : W;
  const gH = H % 2 === 0 ? H + 1 : H;
  const grid = new Uint8Array(gW * gH).fill(0);
  for (let y = 1; y < gH; y += 2) {
    let runStart = 1;
    for (let x = 1; x < gW; x += 2) {
      grid[y * gW + x] = 1;
      const atEastBorder = (x + 2 >= gW);
      const atSouthBorder = (y + 2 >= gH);
      let closeOut = false;
      if (atEastBorder) closeOut = true;
      else if (!atSouthBorder && rand() < 0.5) closeOut = true;
      if (closeOut) {
        if (!atSouthBorder) {
          const member = runStart + 2 * nextInt(Math.floor((x - runStart) / 2) + 1);
          grid[(y + 1) * gW + member] = 1;
          grid[y * gW + member] = 1;
        }
        runStart = x + 2;
      } else {
        grid[y * gW + x + 1] = 1;
        grid[y * gW + x + 2] = 1;
      }
    }
  }
  return grid;
}

// --- Binary Tree (NW) ---
function makeBinaryTree() {
  const gW = W % 2 === 0 ? W + 1 : W;
  const gH = H % 2 === 0 ? H + 1 : H;
  const grid = new Uint8Array(gW * gH).fill(0);
  for (let y = 1; y < gH; y += 2) {
    for (let x = 1; x < gW; x += 2) {
      grid[y * gW + x] = 1;
      const canN = y - 2 >= 0;
      const canW = x - 2 >= 0;
      if (canN && canW) {
        if (rand() < 0.5) { grid[(y - 1) * gW + x] = 1; grid[(y - 2) * gW + x] = 1; }
        else { grid[y * gW + x - 1] = 1; grid[y * gW + x - 2] = 1; }
      } else if (canN) {
        grid[(y - 1) * gW + x] = 1; grid[(y - 2) * gW + x] = 1;
      } else if (canW) {
        grid[y * gW + x - 1] = 1; grid[y * gW + x - 2] = 1;
      }
    }
  }
  return grid;
}

// Truncate grids to 31x31 if needed
function truncate(g) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = g[y * W + x];
  return out;
}

data.true["Kruskal's"] = gridToJson(truncate(makeKruskal()));
data.true["Prim's"] = gridToJson(truncate(makePrim()));
data.true["Growing Tree"] = gridToJson(truncate(makeGrowingTree()));
data.true["Sidewinder"] = gridToJson(truncate(makeSidewinder()));
data.true["Binary Tree"] = gridToJson(truncate(makeBinaryTree()));

writeFileSync("figures/v2/maze_grids.json", JSON.stringify(data, null, 0));
console.log("Added 5 more true mazes. Total true:", Object.keys(data.true).length);
console.log("Total pseudo:", Object.keys(data.pseudo).length);
