/**
 * 净申购分析：核心口径是 Δ基金总份额 × 收盘价。
 *
 * 为什么不用成交额：成交额只反映二级市场换手，对倒同样会放大。
 * ETF 每日披露的基金总份额是申赎的直接结果，份额增加意味着真有资金
 * 完成申购、管理人被动买入成分股，这才是判断国家队入场的可靠痕迹。
 */

/**
 * 观察池：宽基负责判断「国家队是否入场」，行业/策略/主题负责判断「钱去了哪些板块」。
 * 每条按「跟踪指数」归并 —— 国家队常同时买入同指数的多只 ETF。
 *
 * sector 是粗分的板块大类，group 是细分标的指数。
 */
export const UNIVERSE = [
  // ── 宽基：国家队主战场 ──
  { sector: '宽基', group: '沪深300', codes: ['510300.SH', '510310.SH', '510330.SH', '159919.SZ'] },
  { sector: '宽基', group: '上证50', codes: ['510050.SH', '510710.SH'] },
  { sector: '宽基', group: '中证500', codes: ['510500.SH', '159922.SZ', '512500.SH'] },
  { sector: '宽基', group: '中证1000', codes: ['512100.SH', '159845.SZ', '560010.SH'] },
  { sector: '宽基', group: '科创50', codes: ['588000.SH', '588080.SH'] },
  { sector: '宽基', group: '中证A500', codes: ['512050.SH', '159352.SZ'] },
  { sector: '宽基', group: '创业板指', codes: ['159915.SZ', '159949.SZ'] },
  { sector: '宽基', group: '上证180', codes: ['510180.SH'] },
  { sector: '宽基', group: '中证2000', codes: ['563300.SH'] },

  // ── 行业：钱流向了哪个行业 ──
  { sector: '金融', group: '证券', codes: ['512880.SH'] },
  { sector: '金融', group: '银行', codes: ['512800.SH'] },
  { sector: '消费', group: '主要消费', codes: ['159928.SZ'] },
  { sector: '消费', group: '白酒', codes: ['512690.SH'] },
  { sector: '消费', group: '消费50', codes: ['515650.SH'] },
  { sector: '消费', group: '食品饮料', codes: ['515170.SH'] },
  { sector: '医药', group: '医药卫生', codes: ['512010.SH'] },
  { sector: '医药', group: '医疗', codes: ['512170.SH'] },
  { sector: '科技', group: '半导体', codes: ['512480.SH'] },
  { sector: '科技', group: '科技龙头', codes: ['515000.SH'] },
  { sector: '科技', group: '芯片', codes: ['512760.SH'] },
  { sector: '新能源', group: '新能源车', codes: ['515030.SH'] },
  { sector: '新能源', group: '新能源', codes: ['516160.SH'] },
  { sector: '新能源', group: '光伏', codes: ['515790.SH'] },
  { sector: '新能源', group: '电池', codes: ['159755.SZ'] },
  { sector: '能源', group: '能源', codes: ['159930.SZ'] },
  { sector: '能源', group: '电力', codes: ['159611.SZ'] },
  { sector: '资源', group: '有色金属', codes: ['512400.SH'] },
  { sector: '资源', group: '黄金', codes: ['518880.SH'] },
  { sector: '制造', group: '军工', codes: ['512660.SH'] },
  { sector: '地产', group: '房地产', codes: ['512200.SH'] },

  // ── 策略/主题 ──
  { sector: '策略', group: '红利', codes: ['510880.SH'] },
  { sector: '策略', group: '红利低波', codes: ['515100.SH', '159307.SZ'] },
  { sector: '主题', group: '游戏', codes: ['516010.SH', '159869.SZ'] },
  { sector: '主题', group: '旅游', codes: ['159766.SZ'] },
  { sector: '主题', group: '环保', codes: ['512580.SH'] },

  // ── 跨境：标的在港股，走港股通。反映资金偏好，但不属于 A 股国家队托底工具 ──
  { sector: '跨境', group: '港股通红利', codes: ['159569.SZ'] },
  { sector: '跨境', group: '港股通央企红利', codes: ['513910.SH', '520990.SH', '520660.SH'] },
]

/** 兼容旧接口：{ group: [codes] } */
export const BASKET = Object.fromEntries(UNIVERSE.map((u) => [u.group, u.codes]))

export const BENCH = { code: '000300.SH', name: '沪深300' }

/** 万份 -> 亿份 */
const SHARE_TO_YI = 1e4

export function basketCodes() {
  return [...new Set(UNIVERSE.flatMap((u) => u.codes))]
}

/** code -> { group, sector } */
function codeMeta() {
  const map = new Map()
  for (const u of UNIVERSE) {
    for (const c of u.codes) map.set(c, { group: u.group, sector: u.sector })
  }
  return map
}

/**
 * 构造面板：把份额、行情、基准对齐成「每只 ETF 每交易日」的长表。
 * @param {Array<{ts_code,trade_date,fd_share}>} shares
 * @param {Array<{ts_code,trade_date,close,pct_chg,amount}>} quotes
 * @param {Map<string, number>} benchPct  trade_date -> 基准涨跌幅
 */
export function buildPanel(shares, quotes, benchPct) {
  const meta = codeMeta()
  const quoteMap = new Map()
  for (const q of quotes) quoteMap.set(`${q.ts_code}|${q.trade_date}`, q)

  const rows = []
  for (const s of shares) {
    const m = meta.get(s.ts_code)
    if (!m) continue
    const q = quoteMap.get(`${s.ts_code}|${s.trade_date}`)
    if (!q) continue
    rows.push({
      date: s.trade_date,
      code: s.ts_code,
      group: m.group,
      sector: m.sector,
      share: Number(s.fd_share),
      close: Number(q.close),
      pct: Number(q.pct_chg ?? 0),
      amount: Number(q.amount ?? 0) / 1e5, // 千元 -> 亿元
      bench: benchPct.get(s.trade_date) ?? null,
    })
  }

  rows.sort((a, b) => (a.code === b.code ? a.date.localeCompare(b.date) : a.code.localeCompare(b.code)))

  // 逐只计算 Δ份额与净申购额；跨过长假不连算，避免把多日变化记成单日
  let prevCode = null
  let prevShare = null
  let prevDate = null
  for (const r of rows) {
    let delta = 0
    let continuous = false
    if (prevCode === r.code && prevDate) {
      const gapDays = (Date.parse(ymd(r.date)) - Date.parse(ymd(prevDate))) / 86400000
      continuous = gapDays <= 5
      if (continuous) delta = r.share - prevShare
    }
    r.dShare = delta
    r.inflow = continuous ? (delta * r.close) / SHARE_TO_YI : null // 亿元
    prevCode = r.code
    prevShare = r.share
    prevDate = r.date
  }
  return rows
}

function ymd(s) {
  const t = String(s)
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`
}

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x))

/**
 * 计算各指数资金流与「国家队入场」综合评分。
 * 评分维度：净申购强度(45%) + 流入广度(30%) + 逆势托底(25%)
 */
export function computeSignals(panel, lookback = 5) {
  if (!panel.length) return { asOf: null, groups: [], sectorTotals: [], basket: {}, series: [], scores: {}, composite: 0 }

  const valid = panel.filter((r) => r.inflow !== null)
  const asOf = valid.length ? valid[valid.length - 1].date : panel[panel.length - 1].date

  // 池级统一日期轴：所有窗口都在这条轴上取，保证「合计 = 各基金之和」严格成立。
  // 沪深披露不同步（沪 11-03 / 深 11-02）时，深市缺的那天按 0 计入组，基金侧同样按这套日期取窗。
  const axisDates = [...new Set(valid.map((r) => r.date))].sort()

  const byGroup = new Map()
  for (const r of valid) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, [])
    byGroup.get(r.group).push(r)
  }

  const groups = []
  let grossBase = 0
  for (const [group, list] of byGroup) {
    // ── 先按日期聚合成「每日净申购序列」，再在日期轴上取窗口。
    // 关键：list 是「多管理人 × 多交易日」的行集合。直接 list.slice(-N) 取到的是最后 N 行
    // （同一天的多只 ETF 相邻，约等于一天），会让多管理人指数严重低估——
    // 实测沪深300 曾显示 285.79 亿而正确值是 613.97 亿。所有窗口必须落在日期轴上。
    const byDate = new Map()
    for (const r of list) {
      const cur = byDate.get(r.date)
      if (cur) cur.inflow += r.inflow
      else byDate.set(r.date, { inflow: r.inflow, bench: r.bench })
    }
    const daySeries = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({ date, inflow: v.inflow, bench: v.bench }))

    const winDates = axisDates.slice(-lookback)
    const recent = winDates.map((d) => daySeries.find((x) => x.date === d)).filter(Boolean)
    const inflowNd = recent.reduce((s, d) => s + d.inflow, 0)
    const inflow1d = daySeries.length ? daySeries[daySeries.length - 1].inflow : 0

    const hist = axisDates.slice(-60).map((d) => {
      const hit = daySeries.find((x) => x.date === d)
      return Math.abs(hit ? hit.inflow : 0)
    })
    const base = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : 0
    grossBase += base

    // 组内每只 ETF 取各自最新份额与价格求和
    const latest = new Map()
    for (const r of list) latest.set(r.code, r)
    let scaleYi = 0
    let scaleShare = 0
    const first = new Map()
    for (const r of list) if (!first.has(r.code)) first.set(r.code, r)
    let prevYi = 0
    for (const [code, r] of latest) {
      scaleYi += (r.share * r.close) / SHARE_TO_YI
      scaleShare += r.share / SHARE_TO_YI
      const f = first.get(code)
      if (f) prevYi += (f.share * f.close) / SHARE_TO_YI
    }

    const downDays = recent.filter((d) => d.bench !== null && d.bench < 0)
    const contrarian = downDays.length
      ? downDays.filter((d) => d.inflow > 0).length / downDays.length
      : 0

    const dayMap = new Map(daySeries.map((d) => [d.date, d.inflow]))
    const periods = {}
    for (const p of [1, 5, 10, 20]) {
      // 内部不取整：各级独立 round 会让「合计 = 各基金之和」差出 0.0x 亿。
      // 统一在渲染层用 nf() 格式化。
      periods[`inflow_${p}d`] = axisDates
        .slice(-p)
        .reduce((s, d) => s + (dayMap.get(d) ?? 0), 0)
    }

    groups.push({
      group,
      sector: list[0].sector,
      codes: [...new Set(list.map((r) => r.code))].sort(),
      inflow1d,
      inflowNd,
      power: base > 0 ? round(inflowNd / base, 2) : 0,
      persistence: recent.length ? round(recent.filter((d) => d.inflow > 0).length / recent.length, 2) : 0,
      contrarian: round(contrarian, 2),
      scaleYi: round(scaleYi, 2),
      scaleShare: round(scaleShare, 2),
      scaleChgYi: round(scaleYi - prevYi, 2),
      periods,
      downDays: downDays.length,
    })
  }

  const totalInflow = groups.reduce((s, g) => s + g.inflowNd, 0)
  const basketPower = grossBase > 0 ? totalInflow / grossBase : 0
  const breadth = groups.length ? groups.filter((g) => g.inflowNd > 0).length / groups.length : 0

  // 逆势度：按「交易日 × 指数」当口径统计
  const dayGroup = new Map()
  for (const r of valid) {
    const k = `${r.date}|${r.group}`
    const cur = dayGroup.get(k) || { inflow: 0, bench: r.bench }
    cur.inflow += r.inflow
    dayGroup.set(k, cur)
  }
  const downCells = [...dayGroup.values()].filter((c) => c.bench !== null && c.bench < 0)
  const basketContrarian = downCells.length
    ? downCells.filter((c) => c.inflow > 0).length / downCells.length
    : 0

  const sPower = clamp(Math.tanh(basketPower) * 100)
  const sPersist = clamp(breadth * 100)
  const sContra = clamp(basketContrarian * 100)
  const composite = round(0.45 * sPower + 0.3 * sPersist + 0.25 * sContra, 1)

  let regime
  let note
  if (composite >= 75) {
    regime = '强烈入场'
    note = '宽基 ETF 份额同步放量，典型国家队托底特征'
  } else if (composite >= 55) {
    regime = '温和流入'
    note = '资金持续净申购，需观察能否延续'
  } else if (composite >= 35) {
    regime = '观望'
    note = '流入偏弱，未见明显合力'
  } else {
    regime = '净流出'
    note = '份额收缩，资金撤离'
  }

  // 时间序列
  const byDate = new Map()
  for (const r of valid) {
    const cur = byDate.get(r.date) || { inflow: 0, bench: r.bench }
    cur.inflow += r.inflow
    byDate.set(r.date, cur)
  }
  const dates = [...byDate.keys()].sort()
  let cum = 0
  const series = dates.map((d) => {
    const c = byDate.get(d)
    cum += c.inflow
    return {
      date: ymd(d),
      inflow: round(c.inflow, 2),
      cum: round(cum, 2),
      bench: c.bench === null ? null : round(c.bench, 2),
    }
  })

  // 板块聚合：把 33 个细分指数归到大类，回答「钱去了哪些板块」
  const sectorTotals = aggregateBySector(groups, lookback)

  // 流入集中度：Top3 指数占全部正流入的比例。
  // 高集中度＝只护几个大指数；低集中度＝全面撒钱。
  const positive = groups.filter((g) => g.inflowNd > 0).sort((a, b) => b.inflowNd - a.inflowNd)
  const positiveSum = positive.reduce((acc, g) => acc + g.inflowNd, 0)
  const top3Sum = positive.slice(0, 3).reduce((acc, g) => acc + g.inflowNd, 0)
  const concentration = {
    ratio: positiveSum > 0 ? round(top3Sum / positiveSum, 3) : 0,
    top3: positive.slice(0, 3).map((g) => ({ group: g.group, inflow: g.inflowNd })),
    positiveSum: round(positiveSum, 2),
  }

  // 异常日：全池单日净申购的 z-score，标出极端入场日
  const dailyVals = [...byDate.entries()].map(([date, v]) => ({ date, inflow: v.inflow }))
  const anomalies = detectAnomalies(dailyVals)

  return {
    asOf: ymd(asOf),
    lookback,
    regime,
    note,
    composite,
    scores: { power: round(sPower, 1), breadth: round(sPersist, 1), contrarian: round(sContra, 1) },
    sectorTotals,
    concentration,
    anomalies,
    basket: {
      inflowNd: totalInflow,
      inflowLatest: series.length ? series[series.length - 1].inflow : 0,
      power: round(basketPower, 2),
      breadth: round(breadth, 2),
      contrarian: round(basketContrarian, 2),
      benchName: BENCH.name,
      benchCode: BENCH.code,
    },
    groups: groups.sort((a, b) => b.inflowNd - a.inflowNd),
    series,
  }
}

/** 单只 ETF 明细。 */
export function fundDetail(panel, lookback = 5, names = {}) {
  const byCode = new Map()
  for (const r of panel) {
    if (r.inflow === null && !byCode.has(r.code)) {
      // 仍要保留首个记录用于取份额
    }
    if (!byCode.has(r.code)) byCode.set(r.code, [])
    byCode.get(r.code).push(r)
  }

  // 与 computeSignals 共用同一条池级日期轴，保证「合计 = 各基金之和」严格成立。
  // 深市缺最新一天时，那天按 0 计入，而不是退回它自己的上一个交易日。
  const axisDates = [...new Set(panel.filter((r) => r.inflow !== null).map((r) => r.date))].sort()

  const out = []
  for (const [code, list] of byCode) {
    list.sort((a, b) => a.date.localeCompare(b.date))
    const validList = list.filter((r) => r.inflow !== null)
    if (!validList.length) continue
    const last = list[list.length - 1]
    const byDay = new Map(validList.map((r) => [r.date, r]))

    const periods = {}
    for (const p of [1, 5, 10, 20]) {
      periods[`inflow_${p}d`] = axisDates
        .slice(-p)
        .reduce((s, d) => s + (byDay.get(d)?.inflow ?? 0), 0)
    }
    const window = axisDates.slice(-lookback).map((d) => byDay.get(d)).filter(Boolean)

    // 逆势托底度：基准下跌日里仍净申购的比例
    const downDays = window.filter((r) => r.bench !== null && r.bench < 0)
    const contrarian = downDays.length
      ? downDays.filter((r) => r.inflow > 0).length / downDays.length
      : 0

    // 资金流强度：净申购 / 成交额。区分「真申购」与「高换手带出的假流入」
    const inflowWin = window.reduce((acc, r) => acc + r.inflow, 0)
    const amountWin = window.reduce((acc, r) => acc + r.amount, 0)
    const intensity = amountWin > 0 ? (inflowWin / amountWin) * 100 : 0

    // 规模变化分解：份额效应（真资金）vs 净值效应（价格涨跌）
    const firstValid = window.length ? window[0] : validList[0]
    const lastValid = window.length ? window[window.length - 1] : last
    const shareEffect = ((lastValid.share - firstValid.share) * lastValid.close) / SHARE_TO_YI
    const navEffect = (firstValid.share * (lastValid.close - firstValid.close)) / SHARE_TO_YI

    // 连续净流入天数
    let streak = 0
    for (let i = validList.length - 1; i >= 0; i -= 1) {
      if (validList[i].inflow > 0) streak += 1
      else break
    }

    out.push({
      code,
      name: names[code]?.name || code,
      manager: names[code]?.manager || '—',
      group: last.group,
      sector: last.sector,
      close: round(last.close, 3),
      pct: round(last.pct, 2),
      share: round(last.share / SHARE_TO_YI, 2),
      amount: round(last.amount, 2),
      inflow1d: periods.inflow_1d,
      inflowNd: inflowWin,
      contrarian: round(contrarian, 2),
      intensity: round(intensity, 2),
      shareEffect: round(shareEffect, 2),
      navEffect: round(navEffect, 2),
      streak,
      periods,
    })
  }
  return out.sort((a, b) => b.inflowNd - a.inflowNd)
}

/** 按指数聚合的每日净申购（堆叠图用）。 */
export function groupSeries(panel, window = 60) {
  const valid = panel.filter((r) => r.inflow !== null)
  if (!valid.length) return {}
  const dates = [...new Set(valid.map((r) => r.date))].sort().slice(-window)
  const keep = new Set(dates)
  const map = new Map()
  for (const r of valid) {
    if (!keep.has(r.date)) continue
    if (!map.has(r.group)) map.set(r.group, new Map())
    const m = map.get(r.group)
    m.set(r.date, (m.get(r.date) || 0) + r.inflow)
  }
  const out = {}
  for (const [group, m] of map) {
    out[group] = dates.map((d) => ({ date: ymd(d), inflow: round(m.get(d) ?? 0, 2) }))
  }
  return out
}

/** 单只 ETF 的份额与净申购序列。 */
export function fundSeries(panel, window = 60) {
  const byCode = new Map()
  for (const r of panel) {
    if (!byCode.has(r.code)) byCode.set(r.code, [])
    byCode.get(r.code).push(r)
  }
  const out = {}
  for (const [code, list] of byCode) {
    list.sort((a, b) => a.date.localeCompare(b.date))
    const valid = list.filter((r) => r.inflow !== null)
    const tail = valid.slice(-window)
    if (!tail.length) continue
    out[code] = tail.map((r) => ({
      date: ymd(r.date),
      share: round(r.share / SHARE_TO_YI, 2),
      inflow: round(r.inflow, 2),
      close: round(r.close, 3),
      amount: round(r.amount, 2),
    }))
  }
  return out
}

/**
 * 把细分指数汇总到板块大类。
 * 每个板块给出：当日/多周期净申购、规模、成分指数数、流入的指数占比。
 */
function aggregateBySector(groups, lookback) {
  const buckets = new Map()
  for (const g of groups) {
    const key = g.sector || '其他'
    if (!buckets.has(key)) {
      buckets.set(key, {
        sector: key,
        groups: [],
        inflow1d: 0,
        inflowNd: 0,
        scaleYi: 0,
        posCount: 0,
        periods: {},
      })
    }
    const b = buckets.get(key)
    b.groups.push(g.group)
    b.inflow1d += g.inflow1d
    b.inflowNd += g.inflowNd
    b.scaleYi += g.scaleYi
    if (g.inflowNd > 0) b.posCount += 1
    for (const p of [1, 5, 10, 20]) {
      const k = `inflow_${p}d`
      b.periods[k] = (b.periods[k] || 0) + (g.periods?.[k] ?? 0)
    }
  }

  const out = []
  for (const b of buckets.values()) {
    out.push({
      sector: b.sector,
      groups: b.groups.sort(),
      groupCount: b.groups.length,
      inflow1d: round(b.inflow1d, 2),
      inflowNd: round(b.inflowNd, 2),
      scaleYi: round(b.scaleYi, 2),
      breadth: b.groups.length ? round(b.posCount / b.groups.length, 2) : 0,
      periods: b.periods,
    })
  }
  return out.sort((a, b) => b.inflowNd - a.inflowNd)
}

/** 用 z-score 找极端净申购日。窗口内标准差为 0 时返回空。 */
function detectAnomalies(daily, threshold = 2) {
  if (daily.length < 8) return []
  const vals = daily.map((d) => d.inflow)
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length
  const sd = Math.sqrt(variance)
  if (!(sd > 0)) return []
  return daily
    .map((d) => ({ date: ymd(d.date), inflow: round(d.inflow, 2), z: round((d.inflow - mean) / sd, 2) }))
    .filter((d) => Math.abs(d.z) >= threshold)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
}

/**
 * 板块轮动动量：近 n 日 vs 前 n 日。
 * 正值＝在加仓，负值＝在撤。
 */
export function sectorMomentum(panel, n = 5) {
  const valid = panel.filter((r) => r.inflow !== null)
  if (!valid.length) return []
  const dates = [...new Set(valid.map((r) => r.date))].sort()
  const recentDates = new Set(dates.slice(-n))
  const prevDates = new Set(dates.slice(-2 * n, -n))

  const bucket = new Map()
  for (const r of valid) {
    const key = r.sector
    if (!bucket.has(key)) bucket.set(key, { recent: 0, prev: 0 })
    const b = bucket.get(key)
    if (recentDates.has(r.date)) b.recent += r.inflow
    else if (prevDates.has(r.date)) b.prev += r.inflow
  }

  return [...bucket.entries()]
    .map(([sector, v]) => ({
      sector,
      recent: round(v.recent, 2),
      prev: round(v.prev, 2),
      delta: round(v.recent - v.prev, 2),
    }))
    .sort((a, b) => b.delta - a.delta)
}

/**
 * 管理人偏好：同一指数下不同管理人的份额变化对比。
 * 国家队常只买其中一两只，这个能看出它的偏好。
 */
export function managerView(panel, names = {}, window = 30) {
  const byGroup = new Map()
  for (const r of panel) {
    if (r.inflow === null) continue
    if (!byGroup.has(r.group)) byGroup.set(r.group, new Map())
    const m = byGroup.get(r.group)
    if (!m.has(r.code)) m.set(r.code, [])
    m.get(r.code).push(r)
  }

  const out = []
  for (const [group, codes] of byGroup) {
    if (codes.size < 2) continue
    const rows = []
    for (const [code, list] of codes) {
      list.sort((a, b) => a.date.localeCompare(b.date))
      const tail = list.slice(-window)
      if (tail.length < 2) continue
      const first = tail[0]
      const last = tail[tail.length - 1]
      rows.push({
        code,
        name: names[code]?.name || code,
        manager: names[code]?.manager || '—',
        shareNow: round(last.share / SHARE_TO_YI, 2),
        shareChgPct: first.share > 0 ? round(((last.share - first.share) / first.share) * 100, 2) : 0,
        inflow: round(tail.reduce((a, r) => a + r.inflow, 0), 2),
      })
    }
    if (rows.length < 2) continue
    rows.sort((a, b) => b.inflow - a.inflow)
    out.push({ group, rows })
  }
  return out.sort((a, b) => b.rows.reduce((x, r) => x + r.inflow, 0) - a.rows.reduce((x, r) => x + r.inflow, 0))
}

/**
 * 热力矩阵：日期 × 指数 的每日净申购。
 * 只保留总流入绝对值最大的若干指数，避免列太多排不下。
 */
export function heatmap(panel, { days = 20, topGroups = 10 } = {}) {
  const valid = panel.filter((r) => r.inflow !== null)
  if (!valid.length) return { dates: [], groups: [], cells: [], max: 0 }

  const dates = [...new Set(valid.map((r) => r.date))].sort().slice(-days)
  const keepDate = new Set(dates)

  const totalByGroup = new Map()
  for (const r of valid) {
    if (!keepDate.has(r.date)) continue
    totalByGroup.set(r.group, (totalByGroup.get(r.group) || 0) + r.inflow)
  }
  const groups = [...totalByGroup.entries()]
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, topGroups)
    .map(([g]) => g)

  const cellMap = new Map()
  for (const r of valid) {
    if (!keepDate.has(r.date)) continue
    const k = `${r.date}|${r.group}`
    cellMap.set(k, (cellMap.get(k) || 0) + r.inflow)
  }

  let max = 0
  const cells = []
  for (const d of dates) {
    const row = []
    for (const g of groups) {
      const v = round(cellMap.get(`${d}|${g}`) ?? 0, 2)
      if (Math.abs(v) > max) max = Math.abs(v)
      row.push(v)
    }
    const total = round(row.reduce((a, b) => a + b, 0), 2)
    cells.push({ date: ymd(d), values: row, total })
  }

  return { dates: dates.map(ymd), groups, cells: cells.reverse(), max: round(max, 2) }
}

function round(v, d = 2) {
  const p = 10 ** d
  return Math.round((Number(v) + Number.EPSILON) * p) / p
}
