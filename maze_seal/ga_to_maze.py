"""ga_to_maze.py — Convert a CA grid (raw GA output) into a "maze" with 2 entries.

Pipeline (v19, 2026-07-16):
  1. find_border_corridors: collect all 0-cells on the 4 edges.
  2. greedy_wall_removal: iteratively remove 1-cells with exactly 2 0-neighbors
     (4-conn) to maximize the top-2 sum of BFS distances from entries. This
     lengthens the longest path between any 2 entries.
  3. Restrict entries to the largest 0-component (defensive: A↔B must be connected).
  4. BFS 2-pass to find entry pair (entry_a, entry_b) along the diameter.
     Gate: if BFS(A, B) < 5, fall back to a Manhattan-first search.
  5. Path-aware seal:
     - BFS path from entry_a to entry_b on the post-greedy grid.
     - Close border 0-cells that are NOT on the path.
     - Border cells ON the path stay open (linear snake case).

Note: a previous "Step 6" that closed off-path junctions (≥3 0-neighbors) was
REMOVED in v19. It closed ~10% of raw corridors in dense grids, which the user
found too aggressive. Multi-branched / cyclic structure is allowed by spec.
If you want a cleaner (more tree-like) maze, call `close_off_path_junctions()`
separately as a post-processing step.

Spec (user-confirmed, 2026-07-16):
  - 2 entries on border (A, B)
  - A↔B has a connected path
  - Dead-ends (1 0-neighbor) and unreachable sub-grids kept as visual richness
  - Multi-branched structure (cycles, junctions) is OK and expected

Convention: 0 = corridor, 1 = wall. 4-conn adjacency. BFS treats 1-cell as wall.
"""
import collections
import json
import os
from typing import Any

import numpy as np


# ============================================================================
# Core algorithm
# ============================================================================

def find_border_corridors(g: np.ndarray) -> list[tuple[int, int]]:
    """All border (4-edge) 0-cells. Sorted, deduped."""
    H, W = g.shape
    out = []
    for x in range(W):
        if g[0, x] == 0: out.append((0, x))
        if g[H-1, x] == 0: out.append((H-1, x))
    for y in range(H):
        if g[y, 0] == 0: out.append((y, 0))
        if g[y, W-1] == 0: out.append((y, W-1))
    return sorted(set(out))


def bfs_0(g: np.ndarray, src: tuple[int, int]) -> np.ndarray:
    """BFS over 0-cells (treating 1 as wall). Returns dist grid (-1 = unreachable)."""
    H, W = g.shape
    dist = -np.ones_like(g, dtype=np.int32)
    dist[src] = 0
    q = collections.deque([src])
    while q:
        y, x = q.popleft()
        d = dist[y, x]
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < H and 0 <= nx < W and g[ny, nx] == 0 and dist[ny, nx] == -1:
                dist[ny, nx] = d + 1
                q.append((ny, nx))
    return dist


def bfs_0_with_parent(g: np.ndarray, src: tuple[int, int]) -> tuple[np.ndarray, dict]:
    """BFS over 0-cells with parent dict. Returns (dist, parent)."""
    H, W = g.shape
    dist = -np.ones_like(g, dtype=np.int32)
    parent: dict[tuple[int, int], tuple[int, int]] = {}
    dist[src] = 0
    q = collections.deque([src])
    while q:
        y, x = q.popleft()
        d = dist[y, x]
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < H and 0 <= nx < W and g[ny, nx] == 0 and dist[ny, nx] == -1:
                dist[ny, nx] = d + 1
                parent[(ny, nx)] = (y, x)
                q.append((ny, nx))
    return dist, parent


def _verify_entries_connected(g, entry_a, entry_b, border_0):
    """Check: if all border_0 cells except entry_a, entry_b are closed, can A still reach B?

    Returns True if entry_a and entry_b are still in the same 0-component after the seal.
    """
    if entry_a is None or entry_b is None:
        return False
    maze = g.copy()
    for e in border_0:
        if e != entry_a and e != entry_b:
            maze[e] = 1
    dist_a, _ = bfs_0_with_parent(maze, entry_a)
    return dist_a[entry_b[0], entry_b[1]] >= 0


def _find_connected_entry_pair(g, border_0):
    """Return the FARTHEST connected entry pair (a, b) in border_0.

    Among all (a, b) pairs that survive the seal (A can still reach B in the
    post-seal maze), return the one with the largest BFS distance from a to b
    in the post-seal grid — i.e. the pair that yields the longest path.

    For large border_0 (e.g. chebyshev-4 with high mf), the O(N²) BFS is too
    slow; fall back to the first-found connected pair in that case.
    """
    if len(border_0) < 2:
        return None
    if len(border_0) > 30:
        # First-found (cheap)
        for a in border_0:
            for b in border_0:
                if b == a:
                    continue
                if _verify_entries_connected(g, a, b, border_0):
                    return (a, b)
        return None
    # Farthest-found (more expensive, but better paths)
    best = None
    best_dist = -1
    for a in border_0:
        dist_a, _ = bfs_0_with_parent(g, a)
        for b in border_0:
            if b == a:
                continue
            if dist_a[b[0], b[1]] < 0:
                continue
            if not _verify_entries_connected(g, a, b, border_0):
                continue
            maze_tmp = g.copy()
            for e in border_0:
                if e != a and e != b:
                    maze_tmp[e] = 1
            d_post, _ = bfs_0_with_parent(maze_tmp, a)
            dpb = d_post[b[0], b[1]]
            # Use Manhattan distance (geometric) as primary, BFS post-seal as tiebreaker.
            # Reason: BFS distance can be tiny (e.g. 2) for geometrically-near pairs like
            # (59,2)↔(59,3) that share a 1-cell wall separator, but we want to prefer
            # geometrically-far entries for a proper "maze" (long winding path).
            manhattan = abs(a[0] - b[0]) + abs(a[1] - b[1])
            score = manhattan * 1000 + dpb  # prioritize Manhattan, then BFS
            if score > best_dist:
                best_dist = score
                best = (a, b)
    return best


def all_dists(g: np.ndarray, entries: list[tuple[int, int]]) -> list[np.ndarray]:
    """BFS from every entry. dists[i] = dist grid from entry i."""
    return [bfs_0(g, e) for e in entries]


def top2_sum_max(g: np.ndarray, dists: list[np.ndarray], border_0: list[tuple[int, int]] | None = None) -> tuple[int, tuple[int, int] | None, int, int]:
    """For each 0-cell, find top-1 + top-2 of finite dists (excluding self-dist at border cells).
    Return (max_score, cell, top1, top2).
    - Interior cells: top-1 + top-2 from any 2 entries (the cell is the meeting point).
    - Border cells: top-1 + top-2 from any 2 OTHER entries (cell is one endpoint, but path
      goes from entry_X through cell to entry_Y, so still 2 entries other than cell).
    """
    H, W = g.shape
    N = len(dists)
    best = -1
    best_cell = None
    best_top1 = -1
    best_top2 = -1
    border_set = set(border_0) if border_0 is not None else set()

    for y in range(H):
        for x in range(W):
            if g[y, x] != 0:
                continue
            # Exclude c itself (dist to itself = 0, useless for path length)
            finite = [dists[i][y, x] for i in range(N)
                      if dists[i][y, x] >= 0 and border_0[i] != (y, x)]
            if len(finite) < 2:
                continue
            finite.sort(reverse=True)
            s = int(finite[0]) + int(finite[1])
            if s > best:
                best = s
                best_cell = (y, x)
                best_top1 = int(finite[0])
                best_top2 = int(finite[1])
    return best, best_cell, best_top1, best_top2


def find_wall_candidates(g: np.ndarray) -> list[tuple[tuple[int, int], list[tuple[int, int]]]]:
    """1-cell with exactly 2 0-neighbors (4-conn, ANY 2 — not requiring opposite)."""
    H, W = g.shape
    cands = []
    for y in range(H):
        for x in range(W):
            if g[y, x] != 1:
                continue
            zns = []
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and g[ny, nx] == 0:
                    zns.append((ny, nx))
            if len(zns) == 2:
                cands.append(((y, x), zns))
    return cands


def try_remove_wall(g: np.ndarray, w: tuple[int, int], border_0: list[tuple[int, int]]) -> int:
    """Flip 1→0 at w, re-BFS from all border 0-cells (INCLUDING new w which becomes entry), return new top-2 sum max."""
    H, W = g.shape
    g_test = g.copy()
    g_test[w] = 0
    # After flip, the wall cell is now a 0-cell on border (since w had 0-neighbors on both sides)
    # We must include it in BFS sources (it might be a new entry on its own edge)
    # But w is INSIDE grid (it's a wall, not on border), so it's not a border 0-cell.
    # However, removing the wall can make OTHER cells reachable that weren't before.
    # So we just re-BFS from the original entries; new cells reachable from those entries.
    # The wall cell itself becomes reachable, but doesn't need to be a BFS source.
    dists = all_dists(g_test, border_0)
    score, _, _, _ = top2_sum_max(g_test, dists, border_0)
    return score


def greedy_wall_removal(g: np.ndarray, border_0: list[tuple[int, int]], max_iters: int = 50, verbose: bool = False) -> tuple[np.ndarray, int, list]:
    """Greedy loop: each iter, try every wall candidate, keep the one with max new top-2 sum.
    Returns (final_g, final_score, history)."""
    g_work = g.copy()
    dists = all_dists(g_work, border_0)
    score, cell, t1, t2 = top2_sum_max(g_work, dists, border_0)
    if verbose:
        print(f"  [init] top-2 sum = {score} at {cell} (top1={t1}, top2={t2})")

    history = [("init", score, None)]
    for it in range(1, max_iters + 1):
        cands = find_wall_candidates(g_work)
        if not cands:
            if verbose:
                print(f"  [iter {it}] no wall candidates, stop")
            break

        best_w = None
        best_s = score
        best_c = None
        for w, _ in cands:
            s = try_remove_wall(g_work, w, border_0)
            if s > best_s:
                best_s = s
                best_w = w
        if best_w is None:
            if verbose:
                print(f"  [iter {it}] no wall improves (best stays {score}), stop")
            break

        g_work[best_w] = 0
        # Update dists incrementally — re-BFS all (correctness over speed)
        dists = all_dists(g_work, border_0)
        score, cell, t1, t2 = top2_sum_max(g_work, dists, border_0)
        history.append((f"iter{it}", score, best_w))
        if verbose:
            print(f"  [iter {it}] removed {best_w} → score = {score} at {cell}")

    return g_work, score, history


def seal_to_maze(
    g: np.ndarray,
    border_0: list[tuple[int, int]],
) -> tuple[np.ndarray, tuple[int, int], tuple[int, int], list[tuple[int, int]]]:
    """After greedy, seal the grid into a maze with 2 entries and a long A→B path.

    Returns (maze_g, entry_a, entry_b, path).

    The entry pair is selected by BFS 2-pass (diameter approximation); the
    A→B path is the BFS parent tree path. Border cells on the path are kept
    open; off-path border cells are closed.

    Off-path junctions (0-cells with ≥3 0-neighbors) are NOT closed here —
    see `close_off_path_junctions()` if you want that as a separate pass.
    """
    H, W = g.shape
    # Step 1: find best entry pair via BFS 2-pass (correct, not top-2 sum)
    # Start with any border cell, BFS to find farthest, then BFS from that.
    start = border_0[0]
    d1 = bfs_0(g, start)
    d1_finite = [(int(d1[y, x]), y, x) for y in range(H) for x in range(W)
                 if d1[y, x] >= 0 and g[y, x] == 0]
    if not d1_finite:
        raise ValueError("no 0-cells reachable from start entry")
    d1_finite.sort(reverse=True)
    # Furthest cell from start
    far_cell = (d1_finite[0][1], d1_finite[0][2])
    d2, parent = bfs_0_with_parent(g, far_cell)
    d2_finite = [(int(d2[y, x]), y, x) for y in range(H) for x in range(W)
                 if d2[y, x] >= 0 and g[y, x] == 0]
    if not d2_finite:
        raise ValueError("no 0-cells reachable from far_cell")
    d2_finite.sort(reverse=True)
    end_cell = (d2_finite[0][1], d2_finite[0][2])
    # Compute candidates for both entries (use full border_0, sorted by reachability)
    candidates = sorted(border_0, key=lambda e: d2[e[0], e[1]], reverse=True)
    # end_cell is on border (farthest from far_cell) — should be a border entry
    if end_cell not in set(border_0):
        entry_b = candidates[0]
    else:
        entry_b = end_cell
    # entry_a = far_cell; but if far_cell not on border, find nearest border entry
    if far_cell not in set(border_0):
        candidates_a = sorted(border_0, key=lambda e: d1[e[0], e[1]], reverse=True)
        entry_a = candidates_a[0]
    else:
        entry_a = far_cell
    # If entry_a == entry_b (degenerate), pick second-farthest by d2
    if entry_a == entry_b:
        if len(candidates) > 1:
            entry_a = candidates[1]
        else:
            raise ValueError(f"only 1 entry, can't form a 2-entry maze")

    # BFS path-length gate: if A↔B BFS distance is very small (< 5), the BFS 2-pass
    # picked two geometrically-near border cells (e.g. (59,2)↔(59,3) on a 60-cell-tall
    # grid whose BFS distance is 1-2 due to a shared 1-cell wall separator) and the
    # resulting maze has no useful long path. Use farthest-pair search (geometric-first)
    # in that case. Threshold 5: 1x9 snake (BFS=8) is OK, but adjacent cells (BFS=1-2) fire.
    dist_check, _ = bfs_0_with_parent(g, entry_a)
    a_to_b = int(dist_check[entry_b[0], entry_b[1]])
    if 0 <= a_to_b < 5:
        better = _find_connected_entry_pair(g, border_0)
        if better is not None:
            entry_a, entry_b = better

    # Step 2+3 (reordered): BFS path FIRST, then close non-path border 0-cells.
    # Old order closed all non-A/B border cells FIRST, then computed path. That
    # broke linear snakes (e.g. 1x9 corridor on top row): path was the snake itself,
    # closing intermediate border cells severed A↔B, fallback picked (0,0)↔(0,1) →
    # 2-cell maze. Spec says: "May have ≥2 border 0-cells if all are on the single
    # path" — so only close border 0-cells that are NOT on the path.
    dist_a, parent = bfs_0_with_parent(g, entry_a)
    if dist_a[entry_b] < 0:
        # entry_a, entry_b are not in the same 0-component in `g` itself. Rare.
        # Fallback: re-find farthest pair on g (the post-greedy grid passed in as `g`).
        d1g, _ = bfs_0_with_parent(g, border_0[0])
        d1g_finite = [(int(d1g[y, x]), y, x) for y in range(H) for x in range(W)
                      if d1g[y, x] >= 0 and g[y, x] == 0]
        d1g_finite.sort(reverse=True)
        new_far = (d1g_finite[0][1], d1g_finite[0][2])
        d2g, _ = bfs_0_with_parent(g, new_far)
        d2g_finite = [(int(d2g[y, x]), y, x) for y in range(H) for x in range(W)
                      if d2g[y, x] >= 0 and g[y, x] == 0]
        d2g_finite.sort(reverse=True)
        new_end = (d2g_finite[0][1], d2g_finite[0][2])
        if new_far not in set(border_0):
            cand = sorted(border_0, key=lambda e: d1g[e[0], e[1]], reverse=True)
            new_far = cand[0]
        if new_end not in set(border_0):
            cand = sorted(border_0, key=lambda e: d2g[e[0], e[1]], reverse=True)
            new_end = cand[0]
        if new_far == new_end:
            cand_all = sorted(border_0, key=lambda e: d2g[e[0], e[1]], reverse=True)
            if len(cand_all) > 1:
                new_far = cand_all[1]
        entry_a, entry_b = new_far, new_end
        dist_a, parent = bfs_0_with_parent(g, entry_a)
        if dist_a[entry_b] < 0:
            raise ValueError(f"entry_a={entry_a} and entry_b={entry_b} not in same 0-component (fallback failed)")

    # Reconstruct path in `g` (post-greedy grid, BEFORE border sealing)
    path = []
    cur = entry_b
    while cur != entry_a:
        path.append(cur)
        cur = parent[cur]
    path.append(entry_a)
    path.reverse()
    path_set = set(path)

    # Now seal: copy g, close border 0-cells that are NOT on the path.
    # Border cells on the path stay 0 — they're the only way to traverse the
    # maze (linear snake case) or intermediate path nodes.
    maze = g.copy()
    new_border_0 = find_border_corridors(maze)
    for e in new_border_0:
        if e != entry_a and e != entry_b and e not in path_set:
            maze[e] = 1

    # Verify A can still reach B (should always be true since we kept path cells).
    dist_a_post, _ = bfs_0_with_parent(maze, entry_a)
    if dist_a_post[entry_b] < 0:
        # Should never happen — path is preserved. But guard anyway.
        raise ValueError(f"entry_a={entry_a} and entry_b={entry_b} disconnected after path-aware seal")

    # NOTE: A previous "Step 6" (closing off-path junctions, ≥3 0-neighbors) was
    # REMOVED in v19. It closed ~10% of raw corridors in dense grids.
    # Spec does NOT require this — multi-branched / cyclic structure is allowed.
    # If you want a cleaner maze, call `close_off_path_junctions(maze, path)` separately.

    return maze, entry_a, entry_b, path


def ga_to_maze(g: np.ndarray, verbose: bool = False) -> dict[str, Any]:
    """Full pipeline. Returns dict with keys: ok, maze, entry_a, entry_b, path, history, reason."""
    border_0 = find_border_corridors(g)
    if len(border_0) < 2:
        return {
            "ok": False,
            "reason": f"need >= 2 entries, got {len(border_0)}",
            "border_0": border_0,
            "maze": g.copy(),
            "entry_a": None,
            "entry_b": None,
            "path": [],
            "history": [],
        }

    if verbose:
        print(f"[ga_to_maze] grid {g.shape}, 0-cells={int((g==0).sum())}, entries={len(border_0)}")

    g_opt, score, cell_t12 = greedy_wall_removal(g, border_0, verbose=verbose)
    score_after, cell, t1, t2 = top2_sum_max(g_opt, all_dists(g_opt, border_0), border_0)

    # Defensive: if border_0 cells belong to multiple 0-components, restrict to the
    # largest one (the one containing the most border cells). Without this, seal_to_maze
    # may pick A and B from DIFFERENT components, which can never be connected.
    if len(border_0) >= 2:
        reachable_set = set()
        dist0, _ = bfs_0_with_parent(g_opt, border_0[0])
        H, W = g_opt.shape
        for yy in range(H):
            for xx in range(W):
                if dist0[yy, xx] >= 0 and g_opt[yy, xx] == 0:
                    reachable_set.add((yy, xx))
        border_in_main = [b for b in border_0 if b in reachable_set]
        if len(border_in_main) >= 2:
            border_0 = border_in_main
        else:
            # border_0[0] is in a tiny component; try others
            for b0 in border_0:
                dist0, _ = bfs_0_with_parent(g_opt, b0)
                reach = set((yy, xx) for yy in range(H) for xx in range(W)
                            if dist0[yy, xx] >= 0 and g_opt[yy, xx] == 0)
                cand = [b for b in border_0 if b in reach]
                if len(cand) >= 2:
                    border_0 = cand
                    break

    maze, entry_a, entry_b, path = seal_to_maze(g_opt, border_0)

    if verbose:
        print(f"[ga_to_maze] final: entries=({entry_a},{entry_b}), path_len={len(path)}, "
              f"corridor_cells={int((maze==0).sum())}, "
              f"dead_ends={count_dead_ends(maze)}")

    return {
        "ok": True,
        "reason": "",
        "border_0": border_0,
        "maze": maze,
        "entry_a": entry_a,
        "entry_b": entry_b,
        "path": path,
        "score": score_after,
        "meeting_cell": cell,
        "top1": t1,
        "top2": t2,
        "history": cell_t12,  # alias; rename to "iter_history" for clarity
    }


# ============================================================================
# Diagnostic helpers
# ============================================================================

def count_dead_ends(g: np.ndarray) -> int:
    """Count 0-cells with exactly 1 0-neighbor (4-conn)."""
    H, W = g.shape
    n = 0
    for y in range(H):
        for x in range(W):
            if g[y, x] != 0:
                continue
            nz = 0
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and g[ny, nx] == 0:
                    nz += 1
            if nz == 1:
                n += 1
    return n


def count_junctions(g: np.ndarray) -> int:
    """Count 0-cells with >= 3 0-neighbors (4-conn)."""
    H, W = g.shape
    n = 0
    for y in range(H):
        for x in range(W):
            if g[y, x] != 0:
                continue
            nz = 0
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and g[ny, nx] == 0:
                    nz += 1
            if nz >= 3:
                n += 1
    return n


def close_off_path_junctions(
    maze: np.ndarray,
    path: list[tuple[int, int]],
    min_degree: int = 3,
) -> int:
    """Optional cleanup: close 0-cells NOT on the path with ≥min_degree 0-neighbors.

    This was the old "Step 6" in the pipeline (v18 and earlier). It was removed
    from the default `ga_to_maze()` flow because it closes ~10% of raw corridors
    in dense grids, which the user found too aggressive. Multi-branched / cyclic
    structure is allowed by spec and often desired for visual richness.

    Call this separately if you want a cleaner (more "tree-like") maze.

    Args:
        maze: 0/1 grid, will be modified in-place.
        path: list of (y, x) cells on the A→B path (these are preserved).
        min_degree: minimum number of 0-neighbors to trigger closing.
                    Default 3 (any junction). Use 4 for stricter (only 4-way
                    intersections).

    Returns:
        Number of cells closed.
    """
    H, W = maze.shape
    path_set = set(path)
    closed = 0
    for yy in range(H):
        for xx in range(W):
            if maze[yy, xx] != 0 or (yy, xx) in path_set:
                continue
            nz = 0
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = yy + dy, xx + dx
                if 0 <= ny < H and 0 <= nx < W and maze[ny, nx] == 0:
                    nz += 1
            if nz >= min_degree:
                maze[yy, xx] = 1
                closed += 1
    return closed


def verify_maze(g: np.ndarray, entry_a: tuple[int, int], entry_b: tuple[int, int]) -> dict[str, Any]:
    """Sanity checks on a sealed maze. Returns metrics matching the actual spec:

    - a_reaches_b: is there a path from A to B?
    - path_length: BFS distance from A to B (cells)
    - border_0_total / on_path / off_path: how many border 0-cells remain,
      how many are on the A→B path, how many are not
    - reachable_from_a: size of A's connected component (sub-grids are NOT counted)
    - junctions_on_path / off_path: cells with ≥3 0-neighbors (info only)
    """
    H, W = g.shape
    dist, parent = bfs_0_with_parent(g, entry_a)
    reachable = int(((dist >= 0) & (g == 0)).sum())
    total_0 = int((g == 0).sum())

    # Reconstruct A→B path
    if dist[entry_b[0], entry_b[1]] < 0:
        path_len = 0
        path_set: set = set()
    else:
        path = []
        cur = entry_b
        while cur != entry_a:
            path.append(cur)
            cur = parent[cur]
        path.append(entry_a)
        path_len = len(path)
        path_set = set(path)

    border_0 = find_border_corridors(g)
    border_on_path = [b for b in border_0 if b in path_set]
    border_off_path = [b for b in border_0 if b not in path_set]

    # Count junctions (informational, not a pass/fail criterion)
    junctions_on_path = 0
    junctions_off_path = 0
    for y in range(H):
        for x in range(W):
            if g[y, x] != 0:
                continue
            nz = sum(1 for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1))
                     if 0 <= y + dy < H and 0 <= x + dx < W and g[y + dy, x + dx] == 0)
            if nz >= 3:
                if (y, x) in path_set:
                    junctions_on_path += 1
                else:
                    junctions_off_path += 1

    return {
        "total_0_cells": total_0,
        "reachable_from_a": reachable,
        "sub_grid_cells": total_0 - reachable,
        "a_reaches_b": dist[entry_b[0], entry_b[1]] >= 0,
        "path_length": path_len,
        "border_0_total": len(border_0),
        "border_0_on_path": len(border_on_path),
        "border_0_off_path": len(border_off_path),
        "junctions_on_path": junctions_on_path,
        "junctions_off_path": junctions_off_path,
    }
