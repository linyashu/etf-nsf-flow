#!/usr/bin/env node
/**
 * 指标自检（self-check）。
 *
 * 每次改动指标、SQL、口径后跑一次。它检查四类问题，都是本项目实际踩过的坑：
 *
 *   1. 结构 —— 每个指标是否带齐 口径 / 单位 / 数据日期 / 样本量
 *   2. 自洽 —— 同一量在不同层级算出来必须相等（组=板块=基金；评分=加权和）
 *   3. 范围 —— 数值是否落在物理可能区间（分位 0–100、比例 0–1、涨跌家数 ≤ 总数）
 *   4. 新鲜 —— 数据日期是否落后过久，且必须写明真实日期
 *
 * 用法：
 *   node scripts/check-metrics.mjs              # 完整检查
 *   node scripts/check-metrics.mjs --json       # 机器可读输出
 *   node scripts/check-metrics.mjs --asof 2026-11-03
 *
 * 退出码：0 全过；1 有失败项；2 环境不可用（连不上库等）。
 */
import { readFileSync } from 'node:fs'
import { Store } from '../lib/store.js'
import { basketCodes, buildPanel, computeSignals, fundDetail, sectorMomentum } from '../lib/analyze.js'
import { marketTemperature } from '../lib/market.js'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
// 注意：indexOf 返回 -1 时，args[-1 + 1] 会取到 args[0]（比如 '--json'），
// 必须显式判断，否则 asof 会被污染成参数名。
const asofIdx = args.indexOf('--asof')
const asofRaw = asofIdx >= 0 ? args[asofIdx + 1] : undefined
// 接受 YYYY-MM-DD 与 YYYYMMDD 两种写法，内部统一用紧凑格式
const asofArg = asofRaw ? String(asofRaw).replace(/-/g, '') : undefined
if (asofArg && !/^\d{8}$/.test(asofArg)) {
  console.error(`--asof 格式无效：${asofRaw}（应为 2026-11-03 或 20261103）`)
  process.exit(2)
}

// 凭据只从环境变量读，不给默认值——否则本文件会变成仓库里的泄漏源。
const DB = {
  host: process.env.ETF_DB_HOST,
  port: Number(process.env.ETF_DB_PORT || 5432),
  user: process.env.ETF_DB_USER || 'postgres',
  password: process.env.ETF_DB_PASSWORD || '',
  database: process.env.ETF_DB_NAME || 'timescaledb',
}
if (!DB.host) {
  console.error(
    '缺少数据库配置。请先设置环境变量：\n' +
      '  export ETF_DB_HOST=... ETF_DB_PORT=5433 ETF_DB_PASSWORD=...\n' +
      '或从项目根目录的 .env 读取（见 .env.example）。',
  )
  process.exit(2)
}

const results = []
let failed = 0

function check(category, name, ok, detail) {
  results.push({ category, name, ok, detail })
  if (!ok) failed += 1
}

function approx(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol
}

function fmt(v, n = 2) {
  return Number.isFinite(v) ? v.toFixed(n) : String(v)
}

// 数值必须落在区间
function inRange(v, lo, hi) {
  return Number.isFinite(v) && v >= lo && v <= hi
}

const store = new Store(DB)
if (!(await store.open())) {
  console.error(`无法连接数据库：${store.lastError ?? 'unknown'}`)
  process.exit(2)
}

const codes = basketCodes()

// ── 取数 ──
const [shareRows, quoteRows, benchRows, etfDailyRows] = await Promise.all([
  store.pool.query(`SELECT to_char(trade_date,'YYYYMMDD') trade_date, ts_code, fd_share FROM etf_share WHERE ts_code = ANY($1)`, [codes]),
  store.pool.query(`SELECT to_char(trade_date,'YYYYMMDD') trade_date, ts_code, close, pct_chg, amount FROM etf_daily WHERE ts_code = ANY($1)`, [codes]),
  store.pool.query(`SELECT to_char(trade_date,'YYYYMMDD') trade_date, pct_chg FROM index_daily WHERE ts_code = '000300.SH'`),
  store.pool.query(`SELECT ts_code, amount FROM etf_daily WHERE ts_code = ANY($1)`, [codes]),
])

const bench = new Map(benchRows.rows.map((r) => [r.trade_date, Number(r.pct_chg)]))
const panel = buildPanel(shareRows.rows, quoteRows.rows, bench)
const signals = computeSignals(panel, 5)
const funds = fundDetail(panel, 5, {})

const axisDates = [...new Set(panel.filter((r) => r.inflow !== null).map((r) => r.date))].sort()
const asof = asofArg ?? axisDates[axisDates.length - 1]
const toDash = (c) => (c && c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}` : null)
const asofDash = toDash(asof)

// ════════════════ 1. 结构检查 ════════════════

// 每个 market 指标必须带单位；分位类必须带样本量；T+1 的必须带数据日期
const temp = await marketTemperature(store.pool, asofDash)
if (!temp || !temp.items?.length) {
  check('结构', '市场温度可用', false, '返回空，检查 market.js 是否抛异常（catch 吞错会静默少项）')
} else {
  check('结构', '市场温度项数', temp.items.length >= 5, `${temp.items.length} 项（预期 ≥5）`)

  for (const it of temp.items) {
    check('结构', `${it.label}·有单位`, Boolean(it.unit), it.unit ?? '缺失')
    check('结构', `${it.label}·有小数位`, Number.isFinite(it.digits), `digits=${it.digits}`)

    // 带 rank 的必须有样本量，否则分位无依据
    if (it.rank !== null && it.rank !== undefined) {
      check('结构', `${it.label}·分位有样本量`, Number.isFinite(it.windowDays) && it.windowDays > 0, `windowDays=${it.windowDays}`)
    }
    // 两融/成交额等按日发布的，必须写明真实数据日期
    if (['两融余额', '全市场成交额', '涨停家数', '跌停家数'].includes(it.label)) {
      check('结构', `${it.label}·有数据日期`, Boolean(it.dataDate), it.dataDate ?? '缺失（T+1 数据会误导）')
    }
  }
}

// 证据链必须有口径字段
if (signals.enhancement) {
  const p = signals.enhancement.percentile
  check('结构', '分位有样本天数', Number.isFinite(p.sampleDays) && p.sampleDays > 0, `${p.sampleDays} 天`)
  check('结构', '分位有起止日期', Boolean(p.from && p.to), `${p.from ?? '?'} → ${p.to ?? '?'}`)
  check('结构', '持续性有日序列', Array.isArray(signals.enhancement.persistence?.daily), `${signals.enhancement.persistence?.daily?.length ?? 0} 点`)
} else {
  check('结构', '证据链存在', false, 'signals.enhancement 缺失')
}

// ════════════════ 2. 自洽检查 ════════════════

for (const k of ['inflow_1d', 'inflow_5d', 'inflow_10d', 'inflow_20d']) {
  const g = signals.groups.reduce((a, x) => a + (x.periods?.[k] ?? 0), 0)
  const s = signals.sectorTotals.reduce((a, x) => a + (x.periods?.[k] ?? 0), 0)
  const f = funds.reduce((a, x) => a + (x.periods?.[k] ?? 0), 0)
  check('自洽', `${k}: 组=板块=基金`, approx(g, f) && approx(s, f), `组 ${fmt(g)} / 板块 ${fmt(s)} / 基金 ${fmt(f)}`)
}

// 集中度 = top3 之和 ÷ 正流入之和
const c = signals.concentration
const top3Sum = c.top3.reduce((a, t) => a + t.inflow, 0)
const expectRatio = c.positiveSum > 0 ? top3Sum / c.positiveSum : 0
check('自洽', '集中度 = Top3 ÷ 正流入和', approx(c.ratio, expectRatio, 0.002), `显示 ${c.ratio} vs 重算 ${fmt(expectRatio, 4)}`)

// 评分 = 加权和
const sc = signals.scores
const expectComposite = 0.45 * sc.power + 0.3 * sc.breadth + 0.25 * sc.contrarian
check('自洽', '评分 = 0.45p+0.30b+0.25c', Math.abs(signals.composite - expectComposite) <= 0.15, `显示 ${signals.composite} vs 重算 ${fmt(expectComposite, 2)}`)

// 净申购公式抽查（取成交额最大的一只）
const target = funds.slice().sort((a, b) => b.inflowNd - a.inflowNd)[0]
if (target) {
  const rows = panel.filter((r) => r.code === target.code && r.inflow !== null).sort((a, b) => a.date.localeCompare(b.date))
  if (rows.length >= 2) {
    const last = rows[rows.length - 1]
    const manual = (last.dShare * last.close) / 1e4
    check('自洽', '净申购 = Δ份额×收盘/1e4', approx(manual, last.inflow), `手算 ${fmt(manual, 6)} vs 代码 ${fmt(last.inflow, 6)}`)
  }
}

// 判词用的合计必须等于板块合计
const sectorNd = signals.sectorTotals.reduce((a, x) => a + (x.periods?.inflow_5d ?? 0), 0)
check('自洽', '判词合计 = 板块合计', approx(sectorNd, signals.basket.inflowNd, 0.01), `${fmt(sectorNd)} vs ${fmt(signals.basket.inflowNd)}`)

// ════════════════ 3. 范围检查 ════════════════

if (signals.enhancement) {
  const p = signals.enhancement.percentile
  check('范围', '分位 ∈ [0,100]', p.daily === null || inRange(p.daily, 0, 100), `${p.daily}`)
  const pers = signals.enhancement.persistence
  check('范围', '连续天数 ≤ 样本总数', pers.streak <= p.sampleDays, `${pers.streak} ≤ ${p.sampleDays}`)
  check('范围', '脉冲占比 ∈ [0,100]', pers.burstShare === null || inRange(pers.burstShare, 0, 100), `${fmt(pers.burstShare, 1)}%`)
  const diff = signals.enhancement.diffusion
  check('范围', '流入指数 ≤ 总指数', diff.inflowGroups <= diff.totalGroups, `${diff.inflowGroups} ≤ ${diff.totalGroups}`)
  check('范围', '宽基流入 ≤ 宽基总数', diff.broadInflow <= diff.broadTotal, `${diff.broadInflow} ≤ ${diff.broadTotal}`)
}

check('范围', '集中度 ∈ [0,1]', inRange(c.ratio, 0, 1), `${c.ratio}`)
check('范围', '评分 ∈ [0,100]', inRange(signals.composite, 0, 100), `${signals.composite}`)
for (const [k, v] of Object.entries(sc)) {
  check('范围', `分项 ${k} ∈ [0,100]`, inRange(v, 0, 100), `${v}`)
}

for (const it of temp?.items ?? []) {
  if (it.rank !== null && it.rank !== undefined) {
    check('范围', `${it.label}·分位 ∈ [0,100]`, inRange(it.rank, 0, 100), `${fmt(it.rank, 1)}`)
  }
  if (it.key === 'limitUp' || it.key === 'limitDown') {
    check('范围', `${it.label}·非负`, it.value >= 0, `${it.value}`)
  }
  if (it.key === 'brokenRate') {
    check('范围', '炸板率 ∈ [0,100]', inRange(it.value, 0, 100), `${fmt(it.value, 1)}%`)
  }
}

// 涨跌家数：涨+跌 不应超过当日有行情的股票数
const adv = temp?.items?.find((i) => i.key === 'advanceDecline')
if (adv?.hint) {
  const m = adv.hint.match(/(\d+)\s*涨\s*\/\s*(\d+)\s*跌/)
  if (m) {
    const total = Number(m[1]) + Number(m[2])
    const cnt = await store.pool.query(`SELECT count(*)::int n FROM stock_daily WHERE trade_date = $1::date`, [asofDash])
    check('范围', '涨+跌 ≤ 当日股票数', total <= cnt.rows[0].n, `${total} ≤ ${cnt.rows[0].n}`)
  }
}

// ════════════════ 4. 新鲜度检查 ════════════════

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000)

const shareMax = shareRows.rows.reduce((m, r) => (r.trade_date > m ? r.trade_date : m), '')
const shareMaxDash = toDash(shareMax)
const lag = daysBetween(shareMaxDash, asofDash)
check('新鲜', '份额数据不落后超过 3 个自然日', lag <= 3, `asOf=${asofDash}, 份额最新=${shareMaxDash}`)

// 每个带 dataDate 的指标，其日期不能早于 asOf 超过 3 天（T+1 允许 1 天）
for (const it of temp?.items ?? []) {
  if (!it.dataDate) continue
  const d = daysBetween(it.dataDate, asofDash)
  check('新鲜', `${it.label}·数据日期合理`, d >= 0 && d <= 3, `dataDate=${it.dataDate}, 落后 ${d} 天`)
}

// 两条链路覆盖的标的必须一致
const missingInQuotes = codes.filter((c) => !quoteRows.rows.some((r) => r.ts_code === c))
check('新鲜', '全部标的都有行情', missingInQuotes.length === 0, missingInQuotes.length ? `缺 ${missingInQuotes.join(',')}` : '52/52')

// 动量/管理人这些衍生视图不该为空
check('新鲜', '板块动量非空', sectorMomentum(panel, 5).length > 0, `${sectorMomentum(panel, 5).length} 条`)

// ════════════════ 5. 口径断言（静态）════════════════
//
// 前三类检查都基于数值，抓不住「字段选错」——把 rzye 换成 rzrqye、
// 把 pool 过滤删掉，算出来的数依然是合法数字，只是语义错了。
// 历史三次事故全部属于这一类，所以这里直接对关键 SQL 做源码断言，防回归。

const src = (f) => readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8')
const marketSrc = src('market.js')
const analyzeSrc = src('analyze.js')

check('口径', "涨停按 pool='zt' 过滤", marketSrc.includes("pool = 'zt'"), marketSrc.includes("pool = 'zt'") ? '已过滤' : "缺失：会把跌停/次新算成涨停")
check('口径', "跌停按 pool='dt' 过滤", marketSrc.includes("pool = 'dt'"), marketSrc.includes("pool = 'dt'") ? '已过滤' : '缺失')
check('口径', "炸板按 pool='zb' 过滤", marketSrc.includes("pool = 'zb'"), marketSrc.includes("pool = 'zb'") ? '已过滤' : '缺失')
check('口径', '两融用 rzrqye 而非 rzye', /sum\(rzrqye\)/.test(marketSrc), /sum\(rzrqye\)/.test(marketSrc) ? 'rzrqye ✓' : '用的是融资余额 rzye，标签不符')
check('口径', '净申购用 SHARE_TO_YI=1e4', analyzeSrc.includes('SHARE_TO_YI'), '份额万份×价格→亿元')
check('口径', '成交额除以 1e5（千元→亿元）', analyzeSrc.includes('/ 1e5'), analyzeSrc.includes('/ 1e5') ? '已换算' : '单位可能错')
check('口径', '盘中时段用 Asia/Shanghai', src('intraday.js').includes('Asia/Shanghai'), '不能用服务器本地时区')

await store.close()

// ════════════════ 输出 ════════════════

if (asJson) {
  console.log(JSON.stringify({ asof: asofDash, failed, total: results.length, results }, null, 2))
} else {
  const byCat = new Map()
  for (const r of results) {
    if (!byCat.has(r.category)) byCat.set(r.category, [])
    byCat.get(r.category).push(r)
  }
  console.log(`\n指标自检 · asOf ${asofDash} · 共 ${results.length} 项\n${'='.repeat(72)}`)
  for (const [cat, list] of byCat) {
    const bad = list.filter((r) => !r.ok).length
    console.log(`\n【${cat}】${list.length - bad}/${list.length} 通过`)
    for (const r of list) {
      const mark = r.ok ? '✓' : '✗'
      console.log(`  ${mark} ${r.name.padEnd(30)} ${r.detail}`)
    }
  }
  console.log(`\n${'='.repeat(72)}`)
  console.log(failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`)
}

process.exit(failed === 0 ? 0 : 1)
