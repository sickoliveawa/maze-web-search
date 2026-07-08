"""
Verify the cellMaskType fix:
  - Load ckpt into preview tab (with patched RuleChromosome + preview.js)
  - Init + 300 steps
  - Extract canvas grid (dark cells)
  - Compare against expected grid (GPU eval reproduce, which uses gpu_scorer.decodeChromosome WITH filter)
  - Should now match!
"""
from playwright.sync_api import sync_playwright
import time, json, os, shutil

URL = "http://127.0.0.1:8087/"
NAMES = [
    'sweep_manhattan-2_mf1_s111.json',
    'sweep_manhattan-2_mf8_s444.json',
    'sweep_manhattan-1_mf2_s222.json',
    'sweep_chebyshev-1_mf8_s333.json',
    'sweep_manhattan-3_mf4_s333.json',
]

fresh_profile = "C:/Users/sicko/AppData/Local/Temp/verify_filter_fix_2026_07_08"
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

    # Verify new code is loaded
    src = page.evaluate("async () => (await fetch('/src/search/rule_chromosome.js')).text()")
    has_cellInRange = 'function cellInRange' in src
    has_decode_param = 'decode(cellMaskType)' in src
    print(f"=== Source verification ===")
    print(f"  Has 'function cellInRange': {has_cellInRange}")
    print(f"  Has 'decode(cellMaskType)' param: {has_decode_param}")
    if not (has_cellInRange and has_decode_param):
        print("  ❌ STALE MODULE")
        browser.close()
        exit(1)
    print(f"  ✓ New code present")

    for NAME in NAMES:
        print(f"\n========== {NAME} ==========")
        with open(f'ckpt/{NAME}') as f:
            t = json.load(f)
        rs = t['config']['randomSeed']
        W = t['config']['gridW']
        H = t['config']['gridH']
        caSteps = t['config']['caSteps']
        mask = t['config']['cellMaskType']

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

        # Init + 300 steps
        page.evaluate("() => document.querySelector('#pv-init')?.click()")
        time.sleep(1.0)
        for i in range(30):
            page.evaluate("() => document.querySelector('#pv-step-10')?.click()")
            time.sleep(0.2)
        time.sleep(1.0)

        # Capture canvas
        png_b64 = page.evaluate("() => document.querySelector('#pv-canvas')?.toDataURL('image/png')")
        if png_b64:
            png_path = f'E:/doro/maze-web/_verify_filter_fix_{NAME.replace(".json","")}.png'
            import base64
            with open(png_path, 'wb') as f:
                f.write(base64.b64decode(png_b64.split(',', 1)[1]))

        # Extract grid dark count + compare
        result = page.evaluate(f"""async () => {{
            const c = document.querySelector('#pv-canvas');
            const ctx = c.getContext('2d');
            const imgData = ctx.getImageData(0, 0, c.width, c.height).data;
            let dark = 0;
            const cw = c.width / {W}, ch = c.height / {H};
            for (let y = 0; y < {H}; y++) {{
                for (let x = 0; x < {W}; x++) {{
                    const px = Math.floor((x + 0.5) * cw);
                    const py = Math.floor((y + 0.5) * ch);
                    const idx = (py * c.width + px) * 4;
                    const sum = imgData[idx] + imgData[idx+1] + imgData[idx+2];
                    if (sum < 200) dark++;
                }}
            }}

            // GPU eval reproduce
            const ckptMod = await import('/src/ckpt.js');
            const chromMod = await import('/src/search/chromosome.js');
            const gsMod = await import('/src/gpu/gpu_scorer.js');
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
            const expectedOnes = res[0]?.bestGrid ? Array.from(res[0].bestGrid).reduce((a,b)=>a+(b>0?1:0), 0) : 0;
            const totalCells = {W} * {H};
            const status = document.getElementById('pv-status')?.textContent || '';
            scorer.destroy();

            return {{
                status, canvas_dark: dark,
                expected_ones: expectedOnes, expected_dead: totalCells - expectedOnes,
                total: totalCells,
            }};
        }}""")
        ones = result['expected_ones']
        dead = result['expected_dead']
        dark = result['canvas_dark']
        diff_ones = abs(dark - ones)
        diff_inv = abs(dark - dead)
        print(f"  status: {result['status']!r}")
        print(f"  canvas dark: {dark}, expected ones: {ones}, expected dead: {dead}")
        if diff_ones < 50:
            print(f"  ✓ canvas DARK matches expected ONES (diff {diff_ones}) — preview shows orig side, dark=live")
        elif diff_inv < 50:
            print(f"  ✓ canvas DARK matches expected DEAD/INVERTED (diff {diff_inv}) — preview shows inv side, dark=dead")
        else:
            print(f"  ❌ canvas DARK ({dark}) doesn't match expected grid (ones={ones}, dead={dead}, total={result['total']})")
            print(f"  diff_ones={diff_ones}, diff_inv={diff_inv}")

    browser.close()
