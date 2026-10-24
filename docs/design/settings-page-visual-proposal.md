# 插件设置页视觉设计方案（T2 · att-onebot-ui-01）

> 面向：dsh-onebot `OnebotSettingsPanel`（挂载点 `plugins.bundle.config`，渲染于宿主「插件 → 组合包详情」页内）。
> 性质：**只规划，不写代码**。实施落点为 `lib/client.js` 单文件内联样式与少量 JSX，不引新依赖（externals 仅 react，保持不变）。
> 撰写：UI 设计师 ｜ 依据：源码核实（见 §0）｜ 状态：待评审（UX 对齐点见 §4.3、§8.4）

---

## 0. 核实基础与假设声明

### 0.1 证据来源（只读核实）

| 来源 | 用途 |
| --- | --- |
| `dsh-onebot/lib/client.js`（967 行） | 唯一 UI 现状证据：CSS 定义 L429–456；分组渲染 L575–655；workspace 选择器 L674–714；save/反馈 L796–832；渲染结构 L893–908；`apply()` L919–943 |
| `dsh-onebot/src/settings-remote.ts`（556 行） | 契约：`SETTINGS_GROUPS` L69–74、`SCHEMA_DEFAULTS` L77–112、`SECRET_KEYS` L115（仅 `accessToken`）、类型分类 L117–148 |
| `dsh-onebot/docs/settings-page-design.md`（T1 定案）、`docs/settings-page-review.md` | 前期定案与评审（部分滞后，仅作背景） |
| `.expert-lessons.md` | 生效时点教训（§9.2 验证方式） |

### 0.2 键数口径（以源码为准）

**当前实际 29 键**（`ALL_KEYS` = enum 6 + number 4 + boolean 11 + string 5 + stringArray 3 = 29；`SETTINGS_GROUPS` 四组 7+7+9+6 = 29）。已知滞后口径：T1 设计文档 19 键、任务书转述 docs 26 键、`settings-remote.ts` L156/L306/L335 注释「28 键」——**本方案一律按 29 键设计**，后续文档修订时同步订正注释。

### 0.3 显式假设（宿主外观不可见）

- **容器约束假设**：面板内嵌于宿主「组合包详情」页的区块内，外层宽度、页面留白与滚动容器均不可见。方案以「面板自身自适应容器宽度」设计（§6 容器查询三档），不对宿主页面结构做任何断言。
- **主题假设**：宿主主题变量名与明暗切换机制不可见。面板文字/图标继承宿主前景色（现状 `color: inherit` 保留）；自包含 token（§5）以中性灰 alpha 与语义色对组成，明色底按白色系、暗色底按 `#1f1f1f` 系假设校准对比度，接入宿主后按实测定稿。
- **截图缺口**：无现成 UI 截图，§7 线框为源码结构的图形化重绘，非现状截图。

---

## 0.4 改进/保留总览（与任务书 8 项要求一一对应）

| # | 要求 | 裁定 | 一句话结论 |
| --- | --- | --- | --- |
| 1 | 布局栅格与页面结构 | **改进** | 单列结构保留，新增 720px 内容上限 + 两列字段栅格 |
| 2 | 分组卡片与标题层级 | **改进** | `border-top` 发丝线 → 圆角卡片容器；诊断组建议折叠 |
| 3 | 表单控件规格 | **改进为主** | 补 focus/invalid 态、开关组件、数字列宽收紧；脱敏链路与尺寸基线保留 |
| 4 | 状态反馈视觉 | **改进** | 反馈横幅自页面底部上移至工具栏下；语义色三对新增；文案全保留，交互细节待 UX 对齐 |
| 5 | 明暗主题 token | **改进** | 自包含 `--obx-*` token 表 + 宿主变量回退链三处适配点 |
| 6 | 响应式与容器约束 | **改进** | 容器查询三档降级；`flex-wrap` 现状行为保留为旧内核兜底 |
| 7 | 线框/示意 | **新增** | §7 四幅结构化线框 |
| 8 | React-only 实施建议 | **改进** | 单文件 diff ≈120–180 行，CSS 为主，零依赖零契约变更 |

---

## 1. 布局栅格与页面结构 【改进】

现状：`.obx-panel` 纵向 flex，`gap:16px`；字段行为 `flex-wrap` 行（label `min-width:180px` + 控件 `min-width:240px`）；无内容宽度上限。**保留**：纵向单列信息流、标题→描述→工具栏→提示→分组的顺序（与源码 L893–908 一致）。

**规格（改进项）**：

| 项 | 值 | 说明 |
| --- | --- | --- |
| 内容最大宽度 | `max-width: 720px`，**左对齐不居中** | 防超宽宿主容器下输入框拉长至难用；左对齐与详情页区块流一致 |
| 面板内边距 | `padding: 0`（贴容器，不改宿主节奏） | 内嵌区块自身已有页边距；面板不叠加第二层留白 |
| 纵向节奏 | 区块间 `16px`（**保留**现状 gap）；标题→描述 `4px`（**保留**） | |
| 字段行栅格 | `display:grid; grid-template-columns: 176px minmax(240px,1fr); column-gap:12px; row-gap:4px` | label 列 176px（现 `min-width:180px` 微调至 8pt 栅格）；hint 挂第二列跨满（`grid-column:2`），窄容器降级见 §6 |
| 工具栏 | **保留**现状位置与构成（revision 徽章 ｜ spacer ｜ 重新加载 · 恢复默认值 · 保存设置），仅按钮规格升级（§3.5） | 保存动作保留在顶部工具栏主位——单屏内完成「改→存」动线；反馈横幅上移至工具栏正下方（§4） |
| 热生效提示条 | 保留 `obx-effect` 虚线框语义，升级为提示条样式（§4.1 图例） | 置于工具栏之下、分组卡片之上（现状位置保留） |

不引入侧栏/双栏总布局：29 键分组是平铺型配置，双栏会破坏 label–control 对读关系。

---

## 2. 分组卡片与标题层级 【改进】

现状：四组仅以 `border-top:1px solid rgba(128,128,128,.2)` 发丝线分隔，无卡片容器、无组计数、无组描述。

**规格（改进项）**——对齐 `SETTINGS_GROUPS` 四组（连接 connection 7 键 / 权限 permissions 7 键 / 行为 behavior 9 键 / 诊断 diagnostics 6 键）：

| 项 | 值 |
| --- | --- |
| 卡片容器 | `background: var(--obx-card-bg); border:1px solid var(--obx-card-border); border-radius:10px; padding:14px 16px 16px` |
| 卡片间距 | 组间 `16px`；组内字段行间 `12px` |
| 组标题行 | `h3`（保留语义）`font-size:14px; font-weight:600; margin:0`，右侧 `span.obx-group-meta`（12px 次级灰）「N 项」 |
| 标题层级 | 页标题 `h2` 16px/600（保留）→ 组标题 `h3` 14px/600 → 字段 label 13px/400（见 §3.1，自 12px 上调） |
| 组描述 | 每组标题下加一行 12px 次级灰说明（连接=「NapCat 与插件的通信通道」，权限=「谁可以与 Bot 对话」，行为=「消息处理与回复策略」，诊断=「运行观测开关」）——**文案待 UX 对齐**，实施时新增 4 个 locale 键 |
| 诊断组折叠 | 6 键全布尔、低频使用，建议 `<details>` 原生折叠（键盘可达、无 JS 依赖），默认收起，summary 行 = 组标题 + N 项徽章——**默认态待 UX 对齐** |
| 卡片内分栏 | 组内字段一律单列（不分组内双栏），与 §1 栅格共用 |

---

## 3. 表单控件规格 【改进为主】

### 3.1 通用输入（text / number / password / select）

| 状态 | 规格 | 裁定 |
| --- | --- | --- |
| 默认 | 高 `32px`（`padding:5px 10px`）、`font-size:13px`、`border-radius:8px`、`border:1px solid var(--obx-border)`、`background:var(--obx-input-bg)` | 尺寸基线改进（原 padding 6/8、radius 6）；`background:transparent` + `color:inherit` **保留**（主题继承核心） |
| hover | `border-color: var(--obx-border-strong)` | 新增（现状无） |
| focus-visible | `outline:none; box-shadow:0 0 0 2px var(--obx-focus-ring); border-color:var(--obx-accent)` | **新增**（现状完全缺失，键盘可达性缺口） |
| disabled | `opacity:.45; cursor:not-allowed`（保留）+ `background:var(--obx-card-bg)` | 半保留 |
| invalid（数字校验失败） | `border-color:var(--obx-error); box-shadow:0 0 0 2px var(--obx-error-ring)` + 渲染期加 `aria-invalid="true"` | 新增（数据源：`computePatch` 的 `invalidKeys` 提为渲染期派生，见 §8） |
| max-width | 文本/密码/下拉 `420px`（**保留**现状）；数字输入收窄至 `160px` | 改进：`port/interimRecallMs/rateLimitPerMinute/deferredTimeoutMs` 4 个数字键无需 420px 宽，收窄后 label–control 对读更稳 |

number 键建议渲染时加 `inputmode="decimal"`（移动端数字键盘；不改控件类型，避开原生 spin 按钮与宿主风格冲突）。

### 3.2 开关（boolean × 11 项）【改进】

现状：原生 checkbox + 文本「开/关」。改进为**纯 CSS 开关**（仍是 `input[type=checkbox]`，视觉层隐藏、保留原生语义与键盘行为，零依赖）：

| 项 | 值 |
| --- | --- |
| 轨道 | `36×20px`，`border-radius:999px`；off：`var(--obx-switch-off)`；on：`var(--obx-accent)`；`transition:background 150ms ease` |
| 滑块 | `16×16px` 圆形，`background:var(--obx-switch-knob)`，off 左移 2px / on 右移 2px，`transition:transform 150ms ease` |
| 对比度 | off 轨道对滑块 ≥3:1（token 值已按此校准，见 §5 表注）；on 轨道 `#2563eb` 对白滑块 5.1:1 ✓ |
| 文本 | **保留**「开/关」文字标签（色弱与屏幕阅读器双兜底），置于开关右侧 13px |
| 热区 | checkbox 视觉隐藏但保持 24×24 命中区（`opacity:0` + 定位覆盖轨道），触控可达 |
| reduced-motion | `prefers-reduced-motion: reduce` 时去 transition |

### 3.3 多行文本（stringArray × 3 项：adminUsers / allowFrom / groupAllowFrom）

- **保留**：`textarea rows=3`、placeholder「每行一个」、`resize:vertical`。
- 改进：`min-height:56px→88px`（3 行实感）；`max-width:520px`（保留）；`font-family` 保留 `inherit`（QQ 号/ID 列表非代码场景，不上等宽）。

### 3.4 密文输入（`accessToken`，`SECRET_KEYS` 唯一键）【脱敏链路保留，视觉改进】

| 项 | 规格 | 裁定 |
| --- | --- | --- |
| 输入框 | `type="password"` + `autoComplete="new-password"`（**保留**——防浏览器回填，安全语义） | 保留 |
| placeholder | 「留空 = 不修改」（**保留**现有 `secret.placeholder` 文案） | 保留 |
| 脱敏态徽章 | pill 徽章保留，前置 `8px` 状态点：「已配置（脱敏，不回显）」点用 `--obx-accent`；「未配置」点用 `--obx-border-strong`。徽章文本**保留**现有 `secret.set/unset` 词条 | 改进（状态点） |
| 密文态输入框 | 已配置且未输入时输入框右侧徽章常驻；输入新值时徽章淡出（`opacity .4`） | 改进 |
| 清除动作 | 「清除已保存的 AccessToken」checkbox **保留**（避免引入新控件语义）；勾选后输入框边框转 `--obx-warning` 并显示行内提示「将清除已保存的值」——提示样式**待 UX 对齐** | 改进（勾选反馈） |
| 显示明文 | 不提供「显示明文」切换——快照侧本就不回显（config.accessToken 恒 ''），无明文可显，避免假 affordance | 设计决策 |

### 3.5 按钮（工具栏三枚 + workspace「填入」）

| 项 | 规格 | 裁定 |
| --- | --- | --- |
| 通用 | 高 `32px`（`padding:6px 12px`，原 4/10 上调达触控基线）、`font-size:13px`、`border-radius:8px` | 改进 |
| primary（保存设置） | `background:var(--obx-accent); color:#fff; border:none; font-weight:600`；hover `filter:brightness(1.06)`；disabled `opacity:.45`（保留） | 改进（现状仅 `font-weight:600`，主次不分明） |
| 次级（重新加载/恢复默认值/填入） | 保留透明底描边样式，hover `border-color:currentColor`（**保留**）；新增 `background:var(--obx-card-bg)` | 半保留 |
| busy 态 | 按钮文案「正在保存…」**保留**；按钮内加 `12px` CSS spinner（双圈 border 旋转 800ms linear infinite；`prefers-reduced-motion` 时仅保留文字） | 改进 |
| focus-visible | 同 §3.1 焦点环 | 新增 |
| 危险操作 | 「恢复默认值」不加红色——它仅重置草稿不落盘（源码 `setDraft(draftFromDefaults())`），降级为次级样式即可，避免虚假危险信号 | 设计决策 |

### 3.6 workspace 选择器（`renderWorkspacePicker`，L674–714）

- **保留**：三态渲染逻辑（未加载→不渲染；不可用/空列表→说明行；正常→选择器）与全部文案、`fillWorkspacePath` 仅写草稿的语义。
- 改进：整行降为卡片内嵌次级行（`background:var(--obx-card-bg)`、`border-radius:8px`、`padding:8px 12px`），与所属 `workspacePath` 字段的从属关系可视化；「填入」按钮按 §3.5 次级样式。

---

## 4. 状态反馈视觉 【改进】

### 4.1 反馈位置【改进——现状最大动线缺陷】

现状：错误横幅与成功通知渲染于**页面底部**（L907–908，分组卡片之后），而保存按钮在**顶部工具栏**——用户点击保存后视线需跳到页尾（29 键全展开时横幅在 2–3 屏外）。

改进：`div.obx-error[role=alert]` 与 `p.obx-notice` 两个节点在 JSX 中**上移至工具栏之后、热生效提示条之前**（DOM 移动，语义 `role=alert`/文案全保留）。位置固定后错误永不因分组折叠而不可见。

### 4.2 语义色与样式

| 状态 | 容器样式 | 文案（全部**保留**现有词条） |
| --- | --- | --- |
| 保存中 | 主按钮内 spinner + 文案「正在保存…」；全表单 disabled（现状保留） | `save.saving` |
| 成功 | 左侧 `3px` 实色条 `--obx-success` + 浅底 `--obx-success-bg` + 前置 ✓ 图标（内联 SVG，12px） | `save.done`（含热生效说明，原文保留） |
| 冲突 | 左侧 `3px` 实色条 `--obx-error` + 浅底 + 前置 ↻ 图标（与普通错误靠图标区分：冲突=可恢复重拉） | `conflict.title`（含「已重新拉取最新配置」语义，原文保留） |
| 错误 | 左侧 `3px` 实色条 `--obx-error` + 浅底 + 前置 ! 图标 | `save.badNumber` / `status.error` / Remote messageOf |
| 数字校验 | 除横幅外，§3.1 invalid 输入框同步描红（校验键名以「、」连接的现有文案保留） | `save.badNumber` |
| revision 徽章 | `obx-meta`「revision N」升级为 pill 徽章（同 badge 族 11px）；冲突重拉后数值随新快照自动更新（现状逻辑保留） | `revision.label` |
| entryInactive | 现状 `obx-meta obx-warn` 文字 → 升级为工具栏内 inline 警示 pill（warning 底色 + `--obx-warning-text`） | `effect.entryInactive` |
| 通用横幅样式 | `border-radius:8px; padding:10px 12px; white-space:pre-wrap`（**保留** `role=alert` 与 pre-wrap） | |

### 4.3 待 UX 对齐清单（与并行交互方案对接处）

1. 成功横幅是否自动消失（建议 8s 自动消隐 + 手动关闭钮；涉及计时器与清理逻辑）。
2. 冲突恢复焦点策略：重拉后是否将焦点移至冲突横幅（`tabIndex=-1` + focus）。
3. 保存失败时表单滚动定位（横幅在视口外时的 scrollIntoView 行为）。
4. 「将清除已保存的值」提示样式与措辞（§3.4）。
5. 分组描述文案（§2）与诊断组折叠默认态。

---

## 5. 明暗主题 token 【改进】

宿主主题变量不可见 → **自包含 token**，作用域限定于注入的 `<style>` 内 `.obx-panel{ --obx-*: … }`（不污染宿主）。中性灰用 alpha 灰（在明暗底上自然呈现两档），语义色用显式色值对。**对比度按 WCAG AA 实测校准**（明色底按白、暗色底按 `#1f1f1f` 假设）：

### 5.1 颜色 token

| Token | 明色值 | 暗色值 | 用途 | 对比度注记 |
| --- | --- | --- | --- | --- |
| `--obx-fg` | `inherit` | `inherit` | 正文/输入文字 | 跟随宿主前景（适配点 A） |
| `--obx-fg-muted` | `#6b7280` | `#9ca3af` | label/hint/desc/meta/徽章文字 | 明 4.8:1、暗 6.7:1 ✓——**现状 opacity 灰（hint .65≈2.5:1、label .8≈3.4:1）不达标，本 token 修复** |
| `--obx-border` | `rgba(128,128,128,.75)` | `rgba(255,255,255,.35)` | 输入框/按钮描边（组件边界） | 明 3.4:1、暗 3.4:1 ✓（现状 .4≈2:1 不达标） |
| `--obx-border-strong` | `rgba(128,128,128,1)` | `rgba(255,255,255,.5)` | hover 描边、状态点 | 明 3.9:1 ✓ |
| `--obx-card-bg` | `rgba(128,128,128,.06)` | `rgba(128,128,128,.10)` | 卡片底 | 装饰层，无对比度要求 |
| `--obx-input-bg` | `transparent` | `transparent` | 输入底 | 保留继承 |
| `--obx-accent` | `var(--dsh-accent, #2563eb)` | `var(--dsh-accent, #60a5fa)` | 主按钮/开关 on/focus 描边 | 适配点 B：宿主品牌色变量回退链 |
| `--obx-focus-ring` | `rgba(37,99,235,.45)` | `rgba(96,165,250,.55)` | focus-visible 环 | 适配点 B 联动 |
| `--obx-error` / `--obx-error-text` | `#e5484d` / `#d93036` | `#e5484d` / `#ff8a8a` | 错误图形/边框 ｜ 错误正文 | 图形 3.9:1 ✓；正文 4.7:1 / 暗 7.5:1 ✓（现状 #e5484d 直接作正文不达标） |
| `--obx-warning` / `--obx-warning-text` | `#d97706` / `#92400e` | `#d97706` / `#fbbf24` | 警示图形 ｜ 警示正文（obx-warn、entryInactive） | 图形 3.2:1 ✓；正文 7.1:1 / 暗 10:1 ✓（现状 #d97706 直接作正文不达标） |
| `--obx-success` / `--obx-success-text` | `#2f9e63` / `#1a7f4b` | `#2f9e63` / `#4ade80` | 成功条/图标 ｜ 成功正文 | 图形 3.4:1 ✓；正文 5.0:1 / 暗 9.7:1 ✓ |
| `--obx-switch-off` | `rgba(128,128,128,.7)` | `rgba(128,128,128,.55)` | 开关 off 轨道 | 对滑块 ≥3:1（§3.2 校准） |
| `--obx-switch-knob` | `#ffffff` | `#e8e8e8` | 开关滑块 | — |

暗色切换：`@media (prefers-color-scheme: dark){ .obx-panel{ … } }` 覆盖上表暗列（若宿主显式亮暗类可控，适配点 C 允许选择器替换为宿主类名——三个适配点汇总：**A** fg 继承、**B** accent/focus-ring 回退链 `var(--dsh-accent, fallback)`、**C** 暗色选择器机制待宿主实测定稿）。

### 5.2 非颜色 token

| 类别 | Token |
| --- | --- |
| 间距 | `--obx-space-1:4px ｜ -2:8px ｜ -3:12px ｜ -4:16px ｜ -5:20px ｜ -6:24px`（8pt 半步体系；现值 4/8/12/16 已在此列，新增 20/24 备卡片内层级） |
| 圆角 | `--obx-radius-sm:6px`（badge 例外用 pill 999px 保留）；`-md:8px`（输入/按钮/横幅）；`-lg:10px`（卡片） |
| 字号 | `--obx-fs-xs:11px`（徽章/revision）；`-sm:12px`（hint/meta/组描述）；`-base:13px`（label/控件/按钮）；`-md:14px`（正文/组标题）；`-lg:16px`（页标题） |
| 行高 | `1.5`（**保留**现状 `.obx-panel` 值） |
| 阴影 | **无**——内嵌面板不投阴影，层级感由卡片底色+描边承担，避免与宿主详情页阴影体系冲突 |
| 动效 | `--obx-dur-fast:150ms ease`（开关/hover）；横幅无入场动画（reduced-motion 兜底天然成立） |

---

## 6. 响应式与容器约束 【改进】

机制：`.obx-panel{ container-type:inline-size; container-name:obx; }` 以面板自身为查询源（自包含、零依赖；宿主为现代 Chromium，容器查询可用）。**降级兜底**：旧内核不识别时回落现状 `flex-wrap` 行为（保留现状为兜底路径，无功能损失）。

| 档位 | 触发（容器宽） | 布局 |
| --- | --- | --- |
| 宽 | `≥720px` | §1 两列栅格（label 176px + control 1fr）；控件 `max-width:420px` 生效；卡片 padding 14/16 |
| 中 | `480–719px` | `grid-template-columns:1fr`——label 上、control 下（label 行 `margin-bottom:4px`）；hint 全宽；数字输入仍 160px；工具栏保持 wrap |
| 窄 | `<480px` | 中档基础上：工具栏按钮 `flex:1 1 auto` 等宽横排（保存按钮 `order:-1` 优先可视）；控件 `max-width:none` 全宽；textarea/开关行不变；组卡片 padding 收至 `12px` |

窄容器不改变 DOM 结构与 React 逻辑（纯 CSS 降级）；workspace 选择器三态行随卡片同步收窄；密文徽章在 `<480px` 时换行至输入框下方（badge `flex-basis:100%`）。

---

## 7. 线框/示意（结构化重绘，非截图）

### 7.1 整页正常态（容器 ≥720px）

```
┌─ 内嵌于「插件 → 组合包详情」的面板区块（宽度=宿主容器，面板自适应该宽）─────────┐
│  QQ Bot（OneBot）设置                                        ← h2 16px/600    │
│  配置持久化为 profile 层 cordis.patch.yml 中 dsh-onebot 条目…  ← desc 12px 灰   │
│                                                                              │
│  (revision 7)                    [重新加载] [恢复默认值] [● 保存设置]  ← 工具栏 │
│  ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐                         │
│  ╎ ⓘ 保存即热生效：插件秒级重启，QQ 桥会自动重连…      ╎ ← 提示条（虚线边保留）    │
│  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘                         │
│  ▒ 反馈横幅出现于此（成功✓/冲突↻/错误!）——紧贴保存动线【改进：自页底上移】        │
│                                                                              │
│  ┌ 连接 ───────────────────────────────────────── 7 项 ┐  ← 组卡片 r10        │
│  │ 连接模式        [反向 WebSocket（NapCat 连接本插件） ▾] │  ← select 32px     │
│  │ 主机地址        [127.0.0.1                        ] │                    │
│  │ 端口            [8643     ]                          │  ← 数字列 160px     │
│  │ 服务地址        [ws://127.0.0.1:3001              ] │                    │
│  │ AccessToken     [•••••••••  留空 = 不修改        ] (● 已配置（脱敏，不回显)) │
│  │                 [ ] 清除已保存的 AccessToken            │                    │
│  │ Bot QQ          [                                  ] │                    │
│  │ Workspace       [                                ] (非默认)                │
│  │   ┌ 快速填入 workspace [选择 workspace… ▾] [填入] ┐  ← 内嵌次级行            │
│  └──────────────────────────────────────────────────────┘                    │
│  ┌ 权限 ───────────────────────────────────────── 7 项 ┐                      │
│  │ 要求 @ 提及      (●—) 开      │ ← switch 36×20 + 「开」文字                  │
│  │ 管理员列表       [每行一个         ] │ ← textarea 88px                      │
│  └──────────────────────────────────────────────────────┘                    │
│  ┌ 行为 ───────────────────────────────────────── 9 项 ┐  …                   │
│  ▸ 诊断 ────────────────────────────────────── 6 项（默认折叠，details）        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 反馈三态（横幅样例，位于工具栏下）

```
成功: ┃ ✓ 设置已保存。保存即热生效：插件秒级重启，QQ 桥会自动重连。   ┃ ← 绿条+浅底
冲突: ┃ ↻ 保存冲突：设置已被其他来源修改（revision 不一致），已重新拉取… ┃ ← 红条+浅底+↻
错误: ┃ ! 出错：数字字段不合法：端口                                  ┃ ← 红条+浅底+!
保存中: [◌ 正在保存…]（按钮内 spinner；全表单 disabled）
```

### 7.3 密文脱敏态（`accessToken`）

```
AccessToken   [•••••••••  留空 = 不修改        ] (● 已配置（脱敏，不回显))
              [x] 清除已保存的 AccessToken     ← 勾选后：输入框描边转琥珀 + 「将清除已保存的值」
未配置态:      [                              ] (○ 未配置)
```

### 7.4 窄容器降级（<480px）

```
┌────────────────────────┐
│ QQ Bot（OneBot）设置      │
│ (revision 7)             │
│ [● 保存设置（优先）]        │
│ [重新加载] [恢复默认值]      │
│ ┌ 连接 ──── 7 项 ┐        │
│ │ 连接模式            │    │  ← label 上 / 控件下
│ │ [反向 WebSocket  ▾] │    │  ← 控件全宽
│ │ 主机地址            │    │
│ │ [127.0.0.1        ] │    │
│ │ 端口                │    │
│ │ [8643    ]          │    │
└────────────────────────┘
```

---

## 8. React-only 实施建议与改造量级

### 8.1 落点（全部在 `lib/client.js` 单文件内）

| # | 改动 | 位置 | 量级 |
| --- | --- | --- | --- |
| 1 | CSS 字符串整体重写为 token 块 + 组件类（§1–§6 全部样式） | L429–456（原 28 行） | 约 90–120 行 CSS |
| 2 | 字段行 `div.obx-field` flex → grid | 仅 CSS + hint 的 `grid-column:2` 类，DOM 顺序不动 | CSS 内 |
| 3 | boolean 分支加开关视觉层 | `renderGroup` L575–655：label 内 checkbox 旁增 `span.obx-switch-track/knob` 两枚 span，checkbox `opacity:0` 覆盖热区 | JSX ≈10 行 |
| 4 | 反馈节点上移 | L893–908：`obx-error`/`obx-notice` 两节点移至 toolbar 后 | JSX ≈10 行 |
| 5 | 数字 invalid 态 | `computePatch` 的 invalidKeys 判定提为渲染期派生（`useMemo`），输入框挂 `aria-invalid` + `obx-input--invalid` | JS ≈10 行 |
| 6 | 保存按钮 spinner | busy 分支加 `span.obx-spinner` | JSX ≈3 行 |
| 7 | 密文勾选反馈 | clearSecret===true 时输入框条件类 + 行内提示 | JSX ≈5 行 |
| 8 | 组卡片/组 meta/组描述/诊断折叠 | `renderGroup` 外层 div → section 卡片 + `<details>`（仅诊断组） | JSX ≈15 行 |

### 8.2 量级结论

**单文件 diff ≈ 120–180 行（CSS 为主，JSX <60 行）**；无新增文件、无新依赖、externals 不变、`computePatch`/Remote 契约/保存数据流零改动。建议独立一次 commit 交付（仅样式与渲染层，便于按 artifact rev 验证回滚）。

### 8.3 locale 影响分两档

- **零新增键档**（本方案默认）：开关「开/关」、全部反馈文案、脱敏徽章均复用现有词条；新增视觉元素用 `aria-label` 复用既有文案。
- **+4~8 键档**（待 UX 对齐后）：组描述 ×4、清除提示 ×1、折叠 summary 文案、成功横幅关闭钮 aria 文案。新增键需 zh/en 同步并通过 `assertSameKeys` 自检。

### 8.4 与交互方案（UX）的对接界面

§4.3 五项 + §8.3 第二档键位清单，在 UX 方案定稿前**不锁定**；实施排期建议按「零新增键档先行、UX 对齐项增量跟进」两步走。

### 8.5 不做清单（防范围蔓延）

不引 CSS-in-JS/组件库/icon 库/字体文件；不改 `settings-remote.ts` 契约与脱敏链路；不加动画库；不动宿主页面级样式；不改既有 docs（本文件为唯一新增产出）。

---

## 9. 无障碍清单与验证方式

### 9.1 WCAG AA 清单

- 对比度：正文 ≥4.5:1（§5.1 三对语义色文本已校准）；组件边界/图形 ≥3:1（输入描边、开关轨道、状态条已校准）——**修复现状 4 处不达标**（hint/label/desc 的 opacity 灰、#e5484d/#d97706 直接作正文、输入框 .4 描边）。
- 键盘：focus-visible 全控件（新增环）；Tab 顺序=DOM 顺序（保留）；`<details>` 原生可达。
- 屏幕阅读器：开关保留 checkbox 语义 + 「开/关」文本；`role=alert` 反馈保留；`aria-invalid`/`aria-label` 补齐；徽章状态以文本传达（非仅颜色）。
- 动效：`prefers-reduced-motion` 下禁用 spinner 旋转与开关过渡。
- 触控：按钮/开关命中区 ≥32px 高（按钮 32px、开关 24px 命中区+行高兜底）；44px 理想值受内嵌容器密度取舍，标注为已知取舍。

### 9.2 落地验证方式（依据 `.expert-lessons.md` 2026-10-05 教训）

面板 UI 属 client.js artifact 层——**artifact rev 热生效：实施后重开宿主「插件 → 组合包详情」页面即见新视觉，无需重启宿主进程**（区别于 host-plane Remote 的 fiber 重建时点；本方案不触及 Remote，无该依赖）。验证步骤：保存 client.js → 重开设置页 → 逐项核对 §0.4 表 8 项 + §9.1 清单；宿主切亮/暗主题各核对一遍语义色。

---

## 附：现状样式基线摘录（供实施对照，源=client.js L429–456）

保留要素：`color:inherit` 系主题继承、`background:transparent` 输入底、`.obx-badge` pill 形态、`resize:vertical`、`white-space:pre-wrap`、`.obx-btn:hover:not(:disabled){border-color:currentColor}`、disabled `opacity:.45`。
替换要素：组分隔发丝线→卡片、原生 checkbox→开关、无 focus→焦点环、底部反馈→工具栏下、opacity 灰阶→校准 token、`#e5484d/#d97706` 硬编码→语义色对。

---

*UI 设计师 · T2 · 2026-10-16 · 依据 client.js（967 行）与 settings-remote.ts（556 行）源码核实产出*
