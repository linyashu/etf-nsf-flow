/**
 * 盘中量能预警（Intraday Volume Alert）。
 *
 * 为什么需要它：
 * 本插件的核心信号——份额净申购——依赖申赎数据，沪深两家都是 T+1，收盘后才有。
 * 国家队若在上午出手，用户要到第二天才能看到。盘中量能是唯一能「当天就知道」的信号。
 *
 * ⚠️ 这是**预警**，不是结论。三条必须写在 UI 上的限定：
 *
 *   1. 成交额 = 换手，任何人都会贡献（散户、量化、一二级套利、做市双边报价）。
 *      宽基 ETF 的套利机制会让同一笔申赎在二级市场产生反向成交，稀释信号。
 *   2. 「主动净买入」由外盘/内盘推算：(外盘−内盘)/(外盘+内盘)×成交额。
 *      它是逐笔成交方向的推断，**不是资金净流入，也不是基金申赎**。
 *   3. 统计上，成交额对未来 20 日收益不显著（近三年非重叠抽样 t=-0.09）。
 *      它描述「当下热闹程度」，不具备前瞻性。因此本模块不参与综合评分。
 *
 * 数据源：腾讯行情（qt.gtimg.cn），单次可批量取数十只，GBK 编码。
 * 与「份额」信号的分工：成交额负责盘中预警，份额负责收盘后确认。
 */

const QQ_URL = 'https://qt.gtimg.cn/q='

/** 取北京时间的时分秒。不能直接用本地时区——用户在别的时区会用错进度。 */
function shanghaiClock(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now)
  const g = (t) => Number(p.find((x) => x.type === t)?.value ?? 0)
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour'), mi: g('minute'), s: g('second') }
}

/** 北京时间当天日期 YYYY-MM-DD。用于判断行情是否属于「今天」。 */
export function todayBeijing(now = new Date()) {
  const c = shanghaiClock(now)
  return `${c.y}-${String(c.mo).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`
}

/** A 股交易时段（分钟）。 */
const SESSION = {
  morning: [9 * 60 + 30, 11 * 60 + 30],
  afternoon: [13 * 60, 15 * 60],
  totalMinutes: 240,
}

/**
 * 当前处于交易时段的进度（0–1）。
 * 用于把「半天成交额」折算成可与「全天历史均额」比较的口径——
 * 不做这一步，午间的量永远只有全天的一半，看起来永远是缩量。
 */
export function sessionProgress(now = new Date()) {
  const clock = shanghaiClock(now)
  const t = clock.h * 60 + clock.mi + clock.s / 60
  const [m0, m1] = SESSION.morning
  const [a0, a1] = SESSION.afternoon

  let elapsed = 0
  if (t < m0) elapsed = 0
  else if (t <= m1) elapsed = t - m0
  else if (t < a0) elapsed = m1 - m0
  else if (t <= a1) elapsed = (m1 - m0) + (t - a0)
  else elapsed = SESSION.totalMinutes

  const ratio = Math.max(0, Math.min(1, elapsed / SESSION.totalMinutes))
  const phase =
    t < m0 ? 'pre' : t <= m1 ? 'morning' : t < a0 ? 'lunch' : t <= a1 ? 'afternoon' : 'closed'
  return { ratio, phase, elapsedMinutes: Math.round(elapsed) }
}

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** 腾讯行情代码：510300.SH → sh510300 */
function toQQ(code) {
  const [num, ex] = String(code).split('.')
  return (ex === 'SH' ? 'sh' : 'sz') + num
}

/**
 * 拉取实时行情。返回按 ts_code 索引的 Map。
 * 失败返回空 Map——盘中数据拿不到时看板必须照常可用。
 */
export async function fetchQuotes(codes, { signal } = {}) {
  if (!codes?.length) return new Map()
  const url = QQ_URL + codes.map(toQQ).join(',')
  let text
  try {
    const res = await fetch(url, {
      headers: { Referer: 'https://finance.qq.com/', 'User-Agent': 'Mozilla/5.0' },
      signal,
    })
    if (!res.ok) return new Map()
    text = new TextDecoder('gbk').decode(await res.arrayBuffer())
  } catch {
    return new Map()
  }

  const out = new Map()
  for (const line of text.split('\n')) {
    const m = line.match(/^v_(\w+)="(.+?)"/)
    if (!m) continue
    const f = m[2].split('~')
    if (f.length < 38) continue

    const num = (i) => {
      const v = Number(f[i])
      return Number.isFinite(v) ? v : null
    }
    const price = num(3)
    const prevClose = num(4)
    const volumeHand = num(6) // 手
    const outer = num(7) // 外盘（主动买）
    const inner = num(8) // 内盘（主动卖）
    const amountWan = num(37) // 成交额（万元）

    // 腾讯给的是「手」，1 手 = 100 份；成交额用万元
    const amountYi = amountWan === null ? null : amountWan / 1e4
    const totalFlow = (outer ?? 0) + (inner ?? 0)
    const netRatio = totalFlow > 0 ? ((outer ?? 0) - (inner ?? 0)) / totalFlow : null
    const netActive = netRatio !== null && amountYi !== null ? netRatio * amountYi : null

    const ts = String(f[30] || '')
    // key 必须还原成 ts_code（510300.SH）——否则与 dailyAvg / 观察池的键对不上，
    // 会导致所有标的的日均基准取空、倍数全部为 null。
    const market = m[1].startsWith('sh') ? 'SH' : 'SZ'
    const tsCode = `${m[1].slice(2)}.${market}`
    out.set(tsCode, {
      code: tsCode,
      name: f[1],
      price,
      prevClose,
      pct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
      volumeHand,
      amountYi,
      outer,
      inner,
      netActiveYi: netActive,
      quoteTime: ts,
    })
  }
  return out
}

/**
 * 组装盘中预警。
 *
 * @param {Array<string>} codes  观察池代码（ts_code 形式）
 * @param {Map}   dailyAvg       各代码近 20 日日均成交额（亿元）
 * @param {object} opts
 */
export function buildIntraday(quotes, dailyAvg, { now = new Date(), asOfDate = null } = {}) {
  if (!quotes?.size) return null
  const session = sessionProgress(now)

  // 只有在交易时段内才有「进度」概念；收盘后等价于全天，进度 = 1
  const progress = session.ratio > 0 ? session.ratio : null

  let amtSum = 0
  let netSum = 0
  let baseSum = 0
  let counted = 0
  const rows = []

  for (const [code, q] of quotes) {
    if (q.amountYi === null) continue
    const base = dailyAvg?.get(code) ?? null
    amtSum += q.amountYi
    if (q.netActiveYi !== null) netSum += q.netActiveYi
    if (base !== null) baseSum += base
    counted += 1
    rows.push({
      code,
      name: q.name,
      amountYi: round(q.amountYi, 2),
      pct: round(q.pct, 2),
      netActiveYi: q.netActiveYi === null ? null : round(q.netActiveYi, 2),
      dailyAvgYi: base === null ? null : round(base, 2),
      // 同时点倍数：当日成交额 ÷ (日均 × 进度)。除以进度才能和「全天」比较
      multiple: base && progress ? round(q.amountYi / (base * progress), 2) : null,
    })
  }

  if (!counted) return null
  rows.sort((a, b) => b.amountYi - a.amountYi)

  const baseline = baseSum > 0 && progress ? baseSum * progress : null
  const multiple = baseline ? amtSum / baseline : null

  const quoteTime = rows.length ? [...quotes.values()][0].quoteTime : null
  // 行情时间戳 20261104120530 → 2026-11-04。盘中数据的日期必须来自行情本身，
  // 不能用库里份额的最新日（那是 T-1，会把今天的实时数据标成昨天的）。
  const quoteDate =
    quoteTime && quoteTime.length >= 8
      ? `${quoteTime.slice(0, 4)}-${quoteTime.slice(4, 6)}-${quoteTime.slice(6, 8)}`
      : asOfDate

  return {
    session: { ...session, progress },
    asOfDate: quoteDate,
    shareDate: asOfDate,
    quoteTime,
    totals: {
      amountYi: round(amtSum, 2),
      netActiveYi: round(netSum, 2),
      baselineYi: baseline === null ? null : round(baseline, 2),
      multiple: multiple === null ? null : round(multiple, 2),
      // 「已达成全天日均的多少倍」——不除进度，回答「今天量能相当于几个平常日」
      dayRatio: baseSum > 0 ? round(amtSum / baseSum, 2) : null,
    },
    top: rows.slice(0, 8),
    rows,
    warn: {
      amount: '成交量是换手，任何人都贡献；宽基 ETF 一二级套利会产生反向成交，稀释信号。',
      netActive: '主动净买入由外盘/内盘推算，是逐笔成交方向，不是资金净流入、也不是基金申赎。',
      predictable: '统计上成交额对未来收益不显著，仅用于盘中预警，不参与评分。',
    },
  }
}

function round(v, n) {
  if (v === null || !Number.isFinite(v)) return null
  const f = 10 ** n
  return Math.round(v * f) / f
}

export { ymd }
