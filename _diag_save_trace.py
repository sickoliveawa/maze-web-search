"""
Direct save trace: synthesize a known bits array, POST to /ckpt/save,
then GET back, compare bit-by-bit with the synthesized input.
This is the most direct test of save() + load() path.
"""
from playwright.sync_api import sync_playwright
import time, json, hashlib, urllib.request, os, shutil

TEST_NAME = '_save_trace_test_2026_07_08.json'
# Synthesize 1648-bit pattern with known fingerprint
test_bits = []
for i in range(1648):
    test_bits.append(((i * 31 + 17) & 0xFF) & 1)  # deterministic pattern
expected_sha = hashlib.sha256(bytes(test_bits)).hexdigest()[:16]
print(f"Synthesized test bits: len={len(test_bits)} ones={sum(test_bits)} sha={expected_sha}")
print(f"first 32: {test_bits[:32]}")

fresh_profile = "C:/Users/sicko/AppData/Local/Temp/save_trace_2026_07_08"
if os.path.exists(fresh_profile):
    shutil.rmtree(fresh_profile, ignore_errors=True)
os.makedirs(fresh_profile, exist_ok=True)

URL = "http://127.0.0.1:8087/"

# Step 1: Browser POST synthesized bits to /ckpt/save
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

    print(f"\n=== Step 1: Browser POST /ckpt/save with synthesized bits ===")
    save_resp = page.evaluate(f"""async () => {{
        const bits = {json.dumps(test_bits)};
        const rec = {{
            config: {{
                batchName: 'save_trace_test_2026_07_08',
                randomSeed: 999, gridW: 40, gridH: 60, caSteps: 300,
                cellMaskType: 'manhattan-2', maxFamilies: 1, activeFamilySlots: [0],
                initFullScreen: true, initPatchSize: 60, initDensity: 0.15,
                metric: 'mazeQuality', popSize: 100, generations: 50,
            }},
            gen: 50,
            bestScore: 0.7654321,
            bestChromBits: bits,
            bestBreakdown: null,
            runTag: 'trace_run_{int(time.time())}',
        }};
        const r = await fetch('http://127.0.0.1:8088/ckpt/save', {{
            method: 'POST',
            headers: {{ 'Content-Type': 'application/json' }},
            body: JSON.stringify(rec),
        }});
        return {{ status: r.status, body: await r.text() }};
    }}""")
    print(f"  save response: status={save_resp['status']} body={save_resp['body'][:200]}")

    browser.close()

# Step 2: read disk directly
print(f"\n=== Step 2: Read disk directly ===")
disk_path = f'ckpt/{TEST_NAME}'
with open(disk_path, 'rb') as f:
    disk_raw = f.read()
disk = json.loads(disk_raw)
disk_bits = disk.get('bestChromBits', [])
disk_sha = hashlib.sha256(bytes(disk_bits)).hexdigest()[:16]
print(f"  disk size: {len(disk_raw)} bytes")
print(f"  disk sha: {disk_sha} (expected {expected_sha})")
print(f"  disk ones: {sum(disk_bits)} (expected {sum(test_bits)})")
print(f"  match? {'✓' if disk_sha == expected_sha else '❌'}")

# Step 3: server GET
print(f"\n=== Step 3: Server GET /ckpt/load ===")
with urllib.request.urlopen(f'http://127.0.0.1:8088/ckpt/load?name={TEST_NAME}', timeout=3) as r:
    server_raw = r.read()
server = json.loads(server_raw)
server_bits = server.get('bestChromBits', [])
server_sha = hashlib.sha256(bytes(server_bits)).hexdigest()[:16]
print(f"  server size: {len(server_raw)} bytes")
print(f"  server sha: {server_sha} (expected {expected_sha})")
print(f"  match? {'✓' if server_sha == expected_sha else '❌'}")
print(f"  server == disk? {'✓' if server_bits == disk_bits else '❌'}")

# Step 4: Browser load
print(f"\n=== Step 4: Browser loadCheckpoint via fresh context ===")
with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(
        user_data_dir=fresh_profile,  # reuse
        headless=False,
        args=["--no-sandbox"],
    )
    page = browser.pages[0] if browser.pages else browser.new_page()
    page.goto(URL + "?v=" + str(int(time.time()*1000)), wait_until="domcontentloaded")
    time.sleep(3)
    loaded_bits = page.evaluate(f"""async () => {{
        const ckptMod = await import('/src/ckpt.js');
        const ckpt = await ckptMod.loadCheckpoint('{TEST_NAME}');
        return ckpt ? Array.from(ckpt.bestChromBits) : null;
    }}""")
    if loaded_bits:
        loaded_sha = hashlib.sha256(bytes(loaded_bits)).hexdigest()[:16]
        print(f"  browser sha: {loaded_sha} (expected {expected_sha})")
        print(f"  match? {'✓' if loaded_sha == expected_sha else '❌'}")
        print(f"  browser == server? {'✓' if loaded_bits == server_bits else '❌'}")
        print(f"  browser == disk? {'✓' if loaded_bits == disk_bits else '❌'}")
    else:
        print(f"  ❌ load failed")
    browser.close()

# Step 5: Compare key fields
print(f"\n=== Step 5: Other fields consistency ===")
print(f"  bestScore: input=0.7654321  disk={disk.get('bestScore')}  server={server.get('bestScore')}")
print(f"  runTag: input=trace_run_xxx  disk={disk.get('runTag')}  server={server.get('runTag')}")
print(f"  savedAt: disk={disk.get('savedAt')}  server={server.get('savedAt')}")
print(f"  config.batchName: disk={disk.get('config', {}).get('batchName')}  server={server.get('config', {}).get('batchName')}")

# Cleanup
os.remove(disk_path)
print(f"\nCleaned up: {disk_path}")
