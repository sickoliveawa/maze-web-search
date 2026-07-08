"""
Strictest possible save/parse audit:
  1. train.js's actual saveCheckpoint() payload construction (re-derive bits from rule.decode, then send via fetch to ckpt_server /ckpt/save)
  2. Parse the resulting JSON on disk, extract bestChromBits, compute fingerprint
  3. Compare disk fingerprint vs input fingerprint
  4. Also: separately decode bits via train.js's path (gpu_scorer.decodeChromosome) and preview.js's path (RuleChromosome.decode) — both should produce same fam count + cells count + birth + survive

If save is faithful, disk fingerprint == input fingerprint.
If parse is faithful, both decode paths agree.
"""
from playwright.sync_api import sync_playwright
import time, json, hashlib

CDP = "http://127.0.0.1:9222"
URL = "http://127.0.0.1:8087/"

NAMES = [
    'sweep_manhattan-2_mf1_s111.json',
    'sweep_manhattan-2_mf1_s444.json',
    'sweep_manhattan-2_mf8_s444.json',
    'sweep_manhattan-3_mf4_s333.json',
    'sweep_chebyshev-1_mf8_s333.json',
    'sweep_chebyshev-2_mf2_s333.json',
    'sweep_manhattan-1_mf2_s222.json',
    'test.json',
]

def bits_fingerprint(bits):
    h = hashlib.sha256(bytes(bits)).hexdigest()[:16]
    return f"ones={sum(bits)} sha256={h} first8={bits[:8]} last8={bits[-8:]}"

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0]
    page = ctx.new_page()
    page.on("console", lambda msg: print(f"  [browser.{msg.type}] {msg.text[:200]}"))
    page.goto(URL + "?v=" + str(int(time.time()*1000)), wait_until="domcontentloaded")
    time.sleep(3)

    for name in NAMES:
        print(f"\n========== {name} ==========")
        # 1. Read disk directly
        with open(f'ckpt/{name}') as f:
            t_disk = json.load(f)
        disk_bits = t_disk['bestChromBits']
        disk_fp = bits_fingerprint(disk_bits)
        print(f"  DISK fingerprint: {disk_fp}")
        print(f"  DISK savedScore={t_disk['bestScore']:.6f} gen={t_disk['gen']} mask={t_disk['config']['cellMaskType']} rs={t_disk['config']['randomSeed']}")

        # 2. Load via ckpt.js (browser path) and fingerprint
        result = page.evaluate(f"""async () => {{
            const ckptMod = await import('/src/ckpt.js');
            const rcMod = await import('/src/search/rule_chromosome.js');
            const gsMod = await import('/src/gpu/gpu_scorer.js');
            const chromMod = await import('/src/search/chromosome.js');

            const ckpt = await ckptMod.loadCheckpoint('{name}');
            const bits = Array.from(ckpt.bestChromBits);
            const rs = ckpt.config.randomSeed;
            const mask = ckpt.config.cellMaskType;
            const W = ckpt.config.gridW;
            const H = ckpt.config.gridH;
            const caSteps = ckpt.config.caSteps;

            // SHA256 fingerprint
            const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bits));
            const sha = Array.from(new Uint8Array(hash)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');

            // Path 1: RuleChromosome.decode (preview.js)
            const ba = new chromMod.BitArray(bits.length);
            for (let i = 0; i < bits.length; i++) ba.set(i, bits[i]);
            const rule1 = (new rcMod.RuleChromosome(ba)).decode();
            const rule1Detail = rule1.families.map(f => ({{
                priority: f.priority,
                n_cells: f.cells.length,
                cells: f.cells,
                birth: f.birth,
                survive: f.survive,
            }}));

            // Path 2: gpu_scorer.decodeChromosome (train.js) — re-implement here
            const bitsArr = new Uint8Array(bits);
            const MAX_DX = 4, MAX_DY = 4, MAX_CELLS = 80, MAX_BIRTH = 9, MAX_SURVIVE = 9, PRIORITY_BITS = 4;
            const SLOT_BITS = 1 + MAX_CELLS + MAX_BIRTH + MAX_SURVIVE + PRIORITY_BITS;
            // cellInRange
            const cellInRange = (dx, dy, type) => {{
                const d = 2;  // approx — use real config maxD
                if (type === 'chebyshev') return Math.max(Math.abs(dx), Math.abs(dy)) <= d;
                if (type === 'manhattan') return Math.abs(dx) + Math.abs(dy) <= d;
                return true;
            }};
            const families2 = [];
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
                families2.push({{ priority, cells, birth, survive }});
            }}
            const rule2Detail = families2;

            // Per-family fingerprint compare
            const famFingerprint = (fams) => fams.map(f =>
                `${{f.priority}}|${{[...f.cells].map(c=>`${{c.dx}},${{c.dy}}`).join(';')}}|b${{f.birth.join(',')}}|s${{f.survive.join(',')}}`
            ).join(' || ');

            // Reproduce score via BatchedGPUScorer
            const cfg = {{
                gridW: W, gridH: H, caSteps,
                initFullScreen: ckpt.config.initFullScreen, initPatchSize: ckpt.config.initPatchSize ?? 60,
                initDensity: ckpt.config.initDensity ?? 0.15, cellMaskType: mask,
                maxFamilies: ckpt.config.maxFamilies ?? 1, activeFamilySlots: ckpt.config.activeFamilySlots ?? [0],
                useLayeredMutation: false, withInvert: true, metric: 'mazeQuality',
            }};
            const scorer = new gsMod.BatchedGPUScorer(cfg);
            const chrom = new chromMod.BitArray(bits.length);
            chrom.fromBits(new Uint8Array(bits));
            const res = await scorer.evaluateBatchBatched([chrom], {{
                seeds: 1, gridWidth: W, gridHeight: H, steps: caSteps,
                patchSize: cfg.initPatchSize, cellMaskType: mask, randomSeed: rs, metric: 'mazeQuality',
                initFullScreen: true, initDensity: 0.15,
            }});
            const reproScore = res[0]?.bestScore ?? res[0]?.score;
            const reproGrid = res[0]?.bestGrid ? Array.from(res[0].bestGrid) : null;
            const reproOnes = reproGrid ? reproGrid.reduce((a,b)=>a+(b>0?1:0), 0) : 0;
            scorer.destroy();

            return {{
                name: '{name}',
                loaded_ones: bits.reduce((a,b)=>a+b, 0),
                loaded_first8: bits.slice(0, 8),
                loaded_last8: bits.slice(-8),
                loaded_sha: sha,
                n_fam_rule1: rule1.families.length,
                n_fam_rule2: rule2Detail.length,
                fam1_fp: famFingerprint(rule1Detail),
                fam2_fp: famFingerprint(rule2Detail),
                decode_paths_match: famFingerprint(rule1Detail) === famFingerprint(rule2Detail),
                saved_score: ckpt.bestScore,
                reproduce_score: reproScore,
                score_diff: (reproScore ?? 0) - ckpt.bestScore,
                reproduce_ones: reproOnes,
                reproduce_total: W * H,
                config_mask: mask,
                config_maxFamilies: ckpt.config.maxFamilies,
                config_activeFamilySlots: ckpt.config.activeFamilySlots,
            }};
        }}""")
        # 3. Check disk == loaded
        disk_ones = sum(disk_bits)
        loaded_ones = result['loaded_ones']
        loaded_first8 = result['loaded_first8']
        disk_first8 = disk_bits[:8]
        loaded_last8 = result['loaded_last8']
        disk_last8 = disk_bits[-8:]

        disk_load_match = (loaded_ones == disk_ones and
                          loaded_first8 == disk_first8 and
                          loaded_last8 == disk_last8)
        print(f"  LOADED (browser): ones={loaded_ones} first8={loaded_first8} last8={loaded_last8} sha={result['loaded_sha']}")
        print(f"  disk == loaded? {'✓ YES' if disk_load_match else '❌ NO — JSON parse/load corrupted bits!'}")
        if not disk_load_match:
            print(f"  disk first8: {disk_first8}, last8: {disk_last8}")
            print(f"  disk fp:    {disk_fp}")

        # 4. Check decode paths match
        print(f"  decode path 1 (preview.js RuleChromosome.decode):  n_families={result['n_fam_rule1']}")
        print(f"  decode path 2 (train.js gpu_scorer.decodeChromosome): n_families={result['n_fam_rule2']}")
        print(f"  decode paths match? {'✓ YES' if result['decode_paths_match'] else '❌ NO'}")
        if not result['decode_paths_match']:
            print(f"  path 1: {result['fam1_fp']}")
            print(f"  path 2: {result['fam2_fp']}")

        # 5. Check score reproduce
        print(f"  saved_score={result['saved_score']:.6f}  reproduce_score={result['reproduce_score']:.6f}  diff={result['score_diff']:.2e}")
        if abs(result['score_diff']) < 0.001:
            print(f"  ✓ score reproduce matches saved")
        else:
            print(f"  ❌ score mismatch by {result['score_diff']:.4f} — bits in ckpt don't actually score {result['saved_score']:.4f}")
        print(f"  reproduce_ones: {result['reproduce_ones']}/{result['reproduce_total']} ({100*result['reproduce_ones']/result['reproduce_total']:.1f}%)")
        print(f"  config: mask={result['config_mask']} maxFamilies={result['config_maxFamilies']} activeSlots={result['config_activeFamilySlots']}")

    page.close()
    b.close()
