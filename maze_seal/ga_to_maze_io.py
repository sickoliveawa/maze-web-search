"""ga_to_maze_io.py — save/load grid as .grid.txt (compact text format)

Format (lines):
  # comment lines (any line starting with #)
  W H
  [H lines of W chars: 0=corridor, 1=wall]

Optional header lines (commented) for metadata, e.g.:
  # source: ckpt=sweep07_14_all_v71_manhattan-2_mf2_s3
  # created: 2026-07-16T...
  # entry_a: (23, 0)
  # entry_b: (0, 23)
"""
import os
import numpy as np


def save_grid_txt(g: np.ndarray, path: str, meta: dict | None = None) -> None:
    """Save 0/1 grid to .grid.txt. Meta dict items become # key: value comments."""
    H, W = g.shape
    lines = [f"# convention: 0=corridor, 1=wall, 4-conn", f"# shape: {W}x{H}"]
    if meta:
        for k, v in meta.items():
            lines.append(f"# {k}: {v}")
    lines.append(f"{W} {H}")
    # Encode each row as a string of 0/1
    for y in range(H):
        row = "".join("1" if g[y, x] else "0" for x in range(W))
        lines.append(row)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def load_grid_txt(path: str) -> np.ndarray:
    """Load .grid.txt → 0/1 uint8 array (H, W)."""
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    rows = []
    w = h = None
    for line in raw.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if w is None:
            parts = s.split()
            if len(parts) == 2:
                w, h = int(parts[0]), int(parts[1])
                continue
        # Grid row: 0/1 string
        if all(c in "01" for c in s) and len(s) > 1:
            rows.append([1 if c == "1" else 0 for c in s])
    if w is None or h is None:
        raise ValueError(f"No W H header found in {path}")
    if len(rows) != h:
        raise ValueError(f"{path}: expected {h} rows, got {len(rows)}")
    arr = np.array(rows, dtype=np.uint8)
    if arr.shape != (h, w):
        raise ValueError(f"{path}: expected shape ({h}, {w}), got {arr.shape}")
    return arr


def grid_meta(path: str) -> dict[str, str]:
    """Read only the # comment metadata from a .grid.txt file."""
    meta = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s.startswith("#"):
                continue
            # Skip convention/shape lines
            content = s.lstrip("# ").strip()
            if content.startswith("convention:") or content.startswith("shape:"):
                continue
            if ":" in content:
                k, v = content.split(":", 1)
                meta[k.strip()] = v.strip()
    return meta


