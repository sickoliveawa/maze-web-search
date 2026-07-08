#!/usr/bin/env python3
"""
ckpt_server.py — Local HTTP server for training checkpoints.

Port: 8088 (separate from dashboard 8087)
Dir:  E:\\doro\\maze-web\\ckpt\\   (auto-created on startup)

Endpoints:
  POST  /ckpt/save    body: {config, gen, bestScore, bestChromBits, bestBreakdown, savedAt}
                      → write .json to ckpt/  (filename = config.slug + gen + hash)
                      → return {ok, name, file, size}
  GET   /ckpt/list    → [{name, gen, bestScore, savedAt, size, file}, ...] sorted by savedAt desc
  GET   /ckpt/load?name=<name>     → full JSON content
  DELETE /ckpt/delete?name=<name>  → remove file (optional, for cleanup)

CORS: open to localhost:8087 (dashboard origin).
"""

import hashlib
import http.server
import json
import os
import re
import socketserver
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).parent.resolve()
CKPT_DIR = ROOT / "ckpt"
PORT = 8088
ALLOWED_ORIGIN = "*"  # 允许任意 localhost 端口 (8080 dashboard / 8087 alt)

CKPT_DIR.mkdir(exist_ok=True)


# -------- helpers --------

def _filename_for_config(config: dict) -> str:
    """Return a deterministic filename for a config.

    Same config (same batchName) → same filename → server overwrites on save.
    User controls uniqueness via batchName; server only sanitizes the name.
    """
    name = config.get("batchName") or ""
    # sanitize: only alphanumeric, underscore, hyphen, dot
    name = re.sub(r"[^A-Za-z0-9_\-.]", "_", name)
    if not name:
        name = "default"
    # cap length to keep filename manageable
    if len(name) > 80:
        name = name[:80]
    return f"{name}.json"


def _bits_hash(bits) -> str:
    """6-char short hash of chromosome bits."""
    if not bits:
        return "000000"
    data = json.dumps(bits, separators=(",", ":")).encode("utf-8")
    return hashlib.sha1(data).hexdigest()[:6]


def _safe_name(name: str) -> bool:
    """Reject path traversal / weird filenames."""
    if not name or ".." in name or "/" in name or "\\" in name:
        return False
    return name.endswith(".json")


def _cors_headers():
    return {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }


# -------- handler --------

class CkptHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Quieter logs (timestamp + message only)
        sys.stderr.write(f"[ckpt] {time.strftime('%H:%M:%S')} {fmt % args}\n")

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        for k, v in _cors_headers().items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, code, path, content_type="application/json"):
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        self.send_response(code)
        for k, v in _cors_headers().items():
            self.send_header(k, v)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return None
        return self.rfile.read(length)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in _cors_headers().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/ckpt/list":
            return self._handle_list()
        if url.path == "/ckpt/load":
            qs = parse_qs(url.query)
            name = (qs.get("name") or [""])[0]
            if not _safe_name(name):
                return self._send_json(400, {"ok": False, "error": "bad name"})
            return self._send_file(200, CKPT_DIR / name)
        if url.path == "/ckpt/health":
            return self._send_json(200, {"ok": True, "dir": str(CKPT_DIR), "files": len(list(CKPT_DIR.glob("*.json")))})
        return self._send_json(404, {"ok": False, "error": "no such endpoint"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/ckpt/save":
            return self._send_json(404, {"ok": False, "error": "no such endpoint"})
        body = self._read_body()
        if not body:
            return self._send_json(400, {"ok": False, "error": "empty body"})
        try:
            rec = json.loads(body.decode("utf-8"))
        except Exception as e:
            return self._send_json(400, {"ok": False, "error": f"bad json: {e}"})

        # validate required fields
        for k in ("config", "gen", "bestScore", "bestChromBits"):
            if k not in rec:
                return self._send_json(400, {"ok": False, "error": f"missing field: {k}"})
        if not isinstance(rec["bestChromBits"], list) or len(rec["bestChromBits"]) != 1648:
            return self._send_json(400, {"ok": False, "error": f"bestChromBits must be 1648-element list, got {len(rec.get('bestChromBits', [])) if isinstance(rec.get('bestChromBits'), list) else 'wrong type'}"})

        config = rec["config"]
        gen = int(rec["gen"])
        # ✅ FIX (sko 07-03): 用 batchName 当文件名 — 同 config 覆盖写
        #   防止 ckpt/ 目录塞 100 个文件, 玩家用 batchName 区分训练
        filename = _filename_for_config(config)
        target = CKPT_DIR / filename
        # ✅ FIX (sko 07-07): runTag 反 clobber 保护 — 拒绝跨 run 静默覆盖
        #   panel (b) race-overwrite 真实成因 = re-dispatch 用同 batchName → server 接受 → 文件被新 bits 覆盖
        #   fix: 客户端每 session 生成 runTag, server 检查; runTag 不同 → REJECT + 返回 existing runTag 供用户判断
        incoming_run_tag = rec.get("runTag") or ""
        existing_run_tag = None
        if target.exists():
            try:
                existing = json.loads(target.read_text(encoding="utf-8"))
                existing_run_tag = existing.get("runTag") or ""
            except Exception:
                existing_run_tag = None  # corrupted file, allow overwrite
        # 反 clobber 检查: 双方都有 runTag 且不匹配 → REJECT
        if (incoming_run_tag and existing_run_tag
                and incoming_run_tag != existing_run_tag):
            return self._send_json(409, {
                "ok": False,
                "error": "runTag mismatch — refusing to clobber a different run's ckpt",
                "existing_runTag": existing_run_tag,
                "incoming_runTag": incoming_run_tag,
                "advice": "Either (a) use a different batchName, (b) delete the old ckpt manually, "
                          "or (c) re-load the ckpt with the same runTag if resuming the same run.",
            })
        # ✅ 直接覆盖 (无 counter) — 用户明确要求"覆盖写防止数据过多"
        #   同一 batchName 多次 save → 只保留最后一次的 grid/score/gen
        #   (前提: runTag 匹配, 否则上面 REJECT 拦下)

        # stamp savedAt if missing
        rec.setdefault("savedAt", time.strftime("%Y-%m-%dT%H:%M:%S"))
        rec["schemaVersion"] = 1
        rec["type"] = "chrom_bits"
        rec["filename"] = target.name
        rec["runTag"] = incoming_run_tag or existing_run_tag or ""  # ensure field present

        # ✅ FIX (sko 07-07): atomic write — write to .tmp, then os.replace (NTFS 原子 since Vista)
        #   防止 process kill / page.reload / 断电 中途把 target 写成截断 JSON
        try:
            tmp_path = target.with_suffix('.json.tmp')
            tmp_path.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp_path, target)
        except Exception as e:
            # Cleanup tmp on error
            try:
                if tmp_path.exists(): tmp_path.unlink()
            except Exception: pass
            return self._send_json(500, {"ok": False, "error": f"write failed: {e}"})

        size = target.stat().st_size
        print(f"[ckpt] saved (overwrite) {target.name}  ({size} bytes, gen={gen}, score={rec['bestScore']:.4f})")
        return self._send_json(200, {
            "ok": True,
            "name": target.name,
            "file": str(target),
            "size": size,
            "overwrote": True,
        })

    def do_DELETE(self):
        url = urlparse(self.path)
        if url.path != "/ckpt/delete":
            return self._send_json(404, {"ok": False, "error": "no such endpoint"})
        qs = parse_qs(url.query)
        name = (qs.get("name") or [""])[0]
        if not _safe_name(name):
            return self._send_json(400, {"ok": False, "error": "bad name"})
        target = CKPT_DIR / name
        if not target.exists():
            return self._send_json(404, {"ok": False, "error": "not found"})
        target.unlink()
        return self._send_json(200, {"ok": True})

    def _handle_list(self):
        files = []
        for p in sorted(CKPT_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                rec = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                rec = {}
            files.append({
                "name": p.name,
                "size": p.stat().st_size,
                "savedAt": rec.get("savedAt") or time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(p.stat().st_mtime)),
                "mtime": int(p.stat().st_mtime * 1000),
                "gen": rec.get("gen"),
                "bestScore": rec.get("bestScore"),
                "config": rec.get("config", {}),
                "hasBreakdown": bool(rec.get("bestBreakdown")),
            })
        return self._send_json(200, files)


def main():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), CkptHandler) as httpd:
        print(f"[ckpt] server listening on http://127.0.0.1:{PORT}")
        print(f"[ckpt] ckpt dir: {CKPT_DIR}")
        print(f"[ckpt] CORS origin: {ALLOWED_ORIGIN}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[ckpt] shutting down.")


if __name__ == "__main__":
    main()
