#!/usr/bin/env python3
"""Verify ckpt_server runTag anti-clobber fix is in place.

Replays the panel (b) race-overwrite scenario:
  Run 1: gen=500, score=0.81, runTag="run_orig"  → save OK
  Run 2: gen=50, score=0.40, runTag="run_redispatch" → MUST get HTTP 409
  Final state: on-disk should still be Run 1 (original preserved)

Also verifies atomic write (no .tmp leftover) and backward compat
(legacy ckpts without runTag remain valid).

Usage:
    python verify_runtag_anti_clobber.py [CKPT_BASE_URL]
    # default: http://127.0.0.1:8088
"""
import json
import random
import sys
import time
from pathlib import Path
from urllib.parse import urljoin

try:
    import requests
except ImportError:
    print("ERROR: requests not installed. pip install requests")
    sys.exit(2)

CKPT_BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8088"
CKPT_DIR = Path("E:/doro/maze-web/ckpt")  # adjust for your system
TEST = "_runtag_verify_"
URL_HEALTH = urljoin(CKPT_BASE, "/ckpt/health")
URL_SAVE = urljoin(CKPT_BASE, "/ckpt/save")
URL_LOAD = urljoin(CKPT_BASE, "/ckpt/load")


def rnd_bits(seed: int) -> list:
    rng = random.Random(seed)
    return [rng.randint(0, 1) for _ in range(1648)]


def make_payload(batch_name: str, gen: int, score: float, bits: list,
                 run_tag: str, saved_at: str = None) -> dict:
    p = {
        "config": {
            "batchName": batch_name,
            "mask": "chebyshev-1", "maxFamilies": 8, "randomSeed": 333,
            "gridW": 40, "gridH": 60, "caSteps": 300, "popSize": 200,
            "generations": 500, "initFullScreen": True, "initDensity": 0.15,
            "metric": "mazeQuality", "seeds": 1,
        },
        "gen": gen, "bestScore": score, "bestChromBits": bits,
        "bestBreakdown": {"M_topology": score, "M_diversity": score},
        "savedAt": saved_at or "2026-07-07T15:00:00",
        "runTag": run_tag,
    }
    return p


def post(payload: dict):
    r = requests.post(URL_SAVE, json=payload, timeout=5)
    return r.status_code, r.json()


def get(name: str):
    r = requests.get(URL_LOAD, {"name": name}, timeout=5)
    return r.json() if r.ok else None


def cleanup(bn: str):
    fname = f"{bn}.json"
    for p in CKPT_DIR.glob(f"{fname}*"):
        try:
            p.unlink()
        except Exception:
            pass


def assert_eq(actual, expected, label):
    if actual != expected:
        print(f"  FAIL: {label}: expected={expected!r}, got={actual!r}")
        sys.exit(1)
    print(f"  PASS: {label}")


def test_health():
    """First: verify ckpt_server is reachable."""
    print("\n=== Health check ===")
    try:
        r = requests.get(URL_HEALTH, timeout=3)
        data = r.json()
        if data.get("ok"):
            print(f"  PASS: server up at {CKPT_BASE}, dir={data.get('dir')}, "
                  f"files={data.get('files')}")
            return True
        print(f"  FAIL: server returned ok=false")
        return False
    except Exception as e:
        print(f"  FAIL: cannot reach {CKPT_BASE}: {e}")
        return False


def test_panel_b_replay():
    """Panel (b) exact scenario: original → redispatch should REJECT."""
    print("\n=== Panel (b) replay (runTag anti-clobber) ===")
    bn = f"{TEST}sweep_chebyshev-1_mf8_s333"
    cleanup(bn)

    # Run 1: original at 07-04
    code1, resp1 = post(make_payload(
        bn, gen=500, score=0.81, bits=rnd_bits(1000),
        run_tag="run_orig", saved_at="2026-07-04T17:29:13"))
    print(f"  Run 1: HTTP {code1}, ok={resp1.get('ok')}")
    assert_eq(code1, 200, "Run 1 should be 200")
    assert_eq(resp1.get("ok"), True, "Run 1 ok")

    saved = get(f"{bn}.json")
    assert_eq(saved["gen"], 500, "Run 1 on-disk gen")
    assert_eq(saved["bestScore"], 0.81, "Run 1 on-disk score")
    assert_eq(saved["runTag"], "run_orig", "Run 1 on-disk runTag")

    # Run 2: redispatch at 07-06 — MUST be rejected
    code2, resp2 = post(make_payload(
        bn, gen=50, score=0.40, bits=rnd_bits(50),
        run_tag="run_redispatch", saved_at="2026-07-06T13:11:35"))
    print(f"  Run 2: HTTP {code2}, ok={resp2.get('ok')}")
    assert_eq(code2, 409, "Run 2 should be 409 (clobber blocked)")
    assert_eq(resp2.get("existing_runTag"), "run_orig", "Run 2 error.existing_runTag")
    assert_eq(resp2.get("incoming_runTag"), "run_redispatch", "Run 2 error.incoming_runTag")
    assert "advice" in resp2, "Run 2 response should include advice"

    # Final: Run 1 preserved
    saved = get(f"{bn}.json")
    assert_eq(saved["gen"], 500, "Final on-disk gen (Run 1 preserved)")
    assert_eq(saved["bestScore"], 0.81, "Final on-disk score (Run 1 preserved)")
    assert_eq(saved["runTag"], "run_orig", "Final on-disk runTag (Run 1 preserved)")

    cleanup(bn)
    return True


def test_same_session_overwrite():
    """Same runTag across saves (gen 50→500) → latest wins, all OK."""
    print("\n=== Same-session overwrite (gen 50→500, same runTag) ===")
    bn = f"{TEST}same_session"
    cleanup(bn)
    rt = "run_same_session_test"

    for gen in [50, 100, 200, 350, 500]:
        code, resp = post(make_payload(
            bn, gen=gen, score=0.5+gen*0.001, bits=rnd_bits(gen),
            run_tag=rt, saved_at=f"2026-07-07T16:00:{gen:02d}"))
        print(f"  gen={gen}: HTTP {code}, ok={resp.get('ok')}")
        assert_eq(code, 200, f"gen={gen} HTTP")
        assert_eq(resp.get("ok"), True, f"gen={gen} ok")

    saved = get(f"{bn}.json")
    assert_eq(saved["gen"], 500, "Final gen=500 wins")
    assert_eq(saved["runTag"], rt, "runTag preserved")

    cleanup(bn)
    return True


def test_legacy_backward_compat():
    """Legacy ckpts (no runTag) + new save (no runTag) → OK overwrite."""
    print("\n=== Backward compat: legacy no runTag + new no runTag → OK ===")
    bn = f"{TEST}legacy_compat"
    cleanup(bn)

    code1, resp1 = post(make_payload(
        bn, gen=100, score=0.5, bits=rnd_bits(10),
        run_tag="", saved_at="2026-07-07T17:00:00"))  # legacy: empty runTag
    assert_eq(code1, 200, "Legacy save HTTP")
    saved = get(f"{bn}.json")
    assert_eq(saved.get("runTag", ""), "", "Legacy on-disk runTag is empty")

    code2, resp2 = post(make_payload(
        bn, gen=500, score=0.7, bits=rnd_bits(20),
        run_tag="", saved_at="2026-07-07T17:01:00"))  # new: also empty
    assert_eq(code2, 200, "New legacy-style save HTTP")
    saved = get(f"{bn}.json")
    assert_eq(saved["gen"], 500, "Overwrite allowed (both no runTag)")

    cleanup(bn)
    return True


def test_atomic_write():
    """Multiple saves → no .tmp leftover."""
    print("\n=== Atomic write (no .tmp leftover) ===")
    bn = f"{TEST}atomic_check"
    cleanup(bn)
    rt = "run_atomic_check"

    for gen in [50, 100, 500]:
        code, resp = post(make_payload(
            bn, gen=gen, score=0.5, bits=rnd_bits(gen),
            run_tag=rt, saved_at=f"2026-07-07T18:00:{gen:02d}"))
        assert_eq(code, 200, f"gen={gen} save")

    tmps = list(CKPT_DIR.glob(f"{bn}.json.tmp"))
    if tmps:
        print(f"  FAIL: .tmp leftovers found: {[t.name for t in tmps]}")
        for t in tmps:
            try:
                t.unlink()
            except Exception:
                pass
        return False
    print(f"  PASS: no .tmp leftovers")

    cleanup(bn)
    return True


def main():
    global CKPT_DIR
    print("="*70)
    print("maze-web runTag anti-clobber verification (gotcha #34)")
    print("="*70)
    print(f"Target server: {CKPT_BASE}")
    print(f"Target dir:    {CKPT_DIR}")

    if not test_health():
        print("\nFAIL: server unreachable. Start it first:")
        print("  cd E:/doro/maze-web && python ckpt_server.py &")
        sys.exit(2)

    # Adjust CKPT_DIR from server's reported dir if it differs
    try:
        data = requests.get(URL_HEALTH, timeout=3).json()
        server_dir = Path(data.get("dir", str(CKPT_DIR)))
        if server_dir.exists():
            CKPT_DIR = server_dir
            print(f"  using server's dir: {CKPT_DIR}")
    except Exception:
        pass

    results = []
    for name, fn in [
        ("Panel (b) replay", test_panel_b_replay),
        ("Same-session overwrite", test_same_session_overwrite),
        ("Legacy backward compat", test_legacy_backward_compat),
        ("Atomic write", test_atomic_write),
    ]:
        try:
            ok = fn()
            results.append((name, ok))
        except AssertionError as e:
            print(f"  FAIL: {e}")
            results.append((name, False))
        except Exception as e:
            print(f"  ERROR: {e}")
            results.append((name, False))

    print("\n" + "="*70)
    print("SUMMARY")
    print("="*70)
    for name, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}: {name}")
    failed = sum(1 for _, ok in results if not ok)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()