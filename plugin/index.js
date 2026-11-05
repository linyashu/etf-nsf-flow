/**
 * Host 端：注册 ETF 资金流工具，并通过 webServer 暴露看板数据的 HTTP 路由。
 *
 * 设计要点：
 * - 数据全部实时从 tushare 拉取，带内存缓存（默认 30 分钟），避免反复消耗积分。
 * - webServer 路由只读，前端轮询即可；不写 session log。
 */

import { BASKET, BENCH, UNIVERSE, basketCodes, buildPanel, computeSignals, fundDetail, fundSeries, groupSeries, heatmap, managerView, sectorMomentum } from './lib/analyze.js'
import { compactToDash, fetchSSELatest, fetchSharesChunked } from './lib/sources.js'
import { Store } from './lib/store.js'
import { marketTemperature } from './lib/market.js'
import { buildIntraday, fetchQuotes, sessionProgress, todayBeijing } from './lib/intraday.js'
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

  let cache = { at: 0, payload: null, inflight: null }
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

  async function compute(signal) {
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

    // 限制到最近 lookbackDays 个交易日
    const allDates = [...new Set(panel.map((r) => r.date))].sort().slice(-lookbackDays)
    const keep = new Set(allDates)
    const trimmed = panel.filter((r) => keep.has(r.date))

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
    if (store?.pool) {
      try {
        const [quotes, avg] = await Promise.all([
          fetchQuotes(codes, { signal }),
          store.dailyAvgAmount(codes, 20),
        ])
        intraday = buildIntraday(quotes, avg, {
          now: new Date(),
          asOfDate: fmtDate(allDates[allDates.length - 1]),
        })
        if (intraday) {
          // isToday=false 时前端会标明「这是上一交易日的数据」，避免误读为今日
          intraday.isToday = intraday.asOfDate === todayBeijing()
        }
      } catch {
        intraday = null
      }
    }

    const funds = fundDetail(trimmed, 5, names)
    const gSeries = groupSeries(trimmed, Math.min(lookbackDays, 120))
    const fSeries = fundSeries(trimmed, Math.min(lookbackDays, 120))
    const momentum = sectorMomentum(trimmed, 5)
    const managers = managerView(trimmed, names, 30)
    const heat = heatmap(trimmed, { days: 20, topGroups: 11 })

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

    return {
      generatedAt: new Date().toISOString(),
      asOf: signals.asOf,
      freshness: {
        shareDate: fmtDate(latestShareDate ?? allDates[allDates.length - 1]),
        quoteDate: latestQuote ? fmtDate(latestQuote) : null,
        shDate: fmtDate(dateOf('.SH')),
        szDate: fmtDate(dateOf('.SZ')),
        sseSupplement,
        shCount,
        szCount,
        shareChunks: chunks,
        storage,
        readMs: readMs ?? null,
        storeError,
        note: sseSupplement
          ? `沪市已补至 ${sseSupplement.date}（${sseSupplement.funds} 只），深市仍为上一交易日`
          : null,
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

  async function getData({ force = false, signal } = {}) {
    const fresh = cache.payload && Date.now() - cache.at < cacheMs
    if (fresh && !force) return cache.payload
    if (cache.inflight) return cache.inflight

    cache.inflight = (async () => {
      try {
        const payload = await compute(signal)
        cache = { at: Date.now(), payload, inflight: null }
        return payload
      } catch (err) {
        cache.inflight = null
        throw err
      }
    })()
    return cache.inflight
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
          const payload = await getData({ force })
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
