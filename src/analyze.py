"""核心分析引擎：净申购、国家队信号评分、资金流指标.

为什么用「份额变化 × 净值」而不是成交额：
成交额只反映换手，无法区分申购与二级市场对倒/卖出。ETF 每日总份额是申赎的
直接结果，Δ份额>0 即净申购（真金白银进入基金、由管理人买成分股），
这正是国家队入场最可观测的痕迹。
"""
from __future__ import annotations

import math
from typing import Any

import pandas as pd

from .config import BENCH_INDEX, BENCH_NAME, BROAD_BASKET, SHARE_UNIT_TO_YI


def build_panel(share: pd.DataFrame, daily: pd.DataFrame, bench: pd.DataFrame) -> pd.DataFrame:
    """把份额、行情、基准对齐成「每只 ETF 每交易日」的宽表。

    输出列：
      trade_date, ts_code, group, fd_share, close, amount, pct_chg,
      d_share(万份), net_inflow(亿元), bench_pct
    """
    if share.empty or daily.empty:
        return pd.DataFrame()

    code2group = {c: g for g, codes in BROAD_BASKET.items() for c in codes}

    s = share.copy()
    s["trade_date"] = pd.to_datetime(s["trade_date"])
    d = daily.copy()
    d["trade_date"] = pd.to_datetime(d["trade_date"])

    panel = s.merge(d, on=["trade_date", "ts_code"], how="inner")
    panel = panel[panel["ts_code"].isin(code2group)].copy()
    panel["group"] = panel["ts_code"].map(code2group)

    panel = panel.sort_values(["ts_code", "trade_date"])
    # 份额用前值差；缺失日不连跨（避免长假把多日变化算成一天）
    panel["prev_date"] = panel.groupby("ts_code")["trade_date"].shift(1)
    panel["fd_share_prev"] = panel.groupby("ts_code")["fd_share"].shift(1)

    # 相邻记录间隔超过 5 个自然日则视为不连续，Δ记为 0
    gap = (panel["trade_date"] - panel["prev_date"]).dt.days
    panel["continuous"] = gap.le(5)

    delta = panel["fd_share"] - panel["fd_share_prev"]
    panel["d_share"] = delta.where(panel["continuous"], 0.0)

    # 净申购额(亿元) = Δ份额(万份) * 收盘价(元) / 1e4
    panel["net_inflow"] = (panel["d_share"] * panel["close"] / SHARE_UNIT_TO_YI).where(
        panel["continuous"], float("nan")
    )

    if not bench.empty:
        b = bench.copy()
        b["trade_date"] = pd.to_datetime(b["trade_date"])
        b["bench_pct"] = pd.to_numeric(b["pct_chg"], errors="coerce")
        panel = panel.merge(b[["trade_date", "bench_pct"]], on="trade_date", how="left")
    else:
        panel["bench_pct"] = float("nan")

    panel["amount"] = pd.to_numeric(panel["amount"], errors="coerce")
    panel["pct_chg"] = pd.to_numeric(panel["pct_chg"], errors="coerce")
    return panel.drop(columns=["prev_date", "fd_share_prev"])


def group_daily(panel: pd.DataFrame) -> pd.DataFrame:
    """按跟踪指数聚合每日净申购与规模。"""
    if panel.empty:
        return pd.DataFrame()
    g = panel.groupby(["trade_date", "group"], as_index=False).agg(
        net_inflow=("net_inflow", "sum"),
        total_share=("fd_share", "sum"),
        amount=("amount", "sum"),
        n_funds=("ts_code", "nunique"),
    )
    g["scale_yi"] = g["total_share"] * 1.0 / SHARE_UNIT_TO_YI  # 万份 -> 亿份 近似
    return g


def _clip(x: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, x))


def compute_signals(panel: pd.DataFrame, group_flow: pd.DataFrame, lookback: int = 5) -> dict[str, Any]:
    """计算各观察池的资金流指标与「国家队入场」综合评分。

    评分维度（0-100）：
      inflow_power  净申购强度：近 N 日累计净申购 / 近 60 日均值
      persistence   持续性：近 N 日净申购为正的天数占比
      breadth       广度：观察池内有净申购的指数占比
      contrarian    逆势度：净申购发生在基准下跌日的比例（托底特征）
    """
    if panel.empty:
        return {"as_of": None, "groups": [], "basket": {}, "series": []}

    last_date = panel["trade_date"].max()
    panel = panel[panel["net_inflow"].notna()]

    groups: list[dict] = []
    for grp, sub in panel.groupby("group"):
        sub = sub.sort_values("trade_date")
        recent = sub.tail(lookback)
        inflow_n = float(recent["net_inflow"].sum())
        inflow_1d = float(sub["net_inflow"].iloc[-1]) if len(sub) else 0.0

        hist = sub["net_inflow"].tail(60)
        base = float(hist.abs().mean()) if len(hist) else 0.0
        power = inflow_n / base if base > 0 else 0.0

        pos_days = int((recent["net_inflow"] > 0).sum())
        persistence = pos_days / len(recent) if len(recent) else 0.0

        down_days = recent[recent["bench_pct"] < 0]
        contrarian = (
            float((down_days["net_inflow"] > 0).sum() / len(down_days)) if len(down_days) else 0.0
        )

        # 组内多只 ETF：份额取「每只最新值」之和；规模(元)按各只最新份额×最新价求和
        last = sub.sort_values("trade_date").groupby("ts_code").last()
        first = sub.sort_values("trade_date").groupby("ts_code").first()
        scale = float(last["fd_share"].sum()) / SHARE_UNIT_TO_YI      # 亿份
        scale_yi = float((last["fd_share"] * last["close"]).sum()) / SHARE_UNIT_TO_YI  # 亿元
        prev_yi = float((first["fd_share"] * first["close"]).sum()) / SHARE_UNIT_TO_YI

        periods = {}
        for p in (1, 5, 10, 20):
            periods[f"inflow_{p}d"] = round(float(sub["net_inflow"].tail(p).sum()), 2)

        groups.append(
            {
                "group": grp,
                "codes": sorted(sub["ts_code"].unique().tolist()),
                "inflow_1d": round(inflow_1d, 2),
                "inflow_nd": round(inflow_n, 2),
                "power": round(power, 3),
                "persistence": round(persistence, 3),
                "contrarian": round(contrarian, 3),
                "scale_share": round(float(last["fd_share"].sum()) / SHARE_UNIT_TO_YI, 2),
                "scale_yi": round(scale_yi, 2),
                "scale_chg_yi": round(scale_yi - prev_yi, 2),
                "periods": periods,
                "n_down_days": int(len(down_days)),
            }
        )

    total_inflow = sum(g["inflow_nd"] for g in groups)
    gross_base = 0.0
    for grp, sub in panel.groupby("group"):
        h = sub["net_inflow"].tail(60)
        gross_base += float(h.abs().mean()) if len(h) else 0.0
    basket_power = total_inflow / gross_base if gross_base > 0 else 0.0

    pos_groups = sum(1 for g in groups if g["inflow_nd"] > 0)
    breadth = pos_groups / len(groups) if groups else 0.0

    down = panel[panel["bench_pct"] < 0]
    basket_contrarian = (
        float((down.groupby(["trade_date", "group"])["net_inflow"].sum() > 0).mean())
        if not down.empty
        else 0.0
    )

    inflow_power_score = _clip(math.tanh(basket_power) * 100)
    persistence_score = _clip(breadth * 100)
    contrarian_score = _clip(basket_contrarian * 100)

    composite = round(
        0.45 * inflow_power_score + 0.30 * persistence_score + 0.25 * contrarian_score, 1
    )

    if composite >= 75:
        regime, regime_note = "强烈入场", "宽基 ETF 份额同步放量，典型国家队托底特征"
    elif composite >= 55:
        regime, regime_note = "温和流入", "资金持续净申购，需观察能否延续"
    elif composite >= 35:
        regime, regime_note = "观望", "流入偏弱，未见明显合力"
    else:
        regime, regime_note = "净流出", "份额收缩，资金撤离"

    # 时间序列：观察池每日合计净申购 vs 基准涨跌
    ts = panel.groupby("trade_date", as_index=False).agg(
        net_inflow=("net_inflow", "sum"),
        bench_pct=("bench_pct", "first"),
    )
    ts["cum_inflow"] = ts["net_inflow"].fillna(0).cumsum()
    series = [
        {
            "date": r.trade_date.strftime("%Y-%m-%d"),
            "inflow": round(float(r.net_inflow), 2) if pd.notna(r.net_inflow) else 0.0,
            "cum": round(float(r.cum_inflow), 2),
            "bench": round(float(r.bench_pct), 2) if pd.notna(r.bench_pct) else None,
        }
        for r in ts.itertuples()
    ]

    return {
        "as_of": str(last_date.date() if hasattr(last_date, "date") else last_date),
        "lookback": lookback,
        "regime": regime,
        "regime_note": regime_note,
        "composite": composite,
        "scores": {
            "inflow_power": round(inflow_power_score, 1),
            "persistence": round(persistence_score, 1),
            "contrarian": round(contrarian_score, 1),
        },
        "basket": {
            "inflow_nd": round(total_inflow, 2),
            "inflow_latest": round(float(ts["net_inflow"].iloc[-1]), 2) if len(ts) else 0.0,
            "power": round(basket_power, 3),
            "breadth": round(breadth, 3),
            "contrarian": round(basket_contrarian, 3),
            "bench_name": BENCH_NAME,
            "bench_code": BENCH_INDEX,
        },
        "groups": sorted(groups, key=lambda x: x["inflow_nd"], reverse=True),
        "series": series,
    }


def fund_detail(panel: pd.DataFrame, lookback: int = 5, meta: dict | None = None) -> list[dict]:
    """单只 ETF 明细，用于看板表格。"""
    if panel.empty:
        return []
    meta = meta or {}
    periods = (1, 5, 10, 20)
    rows: list[dict] = []
    for code, sub in panel.groupby("ts_code"):
        sub = sub.sort_values("trade_date")
        recent = sub.tail(lookback)
        row = {
            "code": code,
            "name": meta.get(code, {}).get("name") or code,
            "manager": meta.get(code, {}).get("manager") or "—",
            "group": sub["group"].iloc[-1],
            "share": round(float(sub["fd_share"].iloc[-1]) / SHARE_UNIT_TO_YI, 2),
            "close": round(float(sub["close"].iloc[-1]), 4),
            "pct_chg": round(float(sub["pct_chg"].iloc[-1]), 2),
            "amount": round(float(sub["amount"].iloc[-1]) / 1e5, 2),
        }
        for p in periods:
            row[f"inflow_{p}d"] = round(float(sub["net_inflow"].tail(p).sum()), 2)
        row["inflow_nd"] = round(float(recent["net_inflow"].sum()), 2)
        rows.append(row)
    return sorted(rows, key=lambda x: x["inflow_nd"], reverse=True)
