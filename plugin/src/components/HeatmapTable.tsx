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

  const { dates, groups, cells, max } = data
  const denom = max || 1

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
            <th scope="col" className="border-b border-etf-line1 py-3 pl-3 text-right text-meta font-normal text-etf-faint">
              合计
            </th>
          </tr>
        </thead>
        <tbody>
          {cells.map((row) => (
            <tr key={row.date} className="border-b border-etf-line1">
              <td className="py-1 pr-3 font-etf-mono text-meta tabular-nums text-etf-muted">{row.date}</td>
              {row.values.map((v, i) => (
                <td
                  key={`${row.date}-${groups[i]}`}
                  title={`${row.date} ${groups[i]} ${signed(v)} 亿`}
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
                    {v === 0 ? '·' : signed(v, Math.abs(v) >= 100 ? 0 : 1)}
                  </div>
                </td>
              ))}
              <td className="py-1 pl-3 text-right font-etf-mono text-meta font-medium tabular-nums text-etf-text">
                {signed(row.total, Math.abs(row.total) >= 100 ? 0 : 1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-meta text-etf-faint">
        <span>近 {dates.length} 个交易日 · 单位亿元</span>
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
