/**
 * ckpt.js — Browser-side client for the local ckpt server.
 *
 * Server:  http://127.0.0.1:8088  (see ckpt_server.py)
 * Endpoints used:
 *   POST /ckpt/save
 *   GET  /ckpt/list
 *   GET  /ckpt/load?name=<name>
 *   DELETE /ckpt/delete?name=<name>
 *
 * Usage (Train tab — auto-save every 50 gen):
 *   import { saveCheckpoint } from '../ckpt.js';
 *   saveCheckpoint({ bits, gen, config, bestScore, bestBreakdown, runTag });
 *   // runTag: unique-per-session string, prevents clobbering across runs (see ckpt_server.py)
 *
 * Usage (Preview tab — load from server list):
 *   import { listCheckpoints, loadCheckpoint } from '../ckpt.js';
 *   const items = await listCheckpoints();
 *   const rec = await loadCheckpoint(items[0].name);
 *   const rule = decodeChromosomeBits(rec.bestChromBits);
 */

const CKPT_BASE = 'http://127.0.0.1:8088';

/**
 * Save a training checkpoint to the local server.
 *
 * @param {Object} args
 * @param {number[]} args.bits - 1648-element 0/1 array
 * @param {number} args.gen - generation number (0..config.generations)
 * @param {Object} args.config - full ESConfig (or subset with metric/popSize/gridW/gridH/rngSeed)
 * @param {number} args.bestScore - best score for this gen
 * @param {Object} [args.bestBreakdown] - 10 sub-metrics object (optional)
 * @returns {Promise<{ok: boolean, name?: string, file?: string, size?: number, error?: string}>}
 */
export async function saveCheckpoint({ bits, gen, config, bestScore, bestBreakdown, runTag = '' }) {
  if (!Array.isArray(bits) || bits.length !== 1648) {
    return { ok: false, error: `bits must be 1648-element array, got ${bits ? bits.length : 'null'}` };
  }
  if (typeof gen !== 'number' || !Number.isFinite(gen)) {
    return { ok: false, error: 'gen must be a finite number' };
  }
  if (!config || typeof config !== 'object') {
    return { ok: false, error: 'config must be an object' };
  }
  const payload = {
    config,
    gen: Math.floor(gen),
    bestScore: Number(bestScore) || 0,
    bestChromBits: bits,
    bestBreakdown: bestBreakdown || null,
    savedAt: new Date().toISOString(),
    runTag: runTag || '',  // ✅ (sko 07-07) anti-clobber tag, server checks vs existing file
  };
  try {
    const r = await fetch(`${CKPT_BASE}/ckpt/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, error: `server returned non-JSON (status ${r.status}): ${text.slice(0, 200)}` }; }
    if (!r.ok) {
      // ✅ (sko 07-07) Pass through HTTP status + structured 409 fields so caller
      //   can distinguish clobber-rejection (409) from generic errors.
      return {
        ok: false,
        status: r.status,
        error: data.error || `HTTP ${r.status}`,
        existing_runTag: data.existing_runTag,
        incoming_runTag: data.incoming_runTag,
        advice: data.advice,
      };
    }
    return data;
  } catch (e) {
    return { ok: false, error: `network error: ${e.message}` };
  }
}

/**
 * List all checkpoints on the server, newest first.
 * @returns {Promise<Array<{name, size, savedAt, mtime, gen, bestScore, config, hasBreakdown}>>}
 */
export async function listCheckpoints() {
  try {
    const r = await fetch(`${CKPT_BASE}/ckpt/list`);
    if (!r.ok) {
      console.warn('[ckpt] list failed:', r.status);
      return [];
    }
    return await r.json();
  } catch (e) {
    console.warn('[ckpt] list network error:', e.message);
    return [];
  }
}

/**
 * Load a single checkpoint record by filename.
 * @param {string} name - filename (e.g. "mazeQuality_pop200_g60x40_seed2026__gen0050__0ae73f.json")
 * @returns {Promise<Object|null>} - full record (config, gen, bestScore, bestChromBits, ...) or null
 */
export async function loadCheckpoint(name) {
  if (!name || !name.endsWith('.json')) {
    console.warn('[ckpt] loadCheckpoint: bad name', name);
    return null;
  }
  try {
    const r = await fetch(`${CKPT_BASE}/ckpt/load?name=${encodeURIComponent(name)}`);
    if (!r.ok) {
      console.warn('[ckpt] load failed:', r.status, name);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.warn('[ckpt] load network error:', e.message);
    return null;
  }
}

/**
 * Delete a checkpoint file from server.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function deleteCheckpoint(name) {
  try {
    const r = await fetch(`${CKPT_BASE}/ckpt/delete?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    return r.ok;
  } catch (e) {
    console.warn('[ckpt] delete failed:', e.message);
    return false;
  }
}

/**
 * Health check — verify server is reachable.
 * @returns {Promise<{ok: boolean, dir?: string, files?: number, error?: string}>}
 */
export async function healthCheck() {
  try {
    const r = await fetch(`${CKPT_BASE}/ckpt/health`);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
