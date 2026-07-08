# Canonical Numbers for Paper v1.3.0

_Generated: 2026-07-08T19:28:15.093277_

_Sources: sweep_2026_07_08_big\results.ndjson, sweep_2026_07_08\results.ndjson, sweep_2026_07_04\results.ndjson, mini_sweep_2026_07_07\results.ndjson, ckpt/*.json, paper/data/sweep_summary.json_


## Headline Numbers

- **big_sweep status**: PARTIAL: 2/5 runs complete (s444, s1111), s2222 in progress (~30% done), s3333/s6666 pending
- **big_sweep n_complete**: 2
- **big_sweep top score**: 0.8195 (config: {'mask': 'manhattan-2', 'maxFam': 8, 'seed': 444})
- **old 128-run top score**: 0.8233 (config: {'mask': 'manhattan-2', 'maxFam': 8, 'seed': 444})
- **chromosome bits/family**: 103 = 1 (active) + 80 (cells mask) + 9 (birth) + 9 (survive) + 4 (priority) = 103 bits
- **search space**: 2^103 (single family); 2^1648 (full 16-family chromosome)

## Family Cap Ablation (old 200x500 sweep)

- mf=2: mean=0.6688204333333334
- mf=4: mean=0.63818253125
- mf=8: mean=0.6306086875
- mf=1: mean=0.6983712857142857

## Mask Template Ablation (old 200x500 sweep)

- chebyshev-1: mean=0.7726130625000001
- chebyshev-2: mean=0.7437999375
- chebyshev-3: mean=0.7764362499999999
- chebyshev-4: mean=0.157268
- manhattan-1: mean=0.42053149999999995
- manhattan-2: mean=0.7776793125
- manhattan-3: mean=0.7714063125
- manhattan-4: mean=0.7517354375

## 15-Pattern Benchmark (maze_quality)

- true mazes: mean=0.711
- pseudo mazes: mean=0.0
- gap: 0.711
- misclassifications: 0/9 (maze_quality阈值 = 0.5)

## 15-Pattern Benchmark (Bellot F, smoking gun)

- true mazes: mean=100.882
- pseudo mazes: mean=292.205
- gap: -191.323 (negative = Bellot F underrates true mazes)
- misclassifications: 4/9 pseudo (Spiral F=11.85 + 3× F=0 patterns ranked as most maze-like)

## big_sweep per-run

| seed | best | mask | maxFam | ts |
|------|------|------|--------|----|
| 444 | 0.8195 | manhattan-2 | 8 | 2026-07-08T18:17:40.602143 |
| 1111 | 0.8138 | manhattan-2 | 8 | 2026-07-08T19:05:11.476552 |

## ckpt top scores

- big_manhattan-2_mf8_s1111.json: bestScore=0.8138289451599121, gen=2000
- big_manhattan-2_mf8_s2222.json: bestScore=0.7664309740066528, gen=850
- big_manhattan-2_mf8_s444.json: bestScore=0.8195065855979919, gen=2000
