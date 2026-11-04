---
name: 国家队资金流监测
description: 用宽基 ETF 份额净申购追踪 A 股国家队入场
colors:
  surface-base: "var(--dsw-alias-bg-base)"
  surface-card: "var(--dsw-alias-bg-layer-1)"
  surface-raised: "var(--dsw-alias-bg-layer-2)"
  surface-overlay: "var(--dsw-alias-bg-overlay)"
  border-hairline: "var(--dsw-alias-border-l1)"
  border-strong: "var(--dsw-alias-border-l2)"
  ink-primary: "var(--dsw-alias-label-primary)"
  ink-secondary: "var(--dsw-alias-label-secondary)"
  ink-tertiary: "var(--dsw-alias-label-tertiary)"
  flow-in: "var(--dsw-alias-state-error-primary)"
  flow-out: "var(--dsw-alias-state-success-primary)"
  flow-in-text: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 72%, var(--dsw-alias-label-primary))"
  flow-out-text: "color-mix(in srgb, var(--dsw-alias-state-success-primary) 72%, var(--dsw-alias-label-primary))"
  hover-wash: "var(--dsw-alias-interactive-bg-hover)"
typography:
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Noto Sans, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.333
  body:
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.538
  emph:
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.428
  title:
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.375
  lead:
    fontSize: "20px"
    fontWeight: 500
    lineHeight: 1.6
  stat:
    fontSize: "28px"
    fontWeight: 500
    lineHeight: 1.143
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
rounded:
  sm: "2px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  3xl: "32px"
components:
  card:
    backgroundColor: "{colors.surface-card}"
    rounded: "{rounded.xl}"
    padding: "20px"
  seg-item:
    rounded: "{rounded.md}"
    padding: "4px 8px"
  seg-item-active:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink-primary}"
  chip-filter:
    rounded: "{rounded.md}"
    padding: "4px 8px"
  chip-filter-active:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink-primary}"
  input-search:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.lg}"
    padding: "4px 12px"
    height: "26px"
  expanded-row:
    backgroundColor: "{colors.surface-base}"
---

# Design System: 国家队资金流监测

## Overview

**Creative North Star: "夜盘交易台"**

这个面板不是一份报告，而是一块**夜间盯盘的仪表**。使用者在收盘后打开它两分钟，
需要的不是被说服，而是看清当前读数与它偏离常态的程度。因此界面不追求表现力，
追求的是**读数精度与零歧义**——数字必须自带身份（单位、分母、时间窗口、样本量），
标签必须贴着它修饰的那个数，不允许读者靠位置去猜归属。

克制是手段而非目的：所有装饰性元素被移出，颜色预算几乎全部让给「钱在进出」
这一件事。整个面板只有一个强调色（红＝流入），它出现的地方就意味着「这里有动作」。
其余视觉区分靠字重、字色层级与等宽数字完成，不靠色块、渐变或投影。

这一判断有数据支撑：项目在近三年非重叠样本上验证过，ETF 净申购是唯一对未来
20 日收益显著相关的指标（t=-2.18 / +2.91）。界面必须让这个有效信号占据
视觉最高位，而把统计上不显著的描述性指标压到明确的次位——不是靠文案声明，
而是靠形状、色阶与位置。

**Key Characteristics:**
- 无投影、无渐变、无发光。深度只用 background 层级（base → card → raised）与 1px 描边表达
- 单一强调色：红＝流入。绿＝流出时压暗使用，不与之争抢
- 数字一律等宽 + `tabular-nums`，表格可逐行对齐扫读
- 字号只允许六档，间距只走 4px 网格
- 描述性指标与参与评分的指标在形状上区分（描边条 vs 实心条）
- 颜色从不单独承载语义：所有涨跌都同时带 `+` / `-` 号

## Colors

调色板本身几乎无色——全部从中性灰阶构建，只为「资金流向」保留一个高饱和度的红。

### Primary
- **流入红** (`state-error-primary`, 深色 #e5484d / 浅色 #dc2626)：唯一强调色。
  只用于三处——正的净申购数值、累计净申购折线与面积、当日净申购柱。
  它出现即代表「钱在进来」。全屏占比控制在 10% 以内。
- **流入红·文本** (`flow-in-text`)：由流入红与当前主题的 label-primary 混色而成。
  直接使用宿主红做 12–13px 正文只有 4.49:1，hover 时 3.86:1，不达 AA；
  混色后深色 6.09:1 / 浅色 7.38:1。

### Neutral
- **底色** (`bg-base`, 深 #141415 / 浅 #fafafa)：页面背景与展开行内嵌区。
- **卡面** (`bg-layer-1`, 深 #19191b / 浅 #ffffff)：所有卡片。与底色只差一档亮度，
  靠 1px 描边界定边界，不靠阴影。
- **抬升面** (`bg-layer-2`, 深 #232325 / 浅 #f4f4f5)：选中态、输入框底、进度条轨道。
- **发丝线** (`border-l1`, 8% 前景色)：卡片描边、表格分隔线。全部是 1px。
- **强线** (`border-l2`, 14% 前景色)：需要强调的边界，如零轴、竖分隔、焦点框。
- **主文字** (`label-primary`)：数值与标题。深色 15:1，浅色 17.9:1。
- **次文字** (`label-secondary`)：标签、注释。
- **弱文字** (`label-tertiary`)：单位、脚注。深色 4.79:1 已贴近 AA 下沿，
  不再往下压。

### Named Rules

**The One Voice Rule.** 强调色全屏只出现在「钱在进来」这件事上，占比不超过 10%。
它的稀缺性就是它的信息量。不要用它标标题、标选中、标品牌。

**The Zero-Is-Not-Missing Rule.** 数值 0 与「无数据」是两个语义，不可互替。
缺失一律显示「—」并说明原因，绝不渲染成 0。

**The Paired Sign Rule.** 颜色从不单独承载语义。每一处涨跌值都同时带 `+` / `-` 号，
色盲用户与黑白打印都能读。红绿只是第二通道。

**The Mixed Text Rule.** 语义色做文字必须经过 `color-mix` 与当前主题文字色混合，
不得直接使用宿主 `state-*-primary`。填充可以用原色，文字不行。

## Typography

**Display / Text Font:** 系统无衬线栈（-apple-system, BlinkMacSystemFont, Segoe UI, …）
**Numeric Font:** JetBrains Mono（ui-monospace, SFMono-Regular, Menlo）

**Character:** 正文与标题用系统字体保持中性、不抢戏；一切数字换成等宽体。
这个切换本身就是本系统的核心排版手法——读者一眼就能区分「这是标签」与「这是读数」，
并且表格里几十个数字能沿小数点对齐成列。

### Hierarchy
- **Stat** (500, 28px, 1.143)：判词卡里的大数字。仅在需要一眼抓住总量时使用。
- **Lead** (500, 20px, 1.6)：判词行。首屏唯一的结论句，一行内读完（实测 1350px 内）。
- **Title** (500, 16px, 1.375)：页面标题。
- **Emph** (500, 14px, 1.428)：卡片标题（h2）、区块内主数值。
- **Body** (400, 13px, 1.538)：表格单元格、正文。
- **Meta** (400, 12px, 1.333)：标签、单位、注释、脚注。**这是最小字号，不允许更小。**

### Named Rules

**The Six-Step Rule.** 字号只有六档：12 / 13 / 14 / 16 / 20 / 28。
不新增档位，不出现 11px、11.5px、13.5px。层级靠字重与颜色补足，不靠微调字号。

**The Number Is Mono Rule.** 任何呈现数字的文本都用等宽体并开启 `tabular-nums`。
包括百分比、单位前的金额、表格里的计数。

## Layout

单列纵向流，卡片之间 12px 间距，卡片内边距 20px，页面左右留白 24px。
所有间距落在 4px 网格上。

信息顺序即决策顺序：
判词（结论）→ 主图与排行（趋势与结构）→ ETF 明细（可下钻的凭证）
→ 热力图（日度分布）→ 结构与存量（慢变量）→ 市场温度（描述性）→ 口径（约束）。

**响应式**：
- ≥1280px：主图与排行左右并排（2.5fr : 1fr），判词卡四列仪表带
- 1024–1280px：并排解除，判词带窄列仍可一行
- <1024px：判词带第一列独占整行（含仪表盘 + 两行文字，需约 304px）
- <768px：温度五格降为 3+2 两行，证据链三列保持三列不塌陷

**模块分组**：同一行并列的多个数据模块必须满足三个条件，缺一个就会出现对齐问题。

1. **结构一致**：每个模块都走「标题 → 说明行 → 1px 分隔线 → 内容 → 底部注」，
   不允许某个模块把副标题塞进标题行、另一个模块放在说明行——否则分隔线与内容起始会错位。
2. **边界明确**：用 1px `border-l1` 竖线分隔（`divide-x`），不靠 whitespace。
3. **底部贴齐**：容器 `flex flex-col`，内容区 `flex-1 content-start`，底部注 `mt-auto`。
4. **竖线等高**：用 `divide-x` 时**不要**给容器加 `items-center`——那会让各格高度不一、
   竖线长短参差。正确做法是让格撑满（默认 stretch），在各格内部用 `flex items-center`
   把内容垂直居中。

实测（结构与存量三列）：统一前分隔线错位 33px、底边参差；统一后六段位置完全一致：

| 段 | 列1 | 列2 | 列3 |
|---|---|---|---|
| 标题 | 2454 | 2454 | 2454 |
| 说明行 | 2480 | 2480 | 2480 |
| 分隔线 | 2503 | 2503 | 2503 |
| 内容起始 | 2511 | 2511 | 2511 |
| 底部注 | 2707 | 2707 | 2707 |

任何宽度都不允许横向滚动。表格用 `table-fixed` + `colgroup` 固定比例，
名称列 `truncate`，其余列右对齐。

### Named Rules

**The No-Scroll Rule.** 页面在任何宽度下都不得出现横向滚动条。
表格列数多时固定列宽比例并截断名称，不靠横向滚动。

## Elevation & Depth

**本系统不使用阴影。** 深度完全靠 background 亮度阶梯与 1px 描边表达：

```
bg-base (#141415)  →  card (#19191b)  →  raised (#232325)
   页面最底              卡片表面           选中/输入/轨道
```

三级之间亮度差极小，边界由 `border-l1` 的 8% 前景色界定。这种处理在深色主题下
不会产生「贴纸感」，在浅色主题下也不会糊成一片灰。

浮层（tooltip）用 `bg-overlay` + `border-l2` + `rounded-lg`，同样不投影。

### Named Rules

**The Flat-By-Default Rule.** 表面永远是平的。需要区分层级时加深或提亮一档背景，
不添加阴影。选中态用 `bg-layer-2`，不用投影或外发光。

## Shapes

圆角克制且统一，最大 12px，避免「卡片糖果化」：
- 卡片与 tooltip：12px（`rounded-xl`）
- 输入框、分段控件外框：8px（`rounded-lg`）
- 分段项、筛选 chip：6px（`rounded-md`）
- 进度条、色块、图例小方块：2px（`rounded-sm`）——几乎方正，像仪表上的刻度条
- 状态点、头像位：全圆

描边一律 1px，颜色分两档（8% / 14% 前景色）。没有 2px 以上的边框，
也没有虚线边框。

图表内部沿用手绘 SVG，线宽 1–2px，不用渐变填充（面积填充用 8% 透明度的实色）。

## Components

### Cards / Containers
- **Shape:** 圆角 12px
- **Background:** `bg-layer-1`
- **Border:** 1px `border-l1`，无阴影
- **Internal Padding:** 20px，卡片内标题与内容之间 16px
- **Character:** 安静到近乎不可见，把注意力让给里面的数字

### Segmented Control（主图跨度 / 统计窗口 / 排行切换）
- **Shape:** 外层 8px 圆角浅底容器，内部项 6px 圆角
- **Default:** 文字 `ink-secondary`，透明底
- **Active:** 文字 `ink-primary` + 500 字重，背景 `bg-layer-2`
- **Hover:** 仅文字提亮至 `ink-primary`，不改背景
- **Disabled:** 文字 `ink-tertiary` + 40% 透明度
- **Character:** 选中靠「提亮一档背景 + 加粗」，不靠强调色

### Filter Chips（板块筛选）
- 与分段控件同构，但无外层容器，直接平铺
- **Active:** `bg-layer-2` + `ink-primary`
- **Character:** 14 个 chip 平铺时仍保持安静，不能形成色块阵列

### Inputs（搜索框）
- **Shape:** 8px 圆角，`bg-layer-2` 底，1px `border-l1`
- **Focus:** 边框提亮至 `border-l2`，不加外发光、不改背景
- **Placeholder:** `label-secondary`（6.1:1）。浏览器默认会给 placeholder 加
  50% 透明度，必须显式覆盖 `opacity: 1`，否则实测只有 3.55:1

### Table（ETF 明细 / 热力表）
- 无外框，表头 12px `ink-tertiary`，行间 1px `border-l1`
- 数字列右对齐 + 等宽，名称列左对齐 + 截断
- 行悬停 `hover-wash`（6% 前景色），不改变文字颜色
- 可展开行的首列是真 `<button>`，带 `aria-expanded` / `aria-controls`，
  整行点击作为鼠标便利

### Progress Bar（分位条）
- 轨道 4px 高，2px 圆角
- **参与评分的指标**：实心强调色填充
- **描述性指标**：描边轨道 + 中性色半透明填充
- 这条区分是刻意的——同样的形状不能同时表达「信号」与「非信号」

### Signature: 判词卡（Verdict Card）
整个面板的入口。结构固定为三层：

1. **判词行**：20px `Lead`，一句带具体数字的结论，横跨整卡一行
2. **仪表带**：2–4 个关键读数，竖向 1px 分隔线切分，`divide-x`
3. **证据链**：分位条 / 持续性 / 扩散度三列，把绝对值放进历史坐标
4. **口径行**：底部 12px `ink-tertiary`，写明集中度分母与数据缺口

判词的措辞必须由阈值驱动且阈值可见（hover 显示判定依据），不允许出现
无标准的定性词。

### Signature: 市场温度（Descriptive Block）
五格描述性指标，明确标注「描述性 · 不参与评分 · 不预测方向」。
与判词卡的关键区别：分位条用描边样式，数值不用强调色，卡片位置在页面末尾。

## Do's and Don'ts

### Do:
- **Do** 让每个数值自带单位与口径。写「净申购（亿）」「近 5 日」「样本 119 个交易日」，
  而不是只给一个裸数字。
- **Do** 用等宽体 + `tabular-nums` 呈现一切数字，让表格能逐行对齐。
- **Do** 把「描述性」与「参与评分」的指标在形状上区分开（描边条 vs 实心条）。
- **Do** 并列的多个数据模块之间必须有视觉边界（1px 竖线），且各模块内部结构一致：
  「标签 → 主值 → 辅助行」。只靠间距分组，读者无法判断哪些数字属于同一模块。
- **Do** 在深色与浅色两个主题下都实测对比度，语义色做文字必须 ≥4.5:1。
- **Do** 让统计窗口控件作用于页面上所有相关区块；切窗口时同步重算。
- **Do** 用 `color-mix` 把语义色混入当前主题文字色，一个表达式同时适配双主题。
- **Do** 给可展开行用真 `<button aria-expanded>`，保留整行点击作为鼠标便利。

### Don't:
- **Don't** 使用阴影、渐变、发光、背景模糊。深度只用背景亮度阶梯 + 1px 描边。
- **Don't** 新增字号档位。六档之外的字号一律不接受（含 11px）。
- **Don't** 用强调色标注非「资金流入」的东西——不标标题、不标选中、不标品牌。
- **Don't** 让颜色单独承载语义。涨跌必须同时带 `+` / `-` 号。
- **Don't** 把口径写在页脚充当免责声明。改变数字含义的说明必须贴着那个数字。
- **Don't** 用「·」之类的符号表示 0 值——会被读成「无数据」。
- **Don't** 把「数据未到」渲染成 `0`。缺失必须显示为「—」并附口径说明；
  0 是「确实没流入」，两者是不可交换的语义。
- **Don't** 只靠 whitespace 分隔并列模块。没有竖线或卡片边界时，
  多行内容高度不一会让读者串列。
- **Don't** 在同一张卡里混排不同时间窗口的数字。
- **Don't** 用「近 30 日」这类固定文案描述一个实际由参数决定的窗口。
- **Don't** 在插件里加入数据写入逻辑。采集归 mac-mini 的定时任务，本插件只读。
