# maze-web top-N × 30-seeds sweep 自动触发 — 维护文档

**创建于**: 2026-07-15
**触发者**: sko（口头: "等现在 sweep 跑完后，新建一个 sweep 拿平均分最高的几个 config 各跑 30 个不同 seed"）

## 链路概览

```
main sweep (sweep_2026_07_14_all_v71, pid 25216)
        ↓ OK ≥ 158
trigger.py (cron 5min 轮询)
        ↓ 选 top 3 by mean
        ↓ 写 runner script
spawn _sweep_runner_topN_30seeds_2026_07_16.py
        ↓ 90 configs (3 top × 30 seeds)
new sweep (sweep_2026_07_16_topN_30seeds)
```

## 文件

| 文件 | 作用 |
|---|---|
| `~/.hermes/scripts/maze_web_topn_30seeds_trigger.py` | 监控 + 触发 |
| `E:\doro\maze-web\_sweep_runner_topN_30seeds_TEMPLATE.py` | runner 模板（占位符） |
| `E:\doro\maze-web\_sweep_runner_topN_30seeds_2026_07_16.py` | 自动生成的 runner（触发后写） |
| `E:\doro\maze-web\sweep_2026_07_16_topN_30seeds\.triggered.flag` | 触发标记（防止重触发） |
| `E:\doro\maze-web\sweep_2026_07_16_topN_30seeds\dispatcher.log` | 新 sweep log |
| `E:\doro\maze-web\sweep_2026_07_16_topN_30seeds\results.ndjson` | 新 sweep 结果 |

## cron job

- **id**: `1b3f9bd0ec6e`
- **schedule**: every 5m
- **type**: no_agent=True (直接跑 python script)
- **deliver**: origin (QQ sko)
- **stdout**: "✅ trigger complete. New sweep: 3 configs × 30 seeds = 90 runs, ETA ~10.5h." → 自动 deliver 到 sko QQ

## 决策参数 (在 trigger.py 顶部常量)

```python
TOP_N = 3               # 取 mean top 3 (mask, maxFam) pairs
SEED_START = 0
SEED_END = 29           # 30 个全新 seed (跟 main sweep 的 0-3 不重叠)
POP = 200
GENS = 300              # 比 main sweep 的 500 短 (200×300 算约 6-7min/个)
GRID_W = 40
GRID_H = 60
```

## 修改常见项

### 想多跑几个 top config？
改 `trigger.py` 的 `TOP_N = 3` → `TOP_N = 5`。注: N=5 → 150 runs × 7min = 17.5h。

### 想换 seed 范围？
改 `SEED_START` / `SEED_END`。注: 跟 main sweep 重叠的 seed 不会被重复跑（runner 自动 skip done）。

### 想用不同 pop/gens？
改 `trigger.py` 顶部 `POP`/`GENS` 常量。注意 runner 模板里 `__POP__` `__GENS__` 占位符会被替换。

### 触发后想换 top config？
不能改 — 触发已完成、runner 已生成。如果想改，必须：
1. `rm E:/doro/maze-web/sweep_2026_07_16_topN_30seeds/.triggered.flag`（清 flag）
2. `taskkill` 当前新 runner
3. 改 trigger.py TOP_N
4. 删新 runner 脚本
5. 等下一次 cron tick（5min 内）会自动重触发

### 触发卡住怎么办？
1. 看 `E:/doro/maze-web/sweep_2026_07_16_topN_30seeds/trigger.log` (trigger 行为)
2. 看 `E:/doro/maze-web/sweep_2026_07_16_topN_30seeds/dispatcher.log` (新 sweep 行为)
3. 看 `E:/doro/maze-web/_sweep_runner_topN_30seeds_2026_07_16.py` 内容 (生成的 runner)
4. 看 cron job 状态: `hermes cronjob list`

## 预期时间线

- 现在 (00:15): cron 已设, 5min 轮询
- ~01:00-02:00: main sweep 跑完 (剩 4 个 configs, mf=16 慢)
- ~01:00-02:00: trigger 自动触发, 新 runner 生成 + spawn
- ~12:00 (明天): 新 sweep 跑完 (90 configs × 7min ≈ 10.5h)

## 已知约束

- Edge 必须保持运行 (CDP 9222 listening) — 关电脑就停了
- ckpt server (Python 313, port 8087) 必须保持运行
- 如果新 sweep 跑到一半崩了，runner 自动 resume (从 ndjson done set 跳已完成)

## 相关 cron

- `63e12c40c7db` (`maze-web-sweep-watch`): 旧 sweep 进度 watcher, main sweep 完成后停止有效
- `1b3f9bd0ec6e` (`maze-web-sweep-completion-trigger`): 本次新加的触发器