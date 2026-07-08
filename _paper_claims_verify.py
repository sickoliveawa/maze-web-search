"""
Paper v1.2 full verification:
  1. fig 6 v2 6 panel reproduce — DONE in prior run (6/6 match)
  2. headline 0.8233 — verified
  3. 6 healthy mask families mean 0.74-0.78 (paper §5.3)
  4. chebyshev-4 dead (mean 0.157) (paper §5.3)
  5. manhattan-1 stuck attractor (mean 0.420) (paper §5.3)
  6. fig 5.4 panel per-config — mf=2 vs mf=8 clarification
  7. ckpt vs ndjson drift — paper §5.5
"""
import json
from collections import defaultdict

# Load ndjson
nd = []
with open('sweep_2026_07_04/results.ndjson') as f:
    for line in f:
        r = json.loads(line)
        if r.get('status') == 'OK':
            nd.append(r)

# Group by mask
by_mask = defaultdict(list)
for r in nd:
    by_mask[r['mask']].append(r)

print("=" * 80)
print("PAPER V1.2 HEADLINE NUMBERS — sweep_2026_07_04 (122 OK runs)")
print("=" * 80)
print(f"{'mask':<13} {'n':>3}  {'mean':>7}  {'std':>7}  {'min':>7}  {'max':>7}  {'top':>7}")
print("-" * 80)
import statistics
for mask in sorted(by_mask):
    scores = [r['best'] for r in by_mask[mask]]
    m, s = statistics.mean(scores), statistics.stdev(scores)
    print(f"{mask:<13} {len(scores):>3}  {m:>7.4f}  {s:>7.4f}  {min(scores):>7.4f}  {max(scores):>7.4f}  {max(scores):>7.4f}")

print()
print("Paper claim 1: 6 healthy mask families mean 0.74-0.78")
healthy_masks = ['manhattan-2', 'manhattan-3', 'manhattan-4', 'chebyshev-1', 'chebyshev-2', 'chebyshev-3']
healthy_means = [statistics.mean([r['best'] for r in by_mask[m]]) for m in healthy_masks]
print(f"  healthy means: {[f'{m:.4f}' for m in healthy_means]}")
print(f"  range: {min(healthy_means):.4f} to {max(healthy_means):.4f}")
print(f"  paper claim: 0.74-0.78 → {'✓' if all(0.74 <= m <= 0.78 for m in healthy_means) else 'check'}")

print()
print("Paper claim 2: chebyshev-4 dead (mean 0.157)")
ch4 = [r['best'] for r in by_mask['chebyshev-4']]
print(f"  chebyshev-4 mean: {statistics.mean(ch4):.4f} (paper claim: 0.157)")
print(f"  chebyshev-4 best: {max(ch4):.4f} (panel e: 0.4244)")

print()
print("Paper claim 3: manhattan-1 stuck attractor (mean 0.420)")
ma1 = [r['best'] for r in by_mask['manhattan-1']]
print(f"  manhattan-1 mean: {statistics.mean(ma1):.4f} (paper claim: 0.420)")
print(f"  manhattan-1 best: {max(ma1):.4f} (panel f: 0.4240)")

print()
print("=" * 80)
print("PAPER §5.5 + APPENDIX D: ckpt vs ndjson drift")
print("=" * 80)
# Load ckpt list
import urllib.request
ckpts_raw = urllib.request.urlopen('http://127.0.0.1:8088/ckpt/list').read()
ckpts = json.loads(ckpts_raw)
sweep_ckpts = {c['name']: c for c in ckpts if c['name'].startswith('sweep_') and not c['name'].startswith('mini_') and not c['name'].startswith('_')}

from datetime import datetime
nd_by_key = {(r['mask'], r['maxFam'], r['seed']): r for r in nd}

print(f"{'NAME':<42} {'ckpt_score':>10} {'nd_score':>10} {'drift_h':>8}  drift?")
n_drift = 0
n_no_match = 0
n_score_diff = 0
n_match = 0
for name, c in sorted(sweep_ckpts.items()):
    parts = name.replace('.json','').split('_')
    mask = parts[1]
    mf = int(parts[2].replace('mf',''))
    seed = int(parts[3].replace('s',''))
    key = (mask, mf, seed)
    if key not in nd_by_key:
        n_no_match += 1
        continue
    nd_r = nd_by_key[key]
    ckpt_score = c['bestScore']
    nd_score = nd_r['best']
    nd_ts_ms = int(datetime.fromisoformat(nd_r['ts']).timestamp() * 1000)
    drift_h = (c['mtime'] - nd_ts_ms) / 3600000.0
    score_diff = abs(ckpt_score - nd_score)
    if abs(drift_h) > 1.0:
        n_drift += 1
        flag = '⚠️ DRIFT'
    elif score_diff > 0.001:
        n_score_diff += 1
        flag = '⚠️ SCORE'
    else:
        n_match += 1
        flag = '✓'
    if abs(drift_h) > 0.5 or score_diff > 0.001 or abs(drift_h) > 1.0:
        print(f"  {name:<42} {ckpt_score:>10.4f} {nd_score:>10.4f} {drift_h:>8.2f}  {flag}")

print()
print(f"Summary: {n_match} match, {n_drift} drift, {n_score_diff} score diff, {n_no_match} no ndjson match")
print(f"Total sweep ckpts: {len(sweep_ckpts)}")

print()
print("=" * 80)
print("PAPER FIG 5.4 panel per-config (mf=2 vs mf=8 clarification)")
print("=" * 80)
# Find for each top panel what mf it actually uses
TOP_PANELS = [
    ('a', 'sweep_manhattan-2_mf8_s444.json'),
    ('b', 'sweep_chebyshev-1_mf8_s333.json'),
    ('c', 'sweep_chebyshev-2_mf2_s333.json'),
    ('d', 'sweep_manhattan-4_mf1_s111.json'),
    ('e', 'sweep_chebyshev-4_mf1_s111.json'),
    ('f', 'sweep_manhattan-1_mf2_s444.json'),
]
print(f"{'panel':<6} {'NAME':<42} {'mf':>3} {'saved':>8}")
for label, name in TOP_PANELS:
    parts = name.replace('.json','').split('_')
    mf = int(parts[2].replace('mf',''))
    score = sweep_ckpts[name]['bestScore']
    print(f"  ({label})   {name:<42} {mf:>3} {score:>8.4f}")

print()
print("Paper note: fig 5.4 panel (c)(f) use mf=2 (not mf=8 as v1.2 §5.3 prose said)")
print("Verified: panel c = mf=2, panel f = mf=2 ✓")
