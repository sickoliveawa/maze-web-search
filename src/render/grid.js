/**
 * render/grid.js — Canvas grid renderer.
 *
 * Two modes:
 *   - renderGrid(canvas, grid, W, H, opts)   // takes Uint8Array(row-major 0/1)
 *   - renderGridFromCells(canvas, grid, opts) // alternative signature accepts 2D array
 *   - makeAliveSnapshot(W, H)                 // returns fresh Uint8Array(W*H)
 *
 * Used by every tab (live grid preview, breakdown viewer, preset preview).
 */

const DEFAULT_OPTS = {
  cellSize: 8,
  // ✅ FIX (sko 07-01): 配色按 user 真实意图 — 白底+白路+深色墙
  //   原意: "路白融背景, 墙深连 maze 结构" — 经典 maze paper 风格
  //   黑色背景+白色路 = 路看起来"分散方块", 视觉碎
  //   白色背景+白色路+深色墙 = 墙连成 maze 边界, 视觉连贯
  //   orig:     wall 极深 #1a1a1a (maze 屏障), road 纯白 #ffffff (跟背景融)
  //   inverted: wall 纯白 #ffffff, road 极深 #1a1a1a
  liveColor: '#ffffff',      // road / path (orig scheme: 纯白, 跟背景融)
  deadColor: '#1a1a1a',      // wall / 屏障 (orig scheme: 极深, maze 边界主视觉)
  // ✅ path highlight: 走廊/死端/路口**都跟路同色** (白) — 因为视觉上只看到墙
  //   唯一可见的"path 结构"是**深色墙的缺口**, path 颜色不参与视觉
  //   路口中心 dot 用墙色 (深) 强调 T 字/十字 — 在白路中极显眼
  pathHighlightColor:     '#ffffff',  // orig: corridor 2 跟路同 (白)
  pathEndColor:           '#ffffff',  // orig: dead-end 1 跟路同 (白)
  pathHighlightColorInv:  '#1a1a1a',  // inverted: corridor 2 跟路同 (深)
  pathEndColorInv:        '#1a1a1a',  // inverted: dead-end 1 跟路同 (深)
  // ✅ 增强视觉: junction (degree ≥3) 跟路同色, 中心 dot 用墙色 (极深) 强调 T 字
  //   白路上 1px 极深点 → 一眼看到 T 字/十字路口
  junctionHighlightColor:    '#ffffff',  // orig: junction 跟路同 (白)
  junctionHighlightColorInv: '#1a1a1a',  // inverted: junction 跟路同 (深)
  // ✅ user 不绘制网格 (cleaner maze 视觉, 只看墙结构)
  showGrid: false,
  showPathHighlight: true,
  showJunctionDot: true,    // ✅ junction 中心 1px dot (深色, 强调 T 字)
  showOuterFrame: true,     // ✅ maze 外框 1.5px (跟墙同色, 强化边界)
  outerFrameColor:    '#1a1a1a',  // orig: maze 外框 = 墙色 (极深)
  outerFrameColorInv: '#fafafa',  // inverted: maze 外框 = 路色 (白)
  // ✅ FIX (sko 07-01): dual-interpretation 配色
  //   'orig'  → alive=road (白), dead=wall (极深)
  //   'inverted' → alive=wall (白), dead=road (极深)  (high score side)
  //   自动从 usedInverted 推, 手动覆盖也 OK
  colorScheme: 'orig',
  // grid line 粗细 (subtle, 几乎隐)
  gridLineWidth: 0.8,
  // ✅ FIX (sko 07-03): 黑色方块加大, 缝隙缩小, 墙连成 maze 屏障
  //   cellGap=0.5 → 死 cell 7.5x7.5 px (几乎全 cell, 缝隙几乎不可见)
  //   视觉: 墙连成厚屏障, maze 边界更突出
  cellGap: 0.5,
};

export function makeAliveSnapshot(W, H) {
  return new Uint8Array(W * H);
}

export function renderGrid(canvas, grid, W, H, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  // ✅ dual interpretation: 玩家传的 usedInverted 决定 colorScheme
  if (opts.usedInverted === true) o.colorScheme = 'inverted';
  if (opts.usedInverted === false) o.colorScheme = 'orig';

  // ✅ 最简版: 白底 + 黑墙
  //   isInverted 决定画哪类 cell:
  //     orig (dead=墙):     画 grid[i] === 0 (死 cell = 原始墙)
  //     inv  (live=墙倒置): 画 grid[i] > 0   (倒置 grid 的活 cell = 原始墙)
  //   两种 interpretation 画的都是**原始网格的墙**, 永远黑
  const isInverted = (o.colorScheme === 'inverted');
  const ctx = canvas.getContext('2d');
  const px = o.cellSize;
  canvas.width = W * px;
  canvas.height = H * px;

  // 白底
  ctx.fillStyle = o.liveColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // ✅ 画 cell — 两种行为用 flag 切
  //   drawLiveCells=false (默认, Train live preview): 画**墙** (死 cell) — orig: grid[i]===0; inv: grid[i]>0
  //   drawLiveCells=true  (Preview):               画**路** (活 cell) — orig: grid[i]>0;   inv: grid[i]===0
  const drawLiveCells = opts.drawLiveCells === true;
  ctx.fillStyle = o.deadColor;
  const cellGap = o.cellGap ?? 0.5;
  const fillSize = px - cellGap;
  const offset = cellGap / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const draw = drawLiveCells
        ? (isInverted ? (grid[i] === 0) : (grid[i] > 0))
        : (isInverted ? (grid[i] > 0) : (grid[i] === 0));
      if (draw) {
        ctx.fillRect(x * px + offset, y * px + offset, fillSize, fillSize);
      }
    }
  }
}

/** Render a downsampled grid (when source is bigger than display). */
export function renderGridDownsampled(canvas, grid, W, H, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const ctx = canvas.getContext('2d');
  const px = o.cellSize;
  // Map source (W, H) into canvas (W*px, H*px) — 'image-smoothing: pixelated'
  // Resize source to a 1:1 image, then drawImage scaled.
  const tmp = document.createElement('canvas');
  tmp.width = W;
  tmp.height = H;
  const tctx = tmp.getContext('2d');
  const data = tctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const v = grid[i] > 0 ? 255 : 0;
    data.data[i * 4 + 0] = v;
    data.data[i * 4 + 1] = v;
    data.data[i * 4 + 2] = v;
    data.data[i * 4 + 3] = 255;
  }
  tctx.putImageData(data, 0, 0);

  canvas.width = W * px;
  canvas.height = H * px;
  ctx.imageSmoothingEnabled = false;
  // ✅ FIX (sko 07-03): 跟 renderGrid 一致 — 画 live cell
  //   downsampled 路径 (大 maze → 小 canvas) 配色保持一致
  //   背景 liveC (白), ImageData 画活 cell (深) — 跟主 renderGrid 同步
  ctx.fillStyle = o.liveColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
}
