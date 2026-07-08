"""
Byte-equal triple compare:
  1. disk:  read ckpt/X.json directly from disk, extract bestChromBits → bytes
  2. server: curl GET /ckpt/load?name=X → bytes
  3. browser: import loadCheckpoint(X) → bytes

If any pair differs, that's a save/parse bug.
"""
from playwright.sync_api import sync_playwright
import time, json, hashlib, urllib.request, os, shutil

URL = "http://127.0.0.1:8087/"
NAMES = [
    'sweep_manhattan-2_mf1_s111.json',
    'sweep_manhattan-2_mf8_s444.json',
    'sweep_chebyshev-1_mf8_s333.json',
    'test.json',
    'mini_sweep_manhattan-2_mf1_s111.json',
    '_panel_b_test.json',
]

def hash_bits(bits):
    h = hashlib.sha256(bytes(bits)).hexdigest()[:16]
    return f"sha256={h} ones={sum(bits)} len={len(bits)} first8={list(bits[:8])} last8={list(bits[-8:])}"

# Fresh profile
fresh_profile = "C:/Users/sicko/AppData/Local/Temp/byte_equal_2026_07_08"
if os.path.exists(fresh_profile):
    shutil.rmtree(fresh_profile, ignore_errors=True)
os.makedirs(fresh_profile, exist_ok=True)

# Test server GET roundtrip
print("=" * 90)
print(f"{'NAME':<45} {'disk':>10} {'server-GET':>10} {'browser':>10} {'all 3 match?':>15}")
print("=" * 90)

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
        disk_path = f'ckpt/{name}'
        if not os.path.exists(disk_path):
            continue
        # 1. disk
        with open(disk_path, 'rb') as f:
            disk_raw = f.read()
        disk = json.loads(disk_raw)
        disk_bits = disk.get('bestChromBits', [])
        disk_fp = hash_bits(disk_bits)
        # disk savedAt vs mtime
        disk_savedAt = disk.get('savedAt', 'NONE')
        disk_mtime = os.path.getmtime(disk_path)
        disk_mtime_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(disk_mtime))
        # 2. server GET
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:8088/ckpt/load?name={name}', timeout=3) as r:
                server_raw = r.read()
            server = json.loads(server_raw)
            server_bits = server.get('bestChromBits', [])
            server_fp = hash_bits(server_bits)
            server_ok = True
        except Exception as e:
            server_fp = f"ERR: {e}"
            server_ok = False
        # 3. browser load
        browser_bits = page.evaluate(f"""async () => {{
            try {{
                const ckptMod = await import('/src/ckpt.js');
                const ckpt = await ckptMod.loadCheckpoint('{name}');
                return ckpt && ckpt.bestChromBits ? Array.from(ckpt.bestChromBits) : null;
            }} catch (e) {{ return null; }}
        }}""")
        if browser_bits is None:
            browser_fp = "ERR: load failed"
            browser_ok = False
        else:
            browser_fp = hash_bits(browser_bits)
            browser_ok = True

        # Compare
        all_match = (disk_bits == server_bits == browser_bits) if server_ok and browser_ok else False
        match_str = '✓ YES' if all_match else '❌ NO'
        print(f"{name:<45} {disk_fp[:10]:>10} {server_fp[:10]:>10} {browser_fp[:10]:>10} {match_str:>15}")
        if not all_match:
            print(f"  DISK bits:    {disk_fp}")
            if server_ok:
                print(f"  SERVER bits:  {server_fp}")
            if browser_ok:
                print(f"  BROWSER bits: {browser_fp}")
        # Also show savedAt vs mtime for ALL files (sko noticed "time wrong")
        print(f"  savedAt={disk_savedAt!r}  file mtime={disk_mtime_iso}  match? {disk_savedAt.startswith(disk_mtime_iso[:16])}")

    browser.close()
