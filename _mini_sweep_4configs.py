"""
mini_sweep_4configs.py — 4-config mini-sweep for sko to inspect.

Goals:
- 4 fresh ckpts named `sweep_<mask>_mf<N>_s<M>` (matches 07-04 schema)
- Each config: pop=100, gens=100 (~30-60s each, ~3-4 min total)
- NEW sweep dir sweep_2026_07_08 (don't touch old sweep data)
- ckpt auto-saved by train.js autosave (gen % 50 === 0)
- CDP borrow sko's Edge on port 9222
- Python 3.13 (3.14 venv lacks greenlet._greenlet)

Why this matters: sko says preview loading old sweep ckpts is "完全不对".
This script runs 4 configs with clean state + correct naming, so sko can
preview-tab-load and inspect whether the issue is in the sweep dispatcher
or something else.
"""
from playwright.sync_api import sync_playwright
import time, json, os, datetime, sys

CDP = "http://127.0.0.1:9222"
URL = "http://127.0.0.1:8087/"
SWEEP_DIR = r"E:\doro\maze-web\sweep_2026_07_08"
NDJSON = os.path.join(SWEEP_DIR, "results.ndjson")
LOG = os.path.join(SWEEP_DIR, "sweep.log")

os.makedirs(SWEEP_DIR, exist_ok=True)

# 4 configs: same mask (manhattan-2), mf=1 (simple, fast), 4 different seeds
# 命名严格按 07-04 schema: sweep_<mask>_mf<N>_s<M>
CONFIGS = [
    {"mask": "manhattan-2", "maxFam": 1, "seed": 111},
    {"mask": "manhattan-2", "maxFam": 1, "seed": 222},
    {"mask": "manhattan-2", "maxFam": 1, "seed": 333},
    {"mask": "manhattan-2", "maxFam": 1, "seed": 444},
]

POP = 100
GENS = 100  # Quick for inspection — NOT for paper numbers
GRID_W = 40
GRID_H = 60

def log(msg):
    ts = datetime.datetime.now().isoformat()
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")

def setup_run(page, cfg, run_idx):
    """Set fields via JS dispatch (bindField needs correct event type)."""
    page.goto(URL + "?v=" + str(int(time.time() * 1000)), wait_until="domcontentloaded")
    time.sleep(2)
    page.evaluate("() => document.querySelector('nav.tabs button[data-tab=configure]').click()")
    time.sleep(0.4)
    page.evaluate(f"""() => {{
      const setVal = (sel, v, evt) => {{
        const el = document.querySelector(sel);
        if (!el) {{ console.warn('NOT FOUND: ' + sel); return; }}
        el.value = v;
        el.dispatchEvent(new Event(evt, {{ bubbles: true }}));
      }};
      setVal('#cfg-batch-name',  'sweep_{cfg["mask"]}_mf{cfg["maxFam"]}_s{cfg["seed"]}', 'input');
      setVal('#cfg-popSize',     '{POP}',          'input');
      setVal('#cfg-generations', '{GENS}',         'input');
      setVal('#cfg-gridW',       '{GRID_W}',       'input');
      setVal('#cfg-gridH',       '{GRID_H}',       'input');
      setVal('#cfg-cellMaskType','{cfg["mask"]}',  'change');
      setVal('#cfg-maxFamilies', '{cfg["maxFam"]}','change');
      setVal('#cfg-randomSeed',  '{cfg["seed"]}',  'input');
    }}""")
    time.sleep(0.4)
    # Activate first N family slots
    page.evaluate(f"""() => {{
      for (let i = 0; i < {cfg["maxFam"]}; i++) {{
        const el = document.querySelector(`.fam-slot[data-idx='${{i}}']`);
        if (el && !el.classList.contains('active')) el.click();
      }}
    }}""")
    time.sleep(0.2)
    # Verify config was set
    actual = page.evaluate("""() => ({
        batch: document.querySelector('#cfg-batch-name')?.value,
        pop: document.querySelector('#cfg-popSize')?.value,
        gens: document.querySelector('#cfg-generations')?.value,
        mask: document.querySelector('#cfg-cellMaskType')?.value,
        mf: document.querySelector('#cfg-maxFamilies')?.value,
        seed: document.querySelector('#cfg-randomSeed')?.value,
    })""")
    log(f"  config set: {actual}")
    # Go to Train
    page.evaluate("() => document.querySelector('#cfg-go-train').click()")
    time.sleep(0.4)

def wait_done(page, cfg, timeout_s=240):
    """Wait for ES to finish. Status pill text becomes 'Done.' when complete."""
    t0 = time.time()
    last_status = ""
    last_log = ""
    while time.time() - t0 < timeout_s:
        time.sleep(1.5)
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
        if elapsed % 15 == 0:
            log(f"  [{elapsed}s] status={state['status']!r} log_last={last_log[:80]!r}")
        if state['status'].startswith('Done') or state['status'].startswith('Error') or state['status'].startswith('Stopped'):
            return state
        # Detect ckpt save completion via '✅ run complete' or '💾 ckpt saved'
        if '✅ run complete' in last_log:
            # Wait 5s for ckpt save to flush
            time.sleep(5)
            return state
    log(f"  TIMEOUT after {timeout_s}s, last_status={last_status!r}")
    return None

def capture(page, cfg, wall_sec, status_state):
    """Extract bestScore + log_tail from DOM."""
    best_summary = page.evaluate("() => document.getElementById('train-best-summary')?.innerText || ''")
    log_tail = page.evaluate("""() => {
        const el = document.getElementById('train-log');
        if (!el) return '';
        const lines = Array.from(el.querySelectorAll('div')).map(d => d.innerText);
        return lines.slice(-3).join(' || ');
    }""")
    # Try parse bestScore from best_summary "best=0.XXXX"
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
        "ts": datetime.datetime.now().isoformat(),
        "status": "OK" if best_score is not None else "FAIL",
    }

# ============ MAIN ============
log(f"=== mini-sweep 4 configs starting ===")
log(f"PLAN: {CONFIGS}")

# Verify ckpt_server health first
import urllib.request
try:
    h = json.loads(urllib.request.urlopen('http://127.0.0.1:8088/ckpt/health').read())
    log(f"ckpt_server health: {h}")
except Exception as e:
    log(f"ckpt_server health FAILED: {e}")
    sys.exit(1)

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    # Use existing context (don't create new) — Edge dev mode already has one
    ctx = b.contexts[0]
    log(f"connected to CDP, contexts={len(b.contexts)}")

    for idx, cfg in enumerate(CONFIGS):
        log(f"\n=== [{idx+1}/4] {cfg['mask']}/mf={cfg['maxFam']}/s={cfg['seed']} ===")
        # Fresh page per config (avoid module cache + ES state pollution)
        page = ctx.new_page()
        # Capture console for debug
        page.on("console", lambda msg: log(f"  [console.{msg.type}] {msg.text[:120]}"))
        try:
            setup_run(page, cfg, idx)
            # Click Start
            page.evaluate("() => document.querySelector('#train-start').click()")
            log(f"  start clicked")
            t0 = time.time()
            state = wait_done(page, cfg)
            wall_sec = int(time.time() - t0)
            if state is None:
                log(f"  ❌ TIMEOUT — recording FAIL")
                rec = {
                    "summary": "(timeout)", "best": None, "log_tail": "",
                    "mask": cfg["mask"], "maxFam": cfg["maxFam"], "seed": cfg["seed"],
                    "pop": POP, "gens": GENS, "gridW": GRID_W, "gridH": GRID_H,
                    "wall_sec": wall_sec, "ts": datetime.datetime.now().isoformat(),
                    "status": "FAIL",
                }
            else:
                log(f"  done: status={state['status']!r} elapsed={state['elapsed']}")
                rec = capture(page, cfg, wall_sec, state)
            log(f"  captured: best={rec.get('best')}")
            with open(NDJSON, "a") as f:
                f.write(json.dumps(rec) + "\n")
        except Exception as e:
            log(f"  ❌ EXCEPTION: {e}")
            import traceback
            log(traceback.format_exc())
        finally:
            time.sleep(2)
            page.close()

    log(f"\n=== mini-sweep complete ===")
    log(f"ndjson: {NDJSON}")
    b.close()

# Final summary
log("\n=== NDJSON SUMMARY ===")
if os.path.exists(NDJSON):
    with open(NDJSON) as f:
        for line in f:
            try:
                r = json.loads(line)
                log(f"  {r['mask']:13s} mf={r['maxFam']} s={r['seed']:3d}  best={r.get('best')}  status={r['status']}  wall={r['wall_sec']}s")
            except: pass
log("\nDONE")