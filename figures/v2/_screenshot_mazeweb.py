"""Use playwright + msedge to screenshot mazeweb preview tab."""
import sys, os, asyncio
from playwright.async_api import async_playwright

MSEDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
CHROME = r"C:\Users\sicko\AppData\Local\ms-playwright\chromium-1228\chrome-win64\chrome.exe"

async def main():
    exe = MSEDGE if os.path.exists(MSEDGE) else CHROME
    print(f"Using browser: {exe}")
    out_dir = r"E:/doro/maze-web/figures/v2"
    os.makedirs(out_dir, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=exe, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await context.new_page()

        # === Step 1: Open preview tab ===
        print("[1] Open mazeweb index")
        await page.goto("http://localhost:8080/index.html", wait_until="networkidle")
        await page.wait_for_timeout(2000)
        await page.screenshot(path=f"{out_dir}/shot_01_index.png", full_page=False)

        # === Step 2: Click Preview tab ===
        print("[2] Click Preview tab")
        # find preview tab link/button
        try:
            await page.click('text="Preview"', timeout=5000)
        except Exception:
            try:
                await page.click('a:has-text("Preview")', timeout=3000)
            except Exception:
                # try other selectors
                for sel in ['[data-tab="preview"]', '#tab-preview', 'button:has-text("Preview")']:
                    try:
                        await page.click(sel, timeout=2000); break
                    except Exception: pass
        await page.wait_for_timeout(2000)
        await page.screenshot(path=f"{out_dir}/shot_02_preview.png", full_page=False)

        # === Step 3: In preview, load a known checkpoint from list ===
        # Need to load one of the top ckpts. Check what selectors exist for ckpt cards
        ckpt_cards = await page.query_selector_all('.ckpt-card')
        print(f"   ckpt cards found: {len(ckpt_cards)}")
        if ckpt_cards:
            # Click first card (best)
            await ckpt_cards[0].click()
            await page.wait_for_timeout(3000)
            await page.screenshot(path=f"{out_dir}/shot_03_loaded_first.png", full_page=False)

        # === Step 4: Step a few times to show evolution ===
        try:
            await page.click('#pv-step-10', timeout=2000)
            await page.wait_for_timeout(2000)
            await page.screenshot(path=f"{out_dir}/shot_04_step10.png", full_page=False)
            await page.click('#pv-step-10', timeout=2000)
            await page.wait_for_timeout(2000)
            await page.screenshot(path=f"{out_dir}/shot_05_step20.png", full_page=False)
            await page.click('#pv-step-10', timeout=2000)
            await page.wait_for_timeout(2000)
            await page.screenshot(path=f"{out_dir}/shot_06_step30.png", full_page=False)
            # step many times to get to ~step 300
            for _ in range(27):
                try:
                    await page.click('#pv-step-10', timeout=1000)
                    await page.wait_for_timeout(300)
                except Exception: break
            await page.wait_for_timeout(1000)
            await page.screenshot(path=f"{out_dir}/shot_07_step300.png", full_page=False)
        except Exception as e:
            print(f"   step button error: {e}")

        # === Step 5: Take full page screenshot of preview tab ===
        await page.screenshot(path=f"{out_dir}/shot_08_preview_full.png", full_page=True)

        await browser.close()
    print("done")

asyncio.run(main())