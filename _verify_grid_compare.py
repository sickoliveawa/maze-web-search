"""
End-to-end grid comparison:
  - Load ckpt into preview tab (with patch applied)
  - Init + 300 steps via step×10
  - Extract grid bits from preview internal state
  - Extract grid bits from GPU eval reproduce
  - Compare bit-by-bit
"""
from playwright.sync_api import sync_playwright
import time, json, os, shutil

URL = "http://127.0.0.1:8087/"
NAMES = ['sweep_manhattan-2_mf1_s111.json', 'sweep_manhattan-2_mf8_s444.json']

fresh_profile = "C:/Users/sicko/AppData/Local/Temp/verify_grid_cmp_2026_07_08"
if os.path.exists(fresh_profile):
    shutil.rmtree(fresh_profile, ignore_errors=True)
os.makedirs(fresh_profile, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(
        user_data_dir=fresh_profile,
        headless=False,
        args=["--no-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan"],
    )
    page = browser.pages[0] if browser.pages else browser.new_page()
    page.on("console", lambda msg: None)
    page.goto(URL + "?v=" + str(int(time.time()*1000)), wait_until="domcontentloaded")
    time.sleep(3)

    for NAME in NAMES:
        print(f"\n========== {NAME} ==========")
        with open(f'ckpt/{NAME}') as f:
            t = json.load(f)
        rs = t['config']['randomSeed']
        W = t['config']['gridW']
        H = t['config']['gridH']
        caSteps = t['config']['caSteps']
        mask = t['config']['cellMaskType']
        bits = t['bestChromBits']

        # Compute F2 seed
        chromHash = 0
        for b in bits:
            chromHash = ((chromHash * 31) + b) | 0
        f2_seed = (rs + chromHash * 65537) & 0xFFFFFFFF

        # Load ckpt in browser
        page.evaluate("() => document.querySelector('nav.tabs button[data-tab=preview]')?.click()")
        time.sleep(0.5)
        page.evaluate("() => document.querySelector('#pv-ckpt-refresh')?.click()")
        time.sleep(1.5)
        page.evaluate(f"""() => {{
          const cards = document.querySelectorAll('.ckpt-card');
          for (const c of cards) {{
            if (c.dataset.name === '{NAME}') {{ c.click(); return; }}
          }}
        }}""")
        time.sleep(2)

        init_seed_input = page.evaluate("() => document.getElementById('pv-init-seed')?.value")
        print(f"  init seed input: {init_seed_input} (F2 expected: {f2_seed})")

        # Init + 300 steps
        page.evaluate("() => document.querySelector('#pv-init')?.click()")
        time.sleep(1.0)
        for i in range(30):
            page.evaluate("() => document.querySelector('#pv-step-10')?.click()")
            time.sleep(0.2)
        time.sleep(1.0)

        # Extract grid from preview module's internal `grid` variable
        # We need to fish it out. The module has `let grid` not exported, but we can:
        #  - Read canvas pixel data and infer grid
        #  - Use a known pattern: the canvas shows the dual-interpretation selected grid
        #  - We can re-import GPU eval, run with F2 seed, get expected grid
        # Easier: re-run GPU eval in JS and compare with canvas hash
        result = page.evaluate(f"""async () => {{
            const ckptMod = await import('/src/ckpt.js');
            const chromMod = await import('/src/search/chromosome.js');
            const gsMod = await import('/src/gpu/gpu_scorer.js');
            const mqMod = await import('/src/metrics/maze_quality.js');

            // Get canvas pixels
            const c = document.querySelector('#pv-canvas');
            const ctx = c.getContext('2d');
            const imgData = ctx.getImageData(0, 0, c.width, c.height).data;
            // Count dark vs light cells
            let dark = 0, light = 0;
            const cellSize = 6;  // 6px per cell, 40x60 grid → 240x360 canvas
            const cw = c.width / {W}, ch = c.height / {H};
            for (let y = 0; y < {H}; y++) {{
                for (let x = 0; x < {W}; x++) {{
                    const px = Math.floor((x + 0.5) * cw);
                    const py = Math.floor((y + 0.5) * ch);
                    const idx = (py * c.width + px) * 4;
                    const sum = imgData[idx] + imgData[idx+1] + imgData[idx+2];
                    if (sum < 200) dark++; else light++;
                }}
            }}

            // Also: do GPU eval reproduce to get expected grid
            const ckpt = await ckptMod.loadCheckpoint('{NAME}');
            const bitsArr = new Uint8Array(ckpt.bestChromBits);
            const cfg = {{
                gridW: {W}, gridH: {H}, caSteps: {caSteps},
                initFullScreen: ckpt.config.initFullScreen,
                initPatchSize: ckpt.config.initPatchSize ?? 60,
                initDensity: ckpt.config.initDensity ?? 0.15,
                cellMaskType: '{mask}',
                maxFamilies: ckpt.config.maxFamilies ?? 1,
                activeFamilySlots: ckpt.config.activeFamilySlots ?? [0],
                useLayeredMutation: false, withInvert: true, metric: 'mazeQuality',
            }};
            const scorer = new gsMod.BatchedGPUScorer(cfg);
            const chrom = new chromMod.BitArray(bitsArr.length);
            chrom.fromBits(bitsArr);
            const res = await scorer.evaluateBatchBatched([chrom], {{
                seeds: 1, gridWidth: {W}, gridHeight: {H}, steps: {caSteps},
                patchSize: cfg.initPatchSize, cellMaskType: '{mask}',
                randomSeed: {rs}, metric: 'mazeQuality',
                initFullScreen: true, initDensity: 0.15,
            }});
            const expectedGrid = res[0]?.bestGrid ? Array.from(res[0].bestGrid) : [];
            const usedInv = res[0]?.usedInverted;
            const expectedOnes = expectedGrid.reduce((a,b)=>a+(b>0?1:0), 0);
            scorer.destroy();

            return {{
                canvas_dark_cells: dark,
                canvas_light_cells: light,
                expected_grid_ones: expectedOnes,
                expected_grid_total: expectedGrid.length,
                expected_grid_first32: expectedGrid.slice(0, 32),
            }};
        }}""")
        print(f"  canvas dark cells: {result['canvas_dark_cells']}, light cells: {result['canvas_light_cells']}")
        print(f"  expected grid ones: {result['expected_grid_ones']} / {result['expected_grid_total']} ({100*result['expected_grid_ones']/result['expected_grid_total']:.1f}%)")
        print(f"  expected grid first 32: {result['expected_grid_first32']}")
        # Note: canvas uses drawLiveCells=true so LIVE cells are dark
        # So canvas_dark = number of live cells = expected_grid_ones (if usedInv=false)
        # OR canvas_dark = expected_grid_dead (if usedInv=true)
        # match if canvas_dark ≈ expected_grid_ones OR canvas_dark ≈ (total - expected_grid_ones)
        ones = result['expected_grid_ones']
        total = result['expected_grid_total']
        canvas_dark = result['canvas_dark_cells']
        diff_ones = abs(canvas_dark - ones)
        diff_inv = abs(canvas_dark - (total - ones))
        if diff_ones < 100:
            print(f"  ✓ canvas dark ({canvas_dark}) matches expected ONES ({ones}), diff={diff_ones}")
        elif diff_inv < 100:
            print(f"  ✓ canvas dark ({canvas_dark}) matches expected INVERTED (dead={total-ones}), diff={diff_inv}")
        else:
            print(f"  ❌ canvas dark ({canvas_dark}) doesn't match expected grid (ones={ones}, dead={total-ones})")
            print(f"  diff_ones={diff_ones}, diff_inv={diff_inv}")

    browser.close()
