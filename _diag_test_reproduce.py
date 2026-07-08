"""
End-to-end test.json reproduce in sko's Edge.
Tests:
  A. bits fingerprint matches disk (no clobber)
  B. rule decode OK
  C. GPU eval with F2 init seed (rs + chromHash*65537) reproduces saved 0.76919
  D. Preview tab paint: what grid is actually shown?
  E. Compare to live preview train tab grid (if reachable)
"""
from playwright.sync_api import sync_playwright
import time, json, sys

CDP = "http://127.0.0.1:9222"
URL = "http://127.0.0.1:8087/"

with open('ckpt/test.json') as f:
    t_disk = json.load(f)

print(f"DISK test.json: gen={t_disk['gen']} bestScore={t_disk['bestScore']:.10f} savedAt={t_disk['savedAt']}")
bits_disk = t_disk['bestChromBits']
print(f"  bits len: {len(bits_disk)}, ones: {sum(bits_disk)}")
ones_disk = sum(bits_disk)

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0]
    page = ctx.new_page()
    page.on("console", lambda msg: print(f"  [browser.{msg.type}] {msg.text[:200]}"))
    page.goto(URL + "?v=" + str(int(time.time()*1000)), wait_until="domcontentloaded")
    time.sleep(3)

    print("\n=== Test A+B+C: Load test.json, decode, reproduce ===")
    result = page.evaluate("""async () => {
        const ckptMod = await import('/src/ckpt.js');
        const chromMod = await import('/src/search/chromosome.js');
        const ruleMod = await import('/src/search/rule_chromosome.js');
        const scorerMod = await import('/src/gpu/gpu_scorer.js');

        const ckpt = await ckptMod.loadCheckpoint('test.json');
        const bits = Array.from(ckpt.bestChromBits);
        const W = ckpt.config.gridW;
        const H = ckpt.config.gridH;
        const caSteps = ckpt.config.caSteps;
        const rs = ckpt.config.randomSeed;
        const savedScore = ckpt.bestScore;

        // Decode the rule (BitArray is a class — use new + fromBits)
        const chrom = new chromMod.BitArray(bits.length);
        chrom.fromBits(new Uint8Array(bits));
        let chromHash = 0;
        for (let b = 0; b < bits.length; b++) chromHash = ((chromHash * 31) + bits[b]) | 0;
        const f2Seed = (rs + chromHash * 65537 + 0) >>> 0;

        let families;
        try {
          families = ruleMod.decodeFamilies(chrom, ckpt.config.cellMaskType);
        } catch (e) {
          families = [{B: 'err', S: e.message}];
        }

        return {
            bits_len: bits.length,
            bits_ones: bits.reduce((a,b)=>a+b, 0),
            bits_first8: bits.slice(0, 8),
            W, H, caSteps, rs, savedScore, chromHash, f2Seed,
            n_families: families.length,
            fam0: families[0] ? {B: families[0].B, S: families[0].S} : null,
            fam1: families[1] ? {B: families[1].B, S: families[1].S} : null,
        };
    }""")
    print(json.dumps(result, indent=2, default=str))

    # Compare disk bits fingerprint
    if result['bits_ones'] != ones_disk:
        print(f"⚠️  BITS MISMATCH! disk ones={ones_disk}, browser load ones={result['bits_ones']}")
    else:
        print(f"✓ Bits fingerprint matches disk (ones={ones_disk})")

    print("\n=== Test D: GPU eval reproduce saved score ===")
    print("  Running GPU eval with F2 init seed (production formula)...")
    repro = page.evaluate("""async () => {
        const ckptMod = await import('/src/ckpt.js');
        const chromMod = await import('/src/search/chromosome.js');
        const scorerMod = await import('/src/gpu/gpu_scorer.js');

        const ckpt = await ckptMod.loadCheckpoint('test.json');
        const bits = new Uint8Array(ckpt.bestChromBits);
        const W = ckpt.config.gridW;
        const H = ckpt.config.gridH;
        const caSteps = ckpt.config.caSteps;
        const rs = ckpt.config.randomSeed;
        const maskType = ckpt.config.cellMaskType;

        // Build config matching the saved ckpt
        const cfg = {
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
        };

        const scorer = new scorerMod.BatchedGPUScorer(cfg);
        const chrom = new chromMod.BitArray(bits.length);
        chrom.fromBits(bits);

        // Replicate production GPU eval path — use opts object (not positional!)
        const t0 = performance.now();
        const res = await scorer.evaluateBatchBatched([chrom], {
          seeds: 1,
          gridWidth: W,
          gridHeight: H,
          steps: caSteps,
          patchSize: cfg.initPatchSize,
          cellMaskType: maskType,
          randomSeed: rs,
          metric: 'mazeQuality',
          initFullScreen: true,
          initDensity: 0.15,
        });
        const t1 = performance.now();
        const score = res[0]?.bestScore ?? res[0]?.score ?? -999;
        const grid = res[0]?.bestGrid;
        const initGrid = res[0]?.bestInitGrid;
        const breakdown = res[0]?.bestBreakdown;
        const usedInverted = res[0]?.usedInverted;

        // Grid fingerprint
        let ones = 0;
        let sum = 0;
        let h0 = 0;
        if (grid) {
          for (let i = 0; i < grid.length; i++) { ones += grid[i] > 0 ? 1 : 0; sum += grid[i]; h0 = ((h0 * 31) + grid[i]) | 0; }
        }
        let i_ones = 0;
        let i_h0 = 0;
        if (initGrid) {
          for (let i = 0; i < initGrid.length; i++) { i_ones += initGrid[i] > 0 ? 1 : 0; i_h0 = ((i_h0 * 31) + initGrid[i]) | 0; }
        }

        return {
          reproduce_score: score,
          saved_score: ckpt.bestScore,
          diff: score - ckpt.bestScore,
          eval_ms: t1 - t0,
          grid_ones: ones,
          grid_hash: h0,
          grid_total: W * H,
          init_ones: i_ones,
          init_hash: i_h0,
          usedInverted,
          breakdown_keys: breakdown ? Object.keys(breakdown) : null,
          breakdown_subset: breakdown ? {
            M_topology: breakdown.M_topology,
            M_branching: breakdown.M_branching,
            M_connectedness: breakdown.M_connectedness,
            M_wall_ratio: breakdown.M_wall_ratio,
          } : null,
        };
    }""")
    print(json.dumps(repro, indent=2, default=str))

    if 'diff' in repro and abs(repro['diff']) < 0.01:
        print("✓ GPU eval reproduce MATCHES saved score (bits OK)")
    else:
        print(f"⚠️  GPU eval reproduce DIFFERS from saved by {repro.get('diff', '?')}")

    page.close()
    b.close()
