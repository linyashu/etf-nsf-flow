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
    intraday.js  盘中量能预警（腾讯行情，盘前除外都拉取）
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

### 两融余额的字段选择与日期

`margin_detail` 里三个相似字段，含义不同：

| 字段 | 含义 | 11-02 全市场 |
|---|---|---|
| `rzye` | **融资**余额 | 2.2840 万亿 |
| `rqye` | **融券**余额 | 281.8 亿 |
| `rzrqye` | **融资融券**余额 = 前两者之和 | 2.3121 万亿 |

标签写「两融余额」就必须用 `rzrqye`。曾用 `rzye`，标签与口径不符（少算 280 亿融券）。

另外两融是 **T+1 发布**：`asOf=11-03` 时库里最新只到 11-02。
必须把真实数据日期透出到 UI（`item.dataDate`），否则用户会以为是当天的数。

### `round` 这类工具函数要确认存在

`market.js` 曾直接调用 `round()` 但该文件没有定义它，
异常被上层 `catch` 吞掉，表现是**整项指标静默消失**（两融从 6 项里少了 1 项），
而不是报错。新增指标后要核对 `items.length` 是否符合预期。

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
加权折溢价 = Σ(单只折溢价 × 成交额) ÷ Σ成交额
单只折溢价 = (价格 − IOPV) ÷ IOPV
```

**折溢价是最接近申赎本质的盘中指标**：溢价 → 套利者「申购+卖出」→ 份额将增；
折价 → 「买入+赎回」→ 份额将减。它比「外盘−内盘」更直接，因为后者只是成交方向。
IOPV 来自腾讯行情字段 `[78]`（实测 510300 价格 4.175 vs IOPV 4.1728，偏离 0.05%）。

不除进度的后果：午间的量永远只有全天一半，看起来永远是缩量。

**三条必须保留的限定**（它们同时出现在 UI 和 payload.warn 里，不要在改版时删掉）：

1. 成交额是换手，任何人都贡献；宽基 ETF 一二级套利会产生反向成交，稀释信号
2. 主动净买入是逐笔成交方向推算，**不是资金净流入、也不是基金申赎**
3. 统计上成交额对未来 20 日收益不显著（t=-0.09），仅作预警，**不参与评分**

实现注意：
- **收盘后也要拉取**（`phase` 为 morning / lunch / afternoon / closed）。
  15:00 后行情仍是当天完整数据，此时倍数是「全天 vs 20日均额」，
  正是当天最终的量能结论。只有 `pre`（盘前）没有意义。
  曾错误地只在交易时段拉取，导致收盘后卡片整个消失，用户以为坏了。
- 非交易日靠「行情日期 == 北京今天」过滤——周末拉到的会是上一交易日数据
- 时段判断必须用 `Asia/Shanghai`，不能直接读服务器本地时区
- 行情时间戳的日期与库内份额日期不同（行情是今日、份额是 T-1），
  `asOfDate` 取行情日期，`shareDate` 另存
- 收盘后 `progress=1`，`multiple` 与 `dayRatio` 相等，UI 不要重复展示

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

## 数据时效性

**ETF 份额本质上是 T+1**，这是交易所披露规则，不是工程问题。
实测三种源当天都拿不到（2026-11-04 20:45）：

| 数据 | 来源 | 当天可用 | 延迟 |
|---|---|---|---|
| ETF 日线 | tushare `fund_daily` | 19:07 已有 2201 条 | 0 天 |
| ETF 份额 | tushare `fund_share` | 当天仅 32 行 | **1 天** |
| 沪市份额 | 上交所官网 | 当天 **0 条** | **1 天** |
| 深市份额 | 深交所官网 | 快照仍是前一日 | **1 天** |
| 两融 | tushare `margin_detail` | 次日 | 1 天 |
| 成交额 / 折溢价 | 腾讯行情 | 实时 | 0 |

> 曾误以为「上交所官网当晚即有当日全量」，实测不成立，已修正注释。

### 采集节奏

| 时间 | 任务 | 作用 |
|---|---|---|
| 工作日 19:05 | `stock_wiki_ingest_daily.sh` | 全量采集（日线当天已有） |
| **周一–周六 07:00** | `etf_morning_backfill.py` | 补采 T+1 份额，用户上班即见最新 |

晨间补采用独立脚本而非 `run_task.py`：
后者用 `date.today()` 推导交易日，且 `is_trading_day()` 在周六直接跳过，
早上 07:00 会去拉「当天尚未开盘」的数据。本脚本显式取「上一个已收盘交易日」
（从昨天往前找），周二~周六早上都能正确落到昨天/上周五。

### 延迟监控

`etf_share` / `etf_daily` 有 `created_at timestamptz DEFAULT now()`
（历史行置 NULL 表示未知）。`data_health.py` 的 `_ingest_delay_hours()` 输出
「首次写入时刻 − 交易日 15:00」，是时效性最直接的度量。

> `ADD COLUMN ... DEFAULT now()` 会把全部历史行填成迁移时刻，
> 必须先 `DROP NOT NULL` 再 `UPDATE ... SET NULL`，否则监控全被污染。

## 指标自检

```bash
cd plugin
node scripts/check-metrics.mjs          # 完整检查，失败退出码 1
node scripts/check-metrics.mjs --json   # 机器可读
node scripts/check-metrics.mjs --asof 2026-11-03
# npm run check
```

**改动任何指标、SQL、口径后必跑。** 它检查五类问题：

| 类别 | 检查内容 |
|---|---|
| 结构 | 每个指标带齐 单位 / 小数位 / 样本量 / 数据日期 |
| 自洽 | 组=板块=基金（4 个周期）、集中度=Top3÷正流入、评分=加权和、净申购=Δ份额×收盘 |
| 范围 | 分位 ∈[0,100]、比例 ∈[0,1]、流入指数 ≤ 总数、涨+跌 ≤ 当日股票数 |
| 新鲜 | 份额不落后 >3 天、带 dataDate 的指标落后 ≤3 天、52 只全有行情 |
| **口径** | **静态断言**：涨停必须 `pool='zt'`、两融必须 `rzrqye`、净申购必须 `SHARE_TO_YI`、盘中必须 `Asia/Shanghai` |

最后一类最重要。前三类都是数值检查，**抓不住「字段选错」**——
把 `rzrqye` 换成 `rzye`、把 `pool` 过滤删掉，算出来的仍是合法数字，只是语义错了。
项目三次数据事故（涨停 405、两融 2.28、日期未标）全部属于这一类，
所以对这些关键 SQL 直接做源码断言防回归。

实测：注入三种历史 bug，脚本分别报出
「涨停按 pool='zt' 过滤 缺失」「两融用 rzrqye 而非 rzye」「评分 75.9 vs 重算 70.91」。

## 提交前自查

- [ ] `tsc --noEmit` 通过
- [ ] `node scripts/check-metrics.mjs` 通过（改了指标/SQL 时必跑）
- [ ] `node scripts/build.mjs` 通过
- [ ] 预览页三宽度（1440/1024/768）无横向溢出、无 console error
- [ ] 未提交任何凭据（`git diff --cached | grep` 扫一遍）
- [ ] 若改了 UI，重启预览并实际点击验证，不要只看源码推断
