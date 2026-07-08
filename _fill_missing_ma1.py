"""
_fill_missing_ma1.py
================================================================
Fill in the 6 missing ndjson entries for sweep_2026_07_04:
  4× manhattan-1/mf=1 (s111, s222, s333, s444)
  2× manhattan-1/mf=2 (s111, s222)

These 6 ckpts WERE saved by dispatcher (gen < 500 timeout) but
ndjson entry is status=TIMEOUT with best=null.

For each:
  1. Load ckpt JSON
  2. Call gpu_scorer via browser CDP using verified path:
       import { BatchedGPUScorer } from '/src/gpu/gpu_scorer.js';
       import { GPUEngine } from '/src/gpu/gpu_engine.js';
       engine = new GPUEngine(); await engine.init();
       scorer = new BatchedGPUScorer(engine); await scorer.init();
       results = scorer.evaluateBatchBatched([chrom], opts);
  3. Compare reproduced score vs ckpt.bestScore (saved)
  4. Record to results_filled.ndjson (don't touch original)
================================================================
"""
from playwright.sync_api import sync_playwright
import time, json, os, datetime, base64, sys

CDP = "http://127.0.0.1:9222"
URL = "http://127.0.0.1:8087/"
CKPT_DIR = r"E:\doro\maze-web\ckpt"
NDJSON_FILL = r"E:\doro\maze-web\sweep_2026_07_04\results_filled.ndjson"
LOG = r"E:\doro\maze-web\sweep_2026_07_04\fill_missing.log"

MISSING = [
    "sweep_manhattan-1_mf1_s111.json",
    "sweep_manhattan-1_mf1_s222.json",
    "sweep_manhattan-1_mf1_s333.json",
    "sweep_manhattan-1_mf1_s444.json",
    "sweep_manhattan-1_mf2_s111.json",
    "sweep_manhattan-1_mf2_s222.json",
]

EVAL_SCRIPT = """
async (args) => {
  const out = {steps: []};
  try {
    if (!window._batchedScorer) {
      out.steps.push('creating scorer...');
      const gpuScorerMod = await import('/src/gpu/gpu_scorer.js');
      const gpuEngineMod = await import('/src/gpu/gpu_engine.js');
      const engine = new gpuEngineMod.GPUEngine();
      const initRes = await engine.init();
      if (!initRes.ok) return {error: 'engine.init failed: ' + initRes.error};
      const scorer = new gpuScorerMod.BatchedGPUScorer(engine);
      await scorer.init();
      window._batchedScorer = scorer;
      out.steps.push('scorer created');
    } else {
      out.steps.push('reusing cached scorer');
    }

    const bitsArr = new Uint8Array(atob(args.bits_b64).split('').map(c => c.charCodeAt(0)));
    const cfg = args.cfg;
    const chrom = { bits: bitsArr };
    const opts = {
      seeds: cfg.seeds || 1,
      gridWidth: cfg.gridW,
      gridHeight: cfg.gridH,
      steps: cfg.caSteps || 300,
      patchSize: cfg.initPatchSize || 60,
      cellMaskType: cfg.cellMaskType,
      randomSeed: cfg.randomSeed,
      metric: cfg.metric || 'mazeQuality',
      initFullScreen: cfg.initFullScreen !== false,
      initDensity: cfg.initDensity || 0.15,
      maxFamilies: cfg.maxFamilies,
      activeFamilySlots: cfg.activeFamilySlots,
    };
    const results = await window._batchedScorer.evaluateBatchBatched([chrom], opts);
    const r = results[0];
    return {
      score: r.score,
      total: r.total,
      conn: r.conn,
      connected: r.connected,
      steps: out.steps,
    };
  } catch (e) {
    out.error = e.message || String(e);
    out.stack = e.stack;
    return out;
  }
}
"""

def log(msg):
    ts = datetime.datetime.now().isoformat()
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")

# ============== MAIN ==============
log(f"=== fill missing ma-1 starting ===")
log(f"MISSING: {MISSING}")

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0]
    log(f"connected to CDP, contexts={len(b.contexts)}")

    page = ctx.new_page()
    page.on("console", lambda msg: log(f"  [console.{msg.type}] {msg.text[:200]}"))
    page.on("pageerror", lambda e: log(f"  [pageerror] {e}"))
    page.goto(URL + "?v=" + str(int(time.time() * 1000)), wait_until="domcontentloaded")
    time.sleep(2)
    log("page loaded")
    # Train tab to ensure gpu_scorer module is in cache
    page.evaluate("() => document.querySelector('nav.tabs button[data-tab=train]')?.click()")
    time.sleep(2)
    log("train tab opened")

    for ck_name in MISSING:
        log(f"\n=== {ck_name} ===")
        ck_path = os.path.join(CKPT_DIR, ck_name)
        with open(ck_path) as f:
            ck = json.load(f)
        saved = ck.get('bestScore')
        gen = ck.get('gen')
        bits_b64 = base64.b64encode(bytes(ck['bestChromBits'])).decode('ascii')
        log(f"  saved bestScore={saved:.6f} gen={gen} bits={len(ck['bestChromBits'])}")
        t0 = time.time()
        res = page.evaluate(EVAL_SCRIPT, {"bits_b64": bits_b64, "cfg": ck['config']})
        dt = time.time() - t0
        if 'error' in res:
            log(f"  ❌ ERROR ({dt:.1f}s): {res['error']}")
            rec = {
                "name": ck_name,
                "mask": ck['config']['cellMaskType'],
                "maxFam": ck['config']['maxFamilies'],
                "seed": ck['config']['randomSeed'],
                "gen": gen,
                "saved_best": saved,
                "repro_best": None,
                "diff": None,
                "status": "REPRODUCE_FAILED",
                "error": res['error'],
                "wall_sec": round(dt, 1),
                "ts": datetime.datetime.now().isoformat(),
            }
        else:
            repro = res['score']
            diff = abs(repro - saved) if (repro is not None and saved is not None) else None
            log(f"  ✓ repro={repro:.6f}  diff={diff:.2e}  ({dt:.1f}s)")
            rec = {
                "name": ck_name,
                "mask": ck['config']['cellMaskType'],
                "maxFam": ck['config']['maxFamilies'],
                "seed": ck['config']['randomSeed'],
                "gen": gen,
                "saved_best": saved,
                "repro_best": repro,
                "diff": diff,
                "status": "OK_REPRODUCED" if (diff is not None and diff < 1e-6) else "DRIFT",
                "wall_sec": round(dt, 1),
                "ts": datetime.datetime.now().isoformat(),
            }
        with open(NDJSON_FILL, "a") as f:
            f.write(json.dumps(rec) + "\n")
        log(f"  recorded: status={rec['status']}")

    page.close()
    b.close()

log("\n=== fill missing complete ===")
log(f"results_filled.ndjson: {NDJSON_FILL}")
log("\nDONE")
