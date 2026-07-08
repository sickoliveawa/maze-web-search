"""
mini_redispatch_panelB.py — re-run just panel B config.
"""
from playwright.sync_api import sync_playwright
import time, json, datetime

CDP = "http://127.0.0.1:9222"
URL = "http://127.0.0.1:8087/"
LOG = r"E:\doro\maze-web\sweep_2026_07_04\redispatch_panelB.log"

MASK = "chebyshev-1"
MF = 8
SEED = 333

with open(LOG, "w") as f:
    f.write(f"=== Redispatch {MASK}/mf={MF}/s={SEED} ===\n")
    f.flush()

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(CDP)
    page = browser.contexts[0].new_page()

    def on_msg(msg):
        ts = datetime.datetime.now().isoformat()
        with open(LOG, "a") as f:
            f.write(f"[{ts}] {msg.type}: {msg.text}\n")

    page.on("console", on_msg)

    cfg = {"mask": MASK, "maxFam": MF, "seed": SEED}

    page.goto(URL + "?v=" + str(int(time.time() * 1000)), wait_until="domcontentloaded")
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
      setVal('#cfg-batch-name',  'sweep_{cfg['mask']}_mf{cfg['maxFam']}_s{cfg['seed']}', 'input');
      setVal('#cfg-popSize',       '200', 'input');
      setVal('#cfg-generations',   '500', 'input');
      setVal('#cfg-gridW',         '40', 'input');
      setVal('#cfg-gridH',         '60', 'input');
      setVal('#cfg-cellMaskType',  '{cfg['mask']}', 'change');
      setVal('#cfg-maxFamilies',   '{cfg['maxFam']}', 'change');
      setVal('#cfg-randomSeed',    '{cfg['seed']}', 'input');
    }}""")
    time.sleep(0.4)
    page.evaluate(f"""() => {{
      for (let i = 0; i < {cfg['maxFam']}; i++) {{
        const el = document.querySelector(`.fam-slot[data-idx='${{i}}']`);
        if (el && !el.classList.contains('active')) el.click();
      }}
    }}""")
    time.sleep(0.2)
    page.evaluate("() => document.querySelector('#cfg-go-train').click()")
    time.sleep(0.4)
    page.evaluate("() => document.querySelector('#train-start').click()")

    t0 = time.time()
    while time.time() - t0 < 600:
        time.sleep(2)
        try:
            state = page.evaluate("""() => {
              const statusEl = document.querySelector('#train-status-text');
              const lastLine = (document.querySelector('#train-log') || {}).innerText || '';
              const lines = lastLine.split('\\n').filter(Boolean);
              return { status: statusEl ? statusEl.innerText : '', lastLine: lines.slice(-1)[0] || '' };
            }""")
        except: continue
        elapsed = int(time.time() - t0)
        with open(LOG, "a") as f:
            f.write(f"[{elapsed}s] status={state['status']!r} log={state['lastLine'][:80]!r}\n")
        if state['status'].startswith('Done') or state['status'].startswith('Stopped'):
            print(f"  [{elapsed}s] DONE status={state['status']!r}")
            break
        if '✅' in state['lastLine'] or 'run complete' in state['lastLine'].lower():
            print(f"  [{elapsed}s] OK seen, +5s for ckpt save")
            time.sleep(5)
            break

    time.sleep(5)
    page.close()

print("DONE")
