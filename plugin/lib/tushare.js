/**
 * Tushare Pro HTTP 客户端。直接走 https://api.tushare.pro，无需 Python 依赖。
 */

const ENDPOINT = 'https://api.tushare.pro'

export class TushareError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'TushareError'
    this.code = code
  }
}

/**
 * 调用一个 tushare 接口，返回 { fields, items }。
 * 网络错误与业务错误分开抛出，便于上层区分重试。
 */
export async function query(token, apiName, params = {}, fields = '', { timeoutMs = 20000, signal } = {}) {
  if (!token) throw new TushareError('缺少 Tushare token', 'NO_TOKEN')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_name: apiName, token, params, fields }),
      signal: controller.signal,
    })
    if (!res.ok) throw new TushareError(`HTTP ${res.status}`, 'HTTP_' + res.status)
    const json = await res.json()
    if (json.code !== 0) {
      const msg = String(json.msg || '')
      // tushare 限流返回 40203 / 每分钟最多访问
      const limited = /每分钟|最多访问|频率|超过/.test(msg)
      throw new TushareError(msg || 'tushare 返回错误', limited ? 'RATE_LIMIT' : 'API_ERROR')
    }
    return { fields: json.data?.fields ?? [], items: json.data?.items ?? [] }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 把 tushare 的 fields/items 转成对象数组。 */
export function toObjects({ fields, items }) {
  return items.map((row) => {
    const obj = {}
    for (let i = 0; i < fields.length; i += 1) obj[fields[i]] = row[i]
    return obj
  })
}

/** 按 YYYYMMDD 生成交易日列表（跳过周末；tushare 有 trade_cal，这里做轻量兜底）。 */
export function recentDates(days) {
  const out = []
  const now = new Date()
  for (let i = 0; out.length < days && i < days * 2.2; i += 1) {
    const d = new Date(now.getTime() - i * 86400000)
    const wd = d.getDay()
    if (wd === 0 || wd === 6) continue
    const s = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    out.push(s)
  }
  return out.reverse()
}

export function fmtDate(s) {
  if (!s) return ''
  const t = String(s)
  return t.length === 8 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : t
}
