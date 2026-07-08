"""For each top ckpt, decode + verify via GPU engine (use preview tab).
Use playwright to load, run, capture grid as raw canvas pixels."""
import os, asyncio
from playwright.async_api import async_playwright
import numpy as np
import json

MSEDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
OUT = r"E:/doro/maze-web/figures/v2"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=MSEDGE, args=["--no-sandbox", "--disable-dev-shm-usage"])
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()
        await page.goto("http://localhost:8080/index.html", wait_until="domcontentloaded")
        await page.wait_for_timeout(2000)
        await page.click('text="Preview"')
        await page.wait_for_timeout(2000)
        await page.click('button:has-text("Refresh")')
        await page.wait_for_timeout(2000)

        # Target: top 6 by single-side score
        targets = [
            'sweep_manhattan-2_mf8_s444',     # best overall 0.8233
            'sweep_chebyshev-2_mf2_s333',     # #3 0.8080
            'sweep_manhattan-2_mf4_s444',     # #4 0.8059
            'sweep_manhattan-4_mf1_s111',     # #5 0.7999
            'sweep_chebyshev-1_mf8_s333',     # chebyshev-1 best 0.7452
            'sweep_chebyshev-4_mf8_s444',     # broken 0.4288
            'sweep_manhattan-1_mf8_s444',     # stuck 0.4205
        ]

        for target in targets:
            cards = await page.query_selector_all('.ckpt-card')
            card = None
            for c in cards:
                nm = await c.get_attribute('data-name')
                if nm and target in nm:
                    card = c; break
            if not card:
                print(f"  SKIP {target}"); continue
            print(f"  loading {target}")
            await card.click()
            await page.wait_for_timeout(3000)
            await page.click('button:has-text("Init")')
            await page.wait_for_timeout(1500)

            # Get the current mode (orig/inv) before stepping
            status_before = await page.eval_on_selector('#pv-status', 'el => el.textContent')
            print(f"    status after init: {status_before}")

            # Step 300
            for _ in range(30):
                try:
                    await page.click('button:has-text("step ×10")', timeout=1000)
                    await page.wait_for_timeout(150)
                except: break
            await page.wait_for_timeout(1500)

            status_after = await page.eval_on_selector('#pv-status', 'el => el.textContent')
            print(f"    status after step300: {status_after}")

            # If inv, click reset and reload to force orig
            if 'inv' in status_after.lower():
                print(f"    forcing orig mode...")
                # Reset, step once, check
                await page.click('button:has-text("reset")', timeout=2000)
                await page.wait_for_timeout(1000)
                await page.click('button:has-text("Init")')
                await page.wait_for_timeout(1000)
                status_reset = await page.eval_on_selector('#pv-status', 'el => el.textContent')
                print(f"    status after reset+init: {status_reset}")

            # Take full screenshot
            await page.screenshot(path=f"{OUT}/ckpt_{target}_step300.png", full_page=True)

            # Extract canvas pixel data: locate canvas, screenshot just the canvas area
            canvas = await page.query_selector('canvas')
            if canvas:
                box = await canvas.bounding_box()
                if box:
                    # Need to clip to the IMAGE panel area
                    # Actually use the pv-canvas or the right canvas
                    pass

            # Refresh
            await page.click('button:has-text("Refresh")')
            await page.wait_for_timeout(1500)

        await browser.close()

asyncio.run(main())