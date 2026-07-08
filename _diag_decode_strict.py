"""
Strictest decode path comparison:
  For each ckpt, decode via BOTH paths, dump every cell dx/dy for every family,
  compare byte-by-byte.

Also test what happens when bits have 0 active family (the _ensureActive bug).
"""
from playwright.sync_api import sync_playwright
import time, json, os, shutil

URL = "http://127.0.0.1:8087/"

# 1-family + multi-family with narrow mask (manhattan-1, chebyshev-1)
NAMES = [
    'sweep_manhattan-1_mf2_s222.json',  # manhattan-1, mf=2
    'sweep_manhattan-2_mf1_s111.json',  # manhattan-2, mf=1
    'sweep_manhattan-2_mf8_s444.json',  # manhattan-2, mf=8
    'sweep_chebyshev-1_mf8_s333.json',  # chebyshev-1, mf=8
    'sweep_manhattan-3_mf4_s333.json',  # manhattan-3, mf=4
    'sweep_chebyshev-2_mf2_s333.json',  # chebyshev-2, mf=2
]

fresh_profile = "C:/Users/sicko/AppData/Local/Temp/decode_strict_2026_07_08"
if os.path.exists(fresh_profile):
    shutil.rmtree(fresh_profile, ignore_errors=True)
os.makedirs(fresh_profile, exist_ok=True)

def cells_to_set(cells):
    return set((c['dx'], c['dy']) for c in cells)

def sort_families(families):
    """Sort families by priority (stable), then by original index for ties."""
    return sorted(enumerate(families), key=lambda x: x[1].get('priority', 0))

with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(
        user_data_dir=fresh_profile,
        headless=False,
        args=["--no-sandbox"],
    )
    page = browser.pages[0] if browser.pages else browser.new_page()
    page.on("console", lambda msg: None)
    page.goto(URL + "?v=" + str(int(time.time()*1000)), wait_until="domcontentloaded")
    time.sleep(3)

    for name in NAMES:
        print(f"\n========== {name} ==========")
        with open(f'ckpt/{name}') as f:
            t = json.load(f)
        mask = t['config']['cellMaskType']
        bits = t['bestChromBits']

        result = page.evaluate(f"""async () => {{
            const ckptMod = await import('/src/ckpt.js');
            const rcMod = await import('/src/search/rule_chromosome.js');
            const chromMod = await import('/src/search/chromosome.js');
            const gsMod = await import('/src/gpu/gpu_scorer.js');

            const ckpt = await ckptMod.loadCheckpoint('{name}');
            const bitsArr = new Uint8Array(ckpt.bestChromBits);
            const mask = '{mask}';

            // === Path A: RuleChromosome.decode (with cellMaskType filter, NEW path) ===
            const ba = new chromMod.BitArray(bitsArr.length);
            for (let i = 0; i < bitsArr.length; i++) ba.set(i, bitsArr[i]);
            const ruleA = (new rcMod.RuleChromosome(ba)).decode(mask);   // ✅ pass mask
            const famsA = ruleA.families.map(f => ({{
                priority: f.priority,
                cells: f.cells.map(c => `(${{c.dx}},${{c.dy}})`).join(';'),
                birth: f.birth.join(','),
                survive: f.survive.join(','),
            }}));

            // === Path B: gpu_scorer.decodeChromosome (re-impl with cellInRange) ===
            const cellInRange = (dx, dy, type) => {{
                // 'chebyshev' or 'manhattan' or 'unknown'
                if (type === 'chebyshev-1') return Math.max(Math.abs(dx), Math.abs(dy)) <= 1;
                if (type === 'chebyshev-2') return Math.max(Math.abs(dx), Math.abs(dy)) <= 2;
                if (type === 'chebyshev-3') return Math.max(Math.abs(dx), Math.abs(dy)) <= 3;
                if (type === 'chebyshev-4') return Math.max(Math.abs(dx), Math.abs(dy)) <= 4;
                if (type === 'manhattan-1') return Math.abs(dx) + Math.abs(dy) <= 1;
                if (type === 'manhattan-2') return Math.abs(dx) + Math.abs(dy) <= 2;
                if (type === 'manhattan-3') return Math.abs(dx) + Math.abs(dy) <= 3;
                if (type === 'manhattan-4') return Math.abs(dx) + Math.abs(dy) <= 4;
                return true;
            }};
            const familiesB = [];
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
                        if (bitsArr[slot + 1 + bitIdx] === 1 && cellInRange(dx, dy, mask)) {{
                            cells.push({{dx, dy}});
                        }}
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
                familiesB.push({{ priority, cells, birth, survive }});
            }}
            if (familiesB.length === 0) {{
                familiesB.push({{
                    id: 'fam_0', name: 'family_0', priority: 1,
                    cells: [
                        {{dx:-1,dy:-1}},{{dx:0,dy:-1}},{{dx:1,dy:-1}},
                        {{dx:-1,dy:0}},                 {{dx:1,dy:0}},
                        {{dx:-1,dy:1}}, {{dx:0,dy:1}}, {{dx:1,dy:1}}
                    ],
                    birth: [3], survive: [2, 3],
                }});
            }}
            const famsB = familiesB.map(f => ({{
                priority: f.priority,
                cells: f.cells.map(c => `(${{c.dx}},${{c.dy}})`).join(';'),
                birth: f.birth.join(','),
                survive: f.survive.join(','),
            }}));

            // Now sort both by priority, then compare
            const sortedA = famsA.map((f, i) => ({{...f, _origIdx: i}})).sort((a, b) => a.priority - b.priority);
            const sortedB = famsB.map((f, i) => ({{...f, _origIdx: i}})).sort((a, b) => a.priority - b.priority);
            // For stable comparison, also try with birth/survive order swapped (because order of B/S depends on push order which can be in either order)
            // Compare family-by-family
            let allMatch = true;
            const diffs = [];
            if (sortedA.length !== sortedB.length) {{
                allMatch = false;
                diffs.push(`count: A=${{sortedA.length}} B=${{sortedB.length}}`);
            }} else {{
                for (let i = 0; i < sortedA.length; i++) {{
                    const fa = sortedA[i], fb = sortedB[i];
                    if (fa.priority !== fb.priority) {{
                        allMatch = false; diffs.push(`priority[${{i}}]: A=${{fa.priority}} B=${{fb.priority}}`);
                    }}
                    if (fa.cells !== fb.cells) {{
                        allMatch = false;
                        // Find which cells differ
                        const ca = new Set(fa.cells.split(';').filter(Boolean));
                        const cb = new Set(fb.cells.split(';').filter(Boolean));
                        const inANotB = [...ca].filter(c => !cb.has(c));
                        const inBNotA = [...cb].filter(c => !ca.has(c));
                        diffs.push(`cells[${{i}}]: in A not B=${{JSON.stringify(inANotB)}}, in B not A=${{JSON.stringify(inBNotA)}}`);
                    }}
                    if (fa.birth !== fb.birth) {{
                        allMatch = false; diffs.push(`birth[${{i}}]: A=${{fa.birth}} B=${{fb.birth}}`);
                    }}
                    if (fa.survive !== fb.survive) {{
                        allMatch = false; diffs.push(`survive[${{i}}]: A=${{fa.survive}} B=${{fb.survive}}`);
                    }}
                }}
            }}
            return {{
                mask, n_a: sortedA.length, n_b: sortedB.length,
                all_match: allMatch, diffs: diffs,
                path_A: sortedA, path_B: sortedB,
            }};
        }}""")
        print(f"  mask: {result['mask']}")
        print(f"  Path A (RuleChromosome.decode, NO filter):  n_families={result['n_a']}")
        print(f"  Path B (gpu_scorer.decodeChromosome, +filter): n_families={result['n_b']}")
        if result['all_match']:
            print(f"  ✓ ALL match (priority + cells + birth + survive, after sort by priority)")
        else:
            print(f"  ❌ MISMATCH:")
            for d in result['diffs'][:8]:
                print(f"    {d}")
        # Show details
        for i, (fa, fb) in enumerate(zip(result['path_A'], result['path_B'])):
            print(f"  fam[{i}]: A pri={fa['priority']} cells={fa['cells'][:80]}{'...' if len(fa['cells'])>80 else ''} b={fa['birth']} s={fa['survive']}")
            print(f"           B pri={fb['priority']} cells={fb['cells'][:80]}{'...' if len(fb['cells'])>80 else ''} b={fb['birth']} s={fb['survive']}")

    browser.close()
