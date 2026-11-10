/**
 * 深交所 ETF 份额（官方快照）。
 *
 * 为什么需要它：
 * 深市份额一直是我们最大的口径缺口——tushare 的 fund_share 对深市回填极慢，
 * 实测 2026-11-04 的数据到 11-05 下午仍未入库，导致合计被系统性低估约 20~38%。
 *
 * 深交所官方基金列表（fund.szse.cn / CATALOGID=1000_lf）提供全量 ETF 当前规模，
 * 分 39 页、每页 20 条，实测扫 37 页即可覆盖我们全部 25 只深市标的，耗时约 7.5 秒。
 *
 * ⚠️ 关键口径（实测确认，不要被 metadata.subname 误导）：
 *   - `metadata.subname` 是**页面日期**（如 2026-11-10），不是数据日期
 *   - 实际数值是 **T-1 的确认值**：实测 11-10 页面拿到的 159915 = 4,586,245.49，
 *     与库内 11-09 的 4,586,245 完全一致，而与 11-06 的 4,537,245 不同
 *   - 深交所口径：T 日晚为预估值、T+1 早为确认值。我们取到的稳定值属后者
 *
 * 因此本模块返回的 trade_date 必须由调用方显式指定为 **T-1**，
 * 绝不能直接拿 subname 当数据日期——那是造假数据。
 */

const SZSE_URL = 'https://fund.szse.cn/api/report/ShowReport/data'
const PAGE_SIZE = 20 // 服务端固定 20 条/页，传更大也无效

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 拿北京时间的昨天（跳过周末，但不处理法定节假日——由调用方校验数据日期） */
export function prevTradingDayGuess(now = new Date()) {
  const d = new Date(now.getTime())
  d.setDate(d.getDate() - 1)
  // 周日(0) / 周六(6) 往前推到周五
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1)
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 抓深交所 ETF 当前规模快照。
 *
 * @param {Set<string>|string[]} wantedCodes  关心的 6 位代码（不带后缀）；给空则取全量
 * @param {object} opts
 * @returns {Promise<{shares: Map<string, number>, subname: string|null, scannedPages: number, fetchedAt: string}>}
 *          shares 的 key 是带后缀的 ts_code（如 159915.SZ），value 单位万份
 */
export async function fetchSZSEshares(wantedCodes, { signal, maxPages = 45 } = {}) {
  const want = wantedCodes instanceof Set ? wantedCodes : new Set(wantedCodes ?? [])
  const shares = new Map()
  let subname = null
  let page = 1
  let pageCount = 1
  let scanned = 0

  while (page <= pageCount && page <= maxPages) {
    const params = new URLSearchParams({
      SHOWTYPE: 'JSON',
      CATALOGID: '1000_lf',
      TABKEY: 'tab1',
      selectJjlb: 'ETF',
      PAGENO: String(page),
    })
    let payload
    try {
      const res = await fetch(`${SZSE_URL}?${params}`, {
        headers: { Referer: 'https://fund.szse.cn/', 'User-Agent': 'Mozilla/5.0' },
        signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      payload = await res.json()
    } catch (err) {
      // 单页失败不整体放弃：已拿到的部分仍可用，但要如实标记
      if (shares.size === 0) throw err
      break
    }

    const table = Array.isArray(payload) ? payload[0] : null
    const meta = table?.metadata
    const rows = table?.data
    if (!meta || !Array.isArray(rows)) throw new Error('深交所基金列表返回结构改变')

    if (page === 1) {
      subname = meta.subname ?? null
      pageCount = Number(meta.pagecount) || 1
    }
    scanned += 1
    if (rows.length === 0) break

    for (const r of rows) {
      const codeMatch = /<u>(\d{6})<\/u>/.exec(r.sys_key ?? '')
      if (!codeMatch) continue
      const code = codeMatch[1]
      if (want.size && !want.has(code)) continue
      const volMatch = />([\d,.]+)<\/a>/.exec(r.dqgm ?? '')
      if (!volMatch) continue
      const vol = Number(volMatch[1].replace(/,/g, ''))
      if (Number.isFinite(vol) && vol > 0) shares.set(`${code}.SZ`, vol)
    }

    // 全部标的都拿到就提前结束，不必扫完 39 页
    if (want.size && shares.size >= want.size) break
    page += 1
    // 轻微间隔，避免触发风控
    await new Promise((r) => setTimeout(r, 120))
  }

  return {
    shares,
    subname,
    scannedPages: scanned,
    fetchedAt: new Date().toISOString(),
  }
}
