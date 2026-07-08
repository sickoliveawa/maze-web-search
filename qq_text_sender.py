# -*- coding: utf-8 -*-
"""Send plain text to a QQ user via QQ Bot Open Platform REST API.

Used by the sweep-progress cron job to deliver concise reports to sko.
Reads credentials from environment / ~/.hermes/.env at runtime (no
secrets written into this file).
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from pathlib import Path

import httpx

TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"


def _load_env_file(path: Path) -> dict:
    out: dict = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def _resolve_hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / "AppData" / "Local" / "hermes")


def load_credentials() -> tuple[str, str, str]:
    hermes_home = _resolve_hermes_home()
    kv = _load_env_file(hermes_home / ".env")
    app_id = os.environ.get("QQ_APP_ID") or kv.get("QQ_APP_ID", "")
    secret = (
        os.environ.get("QQ_CLIENT_SECRET")
        or os.environ.get("QQ_SECRET_FALLBACK")
        or kv.get("QQ_CLIENT_SECRET", "")
    )
    openid = os.environ.get("QQBOT_HOME_CHANNEL") or kv.get("QQBOT_HOME_CHANNEL", "")
    return app_id, secret, openid


async def get_access_token(client: httpx.AsyncClient, app_id: str, secret: str) -> str:
    resp = await client.post(TOKEN_URL, json={"appId": app_id, "clientSecret": secret})
    resp.raise_for_status()
    data = resp.json()
    token = data.get("access_token")
    if not token:
        raise RuntimeError(f"no access_token in response: {data}")
    return token


async def send_text(client: httpx.AsyncClient, headers: dict, openid: str, text: str) -> dict:
    msg_seq = int(time.time() * 1000) % 100000
    payload = {
        "msg_type": 0,            # text
        "content": text[:4000],   # QQ message length cap
        "msg_seq": msg_seq,
    }
    url = f"https://api.sgroup.qq.com/v2/users/{openid}/messages"
    resp = await client.post(url, json=payload, headers=headers)
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"send failed: {resp.status_code} {resp.text[:300]}")
    return resp.json()


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("text", help="text body to send")
    ap.add_argument("--openid", default=None, help="target openid (default: $QQBOT_HOME_CHANNEL)")
    args = ap.parse_args()

    app_id, secret, default_openid = load_credentials()
    openid = args.openid or default_openid
    if not (app_id and secret and openid):
        print("FAIL: missing credentials. Set QQ_APP_ID, QQ_CLIENT_SECRET, "
              "QQBOT_HOME_CHANNEL in ~/.hermes/.env or environment.", file=sys.stderr)
        return 3

    print(f"openid: {openid}")
    print(f"text length: {len(args.text)} chars")

    async with httpx.AsyncClient(timeout=30) as client:
        try:
            token = await get_access_token(client, app_id, secret)
            headers = {
                "Authorization": f"QQBot {token}",
                "Content-Type": "application/json",
            }
            resp = await send_text(client, headers, openid, args.text)
            print(f"[send] ok: message_id={resp.get('id', '?')[:60]}")
            return 0
        except Exception as exc:
            print(f"FAIL: {exc}", file=sys.stderr)
            return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))