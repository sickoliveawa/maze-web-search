"""Screenshot mazeweb preview, load top ckpt, step evolution."""
import os, asyncio
from playwright.async_api import async_playwright

MSEDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
OUT = r"E:/doro/maze-web/figures/v2"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=MSEDGE, args=["--no-sandbox", "--disable-dev-shm-usage"])
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()
        errors = []
        page.on("console", lambda msg: errors.append(f"[{msg.type}] {msg.text[:200]}") if msg.type == "error" else None)
        page.on("pageerror", lambda exc: errors.append(f"[pageerror] {exc}"))

        print("[1] goto")
        await page.goto("http://localhost:8080/index.html", wait_until="domcontentloaded")
        await page.wait_for_timeout(2000)

        print("[2] click Preview")
        await page.click('text="Preview"')
        await page.wait_for_timeout(2000)

        print("[3] click Refresh to load ckpt list")
        # Find the refresh button on server panel
        for sel in ['button:has-text("Refresh")', '#pv-refresh']:
            try:
                await page.click(sel, timeout=3000)
                print(f"   clicked {sel}")
                break
            except Exception as e: print(f"   miss {sel}: {e}")
        await page.wait_for_timeout(2000)

        # Now should have ckpt cards. Click first
        cards = await page.query_selector_all('.ckpt-card')
        print(f"[4] found {len(cards)} cards")
        if cards:
            # Get the card's name to verify
            first_card = cards[0]
            name_attr = await first_card.get_attribute('data-name')
            print(f"   first card: {name_attr}")
            await first_card.click()
            await page.wait_for_timeout(4000)
            await page.screenshot(path=f"{OUT}/shot_loaded_best.png")

            print("[5] step×10 ×30")
            for i in range(30):
                try:
                    await page.click('button:has-text("step ×10")', timeout=1000)
                    await page.wait_for_timeout(250)
                except Exception as e:
                    print(f"   step {i} err: {e}"); break
            await page.wait_for_timeout(1500)
            await page.screenshot(path=f"{OUT}/shot_best_step300.png")

            # Also click a different one (manhattan-2 best, the top one)
            # First refresh again to make sure list is fresh
            await page.click('button:has-text("Refresh")', timeout=2000)
            await page.wait_for_timeout(2000)
            cards = await page.query_selector_all('.ckpt-card')
            # Look for manhattan-2_mf8_s444 specifically
            target = None
            for c in cards:
                nm = await c.get_attribute('data-name')
                if nm and 'manhattan-2_mf8_s444' in nm:
                    target = c; break
            if target:
                print("[6] loading manhattan-2_mf8_s444 (overall best)")
                await target.click()
                await page.wait_for_timeout(3000)
                for i in range(30):
                    try:
                        await page.click('button:has-text("step ×10")', timeout=1000)
                        await page.wait_for_timeout(200)
                    except Exception: break
                await page.wait_for_timeout(1500)
                await page.screenshot(path=f"{OUT}/shot_mh2_step300.png")

        print(f"\nconsole errors: {len(errors)}")
        for e in errors[:10]:
            print(f"  {e}")

        await browser.close()

asyncio.run(main())