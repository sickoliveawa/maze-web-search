"""Extract grid as raw pixels from preview tab canvas."""
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

        targets = [
            ('sweep_manhattan-2_mf8_s444',     0.8233, 'best_overall'),
            ('sweep_chebyshev-2_mf2_s333',     0.8080, 'best_cheb2'),
            ('sweep_manhattan-4_mf1_s111',     0.7999, 'best_mh4'),
            ('sweep_chebyshev-1_mf8_s333',     0.7452, 'best_cheb1'),
            ('sweep_chebyshev-4_mf8_s444',     0.4288, 'broken_cheb4'),
            ('sweep_manhattan-1_mf8_s444',     0.4205, 'stuck_mh1'),
        ]

        results = []
        for target, expected_score, label in targets:
            cards = await page.query_selector_all('.ckpt-card')
            card = None
            for c in cards:
                nm = await c.get_attribute('data-name')
                if nm and target in nm:
                    card = c; break
            if not card:
                continue
            print(f"  loading {target}")
            await card.click()
            await page.wait_for_timeout(2500)
            await page.click('button:has-text("Init")')
            await page.wait_for_timeout(1200)

            # Get original-mode status (force orig if showing inv)
            for _ in range(40):  # step up to 400 if needed
                status = await page.eval_on_selector('#pv-status', 'el => el.textContent')
                if 'orig' in status.lower():
                    break
                await page.click('button:has-text("reset")', timeout=2000)
                await page.wait_for_timeout(500)
                await page.click('button:has-text("Init")')
                await page.wait_for_timeout(500)

            # Now step to 300
            for _ in range(30):
                try:
                    await page.click('button:has-text("step ×10")', timeout=500)
                    await page.wait_for_timeout(120)
                except: break
            await page.wait_for_timeout(1500)

            status_after = await page.eval_on_selector('#pv-status', 'el => el.textContent')
            print(f"    final status: {status_after}")

            # Get grid from window.grid or engine
            # Try evaluate _engine state
            grid_data = await page.evaluate("""() => {
                // Look for any global grid array
                const keys = Object.keys(window).filter(k => k.includes('grid') || k.includes('Grid') || k.includes('pv'));
                const found = {};
                keys.forEach(k => {
                    try {
                        const v = window[k];
                        if (v && (v.data || v instanceof Uint8Array)) found[k] = v.data || Array.from(v);
                    } catch(e) {}
                });
                return found;
            }""")
            print(f"    found {len(grid_data)} globals with grid-like data")

            # Render full screenshot
            await page.screenshot(path=f"{OUT}/render_{label}.png")

            # Click just the IMAGE canvas area (the grid display)
            # Find the largest canvas element
            canvases = await page.query_selector_all('canvas')
            print(f"    found {len(canvases)} canvas elements")
            for i, c in enumerate(canvases):
                box = await c.bounding_box()
                if box and box['width'] > 200 and box['height'] > 200:
                    img_path = f"{OUT}/grid_{label}.png"
                    await c.screenshot(path=img_path)
                    print(f"    saved canvas #{i}: {box['width']}x{box['height']} -> {img_path}")

            results.append({'target': target, 'score': expected_score, 'label': label, 'status': status_after})

            await page.click('button:has-text("Refresh")')
            await page.wait_for_timeout(1500)

        print('\nResults:')
        for r in results:
            print(f"  {r['label']}: {r['target']} score={r['score']} status='{r['status']}'")

        await browser.close()
    with open(f'{OUT}/render_results.json', 'w') as f:
        json.dump(results, f, indent=2)

asyncio.run(main())