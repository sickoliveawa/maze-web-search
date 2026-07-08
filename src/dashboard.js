/**
 * dashboard.js — main controller. Wires tab bar + boots each tab module.
 *
 * On load:
 *   - read state config
 *   - render the initially active tab (Configure)
 *   - show WebGPU status badge in header (filled in by Preview tab once user clicks it)
 *   - expose hooks so other modules can switch tabs and check status
 */

import { getState, onChange, getDefaultConfig } from './state.js';
import { renderConfigureTab } from './tabs/configure.js';
import { renderTrainTab } from './tabs/train.js';
import { renderBestTab } from './tabs/best.js';
import { renderPreviewTab } from './tabs/preview.js';

const TAB_IDS = ['configure', 'train', 'best', 'preview'];
const TAB_RENDERERS = {
  configure: renderConfigureTab,
  train: renderTrainTab,
  best: renderBestTab,
  preview: renderPreviewTab,
};

let _activeTab = 'configure';
const _renderedTabs = {};   // tab_id -> ctx (stateUnsub list, etc.)
const _bootPromises = {};

function setHeaderPill(tab) {
  const pill = document.getElementById('tab-pill');
  if (pill) pill.textContent = tab[0].toUpperCase() + tab.slice(1);
}

function showTab(name) {
  _activeTab = name;
  for (const t of TAB_IDS) {
    document.getElementById(`tab-${t}`)?.classList.toggle('active', t === name);
  }
  for (const b of document.querySelectorAll('nav.tabs button')) {
    b.classList.toggle('active', b.dataset.tab === name);
  }
  setHeaderPill(name);

  // Lazy-render the tab on first activation
  if (!_renderedTabs[name]) {
    const ctx = { stateUnsub: [] };
    _renderedTabs[name] = ctx;
    try {
      const root = document.getElementById(`tab-${name}`);
      _bootPromises[name] = Promise.resolve(TAB_RENDERERS[name](root, ctx))
        .catch((e) => {
          console.error(`Tab ${name} failed to render:`, e);
          if (root) {
            root.innerHTML = `<div class="panel" style="color:var(--bad)">Tab "${name}" failed: ${escapeHtml(e.message || String(e))}</div>`;
          }
        });
    } catch (e) {
      console.error('Tab render error', name, e);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function boot() {
  // Tab bar wiring
  document.querySelectorAll('nav.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // Initial tab = Configure
  showTab('configure');

  // Header pill mirrors active tab
  onChange(() => { setHeaderPill(_activeTab); });

  // WebGPU availability probe (don't init here — just check)
  const gpuOk = !!navigator.gpu;
  const gpuStatus = document.getElementById('gpu-status');
  if (gpuOk) {
    gpuStatus.innerHTML = `WebGPU available · <span class="gpu">click Preview to init engine</span>`;
  } else {
    gpuStatus.innerHTML = `WebGPU <span style="color:var(--bad)">NOT AVAILABLE</span> — Train / Preview require Chrome/Edge with hardware accel`;
  }

  // Expose for debugging
  window.__mazeWeb = {
    getState,
    showTab,
    version: '0.1.0',
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
