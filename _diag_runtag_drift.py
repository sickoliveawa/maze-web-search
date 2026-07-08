"""
Diagnose ckpt replay issues across sweep_2026_07_04:
- score mismatch (ckpt vs ndjson)
- savedAt drift (ckpt mtime - ndjson ts, hours)
- runTag presence (legacy ckpts have none)
"""
import json, os
from datetime import datetime
import urllib.request

# Load ndjson
nd_path = 'sweep_2026_07_04/results.ndjson'
nd = {}
with open(nd_path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        if r.get('status') != 'OK':
            continue
        key = (r['mask'], r['maxFam'], r['seed'])
        nd[key] = r

print(f'ndjson entries (status=OK): {len(nd)}')

# Load ckpt list
ckpts = json.loads(urllib.request.urlopen('http://127.0.0.1:8088/ckpt/list').read())
sweep_ckpts = [c for c in ckpts if c['name'].startswith('sweep_') and not c['name'].startswith('mini_')]
print(f'sweep ckpts (server): {len(sweep_ckpts)}')

print()
print(f'{"name":<42} {"ckpt_score":>10} {"nd_score":>10} {"drift_h":>9} {"gen":>5} {"runTag":>22}')
print('-' * 110)

mismatches_score = []
mismatches_drift = []
mismatches_no_match = []
runtag_yes = 0
runtag_no = 0

for c in sweep_ckpts:
    name = c['name'].replace('.json', '')
    parts = name.split('_')
    mask = parts[1]
    mf = int(parts[2].replace('mf', ''))
    seed = int(parts[3].replace('s', ''))
    key = (mask, mf, seed)
    if key not in nd:
        mismatches_no_match.append(name)
        continue

    nd_row = nd[key]
    ckpt_score = round(c.get('bestScore', 0), 4)
    nd_score = round(nd_row.get('best', 0), 4)

    # ndjson ts is ISO string
    nd_ts_dt = datetime.fromisoformat(nd_row['ts'])
    nd_ts_ms = int(nd_ts_dt.timestamp() * 1000)
    ckpt_mtime_ms = c.get('mtime', 0)
    drift_ms = ckpt_mtime_ms - nd_ts_ms
    drift_h = drift_ms / 3600000.0

    # ckpt runTag
    fp = f'ckpt/{c["name"]}'
    try:
        with open(fp) as f:
            ck = json.load(f)
        rt = ck.get('runTag', None)
    except Exception as e:
        rt = f'(err: {e})'

    if rt:
        rt_disp = rt[:20]
        runtag_yes += 1
    else:
        rt_disp = '(none=legacy)'
        runtag_no += 1

    score_diff = abs(ckpt_score - nd_score)
    score_flag = ''
    if score_diff > 0.001:
        score_flag = ' ⚠️SCORE'
        mismatches_score.append((name, ckpt_score, nd_score, score_diff))

    drift_flag = ''
    if abs(drift_h) > 1.0:
        drift_flag = ' ⚠️DRIFT'
        mismatches_drift.append((name, drift_h, ckpt_mtime_ms, nd_ts_ms))

    # only print interesting rows to keep output manageable
    show = (score_diff > 0.001) or (abs(drift_h) > 1.0) or (ckpt_score > 0.75)
    if show:
        print(f'{name:<42} {ckpt_score:>10.4f} {nd_score:>10.4f} {drift_h:>9.2f} {c.get("gen", 0):>5} {rt_disp:>22}{score_flag}{drift_flag}')

print()
print('=' * 60)
print(f'SUMMARY:')
print(f'  ckpts with runTag: {runtag_yes}')
print(f'  legacy ckpts (no runTag): {runtag_no}')
print(f'  score mismatches (>0.001): {len(mismatches_score)}')
print(f'  drift mismatches (>1h): {len(mismatches_drift)}')
print(f'  no ndjson match: {len(mismatches_no_match)}')

if mismatches_score:
    print()
    print('TOP SCORE MISMATCHES:')
    for m in sorted(mismatches_score, key=lambda x: -x[3])[:10]:
        print(f'  {m[0]:<42} ckpt={m[1]:.4f} nd={m[2]:.4f} diff={m[3]:.4f}')

if mismatches_drift:
    print()
    print('TOP DRIFT (>1h ckpt_mtime - ndjson_ts):')
    for m in sorted(mismatches_drift, key=lambda x: -abs(x[1]))[:10]:
        print(f'  {m[0]:<42} drift={m[1]:+.2f}h ckpt_mtime={datetime.fromtimestamp(m[2]/1000).isoformat()} nd_ts={datetime.fromtimestamp(m[3]/1000).isoformat()}')

if mismatches_no_match:
    print()
    print('NO NDJSON MATCH (ckpt but no ndjson row):')
    for m in mismatches_no_match[:10]:
        print(f'  {m}')