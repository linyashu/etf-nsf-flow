import type { GroupPeriods } from './types'

/** 数字格式化，空值统一显示为 —。全屏只用一种小数位约定。 */
export function nf(v: number | null | undefined, d = 2): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—'
  return Number(v).toLocaleString('zh-CN', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}

/** 带正负号。 */
export function signed(v: number | null | undefined, d = 2): string {
  if (v === null || v === undefined) return '—'
  return (v > 0 ? '+' : '') + nf(v, d)
}

/**
 * 涨跌/流入配色，按 A 股习惯：红=流入，绿=流出。
 * 语义色只用来表达方向，不做装饰。
 */
export function toneOf(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return 'text-etf-muted'
  return v > 0 ? 'text-etf-intext' : 'text-etf-outtext'
}

/** 关键数字的强调色：只有一个强调色。 */
export const ACCENT = 'var(--dsw-alias-state-error-primary)'

/** 取某周期窗口内的净申购，缺失则退回 inflowNd。 */
export function periodValue(p: GroupPeriods | undefined, lookK: number, fallback: number): number {
  const v = p?.[`inflow_${lookK}d` as keyof GroupPeriods]
  return typeof v === 'number' ? v : fallback
}

/** 生成等间隔的「好看」刻度值。 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [0]
  const span = max - min
  const step0 = span / count
  const mag = 10 ** Math.floor(Math.log10(step0))
  const norm = step0 / mag
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const out: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1000) / 1000)
  return out
}

/** SVG 折线路径。 */
export function linePath(pts: Array<[number, number]>): string {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
}

/** 只保留 MM-DD，用于横轴。 */
export function shortDate(d: string): string {
  return String(d).slice(5)
}
