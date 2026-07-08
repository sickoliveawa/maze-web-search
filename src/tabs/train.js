/**
 * tabs/train.js — Train tab. Live ES runner.
 *
 * Pulls config from state, calls runES() with onProgress callback that
 * pushes history into state. Best snapshot is saved to IndexedDB when
 * the run completes (or on Stop).
 */

import { renderGrid } from '../render/grid.js';
import { getConfig, setConfig, pushHistory, resetHistory, clearTrainHandle, setTrainHandle, getState, onChange } from '../state.js';
import { saveBatch, buildBatchRecord } from '../storage.js';
import { runES } from '../search/es_searcher.js';
import { saveCheckpoint } from '../ckpt.js';

// Track current run for UI (independent of state.trainHandle for clarity).
let _runCtl = null;     // { abort: AbortController, promise: Promise }

export function renderTrainTab(root) {
  const cfg = getConfig();
  const st = getState();

  root.innerHTML = `
    <div class="panel">
      <h2>Training status</h2>
      <div class="row" style="gap:18px;align-items:center;">
        <span class="pill ${st.isTraining ? 'live' : ''}" id="train-status-pill">${st.isTraining ? 'LIVE' : 'idle'}</span>
        <span class="help" id="train-status-text">Ready to start.</span>
        <span style="margin-left:auto;display:flex;gap:8px;">
          <button class="primary" id="train-start" ${st.isTraining ? 'disabled' : ''}>▶ Start</button>
          <button class="btn" id="train-stop"  ${st.isTraining ? '' : 'disabled'}>■ Stop</button>
        </span>
      </div>
      <div class="progress" style="margin-top:10px"><div class="bar" id="train-progress-bar"></div></div>
      <div class="row" style="margin-top:8px;gap:18px;">
        <span class="help" id="train-progress-text">gen — / —</span>
        <span class="help" id="train-elapsed-text"></span>
        <span class="help" id="train-eta-text"></span>
      </div>
    </div>

    <div class="col2">
      <!-- Live preview + metrics -->
      <div class="panel">
        <h2>Live preview</h2>
        <div class="row" style="gap:18px;align-items:flex-start;">
          <div>
            <h3 style="margin:0 0 4px 0;font-size:11px;color:var(--fg-1);text-transform:uppercase;letter-spacing:0.5px;">Init grid (gen 0)</h3>
            <div class="canvas-wrap" id="train-canvas-init-wrap">
              <canvas id="train-canvas-init"></canvas>
            </div>
          </div>
          <div>
            <h3 style="margin:0 0 4px 0;font-size:11px;color:var(--fg-1);text-transform:uppercase;letter-spacing:0.5px;">Final grid (best CA)</h3>
            <div class="canvas-wrap" id="train-canvas-wrap">
              <canvas id="train-canvas"></canvas>
            </div>
          </div>
          <div>
            <h3>Best so far</h3>
            <pre id="train-best-summary" style="font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--fg-1);background:var(--bg-3);padding:10px;border-radius:4px;margin:0 0 6px 0;width:240px;min-height:60px;">(no run yet)</pre>
            <div id="train-best-bars"></div>
          </div>
        </div>
      </div>

      <!-- Log -->
      <div class="panel">
        <h2>Generation log <small>(auto-scrolls)</small></h2>
        <div class="log" id="train-log"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Settings in use</h2>
      <small>Edit on Configure tab — these refresh live.</small>
      <pre id="train-active-config" style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--fg-1);background:var(--bg-3);padding:10px;border-radius:4px;margin-top:6px;overflow:auto;max-height:200px;"></pre>
    </div>
  `;

  // helpers (closures over root)
  const $ = (id) => root.querySelector('#' + id);
  const log = (msg, cls='') => {
    const e = $('train-log');
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    e.appendChild(line);
    e.scrollTop = e.scrollHeight;
  };
  const fmtPct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;

  function refreshActiveConfig() {
    const c = getConfig();
    $('train-active-config').textContent = JSON.stringify(c, null, 2);
  }
  refreshActiveConfig();

  // ---------------- Start / Stop buttons ----------------

  $('train-start').addEventListener('click', async () => {
    if (_runCtl) return;
    const c = getConfig();
    if (!c.batchName) {
      log('⚠️  Set a batch name on Configure tab first.', 'gen-warn');
      return;
    }
    // Sanity: ratios sum to 1
    const rsum = c.eliteKeepRatio + c.eliteMutRatio + c.randRatio + c.middleKeepRatio;
    if (Math.abs(rsum - 1) > 0.01) {
      log(`⚠️  Selection ratios sum to ${rsum.toFixed(2)} ≠ 1.0 — adjusting.`, 'gen-warn');
      // auto-normalize
      const inv = 1 / rsum;
      setConfig({
        eliteKeepRatio: c.eliteKeepRatio * inv,
        eliteMutRatio:  c.eliteMutRatio  * inv,
        randRatio:      c.randRatio      * inv,
        middleKeepRatio:c.middleKeepRatio* inv,
      });
      return;
    }
    // family mask → ensure length matches maxFamilies
    const fams = c.activeFamilySlots.slice().sort((a, b) => a - b);
    if (fams.length === 0) {
      log('⚠️  No active family slots selected.', 'gen-warn');
      return;
    }

    resetHistory();
    setTrainHandle({ finished: false, abort: null });

    $('train-status-pill').classList.add('live');
    $('train-status-pill').textContent = 'LIVE';
    $('train-status-text').textContent = 'Initializing GPU...';
    log(`🚀 starting run: pop=${c.popSize}, gens=${c.generations}, seed=${c.randomSeed}`);

    const ac = new AbortController();
    _runCtl = { abort: ac };

    // ✅ (sko 07-07) anti-clobber runTag — 每次训练 session 唯一, server 据此拒绝跨 run 静默覆盖
    //   生成: run_<epoch_ms>_<rand4> 例: run_1720345678901_a3f9
    //   同 session 多次 save (gen 50→500) runTag 一致 → server 允许覆盖 (最新 gen 胜)
    //   不同 session 同 batchName → runTag 不同 → server 返 409 + existing runTag
    const runTag = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    log(`🏷️  runTag: ${runTag}`, 'gen-info');

    const opts = {
      popSize: c.popSize,
      generations: c.generations,
      seeds: c.seeds,
      withInvert: c.withInvert,
      gridW: c.gridW,
      gridH: c.gridH,
      steps: c.caSteps,
      patchSize: c.initPatchSize,  // legacy — only used if initFullScreen=false
      initFullScreen: c.initFullScreen,  // ✅ 07-01: 全屏 noise init (sparse 散步)
      initDensity: c.initDensity,        // ✅ 07-01: noise 密度 default 0.15
      randomSeed: c.randomSeed,
      cellMaskType: c.cellMaskType,
      familyMask: fams,
      seedB2S123: c.seedB2S123,
      eliteKeepRatio: c.eliteKeepRatio,
      eliteMutRatio: c.eliteMutRatio,
      randRatio: c.randRatio,
      middleKeepRatio: c.middleKeepRatio,
      useLayeredMutation: c.useLayeredMutation,
      mutLayers: c.mutLayers,
      mutBitsMin: c.mutBitsMin,
      mutBitsMax: c.mutBitsMax,
      metric: c.metric,
      onProgress: (point) => {
        // point = { gen, best, mean, gated, positive, top5, ...}
        pushHistory(point);
        const pct = Math.min(100, (point.gen / c.generations) * 100);
        $('train-progress-bar').style.width = `${pct}%`;
        $('train-progress-text').textContent = `gen ${point.gen} / ${c.generations}`;
        const e = point.elapsed || 0;
        $('train-elapsed-text').textContent = `elapsed ${e.toFixed(1)}s`;
        const eta = (point.gen > 0) ? (e / point.gen) * (c.generations - point.gen) : 0;
        $('train-eta-text').textContent = `eta ${eta.toFixed(0)}s`;
        log(`gen ${point.gen}: best=${point.best.toFixed(4)} mean=${point.mean.toFixed(4)} positive=${point.positive}/${c.popSize} elapsed=${e.toFixed(1)}s`, 'gen-info');

        // Render best grid + best breakdown if present
        const cfg2 = getConfig();
        if (point.topBestGrids && point.topBestGrids[0] && point.topBreakdown && point.topBreakdown[0]) {
          const grid = new Uint8Array(point.topBestGrids[0]);
          // ✅ FIX (sko 07-01): dual-interpretation 配色 — 按 score 高分 side 选
          //   usedInverted=true → inverted (dead=road 亮, alive=wall 深)
          //   usedInverted=false → orig (alive=road 亮, dead=wall 深)
          const usedInverted = point.topUsedInverted && point.topUsedInverted[0] === true;
          renderGrid($('train-canvas'), grid, cfg2.gridW, cfg2.gridH, { cellSize: 6, usedInverted });
          // ✅ FIX (sko 07-01): 配对画 init grid (CA 演化前) — 验证 initFullScreen 模式
          if (point.topInitGrids && point.topInitGrids[0]) {
            const initGrid = new Uint8Array(point.topInitGrids[0]);
            renderGrid($('train-canvas-init'), initGrid, cfg2.gridW, cfg2.gridH, { cellSize: 6, usedInverted: false });
          }
          $('train-best-summary').textContent = `best=${point.best.toFixed(4)}\nM_topology=${point.topBreakdown[0].M_topology?.toFixed(3)}\nM_diversity=${point.topBreakdown[0].M_diversity?.toFixed(3)}`;
          renderBreakdownBars($('train-best-bars'), point.topBreakdown[0]);

          // ✅ NEW (sko 07-03): 每 50 gen 自动保存 best chrom bits 到本地 ckpt server
          //   目的: 训练 5min 崩了/被 stop 也有 ckpt 可恢复 / 手动调参复现
          //   文件名: <config.slug>__gen<NNNN>__<hash>.json  → E:\doro\maze-web\ckpt\
          if (point.gen > 0 && point.gen % 50 === 0 && point.topBits && point.topBits[0]) {
            saveCheckpoint({
              bits: point.topBits[0],
              gen: point.gen,
              config: c,
              bestScore: point.best,
              bestBreakdown: point.topBreakdown?.[0] || null,
              runTag,  // ✅ (sko 07-07) 抗 clobber — 同 session 内可覆盖, 跨 run 拒绝
            }).then((r) => {
              if (r.ok) {
                log(`💾 ckpt saved: ${r.name}  (${r.size}B)`, 'ckpt');
              } else {
                if (r.status === 409 && r.existing_runTag) {
                  log(`🚫 ckpt clobber blocked: existing runTag=${r.existing_runTag}, `
                    + `incoming=${r.incoming_runTag}. ${r.advice || ''}`, 'ckpt-warn');
                } else {
                  log(`⚠ ckpt save failed: ${r.error}`, 'ckpt');
                }
              }
            }).catch((e) => log(`⚠ ckpt save threw: ${e.message}`, 'ckpt'));
          }
        }
      },
      signal: ac.signal,
    };

    try {
      const res = await runES(opts);
      log(`✅ run complete. bestScore=${res.bestScore.toFixed(6)}`);
      $('train-status-text').textContent = `Done. best=${res.bestScore.toFixed(4)}`;
      // save final record
      await saveFinalBatch(res, c);
    } catch (e) {
      if (e.name === 'AbortError') {
        log('⏹ stopped by user.');
        $('train-status-text').textContent = 'Stopped.';
      } else {
        log(`❌ ${e.message || e}`);
        $('train-status-text').textContent = 'Error.';
      }
    } finally {
      _runCtl = null;
      clearTrainHandle();
      $('train-status-pill').classList.remove('live');
      $('train-status-pill').textContent = 'idle';
      $('train-start').disabled = false;
      $('train-stop').disabled = true;
      refreshActiveConfig();
    }
  });

  $('train-stop').addEventListener('click', () => {
    if (_runCtl) _runCtl.abort.abort();
  });

  // subscribe to config changes (live settings)
  onChange(() => {
    refreshActiveConfig();
  });
}

function renderBreakdownBars(container, breakdown) {
  const order = ['M_branching','M_spread','M_junction','M_connectedness','M_boundary','M_pattern','M_asymmetry','M_transition','M_topology','M_diversity'];
  let html = '';
  for (const k of order) {
    const v = breakdown[k];
    if (typeof v !== 'number') continue;
    const pct = Math.round(v * 100);
    html += `<div class="bar-row">
      <span class="name">${k.replace(/^M_/, '')}</span>
      <span class="track"><span class="fill" style="width:${pct}%;background:var(--accent-2);"></span></span>
      <span class="val">${v.toFixed(3)}</span>
    </div>`;
  }
  container.innerHTML = html;
}

async function saveFinalBatch(res, cfg) {
  try {
    const rec = buildBatchRecord({
      name: cfg.batchName,
      config: { ...cfg },
      lastGen: res.history.length ? res.history[res.history.length-1].gen : 0,
      bestScore: res.bestScore,
      bestBreakdown: res.history.length ? last(res.history).topBreakdown?.[0] : null,
      bestChromBits: res.bestChromosome,
      bestGrid: (res.history.length ? last(res.history).topBestGrids?.[0] : null)
        ? new Uint8Array(last(res.history).topBestGrids[0])
        : null,
      gridW: cfg.gridW,
      gridH: cfg.gridH,
      history: res.history.slice(-100),     // cap at 100 entries
    });
    await saveBatch(rec);
    console.log(`saved batch "${cfg.batchName}" → IndexedDB`);
  } catch (e) {
    console.warn('saveBatch failed', e);
  }
}

function last(arr) { return arr[arr.length - 1]; }
