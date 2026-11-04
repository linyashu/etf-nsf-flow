/**
 * 市场温度：描述性情绪指标（第二档）。
 *
 * ⚠️ 这些指标只用于「解释当下状态」，**不参与任何评分、不做方向预测**。
 *
 * 依据：近三年非重叠样本（每 20 个交易日取 1 个独立观测）对沪深300 未来 20 日收益
 * 做双样本检验，成交额 / 两融 / 主力净流入等候选全部不显著（|t| < 2）。
 * 分年度看方向还会翻转（成交额 2024 有效 +5.17pp，2026 反向 -2.36pp）。
 * 唯独 ETF 净申购通过检验，所以评分只由它驱动。
 *
 * 因此这里输出的是"温度计"，不是"信号灯"。
 */

/**
 * 各指标最少需要多少天数据才认为可用。
 *
 * 涨停池 / 炸板池只有 2026-04 起的数据（约 19 个交易日/月），30 天窗口内通常
 * 只有 18~19 天，用 20 天做门槛会让这些指标永远不显示。10 天足以算分位。
 */
const MIN_DAYS = 10

function round(v, n) {
  if (v === null || !Number.isFinite(v)) return null
  const f = 10 ** n
  return Math.round(v * f) / f
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null
  return ((a - b) / Math.abs(b)) * 100
}

function mean(arr) {
  const v = arr.filter((x) => Number.isFinite(x))
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null
}

function percentileRank(series, value) {
  const v = series.filter((x) => Number.isFinite(x))
  if (v.length < MIN_DAYS || !Number.isFinite(value)) return null
  const below = v.filter((x) => x <= value).length
  return (below / v.length) * 100
}

/**
 * 读市场温度。任何一项失败都返回 null，不影响主看板。
 *
 * @param {import('pg').Pool} pool 已打开的连接池
 * @param {string} asOf 截止交易日 cat 'YYYY-MM-DD'
 */
export async function marketTemperature(pool, asOf) {
  if (!pool) return null
  const out = { asOf, items: [], note: null }
  /**
   * digits 按单位定，不按「亿/万亿」一刀切：
   *   家/倍 → 计数类，倍留 1 位；万亿/亿 → 金额类，万亿留 2 位、亿取整
   * windowDays 必须与实际查询窗口一致，否则「近 30 分位」会与 45 天的查询对不上。
   */
  const push = (key, label, value, unit, extra = {}) => {
    if (value === null || !Number.isFinite(value)) return
    const digits = unit === '家' ? 0 : unit === '倍' ? 2 : unit === '万亿' ? 2 : unit === '%' ? 1 : 0
    out.items.push({ key, label, value, unit, digits, ...extra })
  }

  try {
    // ── 1. 涨停 / 跌停 / 炸板：短线情绪温度 ──
    //
    // zt_pool 的 pool 字段有 5 类：zt 涨停、zb 炸板、dt 跌停、strong 强势、sub_new 次新。
    // 必须按 pool 过滤——曾经漏了这个条件，把全部 405 行当成涨停，
    // 导致 11-03 报出「涨停 405 家」（真实 48 家），还把 17 家跌停算成了涨停。
    //
    // 板块口径无需自己判断：实测 zt 池主板 47 家涨幅 9.82~10.13（限 10%）、
    // 创业板 1 家 20.00（限 20%），tushare 已按各板块涨跌幅限制正确判定，
    // 不存在「把科创板/北交所 10%+ 算成涨停」的问题。
    const lim = await pool.query(
      `SELECT trade_date,
              count(*) FILTER (WHERE pool = 'zt')::int AS limit_up,
              count(*) FILTER (WHERE pool = 'dt')::int AS limit_down,
              count(*) FILTER (WHERE pool = 'zb')::int AS broken
         FROM zt_pool
        WHERE trade_date <= $1::date AND trade_date > $1::date - INTERVAL '45 days'
        GROUP BY trade_date ORDER BY trade_date`,
      [asOf],
    )
    if (lim.rows.length >= MIN_DAYS) {
      const today = lim.rows[lim.rows.length - 1]
      const hist = lim.rows.slice(0, -1)
      const up = Number(today.limit_up)
      const dn = Number(today.limit_down)
      const brk = Number(today.broken)

      push('limitUp', '涨停家数', up, '家', {
        dataDate: asOf,
        windowDays: hist.length,
        rank: percentileRank(hist.map((r) => Number(r.limit_up)), up),
        hint: '短线情绪温度，不预测方向',
      })
      push('limitDown', '跌停家数', dn, '家', {
        dataDate: asOf,
        windowDays: hist.length,
        rank: percentileRank(hist.map((r) => Number(r.limit_down)), dn),
        hint: '恐慌情绪温度',
      })
      // 炸板率 = 炸板 ÷ (涨停 + 炸板)。比单看炸板数更能反映封板意愿
      if (up + brk > 0) {
        const rate = (brk / (up + brk)) * 100
        push('brokenRate', '炸板率', rate, '%', {
          dataDate: asOf,
          windowDays: hist.length,
          rank: percentileRank(
            hist.map((r) => {
              const u = Number(r.limit_up)
              const b = Number(r.broken)
              return u + b > 0 ? (b / (u + b)) * 100 : 0
            }),
            rate,
          ),
          hint: `炸板 ${brk} 家 / 触及涨停 ${up + brk} 家`,
        })
      }
    }

    // ── 2. 涨跌家数比：当日赚钱效应 ──
    const adv = await pool.query(
      `SELECT trade_date,
              sum(CASE WHEN pct_chg > 0 THEN 1 ELSE 0 END)::int AS up,
              sum(CASE WHEN pct_chg < 0 THEN 1 ELSE 0 END)::int AS down
         FROM stock_daily
        WHERE trade_date = $1::date
        GROUP BY trade_date`,
      [asOf],
    )
    if (adv.rows.length) {
      const { up, down } = adv.rows[0]
      push('advanceDecline', '涨跌家数比', Number(up) / Math.max(1, Number(down)), '倍', {
        hint: `${up} 涨 / ${down} 跌`,
      })
    }

    // ── 3. 成交额：活跃度水位（相对 20 日均值）──
    const amt = await pool.query(
      `SELECT trade_date, sum(amount)::float AS amt
         FROM stock_daily
        WHERE trade_date <= $1::date AND trade_date > $1::date - INTERVAL '60 days'
        GROUP BY trade_date ORDER BY trade_date`,
      [asOf],
    )
    if (amt.rows.length >= MIN_DAYS) {
      const series = amt.rows.map((r) => Number(r.amt) / 1e5) // 千元 → 亿元
      const today = series[series.length - 1]
      const base = mean(series.slice(-21, -1))
      const ratio = base ? (today / base) * 100 : null
      push('turnover', '全市场成交额', today, '亿', {
        dataDate: asOf,
        windowDays: series.slice(0, -1).length,
        rank: percentileRank(series.slice(0, -1), today),
        hint: ratio === null ? null : `为 20 日均值的 ${ratio.toFixed(0)}%`,
      })
    }

    // ── 4. 两融余额：杠杆水位 ──
    // 必须用 rzrqye（融资融券余额），不是 rzye（仅融资余额）。
    // 实测 11-02 融资余额 2.2840 万亿、两融余额 2.3121 万亿，差的是融券 280 亿——
    // 标签写「两融」却只算融资，是口径错误。
    const margin = await pool.query(
      `SELECT to_char(trade_date,'YYYY-MM-DD') AS d, sum(rzrqye)::float AS bal, sum(rzye)::float AS fin
         FROM margin_detail
        WHERE trade_date <= $1::date AND trade_date > $1::date - INTERVAL '45 days'
        GROUP BY trade_date ORDER BY trade_date`,
      [asOf],
    )
    if (margin.rows.length >= MIN_DAYS) {
      const series = margin.rows.map((r) => Number(r.bal) / 1e8)
      const today = series[series.length - 1]
      const prev = series[series.length - 2]
      // 两融余额是单调趋势量，余额接近历史新高时分位恒为 100，缺乏信息量。
      // 因此不叫「分位」，直接给「相对 20 日均值」的偏离度。
      const base20 = mean(series.slice(-21, -1))
      const dev = base20 ? (today / base20 - 1) * 100 : null
      const todayRow = margin.rows[margin.rows.length - 1]
      const finShare = todayRow?.fin && todayRow?.bal ? (Number(todayRow.fin) / Number(todayRow.bal)) * 100 : null
      push('margin', '两融余额', today / 1e4, '万亿', {
        // 两融是 T+1 发布：asOf 当天通常还没有数据，必须把真实日期标出来
        dataDate: todayRow?.d ?? null,
        rank: null,
        deviation: dev === null ? null : round(dev, 1),
        hint:
          `较前日 ${pct(today, prev)?.toFixed(2) ?? '—'}%` +
          (dev === null ? '' : ` · 20 日均值 ${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%`) +
          (finShare === null ? '' : ` · 融资占 ${finShare.toFixed(0)}%`),
      })
    }

    out.note = out.items.length
      ? '仅描述当日市场状态，不参与评分'
      : '市场温度数据不可用（stock_wiki 采集未就绪）'
    return out
  } catch (err) {
    out.note = `市场温度读取失败：${String(err?.message || err).slice(0, 80)}`
    return out
  }
}
