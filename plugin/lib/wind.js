/**
 * Wind MCP 客户端（只用于季度频率的机构持有比例）。
 *
 * 为什么单独一路：
 * 份额数据是日频、来自 tushare/交易所；机构持有比例是**季度**存量数据，
 * 来自 Wind 的基金持有人结构接口。两者频率差一个数量级，混在日频口径里会误导，
 * 所以单独取、单独缓存、单独展示。
 *
 * 端点：https://mcp.wind.com.cn/vserver_wind_tools/mcp/（Streamable HTTP）
 * 工具：market_call_tool（直接指定 toolName，跳过 market_search_tools 发现）
 */

const ENDPOINT = 'https://mcp.wind.com.cn/vserver_wind_tools/mcp/'

/** Wind 的基金代码要带交易所后缀，我们的代码已经是这个格式。 */
function normalize(code) {
  return String(code).trim().toUpperCase()
}

/** 从 SSE 响应里取出 JSON-RPC 结果。 */
function parseSse(text) {
  const lines = String(text).split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const json = JSON.parse(payload)
      if (json?.result) return json.result
    } catch {
      // 非本次结果的行，跳过
    }
  }
  return null
}

/** 解析 Wind 返回的 markdown 表格，抽出代码与机构持有比例。 */
function parseHolderTable(md) {
  const out = new Map()
  const rows = String(md).split('\n').filter((l) => l.trim().startsWith('|'))
  for (const row of rows) {
    const cells = row
      .split('|')
      .map((c) => c.trim())
      .filter((c, i, arr) => !(i === 0 && c === '') && !(i === arr.length - 1 && c === ''))
    if (cells.length < 4) continue
    // 跳过表头与分隔行
    if (!/^\d+$/.test(cells[0])) continue
    const code = cells[1]
    if (!/^\d{6}\.(SH|SZ)$/.test(code)) continue
    const period = cells[3] || null

    // 机构持有比例：优先找显式的“机构...比例”列
    let instPct = null
    let feederPct = null
    for (let i = 4; i < cells.length; i += 1) {
      if (instPct === null && /^-?\d+(\.\d+)?$/.test(cells[i])) {
        instPct = Number(cells[i])
      } else if (instPct !== null && feederPct === null && /^-?\d+(\.\d+)?$/.test(cells[i])) {
        feederPct = Number(cells[i])
        break
      }
    }
    if (instPct === null) continue
    out.set(code, { code, name: cells[2], period, instPct, feederPct })
  }
  return out
}

/**
 * 拉取若干 ETF 的机构持有比例。
 * 失败一律返回空 Map —— 这是补充证据，不该拖垮主看板。
 */
export async function fetchHolderStructure(codes, apiKey, { signal, timeoutMs = 25000 } = {}) {
  if (!apiKey || !codes?.length) return { rows: [], error: 'no-key' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'market_call_tool',
        arguments: {
          toolName: 'fund_get_holder_structure',
          arguments: {
            windCodes: codes.map(normalize).slice(0, 50),
            includeFields: ['f_holder_institution_totalholdingpct'],
          },
        },
      },
    }

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) return { rows: [], error: `HTTP ${res.status}` }

    const text = await res.text()
    const result = parseSse(text)
    if (!result) return { rows: [], error: 'no-result' }
    if (result.isError) return { rows: [], error: String(result.content?.[0]?.text || 'wind-error').slice(0, 120) }

    const md = result.content?.[0]?.text ?? ''
    const parsed = parseHolderTable(md)
    return { rows: [...parsed.values()], error: null }
  } catch (err) {
    return { rows: [], error: String(err?.message || err).slice(0, 120) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
