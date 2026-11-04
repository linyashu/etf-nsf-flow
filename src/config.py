"""全局配置：数据源、数据库、观察池。"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
WEB_DIR = ROOT / "web"

DATA_DIR.mkdir(exist_ok=True)

TUSHARE_TOKEN = os.getenv("TUSHARE_TOKEN", "")
if not TUSHARE_TOKEN:
    raise SystemExit(
        "缺少 TUSHARE_TOKEN 环境变量。请复制 .env.example 为 .env 并填入自己的 token。"
    )

DB = {
    "host": os.getenv("ETF_DB_HOST", "www.lys153.xyz"),
    "port": int(os.getenv("ETF_DB_PORT", "5433")),
    "dbname": os.getenv("ETF_DB_NAME", "timescaledb"),
    "user": os.getenv("ETF_DB_USER", "postgres"),
    "password": os.getenv("ETF_DB_PASSWORD", ""),
    "connect_timeout": 15,
}

# 宽基 ETF 观察池：国家队（中央汇金/证金/国新）的主要操作标的。
# 归类键统一到「跟踪指数」，便于把同指数不同管理人的份额合并统计。
BROAD_BASKET: dict[str, list[str]] = {
    "沪深300": ["510300.SH", "510310.SH", "510330.SH", "159919.SZ"],
    "上证50": ["510050.SH", "510710.SH"],
    "中证500": ["510500.SH", "159922.SZ", "512500.SH"],
    "中证1000": ["512100.SH", "159845.SZ", "560010.SH"],
    "科创50": ["588000.SH", "588080.SH"],
    "中证A500": ["512050.SH", "159352.SZ"],
    "创业板指": ["159915.SZ", "159949.SZ"],
    "上证180": ["510180.SH"],
    "中证2000": ["563300.SH"],
    "上证红利": ["510880.SH"],
}

# 用于「逆势托底」判定的基准指数
BENCH_INDEX = "000300.SH"
BENCH_NAME = "沪深300"

# 净申购额 = Δ份额(万份) × 净值(元) / 1e4  => 亿元
SHARE_UNIT_TO_YI = 1e4

HISTORY_DAYS = int(os.getenv("ETF_HISTORY_DAYS", "400"))
