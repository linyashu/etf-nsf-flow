#!/usr/bin/env python3
"""导出 JSON 并起本地预览服务。

数据采集已统一到 mac-mini 上的 stock_wiki 每日流水线
（launchd com.stockwiki.ingest-daily，任务 etf_share / etf_daily / etf_basic），
本脚本只负责从库里读出并导出，不再自带采集逻辑。

用法:
    python run.py             # 导出并起服务
    python run.py --no-serve  # 只导出
"""
from __future__ import annotations

import argparse
import functools
import http.server
import socketserver
import time
from pathlib import Path

from src import export

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"


def refresh() -> None:
    t0 = time.time()
    export.write(export.build())
    print(f"导出完成 {time.time()-t0:.1f}s（数据由 mac-mini 的 stock_wiki 流水线采集）")


def serve(port: int) -> None:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(WEB))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
        print(f"看板地址: http://127.0.0.1:{port}/index.html")
        print("按 Ctrl+C 停止")
        httpd.serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-serve", action="store_true")
    ap.add_argument("--port", type=int, default=8899)
    a = ap.parse_args()

    refresh()
    if not a.no_serve:
        serve(a.port)
