"""Focused screenshot of just the IMAGE panel with maze grid."""
import os, asyncio
from playwright.async_api import async_playwright

MSEDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
OUT = r"E:/doro/maze-web/figures/v2"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=MSEDGE, args=["--no-sandbox", "--disable-dev-shm-usage"])
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()
        page.on("pageerror", lambda exc: print(f"[pageerror] {exc}"))

        await page.goto("http://localhost:8080/index.html", wait_until="domcontentloaded")
        await page.wait_for_timeout(2000)
        await page.click('text="Preview"')
        await page.wait_for_timeout(2000)
        await page.click('button:has-text("Refresh")', timeout=2000)
        await page.wait_for_timeout(2000)

        # Find specific top ckpts
        target_names = [
            ('sweep_manhattan-2_mf8_s444', 'best_overall'),  # top score 0.8233
            ('sweep_chebyshev-1_mf8_s333', 'best_cheb1'),     # chebyshev top
            ('sweep_chebyshev-2_mf2_s333', 'best_cheb2'),     # chebyshev-2
            ('sweep_manhattan-4_mf1_s111', 'best_mh4'),       # manhattan-4 single family
            ('sweep_chebyshev-4_mf8_s444', 'worst_cheb4'),    # chebyshev-4 broken
            ('sweep_manhattan-1_mf8_s444', 'worst_mh1'),      # manhattan-1 stuck
        ]

        # CSS to hide M4 badge
        await page.add_style_tag(content='.badge-sota, .sota-badge, [class*="sota"], [class*="m4"] { display:none !important; }')

        for target_name, label in target_names:
            cards = await page.query_selector_all('.ckpt-card')
            card = None
            for c in cards:
                nm = await c.get_attribute('data-name')
                if nm and target_name in nm:
                    card = c; break
            if not card:
                print(f"  SKIP {target_name} (not found)")
                continue
            print(f"  loading {target_name}")
            await card.click()
            await page.wait_for_timeout(3000)
            # Init
            try: await page.click('button:has-text("Init")', timeout=2000)
            except: pass
            await page.wait_for_timeout(1500)
            # Step 300
            for i in range(30):
                try:
                    await page.click('button:has-text("step ×10")', timeout=1000)
                    await page.wait_for_timeout(150)
                except: break
            await page.wait_for_timeout(1500)

            # Screenshot full
            full_path = f"{OUT}/es_{label}_full.png"
            await page.screenshot(path=full_path, full_page=True)
            print(f"    saved {full_path}")

            # Try to locate canvas/img in IMAGE panel
            for sel in ['canvas', '#pv-canvas', 'canvas#pv-grid', '[id*="canvas"]', '.pv-canvas canvas']:
                el = await page.query_selector(sel)
                if el:
                    try:
                        box = await el.bounding_box()
                        if box and box['width'] > 50:
                            img_path = f"{OUT}/es_{label}_grid.png"
                            await page.screenshot(path=img_path, clip=box)
                            print(f"    grid shot {img_path}")
                            break
                    except Exception as e: print(f"    clip err: {e}")
            # Refresh list
            await page.click('button:has-text("Refresh")', timeout=2000)
            await page.wait_for_timeout(1500)

        await browser.close()

asyncio.run(main())