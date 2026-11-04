/**
 * 份额数据多源合并。
 *
 * 为什么需要多源：
 * tushare 的 fund_share 是 T+1 同步，当晚往往只回填了部分交易所（实测 11-03 仅 94 行）；
 * 而上交所官网当晚即有当日全量（923 只）。只依赖 tushare 会让看板停在"昨天"，
 * 看不到当天国家队在沪市的动作 —— 而宽基主力 ETF 绝大多数在沪市。
 *
 * 策略：
 *   历史     -> tushare（完整、可回溯）
 *   最新沪市 -> 上交所官网按日期补（当晚即全量）
 *   深市     -> 交易所与 tushare 均为 T+1，如实保留，前端提示覆盖情况
 */

const SSE_URL = 'https://query.sse.com.cn/commonQuery.do'

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 20261103 -> 2026-11-03 */
export function compactToDash(s) {
  const t = String(s)
  return t.length === 8 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : t
}

/** 上交所：按日期取全市场 ETF 份额（单位万份）。date 形如 2026-11-03。 */
export async function fetchSSEShares(date, { signal } = {}) {
  const params = new URLSearchParams({
    isPagination: 'true',
    'pageHelp.pageSize': '4000',
    'pageHelp.pageNo': '1',
    'pageHelp.beginPage': '1',
    'pageHelp.cacheSize': '1',
    'pageHelp.endPage': '1',
    sqlId: 'COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L',
    STAT_DATE: date,
  })
  const res = await fetch(`${SSE_URL}?${params}`, {
    headers: { Referer: 'https://www.sse.com.cn/', 'User-Agent': 'Mozilla/5.0' },
    signal,
  })
  if (!res.ok) throw new Error(`上交所接口 HTTP ${res.status}`)
  const json = await res.json()
  const rows = json?.result
  if (!Array.isArray(rows) || !rows.length) return { date, shares: new Map() }

  const shares = new Map()
  for (const r of rows) {
    const code = String(r.SEC_CODE || '').trim()
    const vol = Number(r.TOT_VOL)
    if (code && Number.isFinite(vol) && vol > 0) shares.set(`${code}.SH`, vol)
  }
  return { date, shares }
}

/**
 * 从今天往前找，返回最近一个有上交所数据的交易日。
 * 跳过周末，最多回溯 maxBack 天。
 */
export async function fetchSSELatest({ maxBack = 6, signal } = {}) {
  const today = new Date()
  for (let i = 0; i < maxBack; i += 1) {
    const d = new Date(today.getTime() - i * 86400000)
    if (d.getDay() === 0 || d.getDay() === 6) continue
    const ds = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    // 瞬时失败很常见（限流/握手超时），重试一次再判为"该日无数据"，
    // 否则会把当天数据静默降级成昨天。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const r = await fetchSSEShares(ds, { signal })
        if (r.shares.size > 100) return r
        break
      } catch {
        if (attempt === 0) await new Promise((res) => setTimeout(res, 600))
      }
    }
  }
  return { date: null, shares: new Map() }
}

/**
 * 分段拉取 fund_share。
 *
 * tushare 的 fund_share 单次最多返回 2000 行。观察池 52 只时，
 * 2000 / 52 ≈ 38 个交易日 —— 这就是「为什么只有 38 天」的真正原因，
 * 不是历史深度限制（单只可回溯到 2024 年）。
 *
 * 解法：按交易日历切成每段约 1900 行以内多次请求，再按「代码|日期」去重合并。
 */
export async function fetchSharesChunked({ token, codes, start, end, signal, rowLimit = 1900 }) {
  const { query, toObjects } = await import('./tushare.js')
  const codeList = codes.join(',')
  const perChunk = Math.max(5, Math.floor(rowLimit / Math.max(1, codes.length)))

  const calRes = await query(token, 'trade_cal', { exchange: 'SSE', start_date: start, end_date: end }, 'cal_date,is_open', { signal })
  const dates = toObjects(calRes)
    .filter((r) => Number(r.is_open) === 1)
    .map((r) => r.cal_date)
    .sort()
  if (!dates.length) return { rows: [], chunks: 0 }

  const merged = new Map()
  let chunks = 0
  for (let i = 0; i < dates.length; i += perChunk) {
    const seg = dates.slice(i, i + perChunk)
    const res = await query(
      token,
      'fund_share',
      { ts_code: codeList, start_date: seg[0], end_date: seg[seg.length - 1] },
      'ts_code,trade_date,fd_share',
      { signal },
    )
    chunks += 1
    for (const r of toObjects(res)) merged.set(`${r.ts_code}|${r.trade_date}`, r)
  }
  return { rows: [...merged.values()], chunks }
}
