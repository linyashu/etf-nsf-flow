/**
 * Host 端：注册 ETF 资金流工具，并通过 webServer 暴露看板数据的 HTTP 路由。
 *
 * 设计要点：
 * - 数据全部实时从 tushare 拉取，带内存缓存（默认 30 分钟），避免反复消耗积分。
 * - webServer 路由只读，前端轮询即可；不写 session log。
 */

import { BASKET, BENCH, UNIVERSE, basketCodes, buildPanel, computeSignals, fundDetail, fundSeries, groupSeries, heatmap, managerView, sectorMomentum } from './lib/analyze.js'
import { compactToDash, fetchSSELatest, fetchSharesChunked } from './lib/sources.js'
import { fetchSZSEshares, prevTradingDayGuess } from './lib/szse.js'
import { Store } from './lib/store.js'
import { marketTemperature } from './lib/market.js'
import {
  buildIntraday,
  buildMinuteSeries,
  fetchMinuteKline,
  fetchQuotes,
  sessionProgress,
  todayBeijing,
} from './lib/intraday.js'
import { fetchHolderStructure } from './lib/wind.js'
import { fmtDate, query, toObjects } from './lib/tushare.js'

export const inject = ['tools', 'webServer']

/**
 * 配置说明（不改写包内 Config，避免依赖 zod 实例）：
 * 通过 cordis.patch.yml 的 config 传入，apply(ctx, config) 读取，未传则用默认值。
 *   token          Tushare token
 *   lookbackDays   回溯交易日数，默认 120
 *   cacheMinutes   内存缓存分钟数，默认 30
 *   routePath      前端数据路由，默认 /etf-flow/data.json
 */
// 密钥一律从环境变量或 cordis.patch.yml 读取，不给默认值，避免泄露到仓库
const DEFAULT_TOKEN = process.env.TUSHARE_TOKEN || ''
/** Wind MCP key：只用于季度频率的机构持有比例。 */
const DEFAULT_WIND_KEY = process.env.WIND_API_KEY || ''

export function apply(ctx, config = {}) {
  const token = config.token || DEFAULT_TOKEN
  const lookbackDays = config.lookbackDays ?? 120
  const cacheMs = (config.cacheMinutes ?? 30) * 60_000
  const routePath = config.routePath || '/etf-flow/data.json'
  const windKey = config.windKey || DEFAULT_WIND_KEY
  const holderCacheMs = (config.holderCacheHours ?? 24) * 3_600_000

  // 本地库（TimescaleDB）。storage:'live' 可强制走实时模式。
  const storageMode = config.storage || 'db'
  const dbConfig = config.db || {
    host: process.env.ETF_DB_HOST || '127.0.0.1',
    port: Number(process.env.ETF_DB_PORT || 5432),
    user: process.env.ETF_DB_USER || 'postgres',
    password: process.env.ETF_DB_PASSWORD || '',
    database: process.env.ETF_DB_NAME || 'timescaledb',
  }
  const store = storageMode === 'db' ? new Store(dbConfig) : null

  // 机构持有比例是季度数据，单独缓存一天，不必跟着日频刷新
  let holderCache = { at: 0, data: null, inflight: null }

  /** 拉取一次全量数据并计算。 */
  /** 实时模式：直接拉 tushare + 上交所。库不可用时的降级路径。 */
  async function acquireLive({ codes, codeSet, signal }) {
    const today = new Date()
    const end = ymdCompact(today)
    const startDate = new Date(today.getTime() - lookbackDays * 2.2 * 86400000)
    const start = ymdCompact(startDate)

    // fund_share 单次上限 2000 行，52 只时只能覆盖约 38 个交易日，
    // 所以按交易日分段拉取再合并（详见 lib/sources.js 的 fetchSharesChunked）。
    const [chunked, benchRes, basicRes] = await Promise.all([
      fetchSharesChunked({ token, codes, start, end, signal }),
      query(token, 'index_daily', { ts_code: BENCH.code, start_date: start, end_date: end }, 'trade_date,pct_chg,close', { signal }),
      query(token, 'fund_basic', { market: 'E' }, 'ts_code,name,management', { signal }).catch(() => ({ fields: [], items: [] })),
    ])

    const shares = chunked.rows
    const wanted = new Set(shares.map((r) => r.trade_date))
    const quotes = []
    for (const d of [...wanted].sort()) {
      const q = await query(token, 'fund_daily', { trade_date: d }, 'ts_code,trade_date,close,pct_chg,amount', { signal })
      for (const row of toObjects(q)) {
        if (codeSet.has(row.ts_code)) quotes.push(row)
      }
    }

    // ── 沪市补当日 ──
    // tushare 的份额是 T+1，当晚往往只回填部分交易所；上交所官网当晚即有全量。
    const shareDates = new Set(shares.map((r) => r.trade_date))
    let latestShareDate = [...shareDates].sort().pop() ?? null
    let sseSupplement = null
    try {
      const sse = await fetchSSELatest({ signal })
      if (sse.date) {
        const dash = compactToDash(sse.date)
        const compactDate = sse.date.replace(/-/g, '')
        if (!shareDates.has(compactDate)) {
          let added = 0
          for (const code of codeSet) {
            if (!code.endsWith('.SH')) continue
            const vol = sse.shares.get(code)
            if (!Number.isFinite(vol)) continue
            shares.push({ ts_code: code, trade_date: compactDate, fd_share: vol })
            added += 1
          }
          if (added > 0) {
            sseSupplement = { date: dash, funds: added }
            shareDates.add(compactDate)
            latestShareDate = compactDate
          }
        }
      }
    } catch {
      // 官网不可达时静默降级，不影响主数据
    }

    const quoteDates = new Set(quotes.map((q) => q.trade_date))
    if (latestShareDate && !quoteDates.has(latestShareDate)) {
      const q = await query(token, 'fund_daily', { trade_date: latestShareDate }, 'ts_code,trade_date,close,pct_chg,amount', { signal })
      for (const row of toObjects(q)) {
        if (codeSet.has(row.ts_code)) quotes.push(row)
      }
    }

    return {
      shares,
      quotes,
      benchRows: toObjects(benchRes),
      basics: toObjects(basicRes),
      sseSupplement,
      latestShareDate,
      chunks: chunked.chunks,
      storage: 'live',
      sync: null,
    }
  }

  /**
   * 库模式：只读本地库，不做任何写入。
   *
   * 采集统一由 mac-mini 上 stock_wiki 的每日流水线负责
   * （launchd com.stockwiki.ingest-daily，19:05，任务 etf_share / etf_daily / etf_basic）。
   * 插件只负责读——避免出现第二套同步逻辑。
   */
  async function acquireFromStore({ codes, signal }) {
    void signal
    const t0 = Date.now()
    const fromDate = ymdCompact(new Date(Date.now() - lookbackDays * 1.9 * 86400000))
    const data = await store.load(codes, compactToDash(fromDate), BENCH.code)
    if (!data || !data.shares.length) throw new Error('本地库中无可用份额数据')

    const latestShareDate = data.shares.reduce((a, r) => (r.trade_date > a ? r.trade_date : a), '')
    return {
      shares: data.shares,
      quotes: data.quotes,
      benchRows: data.bench,
      basics: data.basics,
      sseSupplement: null,
      latestShareDate: latestShareDate || null,
      chunks: null,
      storage: 'db',
      readMs: Date.now() - t0,
    }
  }

  async function compute(signal, opts = {}) {
    const codes = basketCodes()
    const codeSet = new Set(codes)

    // 库优先。连不上或读失败自动降级到实时模式——数据库挂了看板也必须能打开。
    let acquired = null
    let storeError = null
    if (store) {
      try {
        const opened = await store.open()
        const schemaOk = opened ? await store.ensureSchema() : false
        if (schemaOk) {
          acquired = await acquireFromStore({ codes, signal })
        } else {
          storeError = store.lastError || '无法连接本地库'
        }
      } catch (err) {
        acquired = null
        storeError = String(err?.message || err).slice(0, 120)
      }
    }
    if (!acquired) acquired = await acquireLive({ codes, codeSet, signal })

    const { shares, quotes, benchRows, basics, sseSupplement, latestShareDate, chunks, storage, readMs } = acquired

    // ── 深市份额补齐（深交所官方快照）──
    // tushare 的深市回填极慢（实测 11-04 数据到 11-05 下午仍未入库），
    // 而深交所官方列表能拿到 T-1 确认值，正好补上最新缺口。
    //
    // ⚠️ 深交所 metadata.subname 是页面日期，不是数据日期。
    // 实测 11-10 页面拿到的值 == 库内 11-09（25/25 完全一致），
    // 所以 trade_date 必须显式标记为「目标日」，由后端用完整度校验确认它到底是哪天。
    let szseSupplement = null
    if (store?.pool && !opts.asOf) {
      try {
        const szWanted = [...codeSet].filter((c) => c.endsWith('.SZ')).map((c) => c.split('.')[0])
        const snap = await fetchSZSEshares(szWanted, { signal })
        if (snap.shares.size >= szWanted.length * 0.8) {
          // 判断快照对应哪个交易日：与库里已有的深市数据比对，
          // 完全一致的那天就是它的真实数据日。比对不上说明是新的一天，用「昨天」兜底。
          const existing = new Map()
          for (const r of shares) {
            if (!r.ts_code.endsWith('.SZ')) continue
            const k = `${r.trade_date}|${r.ts_code}`
            existing.set(k, Number(r.fd_share))
          }
          const candidateDates = [...new Set([...existing.keys()].map((k) => k.split('|')[0]))].sort().reverse().slice(0, 6)
          let matchedDate = null
          for (const d of candidateDates) {
            let same = 0
            let total = 0
            for (const [code, vol] of snap.shares) {
              const lib = existing.get(`${d}|${code}`)
              if (lib === undefined) continue
              total += 1
              if (Math.abs(lib - vol) < 2) same += 1
            }
            if (total >= snap.shares.size * 0.8 && same >= total * 0.95) {
              matchedDate = d
              break
            }
          }
          // 若与库内某天完全一致 → 那天已入库，无需补；
          // 若都不一致 → 这是库内还没有的新数据，按「T-1」标记
          if (!matchedDate) {
            const guess = prevTradingDayGuess().replace(/-/g, '')
            let added = 0
            for (const [code, vol] of snap.shares) {
              shares.push({ ts_code: code, trade_date: guess, fd_share: vol })
              added += 1
            }
            if (added > 0) {
              szseSupplement = { date: guess, funds: added, subname: snap.subname, matched: false }
            }
          } else {
            szseSupplement = { date: matchedDate, funds: 0, subname: snap.subname, matched: true }
          }
        }
      } catch {
        // 官网不可达时静默降级，不影响主数据
      }
    }

    // ── 统计截止日选择 ──
    // 深市份额常滞后 1~2 天，最新日往往是「半边数据」，合计被系统性低估。
    // 让用户能选一个两边都齐的截止日，比看一个不完整的「最新」更有判断价值。
    const rawAsOf = opts.asOf ? String(opts.asOf).trim() : null
    // 'latest' 是保留字，强制看最新（哪怕不完整）；其余必须是可解析的日期。
    // 非法值必须报错，不能静默退回默认——否则用户以为切了日期，
    // 实际看的是另一天，这比直接报错危险得多。
    let asOfWant = null
    if (rawAsOf) {
      if (/^latest$/i.test(rawAsOf)) {
        asOfWant = 'latest'
      } else {
        const digits = rawAsOf.replace(/-/g, '').replace(/[^0-9]/g, '')
        if (!/^\d{8}$/.test(digits)) {
          throw new Error(`asOf 参数无效：${rawAsOf}（应为 latest 或 2026-11-03）`)
        }
        // 8 位数字不代表是真实日期：20261399 / 20260230 都能过正则。
        // 用 Date 往返校验能挡住所有不存在的日期（含闰年）。
        const y = Number(digits.slice(0, 4))
        const mo = Number(digits.slice(4, 6))
        const d = Number(digits.slice(6, 8))
        const probe = new Date(Date.UTC(y, mo - 1, d))
        if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
          throw new Error(`asOf 不是有效日期：${rawAsOf}`)
        }
        asOfWant = digits
      }
    }

    const names = {}
    for (const b of basics) {
      if (codeSet.has(b.ts_code)) names[b.ts_code] = { name: b.name, manager: b.management }
    }

    const benchPct = new Map()
    const benchClose = new Map()
    for (const r of benchRows) {
      benchPct.set(r.trade_date, Number(r.pct_chg))
      benchClose.set(r.trade_date, Number(r.close))
    }

    // 机构持有比例：只取宽基核心，季度频率，长缓存。
    // 失败不影响主看板，holders 为空即可。
    const holderCodes = UNIVERSE.filter((u) => u.sector === '宽基').flatMap((u) => u.codes)
    let holders = { rows: [], error: null, fetchedAt: null }
    try {
      holders = await getHolders(holderCodes, signal)
    } catch {
      // 保持空结果
    }

    const panel = buildPanel(shares, quotes, benchPct)
    if (!panel.length) throw new Error('未取到任何 ETF 数据，请检查 token 与观察池代码')

    // ── 每日完整度（必须在截断之前算）──
    // 顺序很关键：完整度要基于【全量 panel】计算，才能知道「最后一个完整日」是哪天；
    // 而截断又要用这个结果来决定默认 asOf。先算全量 → 定 asOf → 再截断。
    const needSH = codeSet.size ? [...codeSet].filter((c) => c.endsWith('.SH')).length : 0
    const needSZ = codeSet.size ? [...codeSet].filter((c) => c.endsWith('.SZ')).length : 0
    const dayCoverage = new Map()
    for (const r of panel) {
      if (r.inflow === null) continue
      const c = dayCoverage.get(r.date) ?? { sh: new Set(), sz: new Set() }
      if (r.code.endsWith('.SH')) c.sh.add(r.code)
      else c.sz.add(r.code)
      dayCoverage.set(r.date, c)
    }
    const coverageList = [...dayCoverage.entries()]
      .map(([d, c]) => ({
        date: d,
        sh: c.sh.size,
        sz: c.sz.size,
        complete: c.sh.size >= needSH * 0.9 && c.sz.size >= needSZ * 0.9,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
    const lastComplete = [...coverageList].reverse().find((x) => x.complete) ?? null
    const lastDay = coverageList[coverageList.length - 1] ?? null

    // ── 默认截止日 ──
    // 默认用最后一个「沪深都齐」的交易日。理由：不完整最新日会让合计低估 30%+，
    // 打开就看到可信的数 比 追赶当天更重要。用户仍可手动切到最新。
    //   asOf = 'latest' → 强制最新（哪怕不完整）
    //   asOf = '2026-11-03' → 指定日期
    //   asOf 缺省 → 最后完整日
    const wantLatest = asOfWant === 'latest'
    const asOfPick = wantLatest
      ? (lastDay?.date ?? null)
      : (asOfWant || lastComplete?.date || lastDay?.date || null)
    const isDefaultComplete = !wantLatest && !asOfWant

    // 限制到最近 lookbackDays 个交易日（截断到 asOfPick）
    const panelUpTo = asOfPick ? panel.filter((r) => r.date <= asOfPick) : panel
    const allDates = [...new Set(panelUpTo.map((r) => r.date))].sort().slice(-lookbackDays)
    const keep = new Set(allDates)
    const trimmed = panelUpTo.filter((r) => keep.has(r.date))

    const signals = computeSignals(trimmed, 5)
    // 主图右轴要用真实收盘点位，而不是日涨跌幅（评审 P1：日涨跌当指数点位会被误读）
    signals.series = signals.series.map((pt) => ({
      ...pt,
      benchClose: benchClose.get(pt.date.replace(/-/g, '')) ?? null,
    }))
    // 市场温度：描述性指标，失败不影响主看板
    let temperature = null
    if (store?.pool) {
      try {
        temperature = await marketTemperature(store.pool, fmtDate(allDates[allDates.length - 1]))
      } catch {
        temperature = null
      }
    }

    // 盘中量能预警：份额是 T+1，这是唯一能「当天就知道」的信号。
    //
    // 卡片必须在任何时刻都可见——曾两次因为「这个时点没意义」而隐藏整张卡，
    // 用户都以为是坏了（盘前 / 收盘后各一次）。正确做法是让口径随时刻变化：
    //
    //   盘前 pre         → 行情仍是上一交易日，展示「上一交易日全天」并标注日期
    //   交易中/收盘后     → 行情是今天，展示今日实时/全天
    //   非交易日（周末）  → 行情是上一交易日，等同于「上一交易日全天」
    //
    // 唯一不显示的情况：行情拉取失败或库不可用（真要报错的场景）。
    let intraday = null
    let intradayError = null
    if (store?.pool) {
      try {
        const [quotes, avg] = await Promise.all([
          fetchQuotes(codes, { signal }),
          store.dailyAvgAmount(codes, 20),
        ])
        // 分时曲线：只拉成交额 Top 8，避免 52 个请求把接口打挂。
        // 8 只大 ETF 的加权价足以代表池子的日内走势。
        let minuteSeries = null
        if (quotes.size) {
          try {
            const topCodes = [...quotes.entries()]
              .sort((a, b) => (b[1].amountYi ?? 0) - (a[1].amountYi ?? 0))
              .slice(0, 8)
              .map(([code]) => code)
            const klines = await Promise.all(topCodes.map((c) => fetchMinuteKline(c, { signal })))
            const merged = buildMinuteSeries(klines, { date: todayBeijing() })
            minuteSeries = merged.length > 1 ? merged : null
          } catch {
            minuteSeries = null
          }
        }

        intraday = buildIntraday(quotes, avg, {
          now: new Date(),
          asOfDate: fmtDate(allDates[allDates.length - 1]),
          minuteSeries,
        })
        if (intraday) {
          // isToday=false 时前端会标明「这是上一交易日的数据」，避免误读为今日
          intraday.isToday = intraday.asOfDate === todayBeijing()
        }
      } catch (err) {
        // 静默失败曾导致整张卡消失且无法排查，至少要留痕
        intraday = null
        intradayError = String(err?.message || err).slice(0, 200)
      }
    }

    const funds = fundDetail(trimmed, 5, names)
    const gSeries = groupSeries(trimmed, Math.min(lookbackDays, 120))
    const fSeries = fundSeries(trimmed, Math.min(lookbackDays, 120))
    const momentum = sectorMomentum(trimmed, 5)
    const managers = managerView(trimmed, names, 30)
    // 热力表：返回「按绝对值排序的前 N 组」+ 全部宽基组，前端可展开到全量。
    // topGroups 用 13 而不是 11 —— 正好覆盖全部宽基指数，多出的列前端默认折叠。
    const heat = heatmap(trimmed, { days: 20, topGroups: 18 })

    const benchSeries = allDates.map((d) => ({
      date: fmtDate(d),
      close: benchClose.get(d) ?? null,
    }))

    // 分市场的实际数据日：沪深披露节奏不同，这是本产品独有的状态信息
    const dateOf = (prefix) => {
      const ds = trimmed.filter((r) => r.code.endsWith(prefix)).map((r) => r.date)
      return ds.length ? ds.sort().pop() : null
    }
    const shCount = funds.filter((f) => f.code.endsWith('.SH')).length
    const szCount = funds.length - shCount
    const latestQuote = quotes.length ? [...new Set(quotes.map((q) => q.trade_date))].sort().pop() : null

    // ── 缺口量化 ──
    // 沪深披露节奏不同：深市份额通常滞后 1~2 个交易日。
    // 缺口日的深市标的按 0 计入（保证「合计=各基金之和」成立），
    // 但这会让合计**系统性低估**。必须把低估幅度算出来，否则用户会把
    // 「+1,800 亿」当成完整口径 —— 实际可能少了两成以上。
    const szLagDate = fmtDate(dateOf('.SZ'))
    const shLagDate = fmtDate(dateOf('.SH'))
    // 必须用「截断后」的日期轴末端判断，不能用 latestShareDate——
    // 用户把截止日切到 11-03 时，latestShareDate 仍是 11-04，
    // 会导致明明两边都齐还报「口径不完整」。
    const latestShareDay = fmtDate(allDates[allDates.length - 1])
    const szLagging = Boolean(szLagDate && latestShareDay && szLagDate < latestShareDay)

    // 缺口日的深市份额变化无法得知，**不能靠外推猜一个数**——那会造假数据。
    // 改为报告可验证的事实：受影响标的的规模占比。占比越大，低估越显著。
    let szMissingGroups = []
    let szScaleShare = null
    if (szLagging) {
      const szFunds = funds.filter((f) => f.code.endsWith('.SZ'))
      const totalScale = funds.reduce((a, f) => a + (f.share * f.close) / 1e4, 0)
      const szScale = szFunds.reduce((a, f) => a + (f.share * f.close) / 1e4, 0)
      szScaleShare = totalScale > 0 ? Math.round((szScale / totalScale) * 1000) / 10 : null
      // 纯深市组（全部标的都在深市）受影响最彻底；混合组只是部分标的缺
      szMissingGroups = signals.groups
        .filter((g) => g.codes.every((c) => c.endsWith('.SZ')))
        .map((g) => g.group)
        .sort()
    }

    return {
      generatedAt: new Date().toISOString(),
      asOf: signals.asOf,
      freshness: {
        // 当前所看数据的截止日（受 asOf 影响），不是库里最新日
        shareDate: fmtDate(allDates[allDates.length - 1]),
        quoteDate: latestQuote ? fmtDate(latestQuote) : null,
        shDate: fmtDate(dateOf('.SH')),
        szDate: fmtDate(dateOf('.SZ')),
        sseSupplement,
        szseSupplement,
        shCount,
        szCount,
        shareChunks: chunks,
        storage,
        readMs: readMs ?? null,
        storeError,
        note: sseSupplement
          ? `沪市已补至 ${sseSupplement.date}（${sseSupplement.funds} 只），深市仍为上一交易日`
          : null,
        // 每日完整度与「最后一个两边都齐的日子」，供用户切换截止日
        coverage: {
          needSH,
          needSZ,
          // 当前截止日的来源：default-complete（默认完整日）/ latest（强制最新）/ explicit（用户指定）
          pickedBy: isDefaultComplete ? 'default-complete' : wantLatest ? 'latest' : 'explicit',
          isDefaultComplete,
          lastCompleteDate: lastComplete ? fmtDate(lastComplete.date) : null,
          lastDate: lastDay ? fmtDate(lastDay.date) : null,
          // lastIsComplete 指「库里最新那一天」是否完整（与用户所选无关）。
          // 当前所看那天是否完整用 pickedIsComplete，两者语义不同，别混用。
          lastIsComplete: Boolean(lastDay?.complete),
          pickedIsComplete: Boolean(
            coverageList.find((x) => x.date === asOfPick)?.complete ??
              (asOfPick ? false : Boolean(lastComplete)),
          ),
          days: coverageList.slice(-30).map((x) => ({
            date: fmtDate(x.date),
            sh: x.sh,
            sz: x.sz,
            complete: x.complete,
          })),
        },
        // 缺口标记：UI 用它决定是否显示「口径不完整」提示
        lag: {
          szLagging: Boolean(szLagging),
          latestShareDay,
          shDate: shLagDate,
          szDate: szLagDate,
          missingDays: null,
          szFundCount: szCount,
          szMissingGroups,
          // 受影响标的占总规模的比例（%）。这是可验证的事实，不是外推估算
          szScaleShare,
          lastCompleteDate: lastComplete ? fmtDate(lastComplete.date) : null,
        },
      },
      universe: UNIVERSE,
      coverage: {
        from: fmtDate(allDates[0]),
        to: fmtDate(allDates[allDates.length - 1]),
        tradingDays: allDates.length,
        fundCount: funds.length,
      },
      signals,
      funds,
      holders,
      momentum,
      managers,
      temperature,
      intraday,
      intradayError,
      heatmap: heat,
      seriesGroups: gSeries,
      seriesFund: fSeries,
      benchSeries,
      basket: BASKET,
      bench: BENCH,
    }
  }

  /** 带长缓存的机构持有比例。季度数据，一天拉一次足够。 */
  async function getHolders(codes, signal) {
    const fresh = holderCache.data && Date.now() - holderCache.at < holderCacheMs
    if (fresh) return holderCache.data
    if (holderCache.inflight) return holderCache.inflight

    holderCache.inflight = (async () => {
      const res = await fetchHolderStructure(codes, windKey, { signal })
      const data = { rows: res.rows, error: res.error, fetchedAt: new Date().toISOString() }
      // 只有成功拿到数据才写缓存，失败下次重试
      if (res.rows.length) {
        holderCache = { at: Date.now(), data, inflight: null }
      } else {
        holderCache.inflight = null
      }
      return data
    })()
    return holderCache.inflight
  }

  // 缓存按 asOf 分桶：不同截止日的数据必须分开缓存，
  // 否则用户切回已看过的日期会命中另一天的缓存，数字莫名跳变。
  const payloadCache = new Map()

  async function getData({ force = false, signal, asOf = null } = {}) {
    const key = asOf || '__latest__'
    const hit = payloadCache.get(key)
    if (hit && Date.now() - hit.at < cacheMs && !force) return hit.payload
    if (hit?.inflight) return hit.inflight

    const entry = { at: 0, payload: null, inflight: null }
    entry.inflight = (async () => {
      try {
        const payload = await compute(signal, { asOf })
        payloadCache.set(key, { at: Date.now(), payload, inflight: null })
        return payload
      } catch (err) {
        payloadCache.delete(key)
        throw err
      }
    })()
    payloadCache.set(key, entry)
    return entry.inflight
  }

  // ---- HTTP 路由：前端拉取数据 ----
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: routePath,
      async handler(req, res) {
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          const force = url.searchParams.get('refresh') === '1'
          const asOf = url.searchParams.get('asOf')
          const payload = await getData({ force, asOf })
          const body = JSON.stringify(payload)
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': Buffer.byteLength(body),
          })
          res.end(body)
        } catch (err) {
          const body = JSON.stringify({ error: String(err?.message || err) })
          res.writeHead(502, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(body)
        }
      },
    }),
  )

  // ---- 工具：让 Agent 也能查这份数据 ----
  // 插件卸载时释放数据库连接池
  if (store) {
    ctx.on('dispose', () => {
      void store.close()
    })
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'etf_nsf_flow',
      description:
        '查询 A 股宽基 ETF 的资金流向，用于判断「国家队」入场情况。' +
        '核心口径是净申购额 = Δ基金总份额 × 收盘价；份额增加意味着真实申购，' +
        '区别于只反映换手的成交额。返回综合评分、各指数净申购排行与单只 ETF 明细。',
      parameters: {
        type: 'object',
        properties: {
          lookback: {
            type: 'number',
            description: '统计窗口的交易日数，默认 5。',
            default: 5,
          },
          forceRefresh: {
            type: 'boolean',
            description: '忽略缓存，强制重新拉取。',
            default: false,
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render(args, value) {
          return [{ type: 'text', text: formatForModel(value) }]
        },
      },
      async execute(args) {
        const payload = await getData({ force: Boolean(args?.forceRefresh) })
        const lookback = Number(args?.lookback ?? 5)
        const s = payload.signals
        const groups = s.groups.map((g) => ({
          ...g,
          inflow: g.periods[`inflow_${lookback}d`] ?? g.inflowNd,
        }))
        return {
          asOf: s.asOf,
          regime: s.regime,
          note: s.note,
          composite: s.composite,
          scores: s.scores,
          basket: s.basket,
          lookback,
          sectors: (s.sectorTotals ?? []).map((st) => ({
            sector: st.sector,
            inflowYi: st.periods[`inflow_${lookback}d`] ?? st.inflowNd,
            breadth: st.breadth,
            scaleYi: st.scaleYi,
            groups: st.groups,
          })),
          groups: groups.map((g) => ({
            group: g.group,
            sector: g.sector,
            inflowYi: g.inflow,
            scaleYi: g.scaleYi,
            power: g.power,
            persistence: g.persistence,
            contrarian: g.contrarian,
          })),
          topFunds: payload.funds
            .slice()
            .sort((a, b) => (b.periods[`inflow_${lookback}d`] ?? 0) - (a.periods[`inflow_${lookback}d`] ?? 0))
            .slice(0, 8)
            .map((f) => ({
              code: f.code,
              name: f.name,
              group: f.group,
              inflowYi: f.periods[`inflow_${lookback}d`] ?? 0,
              shareYi: f.share,
            })),
          freshness: payload.freshness,
          caveat: '份额数据不含持有人身份，宽基 ETF 巨量申赎是强相关性证据，非直接持股披露；深市份额 T+1。',
        }
      },
    }),
  )

  // ---- 插件内可直接调用的服务（非必需，失败不影响看板） ----
  if (typeof ctx.provide === 'function') {
    ctx.provide('etfFlow', { getData, refresh: () => getData({ force: true }) })
  }
}

function ymdCompact(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function formatForModel(v) {
  const lines = []
  lines.push(`【国家队 ETF 资金流】截至 ${v.asOf}｜状态：${v.regime}（综合 ${v.composite}/100）`)
  lines.push(`${v.note}`)
  lines.push(
    `分项：净申购强度 ${v.scores.power}｜流入广度 ${v.scores.breadth}｜逆势托底 ${v.scores.contrarian}`,
  )
  lines.push(
    `观察池近 ${v.lookback} 日净申购 ${v.basket.inflowNd} 亿元（最新单日 ${v.basket.inflowLatest} 亿元）`,
  )
  if (v.sectors?.length) {
    lines.push('板块净申购（亿元，回答「钱去了哪些板块」）：')
    for (const st of v.sectors) {
      lines.push(
        `  ${st.sector}: ${st.inflowYi > 0 ? '+' : ''}${st.inflowYi}（规模 ${st.scaleYi} 亿，含 ${st.groups.length} 个指数，流入占比 ${(st.breadth * 100).toFixed(0)}%）`,
      )
    }
  }
  lines.push('细分指数净申购（亿元）：')
  for (const g of v.groups) {
    lines.push(
      `  [${g.sector}] ${g.group}: ${g.inflowYi > 0 ? '+' : ''}${g.inflowYi}（规模 ${g.scaleYi} 亿，强度 ${g.power}x）`,
    )
  }
  if (v.topFunds.length) {
    lines.push('个股/单只 ETF 前几名：')
    for (const f of v.topFunds) {
      lines.push(`  ${f.name}(${f.code}) ${f.inflowYi > 0 ? '+' : ''}${f.inflowYi} 亿元`)
    }
  }
  if (v.freshness?.note) lines.push(`数据新鲜度：${v.freshness.note}`)
  lines.push(`注意：${v.caveat}`)
  return lines.join('\n')
}
