import { ACCENT } from '../format'

interface Props {
  score: number
}

/** 评分环：细环 + 单一强调色，不做渐变也不发光。 */
export function Gauge({ score }: Props) {
  const r = 32
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, Number(score) || 0))

  return (
    <div
      className="relative h-[80px] w-[80px] shrink-0"
      role="img"
      aria-label={`综合评分 ${v ? v.toFixed(0) : 0} 分，满分 100`}
    >
      <svg width={80} height={80} className="-rotate-90" aria-hidden>
        <circle cx={40} cy={40} r={r} fill="none" stroke="var(--dsw-alias-bg-layer-2)" strokeWidth={4} />
        <circle
          cx={40}
          cy={40}
          r={r}
          fill="none"
          stroke={ACCENT}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <span className="font-etf-mono text-stat font-medium tabular-nums">{v ? v.toFixed(0) : '—'}</span>
      </div>
    </div>
  )
}
