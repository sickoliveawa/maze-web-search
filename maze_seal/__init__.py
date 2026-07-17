"""maze_seal — Convert raw CA grids into 2-entry mazes with a long A→B path.

Public API (the only things external code should import):

    from maze_seal import ga_to_maze, verify_maze
    from maze_seal import seal_to_maze, close_off_path_junctions  # advanced
    from maze_seal import save_grid_txt, load_grid_txt, grid_meta
    from maze_seal import count_dead_ends, count_junctions

Submodules (advanced use only — most users should import from `maze_seal` directly):
    maze_seal._ga_to_maze    — algorithm internals (BFS, greedy, seal)
    maze_seal._ga_to_maze_io — .grid.txt I/O format
"""
from ._ga_to_maze import (
    ga_to_maze,
    seal_to_maze,
    verify_maze,
    count_dead_ends,
    count_junctions,
    close_off_path_junctions,
)
from ._ga_to_maze_io import (
    save_grid_txt,
    load_grid_txt,
    grid_meta,
)

__all__ = [
    # Core
    "ga_to_maze",
    "seal_to_maze",
    "verify_maze",
    # Optional post-processing
    "close_off_path_junctions",
    # Diagnostic helpers
    "count_dead_ends",
    "count_junctions",
    # I/O
    "save_grid_txt",
    "load_grid_txt",
    "grid_meta",
]
