"""
Reproduce sweep 4 ckpts in sko's Edge — same method as test.json reproduce.
If sweep reproduce DIFFERS from saved, sweep script is buggy.
If sweep reproduce MATCHES, bits are OK and the issue is elsewhere.
"""
from playwright.sync_api import sync_playwright
import time, json, sys

CDP = "http://127.0.0.1:9222"
URL = "http://127.0.0.1:8087/"

NAMES = [
    'sweep_manhattan-2_mf1_s111.json',
    'sweep_manhattan-2_mf1_s222.json',
    'sweep_manhattan-2_mf1_s333.json',
    'sweep_manhattan-2_mf1_s444.json',
]

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0]
    page = ctx.new_page()
    page.on("console", lambda msg: print(f"  [browser.{msg.type}] {msg.text[:160]}"))
    page.goto(URL + "?v=" + str(int(time.time()*1000)), wait_until="domcontentloaded")
    time.sleep(3)

    for name in NAMES:
        # Read disk fingerprint
        with open(f'ckpt/{name}') as f:
            t_disk = json.load(f)
        bits_disk = t_disk['bestChromBits']
        ones_disk = sum(bits_disk)
        saved = t_disk['bestScore']
        gen = t_disk['gen']
        rs = t_disk['config']['randomSeed']
        W = t_disk['config']['gridW']
        H = t_disk['config']['gridH']
        caSteps = t_disk['config']['caSteps']
        mask = t_disk['config']['cellMaskType']

        print(f"\n========== {name} ==========")
        print(f"  disk: gen={gen} saved={saved:.6f} rs={rs} {W}x{H} mask={mask} caSteps={caSteps}")
        print(f"  bits ones={ones_disk}")

        # Same GPU eval path
        repro = page.evaluate(f"""async () => {{
            const ckptMod = await import('/src/ckpt.js');
            const chromMod = await import('/src/search/chromosome.js');
            const scorerMod = await import('/src/gpu/gpu_scorer.js');

            const ckpt = await ckptMod.loadCheckpoint('{name}');
            const bits = new Uint8Array(ckpt.bestChromBits);
            const W = ckpt.config.gridW;
            const H = ckpt.config.gridH;
            const caSteps = ckpt.config.caSteps;
            const rs = ckpt.config.randomSeed;
            const maskType = ckpt.config.cellMaskType;

            const cfg = {{
              gridW: W, gridH: H, caSteps,
              initFullScreen: ckpt.config.initFullScreen,
              initPatchSize: ckpt.config.initPatchSize ?? 60,
              initDensity: ckpt.config.initDensity ?? 0.15,
              cellMaskType: maskType,
              maxFamilies: ckpt.config.maxFamilies ?? 1,
              activeFamilySlots: ckpt.config.activeFamilySlots ?? [0],
              useLayeredMutation: false,
              withInvert: true,
              metric: 'mazeQuality',
            }};
            const scorer = new scorerMod.BatchedGPUScorer(cfg);
            const chrom = new chromMod.BitArray(bits.length);
            chrom.fromBits(bits);
            const t0 = performance.now();
            const res = await scorer.evaluateBatchBatched([chrom], {{
              seeds: 1, gridWidth: W, gridHeight: H, steps: caSteps,
              patchSize: cfg.initPatchSize, cellMaskType: maskType,
              randomSeed: rs, metric: 'mazeQuality',
              initFullScreen: true, initDensity: 0.15,
            }});
            const t1 = performance.now();
            const score = res[0]?.bestScore ?? res[0]?.score ?? -999;
            const grid = res[0]?.bestGrid;
            const initGrid = res[0]?.bestInitGrid;
            let ones = 0, h0 = 0;
            if (grid) {{ for (let i = 0; i < grid.length; i++) {{ ones += grid[i] > 0 ? 1 : 0; h0 = ((h0 * 31) + grid[i]) | 0; }} }}
            let i_ones = 0, i_h0 = 0;
            if (initGrid) {{ for (let i = 0; i < initGrid.length; i++) {{ i_ones += initGrid[i] > 0 ? 1 : 0; i_h0 = ((i_h0 * 31) + initGrid[i]) | 0; }} }}
            return {{
              loaded_ones: Array.from(bits).reduce((a,b)=>a+b, 0),
              reproduce_score: score,
              saved_score: ckpt.bestScore,
              diff: score - ckpt.bestScore,
              eval_ms: t1 - t0,
              grid_ones: ones, grid_hash: h0,
              init_ones: i_ones, init_hash: i_h0,
            }};
        }}""")
        print(f"  loaded: {repro['loaded_ones']} ones (disk: {ones_disk})")
        print(f"  reproduce: {repro['reproduce_score']:.6f}  saved: {repro['saved_score']:.6f}  diff: {repro['diff']:.2e}")
        print(f"  init_ones={repro['init_ones']} (expected ~{W*H*0.15:.0f})  grid_ones={repro['grid_ones']} (out of {W*H})")
        if abs(repro['diff']) < 0.001:
            print("  ✓ MATCH (bits OK, sweep script saved correct ckpt)")
        elif abs(repro['diff'] - (-100 - saved)) < 1 or repro['reproduce_score'] <= -99:
            print("  ⚠️ GATED (chrom got -100 from mq gate — possibly wall_ratio out of range)")
        else:
            print(f"  ❌ MISMATCH by {repro['diff']:.4f} — sweep script may have wrong bits in ckpt!")

    page.close()
    b.close()
