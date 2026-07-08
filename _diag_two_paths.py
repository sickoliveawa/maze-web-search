"""
End-to-end: 2 GPU eval paths vs saved bestScore
  Path A: preview.js (RuleChromosome.decode → BatchedGPUEngine.encodeRules → runBatchedSteps × N steps)
  Path B: train.js  (gpu_scorer.decodeChromosome → BatchedGPUScorer.evaluateBatchBatched × N steps)

If both paths return the same final grid AND same score, preview.js logic is correct.
If they differ → preview.js has a code-path bug.

Test on 1-family vs multi-family to confirm sko's symptom.
"""
from playwright.sync_api import sync_playwright
import time, json

CDP = "http://127.0.0.1:9222"
URL = "http://127.0.0.1:8087/"

TEST_CKPTS = [
    'sweep_manhattan-2_mf1_s111.json',     # mf=1, should match
    'sweep_manhattan-2_mf1_s444.json',     # mf=1
    'sweep_manhattan-2_mf8_s444.json',     # mf=8
    'sweep_manhattan-3_mf4_s333.json',     # mf=4
    'sweep_chebyshev-1_mf8_s333.json',     # mf=8, paper panel b
    'sweep_chebyshev-2_mf2_s333.json',     # mf=2
    'sweep_manhattan-1_mf2_s222.json',     # mf=2, mf=1 NOT present for ma-1
]

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0]
    page = ctx.new_page()
    page.on("console", lambda msg: print(f"  [browser.{msg.type}] {msg.text[:200]}"))
    page.goto(URL + "?v=" + str(int(time.time()*1000)), wait_until="domcontentloaded")
    time.sleep(3)

    for name in TEST_CKPTS:
        print(f"\n========== {name} ==========")
        try:
            result = page.evaluate(f"""async () => {{
                const ckptMod = await import('/src/ckpt.js');
                const rcMod = await import('/src/search/rule_chromosome.js');
                const chromMod = await import('/src/search/chromosome.js');
                const gsMod = await import('/src/gpu/gpu_scorer.js');
                const engMod = await import('/src/gpu/gpu_engine_batched.js');
                const mqMod = await import('/src/metrics/maze_quality.js');
                const randMod = await import('/src/core/random.js');
                const gridMod = await import('/src/core/grid.js');

                const ckpt = await ckptMod.loadCheckpoint('{name}');
                const bitsArr = new Uint8Array(ckpt.bestChromBits);
                const W = ckpt.config.gridW;
                const H = ckpt.config.gridH;
                const caSteps = ckpt.config.caSteps;
                const rs = ckpt.config.randomSeed;
                const maskType = ckpt.config.cellMaskType;
                const initFull = ckpt.config.initFullScreen !== false;
                const initDens = ckpt.config.initDensity ?? 0.15;

                // === Path A: preview.js style ===
                // 1. decode via RuleChromosome (no mask filter)
                const ba = new chromMod.BitArray(bitsArr.length);
                for (let i = 0; i < bitsArr.length; i++) ba.set(i, bitsArr[i]);
                const ruleA = (new rcMod.RuleChromosome(ba)).decode();
                ruleA._W = W; ruleA._H = H;

                // 2. init grid via Grid.random (preview.js style) with seed=0
                //    (preview.js doesn't use F2 init seed — it uses bare seed from input)
                const rngA = new randMod.SeededRandom(0);
                const initA = gridMod.Grid.random(W, H, 0.15, rngA).data;
                const initAU32 = new Uint32Array(W * H);
                for (let i = 0; i < initA.length; i++) initAU32[i] = initA[i] > 0 ? 1 : 0;

                // 3. encode + run via BatchedGPUEngine
                const engA = new engMod.BatchedGPUEngine();
                await engA.init();
                const encA = engA.encodeRules([ruleA]);
                const resA = await engA.runBatchedSteps({{
                    ruleParams: encA,
                    initialGrids: initAU32,
                    width: W, height: H, numSeeds: 1, numRules: 1,
                    steps: caSteps,
                    topologyType: 0, defaultState: 0,
                }});
                const gridA = Array.from(resA.finalGrids.slice(0, W*H));
                const mqA = mqMod.mazeQuality(new Uint8Array(gridA), W, H);
                const mqAinv = mqMod.mazeQuality(new Uint8Array(gridA.map(v => 1-v)), W, H);
                const mqA_best = mqAinv.total > mqA.total ? mqAinv.total : mqA.total;
                const mqA_usedInv = mqAinv.total > mqA.total;

                // === Path B: train.js style ===
                // 1. decode via gpu_scorer.js (with mask filter)
                const cfgB = {{
                    gridW: W, gridH: H, caSteps,
                    cellMaskType: maskType,
                    maxFamilies: ckpt.config.maxFamilies ?? 1,
                    activeFamilySlots: ckpt.config.activeFamilySlots ?? [0],
                    initFullScreen: initFull, initDensity: initDens,
                    withInvert: true, metric: 'mazeQuality',
                }};
                const scorerB = new gsMod.BatchedGPUScorer(cfgB);
                const chromB = new chromMod.BitArray(bitsArr.length);
                chromB.fromBits(new Uint8Array(bitsArr));
                const resB = await scorerB.evaluateBatchBatched([chromB], {{
                    seeds: 1, gridWidth: W, gridHeight: H, steps: caSteps,
                    patchSize: ckpt.config.initPatchSize ?? 60,
                    cellMaskType: maskType,
                    randomSeed: rs, metric: 'mazeQuality',
                    initFullScreen: true, initDensity: 0.15,
                }});
                const gridB = resB[0]?.bestGrid ? Array.from(resB[0].bestGrid) : [];
                const scoreB = resB[0]?.bestScore ?? resB[0]?.score;
                scorerB.destroy();

                // === Compare ===
                let gridMatch = true;
                if (gridA.length === gridB.length) {{
                    for (let i = 0; i < gridA.length; i++) if (gridA[i] !== gridB[i]) {{ gridMatch = false; break; }}
                }} else {{ gridMatch = false; }}
                let onesA = gridA.reduce((a,b)=>a+(b>0?1:0), 0);
                let onesB = gridB.reduce((a,b)=>a+(b>0?1:0), 0);

                return {{
                    name: '{name}', mask: maskType, rs,
                    saved_score: ckpt.bestScore,
                    A: {{ score: mqA_best, usedInv: mqA_usedInv, ones: onesA, total: gridA.length, first16: gridA.slice(0,16) }},
                    B: {{ score: scoreB, ones: onesB, total: gridB.length, first16: gridB.slice(0,16) }},
                    grid_match: gridMatch,
                    n_families_A: ruleA.families.length,
                }};
            }}""")
            print(f"  mask={result['mask']} rs={result['rs']} saved_score={result['saved_score']:.4f}")
            print(f"  Path A (preview.js, seed=0, no mask filter): score={result['A']['score']:.4f} (usedInv={result['A']['usedInv']}) ones={result['A']['ones']}/{result['A']['total']} n_families={result['n_families_A']}")
            print(f"  Path B (train.js, F2 init, mask filter):     score={result['B']['score']:.4f} ones={result['B']['ones']}/{result['B']['total']}")
            print(f"  grid match? {result['grid_match']}")
            if not result['grid_match']:
                print(f"  A first 16: {result['A']['first16']}")
                print(f"  B first 16: {result['B']['first16']}")
            print(f"  score match? {abs(result['A']['score'] - result['B']['score']) < 0.01}, diff={result['A']['score'] - result['B']['score']:.4f}")
        except Exception as e:
            import traceback
            print(f"  ERROR: {e}")
            print(traceback.format_exc())

    page.close()
    b.close()
