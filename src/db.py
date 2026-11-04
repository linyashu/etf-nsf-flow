"""TimescaleDB 存储层：ETF 份额、行情、基础信息。"""
from __future__ import annotations

from typing import Iterable, Sequence

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

from .config import DB

SCHEMA = """
CREATE TABLE IF NOT EXISTS etf_basic (
    ts_code      TEXT PRIMARY KEY,
    name         TEXT,
    fund_type    TEXT,
    management   TEXT,
    list_date    TEXT,
    m_fee        NUMERIC,
    benchmark    TEXT,
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS etf_daily (
    trade_date   DATE        NOT NULL,
    ts_code      TEXT        NOT NULL,
    close        NUMERIC,
    pre_close    NUMERIC,
    pct_chg      NUMERIC,
    vol          NUMERIC,
    amount       NUMERIC,
    PRIMARY KEY (trade_date, ts_code)
);

CREATE TABLE IF NOT EXISTS etf_share (
    trade_date   DATE        NOT NULL,
    ts_code      TEXT        NOT NULL,
    fd_share     NUMERIC,
    PRIMARY KEY (trade_date, ts_code)
);

CREATE TABLE IF NOT EXISTS index_daily (
    trade_date   DATE        NOT NULL,
    ts_code      TEXT        NOT NULL,
    close        NUMERIC,
    pct_chg      NUMERIC,
    PRIMARY KEY (trade_date, ts_code)
);

SELECT create_hypertable('etf_daily', 'trade_date', if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('etf_share', 'trade_date', if_not_exists => TRUE, migrate_data => TRUE);
SELECT create_hypertable('index_daily', 'trade_date', if_not_exists => TRUE, migrate_data => TRUE);
"""


def connect():
    return psycopg2.connect(**DB)


def init_schema(conn) -> None:
    with conn.cursor() as cur:
        for stmt in [s.strip() for s in SCHEMA.split(";") if s.strip()]:
            cur.execute(stmt)
    conn.commit()


def _upsert(conn, table: str, cols: Sequence[str], rows: Iterable[tuple], conflict: str) -> int:
    rows = list(rows)
    if not rows:
        return 0
    updates = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols if c not in conflict.split(","))
    sql = (
        f"INSERT INTO {table} ({', '.join(cols)}) VALUES %s "
        f"ON CONFLICT ({conflict}) DO UPDATE SET {updates}"
    )
    with conn.cursor() as cur:
        execute_values(cur, sql, rows, page_size=1000)
    conn.commit()
    return len(rows)


def save_basic(conn, df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    cols = ["ts_code", "name", "fund_type", "management", "list_date", "m_fee", "benchmark"]
    for c in cols:
        if c not in df.columns:
            df[c] = None
    sub = df[cols].astype(object).where(pd.notna(df[cols]), None)
    return _upsert(conn, "etf_basic", cols, sub.itertuples(index=False, name=None), "ts_code")


def save_daily(conn, df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    d = df.copy()
    d["trade_date"] = pd.to_datetime(d["trade_date"], format="%Y%m%d").dt.date
    cols = ["trade_date", "ts_code", "close", "pre_close", "pct_chg", "vol", "amount"]
    for c in cols:
        if c not in d.columns:
            d[c] = None
    sub = d[cols]
    sub = sub.astype(object).where(pd.notna(sub), None)
    return _upsert(conn, "etf_daily", cols, sub.itertuples(index=False, name=None), "trade_date,ts_code")


def save_share(conn, df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    d = df.copy()
    d["trade_date"] = pd.to_datetime(d["trade_date"], format="%Y%m%d").dt.date
    cols = ["trade_date", "ts_code", "fd_share"]
    sub = d[cols].astype(object).where(pd.notna(d[cols]), None)
    return _upsert(conn, "etf_share", cols, sub.itertuples(index=False, name=None), "trade_date,ts_code")


def save_index(conn, df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    d = df.copy()
    d["trade_date"] = pd.to_datetime(d["trade_date"], format="%Y%m%d").dt.date
    cols = ["trade_date", "ts_code", "close", "pct_chg"]
    for c in cols:
        if c not in d.columns:
            d[c] = None
    sub = d[cols].astype(object).where(pd.notna(d[cols]), None)
    return _upsert(conn, "index_daily", cols, sub.itertuples(index=False, name=None), "trade_date,ts_code")


def load_basket(conn, codes: Sequence[str]) -> tuple[pd.DataFrame, pd.DataFrame]:
    """读取观察池的份额与行情，按 trade_date 升序返回。"""
    sql_share = "SELECT trade_date, ts_code, fd_share FROM etf_share WHERE ts_code = ANY(%s) ORDER BY trade_date"
    sql_daily = (
        "SELECT trade_date, ts_code, close, pct_chg, amount FROM etf_daily "
        "WHERE ts_code = ANY(%s) ORDER BY trade_date"
    )
    with conn.cursor() as cur:
        cur.execute(sql_share, (list(codes),))
        share = pd.DataFrame(cur.fetchall(), columns=["trade_date", "ts_code", "fd_share"])
        cur.execute(sql_daily, (list(codes),))
        daily = pd.DataFrame(cur.fetchall(), columns=["trade_date", "ts_code", "close", "pct_chg", "amount"])
    for df in (share, daily):
        if not df.empty:
            for c in ("fd_share", "close", "pct_chg", "amount"):
                if c in df:
                    df[c] = pd.to_numeric(df[c], errors="coerce")
    return share, daily


def load_names(conn, codes: Sequence[str]) -> dict[str, dict]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT ts_code, name, management FROM etf_basic WHERE ts_code = ANY(%s)", (list(codes),)
        )
        return {r[0]: {"name": r[1], "manager": r[2]} for r in cur.fetchall()}


def load_index(conn, code: str) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT trade_date, close, pct_chg FROM index_daily WHERE ts_code=%s ORDER BY trade_date",
            (code,),
        )
        df = pd.DataFrame(cur.fetchall(), columns=["trade_date", "close", "pct_chg"])
    if not df.empty:
        df["close"] = pd.to_numeric(df["close"], errors="coerce")
        df["pct_chg"] = pd.to_numeric(df["pct_chg"], errors="coerce")
    return df


def coverage(conn) -> dict:
    with conn.cursor() as cur:
        out = {}
        for t in ("etf_share", "etf_daily", "index_daily"):
            cur.execute(f"SELECT COUNT(*), MIN(trade_date), MAX(trade_date) FROM {t}")
            n, lo, hi = cur.fetchone()
            out[t] = {"rows": n, "from": str(lo), "to": str(hi)}
        cur.execute("SELECT COUNT(*) FROM etf_basic")
        out["etf_basic"] = {"rows": cur.fetchone()[0]}
    return out
