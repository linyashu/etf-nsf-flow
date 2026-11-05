import { useState } from 'react'
import type { Heatmap } from '../types'
import { nf, signed } from '../format'

interface Props {
  data: Heatmap
}

const IN_RGB = 'var(--dsw-alias-state-error-primary)'
const OUT_RGB = 'var(--dsw-alias-state-success-primary)'

/**
 * 日期 × 指数 的净申购热力表。
 *
 * 两点取舍：
 * 1. 颜色按「全局最大绝对值」归一化，不是按列。这样一眼能比出哪一格最大；
 *    按列归一化会让小额列也满色，反而误导。
 * 2. 单元格不全填满色，只用低透明度底 + 正常可读的数字。
 *    几十个实心色块糊在一起时数字就读不出来了。
 */
export function HeatmapTable({ data }: Props) {
  if (!data?.cells?.length) {
    return <div className="grid h-[200px] place-items-center text-meta text-etf-muted">暂无数据</div>
  }

  const { dates, cells, max, groupsAll } = data
  // 默认只显示前 DEFAULT_COLS 组，避免列过多挤成一片；
  // 展开后显示 payload 里的全部组（后端按窗口内绝对值降序返回）。
  const [expanded, setExpanded] = useState(false)
  // 默认展示列数 = 后端返回的 groups 数量（已按窗口内绝对值排序，topGroups=18），
  // 展开时才用 groupsAll 的全量 41 组。不要在前端再截一次——那会让
  // 「后端算好的 18 列」和「前端显示的 11 列」不一致，小计也跟着错。
  const DEFAULT_COLS = data.groups.length
  const allGroups = expanded && groupsAll?.length ? groupsAll : data.groups
  const showCount = expanded ? allGroups.length : Math.min(DEFAULT_COLS, allGroups.length)
  const groups = allGroups.slice(0, showCount)
  // 需要按裁剪后的列重建 cells 的 values，否则列与值会错位
  const colIdx = groups.map((g) => data.groups.indexOf(g))
  const denom = max || 1
  // 有缺失格时表头要说明，否则读者会把留空当成 0
  const hasMissing = cells.some((row) => (row.missing ?? 0) > 0)

  /** 强度 -> 透明度，封顶 0.42 保证数字始终可读 */
  const alphaOf = (v: number) => Math.min(0.42, (Math.abs(v) / denom) * 0.42)

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-body" aria-label="日度净申购热力表">
        <thead>
          <tr>
            <th scope="col" className="border-b border-etf-line1 py-2 pr-3 text-left text-meta font-normal text-etf-faint">
              日期
            </th>
            {groups.map((g) => (
              <th
                key={g}
                scope="col"
                className="border-b border-etf-line1 px-1 py-2 text-right text-meta font-normal text-etf-faint"
              >
                {g}
              </th>
            ))}
            {/* 这一列只加总「显示中的」指数，不是全市场合计。
                原先叫「合计」，与顶部「最新单日 +599 亿」（37 个指数全量）并列时
                会让人以为同一口径算出了两个不同的数（实测 605 vs 599）。 */}
            <th
              scope="col"
              title="仅为本表显示的指数求和，不等于全市场合计"
              className="border-b border-etf-line1 py-3 pl-3 text-right text-meta font-normal text-etf-faint"
            >
              {groups.length} 项小计
            </th>
          </tr>
        </thead>
        <tbody>
          {cells.map((row) => (
            <tr key={row.date} className="border-b border-etf-line1">
              <td className="py-1 pr-3 font-etf-mono text-meta tabular-nums text-etf-muted">{row.date}</td>
              {colIdx.map((oi, i) => {
                const v = oi >= 0 ? row.values[oi] : null
                if (v === null) {
                  return (
                    <td
                      key={`${row.date}-${groups[i]}`}
                      className="px-1 py-1"
                      title={`${row.date} ${groups[i]}：当日份额尚未披露`}
                    >
                      <div className="text-right font-etf-mono text-meta tabular-nums text-etf-faint">—</div>
                    </td>
                  )
                }
                return (
                  <td
                    key={`${row.date}-${groups[i]}`}
                    title={`${row.date} ${groups[i]} ${signed(v, 1)} 亿元`}
                    className="px-1 py-1"
                    style={{
                      background:
                        v === 0
                          ? 'transparent'
                          : v > 0
                            ? `color-mix(in srgb, ${IN_RGB} ${alphaOf(v) * 100}%, transparent)`
                            : `color-mix(in srgb, ${OUT_RGB} ${alphaOf(v) * 100}%, transparent)`,
                    }}
                  >
                    <div className="text-right font-etf-mono text-meta tabular-nums text-etf-text">
                      {signed(v, 1)}
                    </div>
                  </td>
                )
              })}
              <td className="py-1 pl-3 text-right font-etf-mono text-meta font-medium tabular-nums text-etf-text">
                {(() => {
                  // 小计必须与当前显示的列一致：展开后若仍用后端全量 total，
                  // 读者会拿 18 个格子的值去对一个只含 11 列的合计数，必然对不上。
                  const shown = colIdx.map((oi) => (oi >= 0 ? row.values[oi] : null)).filter((v) => v !== null) as number[]
                  if (!shown.length) return '—'
                  return signed(shown.reduce((a, b) => a + b, 0), 1)
                })()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-meta text-etf-faint">
        <span>近 {dates.length} 个交易日 · 单位亿元</span>
        <span>小计仅含本表 {groups.length} 个指数</span>
        {(groupsAll?.length ?? 0) > DEFAULT_COLS ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded-sm border border-etf-line2 px-1.5 py-0.5 text-meta leading-4 text-etf-muted transition-colors hover:border-etf-line1 hover:text-etf-text"
          >
            {expanded ? '收起' : `展开全部 ${groupsAll!.length} 个指数`}
          </button>
        ) : null}
        {hasMissing && <span>「—」为当日份额尚未披露（深市 T+1），非零流入</span>}
        <span className="inline-flex items-center gap-2">
          <i
            className="block h-3 w-3 rounded-sm"
            style={{ background: `color-mix(in srgb, ${IN_RGB} 42%, transparent)` }}
          />
          净申购
        </span>
        <span className="inline-flex items-center gap-2">
          <i
            className="block h-3 w-3 rounded-sm"
            style={{ background: `color-mix(in srgb, ${OUT_RGB} 42%, transparent)` }}
          />
          净赎回
        </span>
        <span>色深按全表最大绝对值 {nf(max, 0)} 亿归一</span>
      </div>
    </div>
  )
}
