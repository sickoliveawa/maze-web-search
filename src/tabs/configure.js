/**
 * tabs/configure.js — Configure tab. Surface for ALL ESConfig fields.
 *
 * Renders fields grouped into 6 cards:
 *   1. Population
 *   2. Grid / Init
 *   3. Cell & Family mask
 *   4. Selection & Mutation
 *   5. Scoring
 *   6. Persistence (batch name)
 *
 * Every change calls setConfig() so Train tab picks up live edits.
 * "Apply defaults" resets to state.DEFAULT_CONFIG.
 */

import { getConfig, setConfig, resetConfig, getDefaultConfig } from '../state.js';

const POP_DEFAULTS = {
  popSize:        { min: 50,    max: 2000,  step: 50,   group: 'pop' },
  generations:    { min: 1,     max: 5000,  step: 50,   group: 'pop' },
  seeds:          { min: 1,     max: 16,    step: 1,    group: 'pop' },
  randomSeed:     { min: 0,     max: 99999999, step: 1, group: 'pop' },
};

const GRID_DEFAULTS = {
  gridW:          { min: 20,    max: 200,   step: 10,   group: 'grid' },
  gridH:          { min: 20,    max: 200,   step: 10,   group: 'grid' },
  caSteps:        { min: 1,     max: 2000,  step: 50,   group: 'grid' },
  initPatchSize:  { min: 0,     max: 60,    step: 2,    group: 'grid' },
  initFullScreen: { type: 'bool' },
  initDensity:    { min: 0.01,  max: 0.5,   step: 0.01, group: 'grid' },
};

const CELL_FAM_DEFAULTS = {
  cellMaskType:   { type: 'select', options: cellMaskOptions() },
  maxFamilies:    { type: 'select', options: [1, 2, 3, 4, 6, 8, 12, 16] },
};

const SEL_DEFAULTS = {
  eliteKeepRatio: { min: 0,     max: 0.5,   step: 0.01 },
  eliteMutRatio:  { min: 0,     max: 0.95,  step: 0.01 },
  randRatio:      { min: 0,     max: 0.95,  step: 0.01 },
  middleKeepRatio:{ min: 0,     max: 0.5,   step: 0.01 },
  mutLayers:      { min: 1,     max: 50,    step: 1 },
  mutBitsMin:     { min: 1,     max: 50,    step: 1 },
  mutBitsMax:     { min: 1,     max: 50,    step: 1 },
  useLayeredMutation: { type: 'bool' },
};

const SCORING_DEFAULTS = {
  withInvert:     { type: 'bool' },
  metric:         { type: 'select', options: ['mazeQuality', 'mazeScore'] },
  seedB2S123:     { type: 'bool' },
};

function cellMaskOptions() {
  // ✅ 07-03 (sko): 染色体只编码 9x9 ±4 (80 cells)
  //   chebyshev-5..8: 染色体没 |dx|>4 的 bits → 跟 chebyshev-4 行为完全一样 (冗余)
  //   manhattan-5..8: 9x9 用完 → 跟 manhattan-4 / -6 等有部分重叠
  //   sko 决定: 只留 chebyshev-1..4 + manhattan-1..4 = 8 选项 (07-03)
  const out = [];
  for (let n = 1; n <= 4; n++) out.push(`chebyshev-${n}`);
  for (let n = 1; n <= 4; n++) out.push(`manhattan-${n}`);
  return out;
}

// === Hover tooltips (detailed explanation for each field) ===
//   Shown on label hover via native title attr + floating styled tooltip.
const TOOLTIPS = {
  // Population
  popSize:        'Population per generation (50–2000). More = better coverage but linear cost in eval/sec. ES baseline uses 500.',
  generations:    'Number of ES generations (1–5000). Each generation evaluates popSize × seeds grids. Default 1000 takes ~16 min on JS engine.',
  seeds:          'Independent init patches averaged per rule (1–16). Higher = more robust fitness, but N× cost per rule.',
  randomSeed:     'Master seed for ES initialization. Same seed + same config = same result (for reproducibility).',

  // Grid
  gridW:          'Grid width (20–200). Standard search uses 80 (≈6400 cells). Larger grids help metric discrimination but slow O(W·H) per step.',
  gridH:          'Grid height (20–200). Same trade-off as gridW.',
  caSteps:        'CA steps before scoring (1–2000). Standard 300 steps = pseudo-steady-state for Conway-like rules.',
  initPatchSize:  'Initial patch half-side (only used when initFullScreen=false). 0 = full random. Higher = denser seed, faster boundary formation, but biased start.',
  initFullScreen: 'Full-grid Bernoulli random init (sko 07-01). Default TRUE — every cell has density probability of being alive. Use FALSE only for legacy centered-patch experiments.',
  initDensity:    'Probability each cell is alive in the initial grid (when initFullScreen=true). Default 0.15 (sparse noise — GA learns to organize random → maze).',

  // Cell & Family
  cellMaskType:   'chebyshev-N = max(|dx|,|dy|) ≤ N. manhattan-N = |dx|+|dy| ≤ N. chebyshev-1 = Moore (8 cells), chebyshev-2 = 24 cells. Limited to 1..4 (chromosome hard cap, 9×9 ±4 = 80 cells).',
  maxFamilies:    'Hard cap (1–16). GPU MAX_FAMILIES=16 (跟 16 family chromosome 对齐 07-03). Higher F = more varied rules but linear cost in cell mask lookups + GPU dispatch.',
  activeFamilySlots:'Click to toggle which family indices are actually active. The first N=Max are usable; others stay disabled.',

  // Selection & Mutation
  useLayeredMutation:'On = mutate pool split into mutLayers bins, each flipping mutBitsMin..mutBitsMax bits. Off = uniform 1-bit mutate (faster, less diverse).',
  eliteKeepRatio: 'Fraction of top-scorers kept unchanged into next gen (typically 10%).',
  eliteMutRatio:  'Fraction of top-scorers copied then mutated (typically 50%). With layered mutation, each gets different bit-count.',
  randRatio:      'Fraction generated from scratch (typically 40%). Maintains diversity past early generations.',
  middleKeepRatio:'Fraction of median-scorers kept (typically 0%). Use non-zero only if elite+mut+rand together < 100%.',
  mutLayers:      'When useLayeredMutation = true, mutators are split into this many layers, each flipping a different number of bits.',
  mutBitsMin:     'Smallest bit-flip count used in layered mutation (typically 1).',
  mutBitsMax:     'Largest bit-flip count used (typically 10). Must be ≥ mutBitsMin.',

  // Scoring
  withInvert:     'Run each grid twice (alive + inverted), take max score. JS engine default. Doubles eval count but doubles search-space coverage.',
  metric:         'mazeQuality = Bellot 7-dim geometric mean (0..1). mazeScore = Bellot 10-dim sum (higher dynamic range).',
  seedB2S123:     'Force Conway B2/S123 into pop[0]. Reference marker with mazeQuality=0.339 (boundary + correlation regime).',
  batchName:      'Name used when this run is saved to IndexedDB. Required to train. Same name overwrites.',
};

export function renderConfigureTab(root, ctx) {
  const cfg = getConfig();
  const def = getDefaultConfig();

  // Validation helpers
  const pct = (v) => Math.round((Number(v) || 0) * 100);

  root.innerHTML = `
    <div class="col2">
      <!-- LEFT: all config cards -->
      <div>
        <!-- 1. POPULATION -->
        <div class="cfg-card">
          <h3>Population</h3>
          <p class="desc">How many rules per generation and for how long.</p>
          ${fieldRow('popSize',  'Population size',  POP_DEFAULTS.popSize,  cfg)}
          ${fieldRow('generations', 'Generations',  POP_DEFAULTS.generations, cfg)}
          ${fieldRow('seeds',    'Init seeds / rule', POP_DEFAULTS.seeds, cfg,
            'Number of independent init grids each rule is evaluated on. Mean of scores is the fitness.')}
          ${fieldRow('randomSeed','Random seed', POP_DEFAULTS.randomSeed, cfg,
            'Master seed for ES initialization.')}
        </div>

        <!-- 2. GRID / INIT -->
        <div class="cfg-card">
          <h3>Grid &amp; CA</h3>
          <p class="desc">Grid dimensions and how many CA steps each evaluation runs.</p>
          ${fieldRow('gridW',  'Grid width',  GRID_DEFAULTS.gridW, cfg)}
          ${fieldRow('gridH',  'Grid height', GRID_DEFAULTS.gridH, cfg)}
          ${fieldRow('caSteps','CA steps',    GRID_DEFAULTS.caSteps, cfg,
            'Number of CA steps applied before scoring.')}
          ${fieldRow('initPatchSize','Init patch size', GRID_DEFAULTS.initPatchSize, cfg,
            'Centered random patch (half-side). 0 = full random init. Only used if initFullScreen=false (legacy mode).')}
          ${fieldRow('initFullScreen','Full-screen random init', GRID_DEFAULTS.initFullScreen, cfg,
            'On = entire grid is density-noise initial state. Off = centered patch (legacy).')}
          ${fieldRow('initDensity','Init density (full-screen only)', GRID_DEFAULTS.initDensity, cfg,
            'Probability each cell starts alive. 0.15 (sparse) → GA learns to organize random into maze.')}
        </div>

        <!-- 3. CELL & FAMILY MASK -->
        <div class="cfg-card">
          <h3>Cell &amp; Family mask</h3>
          <p class="desc">Which neighbour cells are modifiable and how many families per rule.</p>
          ${fieldRow('cellMaskType','Cell distance mask', CELL_FAM_DEFAULTS.cellMaskType, cfg,
            'chebyshev-N = max(|dx|,|dy|) ≤ N. manhattan-N = |dx|+|dy| ≤ N. Higher = more cells.')}
          ${fieldRow('maxFamilies','Active families / rule', CELL_FAM_DEFAULTS.maxFamilies, cfg,
            'JS engine MAX_FAMILIES hard cap. Truncated to top priority families.')}

          <div style="margin-top:10px">
            <div class="help">Active family slots (click to toggle, first N=Max active):</div>
            <div class="fam-slots" id="fam-slots">
              ${renderFamSlots(cfg.maxFamilies, cfg.activeFamilySlots)}
            </div>
          </div>
        </div>

        <!-- 4. SELECTION & MUTATION -->
        <div class="cfg-card">
          <h3>Selection &amp; Mutation</h3>
          <p class="desc">How the next generation is built (Python ESConfig parity).</p>
          ${fieldRow('useLayeredMutation','Use layered mutation', SEL_DEFAULTS.useLayeredMutation, cfg,
            'On: split mutated pool into mutLayers slices, each flipping a different number of bits. Off: uniform 1-bit.')}
          <div class="row" style="gap:16px;">
            ${fieldCol('eliteKeepRatio','Elite (kept)', cfg, pct(cfg.eliteKeepRatio)+'%')}
            ${fieldCol('eliteMutRatio', 'Elite mut',    cfg, pct(cfg.eliteMutRatio)+'%')}
            ${fieldCol('randRatio',     'Random',       cfg, pct(cfg.randRatio)+'%')}
            ${fieldCol('middleKeepRatio','Middle (kept)', cfg, pct(cfg.middleKeepRatio)+'%')}
          </div>
          ${fieldRow('mutLayers','Mutation layers', SEL_DEFAULTS.mutLayers, cfg)}
          ${fieldRow('mutBitsMin','Bits per layer (min)', SEL_DEFAULTS.mutBitsMin, cfg)}
          ${fieldRow('mutBitsMax','Bits per layer (max)', SEL_DEFAULTS.mutBitsMax, cfg,
            'Must be ≥ mutBitsMin.')}
          <div id="sel-warning" class="help" style="color:var(--warn);"></div>
        </div>

        <!-- 5. SCORING -->
        <div class="cfg-card">
          <h3>Scoring</h3>
          <p class="desc">JS runES also takes both directions (road = alive vs inverted).</p>
          ${fieldRow('withInvert','With invert (max of orig+inverted)', SCORING_DEFAULTS.withInvert, cfg,
            'Match JS default. Doubles evaluation count but improves search space.')}
          ${fieldRow('metric','Metric', SCORING_DEFAULTS.metric, cfg,
            'mazeQuality = Bellot 7-dim geometric mean. mazeScore = Bellot 10-dim sum.')}
          ${fieldRow('seedB2S123','Seed B2/S123 into pop[0]', SCORING_DEFAULTS.seedB2S123, cfg,
            'Reference marker (score=3.72 fixed).')}
        </div>
      </div>

      <!-- RIGHT: actions + summary -->
      <div>
        <div class="cfg-card">
          <h3>Batch</h3>
          <label class="field field-help" data-tip="${escapeHtml(TOOLTIPS.batchName || '')}">Batch name
            <span class="ctrl">
              <input type="text" id="cfg-batch-name" value="${escapeHtml(cfg.batchName || '')}" placeholder="e.g. seed_20260701_run1"/>
            </span>
          </label>
          <p class="help">Saved batches persist in IndexedDB (this browser only).</p>
        </div>

        <div class="cfg-card">
          <h3>Live summary</h3>
          <pre id="cfg-summary" style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--fg-1);background:var(--bg-3);padding:10px;border-radius:4px;overflow:auto;max-height:340px;margin:0;">${escapeHtml(formatConfigSummary(cfg))}</pre>
        </div>

        <div class="row">
          <button class="btn" id="cfg-apply-defaults">Apply defaults</button>
          <button class="ghost" id="cfg-copy-json">Copy as JSON</button>
        </div>

        <div class="cfg-card" style="margin-top:14px">
          <h3 style="color:var(--accent-2)">Ready to train?</h3>
          <p class="desc">Edit any setting on this tab. The Train tab picks up changes live — no Apply button needed.</p>
          <button class="primary" id="cfg-go-train">Go to Train →</button>
        </div>
      </div>
    </div>
  `;

  // ---------------- live wiring ----------------

  function bindField(key, schema) {
    const el = root.querySelector(`#cfg-${key}`);
    if (!el) return;
    if (schema && schema.type === 'bool') {
      el.checked = !!cfg[key];
      el.addEventListener('change', () => setConfig({ [key]: !!el.checked }));
    } else if (schema && schema.type === 'select') {
      el.value = cfg[key];
      el.addEventListener('change', () => setConfig({ [key]: el.value }));
    } else {
      el.value = cfg[key];
      el.addEventListener('input', () => {
        const n = Number(el.value);
        if (Number.isFinite(n)) setConfig({ [key]: n });
      });
    }
  }

  // Generic number fields
  for (const m of [
    ['popSize', POP_DEFAULTS.popSize], ['generations', POP_DEFAULTS.generations],
    ['seeds', POP_DEFAULTS.seeds], ['randomSeed', POP_DEFAULTS.randomSeed],
    ['gridW', GRID_DEFAULTS.gridW], ['gridH', GRID_DEFAULTS.gridH],
    ['caSteps', GRID_DEFAULTS.caSteps], ['initPatchSize', GRID_DEFAULTS.initPatchSize],
    ['initFullScreen', GRID_DEFAULTS.initFullScreen], ['initDensity', GRID_DEFAULTS.initDensity],
    ['eliteKeepRatio', SEL_DEFAULTS.eliteKeepRatio], ['eliteMutRatio', SEL_DEFAULTS.eliteMutRatio],
    ['randRatio', SEL_DEFAULTS.randRatio], ['middleKeepRatio', SEL_DEFAULTS.middleKeepRatio],
    ['mutLayers', SEL_DEFAULTS.mutLayers], ['mutBitsMin', SEL_DEFAULTS.mutBitsMin],
    ['mutBitsMax', SEL_DEFAULTS.mutBitsMax],
  ]) bindField(m[0], m[1]);

  bindField('cellMaskType', CELL_FAM_DEFAULTS.cellMaskType);
  bindField('maxFamilies', CELL_FAM_DEFAULTS.maxFamilies);
  bindField('useLayeredMutation', SEL_DEFAULTS.useLayeredMutation);
  bindField('withInvert', SCORING_DEFAULTS.withInvert);
  bindField('metric', SCORING_DEFAULTS.metric);
  bindField('seedB2S123', SCORING_DEFAULTS.seedB2S123);

  // family slot toggles
  const slotsEl = root.querySelector('#fam-slots');
  slotsEl.addEventListener('click', (ev) => {
    const t = ev.target.closest('.fam-slot');
    if (!t || t.classList.contains('disabled')) return;
    const idx = Number(t.dataset.idx);
    const cur = getConfig().activeFamilySlots.slice().sort((a, b) => a - b);
    const i = cur.indexOf(idx);
    if (i >= 0) {
      // toggle off
      cur.splice(i, 1);
    } else {
      cur.push(idx);
      cur.sort((a, b) => a - b);
    }
    setConfig({ activeFamilySlots: cur });
    // ✅ FIX (07-01): re-render fam-slot DOM — state changed but DOM didn't.
    const cNow = getConfig();
    slotsEl.innerHTML = renderFamSlots(cNow.maxFamilies, cNow.activeFamilySlots);
    attachFloatingTooltips(root);
  });

  // maxFamilies change → trim/expand activeFamilySlots to [0..maxFamilies-1]
  const maxFamEl = root.querySelector('#cfg-maxFamilies');
  maxFamEl.addEventListener('change', () => {
    const max = Number(maxFamEl.value);
    const cur = getConfig().activeFamilySlots.filter((i) => i < max).sort((a, b) => a - b);
    setConfig({ maxFamilies: max, activeFamilySlots: cur });
    // ✅ FIX (07-01): re-render to enable newly-available slots / refresh tooltip
    const cNow = getConfig();
    slotsEl.innerHTML = renderFamSlots(cNow.maxFamilies, cNow.activeFamilySlots);
    attachFloatingTooltips(root);
  });

  // batch name
  const bnEl = root.querySelector('#cfg-batch-name');
  bnEl.addEventListener('input', () => {
    setConfig({ batchName: bnEl.value.trim() });
  });

  // summary updater + ratio sanity (re-renders summary on any change)
  const summaryEl = root.querySelector('#cfg-summary');
  const selWarn = root.querySelector('#sel-warning');
  function refreshSummary() {
    const c = getConfig();
    summaryEl.textContent = formatConfigSummary(c);
    const total = c.eliteKeepRatio + c.eliteMutRatio + c.randRatio + c.middleKeepRatio;
    if (Math.abs(total - 1) > 0.001) {
      selWarn.textContent = `Selection ratios sum to ${total.toFixed(2)} (not 1.0). Adjust before training.`;
    } else {
      selWarn.textContent = '';
    }
  }
  refreshSummary();
  // subscribe
  ctx.stateUnsub.push(subscribeToState(refreshSummary));

  // buttons
  root.querySelector('#cfg-apply-defaults').addEventListener('click', () => {
    resetConfig();
    renderConfigureTab(root, ctx);  // re-render to reset DOM values
  });
  root.querySelector('#cfg-copy-json').addEventListener('click', async () => {
    const text = JSON.stringify(getConfig(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      flash(root.querySelector('#cfg-copy-json'), 'copied');
    } catch {
      flash(root.querySelector('#cfg-copy-json'), 'copy failed');
    }
  });
  root.querySelector('#cfg-go-train').addEventListener('click', () => {
    document.querySelector('nav.tabs [data-tab="train"]').click();
  });

  // Hover tooltips on every labeled field
  attachFloatingTooltips(root);
}

function subscribeToState(fn) {
  // import dynamic (avoid cycle)
  import('../state.js').then(({ onChange }) => onChange(fn));
  // immediate unsub: dashboard manages these
  return () => {};
}

function fieldRow(key, label, schema, cfg, desc) {
  const tip = TOOLTIPS[key] || '';
  // If a TOOLTIPS entry exists, hide inline desc — the hover tooltip replaces it.
  // Otherwise keep the short inline <small> help.
  const inlineDesc = tip ? '' : (desc || '');
  if (schema.type === 'bool') {
    return `<label class="field field-help" style="flex-direction:row;align-items:center;gap:6px;" data-tip="${escapeHtml(tip)}">
      <input type="checkbox" id="cfg-${key}" />
      <span>${label}</span>
      ${inlineDesc ? `<small>${inlineDesc}</small>` : ''}
    </label>`;
  }
  if (schema.type === 'select') {
    const opts = schema.options.map((o) => {
      const v = (typeof o === 'object') ? o.value : o;
      const t = (typeof o === 'object') ? o.label : o;
      return `<option value="${escapeHtml(v)}" ${cfg[key] === v ? 'selected' : ''}>${escapeHtml(t)}</option>`;
    }).join('');
    return `<label class="field field-help" data-tip="${escapeHtml(tip)}">${label}
      <span class="ctrl"><select id="cfg-${key}">${opts}</select></span>
      ${inlineDesc ? `<small class="help" style="margin-top:2px">${inlineDesc}</small>` : ''}
    </label>`;
  }
  // numeric
  return `<label class="field field-help" data-tip="${escapeHtml(tip)}">${label}
    <span class="ctrl"><input type="number" id="cfg-${key}" value="${cfg[key]}" min="${schema.min}" max="${schema.max}" step="${schema.step}"/></span>
    ${inlineDesc ? `<small class="help" style="margin-top:2px">${inlineDesc}</small>` : ''}
  </label>`;
}

function fieldCol(key, label, cfg, suffix='') {
  const schema = SEL_DEFAULTS[key];
  const tip = TOOLTIPS[key] || '';
  return `<label class="field field-help" data-tip="${escapeHtml(tip)}" style="min-width:120px">${label}
    <span class="ctrl" style="display:flex;align-items:center;gap:8px;">
      <input type="number" id="cfg-${key}" value="${cfg[key]}" min="${schema.min}" max="${schema.max}" step="${schema.step}" style="width:80px"/>
      <span class="help">${suffix}</span>
    </span>
  </label>`;
}

function renderFamSlots(maxFamilies, active) {
  const out = [];
  const tip = TOOLTIPS.activeFamilySlots || '';
  for (let i = 0; i < 16; i++) {  // 07-03: 16 family slots (chromosome hard cap)
    const enabled = i < maxFamilies;
    const on = active.includes(i);
    const cls = ['fam-slot'];
    if (!enabled) cls.push('disabled');
    if (on) cls.push('active');
    out.push(`<div class="${cls.join(' ')}" data-idx="${i}" data-tip="${escapeHtml(tip)}">F${i}</div>`);
  }
  return out.join('');
}

// --- Floating tooltip handler (attached once per render) ---
//  Hovering any [data-tip] element shows a styled div following the cursor.
//  Native `title` attr is set as fallback for very slow mousemove.
function attachFloatingTooltips(root) {
  // Single shared tooltip element (created lazily)
  let tipEl = document.getElementById('__floating_tip__');
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = '__floating_tip__';
    tipEl.style.cssText = `
      position:fixed; z-index:9999; max-width:340px; pointer-events:none;
      background:var(--bg-3); color:var(--fg-0); border:1px solid var(--border);
      border-radius:4px; padding:8px 10px; font-size:12px; line-height:1.45;
      box-shadow:0 4px 14px rgba(0,0,0,.4); display:none; white-space:pre-wrap;
    `;
    document.body.appendChild(tipEl);
  }
  root.querySelectorAll('[data-tip]').forEach((el) => {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    // Native fallback
    el.title = text;
    el.addEventListener('mouseenter', (e) => {
      tipEl.textContent = text;
      tipEl.style.display = 'block';
      moveTip(e);
    });
    el.addEventListener('mousemove', moveTip);
    el.addEventListener('mouseleave', () => { tipEl.style.display = 'none'; });
  });
  function moveTip(e) {
    const pad = 14;
    const x = e.clientX + pad;
    const y = e.clientY + pad;
    tipEl.style.left = x + 'px';
    tipEl.style.top  = y + 'px';
  }
}

function formatConfigSummary(cfg) {
  return JSON.stringify(cfg, null, 2);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function flash(btn, label) {
  const old = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { btn.textContent = old; }, 800);
}
