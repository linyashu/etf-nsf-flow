# 国家队资金流监测

用宽基 ETF 的**份额净申购**追踪国家队是否入场，以及资金流向了哪些板块。

插件名「国家队资金流监测」，侧边栏入口「国家队」。

观察 A 股「国家队」（中央汇金、证金、国新等）通过宽基 ETF 入场的迹象。

## 核心口径

**净申购额 = Δ基金总份额 × 收盘价**

这是全项目的立论基础，值得说清楚为什么不用成交额：

| 指标 | 能说明什么 | 能否判断入场 |
|---|---|---|
| 成交额 | 二级市场换手，买卖双方对倒也会放大 | 不能 |
| 价格涨跌 | 市场情绪 | 不能 |
| **Δ基金总份额** | **申赎结果：份额增加 = 真金白银申购，管理人被动买入成分股** | **能** |

ETF 每日披露基金总份额。份额增加意味着有资金完成申购、管理人必须买入成分股，这是**增量资金**。成交额分不清申购与对倒，因此本项目全部指标建立在份额变化上。

### 信号评分（0–100）

| 维度 | 权重 | 含义 |
|---|---|---|
| 净申购强度 | 45% | 近 N 日累计净申购 / 近 60 日日均绝对流量 |
| 流入广度 | 30% | 观察池内净申购为正的指数占比 |
| 逆势托底 | 25% | 沪深300 下跌日仍净申购的比例 |

「逆势托底」是汇金类资金最典型的特征——市场跌的时候它们买，涨的时候不动。

### 局限（重要）

- 份额数据**不含持有人身份**，无法直接确认买方是汇金/证金。宽基 ETF 巨量申赎是**强相关性证据**，不是直接持股披露。
- 数据 **T+1**：tushare 当晚更新前一交易日份额，因此看板最新日期通常是「上一个交易日」。
- 净值用**收盘价**近似（ETF 折溢价通常在 0.1% 内，对亿元级资金流判断影响可忽略）。

## 数据源

| 来源 | 用途 | 状态 |
|---|---|---|
| Tushare Pro（15000 积分） | ETF 每日份额、行情、基础信息、指数 | 主源 |
| TimescaleDB（www.lys153.xyz:5433） | 本地历史缓存，避免重复消耗积分 | 可用 |
| 上交所 / 深交所公开接口 | 份额交叉校验 | 备选 |
| 东方财富 push2 | 实时行情 | 已限流，未采用 |
| Wind MCP（Alice Market） | 未接入，需登录配置 | 待定 |

用 TimescaleDB 做缓存的实际收益：增量同步时若已是最新，**0.9 秒**返回、零 tushare 调用。

## 目录结构

```
src/config.py       观察池配置（BROAD_BASKET）
src/fetch.py        tushare 增量抓取
src/db.py           TimescaleDB 读写
src/analyze.py      净申购计算 + 信号评分
src/export.py       导出 web/data.json
src/verify.py       浏览器渲染验证
src/inspect_ui.py   布局体检（溢出/绘制/截断）
web/index.html      看板前端（单文件 + 本地 ECharts）
run.py              一键刷新 + 起服务
```

## 使用

```bash
# 首次：建环境
python3 -m venv .venv && ./.venv/bin/pip install tushare pandas psycopg2-binary

# 刷新数据并打开看板
./.venv/bin/python run.py

# 只刷新数据
./.venv/bin/python run.py --no-serve

# 全量重抓 700 天
./.venv/bin/python run.py --no-serve --days 700 --force
```

看板地址：<http://127.0.0.1:8899/index.html>

## 观察池（两层：板块 → 细分指数）

44 只 ETF / 33 个细分指数 / 12 个板块，按**跟踪指数**归并（国家队往往同时买多只同指数 ETF）：

| 板块 | 细分指数 |
|---|---|
| 宽基（国家队主战场） | 沪深300、上证50、中证500、中证1000、科创50、中证A500、创业板指、上证180、中证2000 |
| 金融 | 证券、银行 |
| 消费 | 主要消费、白酒 |
| 医药 | 医药卫生、医疗 |
| 科技 | 半导体、科技龙头、芯片 |
| 新能源 | 新能源车、新能源、光伏、电池 |
| 能源 | 能源、电力 |
| 资源 | 有色金属、黄金 |
| 制造 | 军工 |
| 地产 | 房地产 |
| 策略 | 红利、红利低波 |
| 主题 | 游戏、旅游、环保 |

**宽基负责判断「国家队是否入场」，行业/策略/主题负责判断「钱去了哪些板块」。**

改观察池只需编辑 `plugin/lib/analyze.js` 的 `UNIVERSE`，前端会自动适配。

## 数据新鲜度：沪深不对称

两个交易所披露节奏不同，这是必须知道的事实：

| 数据源 | 当日份额 | 说明 |
|---|---|---|
| 上交所官网 | **当晚即有** | 实测 11-03 当晚 923 只全量可用 |
| tushare `fund_share` | T+1 | 实测 11-03 当晚仅回填 94 行 |
| 深交所官网 | T+1 | 仅提供「当前规模」，无日期参数 |

**所以插件采用多源合并**：历史用 tushare，最新沪市用上交所官网补。这样当晚就能看到国家队在沪市的动作（宽基主力 ETF 绝大多数在沪市）。

看板顶部会显示数据新鲜度提示，例如「沪市已补至 2026-11-03（33 只），深市仍为上一交易日」。深市 ETF 的当日流式因此**不计入**当日汇总，这是已知的口径限制，不是 bug。

## 验证

```bash
# 浏览器实测渲染（需系统 Chrome）
./.venv/bin/python src/verify.py      # 图表数量/评分/表格行/控制台错误
./.venv/bin/python src/inspect_ui.py  # 双主题布局体检
```

当前状态：4 个图表全部绘制、双主题无横向溢出、21 只 ETF 明细、10 个指数分组。

---

## DSH 插件版（推荐）

已把看板做成 DeepSeek Harness 插件，装进 profile 后直接在 Web GUI 侧边栏使用，无需另起服务。

**位置**：`plugin/`（独立 bundle，不含 Python 依赖，Host 端用 Node 直连 tushare HTTP API）

### 安装状态

已安装并生效（`dsh-etf-nsf-flow@1.0.0`）：
- 侧边栏入口 `etf-nsf-flow` → `active: true`
- 主面板 `main/etf-nsf-flow` → `active: true`
- 工具 `etf_nsf_flow` → 已注册，可直接调用
- 数据路由 `GET /etf-flow/data.json` → 200

### 结构

```
plugin/
├── package.json            bundle 清单 + dsh.client 声明 + 构建脚本
├── cordis.patch.yml        插入插件行与配置
├── index.js                Host：tushare 拉取 + 分析 + HTTP 路由 + 工具
├── client.js               构建产物（勿手改，由 npm run build 生成）
├── lib/tushare.js          tushare HTTP 客户端（带限流识别）
├── lib/analyze.js          净申购计算与信号评分
├── src/                    Client 源码（TypeScript + React）
│   ├── client.tsx          入口：样式注入 + slot 注册
│   ├── types.ts            与 Host JSON 对应的类型
│   ├── format.ts           数值/刻度/路径工具
│   └── components/
│       ├── Dashboard.tsx   看板主体
│       ├── FlowChart.tsx   主图（累计净申购 + 当日柱 + 基准）
│       ├── FundChart.tsx   单只 ETF 份额走势
│       ├── Gauge.tsx       评分环
│       └── ErrorBoundary.tsx 渲染异常兜底
├── styles/tailwind.css     Tailwind 主题层（映射宿主 token）
├── scripts/build.mjs       构建编排
├── scripts/wrap.mjs        包 ModuleLoader 外壳
├── tsdown.config.ts        打包配置
├── tsconfig.json
├── locale/{zh,en}.json     显示标题/描述
└── icon.svg                插件图标
```

### 前端技术栈（与 dsh-context 一致）

参考 `dsh-context@0.79.0` 的实现选择同一套技术：

| 层 | 选择 | 版本 |
|---|---|---|
| 语言 | TypeScript（strict） | 7.0 |
| UI | React（宿主注入，不打进产物） | 18.3 |
| 样式 | Tailwind CSS v4，编译成 CSS 字符串运行时注入 | 4.3.3 |
| 打包 | tsdown / rolldown，输出单文件 | 0.23.1 |

构建流程：

```bash
cd plugin && npm install && npm run build   # 产出 client.js
```

三步：Tailwind 编译 CSS → 写成 `src/tailwind-css.generated.ts` → tsdown 打包 → 包 `window.__ModuleLoader__.load({ id, factory(require) })` 外壳。

**样式注入**与 dsh-context 相同：编译后的 CSS 作为字符串，运行时创建带 `data-plugin` 标记的 `<style>`，卸载时移除。

**主题**：`styles/tailwind.css` 的 `@theme` 把宿主 `--dsw-alias-*` token 映射成 Tailwind 工具类（如 `text-etf-muted`、`border-etf-line1`），UI 里不出现任何具体色值，深浅色自动跟随宿主。

### 视觉语言（unslop 之后）

设计方向由产品本身决定：**克制、精确、像仪表读数**，世界取「夜盘交易台与仪表」。

| 决策 | 取值 |
|---|---|
| 颜色语义 | **按 A 股习惯：红=流入，绿=流出**（宿主 token 里 error 是红、success 是绿，按本产品含义重新映射） |
| 强调色 | 只有一个——红，只出现在「钱在进来」这件事上 |
| 字号 | 五档：12 / 13 / 14 / 16 / 28，最小 12px |
| 字重 | 只有 400 与 500 |
| 间距 | 全部落在 4px 网格 |
| 圆角 | 标签 4 / 行与按钮 8 / 卡片 12，无胶囊 |
| 图表 | 无渐变、无发光、无阴影；柱体方角；沪深300 用中性细线不与流入抢色 |
| 签名细节 | **数据新鲜度刻度尺**——两小段分别标注沪市/深市的实际数据日，这是本产品独有的（沪深 T+1 不同步） |

改版前的实测问题（数值来自真实渲染）：19 种字号字重组合、9.5px 正文、10 处全大写宽字距、15 处色相渐变、32 处胶囊形条形、间距建在 6px 上。改版后：6 种组合、最小 12px、0 大写宽字距、0 渐变、0 处非 4px 间距。

### 数据架构：采集与展示分离

采集**只有一套**，在 mac-mini 上，复用 `stock_wiki` 的每日流水线；插件**只读**，不含任何同步逻辑。

```
mac-mini  launchd com.stockwiki.ingest-daily  工作日 19:05
   └─ deploy/stock_wiki_ingest_daily.sh
        └─ run_task.py etf_share / etf_daily / etf_basic
              └─ src/ingestion/fetchers/tushare_etf.py
                    ├─ tushare fund_share / fund_daily / fund_basic
                    └─ 上交所官网（当日沪市份额补充）
                          ↓ 写入
              NAS TimescaleDB · database = timescaledb
                          ↓ 只读
              本插件 → /etf-flow/data.json → 看板
```

**数据库**：NAS 上的 TimescaleDB（docker），同一实例下两个 database：

| database | 内容 |
|---|---|
| `timescaledb` | stock_wiki 股票表 + **ETF 三张表**（本看板数据源） |
| `postgres` | 早期独立库，已废弃，仅作冷备 |

连接地址二选一（同一实例）：`www.lys153.xyz:5433`（公网）或 `100.112.224.119:5433`（tailscale）。

#### ETF 采集任务

| 任务 | 表 | 说明 |
|---|---|---|
| `etf_share` | etf_share | 全市场 ETF 总份额。tushare T+1，当日行数不足 1200 时自动用上交所补沪市 |
| `etf_daily` | etf_daily | 全市场 ETF 日行情，约 2186 行/日 |
| `etf_basic` | etf_basic | 基础信息全量，约 3011 行 |

接入位置：`stock_wiki_ingest_daily.sh` 的 P1 段（`etf_share` + `etf_daily`）与 P3 段（`etf_basic`）。

三个设计约束：

1. **份额双源**：tushare 当晚常只回填沪市部分（实测 11-03 仅 94 行），上交所官网当日全量约 923 只。行数低于 1200 时自动补齐。
2. **2000 行截断保护**：`fund_share` 单次上限 2000，全市场已 1800+ 只，命中上限时按代码分块重取。
3. **不设行数硬校验**：当日只有沪市属正常状态，设 `min_expected_rows` 会让合法数据被拒写。

手动触发：

```bash
ssh mac-mini
cd ~/projects/stock_wiki
PYTHONPATH=src /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 \
  src/ingestion/run_task.py etf_share
```

#### 本机（MacBook）只保留导出与预览

`./venv/bin/python run.py` 从库里读出并导出 JSON，不再自带采集：

```
python run.py            # 导出并起预览
python run.py --no-serve # 只导出
```

#### 基准指数

`timescaledb.index_daily` 已含 `000300.SH` 全历史（2005 年起 5298 行），无需为看板单独采集。

### 数据量：分段拉取（tushare 单次 2000 行上限）

`fund_share` 单次最多返回 **2000 行**。52 只观察标的时，2000 / 52 ≈ **38 个交易日**——这是早期只能看到 38 天的真正原因，不是历史深度限制（单只可回溯到 2024 年）。

现在按交易日历分段请求再合并（`lib/sources.js` 的 `fetchSharesChunked`）：

| 回溯 | 分段数 | 首次拉取耗时 | JSON 体积 |
|---|---|---|---|
| 60 天 | 3 | ~12 秒 | ~450 KB |
| **120 天（当前）** | **5** | **~21 秒** | **~700 KB** |
| 250 天 | 7 | ~45 秒 | ~1.4 MB |

主图区间档位为 **20 / 60 / 120 日 + 全部**，按实际可用交易日自动裁剪（59 天时 `60 日` 仍显示，靠 1 天容差）。

**注意**：窗口是滚动的「最近 N 个交易日」，不累积。每天新增 1 天、丢掉最旧 1 天。插件不落库，只做 30 分钟内存缓存；要长期留存历史需接 TimescaleDB。

### 设计要点

- **不依赖 Python**：Host 端直接用 `fetch` 调 `https://api.tushare.pro`，插件自包含。
- **内存缓存 30 分钟**：避免反复消耗 tushare 积分；`?refresh=1` 强制刷新。
- **图表手写 SVG**：不引入 ECharts 等图表库，避免外部模块解析失败拖垮整个 slot。
- **几何量命名用 `gh`/`cw` 而非 `h`/`w`**：早期版本在图表组件里解构 `h` 把 `React.createElement` 遮蔽成数字，导致白屏；TypeScript 下明确命名从源头避免。

### 配置

改 `plugin/cordis.patch.yml` 的 `config`：

| 键 | 说明 | 默认 |
|---|---|---|
| `token` | Tushare Pro token | 已内置 |
| `lookbackDays` | 回溯交易日数 | **120** |
| `cacheMinutes` | 内存缓存分钟 | 30 |
| `storage` | `db` 读本地库 / `live` 直连数据源兜底 | **db** |
| `db.*` | 本地库连接参数 | 见上方 |
| `routePath` | 前端数据路由 | `/etf-flow/data.json` |

改完需重装 bundle 生效：

```bash
# 通过 plugin_manager 先 remove_bundle 再 install_bundle 指向 plugin/ 绝对路径
```

### Wind MCP（可选数据源）

已实测可用，端点 `https://mcp.wind.com.cn/vserver_wind_tools/mcp/`，Bearer 认证，两个工具：
`market_search_tools`（发现）+ `market_call_tool`（取数）。

它能提供**机构投资者持有比例**（如沪深300ETF 机构占 67.05%），这是比份额变化更直接的证据，但只有季度频率。当前插件未接入；如需交叉验证可在 `index.js` 增加一次 Wind 调用。
