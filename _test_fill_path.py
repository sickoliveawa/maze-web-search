"""_test_fill_path.py - dry-run 1 ckpt to verify GPU eval path works in chromium"""
from playwright.sync_api import sync_playwright
import time, json, os, base64

CDP = "http://127.0.0.1:9222"
URL = "http://127.0.0.1:8087/"
CKPT_DIR = r"E:\doro\maze-web\ckpt"

# Pick the simplest one: ma-1/mf=1/s=111
ck_name = "sweep_manhattan-1_mf1_s111.json"
with open(os.path.join(CKPT_DIR, ck_name)) as f:
    ck = json.load(f)
print(f"ckpt: {ck_name} saved={ck['bestScore']:.6f} gen={ck['gen']}")
bits_b64 = base64.b64encode(bytes(ck['bestChromBits'])).decode('ascii')
print(f"bits: {len(ck['bestChromBits'])} bytes -> b64 len {len(bits_b64)}")

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0]
    print(f"contexts={len(b.contexts)}")
    page = ctx.new_page()
    page.on("console", lambda m: print(f"  [console.{m.type}] {m.text[:200]}"))
    page.on("pageerror", lambda e: print(f"  [pageerror] {e}"))
    page.goto(URL + "?v=" + str(int(time.time() * 1000)), wait_until="domcontentloaded")
    time.sleep(2)
    print("page loaded")

    # Click train tab
    page.evaluate("() => document.querySelector('nav.tabs button[data-tab=train]')?.click()")
    time.sleep(2)
    print("train tab opened")

    res = page.evaluate("""
    async (args) => {
      const out = {steps: []};
      try {
        out.steps.push('importing gpu_scorer...');
        const mod = await import('/src/gpu/gpu_scorer.js');
        out.steps.push('mod keys: ' + Object.keys(mod).join(','));
        const BatchedGPUScorer = mod.BatchedGPUScorer;
        if (!BatchedGPUScorer) return {error: 'no BatchedGPUScorer export'};
        out.steps.push('BatchedGPUScorer typeof: ' + typeof BatchedGPUScorer);

        out.steps.push('importing gpu_engine...');
        const engineMod = await import('/src/gpu/gpu_engine.js');
        out.steps.push('engineMod keys: ' + Object.keys(engineMod).join(','));
        const GPUEngine = engineMod.GPUEngine;
        if (!GPUEngine) return {error: 'no GPUEngine export'};

        out.steps.push('creating engine...');
        const engine = new GPUEngine();
        out.steps.push('engine init...');
        const initRes = await engine.init();
        out.steps.push('engine init res: ' + JSON.stringify(initRes));
        if (!initRes.ok) return {error: 'engine.init failed: ' + initRes.error};

        out.steps.push('instantiating BatchedGPUScorer...');
        const scorer = new BatchedGPUScorer(engine);
        out.steps.push('init...');
        await scorer.init();
        out.steps.push('scorer ready');
        window._testScorer = scorer;

        // Now evaluate the bits — decodeChromosome wants Uint8Array
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
        out.opts = opts;
        out.steps.push('evaluateBatchBatched...');
        const results = await scorer.evaluateBatchBatched([chrom], opts);
        out.steps.push('results.length: ' + results.length);
        const r = results[0];
        out.score = r.score;
        out.total = r.total;
        out.conn = r.conn;
        out.connected = r.connected;
        return out;
      } catch (e) {
        out.error = e.message || String(e);
        out.stack = e.stack;
        return out;
      }
    }
    """, {"bits_b64": bits_b64, "cfg": ck['config']})
    print("RES:", json.dumps(res, indent=2))
    page.close()
    b.close()
