import { useMemo, useRef, useState } from 'react'

interface Props {
  series: Array<{ time: string; pct: number | null }>
}

const COLS = 240 // A 股一个交易日的分钟数

/**
 * 当日分时曲线。
 *
 * 只做两件事：价格折线 + 基准线（昨收 = 视口内首点）。
 * 刻意不画成交量柱——分时的价值在「形态」（急拉/跳水/横盘），
 * 加量柱会把 100px 高的容器塞满，反而看不清价格怎么走。
 *
 * 横轴固定为完整交易日（09:30–11:30 / 13:00–15:00），
 * 不随数据点多少伸缩——否则盘中看和收盘后看，同一形态会呈现不同斜率。
 */
export function MinuteChart({ series }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const H = 120
  const PAD_T = 10
  const PAD_B = 18
  const PAD_L = 52
  const PAD_R = 8

  const geo = useMemo(() => {
    const pts = series.filter((p) => p.pct !== null) as Array<{ time: string; pct: number }>
    if (pts.length < 2) return null

    const first = 0 // 基准是 0%（相对当日第一笔）
    const values = [...pts.map((p) => p.pct), 0]
    const rawLo = Math.min(...values)
    const rawHi = Math.max(...values)
    // 上下各留 8% 余量，避免线贴边
    const pad = (rawHi - rawLo) * 0.08 || Math.abs(rawHi) * 0.1 || 0.1
    const lo = rawLo - pad
    const hi = rawHi + pad

    // 时间 → 竖直位置：早盘 09:30–11:30、午盘 13:00–15:00 合并成 0..240
    const minuteOf = (t: string) => {
      const hm = t.slice(11)
      const [h, m] = hm.split(':').map(Number)
      const x = h * 60 + m
      if (x <= 11 * 60 + 30) return x - (9 * 60 + 30)
      if (x >= 13 * 60) return 120 + (x - 13 * 60)
      return 120 // 午休归到上午收盘
    }

    return { pts, first, lo, hi, rawLo, rawHi, minuteOf }
  }, [series])

  const width = 760
  const cw = width - PAD_L - PAD_R
  const ch = H - PAD_T - PAD_B

  if (!geo) {
    return (
      <div className="grid h-[120px] place-items-center text-meta text-etf-faint">暂无分时数据</div>
    )
  }

  const { pts, first, lo, hi, rawLo, rawHi, minuteOf } = geo
  const xOf = (i: number) => PAD_L + (Math.max(0, Math.min(COLS, minuteOf(pts[i].time))) / COLS) * cw
  const yOf = (v: number) => PAD_T + ((hi - v) / (hi - lo)) * ch

  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p.pct).toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  const lastY = yOf(last.pct)
  const zeroY = yOf(first)
  const up = last.pct >= 0
  const color = up ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)'

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const px = ((e.clientX - rect.left) / rect.width) * width
    // 找最近的数据点
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < pts.length; i += 1) {
      const d = Math.abs(xOf(i) - px)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    setHover(best)
  }

  const hoverPt = hover !== null ? pts[hover] : null

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${H}`}
        className="block h-[120px] w-full"
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`当日分时：${pts.length} 个点，最新涨跌幅 ${last.pct}%`}
      >
        {/* 昨收基准线 */}
        <line
          x1={PAD_L}
          x2={width - PAD_R}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--dsw-alias-border-l1)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />

        {/* 刻度：左轴上下边界价 */}
        <text x={PAD_L - 6} y={PAD_T + 4} textAnchor="end" fontSize={10} fill="var(--dsw-alias-label-tertiary)">
          {`${rawHi.toFixed(2)}%`}
        </text>
        <text x={PAD_L - 6} y={PAD_T + ch} textAnchor="end" fontSize={10} fill="var(--dsw-alias-label-tertiary)">
          {`${rawLo.toFixed(2)}%`}
        </text>

        {/* 午休分隔 */}
        <line
          x1={PAD_L + cw / 2}
          x2={PAD_L + cw / 2}
          y1={PAD_T}
          y2={PAD_T + ch}
          stroke="var(--dsw-alias-border-l1)"
          strokeWidth={1}
        />

        {/* 价格线 */}
        <path d={linePath} fill="none" stroke={color} strokeWidth={1.3} strokeLinejoin="round" />

        {/* 最新点 */}
        <circle cx={xOf(pts.length - 1)} cy={lastY} r={2.4} fill={color} />

        {/* 横轴刻度 */}
        {['09:30', '11:30', '13:00', '15:00'].map((t, i) => {
          const anchor = i === 0 ? 'start' : i === 3 ? 'end' : 'middle'
          const px = PAD_L + (i / 3) * cw
          return (
            <text key={t} x={px} y={H - 4} textAnchor={anchor} fontSize={10} fill="var(--dsw-alias-label-tertiary)">
              {t}
            </text>
          )
        })}

        {hover !== null && (
          <line
            x1={xOf(hover)}
            x2={xOf(hover)}
            y1={PAD_T}
            y2={PAD_T + ch}
            stroke="var(--dsw-alias-border-l2)"
            strokeWidth={1}
          />
        )}
      </svg>

      {hoverPt && (
        <div
          className="pointer-events-none absolute top-0 whitespace-nowrap rounded-md border border-etf-line2 bg-etf-overlay px-2 py-1 font-etf-mono text-meta tabular-nums leading-4"
          style={{
            left: `${Math.min(92, Math.max(2, (xOf(hover!) / width) * 100))}%`,
            transform: xOf(hover!) / width > 0.7 ? 'translateX(-100%)' : 'translateX(-50%)',
          }}
        >
          <span className="text-etf-faint">{hoverPt.time.slice(11)}</span>
          <span className={`ml-2 ${hoverPt.pct >= 0 ? 'text-etf-intext' : 'text-etf-outtext'}`}>
            {hoverPt.pct >= 0 ? '+' : ''}
            {hoverPt.pct.toFixed(2)}%
          </span>
        </div>
      )}
    </div>
  )
}
