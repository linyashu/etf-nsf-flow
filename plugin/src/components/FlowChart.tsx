import { useMemo, useRef, useState } from 'react'
import type { AnomalyDay, FlowPoint } from '../types'
import { linePath, nf, niceTicks, shortDate, signed } from '../format'
import { useMeasuredWidth } from '../useMeasuredWidth'

interface Props {
  series: FlowPoint[]
  anomalies?: AnomalyDay[]
  height?: number
}

const IN = 'var(--dsw-alias-state-error-primary)'
const OUT = 'var(--dsw-alias-state-success-primary)'
const GRID = 'var(--dsw-alias-border-l1)'
const MUTED = 'var(--dsw-alias-label-secondary)'
const FAINT = 'var(--dsw-alias-label-tertiary)'
const SURFACE = 'var(--dsw-alias-bg-layer-1)'

/**
 * 主图：累计净申购（左轴，亿元）与沪深300 收盘（右轴，点）。
 *
 * 评审修正：
 * - 右轴画**真实收盘点位**，不再把日涨跌幅按自身极值拉满（那会被读成指数点位）。
 * - 刻度走 pickTicks（值域过滤 + 边界夹取 + 最小间距），避免刻度画到画布外。
 * - 只给 |z| 最大的那天标数值，其余只留三角，避免 "+2.3σ+2.2σ" 叠字。
 * - 几何量用 gh / cw 命名，绝不用 h —— 曾因遮蔽 React.createElement 导致白屏。
 */
export function FlowChart({ series, anomalies = [], height = 320 }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [wrapRef, width] = useMeasuredWidth(760)

  const geo = useMemo(() => {
    if (series.length < 2) return null
    const padL = 56
    const padR = 60
    const padT = 18
    const padB = 30
    const cw = width - padL - padR
    const gh = height - padT - padB

    const cums = series.map((d) => d.cum)
    const cLo = Math.min(0, ...cums)
    // 顶部留 8% 余量，避免红线贴住上边框
    const cHi = Math.max(0, ...cums) + (Math.max(0, ...cums) - cLo) * 0.08 || 1

    const closes = series.map((d) => d.benchClose).filter((v): v is number => typeof v === 'number')
    const bLo = closes.length ? Math.min(...closes) : 0
    const bHi = closes.length ? Math.max(...closes) : 1
    const bPad = (bHi - bLo) * 0.12 || 1

    const x = (i: number) => padL + (i / (series.length - 1)) * cw
    const yC = (v: number) => padT + gh - ((v - cLo) / (cHi - cLo || 1)) * gh
    const yB = (v: number) => padT + gh - ((v - (bLo - bPad)) / (bHi + bPad - (bLo - bPad) || 1)) * gh

    const pickTicks = (lo: number, hi: number, yFn: (v: number) => number) => {
      const out: Array<{ v: number; y: number }> = []
      for (const t of niceTicks(lo, hi, 4)) {
        if (t < lo || t > hi) continue
        const y = Math.min(Math.max(yFn(t), padT + 8), padT + gh - 8)
        if (out.length && Math.abs(y - out[out.length - 1].y) < 20) continue
        out.push({ v: t, y })
      }
      return out
    }

    return {
      padL,
      padT,
      cw,
      gh,
      x,
      yC,
      yB,
      cTicks: pickTicks(cLo, cHi, yC),
      bTicks: pickTicks(bLo - bPad, bHi + bPad, yB),
      barMax: Math.max(...series.map((d) => Math.abs(d.inflow)), 1),
    }
  }, [series, width, height])

  if (!geo) {
    return <div className="grid h-[320px] place-items-center text-body text-etf-muted">数据点不足，无法绘图</div>
  }

  const { padL, padT, cw, gh, x, yC, yB, cTicks, bTicks, barMax } = geo
  const zeroY = yC(0)
  const cumPts = series.map((d, i) => [x(i), yC(d.cum)] as [number, number])
  const benchPts = series
    .map((d, i) => (typeof d.benchClose === 'number' ? ([x(i), yB(d.benchClose)] as [number, number]) : null))
    .filter((p): p is [number, number] => p !== null)

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const px = ((e.clientX - rect.left) / rect.width) * width
    const i = Math.round(((px - padL) / cw) * (series.length - 1))
    setHover(i >= 0 && i < series.length ? i : null)
  }

  const ht = hover !== null ? series[hover] : null
  const tickCount = Math.min(6, series.length)
  const tickIdx: number[] = []
  for (let k = 0; k < tickCount; k += 1) {
    const i = Math.round((k * (series.length - 1)) / (tickCount - 1))
    if (!tickIdx.includes(i)) tickIdx.push(i)
  }

  // 只给 |z| 最大的那天标数值，其余只留三角
  const topAnomaly = anomalies.length
    ? anomalies.reduce((a, b) => (Math.abs(b.z) > Math.abs(a.z) ? b : a))
    : null

  const last = series[series.length - 1]
  const ariaLabel = `累计净申购走势：从 ${series[0].date} 到 ${last.date}，累计 ${nf(last.cum, 0)} 亿元，最新单日 ${signed(last.inflow, 0)} 亿元`

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
        {/* 左轴：累计净申购（亿元） */}
        {cTicks.map(({ v, y }) => (
          <g key={`c${v}`}>
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
        <text x={padL - 8} y={padT - 6} textAnchor="end" fontSize={12} fill={FAINT}>
          亿元
        </text>

        {/* 右轴：沪深300 收盘（点） */}
        {bTicks.map(({ v, y }) => (
          <text
            key={`b${v}`}
            x={padL + cw + 8}
            y={y + 4}
            textAnchor="start"
            fontSize={12}
            fill={FAINT}
            className="font-etf-mono [font-variant-numeric:tabular-nums]"
          >
            {nf(v, 0)}
          </text>
        ))}
        <text x={padL + cw + 8} y={padT - 6} textAnchor="start" fontSize={12} fill={FAINT}>
          沪深300 点
        </text>

        {/* 当日净申购柱 */}
        {series.map((d, i) => {
          const bh = (Math.abs(d.inflow) / barMax) * (gh * 0.26)
          const up = d.inflow >= 0
          return (
            <rect
              key={`bar${i}`}
              x={x(i) - Math.max(2, (cw / series.length) * 0.25)}
              y={up ? zeroY - bh : zeroY}
              width={Math.max(2, (cw / series.length) * 0.5)}
              height={Math.max(bh, 1)}
              fill={up ? IN : OUT}
              opacity={0.42}
            />
          )
        })}

        {/* 沪深300 收盘：中性细线 */}
        {benchPts.length > 1 && (
          <path d={linePath(benchPts)} fill="none" stroke={MUTED} strokeWidth={1} opacity={0.45} />
        )}

        {/* 累计净申购：强调色主线 */}
        <path
          d={`${linePath(cumPts)} L${x(series.length - 1).toFixed(1)},${zeroY.toFixed(1)} L${x(0).toFixed(1)},${zeroY.toFixed(1)} Z`}
          fill={IN}
          opacity={0.08}
        />
        <path
          d={linePath(cumPts)}
          fill="none"
          stroke={IN}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* 零轴 */}
        <line x1={padL} x2={padL + cw} y1={zeroY} y2={zeroY} stroke="var(--dsw-alias-border-l2)" strokeWidth={1} />

        {/* 异常日：全部标三角，只有最强的一天标数值 */}
        {anomalies.map((a) => {
          const i = series.findIndex((d) => d.date === a.date)
          if (i < 0) return null
          const d = series[i]
          const bh = (Math.abs(d.inflow) / barMax) * (gh * 0.26)
          const up = d.inflow >= 0
          const tipY = up ? zeroY - bh - 7 : zeroY + bh + 7
          const isTop = topAnomaly !== null && a.date === topAnomaly.date
          return (
            <g key={`an${a.date}`}>
              <path
                d={`M${x(i) - 4},${tipY + (up ? 4 : -4)} L${x(i) + 4},${tipY + (up ? 4 : -4)} L${x(i)},${tipY} Z`}
                fill={FAINT}
              />
              {isTop && (
                <text
                  x={x(i)}
                  y={up ? tipY - 6 : tipY + 14}
                  textAnchor="middle"
                  fontSize={12}
                  fill={FAINT}
                  className="font-etf-mono"
                >
                  {a.z > 0 ? '+' : ''}
                  {a.z.toFixed(1)}σ
                </text>
              )}
            </g>
          )
        })}

        {/* 末点直接标注累计值 */}
        <circle cx={x(series.length - 1)} cy={yC(last.cum)} r={2.5} fill={IN} />
        <text
          x={x(series.length - 1) - 6}
          y={yC(last.cum) - 8}
          textAnchor="end"
          fontSize={12}
          fill={MUTED}
          className="font-etf-mono [font-variant-numeric:tabular-nums]"
        >
          {nf(last.cum, 0)}
        </text>

        {/* 横轴 */}
        {tickIdx.map((i) => {
          const anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'
          return (
            <text key={`x${i}`} x={x(i)} y={height - 8} textAnchor={anchor} fontSize={12} fill={MUTED}>
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
              y2={padT + gh}
              stroke={MUTED}
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.6}
            />
            <circle cx={x(hover)} cy={yC(series[hover].cum)} r={3} fill={IN} stroke={SURFACE} strokeWidth={2} />
          </g>
        )}
      </svg>

      {ht && (
        <div
          className="pointer-events-none absolute top-0 whitespace-nowrap rounded-md border border-etf-line2 bg-etf-overlay px-3 py-2 text-meta leading-4"
          style={{
            left: `${Math.min(94, Math.max(2, (x(hover!) / width) * 100))}%`,
            transform: x(hover!) / width > 0.72 ? 'translateX(-100%)' : 'translateX(-50%)',
          }}
        >
          <div className="font-medium">{ht.date}</div>
          <div className="mt-1 text-etf-muted">
            累计 <span className="font-etf-mono tabular-nums text-etf-text">{nf(ht.cum, 0)}</span> 亿
          </div>
          <div className="text-etf-muted">
            当日{' '}
            <span className={`font-etf-mono tabular-nums ${ht.inflow >= 0 ? 'text-etf-in' : 'text-etf-out'}`}>
              {signed(ht.inflow, 0)}
            </span>{' '}
            亿
          </div>
          {typeof ht.benchClose === 'number' && (
            <div className="text-etf-faint">
              沪深300 <span className="font-etf-mono tabular-nums">{nf(ht.benchClose, 0)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
