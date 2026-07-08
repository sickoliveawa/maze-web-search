/**
 * state.js — central app state for maze-web.
 *
 * Holds the live ES configuration (what the user set on Configure tab),
 * the current training handle (so the user can Pause / Stop),
 * and the saved-batches cache mirrored from IndexedDB.
 *
 * Modules subscribe to `onChange()` to know when to re-render.
 */

const DEFAULT_CONFIG = Object.freeze({
  // Population
  popSize: 500,
  generations: 1000,
  seeds: 1,           // per-rule init seeds (multi-seed eval; 1 = single init grid)
  randomSeed: 20260630,

  // Grid
  gridW: 100,
  gridH: 60,
  caSteps: 300,
  // ✅ 07-01 (sko): 全屏随机游走 init — 不依赖 center patch
  //   initFullScreen=true → 所有 cell density 概率 init
  //   initFullScreen=false → 用 initPatchSize 中心 patch (legacy)
  initFullScreen: true,
  initPatchSize: 60,            // legacy; only used when initFullScreen=false
  initDensity: 0.15,            // 全屏 noise density (alive cell 概率)

  // Cell mask
  cellMaskType: 'manhattan-4',

  // Family mask
  maxFamilies: 1,            // 1-16 (GPU MAX_FAMILIES hard cap, 跟 chromosome 16 slots 对齐 07-03)
  activeFamilySlots: [0],     // which family indices are modifiable (1..maxFamilies of these)

  // Selection
  eliteKeepRatio: 0.10,
  eliteMutRatio: 0.50,
  randRatio: 0.40,
  middleKeepRatio: 0.0,

  // Mutation
  useLayeredMutation: true,
  mutLayers: 10,
  mutBitsMin: 1,
  mutBitsMax: 10,

  // Scoring
  withInvert: true,
  metric: 'mazeQuality',     // 'mazeQuality' or 'mazeScore'

  // Misc
  seedB2S123: false,
});

const DEFAULT_BATCH_NAME = '';

const state = {
  config: { ...DEFAULT_CONFIG },
  batchName: DEFAULT_BATCH_NAME,

  // Live training
  trainHandle: null,         // { abort, finished, ... } once started
  isTraining: false,
  isPaused: false,
  history: [],                // populated by runES via onProgress
  bestScore: -Infinity,
  bestChromBits: null,
  bestGrid: null,             // Uint8Array (W*H) of the best final grid (or null)
  bestBreakdown: null,        // last seen { total, M_branching, ... }
  startTime: null,
  endTime: null,

  // Saved batches (mirrored from IndexedDB)
  savedBatches: [],           // [{ name, createdAt, lastGen, bestScore, config }]
  loadingSaved: false,

  // Preview tab live state
  preview: {
    ruleBits: null,           // Uint8Array(1648) or null
    ruleBs: '',               // B/S string (alternative to bits)
    gridW: 100,
    gridH: 60,
    initSeed: 0,
    caStep: 0,
    lastGrid: null,           // Uint8Array of last computed grid
    lastScore: null,
  },

  // Listeners
  _listeners: [],
};

export function getState() { return state; }

export function getDefaultConfig() { return { ...DEFAULT_CONFIG }; }

export function getConfig() { return { ...state.config }; }

export function setConfig(patch) {
  state.config = { ...state.config, ...patch };
  emit();
}

export function resetConfig() {
  state.config = { ...DEFAULT_CONFIG };
  emit();
}

export function setBatchName(name) {
  state.batchName = name;
  emit();
}

export function setSavedBatches(list) {
  state.savedBatches = list;
  emit();
}

export function setTrainHandle(handle) {
  state.trainHandle = handle;
  state.isTraining = !!handle && !handle.finished;
  emit();
}

export function clearTrainHandle() {
  state.trainHandle = null;
  state.isTraining = false;
  state.isPaused = false;
  state.endTime = Date.now();
  emit();
}

/** Replace history with a fresh array (call after Start). */
export function resetHistory() {
  state.history = [];
  state.bestScore = -Infinity;
  state.bestChromBits = null;
  state.bestGrid = null;
  state.bestBreakdown = null;
  state.startTime = Date.now();
  state.endTime = null;
  emit();
}

/** Append one history point (called from runES onProgress). */
export function pushHistory(point) {
  state.history.push(point);
  if (point.best > state.bestScore) {
    state.bestScore = point.best;
    state.bestChromBits = point.topBits?.[0] ? new Uint8Array(point.topBits[0]) : null;
  }
  state.bestBreakdown = point.topBreakdown?.[0] ?? null;
  state.bestGrid = point.topBestGrids?.[0]
    ? new Uint8Array(point.topBestGrids[0])
    : null;
  emit();
}

export function setPreview(patch) {
  state.preview = { ...state.preview, ...patch };
  emit();
}

// ---------------- pub/sub ----------------

export function onChange(fn) {
  state._listeners.push(fn);
  return () => {
    const i = state._listeners.indexOf(fn);
    if (i >= 0) state._listeners.splice(i, 1);
  };
}

function emit() {
  for (const fn of state._listeners) {
    try { fn(state); } catch (e) { console.error('state listener error', e); }
  }
}
