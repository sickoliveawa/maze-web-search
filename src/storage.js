/**
 * storage.js — IndexedDB wrapper for saved batches.
 *
 * Schema (single store 'batches'):
 *   key: name (string)
 *   value: {
 *     name, createdAt, lastGen, bestScore, bestBreakdown,
 *     bestChromBits: Uint8Array(1648),
 *     bestGrid: Uint8Array | null,    // row-major flat 0/1
 *     gridW, gridH,
 *     config: object (the ESConfig when this batch was started),
 *     history: [...],                  // trimmed to last N entries
 *   }
 */

const DB_NAME = 'maze_web';
const STORE = 'batches';
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(mode) {
  return openDB().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Save (create or replace) a batch. */
export async function saveBatch(record) {
  const store = await tx('readwrite');
  await reqToPromise(store.put(record));
}

/** Patch an existing batch (merge keys, e.g. update bestScore after a run). */
export async function patchBatch(name, patch) {
  const store = await tx('readwrite');
  const existing = await reqToPromise(store.get(name));
  if (!existing) return false;
  const merged = { ...existing, ...patch };
  await reqToPromise(store.put(merged));
  return true;
}

/** List all batch summaries (no chrom bits / grids to keep payload small). */
export async function listBatches() {
  const store = await tx('readonly');
  const all = await reqToPromise(store.getAll());
  return all
    .map((r) => ({
      name: r.name,
      createdAt: r.createdAt,
      lastGen: r.lastGen,
      lastUpdatedAt: r.lastUpdatedAt || r.createdAt,
      bestScore: r.bestScore,
      gridW: r.gridW,
      gridH: r.gridH,
      config: r.config,
      historyLen: (r.history || []).length,
    }))
    .sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
}

/** Get full record (with chromBits + grid). Returns null if not found. */
export async function getBatch(name) {
  const store = await tx('readonly');
  return await reqToPromise(store.get(name));
}

/** Delete a batch. */
export async function deleteBatch(name) {
  const store = await tx('readwrite');
  await reqToPromise(store.delete(name));
}

/** Wipe everything (debug / "reset all"). */
export async function clearAll() {
  const store = await tx('readwrite');
  await reqToPromise(store.clear());
}

/**
 * Build a "best record" object from current state, ready to put().
 * Caller fills in topBestGrids / topBreakdown after re-simulating.
 */
export function buildBatchRecord({
  name, config, lastGen, bestScore, bestBreakdown,
  bestChromBits, bestGrid, gridW, gridH, history,
}) {
  return {
    name,
    createdAt: Date.now(),
    lastUpdatedAt: Date.now(),
    lastGen,
    bestScore,
    bestBreakdown,
    bestChromBits,           // Uint8Array(1648)
    bestGrid,                // Uint8Array(W*H) or null
    gridW,
    gridH,
    config,                  // frozen copy of ESConfig
    history,                 // array of history points (already trimmed)
  };
}

/**
 * Export a batch as JSON (Uint8Array → number[] for portability).
 * Used for download.
 */
export function exportBatchAsJSON(record) {
  const obj = {
    name: record.name,
    createdAt: record.createdAt,
    lastGen: record.lastGen,
    bestScore: record.bestScore,
    bestBreakdown: record.bestBreakdown,
    bestChromBits: record.bestChromBits ? Array.from(record.bestChromBits) : null,
    bestGrid: record.bestGrid ? Array.from(record.bestGrid) : null,
    gridW: record.gridW,
    gridH: record.gridH,
    config: record.config,
    history: record.history,
    schemaVersion: 1,
  };
  return JSON.stringify(obj, null, 2);
}

/** Import a JSON string produced by exportBatchAsJSON. */
export function importBatchFromJSON(text) {
  const obj = JSON.parse(text);
  if (!obj || obj.schemaVersion !== 1) throw new Error('unknown schema version');
  return {
    name: obj.name,
    createdAt: obj.createdAt || Date.now(),
    lastUpdatedAt: Date.now(),
    lastGen: obj.lastGen || 0,
    bestScore: obj.bestScore,
    bestBreakdown: obj.bestBreakdown,
    bestChromBits: obj.bestChromBits ? new Uint8Array(obj.bestChromBits) : null,
    bestGrid: obj.bestGrid ? new Uint8Array(obj.bestGrid) : null,
    gridW: obj.gridW,
    gridH: obj.gridH,
    config: obj.config,
    history: obj.history || [],
  };
}
