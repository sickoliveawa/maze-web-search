"""
CDP diagnose: load sweep_manhattan-2_mf1_s111 into Preview tab in sko's Edge,
capture what canvas actually shows vs what GPU eval would produce from same bits.

If canvas grid != GPU eval grid → preview.js rendering bug
If canvas grid == GPU eval grid → visual/cognitive mismatch (user error or color scheme)
"""
from playwright.sync_api import sync_playwright
import time, json, base64

CDP = "http://127.0.0.1:9222"
URL = "http://127.0.0.1:8087/"
NAME = 'sweep_manhattan-2_mf1_s111.json'

with open(f'ckpt/{NAME}') as f:
    t = json.load(f)
W = t['config']['gridW']
H = t['config']['gridH']

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0]
    page = ctx.new_page()
    page.on("console", lambda msg: print(f"  [browser.{msg.type}] {msg.text[:160]}"))
    page.goto(URL + "?v=" + str(int(time.time()*1000)), wait_until="domcontentloaded")
    time.sleep(3)

    # Click Preview tab
    page.evaluate("() => document.querySelector('nav.tabs button[data-tab=preview]')?.click()")
    time.sleep(0.5)

    # Click "Refresh" to populate the ckpt list
    page.evaluate("() => document.querySelector('#pv-ckpt-refresh')?.click()")
    time.sleep(1.5)

    # Find the ckpt card for our NAME, click it
    print(f"=== Clicking ckpt card for {NAME} ===")
    page.evaluate(f"""() => {{
      const cards = document.querySelectorAll('.ckpt-card');
      for (const c of cards) {{
        if (c.dataset.name === '{NAME}') {{ c.click(); return; }}
      }}
      console.warn('card not found');
    }}""")
    time.sleep(2)

    # Capture status
    status_before = page.evaluate("() => document.getElementById('pv-status')?.textContent || ''")
    print(f"  status before init: {status_before!r}")

    # Click Init button to render with current init seed
    print("=== Click Init ===")
    page.evaluate("() => document.querySelector('#pv-init')?.click()")
    time.sleep(2)

    status_after = page.evaluate("() => document.getElementById('pv-status')?.textContent || ''")
    print(f"  status after init: {status_after!r}")

    # Now step 5 times to evolve
    print("=== Step ×5 (click #pv-step-once 5 times) ===")
    for i in range(5):
        page.evaluate("() => document.querySelector('#pv-step-once')?.click()")
        time.sleep(0.5)

    time.sleep(1)
    status_step = page.evaluate("() => document.getElementById('pv-status')?.textContent || ''")
    print(f"  status after 5 steps: {status_step!r}")

    # Capture canvas pixel data
    print("=== Capture canvas ===")
    canvas_data = page.evaluate(f"""() => {{
      const c = document.querySelector('#pv-canvas');
      if (!c) return null;
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      // Sample 9 cells (3x3) to determine polarity
      const samples = [];
      for (let row = 0; row < 3; row++) {{
        for (let col = 0; col < 3; col++) {{
          const x = Math.floor((col + 0.5) * c.width / 3);
          const y = Math.floor((row + 0.5) * c.height / 3);
          const idx = (y * c.width + x) * 4;
          samples.push([d[idx], d[idx+1], d[idx+2]]);
        }}
      }}
      return {{
        width: c.width, height: c.height,
        samples: samples,
        cell_size: c.width / {W},  // implied cell size
      }};
    }}""")
    print(f"  canvas: {canvas_data}")

    # Take canvas as PNG to share with sko
    png_b64 = page.evaluate("() => document.querySelector('#pv-canvas')?.toDataURL('image/png')")
    if png_b64:
        png_data = base64.b64decode(png_b64.split(',', 1)[1])
        png_path = f'E:/doro/maze-web/_diag_preview_{NAME.replace(".json", "")}.png'
        with open(png_path, 'wb') as f:
            f.write(png_data)
        print(f"  saved canvas PNG: {png_path} ({len(png_data)} bytes)")

    # Now query preview's internal state: what grid does it think it's showing?
    print("=== Inspect preview internal state ===")
    preview_state = page.evaluate("""async () => {
        // Try to access preview module's internal state
        const previewMod = await import('/src/tabs/preview.js');
        // preview.js exports render functions; let's get the actual grid
        // Look for global hooks first
        const win = window;
        return {
            has_preview_module: !!previewMod,
            preview_keys: Object.keys(previewMod),
            global_grid: typeof win._bestGrid !== 'undefined' ? Array.from(win._bestGrid).slice(0, 50) : null,
            global_rule: typeof win._rule !== 'undefined' ? {W: win._rule._W, H: win._rule._H} : null,
        };
    }""")
    print(f"  preview state: {preview_state}")

    # Finally: load same ckpt via ckpt.js, run GPU eval, get the expected grid
    print("=== Compare against expected GPU eval grid ===")
    expected = page.evaluate(f"""async () => {{
        const ckptMod = await import('/src/ckpt.js');
        const chromMod = await import('/src/search/chromosome.js');
        const scorerMod = await import('/src/gpu/gpu_scorer.js');
        const ckpt = await ckptMod.loadCheckpoint('{NAME}');
        const bits = new Uint8Array(ckpt.bestChromBits);
        const cfg = {{
            gridW: ckpt.config.gridW, gridH: ckpt.config.gridH, caSteps: ckpt.config.caSteps,
            initFullScreen: ckpt.config.initFullScreen, initPatchSize: ckpt.config.initPatchSize ?? 60,
            initDensity: ckpt.config.initDensity ?? 0.15, cellMaskType: ckpt.config.cellMaskType,
            maxFamilies: ckpt.config.maxFamilies ?? 1, activeFamilySlots: ckpt.config.activeFamilySlots ?? [0],
            useLayeredMutation: false, withInvert: true, metric: 'mazeQuality',
        }};
        const scorer = new scorerMod.BatchedGPUScorer(cfg);
        const chrom = new chromMod.BitArray(bits.length);
        chrom.fromBits(bits);
        const res = await scorer.evaluateBatchBatched([chrom], {{
            seeds: 1, gridWidth: cfg.gridW, gridHeight: cfg.gridH, steps: cfg.caSteps,
            patchSize: cfg.initPatchSize, cellMaskType: cfg.cellMaskType,
            randomSeed: ckpt.config.randomSeed, metric: 'mazeQuality',
            initFullScreen: true, initDensity: 0.15,
        }});
        const grid = res[0]?.bestGrid;
        const initGrid = res[0]?.bestInitGrid;
        return {{
            score: res[0]?.bestScore ?? res[0]?.score,
            grid: Array.from(grid).slice(0, 200),
            grid_ones: Array.from(grid).reduce((a,b)=>a+b>0?a+1:a, 0),
            initGrid: Array.from(initGrid).slice(0, 200),
            init_ones: Array.from(initGrid).reduce((a,b)=>a+b>0?a+1:a, 0),
            usedInverted: res[0]?.usedInverted,
        }};
    }}""")
    print(f"  expected grid score: {expected['score']}")
    print(f"  expected init_ones: {expected['init_ones']}, grid_ones: {expected['grid_ones']}")
    print(f"  expected usedInverted: {expected['usedInverted']}")
    print(f"  expected grid first 200: {expected['grid']}")
    print(f"  expected init first 200: {expected['initGrid']}")

    page.close()
    b.close()
