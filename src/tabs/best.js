/**
 * tabs/best.js — Best tab. List saved batches from IndexedDB,
 * show breakdown + best grid of selected batch, plus delete + export.
 */

import { renderGrid } from '../render/grid.js';
import { listBatches, getBatch, deleteBatch, exportBatchAsJSON, importBatchFromJSON } from '../storage.js';
import { setConfig } from '../state.js';

export async function renderBestTab(root) {
  root.innerHTML = `
    <div class="panel">
      <h2>Saved batches <small>(IndexedDB, this browser only)</small></h2>
      <div class="row" style="gap:8px;">
        <button class="btn" id="best-refresh">↻ Refresh list</button>
        <button class="ghost" id="best-import">⬆ Import JSON</button>
        <input type="file" id="best-import-file" accept="application/json,.json" style="display:none"/>
      </div>
      <table style="margin-top:10px;">
        <thead>
          <tr>
            <th>Name</th>
            <th>Best score</th>
            <th class="num">Last gen</th>
            <th class="num">Grid</th>
            <th>Started</th>
            <th>cell mask</th>
            <th class="num">pop</th>
            <th class="num">gens</th>
            <th class="num">seed</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="best-tbody"><tr><td colspan="10" class="help">Loading…</td></tr></tbody>
      </table>
    </div>

    <div id="best-detail" style="display:none">
      <div class="col2">
        <div class="panel">
          <h2>Best grid</h2>
          <div class="canvas-wrap"><canvas id="best-canvas"></canvas></div>
        </div>
        <div class="panel">
          <h2>Breakdown</h2>
          <div id="best-bars"></div>
          <pre id="best-summary" style="font-family:ui-monospace,Menlo,monospace;font-size:11px;background:var(--bg-3);padding:10px;border-radius:4px;margin-top:10px;color:var(--fg-1);"></pre>
        </div>
      </div>

      <div class="panel">
        <h2>Settings used <small>← click "Load into Configure" to apply</small></h2>
        <pre id="best-config" style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--fg-1);background:var(--bg-3);padding:10px;border-radius:4px;margin-top:6px;overflow:auto;max-height:300px;"></pre>
        <div class="row">
          <button class="btn" id="best-load-cfg">↻ Load into Configure</button>
          <button class="ghost" id="best-export">⬇ Export JSON</button>
        </div>
      </div>
    </div>
  `;

  const $ = (id) => root.querySelector('#' + id);
  const tbody = $('best-tbody');
  const detail = $('best-detail');
  let _loadedRecord = null;

  async function refresh() {
    tbody.innerHTML = '<tr><td colspan="10" class="help">Loading…</td></tr>';
    let list = [];
    try {
      list = await listBatches();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="10" style="color:var(--bad)">IndexedDB error: ${e.message}</td></tr>`;
      return;
    }
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="10" class="help">No saved batches yet. Run on Train tab first.</td></tr>`;
      return;
    }
    tbody.innerHTML = '';
    for (const b of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(b.name)}</strong></td>
        <td><span class="${(b.bestScore >= 0.74 ? 'pill ok' : 'pill')}">${b.bestScore.toFixed(4)}</span></td>
        <td class="num">${b.lastGen}</td>
        <td class="num">${b.gridW}×${b.gridH}</td>
        <td>${new Date(b.createdAt).toLocaleString()}</td>
        <td>${escapeHtml(b.config?.cellMaskType || '?')}</td>
        <td class="num">${b.config?.popSize ?? '-'}</td>
        <td class="num">${b.config?.generations ?? '-'}</td>
        <td class="num">${b.config?.randomSeed ?? '-'}</td>
        <td>
          <button class="btn" data-act="open"  data-name="${escapeHtml(b.name)}">Open</button>
          <button class="danger" data-act="del" data-name="${escapeHtml(b.name)}">Del</button>
        </td>`;
      tbody.appendChild(tr);
    }

    tbody.addEventListener('click', async (ev) => {
      const t = ev.target.closest('button[data-act]');
      if (!t) return;
      const name = t.dataset.name;
      if (t.dataset.act === 'open') {
        const rec = await getBatch(name);
        if (!rec) { alert('not found: ' + name); return; }
        _loadedRecord = rec;
        detail.style.display = '';
        renderDetail(rec);
      } else if (t.dataset.act === 'del') {
        if (!confirm(`Delete batch "${name}"? This cannot be undone.`)) return;
        await deleteBatch(name);
        detail.style.display = 'none';
        refresh();
      }
    });
  }

  function renderDetail(rec) {
    // grid preview
    if (rec.bestGrid && rec.gridW && rec.gridH) {
      renderGrid($('best-canvas'), new Uint8Array(rec.bestGrid), rec.gridW, rec.gridH, { cellSize: 6 });
    }
    // breakdown bars
    if (rec.bestBreakdown) {
      const order = ['M_branching','M_spread','M_junction','M_connectedness','M_boundary','M_pattern','M_asymmetry','M_transition','M_topology','M_diversity'];
      let html = '';
      for (const k of order) {
        const v = rec.bestBreakdown[k];
        if (typeof v !== 'number') continue;
        const pct = Math.round(v * 100);
        html += `<div class="bar-row">
          <span class="name">${k.replace(/^M_/, '')}</span>
          <span class="track"><span class="fill" style="width:${pct}%;background:var(--accent-2);"></span></span>
          <span class="val">${v.toFixed(3)}</span>
        </div>`;
      }
      $('best-bars').innerHTML = html;
      $('best-summary').textContent =
        `total = ${rec.bestScore.toFixed(6)}\n` +
        `M_topology = ${rec.bestBreakdown.M_topology?.toFixed(4)}\n` +
        `M_diversity = ${rec.bestBreakdown.M_diversity?.toFixed(4)}\n\n` +
        `Snapshot: ${rec.lastGen} generations, pop=${rec.config?.popSize}.`;
    } else {
      $('best-bars').innerHTML = '<p class="help">No breakdown available (older format?).</p>';
      $('best-summary').textContent = '';
    }
    // config dump
    $('best-config').textContent = JSON.stringify(rec.config, null, 2);
  }

  $('best-refresh').addEventListener('click', refresh);

  $('best-load-cfg').addEventListener('click', () => {
    if (!_loadedRecord) return;
    setConfig({ ..._loadedRecord.config, batchName: _loadedRecord.name });
    alert(`Loaded config from "${_loadedRecord.name}". Switch to Configure / Train tab.`);
  });

  $('best-export').addEventListener('click', () => {
    if (!_loadedRecord) return;
    const text = exportBatchAsJSON(_loadedRecord);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `maze-web-${_loadedRecord.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $('best-import').addEventListener('click', () => $('best-import-file').click());
  $('best-import-file').addEventListener('change', async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const rec = importBatchFromJSON(text);
      const { saveBatch } = await import('../storage.js');
      await saveBatch(rec);
      alert(`Imported "${rec.name}".`);
      refresh();
    } catch (e) {
      alert('Import failed: ' + e.message);
    }
  });

  refresh();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}
