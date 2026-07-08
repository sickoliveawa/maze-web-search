"""Screenshot mazeweb preview, init engine, step evolution."""
import os, asyncio
from playwright.async_api import async_playwright

MSEDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
OUT = r"E:/doro/maze-web/figures/v2"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=MSEDGE, args=["--no-sandbox", "--disable-dev-shm-usage"])
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()
        # Listen console for debugging
        page.on("console", lambda msg: print(f"[browser-{msg.type}] {msg.text[:200]}"))

        print("[1] goto")
        await page.goto("http://localhost:8080/index.html", wait_until="domcontentloaded")
        await page.wait_for_timeout(3000)

        # Find Preview tab button and click
        print("[2] click Preview")
        for sel in ['text="Preview"', 'button:has-text("Preview")', 'a:has-text("Preview")', '[data-tab="preview"]']:
            try:
                await page.click(sel, timeout=2000)
                print(f"   clicked {sel}")
                break
            except Exception as e:
                pass
        await page.wait_for_timeout(3000)

        # Click Init
        print("[3] click Init")
        for sel in ['button:has-text("Init")', '#pv-init', 'button:has-text("▶ Init")']:
            try:
                await page.click(sel, timeout=3000)
                print(f"   clicked {sel}")
                break
            except Exception as e: pass
        await page.wait_for_timeout(3000)
        await page.screenshot(path=f"{OUT}/shot_init.png")

        # Step many times
        print("[4] step×10 ×30")
        for i in range(30):
            try:
                await page.click('button:has-text("step ×10")', timeout=1000)
                await page.wait_for_timeout(200)
            except Exception as e:
                print(f"   step err: {e}"); break
        await page.wait_for_timeout(1000)
        await page.screenshot(path=f"{OUT}/shot_step300.png")

        # Reset & try with a known good ckpt path - first check what fs server path is exposed
        # Actually let me check what's in the ckpt list. Look at #pv-ckpt-list HTML
        ckpt_html = await page.eval_on_selector('#pv-ckpt-list', 'el => el.outerHTML')
        print(f"\n[5] pv-ckpt-list html (first 1500 chars):\n{ckpt_html[:1500]}")

        await browser.close()

asyncio.run(main())