import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { DashboardPayload, FundSeriesPoint } from '../types'
import { nf, periodValue, signed, toneOf } from '../format'
import { ErrorBoundary } from './ErrorBoundary'
import { FlowChart } from './FlowChart'
import { FundChart } from './FundChart'
import { Gauge } from './Gauge'
import { HeatmapTable } from './HeatmapTable'

const DATA_URL = '/etf-flow/data.json'

const RANGES = [20, 60, 120] as const

/** 按真实交易日数裁剪区间档位，避免出现「点了没反应」的禁用按钮。 */
function rangeOptionsFor(days: number): Array<number | 'all'> {
  // 只保留「覆盖天数 < 全部天数」的档位。
  // 原先用 days+1 容差，119 天时会出现「120 日」档，但它与「全部」渲染完全相同的 119 点，
  // 点了没有任何变化——正是要消灭的「点了没反应」。
  return [...RANGES.filter((r) => r < days), 'all']
}

function effectiveRangeOf(rangeN: number | 'all', days: number): number | 'all' {
  const ok = rangeOptionsFor(days)
  return ok.includes(rangeN) ? rangeN : 'all'
}
const LOOKBACKS = [1, 5, 10, 20] as const

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-etf-line1 bg-etf-layer1 p-5 ${className}`}>{children}</div>
}

function Head({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
      <h2 className="m-0 text-emph font-medium">{title}</h2>
      {meta && <div className="text-meta text-etf-faint">{meta}</div>}
    </div>
  )
}

/** 分段控件：带 aria-pressed，选中态统一为「变亮」。 */
function Seg<T extends number | 'all'>({
  options,
  value,
  onChange,
  format,
  disabled,
  label,
}: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  format: (v: T) => string
  disabled?: (v: T) => boolean
  label: string
}) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label={label}>
      <span className="text-meta leading-none text-etf-faint">{label}</span>
      <div className="inline-flex items-center gap-0.5">
        {options.map((o) => {
          const off = disabled?.(o) ?? false
          return (
            <button
              key={String(o)}
              type="button"
              aria-pressed={value === o}
              disabled={off}
              onClick={() => !off && onChange(o)}
              className={[
                'cursor-pointer rounded px-2 py-1 text-meta tabular-nums transition-colors duration-150',
                off
                  ? 'cursor-default text-etf-faint opacity-40'
                  : value === o
                    ? 'bg-etf-layer2 font-medium text-etf-text'
                    : 'text-etf-muted hover:text-etf-text',
              ].join(' ')}
            >
              {format(o)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** generatedAt 是 UTC ISO 串，必须转本地时区，否则北京用户会看到早 8 小时的时间。 */
function fmtLocalTime(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 分位条：把「历史第几分位」画成一条可读刻度。 */
function PercentileBar({ pct, marks }: { pct: number | null; marks: Array<{ p: number; value: number }> }) {
  if (pct === null) return null
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="mt-1.5">
      <div
        className="relative h-1 rounded-sm bg-etf-layer2"
        role="img"
        aria-label={`历史分位 ${Math.round(clamped)}%，0 到 100 分位区间`}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-sm bg-etf-in"
          style={{ width: `${clamped}%` }}
        />
        {[50, 90].map((m) => (
          <span key={m} aria-hidden className="absolute inset-y-0 w-px bg-etf-line2" style={{ left: `${m}%` }} />
        ))}
      </div>
      {/* 端点必须对称：左端只写「低」、右端却给具体金额，会让人以为右端就是 90 分位刻度线 */}
      <div className="mt-1 flex justify-between font-etf-mono text-meta tabular-nums text-etf-faint">
        <span>0</span>
        <span>100</span>
      </div>
      {marks.length > 0 && (
        <div className="mt-0.5 text-meta leading-4 text-etf-faint">
          达到 90 分位需单日 {nf(marks.find((m) => m.p === 90)?.value ?? 0, 0)} 亿
        </div>
      )}
    </div>
  )
}

/** 标签 + 数值，用于合并后的紧凑区块。 */
function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-meta text-etf-faint">{label}</div>
      <div className={`mt-1 font-etf-mono text-body tabular-nums ${tone ?? 'text-etf-text'}`}>{value}</div>
    </div>
  )
}

/** 从走势序列派生展开区的指标。 */
function fundStats(series: FundSeriesPoint[]) {
  if (series.length < 2) return null
  const first = series[0]
  const last = series[series.length - 1]
  const inflowSum = series.reduce((a, d) => a + d.inflow, 0)
  const sharePct = first.share > 0 ? ((last.share - first.share) / first.share) * 100 : 0

  let streak = 0
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i].inflow > 0) streak += 1
    else break
  }

  const shares = series.map((d) => d.share)
  const lo = Math.min(...shares)
  const hi = Math.max(...shares)
  const pos = hi > lo ? ((last.share - lo) / (hi - lo)) * 100 : 50

  return { sharePct, inflowSum, streak, pos, last }
}

/**
 * 判词只放结论本身，保持一行内读完。
 * 数据口径之类的附注移到卡片底部/脚注，避免主句被日期折行打断（曾出现「深市 2026-」换行）。
 */
function buildVerdict(
  composite: number,
  lookK: number,
  basketNd: number,
  top3: Array<{ group: string }>,
  ratio: number,
): string {
  const verb = composite >= 55 ? '国家队在买' : composite >= 35 ? '动作不明显' : '资金在撤'
  const names = top3.slice(0, 3).map((t) => t.group).join('、')
  const pct = Math.round(ratio * 100)
  return `${verb}：近 ${lookK} 日 ${signed(basketNd, 1)} 亿，${pct}% 集中在 ${names}。`
}

function Dashboard() {
  const [data, setData] = useState<DashboardPayload | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [staleNote, setStaleNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lookK, setLookK] = useState<number>(5)
  const [rangeN, setRangeN] = useState<number | 'all'>(60)
  const [expandedCode, setExpandedCode] = useState<string | null>(null)
  const [rankMode, setRankMode] = useState<'sector' | 'group'>('sector')
  const [rankAll, setRankAll] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [query, setQuery] = useState('')
  const [sectorFilter, setSectorFilter] = useState<string>('all')

  const load = useCallback(async (force: boolean) => {
    if (force) setRefreshing(true)
    else setLoading(true)
    try {
      const res = await fetch(DATA_URL + (force ? '?refresh=1' : ''), { cache: 'no-store' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const json = (await res.json()) as DashboardPayload
      // schema 守卫：宁可走错误态，也不要渲染空白
      if (!json?.signals || !Array.isArray(json.funds) || !json.signals.basket) {
        throw new Error('返回数据缺少关键字段')
      }
      setData(json)
      setErr(null)
      setStaleNote(null)
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      // 刷新失败时保留旧数据，并明确告诉用户「这是旧数据」
      setData((prev) => {
        if (prev) {
          setStaleNote(`更新失败（${msg}），仍显示 ${prev.generatedAt?.slice(11, 16) ?? '上一次'} 的数据`)
        } else {
          setErr(msg)
        }
        return prev
      })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const s = data?.signals

  const sectors = useMemo(() => {
    if (!s?.sectorTotals) return []
    return s.sectorTotals
      .map((st) => ({ name: st.sector, val: periodValue(st.periods, lookK, st.inflowNd) }))
      .sort((a, b) => b.val - a.val)
  }, [s, lookK])

  const groups = useMemo(() => {
    if (!s?.groups) return []
    return s.groups
      .map((g) => ({ name: g.group, val: periodValue(g.periods, lookK, g.inflowNd) }))
      .sort((a, b) => b.val - a.val)
  }, [s, lookK])

  const funds = useMemo(() => {
    if (!data?.funds) return []
    return data.funds
      .map((x) => ({ ...x, val: periodValue(x.periods, lookK, x.inflowNd) }))
      .sort((a, b) => b.val - a.val)
  }, [data, lookK])

  const flowSeries = useMemo(() => {
    if (!s?.series) return []
    const r = effectiveRangeOf(rangeN, s.series.length)
    return r === 'all' ? s.series : s.series.slice(-r)
  }, [s, rangeN])

  if (loading && !data) {
    return (
      <div className="etfflow-root grid min-h-[240px] place-items-center text-body text-etf-muted" aria-busy="true">
        正在拉取份额数据…
      </div>
    )
  }

  if (err && !data) {
    return (
      <div className="etfflow-root grid min-h-[240px] place-items-center px-6 text-center text-body text-etf-muted">
        <div role="alert">
          <div className="mb-2 font-medium text-etf-text">数据加载失败</div>
          <div className="text-meta">{err}</div>
          <button
            type="button"
            className="mt-4 cursor-pointer rounded-lg border border-etf-line1 px-4 py-2 text-meta text-etf-text hover:bg-etf-hover"
            onClick={() => void load(true)}
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  if (!data || !s) return null

  const fr = data.freshness
  const sc = s.scores
  const basketNd = sectors.reduce((a, x) => a + x.val, 0)
  const inflowSectors = sectors.filter((x) => x.val > 0).length
  const rankRows = rankMode === 'sector' ? sectors : groups
  const rankMax = Math.max(...rankRows.map((r) => Math.abs(r.val)), 1)
  // 资金流向呈幂律分布（宽基 1391 亿 vs 其余个位数），线性映射会让第二项只剩 1px。
  // 用 log 压缩刻度，保留方向与相对高低，同时让小数项可见。
  const rankScale = (v: number) => (Math.log10(1 + Math.abs(v)) / Math.log10(1 + rankMax)) * 100
  const availableDays = s.series.length

  const sectorNames = [...new Set(funds.map((x) => x.sector))]
  const filteredFunds = funds.filter((x) => {
    if (sectorFilter !== 'all' && x.sector !== sectorFilter) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return x.name.toLowerCase().includes(q) || x.code.toLowerCase().includes(q) || x.group.includes(query.trim())
  })
  const narrowed = query.trim() !== '' || sectorFilter !== 'all'
  const visibleFunds = showAll || narrowed ? filteredFunds : filteredFunds.slice(0, 12)

  const rangeOptions = rangeOptionsFor(availableDays)
  const effectiveRange = effectiveRangeOf(rangeN, availableDays)

  // 集中度必须跟着窗口走（原先固定用服务端按 5 日算的值），但口径要固定用「指数」粒度：
  // 用板块聚合时只有 13 个分母，宽基一项就占 97%，Top3 直接饱和成 100%，失去信息量。
  const groupRank = groups.filter((r) => r.val > 0)
  const windowPositiveSum = groupRank.reduce((a, r) => a + r.val, 0)
  const windowTop3 = [...groupRank].sort((a, b) => b.val - a.val).slice(0, 3)
  const windowConcentration = {
    ratio: windowPositiveSum > 0 ? windowTop3.reduce((a, r) => a + r.val, 0) / windowPositiveSum : 0,
    top3: windowTop3.map((r) => ({ group: r.name, inflow: r.val })),
  }

  const verdict = buildVerdict(
    s.composite,
    lookK,
    basketNd,
    windowConcentration.top3,
    windowConcentration.ratio,
  )
  const verdictList = rankAll ? rankRows : rankRows.slice(0, 15)
  // 原先直接 slice(0,8) 取 delta 降序前 8，会把 Δ 最大但为负的板块（如宽基 -59）
  // 藏进「另 N 个」。按绝对值排序，进出的两个方向都保留。
  const momRows = [...(data.momentum ?? [])]
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 8)
  // 归一化必须与显示范围一致：原先用全部 13 个板块取 max，导致前 8 项的条形普遍很短
  const momMax = Math.max(...momRows.map((m) => Math.abs(m.delta)), 1)
  const szLag = Boolean(fr?.shDate && fr?.szDate && fr.szDate < fr.shDate)
  // 证据链同样必须跟随窗口。服务端只按 lookback=5 预算，切窗口后不能沿用。
  const en = s.enhancement
  const winPersistence = (() => {
    const daily = en?.persistence?.daily
    if (!daily?.length) return en?.persistence ?? null
    const win = daily.slice(-lookK)
    const pos = win.filter((d) => d.inflow > 0).length
    const sum = win.reduce((a, d) => a + d.inflow, 0)
    let streak = 0
    for (let i = daily.length - 1; i >= 0; i -= 1) {
      if (daily[i].inflow > 0) streak += 1
      else break
    }
    const maxDay = win.length ? Math.max(...win.map((d) => d.inflow)) : 0
    return {
      streak,
      positiveDays: pos,
      windowDays: win.length,
      avgPerDay: win.length ? sum / win.length : 0,
      burstShare: sum > 0 ? (maxDay / sum) * 100 : null,
    }
  })()
  // 扩散度同理：按当前窗口的组净申购重算
  const winDiffusion = (() => {
    if (!s.groups?.length) return en?.diffusion ?? null
    const all = groups.map((g) => {
      const src = s.groups.find((x) => x.group === g.name)
      return { sector: src?.sector ?? '', value: g.val }
    })
    const pos = all.filter((x) => x.value > 0)
    const broad = all.filter((x) => x.sector === '宽基')
    return {
      inflowGroups: pos.length,
      totalGroups: all.length,
      ratio: all.length ? pos.length / all.length : 0,
      broadInflow: broad.filter((x) => x.value > 0).length,
      broadTotal: broad.length,
    }
  })()

  return (
    <div className="etfflow-root h-full overflow-auto px-6 pb-12 pt-5">
      {/* 页头：更新时间常驻 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="m-0 text-title font-medium">国家队资金流监测</h1>
          <div className="mt-1 text-meta text-etf-muted">
            更新于 {fmtLocalTime(data.generatedAt)} · 份额 {fr?.shareDate ?? s.asOf} · 行情{' '}
            {fr?.quoteDate ?? s.asOf} · {data.coverage.fundCount} 只 ETF · 数据 {availableDays} 个交易日
          </div>
        </div>
        {/* 控件收成一组：组间用 1px 竖线分隔，避免四块错落 */}
        <div className="flex items-center gap-3 rounded-lg border border-etf-line1 px-3 py-2">
          <Seg
            label="主图跨度"
            options={rangeOptions}
            value={effectiveRange}
            onChange={setRangeN}
            format={(v) => (v === 'all' ? '全部' : `${v} 日`)}
          />
          <span aria-hidden className="h-4 w-px bg-etf-line2" />
          <Seg
            label="统计窗口"
            options={LOOKBACKS}
            value={lookK as (typeof LOOKBACKS)[number]}
            onChange={setLookK}
            format={(v) => `${v} 日`}
          />
          <span aria-hidden className="h-4 w-px bg-etf-line2" />
          <button
            type="button"
            disabled={refreshing}
            aria-busy={refreshing}
            onClick={() => void load(true)}
            className="cursor-pointer rounded-md px-2 py-1 text-meta text-etf-muted transition-colors duration-150 hover:bg-etf-hover hover:text-etf-text disabled:cursor-default disabled:opacity-50"
          >
            {refreshing ? '刷新中' : '刷新'}
          </button>
        </div>
      </div>

      {staleNote && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-etf-line2 bg-etf-layer2 px-3 py-2 text-meta text-etf-text"
        >
          <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-etf-in" />
          {staleNote}
          <button
            type="button"
            onClick={() => void load(true)}
            className="cursor-pointer text-etf-muted underline underline-offset-2 hover:text-etf-text"
          >
            重试
          </button>
        </div>
      )}

      {/* 判词：首屏回答「国家队在不在买」 */}
      <Card className="mb-3">
        <p
          className="m-0 text-pretty text-lead font-medium text-etf-text"
          title={`综合评分 ${nf(s.composite, 1)} 分 · 判定阈值：≥55 为买入信号、≥35 为中性、<35 为流出`}
        >
          {verdict}
        </p>
        {/*
          4 个指标排成一条仪表带。
          第一列含仪表盘 + 两行文字，需要比其他列更宽：等分时 1024 下只有 234px，
          「强度 100 · 广度 49 · 逆势 46」会被挤成两行（768 下折成 5 行）。
          因此用 1.6fr 加宽，并在窄屏让它独占整行。
        */}
        <div className="mt-5 grid grid-cols-2 gap-y-5 lg:grid-cols-[1.8fr_1fr_1fr_1fr] lg:divide-x lg:divide-etf-line1">
          <div className="col-span-2 lg:col-span-1 lg:pr-6">
            <div className="text-meta text-etf-faint">综合评分</div>
            <div className="mt-1 flex items-center gap-3">
              <Gauge score={s.composite} />
              <div>
                <div className="text-meta text-etf-muted">{s.regime}</div>
                <div className="whitespace-nowrap font-etf-mono text-meta tabular-nums text-etf-faint">
                  强度 {nf(sc.power, 0)} · 广度 {nf(sc.breadth, 0)} · 逆势 {nf(sc.contrarian, 0)}
                </div>
              </div>
            </div>
          </div>
          <div className="lg:px-6">
            <Metric label={`近 ${lookK} 日净申购`} value={`${signed(basketNd, 1)} 亿`} tone={toneOf(basketNd)} />
          </div>
          <div className="lg:px-6">
            <Metric
              label={szLag ? '最新单日（沪市口径）' : '最新单日'}
              value={`${signed(s.basket.inflowLatest, 1)} 亿`}
              tone={toneOf(s.basket.inflowLatest)}
            />
          </div>
          <div className="lg:pl-6">
            <Metric label="净申购板块" value={`${inflowSectors} / ${sectors.length}`} />
          </div>
        </div>
        {/* 证据链：把「+1,381 亿」放进历史坐标里，回答「这算多还是少」 */}
        {en && (
          <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-4 border-t border-etf-line1 pt-4 sm:grid-cols-3">
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-meta text-etf-faint">单日净申购历史分位</span>
                <span className="font-etf-mono text-body tabular-nums text-etf-text">
                  {en.percentile.daily === null ? '—' : `${en.percentile.daily}%`}
                </span>
              </div>
              <PercentileBar pct={en.percentile.daily} marks={en.percentile.marks} />
              <div className="mt-1 text-meta leading-4 text-etf-faint">
                {en.percentile.from && en.percentile.to
                  ? `样本 ${en.percentile.from.slice(5)} 至 ${en.percentile.to.slice(5)}，共 ${en.percentile.sampleDays} 个交易日`
                  : `${en.percentile.sampleDays} 个交易日样本`}
              </div>
            </div>

            <div>
              <div className="text-meta text-etf-faint">流入持续性</div>
              <div className="mt-1 flex items-baseline gap-3">
                <span className="font-etf-mono text-body tabular-nums text-etf-text">
                  {winPersistence && winPersistence.streak > 0 ? `连续 ${winPersistence.streak} 天` : '未连续流入'}
                </span>
                <span className="font-etf-mono text-meta tabular-nums text-etf-muted">
                  日均 {nf(winPersistence?.avgPerDay ?? 0, 0)} 亿
                </span>
              </div>
              <div className="mt-1 text-meta text-etf-faint">
                近 {winPersistence?.windowDays ?? lookK} 日 {winPersistence?.positiveDays ?? 0} 天为正
                {winPersistence?.burstShare != null && winPersistence.burstShare >= 50
                  ? ` · 最大单日占 ${nf(winPersistence.burstShare, 0)}%`
                  : ''}
              </div>
            </div>

            <div>
              <div className="text-meta text-etf-faint">流入扩散度</div>
              <div className="mt-1 flex items-baseline gap-3">
                <span className="font-etf-mono text-body tabular-nums text-etf-text">
                  {winDiffusion?.inflowGroups ?? 0} / {winDiffusion?.totalGroups ?? 0} 指数
                </span>
                <span className="font-etf-mono text-meta tabular-nums text-etf-muted">
                  宽基 {winDiffusion?.broadInflow ?? 0} / {winDiffusion?.broadTotal ?? 0}
                </span>
              </div>
              <div className="mt-1 text-meta text-etf-faint">
                {(() => {
                  const r = winDiffusion?.ratio ?? 0
                  if (r >= 0.7) return '多数指数流入，覆盖面广'
                  if (r >= 0.35) return '部分指数流入，仍有选择性'
                  return '少数指数流入，集中护盘'
                })()}
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 border-t border-etf-line1 pt-3 text-meta text-etf-faint">
          集中度 Top3 占正流入 {nf(windowConcentration.ratio * 100, 0)}%（近 {lookK} 日）
          {windowConcentration.top3.length
            ? `（${windowConcentration.top3.map((t) => `${t.group} ${signed(t.inflow, 1)}`).join(' · ')}）`
            : ''}
          {szLag ? (
            <>
              {' · 深市份额 '}
              <span className="whitespace-nowrap">{fr?.szDate}</span>
              {'，当日汇总未含深市'}
            </>
          ) : null}
        </div>
      </Card>

      {/* 主图 + 资金流向 */}
      <div className="mb-3 grid grid-cols-1 gap-3 xl:grid-cols-[2.5fr_1fr]">
        <Card>
          <Head title="累计净申购与沪深300" meta="左轴 亿元 · 右轴 点 · 柱 当日净申购" />
          <FlowChart series={flowSeries} anomalies={s.anomalies} />
        </Card>

        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 text-emph font-medium">
              资金流向
              <span className="ml-2 text-meta font-normal text-etf-faint">
                {rankRows.length} 项 · 近 {lookK} 日 · 亿元
              </span>
            </h2>
            <div
              className="inline-flex items-center gap-1 rounded-lg bg-etf-layer2 p-1"
              role="group"
              aria-label="按板块或指数汇总"
            >
              {(
                [
                  ['sector', '板块'],
                  ['group', '指数'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={rankMode === k}
                  onClick={() => setRankMode(k)}
                  className={[
                    'cursor-pointer rounded-md px-2 py-1 text-meta transition-colors duration-150',
                    rankMode === k ? 'bg-etf-layer1 text-etf-text' : 'text-etf-muted hover:text-etf-text',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-2">
            {verdictList.map((r) => (
              <div key={r.name} className="grid grid-cols-[76px_1fr_68px] items-center gap-2">
                <span className="truncate text-meta text-etf-muted" title={r.name}>
                  {r.name}
                </span>
                <span className="block h-1 bg-etf-layer2">
                  <span
                    className="block h-1"
                    style={{
                      width: `${rankScale(r.val)}%`,
                      background:
                        r.val >= 0
                          ? 'var(--dsw-alias-state-error-primary)'
                          : 'var(--dsw-alias-state-success-primary)',
                    }}
                  />
                </span>
                <span className={`text-right font-etf-mono text-meta tabular-nums ${toneOf(r.val)}`}>
                  {signed(r.val, 1)}
                </span>
              </div>
            ))}
          </div>
          {rankRows.length > 15 && (
            <div className="mt-3 flex items-center justify-between border-t border-etf-line1 pt-3">
              <span className="text-meta text-etf-faint">{rankAll ? `全部 ${rankRows.length} 项` : '前 15 项'}</span>
              <button
                type="button"
                onClick={() => setRankAll((v) => !v)}
                className="cursor-pointer text-meta text-etf-muted transition-colors duration-150 hover:text-etf-text"
              >
                {rankAll ? '收起' : `展开全部 ${rankRows.length} 项`}
              </button>
            </div>
          )}
        </Card>
      </div>

      {/* ETF 明细 */}
      <Card className="mb-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-emph font-medium">ETF 明细</h2>
            <div className="mt-1 text-meta text-etf-faint">
              近 {lookK} 日净申购 · 点击展开份额走势 · 共 {funds.length} 只
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="etf-search" className="text-meta text-etf-faint">
              搜索
            </label>
            <input
              id="etf-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="名称或代码"
              className="w-44 rounded-lg border border-etf-line1 bg-etf-layer2 px-3 py-1 text-meta text-etf-text placeholder:text-etf-placeholder focus:border-etf-line2 focus:outline-none"
            />
          </div>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-1" role="group" aria-label="按板块筛选">
          {['all', ...sectorNames].map((sec) => (
            <button
              key={sec}
              type="button"
              aria-pressed={sectorFilter === sec}
              onClick={() => setSectorFilter(sec)}
              className={[
                'cursor-pointer rounded-md px-2 py-1 text-meta transition-colors duration-150',
                sectorFilter === sec
                  ? 'bg-etf-layer2 text-etf-text'
                  : 'text-etf-muted hover:bg-etf-hover hover:text-etf-text',
              ].join(' ')}
            >
              {sec === 'all' ? '全部板块' : sec}
            </button>
          ))}
        </div>

        <table className="w-full table-fixed border-collapse text-body">
          {/* 名称列原先被拉到 403px（内容仅 150px），数值列反被挤到 200px+，这里按比例固定 */}
          <colgroup>
            <col className="w-[27%]" />
            <col className="w-[15%]" />
            <col className="w-[11%]" />
            <col className="w-[11%]" />
            <col className="w-[15%]" />
            <col className="w-[15%]" />
            <col className="w-[6%]" />
          </colgroup>
          <thead>
            <tr>
              {['ETF', '指数 / 板块', '收盘', '涨跌', `近 ${lookK} 日净申购（亿）`, '份额（亿份）'].map((c) => (
                <th
                  key={c}
                  scope="col"
                  className="border-b border-etf-line1 py-2 pl-3 text-right text-meta font-normal text-etf-faint first:pl-0 first:text-left"
                >
                  {c}
                </th>
              ))}
              <th scope="col" className="w-8 border-b border-etf-line1">
                <span className="sr-only">展开</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleFunds.length === 0 && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-meta text-etf-muted">
                  没有匹配的 ETF
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('')
                      setSectorFilter('all')
                    }}
                    className="ml-2 cursor-pointer underline underline-offset-2 hover:text-etf-text"
                  >
                    清除筛选
                  </button>
                </td>
              </tr>
            )}
            {visibleFunds.map((x) => {
              const open = expandedCode === x.code
              const series = data.seriesFund?.[x.code] ?? []
              const toggle = () => setExpandedCode(open ? null : x.code)
              return (
                <Fragment key={x.code}>
                  <tr
                    onClick={toggle}
                    className={`cursor-pointer border-b border-etf-line1 transition-colors duration-150 hover:bg-etf-hover ${
                      open ? 'bg-etf-layer2' : ''
                    }`}
                  >
                    <td className="py-2 pl-0 pr-3">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={`fund-detail-${x.code}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggle()
                        }}
                        className="flex w-full cursor-pointer items-start gap-2 text-left"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium" title={x.name}>
                            {x.name}
                          </span>
                          <span className="block font-etf-mono text-meta text-etf-faint">{x.code}</span>
                        </span>
                      </button>
                    </td>
                    <td className="py-2 pl-3 pr-3">
                      <div className="text-meta text-etf-muted">{x.group}</div>
                      <div className="text-meta text-etf-faint">{x.sector}</div>
                    </td>
                    <td className="py-2 pl-3 pr-3 text-right font-etf-mono tabular-nums">{nf(x.close, 3)}</td>
                    <td className={`py-2 pl-3 pr-3 text-right font-etf-mono tabular-nums ${toneOf(x.pct)}`}>
                      {signed(x.pct, 2)}%
                    </td>
                    <td className={`py-2 pl-3 pr-3 text-right font-etf-mono tabular-nums ${toneOf(x.val)}`}>
                      {signed(x.val, 2)}
                    </td>
                    <td className="py-2 pl-3 text-right font-etf-mono tabular-nums text-etf-muted">
                      {nf(x.share, 0)} 亿份
                    </td>
                    <td className="py-2 pl-2 text-right">
                      <svg
                        viewBox="0 0 16 16"
                        className={`inline-block h-4 w-4 transition-transform duration-150 ${
                          open ? 'rotate-90 text-etf-muted' : 'text-etf-faint'
                        }`}
                        aria-hidden
                      >
                        <path
                          d="M6 4l4 4-4 4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </td>
                  </tr>
                  {open && (
                    <tr id={`fund-detail-${x.code}`} className="border-b border-etf-line1">
                      <td colSpan={7} className="bg-etf-bg p-0">
                        <div className="px-3 pb-4 pt-3">
                          {(() => {
                            const st = fundStats(series)
                            if (!st) return null
                            // 每个百分比都必须自带分母/口径，否则「份额位置 100%」和
                            // 「逆势托底 100%」并列时读者无法分辨这是两件事。
                            const span = series.length > 1 ? `${series[0].date} 起 ${series.length} 日` : '—'
                            const cells: Array<[string, string, string]> = [
                              ['最新份额', `${nf(st.last.share, 0)} 亿份`, 'text-etf-text'],
                              [`份额变化（${span}）`, `${signed(st.sharePct, 1)}%`, toneOf(st.sharePct)],
                              [`累计净申购（${span}）`, `${signed(st.inflowSum, 1)} 亿`, toneOf(st.inflowSum)],
                              [
                                '连续净流入',
                                st.streak > 0 ? `${st.streak} 天` : '—',
                                st.streak > 0 ? 'text-etf-intext' : 'text-etf-muted',
                              ],
                              ['份额在区间的位置', `${nf(st.pos, 0)}%`, 'text-etf-muted'],
                              ['跌日仍净申购占比', `${nf((x.contrarian ?? 0) * 100, 0)}%`, 'text-etf-muted'],
                              ['净申购占成交额', `${nf(x.intensity ?? 0, 1)}%`, 'text-etf-muted'],
                              [
                                '规模变化拆解（亿）',
                                `${signed(x.shareEffect ?? 0, 0)} 份额 / ${signed(x.navEffect ?? 0, 0)} 净值`,
                                'text-etf-muted',
                              ],
                            ]
                            return (
                              <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                                {cells.map(([label, value, tone]) => (
                                  <Metric key={label} label={label} value={value} tone={tone} />
                                ))}
                              </div>
                            )
                          })()}
                          <FundChart series={series} height={200} />
                          <div className="mt-2 flex flex-wrap gap-5 text-meta text-etf-faint">
                            <span className="inline-flex items-center gap-2">
                              <i className="block h-[2px] w-4 rounded-sm bg-etf-in" aria-hidden />
                              份额（左轴 · 亿份）
                            </span>
                            <span className="inline-flex items-center gap-2">
                              <i className="block h-[2px] w-4 rounded-sm bg-etf-faint" aria-hidden />
                              收盘价（右轴 · 元）
                            </span>
                            <span className="inline-flex items-center gap-2">
                              <i className="block h-2 w-2 rounded-sm bg-etf-in opacity-60" aria-hidden />
                              当日净申购
                            </span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
        {filteredFunds.length > 12 && (
          <div className="mt-4 flex items-center justify-between border-t border-etf-line1 pt-4">
            <span className="text-meta text-etf-faint">
              {narrowed
                ? `筛选出 ${filteredFunds.length} 只`
                : showAll
                  ? `全部 ${filteredFunds.length} 只`
                  : `显示前 12 只，共 ${filteredFunds.length} 只`}
            </span>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="cursor-pointer rounded-lg border border-etf-line1 px-3 py-1 text-meta text-etf-muted transition-colors duration-150 hover:bg-etf-hover hover:text-etf-text"
            >
              {showAll ? '收起' : `显示全部 ${filteredFunds.length} 只`}
            </button>
          </div>
        )}
      </Card>

      {/* 热力表 */}
      <Card className="mb-3">
        <Head
          title="日度净申购热力"
          meta={`近 ${data.heatmap?.dates?.length ?? 0} 个交易日 × 净流入最大的 ${data.heatmap?.groups?.length ?? 0} 个指数（共 ${groups.length} 个）`}
        />
        <HeatmapTable data={data.heatmap} />
      </Card>

      {/* 结构与存量：三列统一「标题 + 内容」，不再用列头（双列内容时列头会与内容错位） */}
      <Card className="mb-3">
        <Head title="结构与存量" meta="动量 近5日 vs 前5日 · 管理人 近30日 · 机构持有 季度" />
        <div className="grid grid-cols-1 gap-x-8 gap-y-7 lg:grid-cols-3">
          {/* ── 板块动量 ── */}
          <section>
            <h3 className="m-0 mb-2 text-body font-medium text-etf-text">板块动量</h3>
            <div className="mb-2 border-b border-etf-line1 pb-1 text-meta text-etf-faint">亿元</div>
            <div className="grid gap-1.5">
              {momRows.map((m) => (
                <div key={m.sector} className="grid grid-cols-[52px_1fr_48px] items-center gap-2 text-meta">
                  <span className="truncate text-etf-muted" title={m.sector}>
                    {m.sector}
                  </span>
                  <span className="block h-1 bg-etf-layer2">
                    <span
                      className="block h-1"
                      style={{
                        width: `${Math.min(100, (Math.abs(m.delta) / momMax) * 100)}%`,
                        background:
                          m.delta >= 0
                            ? 'var(--dsw-alias-state-error-primary)'
                            : 'var(--dsw-alias-state-success-primary)',
                      }}
                    />
                  </span>
                  <span className={`text-right font-etf-mono tabular-nums ${toneOf(m.delta)}`}>
                    {signed(m.delta, 1)}
                  </span>
                </div>
              ))}
            </div>
            {(data.momentum?.length ?? 0) > 8 && (
              <div className="mt-2 border-t border-etf-line1 pt-1.5 text-meta text-etf-faint">
                另 {(data.momentum?.length ?? 0) - 8} 个板块
              </div>
            )}
          </section>

          {/* ── 管理人偏好 ── */}
          <section>
            <h3 className="m-0 mb-2 text-body font-medium text-etf-text">
              管理人偏好
              <span className="ml-2 text-meta font-normal text-etf-faint">份额变化 / 净申购 亿</span>
            </h3>
            <div className="mb-2 border-b border-etf-line1 pb-1" />
            <div className="grid gap-2">
              {(data.managers ?? []).slice(0, 3).map((g) => (
                <div key={g.group}>
                  <div className="text-meta text-etf-muted">{g.group}</div>
                  <div className="grid gap-1">
                    {g.rows.slice(0, 2).map((r) => (
                      <div key={r.code} className="grid grid-cols-[1fr_52px_48px] items-center gap-2 text-meta">
                        <span className="truncate text-etf-faint" title={`${r.manager} ${r.code}`}>
                          {r.manager.replace(/基金管理有限公司|基金管理股份有限公司|基金管理/g, '')}
                        </span>
                        <span className={`text-right font-etf-mono tabular-nums ${toneOf(r.shareChgPct)}`}>
                          {signed(r.shareChgPct, 0)}%
                        </span>
                        <span className={`text-right font-etf-mono tabular-nums ${toneOf(r.inflow)}`}>
                          {signed(r.inflow, 0)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {(data.managers?.length ?? 0) > 3 && (
              <div className="mt-2 border-t border-etf-line1 pt-1.5 text-meta text-etf-faint">
                另 {(data.managers?.length ?? 0) - 3} 个多管理人指数
              </div>
            )}
          </section>

          {/* ── 机构持有比例：双列，标题里带报告期 ── */}
          <section>
            <h3 className="m-0 mb-2 text-body font-medium text-etf-text">
              机构持有
              <span className="ml-2 text-meta font-normal text-etf-faint">
                季度 · {data.holders?.rows?.[0]?.period ?? '—'}
              </span>
            </h3>
            <div className="mb-2 border-b border-etf-line1 pb-1 text-meta text-etf-faint">按占比降序</div>
            {(data.holders?.rows?.length ?? 0) > 0 ? (
              <div className="grid grid-cols-2 gap-x-5 gap-y-1.5">
                {[...(data.holders?.rows ?? [])]
                  .sort((a, b) => b.instPct - a.instPct)
                  .slice(0, 8)
                  .map((h) => (
                    <div key={h.code} className="flex items-baseline justify-between gap-2 text-meta">
                      <span className="truncate text-etf-faint" title={`${h.name} ${h.code}`}>
                        {h.name}
                      </span>
                      <span className="shrink-0 font-etf-mono tabular-nums text-etf-text">
                        {nf(h.instPct, 0)}%
                      </span>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="text-meta text-etf-faint">暂未取到 Wind 数据</div>
            )}
            <div className="mt-2 border-t border-etf-line1 pt-1.5 text-meta text-etf-faint">
              存量证据，不能用于判断单日动作
            </div>
          </section>
        </div>
      </Card>

      {/* 市场温度：描述性指标，明确标注不参与评分（统计上不显著，见 lib/market.js） */}
      {data.temperature?.items?.length ? (
        <Card className="mb-3">
          <Head
            title="市场温度"
            meta={
              <span className="inline-flex items-center gap-1.5">
                <span
                  title="这些指标在历史检验中对未来收益不显著，仅用于理解当日状态"
                  className="rounded-sm border border-etf-line2 px-1.5 py-0.5 text-meta leading-4 text-etf-muted"
                >
                  描述性
                </span>
                不参与评分 · 不预测方向
              </span>
            }
          />
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
            {data.temperature.items.map((it) => (
              <div key={it.key}>
                <div className="text-meta text-etf-faint">{it.label}</div>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="font-etf-mono text-emph tabular-nums text-etf-text">
                    {nf(it.value, it.digits ?? 0)}
                  </span>
                  <span className="text-meta text-etf-faint">{it.unit}</span>
                </div>
                {typeof it.rank === 'number' && (
                  <div className="mt-1.5">
                    {/* 用描边轨道 + 中性填充，与「参与评分」区块的实心强调色分位条区分，
                        避免形状暗示把描述性指标读成信号 */}
                    <div
                      className="relative h-1 rounded-sm border border-etf-line2 bg-transparent"
                      role="img"
                      aria-label={`${it.label} 位于近 ${it.windowDays ?? 30} 个交易日的第 ${Math.round(it.rank)} 分位`}
                    >
                      <div
                        className="absolute inset-y-0 left-0 rounded-sm bg-etf-faint opacity-60"
                        style={{ width: `${Math.max(2, Math.min(100, it.rank))}%` }}
                      />
                    </div>
                    <div className="mt-1 font-etf-mono text-meta tabular-nums text-etf-faint">
                      {it.rankLabel ?? `近 ${it.windowDays ?? 30} 日`} {Math.round(it.rank)} 分位
                    </div>
                  </div>
                )}
                {it.hint && <div className="mt-1 text-meta leading-4 text-etf-faint">{it.hint}</div>}
              </div>
            ))}
          </div>
          <div className="mt-4 border-t border-etf-line1 pt-3 text-meta text-etf-faint">
            {data.temperature.note}
            {' · '}
            依据：近三年非重叠样本检验，这些指标对未来 20 日收益均不显著（|t| &lt; 2），故仅作状态参考
          </div>
        </Card>
      ) : null}

      {/* 口径 */}
      <div className="border-t border-etf-line1 pt-4 text-meta leading-5 text-etf-muted">
        <p className="m-0">
          <span className="text-etf-text">净申购额 = Δ基金总份额 × 收盘价。</span>
          份额是申赎的直接结果，增加意味着真有资金申购、管理人被动买入成分股。成交额只反映换手，无法区分申购与对倒。
        </p>
        <p className="m-0 mt-2">
          <span className="text-etf-text">综合评分</span>
          ＝净申购强度 45% + 流入广度 30% + 逆势托底 25%。逆势托底是汇金类资金最典型的特征。
        </p>
        <p className="m-0 mt-2">
          <span className="text-etf-text">窗口口径：</span>
          合计＝各基金之和，均按同一条交易日轴取窗口。深市份额 T+1，最新一日常缺，当日汇总因此只含沪市。
        </p>
        <p className="m-0 mt-2">
          <span className="text-etf-text">局限：</span>
          份额数据不含持有人身份，宽基巨量申赎是强相关性证据而非直接持股披露。
        </p>
      </div>
    </div>
  )
}

/** 对外入口：包一层错误边界。 */
export function DashboardSafe() {
  return (
    <ErrorBoundary>
      <Dashboard />
    </ErrorBoundary>
  )
}

export { Dashboard }
