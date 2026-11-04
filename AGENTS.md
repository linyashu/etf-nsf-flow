# AGENTS.md

面向在本仓库工作的 AI agent 与人类协作者的工程约定。
**视觉与设计系统另见 [DESIGN.md](./DESIGN.md)。**

---

## 项目是什么

用宽基 ETF 的**份额净申购**追踪 A 股「国家队」（汇金类资金）入场。
核心口径：

```
净申购额 = Δ基金总份额 × 收盘价
```

选择份额而不是成交额的原因：份额是申赎的直接结果，成交额只反映换手，
无法区分申购与对倒。

## 组成

```
plugin/          DeepSeek Harness 插件（Host + React 客户端）
  index.js       Host：注册工具与 HTTP 路由，组装 payload
  lib/           分析层（纯函数，无 I/O）
    analyze.js   核心指标计算
    market.js    市场温度（描述性指标）
    intraday.js  盘中量能预警（腾讯行情，交易时段才拉取）
    store.js     TimescaleDB 只读访问
    sources.js   上交所份额补充
    tushare.js   tushare HTTP 客户端
    wind.js      Wind MCP（季度机构持有比例）
  src/           客户端（TypeScript + React 18）
    components/  界面组件
    format.ts    数字格式化
  styles/        Tailwind v4 token
  preview/       本地预览脚手架（不打包进产物）
src/             Python 导出管道（读库 → data/dashboard.json）
run.py           导出 + 本地预览入口
```

## 数据链路

```
mac-mini launchd com.stockwiki.ingest-daily（工作日 19:05）
  → stock_wiki 的 ingestion 框架（etf_share / etf_daily / etf_basic）
  → NAS TimescaleDB · database = timescaledb
  → 本插件只读
```

**采集与展示分离**：插件不含任何写入逻辑。不要在插件里加同步代码。

## 构建与验证

```bash
cd plugin

# 类型检查（改任何 .ts/.tsx 后必跑）
./node_modules/.bin/tsc --noEmit

# 完整构建（Tailwind → 生成模块 → tsdown → 打包）
node scripts/build.mjs

# 本地预览（改 UI 后必跑，不要只看源码）
node preview/build.mjs
cd preview && python3 -m http.server 8901
# 打开 http://127.0.0.1:8901/
```

Python 侧：

```bash
./.venv/bin/python run.py --no-serve   # 只导出 JSON
./.venv/bin/python run.py              # 导出 + 起预览
```

**装进 DSH 前必须重新构建**，否则 GUI 加载的是旧 bundle：

```
plugin_manager remove_bundle → install_bundle
```

`client.js` 改动还需要浏览器硬刷新（Cmd+Shift+R）。

## 密钥

**绝不把凭据提交到仓库。** 配置来源按优先级：

| 凭据 | 位置 |
|---|---|
| tushare token、DB 密码、Wind key | `plugin/cordis.patch.yml`（已 gitignore） |
| 同上（Python 侧） | `.env`（已 gitignore） |

模板：`plugin/cordis.patch.example.yml`、`.env.example`

`plugin/index.js` 与 `src/config.py` 只从环境变量读，**不给任何默认密钥值**。

> 踩过的坑：把 `cordis.patch.yml` 的 token 清空后发现插件读的正是这个文件，
> 报 `缺少 Tushare token`。改配置后需要重装插件才会重新加载。

## 代码规范

### 数字

- **每个数值必须自带身份**：单位、分母、时间窗口、样本量。缺一项就会产生歧义。
- 同一视觉分组内小数位必须一致。
- 计数类（家/只）用整数，金额类（亿/万亿）按量级定，比率类（%/倍）保留 1–2 位。
- 格式化统一走 `src/format.ts` 的 `nf` / `signed` / `toneOf`，不要内联 `toFixed`。

### 颜色

- 只用 `--etf-*` 语义 token，**不写死 hex**。所有颜色来自宿主 CSS 变量。
- 红 = 流入，绿 = 流出（A 股习惯，与欧美相反）。这是刻意的语义重映射，
  见 `styles/tailwind.css` 注释。
- 文本用 `text-etf-intext` / `text-etf-outtext`（已混色保证对比度），
  填充用 `bg-etf-in` / `bg-etf-out`。直接拿 `state-error-primary` 当文字色
  在 layer1 上只有 4.49:1，不达 AA。

### 字号

只有六档：`text-meta`(12) / `text-body`(13) / `text-emph`(14) / `text-title`(16) /
`text-lead`(20) / `text-stat`(28)。**不要新增字号**，不要出现 11px / 11.5px。

### 布局

- 4px 间距网格。
- 卡片 `rounded-xl` + 1px `border-etf-line1`，**不用阴影**。
- 数据密集区域用等宽字体 + `tabular-nums`。

### React

- 几何变量命名避开 `h`（曾因 `const { h } = geo` 遮蔽 `React.createElement` 导致白屏）。
- SVG 图表必须用 `useMeasuredWidth` 让 `viewBox` 宽度等于容器宽度，
  否则 `preserveAspectRatio="meet"` 会产生 gutter，导致鼠标坐标错位。
- 列表 `key` 用业务 id，不用数组下标。

## 已知陷阱

### 聚合必须落在日期轴上

`etf_share` 是「多管理人 × 多交易日」的行集合。按行切片（`list.slice(-5)`）
取到的是**最后 5 行（约 1 天）**，不是最后 5 个交易日。
多管理人指数会严重低估——实测沪深300 曾显示 285.79 亿而正确值 613.97 亿。

正确做法：先按日期聚合成每日序列，再在日期轴上取窗口。

### 沪深披露不同步

- 上交所：当晚即有当日全量
- 深交所：T+1
- tushare `fund_share`：T+1，且当晚常只回填部分（实测 11-03 仅 94 行）

所有窗口必须用**池级统一日期轴**，保证「合计 = 各基金之和」严格成立。
深市缺的那天按 0 计入，并在 UI 明确标注。

### tushare 单次 2000 行上限

`fund_share` 单次最多 2000 行。52 只标的时只能覆盖约 38 个交易日。
需要分段拉取（见 `lib/sources.js` 的 `fetchSharesChunked`）。

### 「零流入」与「数据未到」必须区分

深市份额 T+1，最新一日通常只有沪市。均匀日期轴把缺失日按 0 计入是**聚合正确**
（合计＝各基金之和），但**渲染绝不能显示成 0**——读者会读成「这个指数今天一点没买」。

`heatmap()` 用 `cellMap.has(key)` 判断该日该指数是否有数据，无数据输出 `null`，
前端渲染为「—」并附图例说明。小计列同步排除 null 项。

同类问题：0 值不要用「·」表示（会被读成无数据），直接用 `0.0`。

### `zt_pool` 必须按 pool 字段过滤

`zt_pool` 一张表装了 5 类股票，**不加过滤会把跌停和次新股都算成涨停**：

| pool | 含义 | 11-03 家数 |
|---|---|---|
| `zt` | 涨停 | 48 |
| `zb` | 炸板（触板未封住） | 34 |
| `dt` | 跌停 | 17 |
| `strong` | 强势股 | 144 |
| `sub_new` | 次新股 | 162 |

曾漏写 `WHERE pool = 'zt'`，把全部 405 行当成涨停，导致 11-03 报出
「涨停 405 家」（真实 48 家，**错 8.4 倍**），还把 17 家跌停算进涨停数。

**板块涨跌幅口径不用自己判断**：实测 `zt` 池主板 47 家涨幅 9.82~10.13（限 10%）、
创业板 1 家 20.00（限 20%），tushare 的 `limit_list_d` 已按各板块限制正确判定，
不存在「科创板/北交所 10%+ 被算成涨停」的问题。

正确写法：

```sql
count(*) FILTER (WHERE pool = 'zt') AS limit_up,
count(*) FILTER (WHERE pool = 'dt') AS limit_down,
count(*) FILTER (WHERE pool = 'zb') AS broken
```

顺带：`炸板率 = zb / (zt + zb)` 比单看炸板数更能反映封板意愿，已加入市场温度。

### 时间的时区

`generatedAt` 是 UTC ISO 串，展示前必须转本地时区，
否则北京用户会看到早 8 小时的时间。

### 窗口切换要全局一致

任何「统计窗口」控件必须让所有相关区块同步重算。
曾出现过切到 20 日后判词变了、但集中度与证据链仍显示 5 日值，
同一张卡混排两个窗口，两组数字导向相反结论。

## 盘中量能预警（唯一不依赖 T+1 的信号）

份额净申购要等申赎数据，沪深都是 T+1。**盘中唯一能当天看到的信号是成交额**，
由 `lib/intraday.js` 提供。

数据源：腾讯行情 `qt.gtimg.cn`（GBK 编码，单次可批量取数十只，无需 token）。

核心算法：

```
同时点倍数 = 当日累计成交额 ÷ (20日均额 × 当前时段进度)
进度 = 已交易分钟数 ÷ 240      （9:30–11:30 + 13:00–15:00）
主动净买入 = (外盘 − 内盘) ÷ (外盘 + 内盘) × 成交额
```

不除进度的后果：午间的量永远只有全天一半，看起来永远是缩量。

**三条必须保留的限定**（它们同时出现在 UI 和 payload.warn 里，不要在改版时删掉）：

1. 成交额是换手，任何人都贡献；宽基 ETF 一二级套利会产生反向成交，稀释信号
2. 主动净买入是逐笔成交方向推算，**不是资金净流入、也不是基金申赎**
3. 统计上成交额对未来 20 日收益不显著（t=-0.09），仅作预警，**不参与评分**

实现注意：
- 只在 `phase` 为 morning / lunch / afternoon 时拉取，盘前与收盘后返回 null
- 时段判断必须用 `Asia/Shanghai`，不能直接读服务器本地时区
- 行情时间戳的日期与库内份额日期不同（行情是今日、份额是 T-1），
  `asOfDate` 取行情日期，`shareDate` 另存

## 指标取舍原则

**不要凭直觉加指标。** 本项目做过严格验证（近三年非重叠样本，
每 20 个交易日取 1 个独立观测，沪深300 未来 20 日收益）：

| 指标 | 低分位→20日 | 高分位→20日 | 判定 |
|---|---|---|---|
| ETF 净申购 | -3.24% (t=-2.18) | +4.81% (t=2.91) | **有效** |
| 全市场成交额 | -0.12% (t=-0.09) | -1.06% (t=-1.00) | 不显著 |
| 两融余额 | +1.29% (t=0.80) | -2.67% (t=-1.83) | 不显著 |
| 主力净流入 | +0.11% (t=0.07) | +1.30% (t=0.82) | 不显著 |

注意：若不做非重叠抽样，成交额会显示 t=7.18、"A股总市值" t=11.89，
但那是样本重叠与时间聚集导致的伪显著（地量日 462/530 落在 2005-2006 年，
是时代效应）。**新指标上线前必须跑这个检验。**

相关背景：`stock_wiki` 项目用 11 年数据把 8 条择时规则删到只剩 1 条，
其中「连续跌破年线」是严重反指（30 日 +2.10%, p<0.0001）。

## 提交前自查

- [ ] `tsc --noEmit` 通过
- [ ] `node scripts/build.mjs` 通过
- [ ] 预览页三宽度（1440/1024/768）无横向溢出、无 console error
- [ ] 未提交任何凭据（`git diff --cached | grep` 扫一遍）
- [ ] 若改了 UI，重启预览并实际点击验证，不要只看源码推断
