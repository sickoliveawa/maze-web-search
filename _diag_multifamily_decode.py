"""
Diagnose multi-family preview bug:
  - Compare preview.js decode path (RuleChromosome.decode, no mask filter)
    vs train.js decode path (gpu_scorer.js::decodeChromosome, with cellInRange filter)
  - Test on: 1-family (mf=1) AND multi-family (mf=2,4,8) ckpts
  - Hypothesis: multi-family preview is wrong because RuleChromosome.decode doesn't filter cells by cellMaskType
"""
from playwright.sync_api import sync_playwright
import time, json

CDP = "http://127.0.0.1:9222"
URL = "http://127.0.0.1:8087/"

# 1-family vs multi-family test cases
TEST_CKPTS = [
    ('sweep_manhattan-2_mf1_s111.json', 1),   # mf=1, single family
    ('sweep_manhattan-2_mf1_s444.json', 1),   # mf=1
    ('sweep_manhattan-2_mf8_s444.json', 8),   # mf=8, multi family
    ('sweep_manhattan-3_mf4_s333.json', 4),   # mf=4
    ('sweep_chebyshev-1_mf8_s333.json', 8),   # mf=8 chebyshev-1 (panel b paper)
    ('sweep_chebyshev-2_mf2_s333.json', 2),   # mf=2
    ('sweep_manhattan-1_mf2_s222.json', 2),   # mf=2 ma-1
]

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0]
    page = ctx.new_page()
    page.on("console", lambda msg: print(f"  [browser.{msg.type}] {msg.text[:160]}"))
    page.goto(URL + "?v=" + str(int(time.time()*1000)), wait_until="domcontentloaded")
    time.sleep(3)

    print("=" * 80)
    print(f"{'NAME':<38} {'mf':>3} {'mask':<13} {'famA':>5} {'famB':>5} {'cellsA':>7} {'cellsB':>7} {'match':>8}")
    print("=" * 80)

    for name, expected_mf in TEST_CKPTS:
        try:
            result = page.evaluate(f"""async () => {{
                const ckptMod = await import('/src/ckpt.js');
                const rcMod = await import('/src/search/rule_chromosome.js');
                const chromMod = await import('/src/search/chromosome.js');
                const gsMod = await import('/src/gpu/gpu_scorer.js');

                const ckpt = await ckptMod.loadCheckpoint('{name}');
                const bitsArr = new Uint8Array(ckpt.bestChromBits);
                const ba = new chromMod.BitArray(bitsArr.length);
                for (let i = 0; i < bitsArr.length; i++) ba.set(i, bitsArr[i]);
                const maskType = ckpt.config.cellMaskType;

                // Path A: preview.js uses this (RuleChromosome.decode, NO mask filter)
                const ruleA = (new rcMod.RuleChromosome(ba)).decode();

                // Path B: train.js / live preview uses this (decodeChromosome WITH cellInRange filter)
                const ruleB = gsMod.__test_decodeChromosome ?
                    gsMod.__test_decodeChromosome({{ bits: bitsArr }}, maskType) : null;
                // gpu_scorer.js may not export — fall back: try direct call
                if (!ruleB) {{
                    // Try the global import
                    const families = [];
                    const MAX_DX = 4, MAX_DY = 4, MAX_CELLS = 80, MAX_BIRTH = 9, MAX_SURVIVE = 9, PRIORITY_BITS = 4;
                    const SLOT_BITS = 1 + MAX_CELLS + MAX_BIRTH + MAX_SURVIVE + PRIORITY_BITS;
                    for (let i = 0; i < 16; i++) {{
                        const slot = i * SLOT_BITS;
                        if (bitsArr[slot] === 0) continue;
                        const cells = [];
                        let bitIdx = 0;
                        for (let dy = -MAX_DY; dy <= MAX_DY; dy++) {{
                            for (let dx = -MAX_DX; dx <= MAX_DX; dx++) {{
                                if (dx === 0 && dy === 0) continue;
                                if (bitsArr[slot + 1 + bitIdx] === 1) cells.push({{dx, dy}});
                                bitIdx++;
                            }}
                        }}
                        const birth = [];
                        for (let n = 0; n < MAX_BIRTH; n++) if (bitsArr[slot + 1 + MAX_CELLS + n] === 1) birth.push(n);
                        const survive = [];
                        for (let n = 0; n < MAX_SURVIVE; n++) if (bitsArr[slot + 1 + MAX_CELLS + MAX_BIRTH + n] === 1) survive.push(n);
                        let priority = 0;
                        for (let p = 0; p < PRIORITY_BITS; p++) priority |= (bitsArr[slot + 1 + MAX_CELLS + MAX_BIRTH + MAX_SURVIVE + p] << p);
                        priority = Math.max(1, Math.min(16, priority || 1));
                        families.push({{ priority, cells, birth, survive }});
                    }}
                    return {{
                        name: '{name}',
                        mask: maskType,
                        famA: ruleA.families.length,
                        famB: families.length,
                        cellsA: ruleA.families.map(f => f.cells.length).join(','),
                        cellsB: families.map(f => f.cells.length).join(','),
                        detailA: ruleA.families.map(f => ({{
                            n_cells: f.cells.length,
                            out_of_range_cells: f.cells.filter(c => Math.abs(c.dx) + Math.abs(c.dy) > 2).length
                        }})),
                        cells_A_first: ruleA.families[0]?.cells.slice(0, 8),
                        cells_B_first: families[0]?.cells.slice(0, 8),
                    }};
                }}
                return {{ name: '{name}', mask: maskType, famA: ruleA.families.length, famB: ruleB.families.length }};
            }}""")
            print(f"{name:<38} {expected_mf:>3} {result['mask']:<13} {result['famA']:>5} {result['famB']:>5} "
                  f"{result['cellsA']:>7} {result['cellsB']:>7} "
                  f"{'OK' if result['cellsA'] == result['cellsB'] else '❌ MISMATCH':>8}")
            if result['cellsA'] != result['cellsB']:
                # Show detail
                if 'detailA' in result:
                    print(f"  detailA (RuleChromosome.decode, NO filter): {result['detailA']}")
                if 'cells_A_first' in result:
                    print(f"  cells_A_first (with out-of-range): {result['cells_A_first']}")
                if 'cells_B_first' in result:
                    print(f"  cells_B_first (no filter, train.js path): {result['cells_B_first']}")
        except Exception as e:
            print(f"{name:<38} ERROR: {e}")

    page.close()
    b.close()
