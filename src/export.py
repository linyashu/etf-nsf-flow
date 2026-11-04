"""导出看板数据：从数据库读到分析结果，写成 web/data.json。"""
from __future__ import annotations

import json
from datetime import datetime

import pandas as pd

from . import analyze, db
from .config import BENCH_INDEX, BROAD_BASKET, DATA_DIR, WEB_DIR

OUT = DATA_DIR / "dashboard.json"
WEB_OUT = WEB_DIR / "data.json"


def build(lookback: int = 5, window: int = 60) -> dict:
    conn = db.connect()
    codes = [c for cs in BROAD_BASKET.values() for c in cs]
    share, daily = db.load_basket(conn, codes)
    bench = db.load_index(conn, BENCH_INDEX)
    meta = db.load_names(conn, codes)
    cov = db.coverage(conn)
    conn.close()

    panel = analyze.build_panel(share, daily, bench)
    if panel.empty:
        raise SystemExit("数据库无数据，请先运行 python -m src.fetch")

    gflow = analyze.group_daily(panel)
    signals = analyze.compute_signals(panel, gflow, lookback=lookback)
    details = analyze.fund_detail(panel, lookback=lookback, meta=meta)

    # 分组时间序列（用于堆叠面积图）
    series_groups: dict[str, list] = {}
    if not gflow.empty:
        gflow = gflow.sort_values("trade_date")
        cutoff = gflow["trade_date"].max() - pd.Timedelta(days=window)
        gflow = gflow[gflow["trade_date"] >= cutoff]
        for grp, sub in gflow.groupby("group"):
            series_groups[grp] = [
                {
                    "date": r.trade_date.strftime("%Y-%m-%d"),
                    "inflow": round(float(r.net_inflow), 2) if pd.notna(r.net_inflow) else 0.0,
                }
                for r in sub.itertuples()
            ]

    # 每只 ETF 的份额走势（用于详情图）
    per_fund: dict[str, list] = {}
    cutoff = panel["trade_date"].max() - pd.Timedelta(days=window)
    for code, sub in panel[panel["trade_date"] >= cutoff].groupby("ts_code"):
        sub = sub.sort_values("trade_date")
        per_fund[code] = [
            {
                "date": r.trade_date.strftime("%Y-%m-%d"),
                "share": round(float(r.fd_share) / 1e4, 2),
                "inflow": round(float(r.net_inflow), 2) if pd.notna(r.net_inflow) else 0.0,
                "close": round(float(r.close), 4),
            }
            for r in sub.itertuples()
        ]

    names = {}
    if not daily.empty:
        names = {c: c for c in daily["ts_code"].unique()}

    return {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "data_coverage": cov,
        "signals": signals,
        "funds": details,
        "series_groups": series_groups,
        "series_fund": per_fund,
        "basket_map": BROAD_BASKET,
    }


def write(payload: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    WEB_DIR.mkdir(exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    OUT.write_text(text, encoding="utf-8")
    WEB_OUT.write_text(text, encoding="utf-8")
    print(f"写入 {OUT} ({len(text)/1024:.1f} KB)")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--lookback", type=int, default=5)
    ap.add_argument("--window", type=int, default=60)
    a = ap.parse_args()
    write(build(lookback=a.lookback, window=a.window))
