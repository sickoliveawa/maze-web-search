#!/usr/bin/env python3
"""
verify_paper_numbers.py — verification method for maze-web paper v1.3.0

INDEPENDENT OF SOURCE CODE. Reads only:
  - sweep_*/results.ndjson  (sweep logs)
  - ckpt/*.json             (saved chromosomes + bestBreakdown)
  - paper/data/sweep_summary.json  (15-pattern benchmark, old 200x500 numbers)

Outputs canonical numbers the paper should reference:
  - paper/data/_verify_canonical.json   (machine-readable)
  - paper/data/_verify_canonical.md     (human-readable table)

Usage:
  python tools/verify_paper_numbers.py

Why this exists:
  Subagent rewrites paper §5/§6/§7 against NEW big_sweep data.
  This script is the SOLE source of truth — no source code reading.
  If a number in the paper disagrees with _verify_canonical.{json,md},
  the paper is wrong.
"""

import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from statistics import mean, median, stdev

ROOT = Path(__file__).resolve().parent.parent
OUT_JSON = ROOT / "paper" / "data" / "_verify_canonical.json"
OUT_MD = ROOT / "paper" / "data" / "_verify_canonical.md"

SWEEPS = {
    "big":  ROOT / "sweep_2026_07_08_big" / "results.ndjson",   # 500x2000, 5 seeds, partial n=2/5
    "v8":   ROOT / "sweep_2026_07_08"      / "results.ndjson",   # 100x100 small sanity
    "v4":   ROOT / "sweep_2026_07_04"      / "results.ndjson",   # 200x500, the 128-run headline
    "mini": ROOT / "mini_sweep_2026_07_07"  / "results.ndjson",   # per-template mini (50x110, 20x30)
}
CKPT_DIR = ROOT / "ckpt"
OLD_SUMMARY = ROOT / "paper" / "data" / "sweep_summary.json"  # pre-computed 15-pattern + 128-run summary


def load_ndjson(path):
    """Load ndjson, return list of dicts. Empty list if file missing."""
    if not path.exists():
        return []
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def load_ckpts():
    """Load all ckpt files. Return dict[filename] -> {bestScore, bestBreakdown, config, ...}."""
    if not CKPT_DIR.exists():
        return {}
    out = {}
    for p in sorted(CKPT_DIR.glob("*.json")):
        try:
            with open(p) as f:
                d = json.load(f)
            out[p.name] = {
                "bestScore": d.get("bestScore"),
                "bestBreakdown": d.get("bestBreakdown", {}),
                "config": d.get("config", {}),
                "gen": d.get("gen"),
                "savedAt": d.get("savedAt"),
                "runTag": d.get("runTag"),
                "type": d.get("type"),
            }
        except Exception as e:
            print(f"WARN: failed to load {p.name}: {e}", file=sys.stderr)
    return out


def aggregate_runs(rows, label):
    """Group ndjson rows by (mask, maxFam) and aggregate stats."""
    if not rows:
        return {}
    by_key = defaultdict(list)
    for r in rows:
        if r.get("status") != "OK":
            continue
        key = (r.get("mask", "?"), r.get("maxFam", "?"))
        by_key[key].append({
            "seed": r.get("seed"),
            "best": r.get("best"),
            "wall_sec": r.get("wall_sec"),
        })
    out = {
        "_label": label,
        "_n_total": len(rows),
        "_n_ok": sum(1 for r in rows if r.get("status") == "OK"),
        "_by_mask_fam": {},
        "top_runs": sorted(
            [{"mask": r.get("mask"), "maxFam": r.get("maxFam"), "seed": r.get("seed"), "best": r.get("best")}
             for r in rows if r.get("status") == "OK"],
            key=lambda x: -(x["best"] or 0),
        )[:10],
    }
    for (mask, mf), items in sorted(by_key.items()):
        scores = [i["best"] for i in items if i["best"] is not None]
        if not scores:
            continue
        out["_by_mask_fam"][f"{mask}|mf={mf}"] = {
            "n": len(scores),
            "mean": round(mean(scores), 4),
            "median": round(median(scores), 4),
            "std": round(stdev(scores), 4) if len(scores) > 1 else 0.0,
            "min": round(min(scores), 4),
            "max": round(max(scores), 4),
        }
    return out


def aggregate_by_mask(rows, label):
    """Group by mask only. For the 8 distance templates ablation."""
    if not rows:
        return {}
    by_mask = defaultdict(list)
    for r in rows:
        if r.get("status") != "OK":
            continue
        by_mask[r.get("mask", "?")].append(r.get("best"))
    return {
        "_label": f"{label} by mask",
        **{m: {"n": len(s), "mean": round(mean(s), 4), "max": round(max(s), 4)}
           for m, s in sorted(by_mask.items()) if s},
    }


def aggregate_by_mf(rows, label):
    """Group by maxFam only. For family cap ablation."""
    if not rows:
        return {}
    by_mf = defaultdict(list)
    for r in rows:
        if r.get("status") != "OK":
            continue
        by_mf[r.get("maxFam", "?")].append(r.get("best"))
    return {
        "_label": f"{label} by maxFam",
        **{str(mf): {"n": len(s), "mean": round(mean(s), 4), "max": round(max(s), 4)}
           for mf, s in sorted(by_mf.items()) if s},
    }


def load_old_summary():
    """Load pre-computed 15-pattern benchmark + 128-run summary from paper/data/sweep_summary.json"""
    if not OLD_SUMMARY.exists():
        return None
    with open(OLD_SUMMARY) as f:
        return json.load(f)


def main():
    print(f"=== verify_paper_numbers.py ===")
    print(f"ROOT: {ROOT}")
    print()

    canonical = {
        "_meta": {
            "generated_at": __import__("datetime").datetime.now().isoformat(),
            "purpose": "Canonical numbers for maze-web paper v1.3.0. Subagent must cross-check paper §5/§6/§7 against this file.",
            "source_files": [str(p.relative_to(ROOT)) for p in SWEEPS.values() if p.exists()] + ["ckpt/*.json", "paper/data/sweep_summary.json"],
            "constraint": "INDEPENDENT of src/ source code. Reads only ndjson + ckpt + paper/data/sweep_summary.json.",
        }
    }

    # 1. Load all sweeps
    all_rows = {}
    for label, path in SWEEPS.items():
        rows = load_ndjson(path)
        all_rows[label] = rows
        canonical[f"sweep_{label}"] = aggregate_runs(rows, label)
        canonical[f"sweep_{label}_bymask"] = aggregate_by_mask(rows, label)
        canonical[f"sweep_{label}_bymf"] = aggregate_by_mf(rows, label)
        print(f"sweep_{label}: {len(rows)} rows ({sum(1 for r in rows if r.get('status') == 'OK')} OK)")

    # 2. Load all ckpts
    ckpts = load_ckpts()
    canonical["ckpts"] = {
        "_count": len(ckpts),
        "big_sweep_ckpts": {
            name: v for name, v in ckpts.items() if name.startswith("big_")
        },
        "_example_top_score": max(
            ((name, v["bestScore"]) for name, v in ckpts.items() if v.get("bestScore")),
            key=lambda x: x[1], default=(None, None)
        ),
    }
    print(f"ckpts: {len(ckpts)} files")
    print()

    # 3. Load old summary (15-pattern + 128-run)
    old = load_old_summary()
    if old:
        canonical["old_128run_summary"] = {
            "_source": "paper/data/sweep_summary.json (200x500 sweep, 128 runs)",
            "total_runs": old.get("total_runs"),
            "ok_runs": old.get("ok_runs"),
            "top1_score": old.get("top1", {}).get("best"),
            "top1_config": {
                "mask": old.get("top1", {}).get("mask"),
                "maxFam": old.get("top1", {}).get("maxFam"),
                "seed": old.get("top1", {}).get("seed"),
            },
            "mf_mean": old.get("mf_mean"),
            "mask_mean": old.get("mask_mean"),
            "crosstab_mask_mf": old.get("crosstab_mask_mf"),
            "15pattern": old.get("15pattern"),
        }
        print(f"old 128-run summary: top1={old.get('top1', {}).get('best')}")
        if "15pattern" in old:
            p15 = old["15pattern"]
            print(f"15-pattern: true_mean={p15.get('true_mean')} pseudo_mean={p15.get('pseudo_mean')} gap={p15.get('gap')}")
    print()

    # 4. Key headline numbers — what the paper should cite
    canonical["headline_for_paper_v130"] = {
        "big_sweep_status": "PARTIAL: 2/5 runs complete (s444, s1111), s2222 in progress (~30% done), s3333/s6666 pending",
        "big_sweep_n_complete": sum(1 for r in all_rows["big"] if r.get("status") == "OK"),
        "big_sweep_top_score": max((r.get("best") for r in all_rows["big"] if r.get("status") == "OK"), default=None),
        "big_sweep_top_config": next(
            ({"mask": r.get("mask"), "maxFam": r.get("maxFam"), "seed": r.get("seed")}
             for r in sorted(all_rows["big"], key=lambda x: -(x.get("best") or 0))
             if r.get("status") == "OK"),
            None,
        ),
        "old_128run_top_score": old.get("top1", {}).get("best") if old else None,
        "old_128run_top_config": {
            "mask": old.get("top1", {}).get("mask"),
            "maxFam": old.get("top1", {}).get("maxFam"),
            "seed": old.get("top1", {}).get("seed"),
        } if old else None,
        "mf_ablation_old": {k: v.get("mean") for k, v in (old.get("mf_mean") or {}).items()},
        "mask_ablation_old": {k: v.get("mean") for k, v in (old.get("mask_mean") or {}).items()},
        "15pattern_mq": {
            "true_mean": old.get("15pattern", {}).get("true_mean") if old else None,
            "pseudo_mean": old.get("15pattern", {}).get("pseudo_mean") if old else None,
            "gap": old.get("15pattern", {}).get("gap") if old else None,
            "misclass_mq": old.get("15pattern", {}).get("misclass_mq") if old else None,
        },
        "15pattern_bellot": {
            "true_mean": old.get("15pattern", {}).get("bellot_true_mean") if old else None,
            "pseudo_mean": old.get("15pattern", {}).get("bellot_pseudo_mean") if old else None,
            "gap": old.get("15pattern", {}).get("bellot_gap") if old else None,
            "misclass": old.get("15pattern", {}).get("misclass_bellot") if old else None,
        },
        "chromosome_bits_per_family": 103,
        "chromosome_bits_breakdown": "1 (active) + 80 (cells mask) + 9 (birth) + 9 (survive) + 4 (priority) = 103 bits",
        "chromosome_total_bits_16fam": 1648,
        "search_space_per_family": "2^103 (single family); 2^1648 (full 16-family chromosome)",
        "single_family_BS_only": "2^18 (standard B/S string, no mask)",
    }

    # 5. Write outputs
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_JSON, "w") as f:
        json.dump(canonical, f, indent=2, default=str)
    print(f"\nWritten: {OUT_JSON.relative_to(ROOT)}")

    # Markdown summary
    md = ["# Canonical Numbers for Paper v1.3.0\n"]
    md.append(f"_Generated: {canonical['_meta']['generated_at']}_\n")
    md.append(f"_Sources: {', '.join(canonical['_meta']['source_files'])}_\n")
    md.append("\n## Headline Numbers\n")
    h = canonical["headline_for_paper_v130"]
    md.append(f"- **big_sweep status**: {h['big_sweep_status']}")
    md.append(f"- **big_sweep n_complete**: {h['big_sweep_n_complete']}")
    md.append(f"- **big_sweep top score**: {h['big_sweep_top_score']} (config: {h['big_sweep_top_config']})")
    md.append(f"- **old 128-run top score**: {h['old_128run_top_score']} (config: {h['old_128run_top_config']})")
    md.append(f"- **chromosome bits/family**: {h['chromosome_bits_per_family']} = {h['chromosome_bits_breakdown']}")
    md.append(f"- **search space**: {h['search_space_per_family']}")
    md.append("")

    md.append("## Family Cap Ablation (old 200x500 sweep)\n")
    for k, v in (h["mf_ablation_old"] or {}).items():
        md.append(f"- mf={k}: mean={v}")
    md.append("")

    md.append("## Mask Template Ablation (old 200x500 sweep)\n")
    for k, v in (h["mask_ablation_old"] or {}).items():
        md.append(f"- {k}: mean={v}")
    md.append("")

    md.append("## 15-Pattern Benchmark (maze_quality)\n")
    mq = h["15pattern_mq"]
    md.append(f"- true mazes: mean={mq['true_mean']}")
    md.append(f"- pseudo mazes: mean={mq['pseudo_mean']}")
    md.append(f"- gap: {mq['gap']}")
    md.append(f"- misclassifications: {mq['misclass_mq']}")
    md.append("")

    md.append("## 15-Pattern Benchmark (Bellot F, smoking gun)\n")
    bf = h["15pattern_bellot"]
    md.append(f"- true mazes: mean={bf['true_mean']}")
    md.append(f"- pseudo mazes: mean={bf['pseudo_mean']}")
    md.append(f"- gap: {bf['gap']} (negative = Bellot F underrates true mazes)")
    md.append(f"- misclassifications: {bf['misclass']}")
    md.append("")

    md.append("## big_sweep per-run\n")
    if all_rows["big"]:
        md.append("| seed | best | mask | maxFam | ts |")
        md.append("|------|------|------|--------|----|")
        for r in all_rows["big"]:
            if r.get("status") == "OK":
                md.append(f"| {r.get('seed')} | {r.get('best')} | {r.get('mask')} | {r.get('maxFam')} | {r.get('ts')} |")
        md.append("")

    md.append("## ckpt top scores\n")
    big_ckpts = canonical["ckpts"]["big_sweep_ckpts"]
    for name, v in big_ckpts.items():
        md.append(f"- {name}: bestScore={v['bestScore']}, gen={v['gen']}")
    md.append("")

    with open(OUT_MD, "w") as f:
        f.write("\n".join(md))
    print(f"Written: {OUT_MD.relative_to(ROOT)}")
    print()
    print("=== DONE. Subagent must cross-check paper against _verify_canonical.{json,md} ===")


if __name__ == "__main__":
    main()
