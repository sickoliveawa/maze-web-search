"""
_sweep_runner_2026_07_09.py — Full sweep v5+v6 (NEW seeds)

sko 07-08 spec: 重新跑完整 sweep 验证 mTop 5-权重重分配 (v5) + mC uncap (v6)
效果. 用 NEW seeds [114, 514, 1919, 810] 区别于 07-04 sweep [111,222,333,444].

Matrix (8 mask × 4 mf × 4 seeds = 128):
  mask      : 8 = chebyshev-{1,2,3,4} + manhattan-{1,2,3,4}
  maxFam    : 4 = {1, 2, 4, 8}
  seed      : 4 = {114, 514, 1919, 810}    ← NEW (07-04 sweep 用 111/222/333/444)
  gridW×H   : 40 × 60
  popSize   : 200
  generations: 500
  metric    : mazeQuality v5+v6 (mC uncap + mTop rebalance)

Total runs: 8 × 4 × 4 = 128
Estimated wall time: ~7 min/run × 128 ≈ 15 hours

Saves to: E:\\doro\\maze-web\\sweep_2026_07_09\\results.ndjson
"""
from playwright.sync_api import sync_playwright
import time, json, os, sys, datetime

CDP = "http://127.0.0.1:9222"
URL = "http://127.0.0.1:8087/"
SWEEP_DIR = r"E:\doro\maze-web\sweep_2026_07_09"
NDJSON = os.path.join(SWEEP_DIR, "results.ndjson")

MASKS = ['chebyshev-1', 'chebyshev-2', 'chebyshev-3', 'chebyshev-4',
         'manhattan-1', 'manhattan-2', 'manhattan-3', 'manhattan-4']
MAX_FAMS = [1, 2, 4, 8]
SEEDS = [114, 514, 1919, 810]  # NEW 07-08 seeds (vs 07-04: 111/222/333/444)

GRID_W = 40
GRID_H = 60
POP = 200
GENS = 500

os.makedirs(SWEEP_DIR, exist_ok=True)

# Resume check
done = set()
if os.path.exists(NDJSON):
    with open(NDJSON, 'r') as f:
        for line in f:
            try:
                rec = json.loads(line)
                done.add((rec['mask'], rec['maxFam'], rec['seed']))
            except: pass
print(f"== Resume: {len(done)} runs already done ==")

PLAN = [{'mask': m, 'maxFam': mf, 'seed': s}
        for m in MASKS for mf in MAX_FAMS for s in SEEDS]

print(f"PLAN (total {len(PLAN)}):")
for c in PLAN:
    flag = "[DONE]" if (c['mask'], c['maxFam'], c['seed']) in done else "[    ]"
    print(f"  {flag}  {c['mask']:13s}  mf={c['maxFam']}  seed={c['seed']}")

TO_DO = [c for c in PLAN if (c['mask'], c['maxFam'], c['seed']) not in done]
if not TO_DO:
    print("All done.")
    sys.exit(0)
print(f"\nWill run {len(TO_DO)} more runs.\n")

t_total_start = time.time()

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp(CDP)
    page = b.contexts[0].new_page()

    def setup_run(cfg):
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
          setVal('#cfg-batch-name',  'sweep07_09_{cfg['mask']}_mf{cfg['maxFam']}_s{cfg['seed']}', 'input');
          setVal('#cfg-popSize',       '{POP}',                                                  'input');
          setVal('#cfg-generations',   '{GENS}',                                                 'input');
          setVal('#cfg-gridW',         '{GRID_W}',                                               'input');
          setVal('#cfg-gridH',         '{GRID_H}',                                               'input');
          setVal('#cfg-cellMaskType',  '{cfg['mask']}',                                          'change');
          setVal('#cfg-maxFamilies',   '{cfg['maxFam']}',                                        'change');
          setVal('#cfg-randomSeed',    '{cfg['seed']}',                                          'input');
        }}""")
        time.sleep(0.4)
        # Activate maxFam family slots
        page.evaluate(f"""() => {{
          for (let i = 0; i < {cfg['maxFam']}; i++) {{
            const el = document.querySelector(`.fam-slot[data-idx='${{i}}']`);
            if (el && !el.classList.contains('active')) el.click();
          }}
        }}""")
        time.sleep(0.2)
        page.evaluate("() => document.querySelector('#cfg-go-train').click()")
        time.sleep(0.4)
        # IMPORTANT: cfg-go-train only switches to Train tab. Must explicitly click train-start.
        page.evaluate("() => document.querySelector('#train-start').click()")

    def wait_done(timeout_s=600):
        """Detect run completion via status text + progress + log keywords.

        Bug fix (07-04): previously only checked log for 'complete'/'bestScore',
        which fired only at finalize time. ckpt save events (gen 50, 100, ...)
        added noise without signaling end. Now also checks:
          - #train-status-text === 'Done. best=...'
          - #train-progress-text reaches 'gen N / N' (last gen)
          - log keyword 'run complete' OR '✅'
        Timeout reduced 900→600s (runs are ~7min, so 10min cap is plenty).
        """
        t = time.time()
        last_status = ''
        while time.time() - t < timeout_s:
            time.sleep(2)  # faster poll: was 5s
            try:
                state = page.evaluate("""() => {
                  const statusEl = document.querySelector('#train-status-text');
                  const progEl   = document.querySelector('#train-progress-text');
                  const logEl    = document.querySelector('#train-log');
                  const lastLine = logEl ? (logEl.innerText || '').split('\\n').filter(Boolean).slice(-1)[0] || '' : '';
                  return {
                    status: statusEl ? statusEl.innerText : '',
                    progress: progEl ? progEl.innerText : '',
                    lastLine,
                  };
                }""")
            except Exception:
                continue
            status = state['status'] or ''
            progress = state['progress'] or ''
            lastLine = state['lastLine']
            # Print when status text or last log line changes
            sig = f"{status}|{lastLine[:80]}"
            if sig != last_status:
                print(f"    [{int(time.time()-t)}s] status={status[:30]!r} progress={progress!r} log={lastLine[:80]!r}", flush=True)
                last_status = sig
            # Completion check (any of these)
            if status.startswith('Done') or status.startswith('Stopped') or ('Error' in status and 'no error' not in status.lower()):
                return True
            if '✅' in lastLine or 'run complete' in lastLine.lower():
                return True
            # Progress reached 100%
            import re as _re
            m = _re.match(r'gen\s+(\d+)\s*/\s*(\d+)', progress)
            if m and m.group(1) == m.group(2) and int(m.group(2)) >= 100:
                time.sleep(3)
                if status.startswith('Done'):
                    return True
        return False

    def capture(cfg):
        rec = page.evaluate("""() => {
          const summary = (document.querySelector('#train-summary') || {}).innerText || '';
          const log = document.querySelector('#train-log');
          const lines = log ? (log.innerText || '').split('\\n').filter(Boolean) : [];
          const bestMatch = summary.match(/bestScore=([0-9.]+)/);
          // bugfix 07-04: fall back to log_tail if #train-summary is empty
          const tailMatch = !bestMatch ? lines.join(' || ').match(/bestScore=([0-9.]+)/) : null;
          const best = bestMatch ? parseFloat(bestMatch[1]) : (tailMatch ? parseFloat(tailMatch[1]) : null);
          return {
            summary: summary,
            best,
            log_tail: lines.slice(-6).join(' || '),
          };
        }""")
        rec.update({'mask': cfg['mask'], 'maxFam': cfg['maxFam'], 'seed': cfg['seed'],
                    'pop': POP, 'gens': GENS, 'gridW': GRID_W, 'gridH': GRID_H,
                    'wall_sec': int(time.time() - t_run_start),
                    'ts': datetime.datetime.now().isoformat()})
        return rec

    HEARTBEAT = os.path.join(SWEEP_DIR, 'dispatcher.heartbeat')

    def heartbeat():
        """Write timestamp file so external monitor can detect dispatcher death."""
        with open(HEARTBEAT, 'w') as f:
            f.write(f"{datetime.datetime.now().isoformat()} | cfg={cfg['mask']}/mf={cfg['maxFam']}/s={cfg['seed']} | elapsed={int(time.time()-t_run_start)}s\n")

    for idx, cfg in enumerate(TO_DO):
        print(f"\n=== [{idx+1}/{len(TO_DO)}] {cfg['mask']} mf={cfg['maxFam']} s={cfg['seed']} ===", flush=True)
        t_run_start = time.time()
        try:
            setup_run(cfg)
            ok = wait_done(timeout_s=900)
        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            print(f"  !! EXCEPTION in run: {e}\n{tb}", flush=True)
            rec = {'mask': cfg['mask'], 'maxFam': cfg['maxFam'], 'seed': cfg['seed'],
                   'status': 'ERROR', 'error': str(e)[:200], 'traceback': tb[-500:],
                   'wall_sec': int(time.time() - t_run_start),
                   'ts': datetime.datetime.now().isoformat()}
            with open(NDJSON, 'a') as f:
                f.write(json.dumps(rec) + '\n')
            done.add((cfg['mask'], cfg['maxFam'], cfg['seed']))
            # Try to recover browser context for next run
            try:
                page.reload(wait_until='domcontentloaded')
                time.sleep(2)
                print("  >> reloaded page after error, continuing", flush=True)
            except Exception as reload_err:
                print(f"  >> page reload failed: {reload_err}; ABORTING dispatcher", flush=True)
                break
            continue
        if not ok:
            print("  ! TIMEOUT or error, recording failure")
            rec = {'mask': cfg['mask'], 'maxFam': cfg['maxFam'], 'seed': cfg['seed'],
                   'status': 'TIMEOUT', 'wall_sec': int(time.time() - t_run_start),
                   'ts': datetime.datetime.now().isoformat()}
        else:
            rec = capture(cfg)
            rec['status'] = 'OK'  # bugfix 07-04: capture() didn't set status field, all OK runs were status=None
            print(f"  status=best={rec.get('best')} wall={rec['wall_sec']}s ({rec['wall_sec']/60:.1f}min)", flush=True)
        with open(NDJSON, 'a') as f:
            f.write(json.dumps(rec) + '\n')
        tot_min = (time.time() - t_total_start) / 60
        print(f"  cumulative wall: {tot_min:.1f} min ({tot_min/60:.2f} h)", flush=True)
        done.add((cfg['mask'], cfg['maxFam'], cfg['seed']))
        heartbeat()  # update heartbeat after each successful run

print(f"\n=== ALL {len(TO_DO)} RUNS DONE in {(time.time() - t_total_start)/3600:.2f} hours ===")
print(f"Results: {NDJSON}")