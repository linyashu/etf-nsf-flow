import { useMemo, useRef, useState } from 'react'
import type { FundSeriesPoint } from '../types'
import { linePath, nf, niceTicks, shortDate, signed } from '../format'
import { useMeasuredWidth } from '../useMeasuredWidth'

interface Props {
  series: FundSeriesPoint[]
  height?: number
}

const IN = 'var(--dsw-alias-state-error-primary)'
const OUT = 'var(--dsw-alias-state-success-primary)'
const MUTED = 'var(--dsw-alias-label-secondary)'
const FAINT = 'var(--dsw-alias-label-tertiary)'
const GRID = 'var(--dsw-alias-border-l1)'
const SURFACE = 'var(--dsw-alias-bg-layer-1)'

/**
 * 单只 ETF 走势：按交易终端的「价格 + 成交量」分层。
 *
 *   上区：份额（左轴，亿份）与收盘价（右轴），两线叠加看「份额涨而价格跌」的托底特征
 *   下区：当日净申购柱（红进绿出），高度按绝对值归一化
 *
 * 几何量不用 h 命名 —— 早期版本把 React.createElement 的别名 h 遮蔽成数字，导致白屏。
 */
export function FundChart({ series, height = 200 }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  // viewBox 宽度跟容器走，避免等比缩放居中造成坐标错位
  const [wrapRef, width] = useMeasuredWidth(760)

  const geo = useMemo(() => {
    if (series.length < 2) return null
    const padL = 52
    const padR = 52
    const padT = 14
    const padB = 26
    const cw = width - padL - padR
    const gh = height - padT - padB

    // 上区画线，下区画柱，中间留一道分隔
    const lineH = gh * 0.66
    const gapH = gh * 0.08
    const barTop = padT + lineH + gapH
    const barH = gh - lineH - gapH

    const shares = series.map((d) => d.share)
    const closes = series.map((d) => d.close)
    const sPad = (Math.max(...shares) - Math.min(...shares)) * 0.14 || 1
    const sLo = Math.min(...shares) - sPad
    const sHi = Math.max(...shares) + sPad
    const cPad = (Math.max(...closes) - Math.min(...closes)) * 0.18 || 0.05
    const cLo = Math.min(...closes) - cPad
    const cHi = Math.max(...closes) + cPad

    const x = (i: number) => padL + (i / (series.length - 1)) * cw
    const yShare = (v: number) => padT + lineH - ((v - sLo) / (sHi - sLo || 1)) * lineH
    const yClose = (v: number) => padT + lineH - ((v - cLo) / (cHi - cLo || 1)) * lineH

    // niceTicks 按 step 取整后可能超出真实值域（会画到画布外，实测出现过 y=-17）。
    // 三步处理：只留值域内的值 -> 把 y 夹进绘图带 -> 按最小间距去重。
    const pickTicks = (lo: number, hi: number, yFn: (v: number) => number, minGap = 18) => {
      const out: Array<{ v: number; y: number }> = []
      for (const t of niceTicks(lo, hi, 3)) {
        if (t < lo || t > hi) continue
        const y = Math.min(Math.max(yFn(t), padT + 8), padT + lineH - 8)
        if (out.length && Math.abs(y - out[out.length - 1].y) < minGap) continue
        out.push({ v: t, y })
      }
      return out
    }

    return {
      padL,
      padT,
      cw,
      lineH,
      barTop,
      barH,
      x,
      yShare,
      yClose,
      shareTicks: pickTicks(sLo, sHi, yShare),
      closeTicks: pickTicks(cLo, cHi, yClose),
      barMax: Math.max(...series.map((d) => Math.abs(d.inflow)), 1),
    }
  }, [series, width, height])

  if (!geo) {
    return (
      <div className="grid place-items-center text-meta text-etf-muted" style={{ height }}>
        该 ETF 数据不足
      </div>
    )
  }

  const { padL, padT, cw, lineH, barTop, barH, x, yShare, yClose, shareTicks, closeTicks, barMax } = geo
  const sharePts = series.map((d, i) => [x(i), yShare(d.share)] as [number, number])
  const closePts = series.map((d, i) => [x(i), yClose(d.close)] as [number, number])
  const barW = Math.max(2, (cw / series.length) * 0.55)
  // 等分取 6 个刻度。按索引取模会在末尾留下两个挨得很近的标签（实测 11-02/11-03 相距 34px 而文字宽 50px）。
  const tickIdx: number[] = []
  const TICKS = 6
  for (let k = 0; k < TICKS; k += 1) {
    const i = Math.round((k * (series.length - 1)) / (TICKS - 1))
    if (!tickIdx.includes(i)) tickIdx.push(i)
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const px = ((e.clientX - rect.left) / rect.width) * width
    const i = Math.round(((px - padL) / cw) * (series.length - 1))
    setHover(i >= 0 && i < series.length ? i : null)
  }

  const ht = hover !== null ? series[hover] : null

  const firstPt = series[0]
  const lastPt = series[series.length - 1]
  const ariaLabel = `份额走势：${firstPt.date} 到 ${lastPt.date}，份额由 ${nf(firstPt.share, 0)} 亿份变为 ${nf(lastPt.share, 0)} 亿份，区间净申购 ${signed(series.reduce((a, d) => a + d.inflow, 0), 0)} 亿元`

  return (
    <div ref={wrapRef} className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        className="block"
        role="img"
        aria-label={ariaLabel}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* 上区网格 + 左轴（份额） */}
        {shareTicks.map(({ v, y }) => (
          <g key={`s${v}`}>
            <line x1={padL} x2={padL + cw} y1={y} y2={y} stroke={GRID} strokeWidth={1} />
            <text
              x={padL - 8}
              y={y + 4}
              textAnchor="end"
              fontSize={12}
              fill={MUTED}
              className="font-etf-mono [font-variant-numeric:tabular-nums]"
            >
              {nf(v, 0)}
            </text>
          </g>
        ))}

        {/* 右轴（收盘价） */}
        {closeTicks.map(({ v, y }) => (
          <text
            key={`c${v}`}
            x={padL + cw + 8}
            y={y + 4}
            textAnchor="start"
            fontSize={12}
            fill={FAINT}
            className="font-etf-mono [font-variant-numeric:tabular-nums]"
          >
            {nf(v, 2)}
          </text>
        ))}

        {/* 收盘价：中性细线，作对照 */}
        <path d={linePath(closePts)} fill="none" stroke={FAINT} strokeWidth={1} opacity={0.75} />

        {/* 份额：强调色主线 */}
        <path
          d={`${linePath(sharePts)} L${x(series.length - 1)},${padT + lineH} L${x(0)},${padT + lineH} Z`}
          fill={IN}
          opacity={0.07}
        />
        <path
          d={linePath(sharePts)}
          fill="none"
          stroke={IN}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* 下区分隔 */}
        <line x1={padL} x2={padL + cw} y1={barTop - 4} y2={barTop - 4} stroke={GRID} strokeWidth={1} />

        {/* 当日净申购柱 */}
        {series.map((d, i) => {
          const bh = (Math.abs(d.inflow) / barMax) * barH
          const up = d.inflow >= 0
          const base = barTop + barH
          return (
            <rect
              key={`b${i}`}
              x={x(i) - barW / 2}
              y={base - bh}
              width={barW}
              height={Math.max(bh, 1)}
              fill={up ? IN : OUT}
              opacity={0.55}
            />
          )
        })}

        {/* 横轴：等分刻度，首尾贴边对齐不越界 */}
        {tickIdx.map((i) => {
          const anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'
          return (
            <text key={`x${i}`} x={x(i)} y={height - 6} textAnchor={anchor} fontSize={12} fill={MUTED}>
              {shortDate(series[i].date)}
            </text>
          )
        })}

        {hover !== null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={padT}
              y2={height - 20}
              stroke={MUTED}
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.55}
            />
            <circle
              cx={x(hover)}
              cy={yShare(series[hover].share)}
              r={3}
              fill={IN}
              stroke={SURFACE}
              strokeWidth={2}
            />
          </g>
        )}
      </svg>

      {ht && (
        <div
          className="pointer-events-none absolute top-0 whitespace-nowrap rounded-md border border-etf-line2 bg-etf-overlay px-3 py-2 text-meta leading-4"
          style={{
            left: `${Math.min(96, Math.max(1, (x(hover!) / width) * 100))}%`,
            transform: (x(hover!) / width) > 0.72 ? 'translateX(-100%)' : 'translateX(-50%)',
          }}
        >
          <div className="font-medium">{ht.date}</div>
          <div className="mt-1 text-etf-muted">
            份额 <span className="font-etf-mono tabular-nums text-etf-text">{nf(ht.share, 1)}</span> 亿份
          </div>
          <div className="text-etf-muted">
            净申购{' '}
            <span className={`font-etf-mono tabular-nums ${ht.inflow >= 0 ? 'text-etf-in' : 'text-etf-out'}`}>
              {signed(ht.inflow)}
            </span>{' '}
            亿
          </div>
          <div className="text-etf-faint">
            收盘 <span className="font-etf-mono tabular-nums">{nf(ht.close, 3)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
