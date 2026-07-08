"""
Paper fig 6 v2 6-panel reproduce verification.
For each panel: load ckpt in browser, Init + 300 steps, compare canvas dark count
vs GPU eval reproduce (which uses the corrected cellInRange filter + F2 init seed).

Paper v1.2 audit (5/6 fail) was BEFORE the cellMaskType filter fix.
After fix: should be 6/6 canvas-eval match.
"""
from playwright.sync_api import sync_playwright
import time, json, os, shutil

URL = "http://127.0.0.1:8087/"

PANELS = [
    ('a', 'sweep_manhattan-2_mf8_s444.json', 'manhattan-2', 'best'),
    ('b', 'sweep_chebyshev-1_mf8_s333.json', 'chebyshev-1', 'best (51.7h drift)'),
    ('c', 'sweep_chebyshev-2_mf2_s333.json', 'chebyshev-2', 'best'),
    ('d', 'sweep_manhattan-4_mf1_s111.json', 'manhattan-4', 'best'),
    ('e', 'sweep_chebyshev-4_mf1_s111.json', 'chebyshev-4', 'FAIL (dead mask)'),
    ('f', 'sweep_manhattan-1_mf2_s444.json', 'manhattan-1', 'FAIL (stuck)'),
]

fresh_profile = "C:/Users/sicko/AppData/Local/Temp/paper_v2_2026_07_08"
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

    # Verify new code
    src_rc = page.evaluate("async () => (await fetch('/src/search/rule_chromosome.js')).text()")
    src_pv = page.evaluate("async () => (await fetch('/src/tabs/preview.js')).text()")
    has_cellInRange = 'function cellInRange' in src_rc
    has_f2seed = 'f2Seed' in src_pv
    print(f"=== Source check: cellInRange={has_cellInRange} f2Seed={has_f2seed} ===\n")

    page.evaluate("() => document.querySelector('nav.tabs button[data-tab=preview]')?.click()")
    time.sleep(0.5)
    page.evaluate("() => document.querySelector('#pv-ckpt-refresh')?.click()")
    time.sleep(1.5)

    results = []
    for label, NAME, mask, kind in PANELS:
        print(f"\n========== panel ({label}): {NAME} ({kind}) ==========")
        with open(f'ckpt/{NAME}') as f:
            t = json.load(f)
        rs = t['config']['randomSeed']
        W = t['config']['gridW']
        H = t['config']['gridH']
        caSteps = t['config']['caSteps']
        saved_score = t['bestScore']
        saved_gen = t['gen']
        mtime = t.get('savedAt', '?')
        print(f"  saved: {saved_score:.4f}  gen={saved_gen}  savedAt={mtime}")

        # Click card
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

        result = page.evaluate(f"""async () => {{
            const ckptMod = await import('/src/ckpt.js');
            const chromMod = await import('/src/search/chromosome.js');
            const gsMod = await import('/src/gpu/gpu_scorer.js');
            const ckpt = await ckptMod.loadCheckpoint('{NAME}');
            const bitsArr = new Uint8Array(ckpt.bestChromBits);
            const W = ckpt.config.gridW, H = ckpt.config.gridH, caSteps = ckpt.config.caSteps;
            const cfg = {{
                gridW: W, gridH: H, caSteps,
                initFullScreen: ckpt.config.initFullScreen,
                initPatchSize: ckpt.config.initPatchSize ?? 60,
                initDensity: ckpt.config.initDensity ?? 0.15,
                cellMaskType: ckpt.config.cellMaskType,
                maxFamilies: ckpt.config.maxFamilies ?? 1,
                activeFamilySlots: ckpt.config.activeFamilySlots ?? [0],
                useLayeredMutation: false, withInvert: true, metric: 'mazeQuality',
            }};
            const scorer = new gsMod.BatchedGPUScorer(cfg);
            const chrom = new chromMod.BitArray(bitsArr.length);
            chrom.fromBits(bitsArr);
            const res = await scorer.evaluateBatchBatched([chrom], {{
                seeds: 1, gridWidth: W, gridHeight: H, steps: caSteps,
                patchSize: cfg.initPatchSize, cellMaskType: cfg.cellMaskType,
                randomSeed: ckpt.config.randomSeed, metric: 'mazeQuality',
                initFullScreen: true, initDensity: 0.15,
            }});
            const reproScore = res[0]?.bestScore ?? res[0]?.score;
            const expectedGrid = res[0]?.bestGrid ? Array.from(res[0].bestGrid) : [];
            const expectedOnes = expectedGrid.reduce((a,b)=>a+(b>0?1:0), 0);
            const expectedDead = expectedGrid.length - expectedOnes;
            const usedInv = res[0]?.usedInverted;
            scorer.destroy();

            // canvas dark count
            const c = document.querySelector('#pv-canvas');
            const ctx = c.getContext('2d');
            const imgData = ctx.getImageData(0, 0, c.width, c.height).data;
            let dark = 0;
            const cw = c.width / W, ch = c.height / H;
            for (let y = 0; y < H; y++) {{
                for (let x = 0; x < W; x++) {{
                    const px = Math.floor((x + 0.5) * cw);
                    const py = Math.floor((y + 0.5) * ch);
                    const idx = (py * c.width + px) * 4;
                    const sum = imgData[idx] + imgData[idx+1] + imgData[idx+2];
                    if (sum < 200) dark++;
                }}
            }}
            const status = document.getElementById('pv-status')?.textContent || '';
            return {{
                status, reproScore, savedScore: ckpt.bestScore, scoreDiff: reproScore - ckpt.bestScore,
                expectedOnes, expectedDead, expectedTotal: expectedGrid.length,
                usedInv, canvasDark: dark,
            }};
        }}""")
        diff_ones = abs(result['canvasDark'] - result['expectedOnes'])
        diff_inv = abs(result['canvasDark'] - result['expectedDead'])
        if diff_ones < 50 or diff_inv < 50:
            canvas_match = '✓' if result['usedInv'] is not None else '✓ (orig)'
            if diff_inv < diff_ones:
                canvas_match += f' inv side, diff {diff_inv}'
            else:
                canvas_match += f' orig side, diff {diff_ones}'
        else:
            canvas_match = f'❌ diff_ones={diff_ones} diff_inv={diff_inv}'
        score_match = '✓' if abs(result['scoreDiff']) < 0.001 else f'❌ diff={result["scoreDiff"]:.4f}'
        print(f"  status: {result['status']!r}")
        print(f"  score: saved={result['savedScore']:.4f}  repro={result['reproScore']:.4f}  {score_match}")
        print(f"  canvas dark: {result['canvasDark']}  expected: ones={result['expectedOnes']} dead={result['expectedDead']}  {canvas_match}")
        results.append((label, NAME, result))

    browser.close()

print("\n" + "=" * 80)
print("FIG 6 V2 6-PANEL VERIFICATION (after cellMaskType + F2 init seed fix)")
print("=" * 80)
print(f"{'panel':<6}  {'NAME':<42} {'saved':>8} {'repro':>8} {'match?':>10}  canvas")
n_match = 0
for label, NAME, r in results:
    score_match = '✓' if abs(r['scoreDiff']) < 0.001 else '❌'
    diff_ones = abs(r['canvasDark'] - r['expectedOnes'])
    diff_inv = abs(r['canvasDark'] - r['expectedDead'])
    canvas_match = '✓' if min(diff_ones, diff_inv) < 50 else '❌'
    if score_match == '✓' and canvas_match == '✓':
        n_match += 1
    print(f"  ({label})   {NAME:<42} {r['savedScore']:>8.4f} {r['reproScore']:>8.4f} {score_match:>10}  {canvas_match}  ({r['status']})")
print(f"\n{n_match}/6 panels match (score + canvas)")
