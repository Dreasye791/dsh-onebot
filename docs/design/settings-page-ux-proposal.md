# dsh-onebot 插件设置页 · 交互设计方案（UX Proposal）

> - **任务**：T1「插件设置页交互设计方案」· attempt `att-onebot-ux-01` · 任务板 `onebot-visual.json`
> - **作者**：UX 架构师（只规划，不写代码；本文件为 T1 唯一产出，未修改任何既有文件）
> - **证据基线**：`lib/client.js`（967 行全文核实）、`src/settings-remote.ts`（556 行全文核实）、`docs/settings-page-design.md`、`docs/settings-page-review.md`、`.expert-lessons.md`（323 行全文核实）
> - **标注约定**：【改进】= 建议修改现状交互；【保留现状】= 明确建议不动；行号锚点均指当前工作树文件
> - **日期**：2026-10-23

---

## 0. 核实结论、假设与差异声明

### 0.1 键数口径：以源码为唯一权威

- **源码实测：4 组 29 键。** `lib/client.js` GROUPS（L70-126）与 `src/settings-remote.ts` SETTINGS_GROUPS（L69-74）逐字同构：
  - **connection（7）**：mode, host, port, url, accessToken, botQQ, workspacePath
  - **permissions（7）**：requireMention, adminUsers, dmPolicy, groupPolicy, allowAllUsers, allowFrom, groupAllowFrom
  - **behavior（9）**：interimMessages, interimRecall, interimRecallMs, sendErrorNotice, unknownCommand, rateLimitPerMinute, newMessagePolicy, autoSteerPolicy, deferredTimeoutMs
  - **diagnostics（6）**：actionAuditEnabled, traceEnabled, recordInbound, inboxRedact, injectEnabled, injectDryRun
  - 扁平表 ALL_FIELDS（client.js L127-133）与 ALL_KEYS（settings-remote.ts L146-148）均为 29 键。
- **差异全景**（grep `\b(19|26|28|29)\s*键`，65 处命中）：
  - **docs 旧口径 19 键三组**：settings-page-design.md（L174/184/193/226/253）、settings-page-review.md（L10/L17）、README.md（L227/240）、v043-next-acceptance.md——均滞后于源码；
  - **26 键** = DEVLOG.md L798 与 tests/settings-remote.spec.ts L383 的批次中间口径（W7 workspacePath 落地时点），任务书所称「文档 26」即源于此类批次记录，docs/ 正文未见 26；
  - **28 键** = settings-remote.ts L156/L306/L335 及构建产物 lib/settings-remote.js、lib/types/settings-remote.d.ts 的**陈旧注释**（T9 autoSteerPolicy 落地后未同步）；
  - tests/client-settings.spec.ts 头注（L8）与 client.js 注释（L30/32/64/127）已是 29。
- **结论**：本方案一律按 4 组 29 键设计；文档/注释为滞后记录，不作为交互依据。建议后续单独任务勘误注释（settings-remote.ts L156/L306/L335 的「28 键」→「29 键」），本任务不修改任何既有文件。

### 0.2 假设（宿主外观不可见，显式声明）

| # | 假设 | 依据与影响 |
|---|------|-----------|
| A1 | 面板渲染于宿主「插件」标签页 → 组合包详情页内，是**内嵌区块**而非独立路由页；无页面级 header，宽度受宿主详情页容器约束 | `slots.inject("plugins.bundle.config", …)`（client.js L937-940）；方案按区块卡排版，不假设满屏宽度 |
| A2 | 面板配色继承宿主主题（亮/暗随宿主），插件自身不提供主题切换 | 现状 CSS 输入框 `background:transparent; color:inherit`（client.js L428-457 CSS 区）已如此；仅错误红 `#e5484d`、警示橙 `#d97706` 硬编码（L436/L440） |
| A3 | 宿主未提供「未保存更改离开拦截」扩展点；内嵌面板对宿主 SPA 内路由切换无法主动拦截 | 现状代码无任何 guard；§5.7 给出降级方案与宿主增强建议 |
| A4 | UI 词条 zh/en 双语齐备（client.js L373-426），但分组标题/字段 label 为中文常量不走词条（L374 注释，T4 决策） | 方案不改该决策；交互文案按 zh 设计，en 走词条新增 |

### 0.3 热生效时点与「remote 方法可能不存在」（经验池教训，方案级约束）

- `.expert-lessons.md`（2026-10-05 条目，L241-243）：**面板 UI 与 host-plane 服务生效时点不同**——client.js 走 artifact rev 热生效（重开页面即新 UI），host-plane Remote 新方法（如 listWorkspaces）随插件 fiber 重建才生效。因此**「新 UI + 旧服务」窗口期是常态路径而非异常分支**，§7 降级态按一等公民设计。
- 配套教训（2026-10-12 条目，L269-271）：patch 内容变更热生效有双前提（有效配置差异 + 模块 URL 变化），npm 包形态升级激活=重启 dsh-web。→ §5 成功反馈沿用现有 effect.hint 表述（「保存即热生效」），不承诺绝对即时。
- 部署链教训：工作区源码 → 生产 npm 包 profile 安装，**非自动上线**——本方案全部改动落 client.js 一处即可，host 侧零改动。

### 0.4 红线核查记录

- project1 顶层非 git 仓库（`git status` 报 not a git repository，编排板所在层）；dsh-onebot 为独立 git 仓库，只读 `status --short` 仅见 `?? docs/design/`（本任务自建目录），**无其他会话未提交改动，未触碰任何既有文件**。

---

## 1. 现状交互清单（逐区块，以 client.js 源码为准）

### 1.1 已有交互（按区块）

| 区块 | 现有交互 | 锚点 |
|------|---------|------|
| 标题/描述 | 静态文案 settings.title / settings.desc（词条） | 主渲染 L893-908 内 |
| 工具栏 | revision 徽标（revision.label）；entryActive!==true 时橙警示（effect.entryInactive）；「重新加载」=refetch()，**无确认**直接 accept 新快照→草稿重建；「恢复默认值」=setDraft(draftFromDefaults())，**无确认**且不重置 secretDraft/clearSecret；「保存设置」primary（busy→saving 文案，仅 busy 时禁用） | L893-908；refetch L785-793；reset L901；save L795-832 |
| 生效提示框 | 虚线框常显 effect.hint（保存即热生效语义） | L893-908 内 |
| 连接组（7 键） | mode=select；host/port/url/botQQ/workspacePath=text；accessToken=password+脱敏徽标+「清除」勾选；全部恒展示不按 mode 联动，port/url 靠 hint 文字说明生效模式 | L70-79；renderGroup L558-656；密文行 L607-623 |
| 权限组（7 键） | 布尔=checkbox+「开/关」；adminUsers/allowFrom/groupAllowFrom=textarea（每行一个）；dmPolicy/groupPolicy=select | L80-99 |
| 行为组（9 键） | 布尔/select 混排；interimRecallMs/rateLimitPerMinute/deferredTimeoutMs=number 输入 | L100-119 |
| 诊断组（6 键） | 6 个布尔 checkbox 全平铺，与前三组同权重 | L120-126 |
| 工作区选择器 | workspacePath 行下方注入（renderExtraRow 扩展点 L644-649）；挂载时现拉一次 listWorkspaces()；select（选项 label「path（N 会话）」L703）+「填入」（未选中/busy 禁用 L707）；填入只写草稿（fillWorkspacePath L551-555） | L658-714；拉取 L758-783 |
| 错误/通知 | role=alert 红横幅 + 通知行，渲染在**面板最底部**（四组字段之后） | L907-908 |
| 摘要视图 | props.view==="summary" 时只渲染 desc 文本 | entry L937-940 |

### 1.2 问题点清单（每条附证据）

| # | 问题 | 证据 | 严重度 |
|---|------|------|--------|
| P1 | **初始加载失败即死端**：snapshot===null 时只渲染 loading 文案+错误条，无重试按钮（reload 按钮在已加载后的工具栏里才存在），用户只能重开面板 | L834-838 vs L893-908 | 高 |
| P2 | **错误/通知在面板最底部**：长表单下保存冲突/失败提示在视口外，用户点了页首工具栏的「保存设置」看不到结果 | L907-908 | 高 |
| P3 | 无脏状态跟踪：保存按钮不反映未保存变更数；「没有需要保存的变更」是点击后的事后提示 | L795-812（noChanges L809-812） | 中 |
| P4 | 「重新加载」「恢复默认值」均无确认即丢弃草稿；恢复默认值后 secretDraft/clearSecret 残留（密码框输入与清除勾选不受重置影响） | L785-793、L901、useState L725-750 | 中 |
| P5 | **冲突自动重拉丢弃全部未保存编辑**：conflict → refetch → accept 全量重建草稿，改动静默丢失 | L822-826 → accept L752-756 | 高 |
| P6 | 数字字段无行内范围校验：computePatch 仅拦 NaN（L533-535），port 1–65535 等范围越界要到 wire/host 校验才以横幅报错 | computePatch L525-544；patchSchema L305；host NUMBER_RANGE settings-remote.ts L129-134、validatePatch L338-372 | 中 |
| P7 | 密文勾选「清除」后徽标显示「未配置」，与真实未配置不可区分 | L840-847 → 徽标 L607-623 | 低 |
| P8 | 工作区选择器失败后无重试入口：挂载时一次现拉，降级提示行出现后只能重开面板 | L758-783、L658-714 | 中 |
| P9 | 29 键一屏全平铺：诊断组调试开关与高频键同权重；connection 组 host/port/url 依 mode 只有一个生效，靠 hint 自行判断 | L70-126 | 中 |
| P10 | 无未保存离开防护：脏草稿随组件卸载静默丢失 | 全文无 guard | 中 |
| P11 | 分组标题/字段 label 仅中文（词条不覆盖），en 界面混排 | L373-374 | 低（既有决策，A4） |

---

## 2. 信息架构重组

### 2.1 分组顺序与命名 ——【保留现状】

四组顺序、键序与 host SETTINGS_GROUPS（settings-remote.ts L69-74）及 client GROUPS（client.js L70-126）三方逐字同构，且被 tests/client-settings.spec.ts 常量断言钉住。**不建议重排分组或键序**：收益纯视觉，成本是三方契约+测试同步。视觉差异交给卡片布局表达，不动数据结构。

### 2.2 卡片化 ——【改进】

- 每组一张卡片：`obx-card`（背景用宿主主题次级底色——因继承宿主主题，用半透明叠加而非硬编码色值；圆角 8px；内边距 16px；卡片间距沿用面板 16px gap）。
- 卡片头 = 组标题（现有中文常量）+ **新增组级一句话说明**：连接=NapCat/QQ 桥接参数；权限=谁能触发与使用；行为=回复与限流；诊断=观测与调试开关 + 折叠 chevron（§3）。
- 卡片体 = 现有 obx-field 行结构不变（label min-width 180px + 控件 + hint 换行），仅外层容器变化 → 改造量小。
- 字段行「非默认」徽标保留（L634-640，快照生效值 vs DEFAULTS L136-166）；【改进，微量】徽标加 title=「默认值：X」，悬停可对照。

### 2.3 与 host 的差异处理 ——【注记】

- IA 对齐以源码 GROUPS 为准（§0.1）；docs 19/26/28 旧口径不采信。
- 后续扩键规则（写死为 IA 原则）：新键进语义最贴近的既有组；纯调试/观测键一律进诊断组（可折叠区），避免平铺回潮；扩键仍须三方（GROUPS/SETTINGS_GROUPS/测试常量）同步。

---

## 3. 渐进披露

### 3.1 诊断组默认折叠 ——【改进】

- **默认态：折叠。** 卡片头右侧显示摘要「6 项 · 2 项默认开」（actionAuditEnabled 与 injectDryRun 默认 true，其余四项默认 false，见 DEFAULTS L136-166）。
- 展开/收起：点卡片头任意处切换（含 chevron）；`aria-expanded` / `aria-controls` 齐备；折叠态若该组有未保存变更，头部显示「● 含未保存修改」防盲区——**折叠不隐藏变更**：脏值仍参与 computePatch 与保存（关键规则）。
- 状态持久：sessionStorage 键 `dsh-onebot-qq.diagnosticsExpanded`（会话内记住即可，调试面板不应永久占据展开态）。
- **默认态矩阵**：连接/权限/行为 = 展开；诊断 = 折叠。

### 3.2 connection 组按 mode 联动 ——【改进，低强度：变暗禁用而非隐藏】

- 规则：mode=reverse 时 **url** 变暗禁用；mode=forward 时 **host/port** 变暗禁用；行尾 hint 同步说明「当前模式不生效」。
- **禁用而非移除**：草稿值保留原样；computePatch 基于值比较（valueEquals，utils 区 L459-556），未变的禁用键不进 patch，语义安全。
- 不做隐藏的原因：「我填了为什么没生效」类困惑应可见而非消失。

### 3.3 behavior 组高级键子折叠 ——【保留现状（暂不做）】

rateLimitPerMinute/deferredTimeoutMs 归「高级」子折叠属可选优化，收益低（该组本就是中频调优）且引入两级嵌套折叠；本轮不做，记录为后续观察项。

---

## 4. 工作区选择器状态流

拉取时点与降级链路保留现状（挂载时现拉一次、独立 catch、不污染主链路——L758-783、L766-781）：

| 态 | 进入条件 | 交互 | 标注 |
|----|---------|------|------|
| hidden | 拉取未完成（loaded!==true） | 不渲染整行（接受轻微跳动，现状如此） | 【保留现状】 |
| normal | available=true 且列表非空 | select（选项 label=`<path>（N 会话）` L703；**value=id** 防同名 path 冲突 L665）+「填入」按钮（未选中或 busy 禁用 L707）+ hint「只填值，保存仍走保存设置」；填入=仅写草稿（fillWorkspacePath L551-555），保存仍走显式保存通道 | 【保留现状】 |
| empty | available=true 但 workspaces=[] | 说明行「暂无 workspace 记录，可直接输入路径。」（L678-683 两文案之一） | 【保留现状】 |
| unavailable | available=false（host 侧 registry 缺席/list 抛错时纯实现恒不抛、返回 available:false——settings-remote.ts L282-297） | 说明行「无法获取 workspace 列表（宿主未提供 workspace 注册表），可直接输入路径。」 | 【保留现状】 |
| fetch-failed | RPC 异常 / **remote 方法不存在**（经验池教训 §0.3） | 现状与 unavailable 同文案 | 【改进】文案区分「本次拉取失败」，行尾加「**重试**」链接：重试=重跑拉取函数，成功回 normal；仍失败停留并禁用重试 10s 防连点 |
| busy | 保存进行中 | select 与「填入」disabled | 【保留现状】 |

- **sessionCount 展示**：纯展示（host WorkspaceSummary 注明 pure display，settings-remote.ts L263-277）；「（0 会话）」照常显示，不做特殊态——【保留现状】。
- **填入后反馈**——【改进，微量】：填入成功时 workspacePath 输入框短暂高亮 1.5s（`obx-flash` 类），确认「值已进草稿」；不自动保存。
- **已填入一致性**——【保留现状】：填入不改 selectedId 之外的状态，不与草稿 workspacePath 做比对提示（避免过度工程）。

---

## 5. 保存流（草稿 → computePatch → updateSettings(patch, expectedRevision)）

### 5.1 编辑态 ——【改进：引入脏状态派生】

- 派生 `dirtyKeys = computePatch(draft, snapshot.config, { secretDraft, clearSecret })` 的键集（纯函数已存在 L525-544：跳过 secret 键 L531、NaN→invalidKeys L533-535、clearSecret 优先→`accessToken:''` L540、secretDraft 非空→覆盖 L541）；渲染期调用即可，29 键成本可忽略，无需新增 useState。
- 保存按钮：dirtyKeys 为空 → 禁用，文案「保存设置」；非空 → 启用 + badge「**N 项未保存**」。
- 现状点击后 notice(save.noChanges)（L809-812）保留为兜底（防派生竞态）。

### 5.2 保存中

- busy=true，全部控件 disabled（保留现状 L857-891 的 disabled 链）；保存按钮文案→「正在保存…」（保留现状）。
- 【改进，微量】工具栏加纯 CSS spinner（不加依赖）。

### 5.3 终态四分支

| 分支 | 现状 | 方案 |
|------|------|------|
| 成功 | accept 新快照 + notice(save.done) 在底部 + 重置 secretDraft/clearSecret | 通知位置上移（§5.5），文案保留；revision 徽标随新快照更新 |
| 无变更 | 事后 notice(save.noChanges) | 保留为兜底；常态下按钮已禁用（§5.1） |
| 冲突（expectedRevision 不符拒写，host 抛 `onebot-settings/conflict`——settings-remote.ts L404-444；client 端 CONFLICT_RE 仅窄匹配 L478） | setError(conflict.title) + refetch（草稿全丢） | **§5.4 合并保留规则** |
| 失败 | setError(messageOf(e))；host 侧已归一中文（describeEditFailure L386-402：锁超时/条目失活/未激活/home patch 接管/通用） | 保留；按类别补一句行动提示：锁超时→「稍后重试」；条目失活/未激活→引导检查插件状态 |

### 5.4 冲突合并保留 ——【改进，核心】

现状：conflict → refetch → accept 全量重建草稿，未保存编辑静默丢失（P5）。方案规则：

1. refetch 拿到新快照后，**逐键比较新旧快照值**（旧=发起保存时的 snapshot.config，新=refetch 结果；比较复用现有 valueEquals）；
2. 新旧值**一致**的脏键：保留用户草稿编辑（大概率仍可原样重提）；
3. 新旧值**不一致**的脏键：丢弃该键草稿、跟随新快照，并在该字段行内标橙提示「已被其他来源修改，已同步为最新值」；
4. 结果条文案 = conflict.title + 「已保留 N 项未冲突的修改，请核对后重新保存」；
5. 若全部脏键都被外部修改，退化为现状行为（全量重建草稿）。
- **密文例外**：secretDraft/clearSecret 不参与合并（脱敏值无法比对）——冲突重拉后一律清空，并提示「accessToken 输入已清空，如需修改请重新输入」。
- 实现形态建议：纯函数 `mergeOnConflict(draft, oldCfg, nextCfg)`，与现有 computePatch 同层、可单测（参照 L946-963 导出惯例）。

### 5.5 反馈可见性与位置 ——【改进，修 P2】

- error/notice 从面板底部**上移至工具栏正下方**（effect.hint 框上沿）成为「结果条」；保存结束后 `scrollIntoView({ block:'nearest' })` 并把焦点移入（role=alert 保留，读屏可达）。
- 成功 notice 6s 自动消失；错误常驻直到下一次操作（保留现状语义）。

### 5.6 行内校验 ——【改进，修 P6】

- 数字键 **onBlur** 行内校验范围：port 1–65535，其余数字 ≥0（范围常量与 host NUMBER_RANGE settings-remote.ts L129-134 对齐抄入 client 常量表）；非法→字段行内红字 + 保存按钮禁用并 title 说明；computePatch 的 invalidKeys（NaN）拦截保留为最后防线。
- stringArray 键保持「每行一个、空行自动忽略」现状（snapshotValueToDraft 归一 L485-491），不加行内校验。
- 枚举键由 select 天然约束，无需行内校验（保留现状）。

### 5.7 未保存更改提示与离开防护 ——【改进，受 A3 约束】

- **常显提示**：工具栏 badge「N 项未保存」（§5.1）+ 面板标题后缀「（未保存）」——即使面板滚出视口，回到面板即见（修 P3/P10 的可见部分）。
- **beforeunload**：dirtyKeys 非空时注册，拦截**页面级**离开/刷新（浏览器原生确认框）；SPA 内路由切换无法拦截（A3），如实注明。
- **卸载拦截不可行**（内嵌组件无宿主扩展点）→ 记录为宿主增强建议（§10.3）：若宿主未来在 plugins.bundle.config 提供 dirty 查询或 leave-guard 钩子再接入。
- **确认框**——【改进，修 P4】：dirtyKeys 非空时，「重新加载」「恢复默认值」先弹原生 confirm（「将丢弃 N 项未保存修改」）；无脏时直接执行不打扰。**恢复默认值同时重置 secretDraft('') 与 clearSecret(false)**（修补现状残留缺陷，属行为修正而非新功能）。

---

## 6. 密文（accessToken）交互

语义契约（保留现状，源码钉住）：**缺省（patch 不含键）=不修改；`''`=清空**（client.js L301 注释）；明文永不回显、不进草稿（snapshotValueToDraft 强制 '' L485-491；host buildSnapshot 脱敏 settings-remote.ts L316-333；SECRET_KEYS 仅 accessToken L115）。

| 交互点 | 方案 | 标注 |
|--------|------|------|
| 脱敏显示 | password 输入框恒空 + placeholder「留空 = 不修改」+ 徽标「已配置（脱敏，不回显）」/「未配置」（secretSet 由 snapshot.secrets 推导 L840-847） | 【保留现状】 |
| 修改语义 | 输入非空 → 保存时 patch.accessToken=输入值（覆盖语义）；hint 补一句「输入即覆盖，无需二次确认」——单管理员场景不做「确认新密码」 | 【保留现状 + 补 hint（微量）】 |
| 清空语义 | 勾选「清除已保存的 AccessToken」→ 保存时 patch.accessToken=''（现状 computePatch L540 清除优先）；勾选后徽标改显「**保存后清空**」（橙色），与「未配置」可区分 | 【改进，修 P7】 |
| 互斥规则 | 在密码框输入任何字符 → 自动取消「清除」勾选（反向：勾选清除不清空密码框，但保存以清除优先——与现状 L540 一致）；输入时清除勾选被取消后徽标即时回「已配置（脱敏，不回显）」 | 【改进，微量】 |
| 失败反馈 | 保存失败时 secretDraft 保留（用户不必重输）；冲突重拉时按 §5.4 例外清空并提示 | 【改进】 |
| 可达性 | aria-label=field.label 保留；徽标加 aria-label 说明脱敏语义 | 【保留现状】 |

---

## 7. 状态设计（加载 / 空态 / 错误态 / 降级态）

| 态 | 触发 | 交互方案 | 标注 |
|----|------|---------|------|
| 加载 | snapshot===null 且无错误 | 居中 loading 文案（词条 settings.loading）；【改进，微量】加纯 CSS spinner；不渲染工具栏 | 改进（微量） |
| 加载失败 | getSettings 失败（含 no-entry / 核心方法缺失） | loading 文案 + 红色错误条 + **「重试」按钮调用 refetch**（refetch 已存在 L785-793，仅缺入口——修补 P1 死端）；重试仍失败停留可重试 | 【改进，修 P1】 |
| 空态 | 面板无独立空态：effectiveConfig 全键兜底，快照永不为空（settings-remote.ts L306-314）；「空」仅存在于工作区列表（§4）与 no-entry 错误 | no-entry 按加载失败态处理，文案用 host 归一错误（describeEditFailure L386-402） | 【保留现状】 |
| entry 失活 | entryActive!==true | 工具栏橙警示保留（effect.entryInactive）；【改进，微量】加 title 展开说明「插件条目未激活，修改可能无法生效」 | 改进（微量） |
| 保存冲突/失败 | §5.3–5.5 | 结果条上移 + 冲突合并保留 | 【改进】 |
| **降级：listWorkspaces 缺失** | 「新 UI + 旧服务」窗口期（§0.3，经验池教训） | 快速填入行按 fetch-failed 态渲染（说明行 + 重试），**绝不阻塞主链路**（现状已如此 L766-781，此处固化为验收规则） | 【保留现状 + 注记】 |
| **降级：getSettings/updateSettings 缺失** | 同上（更严重：面板核心通道不可用） | 加载失败态 + 专项文案：「面板与插件服务版本不一致，请刷新页面；若仍失败请等待插件服务重建后重试」（对应 artifact rev 热生效 vs fiber 重建的时差） | 【改进，新增文案】 |
| busy | 保存进行中 | 全控件 disabled + spinner（§5.2） | 【保留现状 + 微调】 |

**降级设计总规则**（作为实现验收点，源自经验池教训）：任何 remote 方法调用必须同时具备 ① 调用前可探测/可兜底（`typeof remote?.<method> === 'function'` 预检或 Promise 包裹同步抛出）② 独立 catch 降级 ③ 降级路径不污染主链路状态与错误横幅。

---

## 8. 线框示意（ASCII）

### 8.1 全景（默认态：诊断折叠、结果条上移、脏 badge）

```
┌─ OneBot 设置 ─────────────────────────────────────────────────┐
│ QQ Bot 桥接配置（desc）                          [（未保存）]  │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ [配置版本 3] [⚠ 条目未激活*]   [重新加载] [恢复默认值]      │ │
│ │ [● 2 项未保存]                        [ 保存设置 ](primary)│ │
│ └───────────────────────────────────────────────────────────┘ │
│ ┄┄ 修改任意设置保存后即热生效（effect.hint，虚线框）┄┄          │
│ ┌─ 结果条（上移至此；错误红/成功绿，role=alert）────────────┐  │
│ │ ⛔ 配置已被其他来源修改：已保留 2 项未冲突修改，请核对后重存 │  │
│ └───────────────────────────────────────────────────────────┘ │
│ ┌─ 连接 ─────────────────────────────────────────────── ▾ ──┐ │
│ │  NapCat/QQ 桥接参数                                        │ │
│ │  接入模式     [反向 WebSocket ▾]                           │ │
│ │  监听地址     [0.0.0.0          ]                          │ │
│ │  监听端口     [8643    ]  （非默认）                       │ │
│ │  服务地址     [https://…  ]（暗：forward 模式才生效）      │ │
│ │  AccessToken  [            ] [已配置（脱敏，不回显）]      │ │
│ │               ☐ 清除已保存的 AccessToken                  │ │
│ │  Bot QQ 号    [123456           ]                          │ │
│ │  ── 快速填入 workspace ──────────────────────────────      │ │
│ │  [选择 workspace… ▾（选项：/path（N 会话））] [填入]       │ │
│ │  只填值，保存仍走保存设置                                  │ │
│ └───────────────────────────────────────────────────────────┘ │
│ ┌─ 权限 ─────────────────────────────────────────────── ▾ ──┐ │
│ │  谁能触发与使用（7 键：布尔开关 / 白名单 textarea / 策略） │ │
│ └───────────────────────────────────────────────────────────┘ │
│ ┌─ 行为 ─────────────────────────────────────────────── ▾ ──┐ │
│ │  回复与限流（9 键）                                        │ │
│ └───────────────────────────────────────────────────────────┘ │
│ ┌─ 诊断 ───────────────────────────── 6 项 · 2 项默认开  ▸ ─┐ │
│ │  （默认折叠；含未保存修改时头部显示「● 含未保存修改」）    │ │
│ └───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

### 8.2 密文行三态（徽标区分）

```
未配置:  AccessToken  [              ]  [未配置]                placeholder=留空 = 不修改
已配置:  AccessToken  [              ]  [已配置（脱敏，不回显）]
待清空:  AccessToken  [              ]  [保存后清空]（橙）      ← 勾选「清除」后
         ☑ 清除已保存的 AccessToken          （在左侧输入新值将自动取消本勾选）
```

### 8.3 保存冲突流（泳道）

```
用户                面板（client.js）                          host（settings-remote.ts）
 │ 点「保存设置」       │                                          │
 │────────────────────►│ computePatch → updateSettings            │
 │                     │   (patch, expectedRevision=3) ──────────►│ revision≠3 → 拒写
 │                     │ ◄──────────────────────────────────────── │ onebot-settings/conflict
 │ 结果条（工具栏下方） │ isConflictError → refetch()              │
 │ ◄────────────────────│ 逐键合并（§5.4：一致保留/不一致跟随+橙标）│
 │ 「已保留 2 项修改…」 │ 密文例外：secretDraft 清空并提示          │
 │ 核对 → 再次点保存    │ updateSettings(patch, revision=新) ──────►│ 成功 → 新快照
```

### 8.4 工作区选择器状态一览

```
normal:       [选择 workspace… ▾]  [填入]    hint: 只填值，保存仍走保存设置
empty:        暂无 workspace 记录，可直接输入路径。
unavailable:  无法获取 workspace 列表（宿主未提供 workspace 注册表），可直接输入路径。
fetch-failed: 本次拉取 workspace 列表失败，可直接输入路径。[重试]   ← 改进：文案区分+重试链接
```

---

## 9. React-only 实施建议（不引入新依赖）

约束：bundle externals 仅 react（client.js L49-55），模块表冻结；现状无状态库/reducer，全部 useState + 模块级纯函数渲染（renderGroup / renderWorkspacePicker / computePatch 等已导出供测试，L946-963）。

| 改动点 | 触及位置（lib/client.js） | 量级 | 同步成本 |
|--------|--------------------------|------|---------|
| 卡片化容器 + 结果条上移 | CSS 区新增 obx-card/obx-result（L428-457）+ 渲染顺序调整（L893-908） | S（<30 行） | 无 |
| 脏状态派生 + 保存 badge | 渲染期调用 computePatch（L525-544），无新 useState | S | 无 |
| 初始失败重试按钮 | loading 分支（L834-838）加按钮调 refetch（L785-793 已有） | S | 无 |
| 诊断组折叠 | renderGroup 卡片头 + sessionStorage 读写；GROUPS 结构不动 | S | 无 |
| 密文徽标三态 + 输入互斥 | 徽标分支（L607-623）+ onSecretChange 联动 setClearSecret(false) | S | 无 |
| 恢复默认值重置密文状态 | L901 补 setSecretDraft('')/setClearSecret(false) | XS | 无 |
| 数字行内范围校验 | 常量表（抄 host NUMBER_RANGE）+ onBlur handler + 字段 error 槽 | M（30–80 行） | 建议加单测 |
| 工作区重试 + 文案区分 | 拉取逻辑提为可重入函数（L758-783）+ 词条 2 条 | M | 无 |
| beforeunload + 危险操作确认 | useEffect 注册/注销 + confirm | M | 无 |
| 冲突合并保留 | save catch 分支（L822-826）新增纯函数 mergeOnConflict（复用 valueEquals） | M-L（80–120 行） | 建议加单测（纯函数可测） |
| 词条新增 | zh/en 各 +3~5 条（结果条/重试/未保存 badge 等），assertSameKeys（L418-425）保证双语齐 | S | 无 |

**实施优先级**：
- **P0**（可见性急救，修 P1/P2）：结果条上移 + 初始失败重试按钮；
- **P1**（防丢改，修 P3/P4/P7）：脏状态 badge + 危险操作确认 + 密文徽标三态 + 恢复默认值补重置；
- **P2**（降噪，修 P8/P9）：诊断折叠 + mode 联动变暗 + 工作区重试；
- **P3**（逻辑最重，修 P5）：冲突合并保留——必须单测护航后上线。

**影响面**：全部改动收敛在 lib/client.js 一处；协议 schema、settings-remote.ts、既有测试零改动（host 侧仅注释勘误，另行任务 §10.1）。量级合计约 250–400 行（含 CSS 与词条），无新依赖、无构建链变化。

---

## 10. 后续建议（超出本任务范围，仅记录）

1. 勘误 settings-remote.ts L156/L306/L335 与产物 d.ts 的「28 键」注释 → 29（纯注释，勿动行为）。
2. docs/ 三份 19 键旧口径文档（settings-page-design.md、settings-page-review.md、README「三组 19 键」节）在下次内容性修订时顺手更新；本方案不回写既有 docs。
3. 向宿主提「plugins.bundle.config 未保存更改拦截（leave-guard/dirty 查询）扩展点」提案（对应 A3 边界）。
4. 验收证据产物严禁包含明文 accessToken（settings-page-review.md A1 阻塞项教训，落证据时复查）。
5. 上线任一改动后按经验池要求做真机首挂载探针（mock 单测抓不到宿主 fiber/Proxy 行为）。
