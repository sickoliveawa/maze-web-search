"""
_big_sweep_500x2000.py
================================================================
Run 500pop × 2000gen for the best config from sweep_2026_07_04:
  mask = manhattan-2, maxFam = 8
  (top1 ckpt: 0.8233 @ seed=444)

5 repeat runs with different seeds (444, 1111, 2222, 3333, 5555)
to give the GA room to find a better score than the 0.8233 record.

Wall time estimate: ~67 min/run × 5 = ~5.5 hours total
  (07-04: 200pop×500gen took ~400s, 500pop×2000gen ≈ 10× → ~4000s/run)

Saves to: E:\\doro\\maze-web\\sweep_2026_07_08_big\\results.ndjson
Config: gridW=40, gridH=60, popSize=500, generations=2000
Anti-clobber: each run has unique runTag (Date.now + rand4)
================================================================
"""
from playwright.sync_api import sync_playwright
import time, json, os, sys, datetime, random

CDP = "http://127.0.0.1:9222"
URL = "http://127.0.0.1:8087/"
SWEEP_DIR = r"E:\doro\maze-web\sweep_2026_07_08_big"
NDJSON = os.path.join(SWEEP_DIR, "results.ndjson")
LOG = os.path.join(SWEEP_DIR, "sweep.log")

# Best config from sweep_2026_07_04: ma-2/mf=8
MASK = "manhattan-2"
MAX_FAM = 8
# 5 different seeds — best seed 444 first (proven 0.8233), then 4 new seeds
SEEDS = [444, 1111, 2222, 3333, 5555]

POP = 500
GENS = 2000
GRID_W = 40
GRID_H = 60
WALL_TIMEOUT_S = 5000  # 83 min per run (slightly above 67 min est)

os.makedirs(SWEEP_DIR, exist_ok=True)

def log(msg):
    ts = datetime.datetime.now().isoformat()
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")

def setup_run(page, cfg, batch_name, run_tag):
    """Set fields + runTag for anti-clobber (v2.1.0 fix)."""
    page.goto(URL + "?v=" + str(int(time.time()*1000)), wait_until="domcontentloaded")
    time.sleep(2)
    page.evaluate("() => document.querySelector('nav.tabs button[data-tab=configure]').click()")
    time.sleep(0.4)
    page.evaluate(f"""() => {{
      const setVal = (sel, v, evt) => {{
        const el = document.querySelector(sel);
        if (!el) return;
        el.value = v;
        el.dispatchEvent(new Event(evt, {{ bubbles: true }}));
      }};
      setVal('#cfg-batch-name',  '{batch_name}', 'input');
      setVal('#cfg-popSize',     '{POP}',        'input');
      setVal('#cfg-generations', '{GENS}',       'input');
      setVal('#cfg-gridW',       '{GRID_W}',     'input');
      setVal('#cfg-gridH',       '{GRID_H}',     'input');
      setVal('#cfg-cellMaskType','{cfg['mask']}', 'change');
      setVal('#cfg-maxFamilies', '{cfg['maxFam']}','change');
      setVal('#cfg-randomSeed',  '{cfg['seed']}', 'input');
    }}""")
    time.sleep(0.4)
    # Activate first maxFam family slots
    page.evaluate(f"""() => {{
      for (let i = 0; i < {cfg['maxFam']}; i++) {{
        const el = document.querySelector(`.fam-slot[data-idx='${{i}}']`);
        if (el && !el.classList.contains('active')) el.click();
      }}
    }}""")
    time.sleep(0.2)
    # Verify
    actual = page.evaluate("""() => ({
        batch: document.querySelector('#cfg-batch-name')?.value,
        pop: document.querySelector('#cfg-popSize')?.value,
        gens: document.querySelector('#cfg-generations')?.value,
        mask: document.querySelector('#cfg-cellMaskType')?.value,
        mf: document.querySelector('#cfg-maxFamilies')?.value,
        seed: document.querySelector('#cfg-randomSeed')?.value,
    })""")
    log(f"  config set: {actual}")
    # Inject runTag via JS — set on a custom field if train.js has it (v2.1.0 added this)
    # If no runTag input, just use the batch_name as differentiator
    page.evaluate(f"""() => {{
      // Try setting window-side runTag if train tab exposes it
      if (typeof window.__setRunTag === 'function') {{
        window.__setRunTag('{run_tag}');
      }}
    }}""")
    page.evaluate("() => document.querySelector('#cfg-go-train').click()")
    time.sleep(0.4)

def wait_done(page, timeout_s):
    t0 = time.time()
    last_status = ""
    last_log = ""
    while time.time() - t0 < timeout_s:
        time.sleep(2)
        try:
            state = page.evaluate("""() => {
                const s = document.getElementById('train-status-text');
                const logEl = document.getElementById('train-log');
                const lines = logEl ? Array.from(logEl.querySelectorAll('div')).map(d => d.innerText) : [];
                return {
                    status: s ? s.innerText : '',
                    lastLog: lines.slice(-1)[0] || '',
                    elapsed: document.getElementById('train-elapsed-text')?.innerText || ''
                };
            }""")
        except Exception as e:
            log(f"  poll error: {e}")
            continue
        last_status = state['status']
        last_log = state['lastLog']
        elapsed = int(time.time() - t0)
        if elapsed % 60 == 0:
            log(f"  [{elapsed}s] status={state['status']!r} log_last={last_log[:80]!r}")
        if state['status'].startswith('Done') or state['status'].startswith('Error') or state['status'].startswith('Stopped'):
            return state, "DONE"
        if '✅ run complete' in last_log:
            time.sleep(8)  # wait for ckpt save flush
            return state, "DONE"
    log(f"  ⚠️ TIMEOUT after {timeout_s}s, last_status={last_status!r}")
    return None, "TIMEOUT"

def capture(page, cfg, batch_name, run_tag, wall_sec, final_state):
    best_summary = page.evaluate("() => document.getElementById('train-best-summary')?.innerText || ''")
    log_tail = page.evaluate("""() => {
        const el = document.getElementById('train-log');
        if (!el) return '';
        const lines = Array.from(el.querySelectorAll('div')).map(d => d.innerText);
        return lines.slice(-3).join(' || ');
    }""")
    best_score = None
    for line in best_summary.split('\n'):
        if line.startswith('best='):
            try:
                best_score = float(line.split('=')[1].strip())
            except: pass
            break
    return {
        "summary": best_summary,
        "best": best_score,
        "log_tail": log_tail,
        "mask": cfg["mask"],
        "maxFam": cfg["maxFam"],
        "seed": cfg["seed"],
        "pop": POP,
        "gens": GENS,
        "gridW": GRID_W,
        "gridH": GRID_H,
        "wall_sec": wall_sec,
        "batch_name": batch_name,
        "run_tag": run_tag,
        "ts": datetime.datetime.now().isoformat(),
        "status": "OK" if best_score is not None else "FAIL",
        "final_state_status": (final_state or {}).get('status', ''),
    }

# ============== MAIN ==============
log(f"=== BIG sweep 500x2000 starting ===")
log(f"PLAN: {MASK}/mf={MAX_FAM} × {len(SEEDS)} seeds = {len(SEEDS)} runs")
log(f"POP={POP} GENS={GENS} gridW×H={GRID_W}×{GRID_H}")

# Verify ckpt_server
import urllib.request
try:
    h = json.loads(urllib.request.urlopen('http://127.0.0.1:8088/ckpt/health').read())
    log(f"ckpt_server health: {h}")
except Exception as e:
    log(f"❌ ckpt_server health FAILED: {e}")
    sys.exit(1)

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    ctx = b.contexts[0]
    log(f"connected to CDP, contexts={len(b.contexts)}")

    t_total = time.time()
    results = []
    for idx, seed in enumerate(SEEDS):
        # Anti-clobber runTag per run
        run_tag = f"run_{int(time.time()*1000)}_{random.randint(1000,9999)}"
        batch_name = f"big_{MASK}_mf{MAX_FAM}_s{seed}"
        cfg = {"mask": MASK, "maxFam": MAX_FAM, "seed": seed}
        log(f"\n=== [{idx+1}/{len(SEEDS)}] {MASK}/mf={MAX_FAM}/s={seed} runTag={run_tag} ===")

        page = ctx.new_page()
        page.on("console", lambda msg, _seed=seed: log(f"  [s{_seed}.console.{msg.type}] {msg.text[:200]}"))
        try:
            setup_run(page, cfg, batch_name, run_tag)
            page.evaluate("() => document.querySelector('#train-start').click()")
            log(f"  start clicked")
            t0 = time.time()
            state, reason = wait_done(page, WALL_TIMEOUT_S)
            wall_sec = int(time.time() - t0)
            if reason == "TIMEOUT" or state is None:
                log(f"  ❌ {reason} — recording FAIL")
                rec = {
                    "summary": "(timeout)", "best": None, "log_tail": "",
                    "mask": cfg["mask"], "maxFam": cfg["maxFam"], "seed": cfg["seed"],
                    "pop": POP, "gens": GENS, "gridW": GRID_W, "gridH": GRID_H,
                    "wall_sec": wall_sec,
                    "batch_name": batch_name, "run_tag": run_tag,
                    "ts": datetime.datetime.now().isoformat(),
                    "status": "TIMEOUT",
                }
            else:
                log(f"  done ({wall_sec}s): status={state['status']!r}")
                rec = capture(page, cfg, batch_name, run_tag, wall_sec, state)
                log(f"  ✓ best={rec.get('best')}")
            with open(NDJSON, "a") as f:
                f.write(json.dumps(rec) + "\n")
            results.append(rec)
        except Exception as e:
            log(f"  ❌ EXCEPTION: {e}")
            import traceback
            log(traceback.format_exc())
        finally:
            time.sleep(3)
            page.close()

    log(f"\n=== BIG sweep complete (total {(time.time()-t_total)/60:.1f} min) ===")
    b.close()

# Final summary
log("\n=== NDJSON SUMMARY ===")
ok = [r for r in results if r.get('status') == 'OK']
ok.sort(key=lambda r: -(r.get('best') or 0))
log(f"OK: {len(ok)}/{len(results)}")
for r in ok:
    log(f"  best={r.get('best'):.6f}  {r['mask']}/mf={r['maxFam']}/s={r['seed']}  wall={r['wall_sec']}s  runTag={r.get('run_tag')}")
log("\nDONE")
