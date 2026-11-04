/** 与 Host 端 index.js 返回的 JSON 结构对应。 */

export interface FlowPoint {
  date: string
  inflow: number
  cum: number
  bench: number | null
  benchClose: number | null
}

export interface GroupPeriods {
  inflow_1d?: number
  inflow_5d?: number
  inflow_10d?: number
  inflow_20d?: number
}

export interface FundGroup {
  group: string
  sector: string
  codes: string[]
  inflow1d: number
  inflowNd: number
  power: number
  persistence: number
  contrarian: number
  scaleYi: number
  scaleShare: number
  scaleChgYi: number
  periods: GroupPeriods
  downDays: number
}

export interface BasketSummary {
  inflowNd: number
  inflowLatest: number
  power: number
  breadth: number
  contrarian: number
  benchName: string
  benchCode: string
}

export interface SectorTotal {
  sector: string
  groups: string[]
  groupCount: number
  inflow1d: number
  inflowNd: number
  scaleYi: number
  breadth: number
  periods: GroupPeriods
}

export interface Freshness {
  shareDate: string
  quoteDate: string | null
  shDate: string | null
  szDate: string | null
  sseSupplement: { date: string; funds: number } | null
  shCount: number
  szCount: number
  shareChunks?: number
  note: string | null
}

export interface UniverseEntry {
  sector: string
  group: string
  codes: string[]
}

export interface Concentration {
  ratio: number
  top3: Array<{ group: string; inflow: number }>
  positiveSum: number
}

export interface AnomalyDay {
  date: string
  inflow: number
  z: number
}

export interface MomentumRow {
  sector: string
  recent: number
  prev: number
  delta: number
}

export interface ManagerRow {
  code: string
  name: string
  manager: string
  shareNow: number
  shareChgPct: number
  inflow: number
}

export interface ManagerGroup {
  group: string
  rows: ManagerRow[]
}

export interface HeatCell {
  date: string
  values: Array<number | null>
  total: number | null
  missing?: number
}

export interface HolderRow {
  code: string
  name: string
  period: string | null
  instPct: number
  feederPct: number | null
}

export interface Holders {
  rows: HolderRow[]
  error: string | null
  fetchedAt: string | null
}

export interface Heatmap {
  dates: string[]
  groups: string[]
  cells: HeatCell[]
  max: number
}

export interface Signals {
  asOf: string
  lookback: number
  regime: string
  note: string
  composite: number
  scores: { power: number; breadth: number; contrarian: number }
  basket: BasketSummary
  groups: FundGroup[]
  sectorTotals: SectorTotal[]
  concentration: Concentration
  anomalies: AnomalyDay[]
  series: FlowPoint[]
  enhancement?: SignalsEnhancement
}

export interface FundRow {
  code: string
  name: string
  group: string
  sector: string
  manager: string
  close: number
  pct: number
  share: number
  amount: number
  inflow1d: number
  inflowNd: number
  contrarian: number
  intensity: number
  shareEffect: number
  navEffect: number
  streak: number
  periods: GroupPeriods
}

export interface FundSeriesPoint {
  date: string
  share: number
  inflow: number
  close: number
  amount: number
}

export interface Coverage {
  from: string
  to: string
  tradingDays: number
  fundCount: number
}

export interface DashboardPayload {
  generatedAt: string
  asOf: string
  coverage: Coverage
  freshness: Freshness
  universe: UniverseEntry[]
  signals: Signals
  funds: FundRow[]
  holders: Holders
  momentum: MomentumRow[]
  temperature?: MarketTemperature | null
  intraday?: IntradayAlert | null
  managers: ManagerGroup[]
  heatmap: Heatmap
  seriesGroups: Record<string, Array<{ date: string; inflow: number }>>
  seriesFund: Record<string, FundSeriesPoint[]>
  benchSeries: Array<{ date: string; close: number | null }>
  basket: Record<string, string[]>
  bench: { code: string; name: string }
}
export interface EnhancementPercentile {
  daily: number | null
  sampleDays: number
  from?: string | null
  to?: string | null
  marks: Array<{ p: number; value: number }>
}

export interface EnhancementPersistence {
  streak: number
  positiveDays: number
  windowDays: number
  avgPerDay: number
  burstShare: number | null
  daily?: Array<{ date: string; inflow: number }>
}

export interface EnhancementDiffusion {
  inflowGroups: number
  totalGroups: number
  ratio: number
  broadInflow: number
  broadTotal: number
}

export interface SignalsEnhancement {
  percentile: EnhancementPercentile
  persistence: EnhancementPersistence
  diffusion: EnhancementDiffusion
}

export interface TemperatureItem {
  key: string
  label: string
  value: number
  unit: string
  digits?: number
  windowDays?: number
  rankLabel?: string
  rank?: number | null
  hint?: string | null
}

export interface MarketTemperature {
  asOf: string
  items: TemperatureItem[]
  note: string | null
}
export interface IntradayRow {
  code: string
  name: string
  amountYi: number
  pct: number | null
  netActiveYi: number | null
  dailyAvgYi: number | null
  multiple: number | null
}

export interface IntradayAlert {
  session: { ratio: number; phase: string; elapsedMinutes: number; progress: number | null }
  asOfDate: string | null
  shareDate?: string | null
  quoteTime: string | null
  totals: {
    amountYi: number
    netActiveYi: number
    baselineYi: number | null
    multiple: number | null
    dayRatio: number | null
  }
  top: IntradayRow[]
  rows: IntradayRow[]
  warn: { amount: string; netActive: string; predictable: string }
}
