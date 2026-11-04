/**
 * 本地库存储层（TimescaleDB / PostgreSQL）。
 *
 * 复用项目里 Python 管道建好的同名字段表，两边共享同一份历史：
 *   etf_share(trade_date, ts_code, fd_share)
 *   etf_daily(trade_date, ts_code, close, pre_close, pct_chg, vol, amount)
 *   index_daily(trade_date, ts_code, close, pct_chg)
 *   etf_basic(ts_code, name, fund_type, management, list_date, m_fee, benchmark)
 *
 * 设计原则：库是加速层，不是唯一真相。连不上就返回 null，由上层降级到实时模式，
 * 不能让看板因为数据库挂了而打不开。
 */

let pgmod = null

async function loadPg() {
  if (pgmod) return pgmod
  const pg = await import('pg')
  pgmod = pg.default ?? pg
  return pgmod
}

export class Store {
  constructor(config) {
    this.config = config
    this.pool = null
    this.lastError = null
  }

  /** 惰性建连接池。失败时返回 false，不抛。 */
  async open() {
    if (this.pool) return true
    try {
      const { Pool } = await loadPg()
      this.pool = new Pool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        max: 4,
        connectionTimeoutMillis: 8000,
        idleTimeoutMillis: 30000,
      })
      await this.pool.query('select 1')
      this.lastError = null
      return true
    } catch (err) {
      this.lastError = String(err?.message || err).slice(0, 160)
      this.pool = null
      return false
    }
  }

  async close() {
    if (this.pool) {
      try {
        await this.pool.end()
      } catch {
        /* 忽略关闭异常 */
      }
      this.pool = null
    }
  }

  /** 建表（幂等）。与 Python 管道的 DDL 保持一致，避免两套结构。 */
  async ensureSchema() {
    if (!this.pool) return false
    const ddl = `
CREATE TABLE IF NOT EXISTS etf_basic (
  ts_code TEXT PRIMARY KEY, name TEXT, fund_type TEXT, management TEXT,
  list_date TEXT, m_fee NUMERIC, benchmark TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS etf_daily (
  trade_date DATE NOT NULL, ts_code TEXT NOT NULL, close NUMERIC, pre_close NUMERIC,
  pct_chg NUMERIC, vol NUMERIC, amount NUMERIC, PRIMARY KEY (trade_date, ts_code)
);
CREATE TABLE IF NOT EXISTS etf_share (
  trade_date DATE NOT NULL, ts_code TEXT NOT NULL, fd_share NUMERIC,
  PRIMARY KEY (trade_date, ts_code)
);
CREATE TABLE IF NOT EXISTS index_daily (
  trade_date DATE NOT NULL, ts_code TEXT NOT NULL, close NUMERIC, pct_chg NUMERIC,
  PRIMARY KEY (trade_date, ts_code)
);`
    try {
      await this.pool.query(ddl)
      return true
    } catch (err) {
      this.lastError = String(err?.message || err).slice(0, 160)
      return false
    }
  }

  /** 某批代码在库里已有的交易日（升序）。 */
  async presentDates(codes, fromDate) {
    if (!this.pool) return []
    const r = await this.pool.query(
      `SELECT DISTINCT trade_date FROM etf_share
        WHERE ts_code = ANY($1) AND trade_date >= $2 ORDER BY 1`,
      [codes, fromDate],
    )
    return r.rows.map((x) => x.trade_date)
  }

  async upsertShares(rows) {
    if (!this.pool || !rows.length) return 0
    const values = rows
      .map((r) => `('${String(r.trade_date).replace(/-/g, '')}'::date, '${r.ts_code}', ${num(r.fd_share)})`)
      .join(',')
    await this.pool.query(
      `INSERT INTO etf_share (trade_date, ts_code, fd_share) VALUES ${values}
       ON CONFLICT (trade_date, ts_code) DO UPDATE SET fd_share = EXCLUDED.fd_share`,
    )
    return rows.length
  }

  async upsertDaily(rows) {
    if (!this.pool || !rows.length) return 0
    const values = rows
      .map(
        (r) =>
          `('${String(r.trade_date).replace(/-/g, '')}'::date, '${r.ts_code}', ${num(r.close)}, ${num(r.pre_close)}, ${num(r.pct_chg)}, ${num(r.vol)}, ${num(r.amount)})`,
      )
      .join(',')
    await this.pool.query(
      `INSERT INTO etf_daily (trade_date, ts_code, close, pre_close, pct_chg, vol, amount)
       VALUES ${values}
       ON CONFLICT (trade_date, ts_code) DO UPDATE
       SET close=EXCLUDED.close, pre_close=EXCLUDED.pre_close, pct_chg=EXCLUDED.pct_chg,
           vol=EXCLUDED.vol, amount=EXCLUDED.amount`,
    )
    return rows.length
  }

  async upsertIndex(rows) {
    if (!this.pool || !rows.length) return 0
    const values = rows
      .map((r) => `('${String(r.trade_date).replace(/-/g, '')}'::date, '${r.ts_code}', ${num(r.close)}, ${num(r.pct_chg)})`)
      .join(',')
    await this.pool.query(
      `INSERT INTO index_daily (trade_date, ts_code, close, pct_chg) VALUES ${values}
       ON CONFLICT (trade_date, ts_code) DO UPDATE SET close=EXCLUDED.close, pct_chg=EXCLUDED.pct_chg`,
    )
    return rows.length
  }

  /**
   * 各标的近 N 日日均成交额（亿元）。
   * etf_daily.amount 单位是千元（tushare fund_daily 口径），/1e5 转亿元。
   */
  async dailyAvgAmount(codes, days = 20) {
    if (!this.pool) return new Map()
    const r = await this.pool.query(
      `SELECT ts_code, avg(amount) AS avg_amount FROM (
         SELECT ts_code, amount,
                row_number() OVER (PARTITION BY ts_code ORDER BY trade_date DESC) AS rn
           FROM etf_daily WHERE ts_code = ANY($1)
       ) t WHERE rn <= $2 GROUP BY ts_code`,
      [codes, days],
    )
    const m = new Map()
    for (const row of r.rows) {
      const v = Number(row.avg_amount)
      if (Number.isFinite(v) && v > 0) m.set(row.ts_code, v / 1e5)
    }
    return m
  }

  /** 读回面板数据，返回与实时模式一致的裸行结构。 */
  async load(codes, fromDate, benchCode) {
    if (!this.pool) return null
    const [share, daily, idx, basic] = await Promise.all([
      this.pool.query(
        `SELECT to_char(trade_date,'YYYYMMDD') trade_date, ts_code, fd_share
           FROM etf_share WHERE ts_code = ANY($1) AND trade_date >= $2 ORDER BY trade_date`,
        [codes, fromDate],
      ),
      this.pool.query(
        `SELECT to_char(trade_date,'YYYYMMDD') trade_date, ts_code, close, pct_chg, amount
           FROM etf_daily WHERE ts_code = ANY($1) AND trade_date >= $2 ORDER BY trade_date`,
        [codes, fromDate],
      ),
      this.pool.query(
        `SELECT to_char(trade_date,'YYYYMMDD') trade_date, close, pct_chg
           FROM index_daily WHERE ts_code = $1 AND trade_date >= $2 ORDER BY trade_date`,
        [benchCode, fromDate],
      ),
      this.pool.query(`SELECT ts_code, name, management FROM etf_basic`),
    ])
    return {
      shares: share.rows,
      quotes: daily.rows,
      bench: idx.rows,
      basics: basic.rows,
    }
  }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 'NULL'
}
