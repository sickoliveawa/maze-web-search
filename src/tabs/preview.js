/**
 * tabs/preview.js — Preview tab (minimal rewrite, 07-03).
 *
 * 3 panels only:
 *   1. Server  — list ckpts from local Python server (port 8088) + refresh + delete
 *   2. Grid    — W / H / seed / density / mode + Init / step ×1 / step ×10 / reset
 *   3. Image   — canvas (no score panel, no breakdown bars)
 *
 * Click a ckpt row → auto load + auto Init → see the result immediately.
 * User can then step ×1 or ×10 to see evolution.
 */

import { renderGrid } from '../render/grid.js';
import { Grid } from '../core/grid.js';
import { SeededRandom } from '../core/random.js';
import { BatchedGPUEngine } from '../gpu/gpu_engine_batched.js';
import { BitArray } from '../search/chromosome.js';
import { RuleChromosome } from '../search/rule_chromosome.js';
import { listCheckpoints, loadCheckpoint, deleteCheckpoint, healthCheck } from '../ckpt.js';
import { mazeQuality } from '../metrics/maze_quality.js';

/** Decode a Uint8Array(1648) of 0/1 into a Rule via the JS RuleChromosome.
 *  @param {Uint8Array|number[]} bits
 *  @param {string} [cellMaskType] - 'manhattan-1..4' / 'chebyshev-1..4'
 *    ✅ FIX (sko 07-08): 传 cellMaskType 让 decode() 用 cellInRange filter
 *      去掉 out-of-range cells (e.g. manhattan-1 下 push (2,0))
 *      不传则不过滤 (旧行为, 兼容 backward)
 */
function decodeChromosomeBits(bits, cellMaskType) {
  if (!bits || bits.length !== 1648) {
    throw new Error(`expected 1648 bits, got ${bits ? bits.length : 'null'}`);
  }
  const ba = new BitArray(1648);
  for (let i = 0; i < 1648; i++) ba.set(i, bits[i] ? 1 : 0);
  const chrom = new RuleChromosome(ba);
  return chrom.decode(cellMaskType);
}

let _engine = null;

export async function renderPreviewTab(root) {
  if (!_engine) {
    _engine = new BatchedGPUEngine();
    const r = await _engine.init();
    if (!r.ok) {
      root.innerHTML = `<div class="panel"><h2>Preview</h2>
        <p style="color:var(--bad)">WebGPU unavailable: ${r.error}</p>
        <p class="help">Use Chrome/Edge with hardware acceleration enabled. WebGPU is required for live preview.</p>
      </div>`;
      return;
    }
  }

  root.innerHTML = `
    <div class="panel">
      <h2>Server</h2>
      <div class="row">
        <button class="btn" id="pv-ckpt-refresh">↻ Refresh</button>
        <span class="help" id="pv-ckpt-status" style="margin-left:8px">checking…</span>
        <button class="btn ghost" id="pv-ckpt-load-latest" style="margin-left:auto" disabled>Load latest</button>
      </div>
      <div id="pv-ckpt-list" class="ckpt-grid" style="margin-top:8px"></div>
    </div>

    <div class="panel">
      <h2>Grid</h2>
      <div class="row">
        <label class="field">W <span class="ctrl"><input type="number" id="pv-grid-w" value="60" min="10" max="200" step="2"/></span></label>
        <label class="field">H <span class="ctrl"><input type="number" id="pv-grid-h" value="40" min="10" max="200" step="2"/></span></label>
        <label class="field">Seed <span class="ctrl"><input type="number" id="pv-init-seed" value="0" min="0" step="1"/></span></label>
        <label class="field">Density <span class="ctrl"><input type="number" id="pv-density" value="0.15" min="0.01" max="0.5" step="0.01"/></span></label>
        <label class="field">Mode <span class="ctrl">
          <select id="pv-init-mode">
            <option value="fullscreen" selected>fullscreen</option>
            <option value="patch">patch</option>
          </select>
        </span></label>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="primary" id="pv-init">▶ Init</button>
        <button class="btn" id="pv-step-once">step ×1</button>
        <button class="btn" id="pv-step-10">step ×10</button>
        <button class="btn ghost" id="pv-reset">reset</button>
        <span class="help" id="pv-status" style="margin-left:8px"></span>
      </div>
    </div>

    <div class="panel">
      <h2>Image</h2>
      <div class="canvas-wrap"><canvas id="pv-canvas"></canvas></div>
    </div>
  `;

  // ---- state ----
  let rule = null;
  let grid = null;
  let stepCount = 0;
  let currentCkptName = null;   // name of loaded ckpt (for row highlight)
  // ✅ 跟 train live preview 完全一致 — dual interpretation 选最优
  //   选完 interpretation 后, renderGrid 永远画**墙** (orig 画死 cell, inv 画活 cell)
  //   → 玩家永远看到"白底+黑墙", 跟 dual interpretation 选哪侧无关
  let _bestGrid = null;          // 高分 side 的 grid (orig 或 inv)
  let _bestUsedInverted = false; // 用哪个 scheme 渲染 (传给 renderGrid)

  const $ = (id) => root.querySelector('#' + id);
  const setStatus = (msg, kind = '') => {
    const el = $('pv-status');
    el.textContent = msg;
    el.style.color = kind === 'bad' ? 'var(--bad)' : kind === 'ok' ? 'var(--accent-2)' : 'var(--muted)';
  };

  // ✅ 跟 train live preview 一致: 算 dual score, 选高分 side 的 grid
  //   跟 gpu_scorer.js:1310-1339 完全一样 — origScore vs invScore, 选高分
  //   选完 interpretation 后, renderGrid 自动画**墙** (跟 interpretation 联动)
  function pickBestGrid() {
    if (!grid || !rule?._W || !rule?._H) {
      _bestGrid = null;
      _bestUsedInverted = false;
      return;
    }
    const W = rule._W, H = rule._H;
    const origScore = mazeQuality(grid, W, H);
    const invertedData = new Uint8Array(grid.length);
    for (let i = 0; i < grid.length; i++) invertedData[i] = 1 - grid[i];
    const invScore = mazeQuality(invertedData, W, H);
    if (invScore.total > origScore.total) {
      _bestGrid = invertedData;
      _bestUsedInverted = true;
    } else {
      _bestGrid = grid;
      _bestUsedInverted = false;
    }
  }

  function paint() {
    if (!grid || !rule?._W || !rule?._H || !_bestGrid) {
      // clear canvas (no rule or no grid → empty white)
      const c = $('pv-canvas');
      c.width = 60 * 6; c.height = 60 * 6;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      return;
    }
    // ✅ 跟 train live preview 一样: 渲染高分 side + 传 usedInverted 让 renderGrid 画墙
    //   Preview 画**路** (活 cell 黑) — drawLiveCells: true
    //   Train   画**墙** (死 cell 黑) — drawLiveCells 默认 false
    renderGrid($('pv-canvas'), _bestGrid, rule._W, rule._H, { cellSize: 6, usedInverted: _bestUsedInverted, drawLiveCells: true });
  }

  async function doInit() {
    if (!rule) { setStatus('Load a ckpt from Server panel first.', 'bad'); return; }
    const seed = Number($('pv-init-seed').value);
    const mode = $('pv-init-mode').value;
    const density = Math.max(0.01, Math.min(0.5, Number($('pv-density').value)));
    const W = Math.max(10, Math.min(200, Number($('pv-grid-w').value)));
    const H = Math.max(10, Math.min(200, Number($('pv-grid-h').value)));
    rule._W = W; rule._H = H;
    const rng = new SeededRandom(seed);
    // ✅ FIX (07-03): Grid.random/patch 返回 Grid 对象, 取 .data 拿 Uint8Array
    //   否则 paint()/stepOnce() 用 grid.length 全是 undefined → NaN → 全黑
    if (mode === 'fullscreen') {
      grid = Grid.random(W, H, density, rng).data;
    } else {
      const patchSize = 10;
      grid = Grid.patch(W, H, patchSize, rng).data;
    }
    stepCount = 0;
    pickBestGrid();
    paint();
    setStatus(`init ${W}×${H} seed=${seed} ${mode} d=${density.toFixed(2)} · ${_bestUsedInverted ? 'inv' : 'orig'}`);
  }

  async function doSteps(n) {
    if (!rule || !grid) { setStatus('Init first.', 'bad'); return; }
    const W = rule._W, H = rule._H;
    for (let s = 0; s < n; s++) {
      grid = await stepOnce(rule, grid, W, H);
      stepCount++;
    }
    pickBestGrid();   // CA 演化后重算 dual score (interpretation 通常不会翻, 但保险)
    paint();
    setStatus(`step ${stepCount} · ${_bestUsedInverted ? 'inv' : 'orig'}`);
  }

  async function stepOnce(rule, grid, W, H) {
    const flatIn = new Uint32Array(W * H);
    for (let i = 0; i < grid.length; i++) flatIn[i] = grid[i] > 0 ? 1 : 0;
    const { finalGrids } = await _engine.runBatchedSteps({
      ruleParams: _engine.encodeRules([rule]),
      initialGrids: flatIn,
      width: W, height: H,
      numSeeds: 1, numRules: 1,
      steps: 1,
      topologyType: rule.topology?.type === 'toroidal' ? 1 : 0,
      defaultState: 0,
    });
    return new Uint8Array(finalGrids);
  }
  // ---- Server panel: ckpt grid ----
  // ✅ FIX (sko 07-03): 卡片布局 (一行多 config) — 替代行布局, 装更多
  //   每张卡片显示: batchName, best score, gen, W×H, file size, savedAt
  //   🗑 按钮浮动右上角 (hover 才显, 不抢眼)
  function renderCkptList(items) {
    if (!items.length) {
      $('pv-ckpt-list').innerHTML = `<p class="help" style="margin:12px">No checkpoints. Run a Train (gen ≥ 50) to auto-save.</p>`;
      $('pv-ckpt-load-latest').disabled = true;
      return;
    }
    $('pv-ckpt-load-latest').disabled = false;
    const cards = items.map((it, idx) => {
      const score = (typeof it.bestScore === 'number') ? it.bestScore.toFixed(4) : '?';
      const gen = (typeof it.gen === 'number') ? `gen ${it.gen}` : '?';
      const cfg = it.config || {};
      const wh = `${cfg.gridW ?? '?'}×${cfg.gridH ?? '?'}`;
      const pop = cfg.popSize ?? '?';
      const m = cfg.metric || 'mazeQuality';
      const active = (it.name === currentCkptName) ? ' ckpt-card active' : ' ckpt-card';
      return `<div class="${active}" data-name="${escapeHtml(it.name)}" title="${escapeHtml(it.name)}">
        <button class="ckpt-card-del" data-del="${escapeHtml(it.name)}" title="delete">🗑</button>
        <div class="ckpt-card-name">${escapeHtml(it.name.replace(/\.json$/, ''))}</div>
        <div class="ckpt-card-score">${score}</div>
        <div class="ckpt-card-meta">${m} · pop ${pop}</div>
        <div class="ckpt-card-meta">${wh} · ${gen} · ${(it.size/1024).toFixed(1)}KB</div>
        <div class="ckpt-card-meta">${it.savedAt || ''}</div>
      </div>`;
    });
    $('pv-ckpt-list').innerHTML = cards.join('');
  }

  async function refreshCkptList() {
    const health = await healthCheck();
    if (!health.ok) {
      $('pv-ckpt-status').innerHTML = `<span style="color:var(--bad)">server down</span> ${escapeHtml(health.error || '')}`;
      $('pv-ckpt-list').innerHTML = `<p class="help" style="color:var(--bad)">Start <code>python ckpt_server.py</code> in maze-web/.</p>`;
      $('pv-ckpt-load-latest').disabled = true;
      return;
    }
    $('pv-ckpt-status').innerHTML = `<span style="color:var(--accent-2)">up</span> · ${health.files} file(s)`;
    const items = await listCheckpoints();
    renderCkptList(items);
  }

  async function loadAndApply(name) {
    setStatus(`loading ${name}…`);
    const rec = await loadCheckpoint(name);
    if (!rec || !rec.bestChromBits) { setStatus(`load failed: ${name}`, 'bad'); return; }
    try {
      // ✅ FIX (sko 07-08): 传 cellMaskType 让 decode 过滤 out-of-range cells
      //   跟 train path (gpu_scorer.decodeChromosome) 一致 — 不传会解出错的 rule
      rule = decodeChromosomeBits(rec.bestChromBits, rec.config?.cellMaskType);
    } catch (e) {
      setStatus(`decode failed: ${e.message}`, 'bad');
      return;
    }
    const cfg = rec.config || {};
    // ✅ FIX (07-03 bug 3): W/H 来自 rec.config, 不再二次覆盖 UI
    if (cfg.gridW) $('pv-grid-w').value = cfg.gridW;
    if (cfg.gridH) $('pv-grid-h').value = cfg.gridH;
    // ✅ FIX (sko 07-08): 字段名 cfg.randomSeed (不是 cfg.rngSeed / cfg.initSeed)
    //   同时计算 F2 init seed (production GPU eval 用的 chromHash-salt 公式):
    //     f2Seed = (randomSeed + chromHash * 65537) >>> 0
    //   1-family rule 简单,attractor 对 init 不敏感 → 视觉差别小
    //   multi-family rule 复杂,attractor 对 init 敏感 → 必须 F2 seed 才能 reproduce saved grid
    if (cfg.randomSeed != null && rec.bestChromBits) {
      let chromHash = 0;
      for (let i = 0; i < rec.bestChromBits.length; i++) {
        chromHash = ((chromHash * 31) + rec.bestChromBits[i]) | 0;
      }
      const f2Seed = (cfg.randomSeed + chromHash * 65537) >>> 0;
      $('pv-init-seed').value = f2Seed;
    } else if (cfg.randomSeed != null) {
      $('pv-init-seed').value = cfg.randomSeed;
    }
    if (cfg.initMode) $('pv-init-mode').value = cfg.initMode;
    if (cfg.initDensity != null) $('pv-density').value = cfg.initDensity;
    rule._W = Number($('pv-grid-w').value);
    rule._H = Number($('pv-grid-h').value);

    currentCkptName = name;
    refreshCkptList();   // re-render to highlight active row

    // ✅ FIX (07-03 bug 2): 加载后自动 doInit — 1 步看到结果
    await doInit();
    setStatus(`loaded: ${name} · score ${rec.bestScore?.toFixed(4) ?? '?'} · gen ${rec.gen} · ${rule.numFamilies ?? '?'} families`, 'ok');
  }

  // event delegation for ckpt cards
  $('pv-ckpt-list').addEventListener('click', async (e) => {
    const delBtn = e.target.closest('.ckpt-card-del');
    if (delBtn) {
      e.stopPropagation();
      const name = delBtn.getAttribute('data-del');
      if (!confirm(`Delete ${name}?`)) return;
      const ok = await deleteCheckpoint(name);
      if (ok && name === currentCkptName) currentCkptName = null;
      await refreshCkptList();
      return;
    }
    const card = e.target.closest('.ckpt-card');
    if (card) {
      const name = card.getAttribute('data-name');
      await loadAndApply(name);
    }
  });

  $('pv-ckpt-refresh').addEventListener('click', refreshCkptList);
  $('pv-ckpt-load-latest').addEventListener('click', async () => {
    const items = await listCheckpoints();
    if (items.length) await loadAndApply(items[0].name);
  });

  // Grid panel wire
  $('pv-init').addEventListener('click', doInit);
  $('pv-step-once').addEventListener('click', () => doSteps(1));
  $('pv-step-10').addEventListener('click', () => doSteps(10));
  $('pv-reset').addEventListener('click', () => {
    grid = null; stepCount = 0; rule = null; currentCkptName = null;
    _bestGrid = null; _bestUsedInverted = false;
    paint();
    setStatus('reset');
    refreshCkptList();
  });

  // initial: list ckpts + paint empty canvas
  refreshCkptList();
  paint();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
