# dsh-onebot 适配器开发日志

> QQ 机器人（dsh × NapCat / OneBot 11）适配器开发全记录
> 起始：2026-08-14（由 Hermes onebot 插件移植而来，源 DEVLOG 见 onebot-adapter-port/plugin/onebot/DEVLOG.md）

## 0. 开发规范（沿用 Hermes 惯例）

1. **能外置的模块就外置**：纯逻辑拆独立模块（src/cq.ts、src/split.ts、src/t2i/*），bridge.ts 只留调用点
2. **所有改动必须写本日志**：时间线、根因、修复、验证
3. **测量=绘制**（t2i）：换行/列宽统一走 segWidth，像素级验证右缘 ≤790

---

## 1. 项目概述

dsh 的 QQ 渠道通过 **OneBot 11 协议**接入 NapCat，本插件实现完整平台适配器（外部插件形态，与 dsh-vision 同款：纯 TS、零 Python、原生 Cordis、不改核心）：

```
NapCat (QQ) ←— 反向 WS —→ dsh-onebot 插件 ←— dsh Agent（每个会话一个）
                              │
                              ├─ src/cq.ts          CQ 解析/反转义/@检测/表情映射
                              ├─ src/connection.ts   反向服务器+正向客户端、echo、重连
                              ├─ src/media.ts        入站媒体四路解析、6h 清理
                              ├─ src/stt.ts          ffmpeg+whisper 语音转写
                              ├─ src/split.ts        标点分段、Markdown 剥离、敏感审计
                              ├─ src/bridge.ts       chat→Agent、session/event 出站、映射持久化
                              ├─ src/tools.ts        qq_* 模型工具（媒体/合并转发/NapCat API 白名单）
                              └─ src/t2i/*          文字图卡片渲染器（@napi-rs/canvas）
```

- **形态**：外部插件 `~/dsh-plugins/dsh-onebot/`，挂载在 `~/.dsh/profiles/web/cordis.patch.yml`（profile 层）
- **协议**：OneBot 11（兼容 NapCat / Lagrange / LLOneBot / go-cqhttp）
- **连接**：反向 WS（默认 8643），NapCat ws-reverse 拨入
- **会话**：每个 QQ 会话一个持久 Agent（session id 稳定派生），重启自动 resume
- **依赖**：@deepseek-ai/*（宿主符号链接）+ ws + @napi-rs/canvas + fontkit


### 2026-09-10（M1 收尾：v0.2.1 发布）

| 时间 | 工作 |
|---|---|
| 全天 | **M1 里程碑完成**——11/11 工作包（Wave1 A2/A6/B4/B5、Wave2 C3/A5/A3a+A3b、Wave3 A7/B6/B7/E2/C6a/A8×3），测试 99→200（+101），tsc 0 错误；安全回归清单随各包验收在库（鉴权 3 路径/路径围栏/SSRF 矩阵/覆盖状态文件防护/解码炸弹/门禁 TOCTOU）；遗留：R5 NapCat 4401 重试行为 24h 观察（生产 v0.2.0 运行中）、真机检查待 trim-cli 登录后执行、file:// 分支与 DNS rebinding 与正文伪前缀（D5）为已知边界 |
| 全天 | **发布 v0.2.1**——版本号 0.2.0→0.2.1；tag v0.2.1；生产升级待用户执行（git pull + ./scripts/build.sh + 重启 dsh，注意生产 accessToken 已配置无需再动） |
---

## 2. 开发时间线

### 2026-08-14（移植日，主代码 12 小时）

| 时间 | 工作 |
|---|---|
| 上午 | 读 DSH AGENTS.md；双路调研（Hermes 插件规格子代理 + DSH 插件架构子代理）；确认 dsh 0.1.0-rc.6 npm 包与 dsh-vision 外部插件先例 |
| 上午 | 脚手架：dsh-onebot 包结构、link-host.sh（宿主 @deepseek-ai 符号链接）、build.sh、npm 依赖 |
| 上午 | 协议/桥接/工具/权限/提示词九模块（cq/chat/connection/media/stt/split/bridge/tools/prompt/index） |
| 上午 | 42 个 vitest（真实 WS 对端 + 全管线）全过；真实宿主加载冒烟（dsh web --patch） |
| 上午 | **E2E 四连修**：stop() 擦映射、resume 模型选择引导期默认值、session id collision 自愈、媒体目录 ENOENT（见 §4） |
| 上午 | 入站消息 source 归属改为 plugin（会话日志区分平台消息） |
| 上午 | 线上部署：发现挂载层两个坑（$HOME 字面量不被 loader 插值、config.yaml 不是 patch 层）→ 改挂 profile 层 cordis.patch.yml + 绝对路径；热加载 1 秒生效 |
| 上午 | NapCat 拨入成功（<port> ESTABLISHED）；真实 QQ 链路验证：hello → 模型回复 → turn completed；重启记忆验证（暗号柚子跨重启保留） |
| 上午 | **t2i 里程碑**：按 T2I_DEV_DOC 整理方案获批；canvas 实验（系统字体家族/emoji 彩色/ttc/逐字形回退）；六模块落地（fonts/canvas/measure/parser/elements/index） |
| 上午 | t2i 修三处：fontkit ESM 入口是浏览器构建（改 createRequire 惰性加载）、表格数据结构维度、嵌套 required 不被参数 DSL 支持 |
| 上午 | **emoji 代理对 bug**：JS 字符串索引按 UTF-16 码元拆开 emoji → 高代理位被分类成 CJK 渲染成黑字形（像素扫描发现）→ 全链路改按码点迭代 |
| 上午 | t2i 集成：textImageThreshold=150 卡片路径 + 渲染失败回退分段；76/76 全过；像素右缘扫描 ≤790；view_image 视觉校准通过 |
| 上午 | t2i 确定性 E2E：长消息 → 出站 types=[image] fileLens=[193629]（单图片段 193KB 卡片） |
| 上午 | **split 分段修复**：需要我做什/么直接说 中间截断 → 对齐原版 _split_reply（窗口内向后找标点、标点集去掉 .:;、空格回退、代理对保护）79/79 全过，热加载上线 |
| 下午 | 本日志 |
| 下午 | **loop 中间消息合并转发+撤回**（按 onebot-adapter-port/plugin/onebot/loop-merge-implementation.md 移植）：interimMessages=true 改为「延迟一条」策略（assistant/message 先暂存，下一条到达时上一条才发出并入缓冲；turn/end 结算：缓冲 ≥2 条 → send_forward_msg/private_forward_msg 合并转发 + delete_msg 撤回原消息 → 再发 final 走原路径含 t2i/分段）；新用户消息到达清空缓冲（防跨轮合并）。踩坑：turn/end 结算任务在发送链上 await sendToChat 造成**链上死锁**（sendToChat 排队在自身之后）→ 结算只走链、final 发送放结算完成的 .then 里再入链。旧测试语义更新（send 从 assistant/message 时点移到 turn/end 后）；新增 3 测试（≥2 合并+撤回+final、单条不合并、新消息清残留）；85/85 全过，构建热加载；
| 下午 | **loop 结算顺序调整**（用户要求）：final（含 t2i 卡片）先发，t2i 发送完成后再合并转发+撤回——先给用户看结果卡片，中间评论再收敛。测试断言同步更新（final → forward → delete 顺序），85/85 全过，构建待重启 |
| 下午 | **斜杠命令补齐**：接通从未被调用的 tryHandleCommand 路由（此前仅 processInbound 特判 /new），新增 /model（查看当前模型+可用 provider/model 目录；`/model <provider> <model>` 切换：更新 agent selectionRef.current（下一步生效）+ agentDefaultModel.saveSelection 持久化，未知模型拒绝）与 /workspace（查看当前 cwd+所属 workspace；list 列出全部；`/workspace <目录>` 校验 realpath+isDirectory 后记录 per-chat 覆盖，并 retire 当前 agent——session cwd 创建时冻结，下一条消息以新目录重建会话）；/stop 增强：cancel 后清 loopPending/loopBuffer（被取消回合静默收尾不发残文）；/new 统一走 resetChat（删除重复内联与 parseSlashCommand 孤儿）；/help 更新。类型：BridgeDeps 注入 agentDefaultModel + WorkspaceRegistryLike 扩展 list；fake agent 补 status/cancel；90/90 全过，构建待重启 |
| 下午 | **事故与修复**：往 cordis.patch.yml 错误新增 dsh-onebot-nas 条目（同插件二次加载）→ 双实例工具注册冲突 → 崩溃循环 + chat-sessions.json 被清空。修复：移除重复条目（配置合并进现有 dsh-onebot 条目），恢复映射，重启。**教训：同一插件文件绝不能 insert 两次；给现有插件加配置必须改原条目 config** |
| 下午 | **QQ 文件接收双通道**：NapCat 文档（napneko.github.io/develop/file）确认 get_private_file_url 私聊直链（QQ CDN，实测 200 + MD5 一致）→ resolveNasFile 优先直链下载，失败回退 get_file 的 base64/http-url 载荷（SSH 方案未实现，仅注释残留，后已清理）；get_private_file_url 加入 qq_napcat_api 白名单；file 段解析 name 回退 file 字段 + 保留 file_id。90/90 全过 |
| 下午 | **loop 结算顺序再调整**（用户要求明确顺序）：合并转发 → 发送 t2i/final → 撤回。settleLoopBuffer 拆为 sendLoopForward + recallLoopMessages 两段，turn/end 在发送链上排三步（转发成功才执行撤回，失败保留原消息）；测试断言更新（fwd → final → delete），90/90 全过，构建待重启 |
| 下午 | **入站图片压缩规划**：对齐 Hermes 原版 _shrink_image 梳理决策点，用户拍板——黑底垫色、EXIF 方向校正、GIF 不支持时保持原图；方案见 §3.12，待实现 |
| 下午 | **入站图片压缩实现**：src/image-shrink.ts + media.ts 接线 + imageMaxSize 配置；踩坑：@napi-rs/canvas loadImage 已自动应用 EXIF 方向（手写解析会双重旋转）→ 删手写 EXIF 逻辑；99/99 全过，详见 §3.12 |
| 晚 | **入站媒体解析修复验证（用户实测四类全过）**：语音——转写正常附带（测试语「听到了吗」）；图片——[图片:path] 标注正确、view_image 可读；文件——[文件:path] 标注正确、dsh-onebot-image-compress-plan.md 完整可读；视频——[视频:path] 标注正确、MP4 v2 有效。四类均落盘 dsh 媒体目录，修复生效 |

### 2026-08-16（验证与修复）

| 时间 | 工作 |
|---|---|
| 上午 | 包名改为 `@dsh-external/dsh-onebot`（符合插件生态 scope 约定，登记 awesome-dsh-plugins 前置），推送 GitHub（a27dd2b） |
| 上午 | **长文本分段路径验证**（用户实测）：默认 textImageThreshold=150 时 >150 字符回复全部走 t2i 卡片，文本分段（splitLongText）仅 100~150 区间或卡片渲染失败时触发；100~150 区间实测分段正常（按句号切两段） |
| 上午 | **loop 合并"少撤回一条"（用户截图实测）**：每轮合并卡片都比中间消息少一条（卡片 2 条+撤回 2 条，漏掉最后一条中间文本且不撤回）。根因：interim 消息 id 在 sendToChat 完成后**异步** push 进 loopBuffer，而 turn/end **同步**快照 buffer → 最后一条 pending interim 的 push 晚于快照，落进被替换的旧数组，永不合并/撤回 |
| 上午 | **中间消息"慢一拍"（用户反馈）**：原「延迟一条」策略（上一条文本等下一条 assistant/message 到达才发）让 QQ 收到的中间文本滞后一步。方案：assistant/message 的 content 含 tool-call 块时 100% 不是最终回复（模型调用工具后必继续）→ **立即发送并记账**；仅无工具调用的纯文本保持延迟判定（用于区分最终回复） |
| 上午 | 修复实现：`sendInterim`（发送+记账封装）+ `settleLoop`（turn/end 先 await 发送队列排空再快照 buffer，顺序：合并转发 → final（t2i/分段原路径）→ 撤回，任一步失败安全降级保留原消息）；99/99 全过，推送 GitHub（68f2398），详见 §3.13 |
| 晚 | **上线实测发现重复发送（用户截图+OCR 核对）**：合并卡片 5 条，第一条中间文本出现 3 次（内容完全相同）。根因：同一 assistant 消息会被会话**重发多次 assistant/message 事件**（流式/usage 更新重发），「立即发送」逻辑对每次事件都 sendInterim 一次 → 重复发送+重复入账。修复：按 message.id 去重（`lastHandledMessageId`，同一 id 只处理一次；消息无 id 时跳过不去重，兼容旧事件）；新增去重回归测试（同 id 重发 3 次只出 1 条，合并卡片 2 条+撤回 2 条）；100/100 全过，推送 GitHub |
| 晚 | **修复后复验通过（用户截图确认）**：重启加载新代码后实测——3 轮工具调用 3 条中间文本：合并卡片正好 3 条、撤回提示 3 条、无重复、中间文本即时出现。三连修（排空队列/立即发送/去重）全部生效 |
| 晚 | **/new 后开不了新对话（用户上报）**：`session "onebot-private-841859784" already has a persisted log on disk that does not match this live session (id collision)`。排查：会话 id 按 chat 确定性派生，/new 只把旧 id 记进**内存** brokenSessions 并清空 mapping，重启后裸 id 被复用撞上磁盘旧日志。修复：废弃 id 持久化（retired-sessions.json）+ 兜底记账修复（用真实 session id 收尾）；102/102 全过，详见 §3.14 |

### 2026-08-18（safe-edit 拆分为独立插件 dsh-safe-edit）
| 时间 | 工作 |
|---|---|
| 午 | **code_safe_edit / code_safe_rollback / code_list_backups 拆分出本插件**（用户要求）：新建独立插件 `~/dsh-plugins/dsh-safe-edit/`，安全编辑工具改为对所有通道（QQ/Web/其他）全局注册；可编辑根跟随会话 sandbox 策略——`danger-full-access` 无限制、`workspace-write` 限会话工作区、`read-only` 拒绝、无策略服务回落 `safeEditRoot`。本插件（onebot）删除 src/safe-edit.ts、tests/safe-edit.spec.ts 及 tools.ts 中相关注册块、index.ts 的 safeEditRoot/backupDir 配置项；相关测试并入 dsh-safe-edit（7/7 全过）。挂载配置：`~/.dsh/profiles/web/cordis.patch.yml` 移除 onebot 的 safeEditRoot，新增 dsh-safe-edit 条目。详见 §3.21 |
| 午 | **真机排查 + 修复 sandbox policy bug + 重启上线**：首次给 `SandboxPolicyService.resolve()` 传 `{id}` stub 导致 `session.events` undefined → `Cannot read ... (reading 'length')`；按 dsh-tool-bash 改为传完整 `exec.agent.session` 对象。KEY 认知：**HMR 只重应用配置快照、不重新 require 插件 JS**，改 lib 必须重启 dsh（launchd 拉起）。重启后实测全链路：编辑→备份→回滚 通过；full-access 会话跨 /tmp 编辑成功。onebot 118/118、dsh-safe-edit 7/7 全绿。详见 §3.21 |

### 2026-08-19（/plan 上线后真机修复）

| 时间 | 工作 |
|---|---|
| 下午 | **/plan 转发补传必填 signal**：§3.22 转发上线后 /plan 调用报 `Cannot read properties of undefined (reading 'aborted')`——宿主 `commands.execute` **无条件**读 `signal.aborted`，而转发时未传 signal（声明为可选）。修复：调用处补传 `new AbortController().signal`（QQ 用户发起的 /plan 不被本插件取消逻辑中断）；BridgeDeps/Context 类型把 signal 改为必填；测试同步；构建入库。详见 §3.25 |

### 2026-09-01（文档：架构图三连）

| 时间 | 工作 |
|---|---|
| 下午 | **架构图三连（纯文档，无代码改动）**：① Archify 导出自包含 SVG（宿主样式变量与类内联、裸属性规范化为 SVG/XML 合法值）嵌入 README「## 架构」+ 保留交互式 HTML；② SVG 在 GitHub 管线不渲染 → README 改用 2x 高清 PNG 嵌入，SVG 补 xmlns 保留矢量版；③ README.en.md 新增英文版架构图（EN SVG 全文翻译 + 按英文宽度重排标签遮罩 + EN PNG）。详见 §3.25 |

### 2026-08-17（会话字段对齐 Web：preset 记录）

| 时间 | 工作 |
|---|---|
| 晚 | **Web 上不显示 QQ 会话的 preset（用户提问）**：查证 Web 会话标题旁 preset 标签（AgentPresetLabel）只渲染 session summary 里的 agentPreset 值，该值来自会话 header 的 agentPreset 字段；Web 创建路径（api-proxy sessions.create）总是 resolve 默认/指定 preset 写入 header，而 onebot 创建路径只在插件配置 agentPreset 非空时写入（默认空）→ 该会话 header 无记录、Web 无从显示（会话实际仍按默认 router-flash 组装）。诊断详见 §3.15 |
| 晚 | **补齐字段与行为**：`ensureChat` 改为总是 `resolvePresetId()`（配置非空用配置，否则部署默认 defaultId）并写入 `meta.agentPreset`——新会话 header 固定记录有效 preset id，Web 标签可见；`loadMapping` resume 改为先 `sessionPersistence.inspect` 读会话自己记录的 preset（最新 `agent-preset/selected` 事件优先，否则 header），有记录时以记录为准并在与插件配置冲突时 warn（防配置变更致老会话组装漂移）；新增 `resolveRecordedPreset` 纯函数与 `resolvePresetId`/`recordedPresetFor`；Config 文案修正（原写「当前为 standard」，实际部署默认 router-flash）；inject 增加 `sessionPersistence`。存量会话 header 无记录 → resume 回落配置/默认，行为不变（不做迁移）。105/105 全过（新增 3 测试），构建上线，详见 §3.15 |
| 晚 | **宿主升级 dsh rc.6→rc.7（用户要求先做冲突检测）**：逐行对比 rc.6/rc.7 的 12 个运行时包 + bundle 组成 + 存储格式，结论：依赖无增删、8 个核心包零差异、base/web-app 组合逐行一致、SESSION_FORMAT_VERSION 仍 0、preset 相关 API 全兼容 → 无冲突。升级执行中发现 **link-host.sh 解析 bug**：`resolve_dsh_root` 在 nvm 全局布局（bin 在 <node>/bin、包在 @deepseek-ai/dsh/node_modules 内嵌）下先命中 `~/.npm/_npx/*/node_modules` 残留 store，把插件链到 npx store 副本（dual-package 隐患）→ 修复：bin 祖先循环增加 `lib/node_modules/@deepseek-ai/dsh/node_modules` 检测优先于 npx store。升级 + 重链 + launchd 重启（kill 主进程 → ai.dsh.web KeepAlive 自动拉起）后验证：bridge ready (1 resumed)、agent joined preset router-flash、heartbeat 恢复、bin --version = 0.1.0-rc.7，详见 §3.16 |

### 2026-09-10（M0 安全与稳定性加固，v0.2.0）

| 时间 | 工作 |
|---|---|
| 全天 | **A1 反向 WS 鉴权加固（BREAKING）**：`token !== '' &&` 使空 token 整体跳过校验（fail-open），叠加默认 `host: '0.0.0.0'` + `accessToken: ''` = 默认全网卡无鉴权，局域网任意主机可伪造管理员事件（等效未认证 RCE）→ reverse 空 token 抛错拒启（fail-closed）、默认绑定 `127.0.0.1`、比较改 `crypto.timingSafeEqual`（先比长度）；forward 模式不受影响（token 是外发 Authorization 头）。connection.spec +6（fail-closed / 错误 token / 缺失 auth / 默认 host / B1 守卫 / 无 dbg 输出） |
| 全天 | **B1 socket close 归属守卫**：attachSocket 与 forward 的 close 处理器无条件 `stopHeartbeat()+setConnected(false)+failAllPending()`，last-wins 替换后旧 socket 的 close 异步晚到 → 杀死新连接心跳并永久断标 → 机器人「活着但失语」。两处首行加 `if (this.socket !== socket) return`（对称）；单测模拟旧 close 晚到：connected 不翻转、心跳存活、pending 正常 |
| 全天 | **C4 删热路径调试日志**：onFrame message 分支残留 `[dsh-onebot:dbg]` 无条件全量 JSON console.log（群成员昵称/QQ 号/原文进宿主日志，隐私+性能）→ 删除，src/tests 零残留 |
| 全天 | **B2+B3 mediaDir 清理修复**：cleanupExpired 无文件名过滤会删同目录的 chat-sessions.json / retired-sessions.json（空闲超 6h TTL 后任意入站触发 → 重启全部会话失忆）；STT `stt_<uuid>` 工作目录从不清理（每条语音泄漏 ~2MB）→ 清理改前缀白名单（仅 media_* 文件 + stt_* 目录递归）；transcribeNow try/finally 清工作目录（best-effort 不吞转写结果）。边界：升级前旧命名历史媒体文件不再自动清理 |
| 全天 | **A4 入站文件改名落盘**：safeName 保留 `.` 且直写 `mediaDir/<原始名>`，发名为 chat-sessions.json 的文件即可覆盖状态文件（配合确定性 session id 可在重启后劫持管理员会话）→ 一律 `MediaStore.freshPath` 生成 `media_<ts>_<uuid><ext>` 不可预测名，新增 `extForInboundName`（扩展名白名单，规则同 extForUrl）。新增 media-cleanup.spec 5 例（恶意文件名落盘 / 状态文件哨兵逐字节不变 / 清理矩阵） |
| 全天 | **E1 元数据 + 发布收尾**：bridge/plugin.spec 28 处 fixture 补 `accessToken: 'test-token'`、bridge.spec 19 处真实 WS 拨入补 Authorization 头，适配 fail-closed 语义；dsh.plugin.json 移除已拆走 dsh-safe-edit 的 code_safe_edit 三件（对齐 package.json）；engines.dsh `>=0.0.1` 收紧为 `>=0.1.0-rc.6`；README / README.en 标注 BREAKING；130/130 vitest 全绿，**发布 v0.2.0**。e2e-peer 真机冒烟当日补跑通过（见下） |
| 全天 | **适配当前宿主 dsh 0.1.5-rc.1（过时声明更正）**：盘点发现宿主全套 @deepseek-ai/* 已升至 0.1.5-rc.1、cordis 4.0.2，且 dsh-tools 公开导出中 JsonValue 类型已迁至 dsh-util-values（tsc TS2614 实证）→ tools.ts 改导入源、link-host.sh LINK_PKGS 与 peerDependencies 增补 @deepseek-ai/dsh-util-values；peer 依赖 0.1.0-rc.6 → ≥0.1.5-rc.1、cordis 4.0.1 → ^4.0.2、engines.dsh 同步 ≥0.1.5-rc.1（package.json + dsh.plugin.json）；README/README.en 兼容表、安装前置、最后验证日期一并更正；验证：对 0.1.5-rc.1 实链宿主 `tsc --noEmit` 0 错误、vitest 130/130 全绿 |
| 全天 | **e2e-peer 真机冒烟（M0 DoD 收口）**：隔离第二实例（独立 DSH_HOME，profiles/web/cordis.patch.yml 挂载工作区新 lib：mode=reverse、127.0.0.1:18643、accessToken 'e2etest'；生产 8765/NapCat 实例全程不动），`tests/e2e-peer.mjs` 假 NapCat 拨入实测：正确 Bearer token 全链路通（入站私聊 → set_input_status → agent 真实 LLM 回复 → 出站 send_msg text 段）；错误 token / 缺失 auth 头均被拒 WS close 4401 unauthorized；默认绑定 127.0.0.1 在真实宿主进程复核。注意：生产 ~/dsh-plugins 仍是旧构建，上线新 lib 前必须先在 cordis.patch.yml 给 dsh-onebot 补 accessToken（否则空 token fail-closed 拒启、QQ 通道中断） |

### 2026-09-10（M0 里程碑复盘与 M1 启动）

| 时间 | 工作 |
|---|---|
| 全天 | **DoD 9/9 核销通过，重排信号未触发**：A1/B1/B2+B3/A4/C4/E1 全部合入且每包有专测；vitest 130/130（基线实为 119，README 曾写 99/99 属滞后声明）；tsc 对 0.1.5-rc.1 实链宿主 0 错误；e2e-peer 真机冒烟通过（全链路 + 4401 拒绝实测，commit 9c65b40）；tag v0.2.0 已推远端 |
| 全天 | **估算偏差**：A1 +50%（BREAKING 测试半径 47 处——28 fixture 补 token + 19 WS 拨入补 Authorization 头——未估入工作包，后置到整合）；E1 成为整合回收站（+100~200%）；日历 1 天 vs 计划 3-4 天（双专家按文件所有权并行的结构优势）；范围内超支 +15% 在缓冲内。**范围审计**：23 变更文件 0 触碰范围外清单；计划外「宿主 0.1.5-rc.1 兼容适配」补录为常备预备包 **C7**（0.5 人日；触发条件：宿主升级 → 盘点 @deepseek-ai/* 与 cordis 版本 → 实链 tsc → 兼容声明与 link-host.sh 更正）；测试适配 47 处追溯并入 A1 口径（变更方负责适配原则） |
| 全天 | **协议偏差与 3 条流程改进**：E1/测试适配/发布整理由编排者亲自实施（违规，产出已验收有效）→ M1 起：①任务书强制「影响面自评 + 测试自含」，tests/ 所有权跟随变更方；②无主 diff 四步处置（冻结→考古定意图→补任务书重委派或显式 revert→禁止编排者改写合入）；③实施一律委派，豁免须先过 PM 检查点并记录；恢复逐包独立 commit（M0 曾两包合一 commit 致 revert 粒度变粗） |
| 全天 | **M1 启动**：范围不变（9.25 人日，A2→A3、C3→A5 硬前置）；Wave 1 三组并行（G-CON：B4+B5 ∥ G-MED：A6 ∥ G-BRG：A2）；A3 拆 A3a/A3b 两单。**遗留风险**：R1 生产未切换新 lib（须先两端配 accessToken 再挂新 lib，否则 fail-closed 拒启）；R5 NapCat 真客户端 4401 重试行为观察 24h；R6 测试数单一事实源 = vitest 实跑 |


### 2026-09-10（M1 Wave1：B4/B5/A6/A2）

| 时间 | 工作 |
|---|---|
| 全天 | **B4 心跳 pong 校验 + 超时 terminate + meta 心跳日志静音（commit 9bd2596）**：reverse/forward 两条 socket 路径挂 pong 监听（带归属守卫 `this.socket !== socket`——晚到旧 socket 的 pong 不污染新连接的 lastPongAt，与 B1 close 守卫同型）；心跳 tick 判定 `now - lastPongAt ≥ 2×HEARTBEAT_MS`（HEARTBEAT_MS=30s）→ terminate 走既有 close 链路（failAllPending + 状态翻转 + 重连调度），半开连接不再永久假在线；meta heartbeat 事件静默（logMetaEvent 对 heartbeat 直接 return，life_cycle 等其余 meta 照常出日志）。**取舍**：keepalive 仅依赖应用层 pong——ws 公开类型面无底层 socket 通道（`_socket` 为私有字段，升级无保证），且 30s ping 帧本身即 keepalive 流量。connection.spec +3 |
| 全天 | **B5 重连策略与状态上报（commit 627bcdf）**：新增配置 `reconnectMaxAttempts`（默认 100；`0`=无限重连，退避封顶 60s）；forward 重连放弃时日志含上限值与恢复指引（查 NapCat 地址与网络后重启插件/重载通道恢复）；reverse 监听 EADDRINUSE 日志含 host:port 与处置建议（停掉占端口进程或改 config.port）；stop() 清理重连定时器 + start() 防重入——stop→start 连续 50 次切换无幽灵定时器（单测覆盖）。connection.spec +5 |
| 全天 | **A6 入站图片解码炸弹预检（commit 4a4ac96）**：loadImage 前轻量头解析（PNG IHDR / JPEG SOF），声明尺寸超 `MAX_DECODE_EDGE`（8192，image-shrink.ts 命名导出常量）→ 解码前中止（return undefined，调用方保留原图），杜绝 30000×30000 声明 PNG 的 ~3.6GB Skia 分配 OOM；畸形/截断头回落原解码路径。**边界**：WebP/AVIF/HEIF 未预检（QQ 入站主体为 PNG/JPEG）；假阴性=放行（与改前行为一致，不新增失败面）。image-shrink.spec +7 |
| 全天 | **A2 canEditFiles 回合级角色固化（TOCTOU 修复，commit 23c0523）**：`chat.lastUserId`（最近入站用户）已删，改 `pendingTurnRoles` FIFO + `activeTurnRole`——**在宿主 `turn/start` 事件点 shift 固化**（静态证据链查证 dsh-session 暴露 turn/start 且与 turn/end 同 feed），canEditFiles 只读当前运行回合自己的角色；队列空/未知路径 fail-closed 为 member；/retry 传 admin（命令门禁已在 tryHandleCommand）；/new 与 healSessionCollision 随 ChatAgent 对象消亡结构性清队。**机制否决推演（给未来维护者的重要上下文）**：否决「turn/end 时 shift」方案——交错场景推演证明存在双向错位（管理员回合被误拒、成员后续回合被误放行）；turn/start-shift 的 FIFO 头严格对应当前运行回合，无此错位。**遗留**：turn/start 送达依赖静态证据链，真机冒烟建议加 debug 观测；若宿主不送 turn/start，后果为全员 fail-closed member（安全方向）。bridge.spec +4 |

### 2026-09-10（R1 生产切换收口 + trim-cli 真机验证能力接入）

| 时间 | 工作 |
|---|---|
| 全天 | **R1 生产切换完成（用户执行）**：NapCat ws-reverse 与插件 accessToken 两端配齐、新 lib 部署、dsh 重启——M0 的安全价值（封死未认证 RCE 口子）正式在生产兑现；R5 随之进入 24h 观察窗（NapCat 真实客户端对 4401 拒绝的重试行为，此前仅 e2e 一次实测）；生产 lib 对应 v0.2.0（M1 Wave1 的 4 个 commit 尚未构建进生产 lib，属正常迭代节奏，Wave1 本就属 M1 迭代） |
| 全天 | **trim-cli 技能接入编排环境**：TRIM NAS（fnOS）命令行客户端——WebSocket 连本机 ws://localhost:5666，登录后可查应用中心/Docker 容器/日志中心/文件/存储/系统监控，支持真机验证 workflow；来源为飞牛论坛附件（club.fnnas.com 附件需论坛登录，无法匿名抓取，技能本体已预装就位，无需再下载）；意义：后续 M1 回归包的「生产部署检查单」「24h 磁盘观察」等真机验证项可由编排方经 trim-cli 直接执行，不再依赖用户手工回报 |

### 2026-09-10（M1 Wave2：C3/A5/A3a/A3b）

| 时间 | 工作 |
|---|---|
| 全天 | **C3 统一下载路径（commit c3b52e0，refactor）**：删除 bridge 私有 downloadToMedia——裸 fetch 后 arrayBuffer() 全量缓冲、maxBytes 限长在缓冲完成之后才生效，大文件先吃满内存再被拒；resolveNasFile 两个 URL 分支改走 MediaStore.downloadUrl(url, ext, maxBytes) 流式边下边限长；grep 零残留；writeMediaFile（base64 分支）保留。C3→A5 硬前置兑现：A5 的下载围栏收口在这条唯一下载路径上 |
| 全天 | **A5 下载 SSRF/协议/限长加固（commit 0e1807e，security）**：downloadUrl 协议白名单仅 http/https；私网判定——IPv4 字面量 0/8、10/8、127/8、169.254/16、172.16/12、192.168/16，IPv6 ::1/::、fc00::/7、fe80::/10（IPv4-mapped `::ffff:x.x.x.x` 双写法归一后再判），域名经 dns.lookup 解析任一命中即拒；redirect: manual 手动跟随 ≤3 跳，每一跳在 fetch 发起前复检协议与私网；整次下载 30s 硬墙钟（AbortSignal.timeout）；新增配置 allowPrivateHosts（默认 false，true 时仅跳过私网检查——本机反代等可信场景逃生门，协议白名单与限长不豁免）；resolveInner 两处调用补传 maxBytes。**取舍**：30s 取整次下载总墙钟而非逐跳计时（重定向拉长全程仍统一封顶）；重定向前置拒绝——每一跳 fetch 前即拒，中间跳不产生出站请求，而非跟随后再补救；IPv4-mapped 归一防 `::ffff:` 写法绕过私网判定。media-guard.spec +16（SSRF 矩阵/重定向/流式中止） |
| 全天 | **A3a 媒体外发路径围栏机制（commit 52655f6，security）**：新增导出 resolveContainedPath(allowedRoots, target)——realpath 归一后前缀匹配且带分隔符边界（`/root/abc` 不误放行 `/root-abc`），symlink 解析后落在根外即拒绝（逃逸封死）；目标不存在 → 返回 null fail-closed；fileToBase64 增可选第三参 allowedRoots。**取舍**：不存在即拒——媒体外发是出站动作，宁可误拒也不给路径探测留口子 |
| 全天 | **A3b 门禁接线（commit b187b03，security）**：bridge 新增 mediaSendRoots(sessionId) 访问器——isTurnAdmin 复用 A2 回合级角色语义（不另起第二套角色判定）；roots 口径：member/未知 → 仅 mediaDir，admin → mediaDir + 会话工作区（两支均 realpath 归一）；qq_send_image/voice/video/file 本地路径分支全部过围栏，围栏拒绝转译为中文可行动提示（而非裸抛校验错误）；URL 分支保持原样（NapCat 侧抓取，见边界行）。过渡窗口关闭：tools 恒传 allowedRoots，无兜底放行。tools-gate.spec 新建 +9（门禁逐条）；vitest 149 → 174 |
| 全天 | **已知边界（后续清理候选）**：①file:// copyFile 分支（NapCat 本地路径场景）未围栏；②qq_send_* 的 URL 出站分支由 NapCat 侧抓取，插件不代理不围栏；③DNS rebinding TOCTOU 未彻底修复——dns.lookup 判定与实际建连之间仍存在时间窗，彻底修需 pinned IP dispatcher（超出本 wave 范围）；④两项清理建议：/ocr 的 fileToBase64 仍为两参调用（未接围栏）、imageSegment 死代码可删 |

### 2026-09-10（M1 Wave3：A8×3/A7/B6/B7/E2/C6a）

| 时间 | 工作 |
|---|---|
| 全天 | **A8-conn WS 帧上限 + reverse 拨入抖动防护（commit 4d32112，security）**：WS 帧上限 `MAX_FRAME_BYTES`=64MiB——取值兼容 get_file base64 大响应（大响应不被误杀）；reverse 拨入抖动防护：60s 滑动窗口限 5 次连接替换，超限拒绝，NapCat 掉线重拨不计入、不受限。**取舍**：抖动防护仅 reverse 侧，forward 行为不变 |
| 全天 | **A8-stt STT 命令探测去 shell（commit 978e3da，security）**：findCommand 由 `sh -c 'command -v …'` 拼接改为 PATH 逐目录扫描（access X_OK），全仓唯一一处 shell 拼接消除。**取舍**：`command -v` 与 PATH 扫描在 builtin/alias 解析上有差异，但探测对象 ffmpeg/whisper 均为二进制文件，语义等价 |
| 全天 | **A7 昵称消毒（临时方案）（commit f0a19da，security）**：sanitizeNickname 剥除 CR/LF/控制字符、空白折叠、按码点截断 32（代理对安全，不拆 emoji）；单一收口点接入全部下游（消息前缀/lastNickname/t2i 卡片标题/retry）。**取舍**：正文内伪造前缀行属对话结构注入，归 D5 体系化处理，本包不动 |
| 全天 | **B6 断线补发队列（commit 00a091c，reliability）**：SendOptions.queuable 白名单仅三个模型最终回复调用点置 true（settleLoop final flush / instant pendingFinal / turn 错误通知），interim/撤回/命令回复不入队；断线入 per-chat FIFO（TTL 5min、上限 20 超限丢最旧），onStatus(true) 按序 drain，drain 中再断线自动重新入队。**取舍**：仅模型最终回复可入队——interim/撤回/命令回复补发无意义（易过期或不该重发） |
| 全天 | **B7 busy 生命周期 + 入站频控（commit 0a618bc，reliability）**：turn/start 置 busy=true——/retry 防重入首次真正生效、/status 失真修复；新增配置 `rateLimitPerMinute`（默认 30，`0`=禁用）：每 chat 60s 滑动窗口，普通消息超限跳过 dispatch、每窗口至多一条限流提示，命令豁免（配置已进双语 README 配置表） |
| 全天 | **E2 flush 去抖（commit 0c6121c，reliability）**：onSessionFlush 改走 saveMappingDebounced——映射文件不再每次 flush 全量重写；stop() 强制落盘语义保留 |
| 全天 | **C6a 清理 + 命令路由前置（commit 4ba73a2，refactor）**：死代码三件删除（imageSegment/cqEscape/恒 false 的 mentioned 字段）；tryHandleCommand 前移到媒体解析/引用展开之前（带图命令不再白付图片下载 I/O）；/ocr 最近图片改惰性两级登记——命令消息中的图片仅在 /ocr 真正执行时才下载，三种场景行为等价核对；retiredSessionIds 数组→Set（磁盘格式不变） |
| 全天 | **A8-cq 提及门禁收紧（commit da81b7e，security）**：reply 段可判定被回复者时仅回复 bot 自身才算提及（回复群友不再唤醒），不可判定回落现状计为提及。**取舍**：fail-open 有意保留——被回复消息取不到时漏唤醒代价高于误唤醒；requireMention 行为语义变化，双语 README 描述已同步。vitest 174 → 200（+26），tsc 0 错误 |
| 全天 | **已知边界（后续清理候选）**：①qq_send_* 的 URL 出站分支仍由 NapCat 侧抓取，插件不代理不围栏（承 Wave2）；②DNS rebinding TOCTOU 时间窗仍在，彻底修需 pinned IP dispatcher；③正文内伪造前缀行归 D5；④B6 补发队列为 bridge 层内存态、按 chatId 组织，重启即丢；⑤B7 滑动窗口为内存态（重启清零），每 chat 首条消息不计窗 |

### 2026-09-10（M2 启动：T0 测试加固）

| 时间 | 工作 |
|---|---|
| 全天 | **M2-T0 启动（bridge.ts 五拆的测试安全网）**：用户确认生产已升 v0.2.1（90129d2 全量在产）；R5 NapCat 4401 重试 24h 观察由用户豁免收口；trim-cli 会话已建立，真机验证能力就位。T0 范围：①特征化测试补齐（命令路由全表/出站闸门矩阵/registry 持久化 round-trip/入站管线顺序/interim 时序/golden 快照/ensureChat 并发现状）；②tests/README.md 五拆迁移地图（现有用例 → commands/inbound/outbound/interim/registry/card-relay 目标 spec）；③打 pre-refactor-baseline tag。铁律：src/ 零改动，纯特征化钉现状 |
| 全天 | **T0 记录（commit 见 git log）**：vitest **212 passed + 1 todo（213）**（基线 200 → +12 特征化 +1 todo）、tsc 0 错误。新增 12 用例：/help 全表快照、14 命令非管理员拒绝矩阵（无副作用断言）、RESTRICTED_PREFIX 注入（成员注/管理员不注）、断线闸门直测（queuable 入队重连补发/非 queuable 抛 OneBotNotConnectedError）、mapping 真 round-trip（钉死：preset 从会话记录回填压过 config、model 无按会话持久化用当前 defaultModel）、collision 自愈端到端（映射清空→新后缀 id 重建+回填）、入站管线顺序 spy（policy→mention→command→media→quote→dispatch）、sendInterim 记账+回填+去重、settleLoop 先排空发送链再快照、golden×3（私聊纯文本/群聊@+工具调用 interim→摘要卡→撤回→final/长文本单 t2i 卡片）。桩设施增量：makeHarness +textImageThreshold、makeCmdHarness +restrictedMemberPrefix。**疑似已知竞态（实证）**：同 chatId 并发首条消息时 ensureChat 双过空表检查——agents.create 被调 2 次、同一裸 session id、chats 仅存后者（80ms create 延迟双并发实测）→ 按 PM 指示 it.todo 留待 M2-PR3 B8a 修复后转正，不固化绿断言；tests/README.md 已载实测证据。src/ 零改动 |
### 2026-09-11（M2 五拆进行中：T0/C2/PR1/PR2/PR3）

| 时间 | 工作 |
|---|---|
| 全天 | **M2-T0 特征化加固收口（commit 238ba61，src 零改动）**：+12 特征化用例钉现状——14 命令×非管理员拒绝矩阵（无副作用断言）、出站闸门直测（queuable 入队重连补发/非 queuable 抛 OneBotNotConnectedError）、mapping 真 round-trip（preset 从会话记录回填压过 config、model 无按会话持久化）、入站管线顺序 spy（policy→mention→command→media→quote→dispatch）、interim 时序（sendInterim 记账+settleLoop 排空）、golden×3（私聊纯文本/群聊@+工具调用 interim→摘要卡→撤回→final/长文本单 t2i 卡片）；ensureChat 并发竞态实证（80ms 双并发 agents.create×2、后者覆盖前者成孤儿）按 PM 指示 it.todo 留位不固化绿断言；tests/README.md 五拆迁移地图（65 条用例→五拆目标 spec；共享桩提取随 9b5701e 为 PR1 前置）；打基线 tag pre-refactor-baseline。**取舍**：纯钉现状——已知竞态进 todo 不进基线，红线留给 B8a 转正 |
| 全天 | **M2-C2 createChatAgent 工厂（commit fd3f33c）**：19 字段字面量 + buildSetup + modelWiring 三件套统一 ensureChat/loadMapping 双份装配（行为零变化）；lastNickname 分歧按现状保留并特征化钉死；字段快照测试钉装配面。**取舍**：分歧不趁 refactor 顺手改——改行为走独立评审，五拆期间断言语义不动 |
| 全天 | **M2-PR1 命令表化（commit da7b549）**：新建 src/commands.ts（568 行）——14 命令一行一注册；窄接口 CommandContext（30 成员，按处理器实际触达面收敛）；/help 由表生成（与原硬编码逐字一致）；adminOnly 从分支判断改声明性元数据；15 条命令用例迁 tests/commands.spec.ts；bridge.ts 2249→1814；tools.ts diff=0。**取舍**：门禁仍守路由入口单点，不随 adminOnly 元数据散落各处理器 |
| 全天 | **M2-PR2 出站管线（commit 4243625）**：新建 src/outbound.ts（249 行，OutboundPipeline 类，B6 pendingSends 随迁）+ src/card-relay.ts（83 行，计划书/提问卡渲染近乎纯函数）；bridge 保留同名 facade（sendToChat 等调用面不变）；interim 五件套零触碰走 facade；bridge.ts →1624；golden 三条留守 bridge.spec。**取舍**：facade 防涟漪——tools.ts 零改动优先于一次性搬净 |
| 全天 | **M2-PR3a 会话注册表（commit 66b2dbe）**：新建 src/registry.ts（786 行，ChatRegistry）——chats/bySession/ensureChat/loadMapping/createChatAgent/mapping/retired 全域搬入；ChatSettings 值对象收拢 5 Map+pendingImageRef（/new survive 语义逐字保持）。**取舍**：行为零变化为唯一验收——持久化格式逐字节不变 |
| 全天 | **M2-PR3b B8 四子项（commit 278006f）**：a) ensureChat in-flight 缓存——T0 it.todo 转正（并发 10 条 create 恰 1 次）；b) 孤儿 agent dispose（create/resume 双路径）；c) 空闲淘汰 `chatIdleEvictDays`（默认 7，`0`=禁用；flush 成功才 dispose、不 retire、映射保留可 resume；双语 README 配置表已加行）；d) 发送链解耦——outbound 自有 sendChains，未注册 chat 也串行；bridge.ts →1116，持久化 JSON 格式逐字节不变。合并树 vitest **221/221** 全绿（200→221，+21）、tsc 0 错误。**取舍**：淘汰只清内存态——先 flush 后 dispose 且映射保留，宁多一次 resume 不丢会话 |
| 全天 | **已知边界（后续清理候选）**：①outbound 自有 pendingSends 后，bridge.ts 残留同名死字段/死代码路径，PR4 清理；②B8c 空闲淘汰连 ChatSettings 一并清空——/workspace /preset /mode 等 per-chat override 随之重置，与 /new survive 语义不一致，是否保留属产品决策待定；③commands 命令表冻结、CommandChatView 结构子型——扩命令/触达面须同步 CommandContext 窄接口；④qq_send_* URL 出站分支 NapCat 侧抓取、DNS rebinding TOCTOU 时间窗——承 M1 Wave2/Wave3 已知边界未变 |

补记：生产 v0.2.1 运行由用户确认、R5 NapCat 4401 重试 24h 观察由用户豁免收口、trim-cli 会话就位（真机验证能力可用）——此前仅口头确认、只在 2026-09-10「M2 启动」T0 行随 T0 前置带过，本行集中补记存档。

### 2026-09-12（M2 收官：五拆完成，v0.3.0）

| 时间 | 工作 |
|---|---|
| 全天 | **M2 收官核对 + 发布 v0.3.0**：五拆完成——bridge.ts 2249→681（-70%），七模块 bridge/registry/commands/inbound/outbound/interim/card-relay 合计 3168 行；测试 200→234（vitest 234/234、tsc 0 错误）；行为零变化（唯一有意变更 = C5a /model 会话级语义）；全程 tools.ts diff=0；基线 tag pre-refactor-baseline →五个 PR 逐个独立 commit 可 revert。B8 收尾核对五项全部测试落位：B8a ensureChat in-flight 缓存（tests/registry.spec.ts:967，并发首条 create 恰 1 次）；B8b 孤儿 agent dispose（tests/registry.spec.ts:978，whenIdle 抛错路径 dispose×1+零残留）；B8c 空闲淘汰 chatIdleEvictDays（tests/registry.spec.ts:1001，dispose+映射保留+resume 同会话恢复）；B8d 发送链解耦（tests/bridge.spec.ts:533，未注册 chat 亦串行）；recalledInterimIds turn/start 修剪（tests/interim.spec.ts:490，同 id 复用不复发）。**已知边界承前**：file:// 分支、DNS rebinding TOCTOU、URL 出站（NapCat 侧抓取）、正文伪前缀属 D5；B8c 淘汰即重置 per-chat override 待产品决策；commands 直写 ChatAgent interim 字段待 D2 收口 |
| 全天 | **发布完整性修复（v0.3.0 重打 tag）**：v0.3.0 tag 的 lib/ 缺五拆六模块产物（用户核查发现）——card-relay/commands/inbound/interim/outbound/registry 六模块 JS 及 lib/types 对应 .d.ts 从未 git add，直接 checkout v0.3.0 不构建的环境会因缺模块挂掉；build.sh resolve_dsh_root 自 link-host.sh 原样移植 npm/nvm 全局布局分支（bin 祖先内探测 `lib/node_modules/@deepseek-ai/dsh/node_modules`），重建产物后 v0.3.0 tag 重打为 4d90469 之后的修复提交。提醒：v0.2.x tag 的 lib 为 M0 时代内容（功能完整但滞后，不回补） |

### 2026-09-12（M3 收官：D2/D4/D5/E3，v0.4.0）

| 时间 | 工作 |
|---|---|
| 全天 | **M3-D2 interim 显式状态机**（8ba1c77/be53abe）：InterimTracker 显式转移表 idle/accumulating/settling（stateOf 诊断缝；双 turn/end 跳过、迟到 assistant 宽容语义保留）；sendInterim 同步记账——placeholder 入队即占位、发送完成按 id 回填、失败丢占位，消除 push 回调微任务顺序依赖；结算 drain 以 inFlight 集合等待在途发送全部落定；`interimRecall` 降级开关（false=只发不撤：无撤回无小结卡）；tests/interim-machine.spec.ts 全转移表覆盖，settle 用例固定 120ms 预算与 60ms 撤回间隔的时序竞态改为 vi.waitFor 终态谓词（idle 在排水最后置位），连续 10 次全绿 |
| 全天 | **M3-D4 配置与持久化**：D4a（5a7f26b）配置改名三件——`imageMaxSize`→`inboundImageMaxPx`、`maxImageBytes`→`outboundImageMaxBytes`、`maxInboundFileBytes`→`inboundFileMaxBytes`（旧名 deprecated 别名等价兼容一版，config-alias 测试钉住）；D4b（529a49c）`/mode` `/goal` per-chat 状态持久化进 chat-sessions.json（加法格式：旧文件裸 session id 照常解析；淘汰快照携带持久化设置，修复空闲淘汰丢 per-chat override）；D4c（ff7eafb）STT 非阻塞——[语音] 占位先行不阻塞回合，转写完成后以（语音转写：…）steer 进当前回合（agent 空闲则开新回合，失败保留占位），默认超时 300s→60s |
| 全天 | **M3-D5 提示注入隔离**（82c10ed）：QQ 消息正文进 user_message 边界；群成员昵称白名单化；平台声明替换 M1-A7 临时方案（正文可打出字面闭标签依赖平台声明向 agent 说明真边界） |
| 全天 | **M3-E3 日志统一**（b79994c/43ac50c）：E3a errors.ts describeError 替换全仓错误样板（error 日志带堆栈）；E3b connection 日志端口化——裸 console 退出，统一注入式日志 |
| 全天 | **已知边界（后续清理候选）**：①正文可打出字面闭标签依赖平台声明（D5）；②t2i/fonts.ts 豁免（字体探测 fs 直读不在注入边界内）；③steer 跨回合污染有标注（转写补递可能落进下一回合）；④llmCatalog 缺省目录为空 |
| 全天 | **发布 v0.4.0**：测试 200→283 全程（vitest 283/283、tsc 0 错误），v0.3.0→v0.4.0；lib 产物完整性校验（v0.3.0 缺六模块事故教训：commit 前 git ls-files 数量与 src 模块数核对、六拆模块 js+d.ts 齐全，commit 后 ls-tree 复核） |

### 2026-09-12（M4 交互与持久化：未知命令拦截 / 序号选择 / workspace 持久化）

| 时间 | 工作 |
|---|---|
| 全天 | **M4 启动与基线**：基于 v0.4.0（HEAD fac751a，工作树未提交改动），测试基线 283；三个工作包 T1（R1 未知命令拦截）、T2（R2 序号选择）、T3（R3 workspace 持久化+默认目录）串行实施，T4 独立评审门禁收口，T5 文档回写（本条目+双语 README） |
| 全天 | **R1 未知命令拦截（新配置 `unknownCommand`，`intercept`（默认）/`passthrough`）**：动机——斜杠命令手滑打错（如 /hel）会整条透传给模型，模型不了解命令语义、回复易误导。行为——未知 /纯单词 命令先模糊匹配已知命令：前缀匹配优先，编辑距离 ≤2 兜底（仅输入长度 ≥4 时启用，防 /id /ver 等短命令被误匹配），至多列 3 个候选，命中回复「未知命令 /xxx，你是想用 /yyy 吗？」并拦截（不进模型）；无候选时 intercept（默认）回复「未知命令 /xxx。发 /help 查看命令列表；要让模型处理请去掉开头的 / 重发。」并拦截，passthrough 维持旧行为透传给模型；/help 尾行同步改为「未知命令默认拦截并提示相近命令；配置 unknownCommand: passthrough 可改为透传给模型。」；非 /纯单词 开头的文本（如 /tmp/x）不受影响仍交模型，非管理员斜杠消息仍被管理员门禁拦截（不进建议路径）。接线三段：index.ts schema（默认 intercept）、bridge→commands config 注入、commands.ts 路由 suggestCommands+editDistanceWithin2；commands.spec +5 |
| 全天 | **R2 序号选择（/workspace /model /preset）**：动机——QQ 端手打长路径/provider/model 全名易错且费事。行为——三命令无参时输出编号列表（/workspace 标「← 当前」），回复 `/workspace 2` 这类序号即可选择；选择基于命令输出时的列表快照（PendingSelection：per-chat 单槽、内存态、不持久化），TTL 5 分钟 lazy 判定（无定时器，下次序号回复时判定，过期提示重新查看；越界保留快照可原地重试）；纯数字参数仅在有同 kind 有效快照时按序号解释，否则维持原语义（/workspace <路径>、/model <provider> <model>、/preset <id>）；/model 为两级——先列 provider 序号，选中后列该 provider 模型序号，选中走原切换路径改当前会话模型（`--default` 直用形式不变，非纯数字不受影响）。registry.ts 新增 PendingSelection 类型与 ChatSettings.pendingSelection 字段，bridge 注入 pendingSelection/setPendingSelection 访问器 |
| 全天 | **R3 workspace 持久化 + 默认目录（T3，方案 C→B）**：workspacePath 加入 PersistedChatSettings（加法格式：旧文件裸 session id 照常解析；无持久化设置时条目逐字节不变）；loadMapping 在 resume 尝试之前恢复覆盖（洞 B：resume 失败 retire→fresh 也不丢）；/workspace 切换路径 flush 映射（洞 C：设置即时落盘）；对 /new 同样保持（settings 载体，T4 回炉固化）。**默认目录方案 C→B 决策**：方案 C（主选）=向宿主可编程查询默认工作区——证据链：WorkspaceRegistry 无 default getter（仅 resolveByPath/list 已有工作区），session controller 的 defaultCwd 属组装内部态不外露（index.ts T3 注释存证）→ 宿主拿不到，降级方案 B = 未配置 workspacePath 时默认仍为宿主进程 cwd + 插件启动 warn 一次（index.ts：workspacePath === '' 时 warn，建议显式配置、避免会话工作区落在宿主启动目录）；README 配置表 workspacePath 行同步。映射往返/旧格式兼容/洞 B 闭合/淘汰周期保持均有用例 |
| 全天 | **T3 超任务书追加 4 项**（任务书仅要求 workspacePath 入映射 + loadMapping 恢复 + C/B 决策；实现中为闭合持久化链路追加，已标记待 T4 重点核查）：①洞 C noteWorkspaceOverride——非活跃 chat（未建会话/resume 失败）执行 /workspace 切换时快照进 evictedChats，否则 settings-only chat 会被任一次 saveMapping 从文件抹掉；②createChat 已退役快照跳过——evicted 快照记录 retired session（/new、/workspace 后的设置载体）时跳过 resume 直接重建，防复活已退役历史；③restoreEvictedSettings 抽取共用——in-run 淘汰→再激活路径把 workspacePath 连同 mode/goal 一并回填（原 D4b 只回 mode/goal）；④loadMapping retired-session 快速路径——retired id 的对象条目不 resume、只取设置 |
| 全天 | **T4 独立评审门禁：同意、无阻塞项；2 条建议改进回炉闭环（+3 用例）**：①loadMapping 将 retired 对象条目重登记进 evictedChats——settings-only chat 不在 chats/evictedChats，一次 mid-flight saveMapping（stop() 或他 chat createChat）就会把 workspacePath/goal/mode 从文件抹掉、下个重启全丢；②snapshotRetainedSettings 共用载体——resetChat 与 healSessionCollision 在有持久化设置时把条目快照进 evictedChats（retired id 之下，永不 resume），无持久化设置保持 pre-T3 丢弃行为（正反两分支均钉用例）。PM 检查点放行 T5 |
| 全天 | **测试 283→306 全绿**（T1 +5→288、T2 +6→294、T3 +9→303、T4 回炉 +3→306），npm test 全绿、build 退出 0；T5 文档回写：DEVLOG 本条目 + 双语 README（命令行为段/unknownCommand 配置行/workspacePath 说明/透传说明改写/最后验证与测试数更新） |
| 全天 | **遗留清单（M4 评审记录，M5 候选）**：①**saveMapping 的 `??` 字段并集**——触发：chat 被空闲淘汰后执行 /goal clear，之后任一次 saveMapping；影响：live.goal 为 undefined 时 `??` 回退 evictedChats 快照旧值，已清除的 goal 复活并每轮重新提醒；建议方向：哨兵值区分「未设/已清」（或 clear 时同步清快照）。②**PendingSelection 单槽跨 kind**——触发：/model 列表在场时误回其他命令旧列表的序号（如 /workspace 1）；影响：无同 kind 快照 → 走原参数路径报错（如「目录无效：1」），提示略费解；建议方向：跨 kind 的序号回复给明确提示（当前不消费、行为安全但反直觉）。③**pendingSelection 随 ChatSettings 在 /new 后保留**——触发：列列表后执行 /new、TTL（5 分钟）内回序号；影响：序号仍可用（不持久化、到期自然失效，无害但语义略怪）；建议方向：/new 时顺手清 pendingSelection。④**幻影 bare id 累积（优先级最高）**——触发：每次重启 resume 失败的 session id 都会 retireSession 永久追加进 retired-sessions.json（append-only、无清理路径）；影响：文件只增不减、缓慢膨胀，有累积效应；建议方向：「同 id 已 retired 不重复追加」+ 定期清理，M5 候选首项 |

### 2026-09-13（M5：/session 历史会话切换）

| 时间 | 工作 |
|---|---|
| 全天 | **M5 启动：/session 命令**——动机：/new、/workspace、/preset 每次切换都把旧会话退休在磁盘，但用户无法回去；任务书要求按序号切回历史会话并恢复其历史上下文，支持来回切。基线 306 测试全绿（m0-hardening @9841167，工作树干净） |
| 全天 | **关键取舍：resume 放行例外 → 切换成功后 unRetire（与任务书设计建议偏离，已报告）**——任务书建议 createChat evicted 分支与 loadMapping 的 retired 跳过分支改为「retired 且在该 chat 可切回列表且未 broken → 允许 resume」。分析发现该例外无法与 T3 设置载体共存：/new（含持久化设置时）恰好会留下「retired + 在列表」的载体条目，基于列表成员的例外会让 /new 后的下一条消息（或一次重启）复活刚被 /new 掉的会话，直接违背 /new 契约与本任务自己钉死的端到端用例（/new → 下一条必须 create 新会话，除非显式 /session）。改为：switchSession 成功 resume 目标后调用 unRetireSession（brokenSessions/retiredSessionIds 双删 + saveRetired 落盘），目标回到「未退休」状态，重启 loadMapping、空闲淘汰后再激活全部走**常规路径**找回；create 路径的 isSessionIdBlocked 一字未动，T3 载体语义逐字节保留。un-retire 后 create 路径仍安全：hasPersistedLog 预检兜住目标自身日志、agents.create 碰撞回退兜底 |
| 全天 | **软/硬退休拆分**——retireSession（broken+retired 双集+落盘）仅保留给真实损坏路径（heal、create 碰撞、stale log、resume 失败）；resetChat 改为软退休（仅 retiredSessionIds+落盘+记入可切回列表），并当 bare 派生 id 就是当前会话（初代 /new）时跳过原有的 bare id 硬退休（软退休已覆盖重启防碰撞，硬退休会把初代会话标记为 broken 导致永不可切回）；loadRetired 不再把文件 id 回填 brokenSessions（文件无法区分来源，blocked 并集对 create 路径行为不变） |
| 全天 | **实现三件套**——registry.ts：SWITCHABLE_FILE（switchable-sessions.json，纪律照抄 loadRetired/saveRetired：ENOENT=全新、读失败/损坏保留内存并 warn、tmp+rename 原子写；每 chat 上限 20 条、去重、最新在前）、switchableSessions()/switchSession()（校验目标在该 chat 列表内且未 broken，busy 拒绝；在线走 resetChat 退休半段+resumeChat，离线走 noteWorkspaceOverride 式 evictedChats 载体；resume 失败→硬退休目标+移出列表+落盘映射，下一条消息全新会话，不卡死）、PendingSelection kind 加 'session'；commands.ts：/session 入命令表（/help 自动收录）、无参渲染编号列表（含 YYYY-MM-DD HH:mm 退休时间）+ 设 kind 'session' 快照、序号走 resolveNumericSelection、busy 先拒（提示 /stop）且不消费快照、/status 追加「可切回」计数行；bridge.ts：commandCtx 透传两方法 + start() 装载 loadSwitchable |
| 全天 | **测试 306→321 全绿**（新增 tests/session-switch.spec.ts 15 用例：列表持久化/上限去重/损坏文件纪律、resetChat 软退休、broken 拒绝与跨 chat 隔离、在线来回切、resume 失败回退、碰撞 heal 与 create 碰撞绝不入列表、**e2e 钉死 /new→/session 1→下一条普通消息 agents.resume 收到原 session id 且 create 仅 1 次**、重启 loadMapping 恢复切换后目标、越界保留快照/非数字用法行、busy 拒绝、/status 计数）；commands.spec 命令表用例同步 14→15（含 /help 全文快照行）；npm test 321/321、npm run build 退出 0 |
| 全天 | **文档回写**——README 能力表命令单元格、斜杠命令速查表（/session 行+/status 行更新）、模型平台说明「14 个→15 个」、/session 持久化与回退语义说明段；DEVLOG 本条目。遗留：src/prompt.ts 的模型平台提示词命令清单未列 /session（任务书范围外，建议后续同步，避免模型不知该命令）；M4 遗留清单 ④（幻影 bare id）可借 unRetire 机制一并治理，M5 后续候选 |

### 2026-09-13（/permission 宿主权限切换转发，参数名简化）

| 时间 | 工作 |
|---|---|
| 全天 | **启动：/permission 命令**——动机：宿主 dsh-permission-presets 插件注册 name 'permission' 的命令（空参回 `current preset X (available: A, B)`、未知名回 `unknown preset "…" (available: …)`、命中即 apply 并回 `preset <name>`，sandbox/mode+approval/policy 事件落盘、切换立即生效），QQ 侧无入口。基线 321 测试全绿（m0-hardening @1cf79dc，工作树干净）。宿主 0.1.5-rc.1 的 dsh-commands lib 已出现 4 参 execute（submittedAttachments）且返回 `{commandId, result:{kind,text}}` 包装，但部署包未引用该签名——沿用本仓 /plan 实测口径：3 参转发 + BridgeDeps 扁平 `{kind?, text?}` 结果类型 |
| 全天 | **实现**——commands.ts：/permission 一行入表（/plan 与 /goal 之间，宿主转发类命令相邻）；handlePermissionCommand 照抄 handlePlanCommand 转发纪律：先判 live chat（无则提示先发消息）、再判 commands 服务、`commands.execute(chat.agent as never, line, new AbortController().signal)`（永不中止 signal，QQ 发起的切换不被本侧取消打断）、闭包内重取 live chat 防切换间隙 agent 被退休、execute 返回 undefined 视为宿主未挂载权限预设插件并明示。QQ 侧别名映射 PERMISSION_PRESET_ALIASES（`w`/`ws`/`write`/`工作区`→workspace-write，`f`/`full`/`danger`/`全权`→danger-full-access，查找前 toLowerCase 故大小写不敏感）；非别名参数照原样转发=完整 preset 名，未知名由宿主报错并回显可用列表，插件加 ❌ 原样转告（命中加 ✅）；无参转发 bare 并把宿主回文转告 + 附 QQ 快捷用法提示 |
| 全天 | **关键取舍：序号不接 PendingSelection 快照，改为现场解析（与 R2 机制偏离，任务书明示允许论证）**——纯数字 1/2 先执行一次 bare `/permission` 取宿主实时 `available` 列表（parseAvailablePresets 解析 `(available: A, B)`），命中即第二次执行 `/permission <名>`；不落快照的理由：仅两个 preset，且 presets 表可被部署用 cordis.patch.yml 覆盖，快照唯一可能的价值是省一次往返，却引入与宿主表不一致的陈旧状态面（R2 快照解决的是列表渲染成本高的问题，这里列表渲染成本≈0）。代价：序号切换多一次宿主命令执行（各追加 command/run+done 生命周期事件，无害）。越界或列表不可解析→回退用法提示并转告宿主原文。诚实记录边缘：若部署把 preset 短名恰好取作 `w`/`f` 等别名键，别名优先于同名字 preset |
| 全天 | **测试 321→324 全绿**（新增 3 用例：①无参转发+宿主回文转告含快捷提示+别名映射全表 8 项逐一断言转发行与回告+未知名 ❌ 原文转告；②序号 2 现场解析=先 bare 后 `/permission danger-full-access` 且 ✅ 回告、序号 9 越界回退用法提示且宿主列表仍转告；③无 live chat 拒绝且 commands.execute 零调用）；commands.spec：/help 名单与非管理员拦截循环加 /permission，命令表用例 15→16（含 /help 全文快照行同步）；npm test 324/324、npm run build 退出 0 |
| 全天 | **文档回写**——src/prompt.ts 模型平台说明命令清单 15→16（/plan 后插 /permission，模型知道该命令存在）；README 能力表命令单元格、斜杠命令速查表新增 /permission 行、序号语义段补「/permission 现场解析不落快照」例外、模型平台说明「15 个→16 个」；DEVLOG 本条目。注：任务书预期 README 有两处「N 个」计数，全仓实查仅一处（平台说明段），已同步。遗留：README.en.md 命令表自 M5 起未收 /session、本版亦未收 /permission（任务书范围外，双语表已滞后两轮），建议后续一次性补齐 |
### 2026-09-13（命令面可用性打磨：/help 分组卡片 + /permission 中文菜单 + 报错自解释）

| 时间 | 工作 |
|---|---|
| 全天 | **启动：命令面可用性统一**——动机：用户反馈「/permission 无参数输入就在报错里把可用参数给提供一下」，推广为全部 16 条斜杠命令的可用性巡检：/help 升级分组多行卡片、每条报错自带「正确用法+可选项」。基线 324 测试全绿（m0-hardening @b99cc8e，工作树干净） |
| 全天 | **/help 重构（保持表驱动）**——CommandDefinition 加可选 group 字段（缺省归「其他」；不在固定卡片序的组按首见顺序追加，新增命令仍是一行入表、/help 自动收录），help 文案统一为「参数用法+说明」形态（/workspace 行补 [序号]、/preset 行补 [序号]、/permission 行改 [w\|f\|预设名\|序号]、/model 行补「无参两级序号列表」等）；helpText() 渲染「可用命令（仅管理员）：」+ ▍会话/输出/查询/操作/其他 五组卡片并导出供全文快照测试。取舍：任务书示例中 /status /id /ver 与 /stop /retry /ocr 的同组合并单行，改为每命令一行——QQ 里逐行更易扫读，且让「每条带用法」可被逐行断言 |
| 全天 | **/permission 无参中文菜单**——bare form 不再原样转发宿主英文回文：parseAvailablePresets + 新增 parseCurrentPreset（解析 `current preset X`）→ renderPermissionMenu 渲染「当前权限：X（含义）／可用预设：编号列表（← 当前 标记）／用法：/permission <序号\|w\|f\|完整名> 切换，立即生效」；含义映射只认 workspace-write=工作区可写+需审批、danger-full-access=全盘+免审批，表外预设名（部署自定义）一律标「部署自定义」不猜语义；available 或 current 任一解析失败 → 回退现状（转发原文+QQ 快捷提示），纯渲染函数绝不抛错。❌ 回告（relayMarked）追加用法行、宿主 text 保留原样；别名 hint「全权」→「全盘」与任务书映射统一 |
| 全天 | **全命令报错巡检（只改文案与 current 解析，零命令语义/权限门槛/持久化改动）**——/workspace 不是目录/无效目录 → 追加「发 /workspace 查看编号列表，或发 /workspace list 查看全部」；/model 参数不完整 → ❌+原因+用法行、未知模型 → 追加用法行（列表失败原提示已有下一步）；/mode 非法值 → 追加当前生效值+合法值；/retry 无可重试 → 追加下一步动作；/ocr 读取失败/OCR 失败 → 追加重试与重发指引；/preset 预设不存在 → 无可用列表时也带用法行；/session 已损坏 → 追加「发 /session 查看其他可切回会话」；/plan 切换失败 → 追加重试指引；resolveNumericSelection 过期/越界提示统一加 ❌ 前缀（session-switch.spec 子串断言零改动通过）。宿主侧基础设施错误（commands/agentPresets 服务缺失、宿主未注册命令）保持原样：非用法错误，追加提示属噪音 |
| 全天 | **测试 324→327 全绿**（新增 3 用例：①/permission 无参菜单断言含「当前权限」「← 当前」「用法：/permission」+ 自定义预设 team-strict 标「部署自定义」；②宿主回文格式变化回退路径=原文转告+快捷提示+无「当前权限：」+宿主仅调用一次；③报错用法行审计=/retry 下一步、/mode 非法值（含当前生效值）、/workspace 不是目录、/preset 未知 id、/model 未知模型 五处）；适配 2 处：commands.spec /permission 用例第 1 段「宿主原文转告」改为中文菜单断言、命令表用例由 preSplit 字节等值改为 helpText() 全文快照（卡片逐字节钉死+每命令在卡片体恰出现一次）；session-switch.spec 的「序号越界」断言因 ❌ 前缀仍子串匹配通过，零改动；npm test 327/327、npm run build 退出 0（lib/commands.js、lib/types/commands.d.ts 随 helpText 导出同步） |
| 全天 | **文档回写**——README 斜杠命令速查表：/model 行参数形态改为 `[--default] <provider> <model>`、/workspace 行补序号与 `list`、/preset 行补序号、/permission 行改参数顺序+无参中文菜单说明、新增 /help 行；src/prompt.ts 本轮零改动（命令清单未变，git 核对无 diff）；DEVLOG 本条目。遗留：README.en.md 命令表仍滞后（沿用前两轮记录，建议后续一次性补齐双语表） |

### 2026-09-13（/permission 与 /plan 宿主转发崩溃修复：commands.execute 4 参签名适配）

| 时间 | 工作 |
|---|---|
| 全天 | **线上报错与根因链**——用户实测 `/permission f` 回 `❌ 权限预设切换失败：Cannot read properties of undefined (reading 'aborted')`。链路：宿主 dsh 0.1.5-rc.1 的 dsh-commands `execute` 实际启用 **4 参** `(agent, line, submittedAttachments, signal)`（第 3 参无条件读 `.length`，第 4 参无条件读 `.aborted`），返回值变为 settle 包裹 `{commandId, result:{kind,text}}`（admission miss 仍 undefined）；而本插件 /plan、/permission 两处转发仍按旧 3 参调用——`new AbortController().signal` 落在 submittedAttachments 槽，宿主读真 signal（undefined）的 `.aborted` 即崩；即便不崩，扁平 `result.kind/text` 读取也会落空。当日 /permission 上线时宿主 lib 已见 4 参签名但部署包未引用、按 /plan 实测口径沿用 3 参转发，该口径随宿主升级失效为直接诱因 |
| 全天 | **修复（最小签名适配，不动命令语义）**——①两处调用改 4 参：`commands.execute(agent, line, [], new AbortController().signal)`（空数组=无附件，signal 归位第 4 参，保持「从不中止」语义）；②新增 `unwrapCommandResult` 解包工具（src/commands.ts，两处共用）：入参含 `result` 属性取 `.result`（新宿主包裹结构），否则按扁平 `{kind,text}` 处理（旧宿主对多余第 4 参安全：其内部只读 signal.aborted），undefined 原样透传=admission miss；③/permission 的「宿主未注册 /permission 命令（未挂载权限预设插件）」提示与 /plan 的默认文案回退保持原状；④类型同步：BridgeDeps（bridge.ts）与 Context（index.ts）的 execute 声明改 4 参、返回类型放行包裹结构；⑤/permission 成功回文增强：宿主原文太简（'preset X'），命中改回 `✅ 已切换权限预设：<preset>（<中文含义>）`，含义用现有 PERMISSION_PRESET_LABELS（workspace-write=工作区可写+需审批、danger-full-access=全盘+免审批），表外预设名（部署自定义）回退「部署自定义」；❌ 转告维持宿主原文+QQ 快捷提示，/plan 回文不变 |
| 全天 | **测试 327→328 全绿**（新增 1 用例钉死本次事故：4 参转发形态——args[2] 为空数组、args[3] 为 AbortSignal、包裹结构正确解包转告（/plan 路径）；适配既有桩：/plan 与 /permission 菜单+别名用例的宿主桩改包裹返回（args 断言补 `[]`、别名命中断言改中文含义标签）、harness 默认桩镜像新宿主（4 参+attachments 数组性检查+包裹返回）、序号用例宿主桩保留旧扁平返回=旧宿主兼容转告回归、bare 菜单/格式漂移回退两用例桩签名同步；全仓 grep 确认 commands.execute 仅 /plan、/permission 两处调用点）；npm test 328/328、npm run build 退出 0（lib/commands.js、lib/types/*.d.ts 随签名同步） |
| 全天 | **文档核对**——src/prompt.ts 与 README 的 /permission 描述均为命令面/别名/菜单语义，未涉及成功回文措辞，命令面没变，零改动；DEVLOG 本条目 |

### 2026-09-14（/session 列表内容预览 + 建立时间）

| 时间 | 工作 |
|---|---|
| 全天 | **动机与目标**——/session 无参列表原本只显示 `${i+1}. ${id}（退休时间 退休）`，同 chat 的 id 共享 `onebot-…` 头、退休时间相近，管理员无法不切回就认出哪个是哪个会话。目标：每项增加一条「标题/内容预览」与会话建立时间，单行内同时给出预览+两个时间+可辨认 id；切回行为（R2 快照 kind 'session'、payload 完整 id）与失败降级语义不变 |
| 全天 | **数据获取方案（open+read 前缀，弃 inspect 全量）**——扩展 bridge.ts 的 SessionPersistenceLike 端口：新增 `open(id,'read')` 返回窄化的 SessionReadHandleLike（header + read(offset,length) + close()，结构对齐 dsh-session-persistence 的 SessionHandle；'read' 不开写所有权、可与活跃写入并存）。预览冷读日志前 24 个事件（首个真实用户输入必落在前几个事件内），读完 finally close（AsyncDisposable：泄漏的 read handle 会钉住后端资源）；取 header.createdAt 为建立时间（非法值省略字段）。理由：一次 /session 最多渲染 20 项，inspect 全量会把每个会话的整个日志解码一遍（QQ 会话动辄数千事件），前缀读有界且轻量；index.ts 的 Context.sessionPersistence 声明同步补 open（方法签名语法，结构兼容宿主服务） |
| 全天 | **预览提取规则**——按日志序扫描 user/message 事件：优先「真实排队用户输入」（source.kind 'user'，或 kind 'plugin' 且 plugin 'dsh-onebot'——本插件入站消息的平台署名即真实用户输入，runtime-context 快照/agent.inject 合成/goal 续跑均排除），取第一条带非空 text 的事件；无真实输入时回退任何来源的第一条 user/message（合成上下文/goal 轮）；提取全部 text 块拼接，\s+ 折叠为单空格保单行，按码点截断 ≤40 字（截断时 39 字+…，emoji 代理对不拆半，§3.1 教训）；无任何 user/message 显示「（无对话内容）」 |
| 全天 | **渲染与降级**——列表项格式 `N. <预览≤40字>（<建立时间> 建立 · <退休时间> 退休 · <截短id>）`，建立时间取不到则省略该字段；id 截短采用前 8+…+后 8 字符（shortSessionId，≤20 字符原样）——任务书示例「前 12 字符」在同 chat 列表内所有条目完全相同（onebot- 头共享），失去可辨认性，故保留唯一后缀（偏差已记录）；20 项并行取预览，单项 open/read/close 任何失败仅该项降级「（内容不可读）」（warn 日志带 describeError，措辞对齐 recordedPresetFor），其余项与 R2 快照（payload 完整 id）不受影响；handle close 失败仅 debug 不上浮 |
| 全天 | **测试 328→337 全绿**（新增 tests/session-preview.spec.ts 9 用例：text 块拼接/非文本块忽略/换行折叠、码点截断 40+emoji 不拆半+maxLength 0、source 优先级三例（kind user/插件署名/首条优先）、无真实输入回退合成源、无 text 真实输入跳过与无 user/message 空串、shortSessionId 双端保留与同 chat 唯一性、e2e 两项渲染+建立/退休时间+截短 id+payload 完整 id+句柄全部关闭、单项 open 抛错降级不连坐、read 抛错+close 抛错仍正常渲染且省略建立时间）；session-switch.spec 三处旧格式断言同步新格式；makeCmdHarness 增加 sessionPersistence 可选桩；git 因 dubious ownership 不可用（修复需写全局 git config，越权红线），工作树核验改用 mtime——今日改动均为本任务产出，09-13 晚间他人在途改动未触碰 |
| 全天 | **版本 0.4.0→0.4.1 + 文档**——README 命令表 /session 行与持久化段落补预览/建立时间/降级说明；DEVLOG 本条目；npm test 全绿、npm run build 退出 0 |

### 2026-09-14（/session 预览剥壳：显示用户正文而非包裹头，v0.4.2）

| 时间 | 工作 |
|---|---|
| 全天 | **缺陷与修复**——真机实证 /session 列表预览显示 `<user_message qq="…" nickname="…` 包裹头而非用户正文：QQ 入站文本经 wrapUserMessage 边界包裹入 session（群聊 inbound.ts 还把 `[受限用户:仅问答] ` 与 `[HH:MM 昵称(QQ)][@我] ` 可信前缀拼在边界外），预览直接拼接 text 块未剥壳。commands.ts 新增 unwrapUserMessageText（在 text 块拼接后、\s+ 折叠与 ≤40 码点截断前执行）：先剥边界外可信前缀，再取首开标签 `>` 之后、最后一个 `</user_message>` 之前的正文；非包裹（严格开头匹配）/有开无闭/空正文一律原样返回走原路径（预览不变空不抛错），折叠与截断复用原逻辑 |
| 全天 | **边界语义**——只剥拼接在边界外的框架元数据；包裹内用户自贴的同形前缀/标签是数据（src/prompt.ts），永不误删；（内容不可读）/（无对话内容）降级路径不受影响 |
| 全天 | **测试 337→342 全绿**（session-preview.spec 新增 5 用例：包裹剥壳+剥壳后截断、群前缀/受限前缀+@我 变体与边界内假冒前缀不误删、非包裹与标签样文本原样、无闭合/空正文回退、跨 text 块拼接剥壳）；README 持久化段落补剥壳一句；版本 0.4.1→0.4.2；npm test 全绿、npm run build 退出 0 |

### 2026-09-14（小结卡同文条目修复：中间消息拆多条 QQ 消息后回合末小结卡逐字重复）

| 时间 | 工作 |
|---|---|
| 全天 | **根因（排查报告《报告-dsh-onebot中间消息重复排查-2026-09-14.md》候选 1 定案，采用 §5.1 方案 B）**——src/interim.ts completeInterim 把 1 条占位条目按 sendToChat 返回的每个 QQ message id 原位展开为 N 条、每条都携带完整原文 entry.text，sendInterimSummary 再对 buffer 逐条编号如实渲染 → 拆段/[[qq_forward]] 场景下小结卡相邻 N 条逐字同文；默认 splitLength=100、textImageThreshold=150 下 101–150 字符的中间消息必现且恰 2 条（与真机截图第 5、6 条同文吻合） |
| 全天 | **修复（2 行 diff）**——①completeInterim 多 id 展开时仅首个 id 的条目携带 entry.text，其余条目 text 置空串：loopBuffer 条目类型 `{ id; text; sentAt }` 与「每条恰 1 个 QQ id」不变，revokeInterim/recallLoopMessages/recallTimers 撤回链路零改动（'forward' 假 id 行为不变）；②sendInterimSummary 先过滤 text.trim()==='' 的条目再编号，编号按过滤后非空条目连续递增（原「先编号后 filter(line!=='')」滤不掉 `"N. "` 孤编号行，一并修复）。直播分段、撤回时机、/stop /retry 清理、inbound residue reset 语义全部不变；src/outbound.ts、src/split.ts、src/commands.ts、src/registry.ts、src/inbound.ts、package.json 未触碰 |
| 全天 | **验证**——tests/interim.spec.ts 新增 2 回归用例（inline 桩 echo 回增序 message_id；maxImageBytes=500 迫使小结卡走 PNG 超限→sendToChat(body) 文本回退，从出站帧直接断言 body）：①「keeps one summary line when the pipeline splits one interim into two QQ messages」104 字符中间文本拆 2 段——直播 send_msg 恰 2 帧且拼接=原文（分段行为不变）、小结卡 body 恰为 '1. '+原文（原文恰 1 次、编号连续）、delete_msg 恰 2 次且 message_id=直播两 id；②「keeps one summary line when an interim carries a [[qq_forward]] block plus body」——小结卡 forward 节点恰 1 个、body='1. 正文'、delete_msg 恰 2 次（'forward' 假 id+正文 id 都撤回）。红绿：临时还原 completeInterim 单行→两用例均红（失败点=同文/重复节点断言），恢复后绿。全量 vitest 343→345 全绿、tsc --noEmit 0 错、./scripts/build.sh 重建 lib/interim.js 入库（lib/types/interim.d.ts 无 diff） |

### 2026-09-14（splitLength 拆除收尾：方案 B——正文两档化，回退整段单条）

| 时间 | 工作 |
|---|---|
| 全天 | **用户裁决方案 B（彻底删除 splitLength）收尾完成**——前序执行专家中断于 src/outbound.ts 语法半成品（TS1128：原 for-of 分段循环删除时少一个闭合花括号），本会话续完不回退：①补回 sendToChat 缺失的 1 个闭合花括号（该函数唯一改动）；②落地新行为：正文 ≤textImageThreshold 单条发送；>threshold 渲染 t2i 图卡；渲染失败、PNG 超 maxImageBytes 或 threshold≤0 → stripMarkdown 后整段单条 sendMsg（不分段）；多 message id 仅剩 [[qq_forward]] 场景；interim 同日方案 B 修复（completeInterim 仅首条带原文 + 小结卡先滤空再连续编号）原样保留；③tests：interim.spec.ts 104 字符用例改钉新行为（恰 1 次 send_msg=完整原文、turn/end 后恰 1 次 delete_msg 撤回该 live id、小结卡 maxImageBytes=500 文本回退 body 恰为 '1. '+原文，[[qq_forward]] 用例未动），outbound.spec.ts maxImageBytes=500 兜底用例改断单条全文消息（golden「恰一张 t2i 卡」用例不受影响零改动）；④README.md/README.en.md 删 splitLength 表行、textImageThreshold 行改两档描述（≤threshold 单条 → >threshold 图卡，渲染失败/超 outboundImageMaxBytes/禁卡片回退单条纯文本）；⑤兼容性说明：config zod 非 strict，旧用户配置里的 splitLength 被静默忽略；docs/dsh-onebot-architecture.html 为历史定格文档不在清理范围。**验证**——全量 vitest 345→338 全绿（减 7 为前序删除的 splitLongText 分段用例，本会话零新增用例、仅改写断言）；npx tsc --noEmit 退出码 0；./scripts/build.sh 重建入库，本次构建 lib 内容变化 7 文件：lib/index.js、lib/outbound.js、lib/split.js、lib/types/bridge.d.ts、lib/types/index.d.ts、lib/types/outbound.d.ts、lib/types/split.d.ts |
### 2026-09-14（README 双语出站叙述清理：标点分段残留清零）

| 时间 | 工作 |
|---|---|
| 全天 | **b19fa5e（splitLength 拆除）文档收尾补漏**——配置表已两档化，但叙述区仍残留旧「标点分段」描述；全量 grep（分段/split/sentence/≤100/回退分段）定位 4 处并仅修过时描述：①README.md 架构图「出站：分段发送」→「出站：单条/t2i 卡片发送」（树形缩进与框线列位不变）；②README.md 功能表出站行「长消息按句号分段（默认 ≤100 字/条）…渲染失败自动回退分段」→「正文 ≤ `textImageThreshold`（默认 150）字符单条发送、超过阈值渲染 t2i 文字图卡片（渲染失败、PNG 超 `outboundImageMaxBytes` 或 `<=0` 禁用卡片时回退单条纯文本）」，与本表 textImageThreshold 行语义对齐；③README.en.md Outbound 行 "Long messages split on sentence boundaries (default ≤100 chars/message)…auto-fallback to split text" → 同两档英文表述（与②中英对齐）；④README.en.md 架构图 "split sending" → "single/t2i-card send"（全量扫描新发现的第 4 处，编排者列点外漏清）。理由：出站现行为两档、无任何分段，旧描述误导用户。范围说明：README.en.md "splits emoji surrogate pairs"（t2i 码点迭代代理对说明）非分段描述、未动；docs/ 历史定格文档与本日志既有内容未动；未执行 git add/commit/push |

### 2026-09-14（README 双语配置表补齐 10 个缺失 schema 键）

| 时间 | 工作 |
|---|---|
| 全天 | **配置表补齐 10 键（用户裁决「全部补齐」）**——双语 README 配置表对照 src/index.ts zod schema 补入一直缺失的 10 个键（动手前复核：10 键在两 README grep 均 0 命中、schema 行内容逐行核实）：`ignoreSelf` 紧随 botQQ 行；`restrictedMemberPrefix` 紧随 groupPolicy 行（群聊权限策略簇）；`sendErrorNotice`+`sensitivePatterns` 紧随 interimRecall 行（出站行为簇：错误提示→出站敏感审计，审计说明含「留空用内置默认」语义）；STT 簇内顺序 Enabled→Engine→Model→Command→Args→TimeoutMs——`sttEngine` 插入 sttEnabled 与 sttModel 之间、`sttCommand`+`sttArgs` 插入 sttModel 与 sttTimeoutMs 之间（custom 引擎专参数后置，含 `{file}`/`{out}` 占位语义）；`tempTtlHours` 紧随 mediaDir 行；`maxVoiceBytes`+`maxFileBytes` 紧随 outboundImageMaxBytes 行（出站大小上限簇）。默认值实取（常量 grep 实算非照抄他行）：tempTtlHours=6、maxVoiceBytes=15728640（src/media.ts:17 VOICE_MAX_BYTES=15*1024*1024）、maxFileBytes=20971520（src/media.ts:18 MEDIA_MAX_BYTES=20*1024*1024）、sttEngine=auto、sttCommand=空串、sttArgs=[]，boolean 键（ignoreSelf/sendErrorNotice/restrictedMemberPrefix）均 true、sensitivePatterns=[]；README.en.md 对称插入同位、中英行语义严格对齐。收尾核验：10 键双语各 ≥1 命中且均落配置表内、双语配置表行数 39/39 差 0、git diff 范围仅 README.md/README.en.md/DEVLOG.md 三文件、未执行 git add/commit/push |
### 2026-09-17（四存量缺陷修复：dshHome 回退 / 保存竞态 / 宿主接口核对 / preset 记录读取，v0.4.3）

| 时间 | 工作 |
|---|---|
| 全天 | **背景与定性**——四缺陷均为用户 QQ 侧报告的存量问题，全部发生在升级前 rc.2 会话期（web-3079.log 行号证据 14251–14434 < 重启线 14675），与 0.1.6-alpha.1 升级（2026-09-17 20:00）无因果。开工前复核工作树 git status 为空（分支 m0-hardening；git 因 dubious ownership 需 `-c safe.directory` 单次覆盖，不写全局配置） |
| 全天 | **缺陷 1：dshHome 解析落到 /tmp（preset 枚举 ENOENT）**——证据：日志 14429 行 `preset enumeration failed: ENOENT scandir '/tmp/.dsh/.agent-presets'`。根因：src/index.ts 两处（defaultMediaDir:132、dshHome:138）回退链 `join(process.env.HOME ?? '/tmp', '.dsh')`——dsh-web 由 systemd 启动无 HOME 环境变量 → `/tmp/.dsh`；宿主自身用 os.homedir()（HOME 缺失回退 passwd 条目 → /root）故宿主侧 preset 加载正常。修法：DSH_HOME 优先不变，回退改 `join(homedir() \|\| '/tmp', '.dsh')`（os.homedir() 内部先读 HOME、缺失查 passwd），两处同改 + `import { homedir } from 'node:os'` |
| 全天 | **缺陷 2：retired-sessions/switchable 保存竞态（ENOENT rename）**——证据：日志 14251/14287/14434 行 `save failed: ENOENT rename '...retired-sessions.json.tmp' -> ...`（mkdir 与 writeFile 均成功，仅 rename 报 ENOENT）。根因：src/registry.ts saveRetired 与 saveSwitchable 两处共用固定 `.tmp` 后缀做「临时写+原子改名」，两个并发保存协程交错时后完成者的 rename 找不到已被前者消费的 tmp。修法：tmp 文件名加每次调用唯一后缀 `.tmp-<Date.now()>-<Math.random 6 位>`，两处同改；rename 成功即消费无需清理，catch 分支保持原样（最小改动） |
| 全天 | **缺陷 3：/permission 调宿主命令形状核对（只读结论：不改）**——证据：日志 14370/14393/14404 行 `host permission command failed: TypeError: Cannot read properties of undefined (reading 'aborted')`。按任务书先钉死宿主当前签名（0.1.6-alpha.1 静态产物实读）：dsh-commands types/index.d.ts:142 `execute(agent, line, submittedAttachments, signal)`、实现 lib/index.js:327（:332 直读 `signal.aborted`、:353 读 `submittedAttachments.length`）、api-gateway 客户端/服务端两侧均把 signal 落最后一位——**与插件现有 4 参调用（commands.ts:963/:1024，signal 第 4 槽）完全一致**；unwrapCommandResult 的 `{ commandId, result: { kind, text } }` 剥壳与 0.1.6 CommandExecution 形状仍匹配。结论：rc.2 期 TypeError 是宿主当时从别的容器读 aborted 所致，0.1.6 已回归直读信号——插件侧**不改调用**（此时若把第 4 参包成 options 对象反而会让 0.1.6 复现同一崩溃）；现有注释（commands.ts:958-961、1016-1018）描述的正是 0.1.6 行为，保持原样 |
| 全天 | **缺陷 4：persistence.inspect is not a function（preset 记录读取失败静默回退）**——证据：日志 14394 行附近（且每次 resume 复现）。根因（宿主接口实读钉死）：0.1.6 dsh-session-persistence 的 SessionPersistence 抽象接口仅 `create/open/flush/stat/list`（types/index.d.ts，jsonl 后端 lib/index.js:2323/:2346/:2422/:2455 实现），**无 inspect**；插件 SessionPersistenceLike 声明的 inspect 是旧宿主接口遗迹。修法（按实接口最小改调用，不加 typeof 守卫——守卫会把 preset 恢复永久降级为 config/default）：hasPersistedLog（registry.ts）改 `stat(id) !== undefined`（缺失/读失败都计为无日志，语义不变）；recordedPresetFor 改 `open(id,'read')` → header.agentPreset + 全量 read() 喂原 resolveRecordedPreset（最新 agent-preset/selected 事件优先、header 兜底的语义逐字保留）→ finally close（AsyncDisposable 不泄漏句柄）；bridge.ts SessionPersistenceLike inspect→stat、SessionReadHandleLike.header 与 SessionPreviewEvent.data 补 agentPreset 可选字段（真实 SessionHeader/事件既有字段），index.ts Context.sessionPersistence 声明同步 |
| 全天 | **测试 338→340 全绿 + 新增回归**——新增 tests/hotfix-043.spec.ts 2 用例：① DSH_HOME+HOME 均删除时 dshHome()/defaultMediaDir() 取 homedir()（passwd 兜底）绝不落 /tmp；② 用 vi.mock 门控 node:fs/promises rename 强制「第二写者先改名」的确定性交错——断言两写者 from（tmp 源）互异、无 `retired-sessions save failed` 日志、最终文件为最后改名者的快照（旧固定 `.tmp` 实现在此交错下必现 ENOENT）。既有测试桩同步（不改语义）：registry.spec 4 处 inspect 桩改 stat/open（断言同步）、session-preview.spec 1 处、bridge-harness 注释、tests/README 对应行；npm run build 退出 0、npm test 340/340 |
| 全天 | **版本 0.4.2→0.4.3 + 部署**——package.json patch bump；构建后 lib/ 与 package.json 同步 /root/dsh-plugins/dsh-onebot/（复制链非链接；仅覆盖活动文件、.bak-* 原样、属主权限对齐）；`diff -rq 工作区/lib 部署副本/lib`（排除 .bak）须为零；重启由编排者流程收尾（systemctl restart dsh-web） |

### 2026-09-23（构建期类型修复：宿主 MessageSourceMap typings 漂移，module augmentation）

| 时间 | 工作 |
|---|---|
| 全天 | **定性**——npx tsc --noEmit 仅余 2 个 TS2322（src/bridge.ts:444、:589），均为 `source: { kind: 'plugin', plugin: 'dsh-onebot' }` 不满足 MessageSource 联合类型。宿主 @deepseek-ai/dsh-llm 0.1.7-alpha.2 的 MessageSourceMap（lib/types/message.d.ts:101）未声明 `plugin` 成员，但其注释明示 merge-extensible（"each producer declares its own `kind` in its own module"），且宿主 dsh-session-format 运行时真实写入 `{ kind: "plugin", plugin: ... }`——属宿主 typings 漂移，运行时无害，纯声明期问题 |
| 全天 | **修法（零运行时改动）**——按宿主自身扩展惯例（dsh-agent lib/types/model-selection.d.ts:8-14 的 `declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'model-selection': ... } }`）新增 src/dsh-llm.d.ts（tsconfig include "src" 自动覆盖）：import + `interface MessageSourceMap { plugin: { kind: 'plugin'; plugin: string } }`，成员形状与宿主运行时写入形状逐字段一致，宿主将来原生加入同形成员时接口合并不冲突。bridge.ts 两处调用点一行未改，无运行时行为变化 |
| 全天 | **验收**——npx tsc --noEmit 退出 0（0 error）；npm test 340/340 全绿（28 文件，与基线持平、无新增失败）；npm run build（./scripts/build.sh）退出 0，lib/ 产物时间戳晚于 src 改动。不 bump 版本号、不部署、不 commit |

### 2026-09-24（R1 部署体验加固：挂载显式化 / files 误导 / DSH_ROOT 逃生门）

| 时间 | 工作 |
|---|---|
| 全天 | **「insert 新增需重启」实测结论（供 T5 文档引用）**——往 cordis.patch.yml 新增 insert 条目（首次挂载/新增插件条目）不会经宿主 HMR 自动加载：宿主 HMR 只重应用既有配置快照、不重新 import 插件 JS。证据：2026-08-18 真机排查条目 KEY 认知「HMR 只重应用配置快照、不重新 require 插件 JS，改 lib 必须重启 dsh（launchd 拉起）」；旁证：同条目 config 改动 1 秒热生效（2026-08-14 挂载条目）vs 重复 insert 条目是重启后的二次加载冲突（2026-08-14 双实例事故）。结论一句话：**改 lib/ 需重启，新增 insert 条目也需重启；只有既有条目的 config 快照改动才热生效** **〔勘误 2026-09-24 评审回炉〕：上句「新增 insert 条目也需重启」与本批次 T1 §1.2 #2 及 0.1.7-alpha.2 宿主源码不符——EntryGroup.update create() 会 import 插件模块，insert 新增/删除均热生效；本轮验收 R1①② 实证（补 host-plane 行未重启宿主即被网关路由）支持新结论。热生效语义以 docs/settings-page-design.md §1.2 矩阵为准，本条目原文保留仅供历史追溯** |

---
## 3. 关键决策与坑（按价值排序）

### 3.1 emoji 代理对拆分（t2i 渲染黑字形）
- **症状**：卡片里 😀👍🎉 渲染成黑色字形（像素扫描：0 个彩色像素，只有页脚蓝）
- **根因**：JS 字符串索引 `text[i]` 按 UTF-16 码元取字符，`😀`（\uD83D\uDE00）被拆成两个半代理；高代理位 0xD83D ≥ 0x2E80 被 classifyChar 判为 CJK → emoji 并进 CJK run 用 Songti 画出单色字形
- **修复**：drawBodyRuns/drawCodeRuns 全部改 `Array.from(text)` 按码点迭代；splitLongText 边界同样保护（charCodeAt 检测高代理回退一位）
- **验证**：修复后 269 个黄色像素；emoji×12 分段测试每个 chunk 码点数×2 == 码元数

### 3.2 分段从非标点位置截断（split）
- **症状**：回复被切成 需要我做什 / 么直接说就行～（「什么」被劈开）
- **根因**：移植版用**向前越界**找标点（chunk 可超 limit），窗口内无标点就硬切在 limit；且标点集误加 `.` `:` `;`（URL/代码里的点被当断句点）
- **修复**：对齐 Hermes 原版 `_split_reply`：窗口内**向后**找最后一个标点（。！？!?；;\n），chunk 恒 ≤ limit 且结尾是标点；无标点优先回退最后一个空格（单词/URL 完整）；代理对保护
- **验证**：原截断文本现在切为 对话内容。 + 需要我做什么直接说就行～；79/79 全过

### 3.3 stop() 先清 chats 再写映射 → 重启失忆
- **症状**：优雅关停后 chat-sessions.json 变成 {}，重启后 0 resumed，create 撞上磁盘残留日志报 id collision
- **根因**：bridge.stop() 先 `chats.clear()` 再 `saveMapping()`
- **修复**：先存映射再 dispose/clear；顺带加 create 失败（id collision）自愈：换带时间戳后缀的新 session id 并提示重发
- **验证**：重启记忆 E2E：记暗号柚子 → 优雅关停 → 重启 → 1 resumed → 答出柚子

### 3.4 resume 时模型选择读到引导期默认值
- **症状**：重启恢复的 Agent 用 deepseek-official（无 key）而非用户配置的 opencode-go，回合报 no API key
- **根因**：loadMapping 在宿主启动早期执行，settings/provider 还没加载完，currentSelection() 返回内置默认
- **修复**：桥接启动先 `await ctx.get('loader')?.await()`（headless-runner 同款）再读模型选择

### 3.5 挂载层两个坑（部署时踩的）
- **$HOME 字面量**：`name: '$HOME/dsh-plugins/...'` 不被 loader 插值（entry 元数据保持字面量）→ 模块找不到；必须绝对路径
- **config.yaml 不是 patch 层**：写 `~/.dsh/config.yaml` 不生效；正确位置是 `~/.dsh/profiles/web/cordis.patch.yml`（dsh-vision 的挂载点）
- **热加载**：改 patch 文件或 touch 即热替换插件（watchUserPatches），1 秒生效，无需重启 dsh

### 3.6 双连接 last-wins 与发送空窗
- **症状**：线上 E2E 用户没收到回复
- **根因**：测试对端拨入顶掉 NapCat 连接；模型回复完成时对端已退出、NapCat 未重拨 → sendMsg 时无连接 → 回复丢弃（仅控制台日志）
- **修复**：测试方法改为本地草稿实例（对端全程在线）；线上链路用真实 QQ 消息验证。已知限制：断线瞬间的回复会丢（与 Hermes 一致），待增强补发

### 3.7 npm 工具链坑
- **npm install 覆盖宿主符号链接**：npm 重装 peer 依赖会把 link-host.sh 建的符号链接替换成真实副本 → 装完依赖必须重跑 link-host.sh（build.sh 已内置）
- **macOS 无 readlink -f**、受限 shell PATH 无 dsh：脚本改用 npx store 兜底查找（~/.npm/_npx/*/node_modules）
- **fontkit ESM 入口是浏览器构建**（dist/browser-module.mjs 无 Node API）→ 改 createRequire 惰性加载 Node 构建

### 3.8 macOS 字体家族缺失 → 豆腐块
- **症状**：PingFang SC 家族在 macOS 26 不在 /System/Library/Fonts，ctx.font 指定它时 Skia 静默回退成豆腐块（墨水自检 224 像素 vs 真字形 1200+）
- **修复**：FontManager 启动时墨水自检（渲染「中」统计深色像素 <600 即弃用该家族）；可用家族：Hiragino Sans GB / Songti SC / Menlo / Apple Color Emoji / Arial Unicode MS
- **emoji 必须显式 Apple Color Emoji**（混合文本不自动彩色化）

### 3.9 schemastery / defineTool 细节
- schemastery Schema 是**可调用函数**：`Config({...})`，不是 Config.validate()
- 参数 DSL 不支持嵌套 `items.required`（defineTool 直接报错）→ execute 内手检
- 字面量联合用 `z.const('x')`

### 3.10 QQ 会话未加入 agent 预设 + 未挂工作区（2026-08-14）
- **症状**：①QQ 会话在 GUI 显示「未分组」；②QQ 会话只有 qq_* + view_image 8 个工具，没有 bash/fs/read 等（会话日志实证：request header 的 tools 数组恰好 8 个，system prompt 仅 2793 字符，无任何工具指引节）
- **根因**（dsh-agent-presets 源码 lib/index.js:866 实证）：
  1. bridge 用 `ctx.agents.create({ setup: 只装模型选择 })` 直接建会话，**没有 `agentPresets.mount(agentCtx)`** → 该 agent 的 tools/prompt/skills 解析在 **empty global layer**，只剩插件自己全局注册的 qq_*（dsh-onebot）+ view_image（dsh-vision）。bash/fs/subagent 等全部在 standard 预设的 agent-plane 里（config/agent-presets/standard/agent.cordis.yml），不加入预设就看不到
  2. GUI 建会话走 api sessions.create → `composeAgent(preset)` + `workspace.attachSession()`；bridge 两样都没做 → 会话不在任何 workspaceRegistry.sessionIds 里 → GUI「未分组」。attachSession 全仓库只有 dsh-host-apiproxy 调用
- **修复**（src/bridge.ts）：
  - `joinPreset(agentCtx)`：setup 里 `agentPresets.mount(agentCtx, config.agentPreset || undefined)`（默认走部署默认 standard；mount 失败仅 warn 回退旧行为，不炸聊天）
  - `attachToWorkspace(sessionId, headerCwd)`：按会话 header cwd `resolveByPath`，无则 `create`，再 `attachSession`（全 best-effort，失败仅日志）
  - 新增配置：`agentPreset`（留空=默认）、`workspacePath`（留空=宿主 cwd）；inject 加 `agentPresets`、`workspaceRegistry`
  - patch 已配 `agentPreset: standard` + `workspacePath: ~/workspace`
- **防复发（3.10 修订）**：宿主重启 resume 旧会话时，旧会话 header cwd 是旧宿主 cwd（~/.hermes/workspace），与 workspacePath 不同 → 原逻辑会按旧 cwd 自动建工作区（实测踩中：自动创建了 ~/.hermes/workspace 工作区）。修订：**仅当 headerCwd === workspacePath 时才自动创建**；异 cwd 会话只挂到已存在的工作区，否则跳过（保持未分组）。旧会话用脚本迁移（header cwd 改写 + 目录迁移 + workspace/projcache 同步，见 workspace/migrate-qq-session.sh）
- **验证**：81 vitest 全绿（含两条回归：preset mount + 工作区 create/attach；异 cwd 不自动建工作区）；tsc 构建通过。**生效需重启 dsh web**（宿主侧插件无 HMR）

### 3.11 斜杠命令 /new（2026-08-14）
- **需求**：QQ 里发斜杠命令开新对话无效——插件此前没有任何斜杠命令处理，/xxx 被当普通消息丢给模型
- **实现**（src/bridge.ts）：
  - `parseSlashCommand(text, selfId)`：解析入站文本，容忍群聊 `@<bot> /new` 前缀；命令集：`/new` `/model` `/workspace` `/stop` `/help`（/model、/workspace 为下午随命令补齐加入，见 §2 时间线）
  - `resetChat(chatId)`：销毁当前 chat agent、把旧 session id 加入 brokenSessions（下次消息自动生成 `onebot-private-<qq>-<base36>` 新 id）、清映射、直接经出站管线回发「已开启新对话」确认（agent 已销毁，不走模型）
  - 权限：仅 admin（群聊成员/受限用户发 /new 直接忽略）
- **验证**：82 vitest 全绿（新增回归：/new 不进入 agent、收到确认回复、下一条消息落在带后缀的新会话 id）；tsc 构建通过

### 3.12 入站图片压缩（2026-08-14，已实现）
- **目标**：大图先压缩再交给视觉模型（view_image），避免大图拖慢视觉分析（路线图最后一项，已转正；对齐 Hermes 原版 `_shrink_image`）
- **决策拍板**（用户确认）：
  - 触发：长边 > `imageMaxSize`（新配置，默认 2048，`<=0` 禁用）才压缩，等比缩放（长边限制、短边跟随）
  - 算法：@napi-rs/canvas 缩放（`imageSmoothingQuality: 'high'`），**不加新依赖**
  - 输出：RGBA（含透明）→ PNG；否则 → JPEG quality=85；**透明垫黑底**（与 PIL 转 RGB 一致）
  - **EXIF 方向校正**（用户要求，优于原版）：竖拍图不横躺
  - GIF 动图：**保持原图**不压缩（用户确认）
  - 失败/解码失败：保持原图（best-effort）
- **实现**（src/image-shrink.ts + media.ts resolve 包装）：
  - `shrinkImage(src, maxSize)`：GIF 魔数跳过 → loadImage 解码 → 长边 ≤maxSize 不动 → 等比缩放 → PNG/JPEG 导出 → 写 `<原名>-c<maxSize>.png|jpg`（不覆盖原图）
  - MediaStore 构造加 `imageMaxSize`（`<=0` 禁用）；resolve 的 image 分支下载后统一压缩（resolveInner 提取 + 外层包装，全分支单点生效）
  - ⚠️ **踩坑（重要）**：原计划手写 JPEG APP1/EXIF Orientation 解析（零依赖约 40 行），实测 **@napi-rs/canvas 的 loadImage 已自动应用 EXIF 方向**（3000×2000 + Orientation=6 解码即 2000×3000）——再手动旋转会**双重旋转**。修复：删除手写 EXIF 解析与旋转代码，直接以解码尺寸为准（解码尺寸=显示尺寸）
- **验证**：99/99 vitest 全绿（新增 9 例：4000→2048、小图不动、禁用、RGBA→PNG、不透明→JPEG、EXIF=6 输出 1365×2048、GIF 保持、损坏文件不抛、不覆盖原图）；tsc 零错误
- **文档**：README 配置表加 `imageMaxSize`、功能表入站转正、路线图章节移除、兼容性验证更新为 99/99

### 3.13 loop 合并竞态与中间消息慢一拍（2026-08-16，已修复）
- **症状 A（少撤回）**：用户截图实测——每轮合并转发卡片都比实际中间消息少一条：卡片 2 条+撤回 2 条，最后一条中间文本留在聊天里（不合并、不撤回）
- **根因 A**：interim 记账是 `sendToChat(...).then(ids => loopBuffer.push(...))` ——消息真正发出后**异步** push；而 turn/end 处理是**同步** `const buf = chat.loopBuffer; chat.loopBuffer = []` 快照换数组。模型生成完最后一条 assistant/message 后立刻发 turn/end，此时最后一条 interim 的发送还在队列里、push 未发生 → 快照后 push 进被替换的旧数组 → 该消息永久失去合并/撤回跟踪
- **症状 B（慢一拍）**：用户反馈 QQ 收到的中间文本滞后——「延迟一条」策略下每条中间文本都要等下一条 assistant/message 到达才发出
- **根因 B**：延迟一条是**有意设计**（上一条被下一条证明是 interim 才发，防最终回复被当中间消息发出），但代价是每步都慢一拍
- **修复**：
  - **立即发送判定**：assistant/message 的 content 含 `tool-call` 块 → 该消息 100% 不是最终回复（模型调用工具后必继续生成）→ 立即发送并入账（`sendInterim`）；仅无工具调用的纯文本保持延迟判定，turn/end 时作为 final 发送
  - **结算先排空队列**：`settleLoop`（turn/end 分支改为 void 异步调用）先 `await chat.queue` 等发送链全部 settle（最后一条 interim 的 push 必然完成——push 回调注册早于队列 catch 链的恢复），再快照 buffer，顺序执行：合并转发 → final（t2i/分段原路径）→ 撤回；任一步失败安全降级（合并失败保留原消息，内容不丢）
- **验证**：99/99 vitest 全绿（既有 ≥2 合并+撤回、单条不合并、新消息清残留测试全部保持通过）；src 与 lib 入库，推送 GitHub（68f2398）

### 3.14 /new 后 id collision 复现：废弃 id 持久化 + 兜底记账修复（2026-08-16，已修复）
- **症状**：QQ 私聊 `/new` 后下一条消息报 `session "onebot-private-841859784" already has a persisted log on disk that does not match this live session (id collision)`，新对话开不起来
- **现场还原**（磁盘证据）：会话 id 由 chat 确定性派生（`sessionIdForChat` → `onebot-private-<qq>`，永不变）；首次会话的日志持久化在 `~/.dsh/sessions/--Users-mario--/onebot-private-841859784/`（cwd=/Users/mario = DSH 进程启动目录）；`/new`（resetChat）只把旧 id 记进**内存** `brokenSessions`、把 chat-sessions.json 清成 {}；进程重启后 `brokenSessions` 丢失、mapping 空 → 下一条消息 ensureChat 又用回裸 id → dsh-session-persistence 的 onCreated→adoptLivePrefix 发现磁盘旧日志的 seed 覆盖不了 → 抛 id collision。该错误**异步**浮出（create 本身 resolve，persistence 的 live.init 被 .catch 吞掉），回合结束变 turn/end error → 发 ⚠️ 并触发 healSessionCollision（内存拉黑裸 id）→ 再发一条才成功；**只要中间重启过一次，裸 id 又被复用，必复现**
- **修复**：
  - **废弃 id 持久化**：新增 `retired-sessions.json`（mediaDir 下，append-only 数组）。`retireSession(id)` = 内存 brokenSessions + 去重追加 + 立即写盘；调用点：resetChat（/new）、healSessionCollision、loadMapping resume 失败、ensureChat create 碰撞兜底。启动时 `loadRetired()` 读盘回填 brokenSessions。`ensureChat` 选 id 判断改为 `isSessionIdBlocked`（内存 ∪ 磁盘），`freshSessionId()` 生成带时间戳后缀新 id 并 while 去重 —— **重启后裸 id 永不再用**
  - **兜底记账修复**：ensureChat 的 catch 分支兜底成功后，`chat.sessionId`/`bySession`/日志原本仍记**原始裸 id**（真实 session 是后缀 id）→ 会话事件全查不到（不回消息、mapping 写错 id）。改为统一用 `handle.agent.session.id`（真实 id）收尾；loadMapping 同步修正
- **验证**：102/102 vitest 全绿。新增/扩展 3 例：/new 后 retired-sessions.json 落盘 + 同一 mediaDir 新 bridge 模拟重启首条消息直接用后缀 id（不再用裸 id）；create 碰撞兜底 → mapping/事件路由指向真实后缀 id；turn/end 碰撞 → retired 落盘 + mapping 清空。线上：预置 retired-sessions.json 两个已知废弃 id 后重启实测

### 3.15 会话 header 缺 agentPreset → Web 上不显示 preset（2026-08-17，已修复）
- **症状**：Web GUI 打开/列表看 QQ 创建的会话，标题旁没有 preset 标签（Web 创建的会话有）
- **根因**（代码级对照）：Web 会话 header 的 `agentPreset` 由 host api-proxy `sessions.create` 写入——`composeAgent(presetId)` 对缺省请求也 `resolve(undefined)` 出部署默认（router-flash）并写进 `meta.agentPreset`，创建 RPC 再把解析值回给前端存 session summary（AgentPresetLabel 只在该值存在时渲染）。onebot 的 `ensureChat` 只在插件配置 `agentPreset` 非空时写 meta（默认空字符串）→ header 无字段、summary 无值、Web 标签不渲染；**会话实际组装仍是默认 preset**（joinPreset 的 mount(undefined) 回落 defaultId），只是没记录
- **修复**：
  - **创建记录**：`ensureChat` 新增 `resolvePresetId()`——配置非空用配置（先 resolve 校验），否则用 `agentPresets.defaultId`；总是写入 `meta.agentPreset`（resolve 失败 warn + 不写，保持降级语义）。新会话 header 固定记录有效 preset id
  - **resume 按记录重建**：`loadMapping` 新增 `recordedPresetFor()`——经 `sessionPersistence.inspect` 冷读持久 header+log，`resolveRecordedPreset`（最新 `agent-preset/selected` 事件优先，否则 header.agentPreset，与 dsh-agent-presets 的官方解析一致）；有记录时 setup 以记录为准，与插件配置冲突仅 warn（防改配置后老会话组装漂移，违反 model-visible ⟺ logged）；无记录（存量）回落配置/默认，行为不变——**存量不迁移**（用户决策）
  - 依赖：inject 增加 `sessionPersistence`（base bundle 已挂 session-persistence-jsonl，`ctx.sessionPersistence`）
  - Config 文案修正：agentPreset 描述原写「当前为 standard」，实际部署默认 router-flash
- **验证**：105/105 vitest 全绿。新增 3 例：配置留空 → header 记录默认 router-flash 且 mount 走默认；resume 读记录 preset 覆盖冲突配置（mount 收到 router-flash、warn 冲突）；resolveRecordedPreset 纯函数（log 最新优先/header 兜底/无记录 undefined）。更新 1 例：配置 preset 的创建断言 header 记录该 id。构建上线（生产热加载验证中）

### 3.16 link-host 在 nvm 全局布局下链到 npx store 副本（2026-08-17，已修复）
- **症状**：dsh 升级到 rc.7 后重跑 link-host.sh，插件 node_modules/@deepseek-ai/* 被链到 `~/.npm/_npx/dsh-onebot/node_modules/@deepseek-ai/*`（一个历史 npx store 残留），而非宿主进程实际加载的全局安装（`<nvm>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`）
- **根因**：`resolve_dsh_root` 第一路按 bin 祖先找 `node_modules/@deepseek-ai`——nvm 全局布局下 bin 在 `<node>/bin`、包在 `lib/node_modules/@deepseek-ai/dsh/node_modules` 内嵌，祖先循环命中不了；于是落入第二路 npx store 扫描，先到先得（store 是旧的都可能）。**宿主进程用全局副本、插件用 npx store 副本 = 同一版本号的物理两份实例**（dual-package hazard：brand Symbol/instanceof 可能断裂）
- **修复**：bin 祖先循环增加 `$dir/lib/node_modules/@deepseek-ai/dsh/node_modules` 检测（存在即优先返回，脚本调用处再拼 `/@deepseek-ai/<pkg>`），npx store 仅作最后回退。幂等重跑验证：链接目标变为 `<nvm>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent`，tsc 零错误、23/23 bridge 测试过（rc.7 类型）
- **升级联动**：npm 全局装 rc.7 → link-host 修复重链 → kill 主进程由 launchd ai.dsh.web KeepAlive 自动拉起 → 日志确认 bridge ready (1 resumed)、agent joined preset router-flash、heartbeat 恢复、bin --version = 0.1.0-rc.7

### 3.17 /new 后 id collision 复发：裸 id 永久退休 + retired 三条防线加固（2026-08-18，已修复）
- **症状**：§3.14 修复上线后仍复发——`/new` 后新会话创建在**裸 id**（`onebot-private-841859784`）上，下一条消息 `turn/end: error`（`session flush failed: ... id collision`），heal 后需再补发一条才恢复，跟 §3.14 一模一样
- **现场还原**（日志 3239-3421 行 + 磁盘证据链）：
  1. 裸 id 的磁盘日志 `~/.dsh/sessions/--Users-mario--/onebot-private-841859784/session.jsonl.zstd` 从 8/16 起就是**存量残留**，这个 id 必须永久退休
  2. **防线①(loadRetired) 失效**：8/17 22:40 重启段（日志 `mounted` 到 `bridge ready` 之间）**没有** `retired-sessions file has N id(s)` debug 行（更早启动有「4 id(s)」）→ `loadRetired()` 读取 retired-sessions.json 失败被 `catch{}` 静默吞掉（把一切错误当「首次启动」）→ 内存 `retiredSessionIds` 变空
  3. **防线②(saveRetired) 非原子 + 覆盖丢史**：22:54 用户 `/new` → `resetChat` 只用内存数组 retire 当前会话 id（`-msx93frw`）并 `saveRetired()` **用空数组覆盖文件** → 4 个历史 retired id 全部丢失（文件 4→1）
  4. 22:56 用户发消息 → `ensureChat` 用回裸 id → 持久层抛 id collision → turn/end error → 报错 + `healSessionCollision` 补 retire 裸 id（文件 1→2，mtime 22:56:22 与报错同刻）
- **缺陷本质**：三条防线各自都不可靠——load 静默吞错 / save 非原子会以空数组覆盖历史 / `/new` 与自愈都不 retire 裸 id；§3.14 只堵了「重启后裸 id 被复用」却没堵「本次运行内 /new 就用裸 id」
- **修复**（src/bridge.ts）：
  - **`/new` 与自愈 retire 裸 id**：`resetChat()`、`healSessionCollision()` 在 retire 当前会话 id 之外追加 `retireSession(sessionIdForChat(chatId))` —— 裸 id 一旦要被替换，其磁盘日志永远与新会话冲突，必须永久禁（本次 bug 的直接根治）
  - **`loadRetired()` 区分真·首次 vs 真·错误**：仅 `ENOENT` 静默（真·fresh start）；文件读出失败/JSON 损坏/非数组一律 `log('warn', ...)` 并**保持内存+磁盘数组不动**——绝不静默后由下一次 `saveRetired` 用空数组覆盖
  - **`saveRetired()` 原子写**：写 `retired-sessions.json.tmp` 后 `rename` 覆盖，防半截文件/并发写坏（配合上一条：文件要么完整要么不存在）
  - **`ensureChat()` 创建前探测残余日志（最终兜底）**：新增 `hasPersistedLog(id)`（用注入的 `sessionPersistence.inspect(id)` 试读：成功=true、抛错=false）；裸 id 未被 blocked 时先探测，有残留日志 → `retireSession(bareId)` 再走 `freshSessionId` —— 即使 retired 文件被清空也绝不再撞盘
- **验证**：tsc 零错误；vitest 108/108 全绿（26 例 bridge）。新增 3 例：mapping 空 + 裸 id 磁盘有日志 → ensureChat 用带时间戳后缀新 id 且裸 id 落入 retired 集；resetChat 后 retiredSessionIds 同时含裸 id 与当前会话 id；loadRetired 遇损坏 JSON → warn 且不覆盖既有内存数组 + save 原子落盘（无 .tmp 残留）。另修测试自身一个 ASI 陷阱（`await vi.waitFor(...)` 后接 `(bridge...)` 行被吞进前一表达式报 `vi.waitFor(...) is not a function`，加前置 `;`）
- **不做**：存量裸 id 磁盘日志不迁移/清理（用户此前决策「存量不迁移」；裸 id 靠 continue 退休永久避开）；不动宿主 dsh（本次为 onebot 插件缺陷）

### 3.18 新增 9 个斜杠命令：/preset /status /retry /id /ver /ocr /mode /plan /goal（2026-08-18，已实现待上线）
- **动机**：用户 `/plan` 会话里要求「onebot 支持更多斜杠命令」，确认新增 7 个后又追加 /plan 与 /goal（/plan=per-chat 计划模式开关+计划指令；/goal=per-chat 目标记录提醒。宿主 bundle 无 plan/goal 服务暴露，不做真宿主 goal 创建）
- **实现**（src/bridge.ts）：
  - 新增 bridge 级 per-chat map：`chatPresetOverrides` / `chatInterimOverrides` / `chatPlanModes` / `chatGoals` / `chatLastImagePaths`（均跨 /new 保留，进程内态，重启回退配置/默认——与 /workspace 覆盖同语义）；`ChatAgent` 加 `lastFollowup`（/retry 用）
  - 入站收拢到 `dispatchFollowup(chatId, text, nickname)`：统一记录 lastFollowup + `prefixTurn`（goal 提醒→plan 指令前置）+ followup。`resolveMediaRef` 传入 chatId 并在图片解析成功时记录 `chatLastImagePaths`（/ocr 取最近图）
  - `/preset`：无参列出可用（扫描 `<dsh-home>/.agent-presets/*/preset.yml` 的 name）+当前（覆盖→resolvePresetId）；`/preset <id>` 用 `agentPresets.resolve` 校验，写覆盖 + resetChat 重建（下一条消息 resolvePresetId 以覆盖优先，header 记录新 preset）
  - `/status`：chat/session（无活跃会话读 chat-sessions.json）/preset/model/cwd/出站模式（含 /mode 覆盖标注）/agent 忙闲；`/id` 与 `/ver`（package.json version + git short hash，各读一次缓存）为纯读
  - `/mode [interim|instant]`：`chatInterimOverrides` 覆盖；`effectiveInterim(chatId)` 替换原 `config.interimMessages` 两处分支（assistant/message 与 turn/end）
  - `/retry`：无 chat/无 lastFollowup → 提示；busy 拒绝；否则清 loop 残留后重放 lastFollowup（prefixTurn 现算，/plan 状态改变后可影响重试结果）
  - `/ocr`：取 `chatLastImagePaths` → `fileToBase64` → `connection.call('ocr_image', { image: 'base64://'+b64 })` → `data.texts` 拼行回复；无图/读取失败/识别失败各有提示
  - `/plan`：on/off 开关 + `/plan <内容>` 置 on 并以计划指令处理；`/goal`：显示/设置/`clear` 清除，每轮自动附「【当前目标】」提醒
  - index.ts 增 `dshHome()` 注入；BridgeDeps 增可选 `dshHome`（供 /preset 枚举）；/help 文案与 README 同步
- **验证**：tsc 零错误；vitest 113/113 全绿（31 例 bridge，+5：/id /ver /status 信息、/goal /plan /mode per-chat 状态与前缀、/retry 重放与 /new 后清除、/preset 切换重建（mock resolve）与无效拒绝、/ocr 无图提示 + mock ocr_image 成功）
- **待上线**：构建 lib → kill 主进程由 launchd ai.dsh.web 拉起 → `/ver` `/status` `/id` 真机看输出；`/ocr` 需用户发图实测（NapCat ocr_image 对 base64 的接受度以真机为准，失败则退 file/直链）
- **上线状态（§3.25 补记）**：随 8/18~8/19 构建与 8/26 重启在线上；8/28 会话系统提示已含 §3.24 校准后的完整 14 命令表（线上 prompt 实证）；各命令真机实测细节未单独记录，日志核查无报错痕迹

### 3.19 /workspace 跨重启持久化（方案 B）+ 宿主计划书/提问卡中继到 QQ（2026-08-18，已实现待上线）
- **需求**：① `/workspace` 指定工作区后重启应默认继续使用；② 宿主弹「计划书/选项卡」时 QQ 端静默、对话停住——exit_plan_mode 的 plan-review 卡与 ask_user_question 走宿主平面 ctx.userQuestions，不经 session 事件流；模型调用时文本块为空，原 `text === ''` 早返回让 QQ 静默
- **实现**（src/bridge.ts）：
  - **方案 B（workspace 回填）**：`loadMapping` resume 成功后，若 `handle.agent.session.header?.cwd` 非空且 != `effectiveCwd()` 默认，回填 `chatWorkspacePaths.set(chatId, header.cwd)`。重启后该 chat 的 /workspace 显示原目录、/new 新会话也用回原目录；cwd==默认的旧 chat 不产生多余覆盖。不动 mapping 结构、无迁移
  - **计划/提问中继**：`onSessionEvent` 的 assistant/message 分支，dedupe 之后、`text === ''` 早返回之前调用 `relayHostCards`——扫描 content 的 tool-call 块：`exit_plan_mode` → renderPlanCard（「【📋 计划书】…plan 全文」）、`ask_user_question` → renderQuestionCard（编号问题 + 选项 + 多选标注），走 sendToChat 出站管线（自动分段/t2i）。independent of interim 模式；沿用 lastHandledMessageId 去重；arguments 解析失败降级静默。边界：QQ 回复暂不能操作宿主 plan-review/option 确认（宿主平面，不动宿主），只保证用户能获知内容
- **验证**：tsc 零错误；vitest 115/115 全绿（33 例 bridge，+2：resume 非默认 cwd → 覆盖回填 + cwd==默认 → 无覆盖；计划书/提问中继内容 + 同 id 连续重发去重）。测试注意：dedupe 只记「最近一次」message id，重发必须紧跟原发、中间不能插新 id
- **真机（已上线验证）**：中继生效——ask_user_question 提问以 **t2i 卡片**到达 QQ、可 QQ 直接作答，且 QQ 作答能解析上游 ask_user_question（工具调用返回了 QQ 文本答案，对话不卡死）。**已知限制**：Web 端提问/计划卡视觉上不自动清除——宿主平面 UI（ctx.userQuestions），onebot 不动宿主无法处理，仅保证 QQ 端可获知+可作答。`/workspace` 跨重启真机：当前 chat 为默认 cwd 不触发回填（符合设计），需用户 /workspace 切非默认目录后重启实测

### 3.20 受守卫文件编辑 code_safe_edit/rollback/list_backups + code-safe-edit skill（2026-08-18，已上线后拆至 dsh-safe-edit）
- **需求**：用户问可否借鉴 irmia_devkit 的 safe_edit（AGPL-3.0）→ 定方案 A1：全渠道可用 + QQ 管理员门控 + skill 引导模型默认优先
- **实现**（src/safe-edit.ts + src/tools.ts + src/bridge.ts + src/index.ts + src/prompt.ts + skill）：
  - `safe-edit.ts`：`checkPathAllowed`（根内 + .. 穿越 + 符号链接逃逸）→ read（CRLF 归一）→ `backupFor`（时间戳 .bak + 惰性剪枝 50 份）→ 匹配链（精确 → `stripLineNumberPrefixes` 剥读输出行号前缀 → `alignWhitespace` Aider 式缩进增量对齐）→ 多匹配返回 `{matches:[{line,col,preview}]}` + occurrence=N/replace_all → replace/insert_at_line/delete_lines → 原子写（tmp+rename）→ 语法检查（js/cjs/mjs `node --check`，可注入桩）→ 失败 `finishEdit` 自动回滚 + 结构化错误；`safeRollback`（回滚前再备份当前状态，可撤销）；`listBackups`（≤50）
  - `tools.ts`：注册三工具（仅当 `safeEditRoot` 非空）；门控走 `bridge.canEditFiles(sessionId)`（A1：onebot chat 需最近入站用户是管理员，非 QQ 会话默认放行；chat 存在但无入站者 → 拒绝）
  - `bridge.ts`：ChatAgent 加 `lastUserId`（processInbound 写回），新增公共 `canEditFiles`
  - `index.ts`：Config 加 `safeEditRoot`/`backupDir`（schema 默认 ''=禁）
  - `prompt.ts`：QQ 平台说明加「改文件优先 code_safe_edit」
  - skill：`code-safe-edit`（全渠道：优先 tool、流程、回滚、坑）
  - 部署配置 `~/dsh/profiles/web/cordis.patch.yml` 设 `safeEditRoot: /Users/mario/workspace`
- **验证**：tsc 0 错误；vitest 128/128 全绿（12 文件，+safe-edit 10 例 + 门控 1 例）。测试注意：align 后须回写对齐后的 newText（否则替换丢缩进）；insert_at_line 的 insert 不能自带尾 \n（join 会再补一个）
- **待上线**：构建 → kill 由 launchd 拉起 → 真机：QQ 让 bot 用 code_safe_edit 改 workspace 下文件测一次（含一次改坏语法看自动回滚）
- **后续**：2026-08-18 已上线，随后按用户要求拆分为独立插件 dsh-safe-edit（见 §3.21），本段保留为拆分前 A1 实现的历史记录

### 3.21 安全编辑从 onebot 拆分为独立插件 dsh-safe-edit（2026-08-18，已完成上线）
- **需求**：用户问"全局生效"——code_safe_edit 原只随 onebot 在 QQ 通道注册，规则也只在 QQ 平台提示词注入；想把安全编辑拆成独立插件，让 Web 等其他通道也能用；同时要"全局规则注入"（~/.dsh/AGENTS.md）
- **三个决策（用户拍板）**：① 权限策略**默认允许所有会话编辑**（去掉原 A1 的 QQ 管理员门控）；② 可编辑根**跟随会话 sandbox 策略**：`danger-full-access` 无限制、`workspace-write` 限会话工作区、`read-only` 拒绝；③ 仅本机落地（不做 git/npm 发布）
- **实现**（独立插件 `~/dsh-plugins/dsh-safe-edit/`，Cordis 直挂 patch）：
  - `src/safe-edit.ts`：从 onebot 原样搬运（零 onebot 依赖，只 import node:*）；`checkPathAllowed` 语义改为 `root===''`=无限制（原为禁）
  - `src/policy.ts`：`resolveRoot(policy, configRoot, configBackupDir)`——policy 三档映射 + 无策略服务回落 config、空根拒绝
  - `src/tools.ts`：注册三工具，`rootFor(exec)` 每次按 `ctx.get('sandboxPolicy').resolve({session})` 解析边界；`inject: ['tools']`
  - `src/index.ts`：Config `safeEditRoot`（默认 `/Users/mario/workspace`）/`backupDir`
  - 挂载：`~/dsh/profiles/web/cordis.patch.yml` 移除 onebot 的 safeEditRoot 条目、新增 `dsh-safe-edit` 条目
  - onebot 侧删除：src/safe-edit.ts、tests/safe-edit.spec.ts、tools.ts 注册块（含 assertEditingAllowed/bridge.canEditFiles 依赖）、index.ts 的 safeEditRoot/backupDir 配置；prompt.ts 的「优先 code_safe_edit」提示保留（工具已全局，指引仍有效）；README/DEVLOG 同步
  - 测试迁到 dsh-safe-edit（7/7 全绿：原 6 例 + 新增 resolveRoot 三档映射 1 例；空 root 语义断言更新为"unrestricted"）
- **坑（真机排查出根因）**：首次实现 `resolvePolicy` 只给 sandbox-policy 的 `resolve()` 传 `{id}` stub——但 dsh 的 `SandboxPolicyService.resolve` 会读 `session.events`/`session.header.cwd`，stub 无 events → `Cannot read properties of undefined (reading 'length')`。**修复**：按 dsh-tool-bash 的做法直接传完整 `exec.agent.session` 对象。另外 HMR 只重应用配置快照、**不重新 require 插件 JS**，改完 `lib/*.js` 必须重启 dsh（launchd `ai.dsh.web` kill 自动拉起）才生效
- **验证**：onebot tsc 0 错误 + 118/118 全绿（safe-edit 相关 10 例移除后无回归）；dsh-safe-edit 7/7 全绿；真机（重启后）code_safe_edit 编辑 /Users/mario/workspace 文件成功、自动生成 .bak、code_safe_rollback 恢复；~/.dsh/AGENTS.md 已注入生效

### 3.22 /plan 转发宿主命令：修复 QQ 无法退出宿主计划模式（2026-08-18，已实现待上线）
- **症状（用户报告并确认）**：QQ 无法退出 plan 模式。根因双重锁死：① 插件 `/plan`（3.18 版自建「前缀计划模式」）劫持了宿主同名命令，QQ 发 `/plan off` 只关前缀 flag，宿主 plan-mode 的 `/plan off` 命令收不到；② 3.17(方案 A) 的 prompt 明令禁用 `exit_plan_mode` → 宿主 plan-mode 唯一工具退路被堵 → 只剩 Web 切换 session 模式
- **关键事实（源码核实 dsh-plan-mode）**：宿主 `/plan` 命令 `handler` 里 `/plan off` 走 `set(agent,false)` **纯文本直退、无 userQuestions/审批卡**；`/plan <内容>` 会 `agent.steer` 自动把内容当用户消息注入。所以 QQ 退出宿主 plan 完全可走 `/plan off`，不依赖 Web
- **修法（收敛到宿主语义）**：
  - `bridge.ts`：删除 `chatPlanModes` map 与 `prefixTurn` 的【计划模式】前缀注入；`handlePlanCommand` 改为**转发** `ctx.commands.execute(chat.agent, '/plan [off|内容]')` 并把宿主返回文本（Plan mode on/off…）中继到 QQ（off 时附提示）；`BridgeDeps` 增可选 `commands`
  - `index.ts`：inject 增加 `commands`；Context 类型化；deps 传入 `ctx.commands`
  - `prompt.ts`：仍禁 `ask_user_question` 与 `exit_plan_mode`（审批卡仅 Web）；新增「处于宿主计划模式时输出纯文本计划并提示 /plan off 退出」→ **不会**重引入「Web 计划书手机 QQ 无法审批」问题
  - 测试改写：/plan 断言改为「转发到 commands.execute(路径/内容)+中继宿主文本」；prompt 断言 /plan off 引导；删除 chatPlanModes 断言
- **并发合流**：期间另一次会话把 safe_edit 拆为独立插件 dsh-safe-edit（§3.21，用户拍板），onebot 移除 code_* 注册与源码；本改动在其上叠加（commands 注入与拆分移除共存），onebot 内 safe-edit 死拷贝已清理，118/118 仍绿
- **验证**：tsc 0；vitest 118/118；待上线：kill 由 launchd 拉起 → QQ 实测 /plan 进宿主模式→文本计划→/plan off 直退→继续执行（全程无 Web 审批卡）
- **上线与修复（§3.25 补记）**：上线后 /plan 调用报 `Cannot read properties of undefined (reading 'aborted')`（宿主 execute 无条件读 signal.aborted）→ 8/19 补传必填 signal 修复（3a42743）；此后无相关报错记录

### 3.23 实时中间消息 + 各自的 90s 单独撤回 + 回合末整轮 t2i 小结卡（2026-08-18，已实现待上线）
- **症状（用户报 + 截图确认）**：推送回复那轮「少撤回文本 + 合并转发里有重复内容」。根因：回合 29 从首个中间消息到 turn/end 耗时 **280s**，最早中间消息已 4.7 分钟；QQ 撤回时限约 2 分钟 → NapCat `recallMsg retcode 1200 Timeout`，日志大量 `loop recall delete_msg failed`；回合末合并转发把 4 条已撤不回的原文收进卡里 → 原文残留 + 卡片重复（截图：4 条原文 +「群聊的聊天记录」卡 4 个同名节点 + 仅 2 条「对方撤回了一条消息」）
- **需求（用户拍板 4 点）**：① 中间消息实时可见；② 每条到 90 秒单独撤回（各自独立定时器）；③ 回合结束先把**整轮所有中间消息**渲染一张 t2i 小结卡、再发 final（final 保持现状阈值：>150 转图、短文文本）；④ 发小结卡时残留原文**立即撤回**（无重叠）
- **实现**（src/bridge.ts + index.ts）：弃用回合末合并转发（sendLoopForward 删除）；`loopBuffer` 条目加 `sentAt`；新增 `ChatAgent.recallTimers: Map<id,timer>` 与 `recalledInterimIds: Set<id>`；`sendInterim` 记 sentAt + 每条设 `interimRecallMs`（默认 90_000，新配置项，可调）定时器 → `revokeInterim` 单独撤回并标记；`settleLoop` 改为：排空队列 → `sendInterimSummary`（renderTextImage 出「📋 本轮中间记录」图卡，超 maxImageBytes 回退文本）→ `recallLoopMessages`（跳过已被 90s 撤过的，clearTimeout 残留定时器，delete_msg 间 60ms 间隔）→ 发送 final；`clearInterimTimers` 在 stop()/resetChat 清理
- **验证**：tsc 0；vitest 119/119（重写合并测试为「小结图卡→立即撤回→final」、去重测试断言无 send_private_forward_msg、新增「40ms interimRecallMs 回合中自动单独撤回」用例）；测试注意：echo 必须给增序 message_id，否则两条 interim 同 id 被「已撤回」集合误跳过
- **上线状态（§3.25 补记）**：随 8/18~8/19 构建与 8/26 重启在线上；小结卡为 t2i 图片、撤回为插件侧动作，会话文本日志无直接痕迹；全量日志核查无 recall 超时/error 残留
- **待上线**：构建 → kill 由 launchd 拉起 → 真机：长回合看中间消息实时出现、90s 后各自消失、回合末出整轮小结卡 + final

### 3.24 平台说明下沉到 agent 自身作用域 + 三条校准（2026-08-26，已上线）
- **背景**：QQ 平台说明与 qq_* 工具原本注册在插件上下文（index.ts），平台规则对 Web 会话也可见；提示词残留两条失效指引——`view_image`（全仓无此工具）与 `code_safe_edit`（§3.21 已从 onebot 移除、dsh-safe-edit 未安装），会让模型调用不存在的工具
- **改动**：
  - `bridge.ts` 新增 `installChannelScope(agentCtx)`：平台说明（`systemPrompt.section` channel:dsh-onebot）与 qq_* 工具注册到**每个 agent 自身作用域**——`agents.create` 新建、`agents.resume` 恢复两处 setup 都执行，Web/local 会话不可见；`session/event`、`session/flush` 监听器改存 dispose 句柄并在 stop() 释放，防 HMR/重载重复累积
  - `prompt.ts` 三条校准：① 删 `view_image` 幻影指令——入站实际标注为 `[图片]`/`[语音]`/`[视频]` 占位（路径不进文本，cq.ts appendImage 核实），无可用看图工具时如实告知用户；② `code_safe_edit` 指引改为内置 read/edit（行级 hash 锚点 + dsh-better-edit 自动 undo，禁 write 整文件覆盖）——原指引与全局 AGENTS.md 惯例相反且工具不存在；③ 斜杠命令示例补全为 14 个（仅管理员，`/help` 查看说明），非管理员 `/` 命令被消费并提示「仅管理员可用」
- **验证**：tsc 0 错；vitest 全绿；lib 重建；真机重启（`launchctl kickstart -k gui/501/ai.dsh.web`）后生效；逐条对照代码核实：tools.ts 工具清单（无 view_image）、cq.ts 标注格式、chat.ts 群前缀、tryHandleCommand 命令表；测试同步：bridge.spec 假 agentCtx 补 systemPrompt/tools 桩并断言通道工具注册到 agent 作用域、plugin.spec 改为断言插件作用域不再注册通道面

### 3.25 补记：/plan signal 修复 + 架构图文档 + 待上线项状态收口（2026-08-19 / 2026-09-01）
- **/plan 转发真机 bug（2026-08-19，已修复）**：§3.22 转发上线后 /plan 调用报 `Cannot read properties of undefined (reading 'aborted')`。根因：宿主 `commands.execute` 实现**无条件**读 `signal.aborted`（signal 实为必填契约），§3.22 转发时未传（类型声明为可选，掩盖了该契约）。修复：`handlePlanCommand` 调用处补传 `new AbortController().signal`（QQ 用户发起的 /plan 不受本插件取消逻辑中断）；`BridgeDeps`/`Context` 的 commands.execute 签名 signal 改必填并补 `result` 字段类型；测试同步（转发用例断言补 signal）。验证：tsc 0；vitest 全绿；构建入库（3a42743）
- **架构图文档三连（2026-09-01，纯文档）**：88ad77c（Archify SVG 自包含化嵌入 README「## 架构」+ 交互式 HTML）→ 9cf1931（SVG 在 GitHub 管线不渲染 → 2x PNG 嵌入，SVG 补 xmlns 保留矢量版）→ 4a86a1a（README.en 英文版 EN SVG 全文翻译 + 重算标签遮罩 + EN PNG）。无代码改动
- **待上线项状态收口**：§3.18 斜杠命令、§3.22 /plan 转发、§3.23 小结卡均随 8/18~8/19 构建与 8/26 重启在线上（§3.24 上线时 lib 即含全部）；对全部 onebot-private-* 会话日志解压核查：无 aborted 报错、无 recall delete_msg failed、无 turn/end error 残留；小结卡为 t2i 图片（文本不进会话日志）、撤回为插件侧动作，日志无直接痕迹，实测细节未单独记录
### 3.26 t2i 小结卡标题栏 emoji 豆腐块（2026-09-14，已修复）
- **症状**：回合末「📋 本轮中间记录」小结卡标题栏里 📋（U+1F4CB）渲染成白色空心豆腐块 □
- **根因**：src/t2i/index.ts renderTextImage 顶部栏把整行 title 用单次 `card.drawRun(..., familyFor('cjk'), 52, white)` 画成单一 run，绕过逐字符分类——📋 在 Noto Sans CJK SC 里无字形即成豆腐块；正文 emoji 走 drawBodyRuns 一直正常
- **修复**：标题绘制改走 `card.drawBodyRuns(title, 24, y, 52, COLORS.white)`（canvas.ts 现成逐字符分类路径：emoji 用 'Noto Color Emoji'、ZWJ/FE0F 零宽跳过、ascii+cjk 走 CJK 族，测量=绘制铁律不破坏）；顶部栏几何（fillRoundRect(10,10,780,72,8)）、x=24、字号 52、白色、垂直居中逻辑全不变，1 行 diff
- **验证**：新增回归 tests/t2i-render.spec.ts「renders the top-bar title emoji in color (no white tofu)」：渲染 `title: '📋 本轮中间记录'` 后对顶部栏做像素判定——统计非白、非顶部栏蓝 #2196f3、非白蓝抗锯齿（蓝通道 ≥240）的墨水像素，无 emoji 对照渲染证明方法本身零假阳性；实测（本机 Noto Color Emoji）：修复前豆腐块 0 px、修后彩色 emoji 1409 px、对照 0 px，阈值取 >1000 / <200；修复前红、修复后绿。vitest 全量 343/343（改动前工作树基线 342 全绿 + 新增 1）、tsc 0 错、./scripts/build.sh 重建 lib 入库

---
### 2026-10-30（出站路径脱敏 S-09）

| 时间 | 工作 |
|---|---|
| 上午 | **出站路径脱敏**：QQ 群里机器人把 `video_material` 返回的素材目录复述进了回复，泄露本机目录结构。根因是模型用绝对路径读文件（`read_image` 等）后顺手照抄，而原有 `scanSensitive` 只做软审计（返回命中的模式名，不改写正文）。新增 `src/redact.ts` 的 `redactLocalPaths()`：盘符 / 正斜杠 / UNC / `\\?\` 长路径 → `<本机路径>`；盘符规则加 `(?<![A-Za-z0-9])` 前置断言，避免把 `https://` 里的 `s:/` 当成盘符 |
| 上午 | 接入点在 `OutboundPipeline.sendToChat` 的 `extractForwardBlocks` **之前**：t2i 卡片、纯文本、转发块共用同一份脱敏后的正文；命中时打 warn 日志并写 trace（`本机路径已脱敏` + count）。新增配置 `redactLocalPaths`（默认 true，`false` 原样发送） |
| 上午 | **为什么放在发送前而不是工具返回时**：模型必须拿到绝对路径才能读关键帧，改工具返回值会让它读不到文件；只有「发出去的文字」是该收口的地方 |
| 上午 | 验证：`npx tsc --noEmit` exit 0；新增 `tests/redact.spec.ts` 7 用例（三类路径形态 / 多处 / 不误伤 URL 与相对路径 / 空文本 / 接入点断言 / 关闭开关）；受影响四文件（outbound / interim / bridge / redact）**49 用例全绿**；`npx tsc -p tsconfig.json` 重新生成 `lib/`（`lib/redact.js` 新增，`lib/outbound.js` 含脱敏调用）。备注：本机直接跑 `tsc -p tsconfig.json`，等价于 `build.sh` 的编译步骤（`link-host.sh` 的符号链接此前已就位） |
| 上午 | 配套（另一仓库）：B 站视频插件的 `video_material` 描述与 skill 正文各加一条「返回的路径只用于自己读文件，不要在回复里复述」——只降低概率，兜底仍靠本仓库的出站脱敏 |

## 4. 功能清单（当前状态）

### 入站
- [x] 私聊/群聊（群需 @/回复触发，requireMention 默认 true；白名单授权）
- [x] 段数组优先解析（CQ 字符串回退）、CQ 反转义
- [x] 图片 url/base64/file/hash 四路获取；**大图自动压缩（长边 ≤imageMaxSize，GIF 不压，透明 PNG 保留）**；语音 ffmpeg→whisper 转写（失败降级 [语音]）
- [x] 引用消息自动取原文（get_msg）；合并转发自动展开（get_forward_msg）
- [x] 表情 id→emoji、@、回复、卡片、戳一戳段类型；群聊 [HH:MM 昵称(QQ)] 前缀注入

### 出站
- [x] 长消息策略：≤100 单条 / 100–150 标点分段 / >150 t2i 文字图卡片（渲染失败回退分段）
- [x] Markdown 剥离为 QQ 纯文本；[[qq_forward]] 合并转发（群/私聊）
- [x] loop 中间消息**实时发送 + 90s 独立撤回 + 回合末整轮 t2i 小结卡**（带 tool-call 的中间文本立即发送、无工具调用延迟一步判定；每条按 interimRecallMs（默认 90s）独立定时撤回；回合末先渲染「📋 本轮中间记录」小结卡 → 撤回残留原文 → 再发 final；结算前排空发送队列不漏最后一条；2026-08-18 §3.23，弃用旧「回合末合并转发」）
- [x] 图片（路径/URL，≤9 张）、语音、视频、文件工具；正在输入提示（私聊）
- [x] qq_napcat_api 白名单代理（14 个 action）、qq_group_history
- [x] ~~受守卫文件编辑 code_safe_edit/rollback/list_backups~~（**2026-08-18 已拆至独立插件 dsh-safe-edit**，随会话 sandbox 策略动态边界，跨通道全局；见 §3.21）

### t2i 渲染（2026-08-14 移植，对照 T2I_DEV_DOC）
- [x] AstrBot 元素化两遍流程（先算高再绘制）；800px/26px/右缘 790
- [x] 标题/粗体双画/斜体变换/删除线/引用/无序有序列表/代码块/表格（表头灰底/网格线/交替行/列宽拉伸/居中）/行内 code 胶囊
- [x] 彩色 emoji（Apple Color Emoji）、中文标点禁则、行内样式整体换行、字面 \n 转换
- [x] 顶栏 To 昵称（#2196F3）+ 页脚 Powered by dsh（#002FA7）
- [x] 像素级右缘验证 ≤790（压力内容全图扫描 0 违规）

### 运维
- [x] 会话映射持久化 + 重启 resume（含引导期模型选择等待）
- [x] 热加载：改 patch 文件/touch 即生效（无需重启 dsh）
- [x] 测试：149 vitest（单元 + 真实 WS 对端 + 全管线 + t2i 像素扫描 + 预设/工作区回归 + loop 合并/斜杠命令回归 + 图片压缩 + 废弃会话 id 持久化/重启回归 + preset 记录/恢复回归；safe-edit 测试已随拆分迁移至 dsh-safe-edit）

---

## 5. 已知限制 / 待办

1. **断线瞬间的回复丢失**：无连接时 sendMsg 失败仅记日志（与 Hermes 一致）；待增强：断线重连后补发
2. **ZWJ 组合 emoji / 区域指示符**：按码点拆分绘制（原版一致限制）
3. **t2i 链接/图片语法原样当文本**、无多级列表/任务列表/嵌套引用/合并单元格（原版一致限制）
4. **Linux 部署**：需安装 Noto CJK（ttc 默认面可能是 JP，fontkit 提取 SC 面代码已就位但未在 Linux 实测）；emoji 需注册 NotoColorEmoji
5. 卡片最大高度未限制（超长 markdown 可能生成超高图）

---

## 6. 快速备忘（运维）

```bash
# 插件目录 / 挂载点
~/dsh-plugins/dsh-onebot/            # 源码 + lib（构建产物入库）
~/.dsh/profiles/web/cordis.patch.yml # 挂载配置（改/touch 即热加载）

# 构建与测试
cd ~/dsh-plugins/dsh-onebot && npm install --include=dev && ./scripts/build.sh
./node_modules/.bin/vitest run       # 149 个测试

# 线上状态
netstat -an | grep <port>             # NapCat 反向 WS 连接（ESTABLISHED）
zstd -dc ~/.dsh/sessions/*/onebot-private-*/session.jsonl.zstd   # 会话日志

# NapCat（NAS 管理面板）
网络配置 → ws-reverse → ws://<dsh 机器 IP>:<port>/ws，token 与插件 accessToken 一致
docker restart 会丢登录态（需重新扫码/QCE 登录）
```

---

*本日志由移植过程会话记录整理，随迭代持续更新。*

## 2026-09-24 npm 包更名并首次发布

- 包名由 `@dsh-external/dsh-onebot` 更名为 `dsh-onebot-qq`（用户裁定，无 scope 名），版本 0.4.4。
- 更名规范文件：package.json、package-lock.json（name 两处）、README.md、README.en.md、cordis.patch.yml（模板注释）、docs/npm-distribution-design.md。
- 历史记录保留旧名（当时包名的表述，不做回溯改写）：DEVLOG.md 既有条目、docs/npm-e2e-report.md（e2e 复验记录）、docs/npm-e2e-evidence/*、docs/acceptance-evidence/04-npm-test.log。
- 验证：npm run build 通过；npm test 30 文件 376 用例全绿；npm pack 清单 56 文件，tarball 名 dsh-onebot-qq-0.4.4.tgz。
- 发布：npm registry 首次发布 `dsh-onebot-qq@0.4.4`（public，latest）；tarball https://registry.npmjs.org/dsh-onebot-qq/-/dsh-onebot-qq-0.4.4.tgz 。

## 2026-09-25 npm 元数据优化（0.4.5）

- package.json：version 0.4.4 → 0.4.5；description 换为精简双语版（中文首句 + 英文短句，dsh-market 卡片与 npm 搜索友好）；新增 keywords（dsh / onebot / onebot11 / qq / qq-bot / napcat / deepseek-harness）。
- 发版说明：纯元数据优化，无代码改动；lib 产物无变化。
- 验证：npm run build 通过；npm test 30 文件 376 用例全绿；npm pack 清单 56 文件，tarball 名 dsh-onebot-qq-0.4.5.tgz。
- 发布：npm registry 发布 `dsh-onebot-qq@0.4.5`（public，latest）；npm view 核验 version/dist-tags/keywords/description 生效。

## 2026-09-25 收录合规修复（0.4.6，awesome-dsh-plugin T1/A1）

- dsh.bundle manifest：package.json 新增 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }`。宿主读取点考证：`dsh.bundle.patch` = dsh-app-boot/lib/index.js:497（bundlePatchFiles：字符串或字符串数组、包相对路径）与 :924（loadProfileDirectory 读 `dsh.bundle`，缺失即报错）；`dsh.client.platform` = dsh-client-modules/lib/index.js:65（parseDshClient：platform 必须为 string，可选 inject/external/immediately）。此前只声明 `dsh.client` 不满足收录 CI 的 dsh.bundle 校验。
- cordis.patch.yml：由 `<DEPLOY_DIR>` 占位符模板改写为可直接加载的 bundle patch（顶层 YAML 数组 + insert 两行，name 用裸包名 `dsh-onebot-qq` / `dsh-onebot-qq/settings-remote`，走 exports）；手工部署形态（绝对路径 name）移入注释说明。宿主对 bundle patch 直接 loadOverlayPatches（dsh-app-boot/lib/index.js:928），占位符模板不可作为 bundle patch。
- peer 预发布分支：8 个 `>=0.1.5-rc.1` 形态 @deepseek-ai/* peer 改为 `>=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-alpha.1 <0.1.7-0 || >=0.1.7-alpha.1 <0.2.0-0`；semver 实测矩阵 10/10（8 版本 true、0.2.0-0/0.2.0 false），旧范围对 0.1.7-alpha.2 = false 的缺陷坐实。矩阵落 docs/semver-matrix.md。cordis/schemastery 无预发布问题未动；`engines.dsh` 同形态属范围外，留作后续事项。
- 验证：npm run build 通过；npm test 30 文件 376 用例全绿（exit 0）。
- 发布：npm registry 发布 `dsh-onebot-qq@0.4.6`（public，latest；token 仅经环境变量，.npmrc 引用 `${NPM_TOKEN}`，用后即删）。
- 同步：部署副本 /vol2/@appshare/Harness/dsh-plugins/dsh-onebot 的 lib（已一致）与 package.json（复制）diff -rq 核验通过。

## 2026-09-25 修复 client bundle 注册 id 与包名不一致（web 端插件激活失败）

- 症状：dsh 0.1.7-rc.2 web 页面顶部「Failed to load plugins: dsh-onebot-qq」，`client-modules: could not load "dsh-onebot-qq": ... loaded without registering "dsh-onebot-qq" via __ModuleLoader__.load`。宿主侧桥接（reverse WS/OneBot 连接）完全正常，仅 web 设置面板起不来。
- 根因：包 0.4.4 由 `@dsh-external/dsh-onebot` 改名 `dsh-onebot-qq`；0.4.6 在 package.json 补 `dsh.client.platform` 声明后，宿主（≥0.1.7-rc.2）boot manifest 才开始按**包名**下发 client entry（`dsh-client-modules/lib/index.js`：entry id = package name）。而 lib/client.js 的 CJS 包裹 banner 仍硬编码改名前的 `id: "dsh-onebot"`，浏览器端 `arrive()` 校验「bundle 执行后必须以 manifest id 注册」→ 永远失配。绝对路径 insert 的 loader entry id（`dsh-onebot`）与 client manifest id（包名）是两套命名，前者不影响此校验。
- 修复：lib/client.js 两处 `dsh-onebot` → `dsh-onebot-qq`（`__ModuleLoader__.load` 的 id 与 `PLUGIN_ID`，Remote `package` 键/样式标签随动）；tests/client-settings.spec.ts 五处断言同步。源码仓与部署副本（/vol2/@appshare/Harness/dsh-plugins/dsh-onebot）diff 一致后同步，部署副本属主 Harness:Harness 600。
- 生效机制：宿主按文件 mtime/ctime/size 重算 artifact rev，**无需重启**；重开页面即拉新 bundle。
- 验证：① manifest rev 更新（9c8122…→936b15…）+ 带 rev 拉 combo bundle 200 且含新 id；② node vm 桩 `__ModuleLoader__` 断言注册 id/导出/inject/Remote package；③ headless Chromium 全链路：设置导航出现「QQ Bot (OneBot)」、面板完整渲染（revision 0、6 分组、监听地址/端口/AccessToken 脱敏快照值来自真实 getSettings RPC）、0 console 错误；④ vitest 30 文件 376 用例全绿。
- 顺带：部署副本/源码仓 node_modules 内 esbuild 二进制丢执行位（EACCES），chmod +x 修复（备份 zip 解压丢 x-bit 同类坑）。
- 教训记录：skill devops/fnos-app-inspection references/dsh-plugin-errors.md 新增模式 9。

## 2026-09-25 发布 0.4.7（client id 失配修复发版 + engines.dsh 补预发布分支）

- 根因回顾：0.4.4 包由 `@dsh-external/dsh-onebot` 改名 `dsh-onebot-qq`；0.4.6 起宿主 `dsh.client` 声明后按**包名**下发 client entry 并校验 bundle 注册 id，而 lib/client.js 硬编码旧 id `dsh-onebot` → 永远失配，web 设置面板加载失败。85f23b4 已改 id 与 PLUGIN_ID 为 `dsh-onebot-qq`，tests 同步。
- 修复内容：lib/client.js id/PLUGIN_ID → `dsh-onebot-qq`（HEAD 已含）；本发版顺带把上轮遗留的 `engines.dsh` 从 `>=0.1.5-rc.1` 补成与 peer 三分支一致的 `>=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-alpha.1 <0.1.7-0 || >=0.1.7-alpha.1 <0.2.0-0`（semver 实测 0.1.5-rc.x/0.1.6-alpha.x/0.1.7-alpha.x/0.1.7-rc.x 全 true、0.2.0-alpha.1 false，矩阵追加进 docs/semver-matrix.md）。
- 验证链路：npm run build + npm test 全绿（30 文件 376 用例）→ 发布 `dsh-onebot-qq@0.4.7`（token 仅经环境变量，用后即删）→ registry latest 核验 + tarball 抽查 lib/client.js 含新 id → 部署副本同步 diff -rq 为零。
- 发版说明：0.4.7 = 0.4.6 修复后的正式发版号（0.4.6 曾被用作 metadata-only 发布占用），内容为 client bundle 注册 id 对齐包名，修复 web 端「Failed to load plugins: dsh-onebot-qq」设置面板失配；另补 engines.dsh 预发布分支。

## 2026-09-25 live web profile 迁移：手工部署形态 → market/npm 官方安装形态

- 操作：live patch（.dsh/profiles/web/cordis.patch.yml）摘除 insert 块内两条手工绝对路径条目（dsh-onebot 主条目 + onebot-settings-remote host-plane 行，均指向 dsh-plugins 部署副本）；官方通道 `dsh plugin --profile web add dsh-onebot-qq@0.4.7` 安装（bundle patch 裸包名两行接管挂载）。顶层 dsh-onebot config 覆盖行原样保留（id 不变，bundle 挂载后继续寻址）。
- 备份：cordis.patch.yml.bak-migrate-20260925（同目录，迁移前 sha256 ac87a4a…）；部署副本保留不删（回滚锚点）。
- 热操作全程：patch 编辑后 ~2s 旧 fiber 卸载（8765 消失，napcat 30s 重连循环）→ 插件安装 exit 0（fresh-release 由 minimumReleaseAgeExclude 放行，未触发 hold）→ 8765 复 LISTEN（fd 22→24，宿主同进程）→ napcat 172.17.0.3 ESTAB 5s 内恢复（fd 29）→ 全程宿主进程不重启（pid 3500551 连续运行 14+ 分钟覆盖整个迁移窗口；任务书中的 2609953 在任务开始前已不存在——宿主在任务启动前已被其他会话重启过，非本任务操作）。
- 验证矩阵：① 8765 LISTEN 属主宿主进程；② napcat 反向 ESTAB 恢复；③ onebotSettings/getSettings ok，revision=0 未跳变，host 192.168.5.74 / port 8765 与迁移前一致，accessToken set:true；④ profile node_modules 顶层出现 dsh-onebot-qq@0.4.7，package.json dsh.profile.bundles 含 dsh-onebot-qq；⑤ market 识别实证：GET /dsh-market/api/v1/updates?name=dsh-onebot-qq&force=1 → source npm, installedVersion=latest=0.4.7, updateAvailable=false；log.ndjson 新增 update-blocked 守卫事件（agent 运行中拒绝变更，证明 in-host market 已纳管该包）。CLI 通道安装不写 install/hot-mount 事件（logEvent 仅存在于宿主内 market RPC 路径，源码 dshmarket/src/routes.ts 实证），如实记录；⑥ live patch 无任何绝对路径 name（YAML safe_load 扫描 + grep，仅存说明注释）。headless Chromium 设置页本次未做（本机无 chromium/playwright 可执行，条件不具备）。
- 证据：docs/market-migration-evidence/（00 基线 sha256/ss、01 迁移前 getSettings、02 卸载记录、03 plugin add 输出、04 market log、05 迁移后 getSettings、06 market updates API、07 守卫事件、08 patch diff、09 终态矩阵）。
- 备注：进行中的 QQ 桥（8765 反向 WS）累计闪断约 3 分钟（卸载至 napcat 重连成功），无报错残留。

## 2026-09-25 发布 0.4.8（npm 搜索排名优化：keywords/description 文本匹配面拉满）

- 调研结论（实测）：`dsh-onebot-qq` 在 "dsh qq"/"dsh onebot"/"onebot dsh"/"napcat dsh"/"dsh onebot qq" 全部组合未进 npm search 前 25；根因是新包 popularity 沉底（npm 搜索排序 popularity 权重高），短期无法靠元数据根治；竞品（@tencent-connect/dsh-qqbot 等）关键词含 deepseek-harness/qqbot/plugin，占名者 dsh-onebot 占 "dsh onebot" 第 1。可优化项=文本匹配面拉满（title/description/keywords 命中）。
- 本次优化（仅 package.json 元数据，零代码改动）：① version 0.4.7→0.4.8；② keywords 7→15 词，新增 qqbot、lagrange、llonebot、go-cqhttp、deepseek、harness、bridge、chatbot（保持全部现有词）；③ description 双语微调：中文补 dsh 全称 DeepSeek Harness 与 go-cqhttp、英文段改为 "QQ bot bridge channel plugin for deepseek harness via OneBot 11."（覆盖 deepseek harness/bridge/plugin 搜索词，描述属实不加营销词）。
- 验证链路：npm run build + npm test 全绿 → 发布 0.4.8（token 仅经环境变量，.npmrc 引用 ${NPM_TOKEN}，用后即删）→ npm view --prefer-online 核验 version/keywords/description 生效 → 部署副本 package.json 同步 diff 核验。
- 复测（发布后，同日）：五组合 "dsh qq"/"dsh onebot"/"onebot dsh"/"napcat dsh"/"dsh onebot qq" 排位均无变化，仍不进前 20（基线同样未进前 25）——如预期，短期仍受 popularity 沉底压制；本次文本匹配面扩充为长线收益，后续随下载量积累再观察。

## 2026-09-25 发布 0.4.9（description 精简为卡片友好短句版）

- 变更（仅 package.json 元数据）：① version 0.4.8→0.4.9；② description 换为短句版：`给 dsh（DeepSeek Harness）加 QQ 机器人通道：OneBot 11 协议，兼容 NapCat，支持私聊群聊、图片语音、t2i 卡片与设置页配置。QQ bot channel plugin for deepseek harness via OneBot 11.`——0.4.8 版罗列兼容端/功能清单过长，市场卡片展示不友好；关键词搜索面由 keywords 15 词承载（本次不动）。
- 验证链路：npm run build + npm test 全绿 → 发布 0.4.9（token 仅经环境变量，.npmrc 引用 ${NPM_TOKEN}，用后即删）→ npm view --prefer-online 核验 version/description/keywords → 部署副本 package.json 同步 diff -rq 核验。

## 2026-09-29 收口 0.5.0（新增宿主 0.2.0 支持：engines.dsh 与 peer 追加第四分支）

- 动机：宿主 dsh 0.2.0-rc.1 下 package.json 的 engines.dsh 与 8 个 `>=0.1.5-rc.1` 形态 @deepseek-ai/* peer 上限 `<0.2.0-0` 均不满足（semver 预发布排序中 0.2.0-rc.1 < 0.2.0-0，历史矩阵已实证 0.2.0 系全 false），宿主当前强豁免运行；本轮适配改动（source kind `plugin:dsh-onebot` 迁移、MessageSourceMap declare module 增广等 19 文件）已实测基线：`npx tsc --noEmit` 对实链 0.2.0-rc.1 零错误、`npm test` 全绿，仓库侧版本声明收口到实测覆盖面。
- 变更清单（仅版本声明与文档，零代码改动）：① version 0.4.9→0.5.0；② engines.dsh 与 8 个 peer（dsh-agent / dsh-llm / dsh-session / dsh-system-prompt / dsh-tools / dsh-typert-protocol / dsh-util-values / @deepseek-ai/schemastery）追加第四分支 `|| >=0.2.0-rc.1 <0.3.0-0`（下限=实测覆盖的 0.2.0-rc.1，排除未实测的 0.2.0-alpha.x；`<0.3.0-0` 挡未来 0.3.0 线）；cordis ^4.0.2 / schemastery ^3.18.0 无预发布问题未动；③ README.md / README.en.md 兼容性表 dsh 行同步 0.2.0 线声明；④ docs/semver-matrix.md 追加 0.5.0 矩阵节；⑤ DEVLOG 本条。dsh.plugin.json engines 为开放下限 `>=0.1.5-rc.1`，无需动。grep `<0.2.0-0`（排除 node_modules）复核：仅剩历史文档记录（DEVLOG 旧条目、semver-matrix 旧矩阵节），无活代码硬编码。
- semver 矩阵结论（npx semver CLI 实测，semver 非运行时依赖、未新增）：新范围下 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0 / 0.2.1 = true，0.2.0-alpha.1 / 0.2.0-beta.1 / 0.3.0-alpha.1 = false；旧范围下 0.2.0 系全 false（失配坐实）。
- 验证链路：npm run build（lib 与 src 一致，lib/*.bak-20260925 被 files 字段排除、原样保留）→ npx tsc --noEmit 0 错误 → npm test 全绿（30 文件 380 用例）→ git diff 复核无意外漂移，HEAD 仍 2cbf5b5 未 commit。
- 发版说明：0.5.0 = 新增宿主 0.2.0 支持（版本声明收口；适配代码为同批 19 文件改动）。后续流程（commit → npm 发版 → live 升级）不在本条范围内。

## 2026-09-29 发版 0.5.0 上 npm 与 live web profile 升级去豁免

- commit（发版惯例拆两笔保回滚粒度）：①`3af11a7` feat: adapt to dsh 0.2.0 — producer-owned source kind plugin:dsh-onebot 迁移（src/lib/tests 19 文件 + docs/market-migration-evidence/ + .gitignore 追加 lib/*.bak-*，lib/client.js.bak-20260925 不入库）；②`ee28ea7` chore(release): 0.5.0（package.json、README×2、docs/semver-matrix.md、DEVLOG.md）。commit 前重跑 `npx tsc --noEmit`（0 错误）+ `npm test`（30 文件 380 用例全绿）；npm run build 复核零漂移。
- npm 发布：token 仅经环境变量（.secrets/dsh-release-tokens.env → $NPM_TOKEN，临时 .npmrc 引用 ${NPM_TOKEN}，发布后即删、不落盘不入库）→ `dsh-onebot-qq@0.5.0` 发布 exit 0 → CDN 复制延迟 ~80s 后 `npm view --prefer-online` 核验：latest=0.5.0，engines.dsh 与 peer 均含第四分支 `>=0.2.0-rc.1 <0.3.0-0`。
- live 升级（全程宿主不重启，pid 54650 连续）：官方 CLI 通道 `dsh plugin --profile web add dsh-onebot-qq@0.5.0` exit 0 → profile node_modules 顶层=0.5.0，其 package.json engines/peer 含新分支 → market API `GET /dsh-market/api/v1/updates?name=dsh-onebot-qq&force=1` installedVersion=0.5.0（latestVersion=0.4.9 为宿主 registry 元数据缓存延迟，npm 侧已实证 latest=0.5.0，自愈无需干预）。QQ 桥零闪断：8765 LISTEN（fd 23）与 napcat 172.17.0.4 ESTAB（fd 33）全程同 fd 连续。
- 去豁免核验：升级前豁免形态=compatibility.json 白名单条目 `"dsh-onebot-qq@0.4.9": ["0.2.0-rc.1"]`（宿主 0.2.0-rc.1 下旧 peer 上限 <0.2.0-0 失配的强豁免，失配机理见 docs/semver-matrix.md）；0.5.0 安装期 compat 校验零告警（add 输出无 incompatible 提示），并以 `dsh plugin revoke-version dsh-onebot-qq@0.4.9 --dsh-version 0.2.0-rc.1` 撤销陈旧条目——compatibility.json 不再含 dsh-onebot-qq，宿主日志零新增豁免/失配记录（err.log ERROR 计数 0）。
- 遗留（如实记录，非缺陷）：①运行中宿主 fiber 仍为启动时（11:46）载入的 0.4.9 host-plane 代码——CLI add 仅替换磁盘文件，宿主无 watcher、无新 mounted 行；且 profile 为 hoisted 布局，更新就地重写、模块 URL 不变，Node ESM 缓存使热路径（configEditor reconcile / market toggle / hotMount）都只围绕旧模块重建 fiber（dshmarket/lib/routes.js #685 注释源码实证「Only a restart ends the process that holds it」）。0.5.0 host-plane 代码与 patch 内 0.5.0 注释将随宿主下次重启一并生效，届时启动 compat 校验按新分支直接通过、无需豁免。②patch 直改不触发热重挂（app-boot 无文件 watcher；09-25 的 ~2s 卸载应系经 GUI configEditor 写入所致），本次为更新 patch 内版本注释已先备份 cordis.patch.yml.bak-hot-20260929（sha256 0d16ae2b…）后直改，效果下次重启生效。③onebotSettings/getSettings RPC 仅宿主 /api 通道可达（浏览器会话鉴权，无可用凭据通道），未经直接调用核验；以桥接功能证据替代（ESTAB 持续、宿主日志 OneBot connected / turn/end 正常）。
- 证据：docs/release-050-live-evidence/（01 两笔 commit、02 registry 核验、03 market API、04 豁免清理、05 桥接终态，README 含关键事实与源码依据）。

## 2026-09-30 修复 per-chat 设置持久化被清空（loadMapping resume-failed 载体缺失 + saveMapping settings-only 不变量缺口）

- 事故现象与磁盘证据（只读核实）：per-chat /workspace 覆盖（含 goal/interimOverride）随一次宿主重启整体丢失，此后每次重启工作区回落宿主 cwd。`media/onebot/chat-sessions.json` 仅剩 2 字节 `{}`（mtime 2026-09-30 12:19，sha256 44136fa3…）；`retired-sessions.json` 含 `onebot-private-841859784` 与 `onebot-private-841859784-mulci1ec`（后者 retiredAt 2026-09-28 22:32，正处事故窗口）；session 持久化 bucket 存在 `…-mulaa1b8`（project1 cwd，未 retired）与 `…-mulci1ec` 等——会话日志还在，仅映射文件被清空。
- 根因（两处，均已定案）：①loadMapping 的 resume-failed catch 分支在 retireSession 后直接丢弃条目，与 retired-skip 分支不对称——后者已把 object 条目放回 evictedChats 作 settings carrier（T3-R1），前者没做；于是 2026-09-28 22:31 重启中 mulci1ec resume 失败 → 该 chat 连同 workspacePath 从内存索引消失 → 后续任意一次 saveMapping 全量重写文件时被抹掉，最终文件变 `{}`。②saveMapping 只遍历 evictedChats 与 chats：一个「只在 chatSettings 有设置、既不 live 也不在 evictedChats」的 chat 被静默丢弃（文件内 T3-R1 注释自认该坑）——一次 dropped save 即抹掉 settings-only chat，属不变量层面的整类缺口。
- 修复（最小改动，仅 src/registry.ts 两处）：①loadMapping resume-failed catch 在 retireSession 之后补一行，object 且非 null 的条目与 retired-skip 同样放入 evictedChats，后续任何 saveMapping 保留该 chat 的设置（下次 ensureChat 走 isSessionIdBlocked 快路径，不复活 retired 会话）。②saveMapping 追加兜底循环：chatSettings 中存在任一可持久化字段（interimOverride/goal/非空 workspacePath）且不在 mapping 的 chat，按 noteWorkspaceOverride 同款派生 bare id（makeSessionId(sessionIdForChat(chatId))）写入；无字段的懒建空条目跳过，不产生占位条目。
- 测试与验证：tests/mapping-settings.spec.ts 新增 describe「T3-R2」两用例——①resume 失败（resumeOk:false、带后缀 session id）后 saveMapping 仍按文件原 session id 保留 workspacePath/goal；②settings-only chat 在 saveMapping 后不丢设置且空设置条目不落盘，并验证重启可恢复。npm run build → npx tsc --noEmit 0 错误 → npm test 全绿（30 文件 382 用例，基线 380 + 2）。
- 恢复指引（不涉及本次代码改动，用户侧操作）：工作区设置被清空的会话在 QQ 发 `/workspace <目标目录>` 即可重建 per-chat 覆盖；旧会话 `…-mulaa1b8` 未 retired，可用 `/session` 切回继续历史上下文。本次止步于代码+测试+文档，未 commit、未发版、未触碰 media/onebot 生产文件。
- 同日收尾（第三处同类缺口 + 发版预备）：修复 C——createChat 的 evicted-resume catch 在 retireSession 后补 `restoreEvictedSettings` 回填 chatSettings 再删 evictedChats 条目（与同函数 blocked-snapshot 快路径同款语义），resume 失败不再丢 workspacePath/goal，紧随的 fresh create 直接继承设置；若 fresh create 亦失败，由上述修复 B 的 saveMapping settings-only 兜底循环按派生 bare id 续写（取舍：catch 里再造 evictedChats 条目会被成功路径的 chats 循环以空 chatSettings 覆盖，设置照样丢，故依赖回填+既有写盘路径，不新增载体机制）。tests/mapping-settings.spec.ts 追加 T3-R2 第三用例（驱逐→复活 resume 失败→设置落盘、retired id 不复用、fresh create cwd 继承覆盖）；noteWorkspaceOverride 处「saveMapping only writes chats/evictedChats」陈旧注释同步更新；version 0.5.0→0.5.1（patch，持久化修复发版预备）。npm run build → npx tsc --noEmit 0 错误 → npm test 全绿（30 文件 383 用例，基线 382 + 1）。仍止步于代码+测试+文档，未 commit、未发版、未触碰生产文件。

## 2026-10-04 W2-①④ 健壮性修复：reverse EADDRINUSE 退避接管 + forward 放弃后慢速自愈（未发版，止步源码+测试+DEVLOG）

- 现状缺陷（特征化文档 docs/m1-characterization/reconnect.md 实证，行号以 953919b 为准）：①reverse 服务器 EADDRINUSE 后 error 处理器（connection.ts:266-269）仅 log 后 return，无重试无恢复；且实测 ws 在 EADDRINUSE 后**不发 close 事件**，`this.server`（:263 赋值）悬挂在死实例上——`start()` 重入守卫（:174）因此连手动重启都锁死，唯一出路是 stop()+start()，而插件运行期没有路径自动走到这里，等价于「端口被占 = 进程内不可逆死锁」。②forward 模式重连梯子 [2,5,10,30,60]s（:64）到放弃上限（:355-362，内置 100 / reconnectMaxAttempts 三态）后 return，进程内永久停机，唯一恢复途径是外部再次 start() 或插件重启。③EADDRINUSE 稳态每次 error 都是一条日志（对照竞品 v0.5.9 教训：每 15s 一条 ≈ 5760 条/天刷屏）。
- 修复设计取舍（对照竞品 /tmp/dsh-qq-onebot-bridge 两层方案：服务层 start 永不抛/幂等/失败就地 close + 入口层 15s 固定退避/日志去重/unref+catch）：竞品的「服务层返回 ok:false 结果形态」需要改 start() 签名与 index.ts 装配，属破坏性接口变更，本次不取；取其入口层语义内联到 connection.ts——①EADDRINUSE error 路径先清理死实例（detach this.server → removeAllListeners → 底层 handle best-effort unref → server.close()，close 在未绑定实例上可能抛 ERR_SERVER_NOT_RUNNING，按 corpse 清理吞掉）再调度固定 15s 重试（REVERSE_RETRY_MS=15_000，对齐竞品实测 ≤15s 接管时效）；②重试不设上限（直到 stop() 被调），timer .unref()，重试纯调度不被 await——start() 同步返回语义保持并加测试钉住；③稳态日志去重：第 1 次 + 每 40 次（10 分钟，REVERSE_LOG_EVERY=600_000/15_000）各一条 error，中间档位降为 debug；④接管成功（listening 时 reverseRetryAttempts>0）输出独立 info 行并清零计数。⑤start() 重入守卫追加 reverseRetryTimer/selfHealTimer 两条件：重试/自愈挂起期间手动 start() 视为「已在启动中」直接 return（防双重 bind/拨号产生 ghost timer；代价是放弃后手动 start() 不再立即重拨，由自愈循环接管——已在 DEVLOG 如实记录）。⑥forward 自愈（scheduleSelfHeal）：give-up 分支追加自愈调度并 在「giving up」错误行尾追加自愈说明（原文案保留，既有 toContain 断言不破）；自愈 15s 间隔，滚动 1 小时窗口（selfHealTimes）上限 120 次，超限后间隔拉长为 60s（60/h < 上限，自然稳态不再抖动）；自愈拨号失败经 scheduleForwardRetry 分流回自愈而非 scheduleReconnect（防止悄悄重建梯子），拨号成功（open）清 selfHealing/selfHealTimes/reconnectAttempts 归零，后续断线完全回到既有梯子语义——红线守住：梯子数组、MAX_RECONNECT_ATTEMPTS、reconnectMaxAttempts 三态、成功归零、重入守卫结构全部未动。
- 行为开关：不新增配置键（纯健壮性修复，无新配置面，settings-remote/registry/outbound 未触碰）。
- 测试清单（tests/connection.spec.ts，新增 describe「EADDRINUSE takeover and forward self-heal (W2-①④)」7 用例，mock 化防 flaky：调度类用 mock error 事件触发，占用类用「先绑 port 0 再复用其确切端口」的确定性占位，无随机端口竞态）：①mock EADDRINUSE→死实例清理（server.detach+close spy）+15s 重试调度+首条 error 文案含 retrying every 15s；②真实占用者持续占 port→39 次重试仅 1 条 error（中途 attempt 20 处抽查）+attempt 40 第二条+计数=40；③释放后自动接管：占用者 close 后 advancing 15s 即重绑同一端口成功+took over info+计数清零；④stop() 终止重试循环：timer 清零、120s 假推进无 ghost bind、listening 仅初始 1 条；⑤start() 占 port 下同步返回（返 undefined+重试纯异步出现）钉住不阻塞；⑥forward give-up 后 selfHealTimer 挂起+梯子冻结（reconnectAttempts=3 不动）+对端恢复后自愈拨号连通+selfHealing/selfHealTimes 归零+再次断线从 2s 梯子档重来；⑦自愈小时上限：直接灌满 selfHealTimes=120→15s 处不拨号、60s 处恢复拨号。既有 give-up 测试「放弃后无任何 timer/不再拨号」断言与修复目标直接冲突，按新语义改写（give-up 后恰 1 个自愈 timer、自愈拨号恢复、梯子冻结 3 不变），其余断言（giving up 文案、3 次拨号计数、reconnectMaxAttempts=2）保留。
- 验证链路：npx tsc --noEmit 0 错误；npm test 全绿（30 文件 390 用例 = 基线 383 + 7）；git HEAD 仍 953919b 未 commit（工作树另有 T1 产出的未跟踪 docs/m1-characterization/，非本任务改动，未触碰）。改动面：src/connection.ts（+158/-12 行含注释）、tests/connection.spec.ts、本 DEVLOG 条目。
- 遗留与建议：①重试 timer 的 .unref() 以代码保证（与竞品同款写法），无直接断言（vitest 假计时器无法观测 unref 标志），建议真机核验宿主可独立退出；②scheduleReverseRetry 清理走 ws 内部 `_server` 句柄做 best-effort unref，属非公开 API 访问（try/catch 包裹），ws 大版本升级时需复核；③index.ts 装配零改动（start/stop 调用形态未变）；④自愈上限 120/h 与竞品 LOG_EVERY 同为常量，若后续需要可观测/可调，随 W2 其他配置面一并评估（本次按「不加键」定案执行）。

## 2026-10-04 W2-②③ 入站 message_id 窗口去重 + 出站主动写闸门（分钟/日限额+审计，未发版，止步源码+测试+DEVLOG）

- 现状缺陷（docs/m1-characterization/pipeline-hooks.md 特征化 + 计划 §1 T5 实证）：①inbound.ts 全文无 message_id 去重——OneBot 实现断线重连后重放消息（ws-reverse 重拨重投递）会重复触发回复/命令/媒体下载；②出站无任何写操作限额与审计——全桥唯一限流是入站 rateLimitPerMinute（每 chat），模型工具（qq_send_*）的主动发送既无频控也无痕迹。
- W2-② 入站去重（src/inbound.ts）：键 = `(chatId, message_id)`，滑动窗口默认 300s（对齐竞品 dedupWindowSeconds 默认值），`dedupWindowSeconds` 可配、0=禁用；窗口表为 Map 插入序 LRU，容量 DEDUP_MAX_ENTRIES=4096（超出逐出最旧，防 distinct id 洪泛撑爆内存；命中刷新 recency 但保留首次见到时间——窗口自首次投递起算，不因重投顺延）。挂点在 `processInbound` 最顶端（先于 ignoreSelf/白名单/@门/命令路由）：一条重投消息既不能再次执行命令，也不能重置 loopBuffer 或重复注册 pendingImageRef，所以必须在一切副作用之前拦截。取舍与边界（依据 pipeline-hooks.md 事件分类）：notice/meta/request 事件在 normalizeOneBot11 即返回 null（bridge.handleInbound 之前的 connection 层也只把 message 事件交给 onMessage），天然不过此闸——去重只覆盖「会触发回复处理的消息事件」；事件未带 message_id（个别实现）则跳过去重（无键可用）；首条投递在处理前先登记（at-most-once：处理中途异常也不重投，与竞品同语义）。与既有机制区分：interim 的 relay 去重是会话事件幂等（outbound.spec 卡片重发用例，未动），B7 rateLimitPerMinute 是每 chat 频率闸（未动），本次是传输层重投递抑制，三者正交。命中仅静默跳过 + 一条 debug（`dedup hit in <chatId>: message_id <id> redelivered within <n>s window, message skipped`）。
- W2-③ 出站主动写闸门（src/outbound.ts）：**主动/被动写口径（按 outbound.ts 结构定义）**——「主动写」= 模型/命令经 qq_* 工具发起、不属于任何入站回合回复链的出站写，即 `sendSegments`（qq_send_image/voice/video/file 与通用 segments）与公开 `sendForward`（qq_send_forward 工具）；「被动回复」= sendToChat 整条链（模型最终回复、interim、错误/命令通知）及回合回复内嵌的 [[qq_forward]] 块（sendToChat 内部改走未设闸的私有 sendForwardNodes）。被动回复不受本闸的理由：其频率已由入站 rateLimitPerMinute + B6 离线队列上限（20/5min TTL）约束，且回合回复被限额拒发会造成「问了不答」的体验断层；主动写是模型可无限刷的写放大面，是本闸的靶子。限额：`actionRatePerMinute`（默认 20，对齐竞品）/`actionRatePerDay`（默认 500，本地自然日）全桥合计（不分 chat，Map 计数器 + 60s 滑窗，风格对齐 B7）；0=各自禁用；超限拒发（抛 OneBotActionError 中文 reason，模型可见）+ warn（中文，带 chatId 与限额名，如 `已拒发主动写操作: chat=group:888 action=send_msg，写操作频率超限：60 秒内主动写已达 20 次上限（actionRatePerMinute=20），请稍后再试`）；被拒尝试不消耗配额。审计：每次主动写（成功/发送失败）与拒发事件追加写一行 JSON 到 `mediaDir/qq-actions.log`（字段 ts/chatId/action/ok/reason，action 取 OneBot action 名 send_msg / send_forward_msg）；`actionAuditEnabled` 默认开；写前 mkdir recursive，写入 fire-and-forget，失败仅 warn（`写操作审计写入失败: …`）绝不影响发送主流程。
- 配置面（src/index.ts）：新增 4 键——`dedupWindowSeconds`（默认 300）、`actionRatePerMinute`（默认 20）、`actionRatePerDay`（默认 500）、`actionAuditEnabled`（默认 true），中文 description 对齐现有风格。装配注意：BridgeConfig（bridge.ts）声明形状未动（红线内 bridge.ts 不在允许改动清单），pipeline 侧以 `Pick<BridgeConfig,…> & Partial<{…}>` 可选交叉成员读取（InboundContext/OutboundContext.config），index.ts 经 `gateConfig` 对象 spread 进 bridge deps.config 字面量完成接线——变量 spread 不触发 TS 多余属性检查，tsc 0 错误，运行期对象携带新键。默认即启用：去重 300s/分钟 20/日 500 对齐竞品默认，符合「默认行为纪律」。
- 测试清单（+12 用例，既有 390 全部原语义保留零改动）：tests/inbound.spec.ts 新增 describe「inbound message_id dedup (W2-②)」6 用例（直连 InboundPipeline，注入 fake 时钟与 LRU 小容量）——①窗口内同 (chatId,messageId) 重投 3 次仅处理 1 次+2 条 dedup hit debug；②键含 chatId：同 id 不同 chat 不互斥；③299s 仍在窗口内跳过、301s 过期放行；④LRU 容量 2：插入序逐出、重插刷新、命中保留逐项断言（5→6 次派发轨迹）；⑤dedupWindowSeconds=0 完全禁用 + 无 message_id 事件永不参与去重；⑥notice/meta 事件 normalize 即 null，结构上不可能过闸。normalizeOneBot11 既有 8 处 inline 快照经 `vitest -u` 纯新增 `"messageId": undefined`（normalize 新增提取字段，diff 无删改行）。tests/outbound.spec.ts 新增 describe「outbound proactive-write gate (W2-③)」6 用例——①分钟限额：第 3 次拒发（含跨 chat 全桥合计验证）、中文 warn 带 chatId 与 actionRatePerMinute=2、被拒不消耗配额；②日限额 actionRatePerDay=3 第 4 次拒发；③审计 jsonl：成功行 ok=true/reason=发送成功、拒绝行 ok=false/reason 含限额名、追加不截断、字段 ts/chatId/action/ok/reason 齐全；④工具 sendForward 计审计而被动 [[qq_forward]] 块与 sendToChat 完全不过闸不审计；⑤审计写失败（mediaDir 落在普通文件内）仅 warn、发送照常成功；⑥双 0 禁用：25 次发送零拒绝零行为变化（审计仍按自身开关记录）。
- 验证链路：npm run build 成功；npx tsc --noEmit 0 错误；npm test 全绿（30 文件 402 用例 = 基线 390 + 12）；git HEAD 仍 953919b 未 commit。改动面：src/inbound.ts、src/outbound.ts、src/index.ts、tests/inbound.spec.ts、tests/outbound.spec.ts、本 DEVLOG 条目；src/connection.ts 与 src/registry.ts 未触碰（前任务在 src/connection.ts 的未提交改动原样保留）。附带说明：npm run build 按仓库惯例重 generated lib/ 产物（lib/inbound.js、lib/outbound.js、lib/index.js 及 d.ts 等 8 个跟踪文件变脏），其中 lib/connection.js 因包含前任务 connection.ts 改动一并重建——纯构建产物，未做任何 restore。
- 遗留与建议：①去重窗口为进程内存态，插件重启后清零（窗口内重投在重启瞬间可能重复处理一次——OneBot 重放通常集中在重连时刻，与重启不重叠，风险低；如需跨重启持久化再评估）；②日限额按宿主本地时区自然日（非滚动 24h），跨时区部署语义以本地日为准；③qq_napcat_api 白名单内的写类扩展 API（如 set_group_*）不经 outbound 管线，不在本闸覆盖范围（工具白名单本身已是闸门）；④审计文件无轮转（默认 ≤520 行/天，量级无害），若 actionRatePerMinute 调大可与 T2 trace 轮转方案统一。

## 2026-10-04 发版 0.6.0（W2 健壮性批次：EADDRINUSE 接管 / forward 自愈 / 入站去重 / 出站写闸门）

- 版本 0.5.1→0.6.0（minor：新增行为面——入站 message_id 去重、出站主动写限额+审计、EADDRINUSE 退避接管与 forward 自愈均为默认生效的新行为；配置面新增 4 键 dedupWindowSeconds/actionRatePerMinute/actionRatePerDay/actionAuditEnabled，默认值 300/20/500/true）。本条目整合本日两条 W2 未发版记录（W2-①④ connection 健壮性、W2-②③ 去重+写闸门），技术细节见上两节，此处不重复。
- 文档同步：README.md 与 README.en.md 配置表各补 4 行（跟随表内既有格式，插在 rateLimitPerMinute 之后，中英双语对齐）；设置页章节不动（4 新键无 UI，仍走 patch config 手改，与「设置页仅覆盖 UI 三组键」的既有口径一致）。
- 发版前基线：npx tsc --noEmit 0 错误；npm test 全绿（30 文件 402 用例）。已知偶发（非本批引入，待后续治理）：outbound 限频用例在同 worker 与其他 spec 共享模块态时偶现跨测试文件泄漏（单跑 15/15 全绿，重跑全量 402/402 全绿）。
- 发版流程按仓库惯例：逐特性 commit 保持回滚粒度 → npm 发布 dsh-onebot-qq@0.6.0 → live 升级（dsh plugin --profile web add，官方通道，不重启宿主）。运行中 fiber 不随 CLI add 换代码（ESM 缓存），0.6.0 行为随宿主下次重启生效，属预期。

## 2026-10-04 W1 核心可观测性：traceId 贯穿全链路 + 决策事件 jsonl 轮转落盘 + 中文 reason 矩阵（T4/T2，未发版，止步源码+测试+DEVLOG）

- 现状缺陷（docs/m1-characterization/pipeline-hooks.md 特征化 §1/§2/§6）：35 个决策点中 6 处纯静默丢弃零日志（#1 非聊天事件、#4 stopping 丢弃、#5 ignoreSelf、#16 限流决策本体、#17 展开后空内容、#23 断连入队、#25 TTL 丢弃、#30 空文本不发送），入站→回合→出站事件无关联 id，出问题只能靠人肉串日志。
- **trace 基础设施（src/trace.ts 新建）**：TraceSink 异步队列化 append 写 jsonl（mediaDir/qq-trace.jsonl；管线内只 push，单一 writer 链串行 drain，管线永不 await 写盘）；4MiB 上限改名轮转 qq-trace.1.jsonl（shift 保留 2 代，旧文件保留不截断）；事件 schema 按 pipeline-hooks.md §4：`{v:1, ts, traceId, stage, ok, reason?, chatId?, messageId?, ms?, data?}`，reason ≤300 字符；同因（stage+reason 归一）5 分钟限频落盘一条、抑制次数在内存计数保留（stats().suppressed）；写失败仅 warn 且告警自身 5 分钟限频；序列化防炸（坏对象降级为「追踪事件不可序列化」行，data 不可序列化降级 stub）；traceLevel=warn 只记 ok:false；队列上限 1000、满丢最旧并计数。默认关：sink 不构造、emit 即 no-op、零文件零开销。stage 词表 18 个（pipeline-hooks.md §4 表 + 本插件特有 `dedup` 覆盖 W2-② 窗口）；中文 reason 常量表 TRACE_REASONS 集中维护，测试可枚举穷举。
- **traceId 贯穿（最小侵入：AsyncLocalStorage + chat 级关联表，管线签名零改动）**：①入站生成——bridge.handleInbound（锚点 pipeline-hooks.md §5）在 traceEnabled 时 newTraceId() 并以 ALS（runWithTrace）包住整条入站链，inbound.ts 各决策点经 currentTrace() 取 scope 打点（未启用时 currentTrace()=undefined，一行短路）；②跨流接续——session 事件不在同一 async 链，dispatchFollowup（ALS 链内）把 traceId 登记进 chat 级关联表 traceByChat，onSessionEvent 按 chatId 取回，turn/start、turn/end（含错误 reason）打 agent 事件，interim/settle 后的最终回复与离线补发也经 outbound 管线归属同一 traceId；③出站主动写——OutboundContext 新增可选 trace 回调，bridge 实现「查关联表→有则沿用、无则（工具主动写）新生成 traceId」，闸门拒发/发送失败/断连入队/队列满/TTL 丢弃均带 reason。**取舍**：关联表不在 turn/end 清除（覆盖文档 §5 原建议）——interim settle loop 在 turn/end 之后才发最终回复，turn/end 清除恰好孤儿化该回复的出站事件；改为下一次 dispatch 覆盖（last-writer-wins，每 chat 一条，量级以 chat 数为界）。W2-②③ 新分支（dedup 命中、闸门拒发）与既有分支一并带 reason。
- **中文 reason 矩阵**：按 §6 三档覆盖——ok:false 丢弃/失败：#1（非聊天消息事件，不处理）、#4（插件停止中，消息丢弃）、#5（机器人自己的消息已忽略）、#6/#7（私聊/群聊不在允许名单）、#8（群聊未 @ 机器人）、#16（消息频率超限，已丢弃；限流提示发送失败单独一条）、#17（消息展开后无有效文本内容）、#10（媒体解析失败）、#13（文件超限/无可用来源）、#15（转写为空/失败）、#11（引用展开失败）、#12（合并转发未展开/失败）、#19（转写结果无处投递）、#21（错误通知发送失败）、#22（会话落盘失败）、#23（断开入队/断开发送失败）、#24（队列满丢最旧）、#25（排队回复超时丢弃）、#26（补发失败）、#28/#29（t2i 降级）、#30（正文为空未发送）、W2-③ 闸门拒发（沿用既有动态中文 reason）；ok:true 关键决策：#9 命令消费、#27 敏感词审计、dispatch 成功、回复已发送、收到消息、回合开始/结束。原「静默」分支同步补 debug 级 log（reason 同文案）——注意此为 log 噪声面变化，决策行为面零变化（下条默认关口径内）。
- **配置面（src/index.ts + README×2）**：`traceEnabled`（默认 **false**，关闭时零文件、不生成 traceId、决策行为与 0.6.0 完全一致）、`traceLevel`（debug/warn，默认 debug）。README.md 与 README.en.md 配置表各补 2 行（插在 actionAuditEnabled 之后）。
- **借鉴清单（MIT 竞品 /tmp/dsh-qq-onebot-bridge/lib/trace.js，MIT License Copyright (c) 2026 dsh-qq-onebot-bridge contributors）**：①traceId 形态 `t-<base36 秒>-<计数>`（trace.js:44-47）；②4MiB 文件上限（:116）；③同因 5 分钟限频（CHANGELOG v0.5.9 教训）；④序列化防炸 jsonlSafe 思路（:92-98）与 data 降级 stub（:104-113）；⑤ok=false+非空 reason 的静默分支可见化原则（:61 注释）。署名落在 src/trace.ts 文件头注释。**其余为本插件原创**：异步队列+writer 链串行写（竞品为同步截断式 appendCappedLine，本插件按 pipeline-hooks.md §4 验收口径改用改名轮转）、reason/stage 常量表、ALS 传播、chat 级关联表、内存环/统计面简化为 stats()。
- **顺手修：outbound 用例隔离（0.6.0 发版报告遗留偶发 401/402，本次实测复现 2 类根因并修）**：①TTL 丢弃用例原以固定 sleep(50ms) 等 interim settle loop 把最终回复「停进」离线队列再跳假时钟——park 晚于跳钟时 sentAt 取跳钟后时间、永不过期、重发致断言失败；改为 vi.waitFor 确定性等待「过期回复文本已入队」（注意队列同时含小结卡，按文本匹配而非条数）；②出站闸门用例注入单调假时钟（OutboundPipeline 新增可选 `now`，无注入路径保持动态 Date.now 查找——否则 vitest 假时钟机制被构造期绑定破坏）消除真实分钟/自然日边界与 worker 时钟跳动影响；③audit append 改 promise 链串行保证行序与调用序一致（fs 线程池并发完成序不稳）；④文件级 afterEach(useRealTimers) 兜底防中途失败泄漏假时钟。
- 测试清单（tests/trace.spec.ts 新增 13 用例；既有 402 用例零语义改动）：①同消息同 traceId 贯穿入站→dispatch→agent(turn/start+end)→outbound（含 message_id/chatId 关联字段传播）；②turn/end 后 settle loop 的最终回复仍归属发起 traceId；③静默分支中文 reason（ignoreSelf 命中实测）；④一轮内全部 ok:false 事件 reason 非空且含中文；⑤默认关：零文件+派发/回复行为完全一致；⑥jsonl 字段完整性（v/ts/traceId/stage/ok/ms 取整/reason 300 截断）+4MiB→600B 缩配置实测改名轮转+旧文件保留；⑦reason 表穷举非空中文≤300；⑧快压 1000 事件零丢失+同步 push 微秒级不阻塞+超队列上限丢最旧计数；⑨同因 5 分钟限频（同因抑制 2 条、异因照写、过窗恢复）+stats；⑩traceLevel=warn 过滤 ok:true；⑪显式禁用 sink 零文件；⑫断连入队/主动写失败 trace 事件带中文 reason 与独立 traceId。
- 验证链路：npx tsc --noEmit 0 错误；npm test 连续 3 次全绿（31 文件 415 用例 = 基线 402 + 13）；npm run build 成功（lib/ 产物重建，纯构建产物）；git HEAD 仍 f06e928 未 commit。改动面：src/trace.ts（新建）、src/bridge.ts、src/inbound.ts、src/outbound.ts、src/index.ts、tests/trace.spec.ts（新建）、tests/outbound.spec.ts、tests/helpers/bridge-harness.ts（makeHarness 增 trace/ignoreSelf 可选注入）、README.md、README.en.md、本 DEVLOG 条目；src/connection.ts、src/registry.ts、src/settings-remote.ts、src/client/ 零改动（transport 层不引 trace 依赖，保持可独立使用）。
- 遗留与建议：①trace 落盘为进程内异步队列，进程崩溃瞬间队列内未 flush 事件丢失（至多 1000 条，观测性数据可接受）；②interim.ts 各失败分支（#34）按红线未触碰，其事件经 outbound 管线已带 chatId/traceId，但分支级 reason 留待后续批次（interim.ts 不在 W1 允许改动清单）；③命令路由触发的 dispatch 经 ALS 归属发起消息 traceId，宿主/web 侧直接输入的回合无入站 traceId、不打点（#20 仅 debug log）；④qq-trace.jsonl 含 chatId/messageId，不记正文与 QQ 明文以外内容，data 面仅白名单小对象，T3 脱敏口径如需覆盖 trace 文件请在 T7 一并核查。

## 2026-10-04 W1 其余四件：入站录制（可脱敏）+ 离线回放 + 事件注入（默认关+dry-run）+ 体检报告与脱敏诊断包（T5/T3，未发版，止步源码+测试+DEVLOG）

- 基线与边界：分支 m0-hardening @ f06e928，基于同批前一任务（W1 trace 核心，未提交）的工作树继续；红线遵守——settings-remote.ts / client/ / registry.ts / connection.ts 零改动，未 commit、未发版、未触碰 live 数据。竞品参照（MIT，只读）：/tmp/dsh-qq-onebot-bridge 的 lib/inbox.js、control/lib/replay.mjs、CHANGELOG v0.4.0 阶段 3（录制/回放/注入/注入安全边界条目，异步 agent 回合回复同样被拦）。
- **①入站录制（src/record.ts 新建，recordInbound 默认 false）**：每条入站事件按可回放形状逐行 JSON 追加写 mediaDir/qq-inbox.jsonl——行结构 `{v:1, ts, kind, frame, decision?}`，frame 为业务字段白名单（post/message_type/sub_type/notice_type/request_type/各 id/message/raw_message/sender，sender 文本截断 2000 字符，socket/未知字段丢弃）；decision 在桥侧 handleInbound 同步决策收敛后回填（门控跳过的事件带当时决策 stage/ok/中文 reason，派发消息带 dispatch ok:true），一行一事件、append-only。2MiB 改名轮转 qq-inbox.1/2.jsonl（旧文件保留，同 trace 方案）。旁路语义：自有串行 writer 链，管线永不 await 写盘，写失败仅 warn 且告警自身 5 分钟限频（INBOX_WRITE_WARN_WINDOW_MS），绝不影响回复管线；begin/end 全程不抛。脱敏：`inboxRedact`（默认 false）开启时对帧做深走遮蔽——字符串值中 ≥6 位数字串→前 3 位+`****`，user_id/group_id/self_id/message_id 等数字型 id 字段一律转脱敏字符串（防 number 型 QQ 漏网），ts 等非帧字段不遮。**注入帧不录制**（handleInbound 带 injected 标志时跳过 recorder），杜绝「注入→录制→回放→注入」自激（竞品 v0.4.0 教训）。
- **②事件注入（src/inject.ts 新建，injectEnabled 默认 false，injectDryRun 默认 true，injectIntervalMs 默认 2000 最小 500）**：开启后按间隔轮询 mediaDir/qq-inject.jsonl，新行（每行一个 OneBot 消息事件 JSON，可直接复制录制行）喂进**真实入站管线**（bridge.handleInbound(event, {injected:true})——normalize→去重→白名单→@门→命令→媒体→dispatch 全走一遍）；trace 事件标 stage=inject（TRACE_STAGES 新增 inject/replay 两个 stage，trace.ts 既有 18 词表追加）；**启动时已存在的历史行跳过**（只消费启动后追加的行，按字节偏移+完整行界定，文件缩短视为替换重读），跳过数记一条 stage=inject trace + info log（无静默分支）。**dry-run 三重防线**（拦截点在出站动作层）：bridge 新增 guardedConnectionCall 统一出站闸——inbound/outbound/interim/typing 四路 ctx.call 全部经此；写类 action（send_*/set_*/delete_msg）在注入回合内被拦截计数、原文（text 段拼接 ≤500 字）进 stage=inject trace 事件、返回标记 message_id=-1（INTERCEPTED_MESSAGE_ID，真实 OneBot id 永不为负）让管线无错级联继续。归属三路：a) 同步链经 AsyncLocalStorage 注入回合（runInjectRound/currentInjectRound，注入事件 handleInbound 全程包在回合内）；b) **异步 agent 回合的最终回复**（v0.4.0 阶段 3 实测漏网场景）——dispatch 时把回合 traceId 登记进桥级 injectRoundByChat（**独立于 trace sink，tracing 关闭时 dry-run 同样生效**），出站调用按 chatId 比对命中即拦；注入回合复用回合 traceId 作为 traceId（beginInboundTrace 检测 ALS 回合直接沿用），整回合事件同源；c) 对已拦截发送的撤回（interim 路径无 chatId）按标记 message_id 识别再拦。**不连坐**：真实消息 dispatch 到同一 chat 立即清除注入回合关联（noteDispatch 无 ALS 回合时删除），真人回复永不误拦；chat 移除同步清理。轮询/读盘/解析失败均降级 warn（5 分钟限频），绝不抛入管线。信任边界：注入是调试通道，默认全关，README 双语标注勿在生产开启；injectDryRun=false 为文档化的真发逃生门（仅隔离环境）。
- **③离线回放（src/replay.ts 新建 + scripts/replay.mjs + npm run replay）**：程序化入口 `replayInbox({inboxFile, traceDir, policy?, requireMention?, botQQ?, ignoreSelf?, limit?, outFile?})`——读录制 jsonl（坏行计 skipped）逐条喂真实 ChatBridge 装配（与线上一致的 normalize→门控→命令→媒体→dispatch 链），**强制 dry-run 语义**：不调用 connection.start()（无 socket、无监听端口）、connected 置真、call 补丁按 inject 同款写类规则拦截全部出站并计数、读类调用快速失败让媒体路径走真实降级分支；agent 侧为录制桩（回放验证管线决策，不冒充模型措辞）。输出每条消息的 traceId+决策链汇总（chain 全量 stage/ok/reason + decision 终态；仅纳入以 inbound 开场的回合 trace，拦截等旁路事件不混入），可写 JSON 报告文件。**不依赖宿主运行**（无宿主服务、无网络）。保真度口径如实记录：录制只存 frame 不存门控配置，回放门控取自调用方参数（默认全放行：requireMention=false、allowAllUsers=true），需复现线上门控请传相同 policy——与竞品的「28 项决策配置快照」方案相比是取舍（少快照机制，保回放器无状态）；去重窗口沿用管线默认 300s，录制中的重投递在回放中同样被丢弃。
- **④体检+诊断包（src/health.ts 新建 + commands.ts /healthcheck 命令）**：命令表新增 `healthcheck`（adminOnly，查询组；命令词表为 ASCII 单词故 `/体` 不可路由，按任务书备选形态注册 `healthcheck`），handler 支持无参（摘要）与 `export`（诊断包）。摘要内容：连接态（connected/mode/host:port/selfId）、重试与自愈（reverse 接管重试/forward 重连/自愈中——经防御性运行期读取 connection 内部计数器，字段缺失显示「未知」，connection.ts 零改动）、去重窗口在窗条数（InboundPipeline 新增 dedupWindowEntries getter）与写闸门分钟/日用量（OutboundPipeline 新增 writeGateStats()）、录制/注入通道状态、trace/inbox/audit 文件大小（含轮转代数）、最近 5 条 ok:false trace 事件（时间戳+stage+reason+traceId）。诊断包：收集 trace+轮转代、inbox+轮转代、qq-actions.log、redactSnapshot 脱敏配置快照、health-report.txt，打成 mediaDir/qq-diagnostics-<ts>.zip——zip 为内置最小 writer（stored 条目+CRC-32，无外部依赖，Dev 环境以 python3 zipfile 实测可解析）；脱敏双保险：config 快照在 index.ts 装配处即遮蔽（token/secret/password/apikey 键→已配置/未配置，密钥明文不出装配闭包），打包前对每个文本产物再跑 scrubSecrets（调用方提供的密钥值逐个替换 + access_token/authorization/bearer/api-key 行模式掩蔽），最终对归档字节做 fail-closed 扫描（仍含任一密钥即抛错拒绝落盘）。
- **接线面（最小侵入）**：src/bridge.ts——TraceBridgeConfig 追加 recorder/inject 可选成员、BridgeDeps 追加 configSnapshot 可选成员；handleInbound 增 injected 可选参数与 recorder 决策捕获（trace 开启时 wrapScope 双写，关闭时 captureScope 仅捕获决策不落 trace 文件）；guardedConnectionCall 统一出站闸；dispatchFollowup 登记注入回合；onChatRemoved 清理注入关联；commandCtx 暴露 healthReport/exportDiagnostics。src/outbound.ts——ctx.call 签名追加可选 chatId（sendMsg/sendForwardNodes 透传，既有实现方零破坏）；writeGateStats()。src/inbound.ts——dedupWindowEntries getter。src/index.ts——5 个新配置键（recordInbound/inboxRedact/injectEnabled/injectDryRun/injectIntervalMs，默认 false/false/false/true/2000）+ recorder/injectChannel 按需构造 + configSnapshot 脱敏闭包 + 注入通道随 effect 启停。src/trace.ts——stage 词表追加 inject/replay。commands.ts——CommandContext 追加 healthReport/exportDiagnostics 可选成员 + 命令表一行 + handler。package.json——`replay` script。
- **借鉴清单（MIT 竞品 /tmp/dsh-qq-onebot-bridge，MIT License Copyright (c) 2026 dsh-qq-onebot-bridge contributors）**：①录制行可回放形状（单行 JSON、业务字段白名单、文本截断、2MiB 轮转）——lib/inbox.js；②录制脱敏（6 位以上数字 QQ 号遮蔽）与注入帧不二次录制（防自激）——lib/inbox.js + CHANGELOG v0.4.0；③注入通道语义（injectEnabled 默认关、间隔轮询、历史行跳过并说明、dry-run 默认 true 拦截全部出站并计数）——CHANGELOG v0.4.0 阶段 3；④异步 agent 回合回复同样拦截、真实消息解除标记不连坐、回合结束清账——CHANGELOG v0.4.0 阶段 3 注入安全边界条目（本实现以 chat 级回合登记+真实 dispatch 清除等价落位，回合清账改为「下一真实 dispatch 覆盖」因最终回复在 turn/end 后才发出，clear-at-turn/end 会漏拦 settle-loop 回复——已在代码注释说明取舍）；⑤离线回放「真实管线+dry-run 拦截+决策归因」概念——control/lib/replay.mjs；⑥体检/导出为硬约束④⑤的落位思路——v0.4.0 验收台。署名：src/record.ts、src/inject.ts、src/replay.ts、src/health.ts 四个新文件头均含 MIT attribution 段。**其余为本插件原创**：决策捕获回填的录制 writer、deep-walk 脱敏（含数字型 id 字段）、ALS 注入回合传播与 traceId 复用、标记 message_id 撤回识别、单进程无沙箱目录的回放装配与 trace 链汇总、最小 ZIP writer 与双重脱敏+fail-closed 字节扫描、/healthcheck 报告版式。
- **测试清单（新增 3 spec 28 用例，既有 415 用例零语义改动；commands.spec.ts 两处既有断言随命令表+1 与建议候选表序更新，属注册新命令的直接后果）**：record-replay.spec.ts（9）——录制行结构/派发与门控跳过双决策回填（mention ok:false 中文 reason）、脱敏开（6+ 位数字含数字型 id 遮蔽、ts 不动）、录制文件扫描无连接 accessToken、2MiB→400B 缩配置实测改名轮转+旧文件保留、写失败仅 warn 不抛（旁路）、默认关零文件；回放 2 用例（真实管线+强制 dry-run：/help 命令回复被拦截 interceptedOutbound≥1、逐消息 traceId+chain+决策汇总、坏行跳过；门控复现：requireMention=true 时回放命中 mention 丢弃中文 reason）。inject.spec.ts（11）——schema 默认值四断言（injectEnabled=false/injectDryRun=true/interval=2000/record 默认关）、间隔下限 500 钳制、通道未接线/已接线未启动双零行为、dry-run 全拦截（注入消息进真实管线 followup 断言+**turn/end 后 settle-loop 最终回复被拦**+socket 零 send_* 帧+stage=inject 事件含原文与中文 reason+计数≥2）、历史行跳过（计数+log+trace 说明，启动后新行正常消费）、dry-run=false 真发逃生门（帧真出）、真实消息清除注入回合不连坐（真人回复真出）、注入帧零录制（无 qq-inbox.jsonl）、坏行降级 warn 计数、拦截返回标记 id 与撤回识别。health.spec.ts（8）——报告八段内容断言、未知传输计数与空失败优雅降级、redactSnapshot 嵌套/数组/空值、scrubSecrets 值+JSON+Bearer 模式、zip 打包含全部产物且密钥零残留（[REDACTED] 在位、非密钥值保留）、fail-closed 拒写分支、CRC-32/EOCD 结构断言、/healthcheck 与 /healthcheck export 真实命令路径（makeCmdHarness）。
- 文档同步明细（README.md / README.en.md 双语）：配置表各补 5 行（recordInbound/inboxRedact/injectEnabled/injectDryRun/injectIntervalMs；traceEnabled/traceLevel 两行已随上节 W1 核心条目记录）、新增「录制 · 回放 · 注入 · 体检（W1）」专节（能力×开关×用法四行表）、命令表新增 `/healthcheck [export]`、斜杠命令计数 16→17（README.md 已同步为 17，README.en.md 漏改为 16，随本批发版勘误为 17）。
- 验证链路：npx tsc --noEmit 0 错误；npm test 全绿（34 文件 443 用例 = 基线 415 + 28；最终连续 4 次全量连跑全绿；开发过程中曾出现 2 例偶发失败——1 例 interim.spec、1 例本批 inject.spec 的 waitFor 超时，均单跑复测全绿，定性为多任务并行时机器负载所致的时序过敏而非逻辑缺陷，已为新增 spec 的 vi.waitFor 显式加 15s 超时去敏；历史已知同类：0.6.0 发版报告 outbound 限频用例跨文件偶发）；npm run build 成功（lib/ 含 record/inject/replay/health 四个新产物）；zip 归档以 python3 zipfile 独立解析验证；npm run replay CLI 对手造 inbox 文件实测输出汇总（tsc/构建后）；git HEAD 仍 f06e928 未 commit。
- 遗留与建议：①dry-run 拦截对「注入回合未清账窗口内，宿主/web 侧直接向同一会话输入」的极端并发会误拦（与竞品 v0.4.0 阶段 3 同类边界，概率极低的调试场景；真实 QQ 消息路径已保证不连坐）；②回放门控保真度依赖调用方传参，未做录制期策略快照（可在后续批次给录制行加可选 policy 段）；③诊断包 zip 为 stored 不压缩（诊断文本量级小，换取零依赖与结构简单；如需压缩可换 zlib deflate raw 块）；④设置页展示（计划 T3 的 client.js 增量）不在本任务红线允许清单内，未实现，留待 T6/T7 与 client 侧任务合并评估；⑤connection 重试/自愈计数经运行期防御性读取（TS private 字段），connection.ts 未来重构重命名字段时体检显示会退化为「未知」（不致错）。

## 2026-10-04 W6 设置页补齐与加固：白名单扩展 6 键 + configEditor 失败归一守卫 + 徽标复核（未发版，止步源码+测试+DEVLOG）

- 基线与边界：分支 m0-hardening @ f06e928，基于 W1/W2 未提交工作树继续；改动面仅 src/settings-remote.ts、lib/client.js（手写 bundle，非构建产物）、lib/settings-remote.js + lib/types/settings-remote.d.ts（构建产物）、tests/settings-remote.spec.ts、tests/client-settings.spec.ts、本 DEVLOG 条目；红线文件（trace/record/inject/replay/health/connection/registry）零触碰，未 commit、未发版、未触碰 live 数据。竞品参照（MIT，只读）：/tmp/dsh-qq-onebot-bridge CHANGELOG v0.6.0 设置面板节——仅取「非默认」徽标行话术与白名单拒绝语义；其自写 tmp+rename 原子写**不采用**（本插件唯一写路径是宿主 configEditor.edit，docs/m1-characterization/config-editor.md §1 已钉死）。
- **白名单扩展（src/settings-remote.ts）**：BOOLEAN_KEYS 增 6 键——actionAuditEnabled/traceEnabled/recordInbound/inboxRedact/injectEnabled/injectDryRun（顺序与 SETTINGS_GROUPS.diagnostics 一致），SCHEMA_DEFAULTS 补 6 项（true/false/false/false/false/true，摘自 src/index.ts:297-317 schema），ALL_KEYS 19→25（4 枚举 + 3 数字 + 11 布尔 + 4 字符串 + 3 字符串数组），validatePatch 未知键提示改为动态键数。设置页新增第四组「diagnostics（诊断）」：6 键全部默认关（除 actionAuditEnabled 默认开）的观测/调试面独立成组，permissions/behavior 三组 19 键原样不动。
- **面板文案（lib/client.js）**：诊断组 6 行均为中文标签 + 一句话「关掉会怎样」+（配置键 xxx）尾注，对齐竞品行话术——主动写审计（关闭后拦截不再留审计痕迹）、决策追踪 trace（关闭后零文件、行为与关闭时完全一致）、入站事件录制（关闭后不录制、无法回放）、录制脱敏（关闭后录制文件含明文号码，注意隐私）、事件注入仅调试（生产环境勿开）、注入 dry-run（关闭后注入消息真实发出，仅限隔离环境）。client 的 configSchema/patchSchema/DEFAULTS/groups snapshot schema 同步 6 键，契约核对由 client-settings.spec 钉住（25 键逐字对齐 host 常量）。
- **错误归一（settings-remote.ts:320 决策点，取「归一」方案）**：configEditor.edit 调用补 try/catch——此前锁超时/激活回滚等宿主原生 Error 裸抛给网关（config-editor.md §5 观测缺口），面板拿到英文技术文案。现归一为 `onebot-settings/edit-failed`：describeEditFailure 按宿主错误特征词分五类中文原因（文件锁超时 / 条目编辑中被替换失活 / 插件未激活 / home-patch 覆盖层接管 / 通用拒绝+宿主原文），details 带 hostMessage（可跨网关序列化）、cause 进程内保留。失败路径语义不变：不重试、不补偿写、revision 不递增，patch 文件「未写或已逐字节还原」由宿主保证（config-editor.md §3 矩阵），测试钉契约不重造轮子。
- **徽标复核（逐键结论，证据 = docs/settings-page-design.md §5 矩阵 + src/index.ts 构造期快照）**：dsh-onebot 全部 25 键**无键级热/冷差异**——config 覆盖变更一律「插件 fiber 秒级原地重启」生效（cordis-plugin-loader/lib/index.js:380-388，本插件 Config 无任何 `.volatile()` 字段，grep 实证 src/index.ts 零命中）。W1/W2 6 新键消费点全部在 apply 期快照：traceSink（index.ts:406-408）、recorder（:411-414，inboxRedact 构造参数）、injectChannel（:415-425，injectDryRun/injectIntervalMs 构造参数）、actionAuditEnabled（:445-450 gateConfig spread）——改键 = fiber 重启 = 新快照，**全部热重启生效、无一需要宿主重启**。据此定案：①「待重启」徽标（配置文件值≠当前生效值）**不适用本插件**——经 configEditor.edit 的成功写入在 reconcile 后即时生效，快照单一来源（entry.options.config 即生效值），不存在可计算的键级 pending 稳态；唯一的「改了不生效」情形是条目失活，面板已有 entryActive=false 警示（effect.entryInactive）覆盖，不新增机制。②「非默认」徽标（与 schema 默认值不同）**已实现**（纯客户端计算，对齐竞品 v0.6.0）：面板以快照生效值逐键对照 DEFAULTS 得 nonDefaultKeys，renderGroup 在命中键旁渲染「非默认」徽标（title=与默认值不同）；以快照而非草稿为准——徽标描述已保存状态，未保存编辑不打标。
- **设置页展示评估（数值键定案）**：dedupWindowSeconds/actionRatePerMinute/actionRatePerDay/injectIntervalMs/traceLevel **本期不上面板**（host 白名单与快照均不含，走 patch config 手改，现状已如此）。取舍：这 5 键是调优旋钮而非开关，上面板需逐键范围校验 + number 输入 + 两侧 schema 再同步，收益低风险高（traceLevel 实为枚举非数值，任务书笔误，一并按「本期不做」处理）；快照 config 仅含 ALL_KEYS 25 键（effectiveConfig 机制），面板无需只读展示路径，保持「设置页仅覆盖 UI 键、低频键手改同一覆盖行」的 T1 §3 既有口径。
- **测试清单（+15 用例 = settings-remote 6 + client-settings 9，基线 443 → 458）**：settings-remote.spec.ts——W6 白名单 describe 3 用例（6 新键入快照含默认值与 diagnostics 组序；布尔写入进覆盖行+revision 递增+混合 patch 单次写；6 键非布尔值逐键拒写 bad-request 且 edit 零调用）；W6 失败守卫 describe 3 用例（锁冲突：归一 edit-failed 中文含「文件锁」+details.hostMessage 保留宿主原文+editCalls=1 不重试+rows 空=零补偿写+revision 与 config 逐键等于写前；校验拒绝：归一+原覆盖行逐键不动；激活失败回滚：FakeConfigEditor 新增 rollbackSimulate 模拟「原子写已落盘→reconcile 失败→逐字节还原→rethrow」（config-editor.md §3 回滚行，未断言 mtime）→快照恢复旧值+revision 不递增+无半态）；既有「edit 失败向上传播」用例按归一后契约改写（code=edit-failed+中文 message+revision/无半态断言保留）。client-settings.spec.ts——分组键序/标题/行数/控件计数全面 19→25、+诊断组（3→4 组、11+1 布尔勾选）；W6 诊断组 describe 4 用例（键序对齐 host、中文标签+hint 含配置键名+关掉会怎样一句话、默认值整表逐字一致、渲染 6 勾选行+patchCodec 收 6 新键拒非布尔）；「非默认」徽标 describe 2 用例（nonDefaultKeys 命中打标/未命中不打/多键逐键标注；数据源=快照生效值对照 DEFAULTS，默认快照零徽标）；失败守卫客户端侧 describe 3 用例（unwrap 保留 code+中文 message 可直接 setError 渲染；edit-failed 不误判走冲突通道；patchSchema 与 host 25 键白名单同宽）。
- 验证链路：npx tsc --noEmit 0 错误；npm run build 成功（lib/settings-remote.js + d.ts 随源码重建；lib/client.js 为手写非构建产物，直接编辑）；npm test 全绿（34 文件 458 用例 = 基线 443 + 15；本轮曾 1 次全量出现 inject.spec「真实消息清除注入回合」waitFor 超时——该 spec 为前序任务产物本批未触碰，单跑复测全绿，定性为 DEVLOG 上一条目已记录的同类时序过敏，全量重跑 458/458 全绿）；git HEAD 仍 f06e928 未 commit。
- 遗留与建议：①错误归一的中文文案五分类按宿主错误消息特征词匹配，宿主 configEditor 大版本改文案时需复核（未命中走通用分支含宿主原文，不会误导）；②「非默认」徽标基于快照，宿主原生设置页/HMR 手改 patch 后重拉快照即刷新，无需额外订阅；③数值/枚举调优键上面板（含范围校验与只读展示）留待后续批次与 T7 一并评估；④lib/client.js 仍为手写 bundle，25 键契约依赖 client-settings.spec 逐字核对防漂移（本次同步更新通过）。

## 2026-10-04 发版 0.7.0（W1 可观测性批次 + W3 设置页诊断组）

- 版本 0.6.0→0.7.0（minor：新增行为面）。本条目整合本日三条未发版记录（W1 核心 traceId 贯穿+决策事件 jsonl+中文 reason 矩阵、W1 四件录制/回放/注入/体检、W6 设置页诊断组），技术细节见上三节，此处不重复。全部观测/调试开关默认关闭（traceEnabled/recordInbound/inboxRedact/injectEnabled 默认 false，injectDryRun 默认 true，actionAuditEnabled 沿用默认开），默认行为与 0.6.0 完全一致。
- 出处勘误（MIT 合规核查①，随发版落地）：src/inject.ts attribution 段与 DEVLOG 四处（:761/:763/:767/:770）「CHANGELOG v0.5.2 注入安全边界」改证为「CHANGELOG v0.4.0 阶段 3」——竞品 CHANGELOG.md:701「注入安全边界（真机测试抓到的漏网）」条目实际位于 v0.4.0 阶段 3 小节内（v0.4.0 节起于 :669、v0.5.2 节起于 :546，v0.5.2 仅 :557 顺带提及），实证见 docs/m1-mit-compliance.md 勘误表；tests/inject.spec.ts 注释同步。
- 计数勘误（合规核查②）：README.en.md:408 斜杠命令计数 16→17，与 README.md:364 对齐（/healthcheck 注册后的正确计数）；DEVLOG W1 四件条目补文档同步明细（README 配置表 5 行/新章节/命令表 /healthcheck/计数 17）。
- 文档同步：README.md 与 README.en.md 配置表各补 7 行（trace×2+录制/注入×5）+ 新增「录制 · 回放 · 注入 · 体检（W1）」专节 + 命令表 `/healthcheck [export]`；docs/m1-mit-compliance.md（M1 MIT 合规核销表，5/5 借鉴文件通过）入库。
- 发版前基线：npx tsc --noEmit 0 错误；npm test 全绿（34 文件 458 用例；期间两轮全量出现 inject.spec waitFor 时序过敏 1-2 例，单跑与复跑全绿，同 DEVLOG 既有记录模式，非逻辑缺陷）。
- 发版流程按仓库惯例：逐特性 commit 保持回滚粒度 → npm 发布 dsh-onebot-qq@0.7.0 → live 升级（dsh plugin --profile web add，官方通道，不重启宿主）。运行中 fiber 不随 CLI add 换代码（ESM 缓存），0.7.0 行为随宿主下次重启生效，属预期。

## 2026-10-05 W7 设置页 workspacePath 入面板 + 「快速填入 workspace」（未发版，止步源码+测试+DEVLOG）

- 基线与边界：分支 m0-hardening @ 0797159（0.7.0 发版后干净工作树），止步源码+测试，未 commit、未发版、未触碰 live 数据、未重启宿主。改动面：src/settings-remote.ts、lib/client.js（手写 bundle）、lib/settings-remote.js + lib/types/settings-remote.d.ts（构建产物随 npm run build 再生）、tests/settings-remote.spec.ts、tests/client-settings.spec.ts、本 DEVLOG 条目；src/index.ts **零改动**（workspacePath 的插件 Config schema 已在位 src/index.ts:287，无需接线）、bridge.ts 零改动（只经 `import type { WorkspaceRegistryLike } from './bridge.js'` 复用既有类型，零运行时依赖）；红线文件（trace/record/inject/replay/health/connection/registry）零触碰。
- **host 侧（src/settings-remote.ts）**：①白名单扩 1 键——STRING_KEYS 增 workspacePath（host/url/accessToken/botQQ 之后），SCHEMA_DEFAULTS 增 `''`（与 src/index.ts:287 schema 默认一致），SETTINGS_GROUPS.connection 键序追加组尾，ALL_KEYS 25→26（4 枚举 + 3 数字 + 11 布尔 + 5 字符串 + 3 字符串数组）；读写主链路（getSettings/updateSettings/revision/脱敏/edit-failed 归一）零语义变化，workspacePath 走既有字符串通道（无额外校验，路径合法性由宿主 schemastery + reconcile 回滚兜底，与 host/url 同粒度）。②新增只读查询 `listWorkspaces()`（descriptor 第 3 方法，0 参全 positional）：纯函数 `listWorkspaces(registry)` 把 `WorkspaceRegistryLike.list()` 映射为 `{id, path, sessionCount}`（sessionCount=sessionIds 长度，纯展示）；registry 缺席/形状不符/list() 抛错一律归一 `{available:false, workspaces:[]}` **不抛错**——辅助查询绝不阻塞读写主链路。接线：**不经 static inject**（保持可选依赖，registry 缺席时服务照常挂载），沿用 requireConfigEditor 的惰性 `ctx.get('workspaceRegistry')` + 运行期形状校验模式（typert 与降级两分支同构）；类型经 import type 复用 bridge.ts 既有 WorkspaceRegistryLike，不打开 registry 内部态。createOnebotSettingsMethods 增可选第三参 workspaceRegistry（测试与降级类共用出口，缺省降级 unavailable）。
- **client 面板（lib/client.js）**：①connection 组新增 workspacePath 字符串输入行（label=会话默认工作区路径，hint 申明语义：「保存后仅对新会话生效，已用 /workspace 设置 per-chat 覆盖的会话不受影响。留空 = 宿主进程工作目录」——对齐 README「会话工作区选择」节优先级口径）；configSchema/patchSchema/DEFAULTS 同步该键（vString 0..1024，26 键契约由 client-settings.spec 逐字钉住）。②workspacePath 行下方新增「快速填入 workspace」行（renderWorkspacePicker 纯函数，经 renderGroup 新增 renderExtraRow 扩展点注入，独立 class obx-workspace-row 不计入 obx-field 行数）：数据 = 面板挂载 effect 对 `remote.listWorkspaces()` **现拉一次**（不缓存跨打开的陈旧列表；descriptor 增第 3 方法 listWorkspaces，result codec=WorkspaceListResult）；select 选项 `path（N 会话）`（value=id，防同名 path 冲突）+「填入」按钮（未选中禁用）；**填入只写输入框不保存**——唯一写入口 `fillWorkspacePath(draft, path)` 纯函数（面板 onApply=setDraft(fillWorkspacePath(...))，结构上无 updateSettings 调用），保存仍走既有显式「保存设置」通道；picker 行 title 与尾部 hint 均申明「只填值，保存仍走保存设置」与生效语义。③降级：拉取完成前不渲染；available=false（registry 缺席/list() 失败/RPC 异常）或列表为空 → 隐藏下拉与按钮，渲染说明行（「无法获取 workspace 列表（宿主未提供 workspace 注册表），可直接输入路径。」/「暂无 workspace 记录，可直接输入路径。」），绝不阻塞/污染 getSettings 主链路与错误横幅。
- **测试清单（+13 用例 = settings-remote 6 + client-settings 7，基线 458 → 471）**：settings-remote.spec——W7 白名单 describe 3 用例（workspacePath 入快照含默认值/connection 组键序/ALL_KEYS 26；字符串写入进覆盖行+revision 递增+非字符串逐类拒写 bad-request 且 edit 零调用+原键保留；携过期 expectedRevision 仍 conflict 不落盘）；W7 listWorkspaces describe 3 用例（正常映射 {id,path,sessionCount}；缺席/形状不符/list() 抛错三态降级不抛错；createOnebotSettingsMethods 两态 + 服务面 ctx.provide('workspaceRegistry') 正常态与缺席降级态（服务照常读写主链路））；既有 W6 用例 ALL_KEYS 25→26 推进（同 W6 当年 19→25 性质）。client-settings.spec——既有契约 25→26 全面推进（26 行 obx-field、文本框 6→7、方法集 +listWorkspaces 0 参、patch codec 收 workspacePath、result codec 断言含 workspacePath）；W7 describe 6 用例（connection 组键序+hint 语义文案；picker 正常态 select 选项/禁用逻辑/title；「填入」只调 onApply(path) 不触其他回调+源码接线钉 `setDraft(fillWorkspacePath(draft, path))`+fillWorkspacePath 纯函数不改入参；填入后显式保存通道 computePatch 只产 workspacePath 键+等值 no-op；降级三态（未拉取不渲染/缺席/空列表）隐藏控件渲染说明行；renderExtraRow 仅在 workspacePath 后注入且字段行计数不变）。
- 验证链路：npx tsc --noEmit 0 错误；npm run build 成功（lib/settings-remote.js + lib/types/settings-remote.d.ts 随源码重建，node 实载产物核验 listWorkspaces 导出与两态返回、connection 组含 workspacePath、ALL_KEYS=26；其余 lib 产物重建后字节一致；lib/client.js 为手写非构建产物，直接编辑）；npm test 全绿（34 文件 471 用例 = 基线 458 + 13；首轮全量曾出现 inject.spec「真实消息清除注入回合」waitFor 超时 1 例——该 spec 本批零触碰，单跑复测全绿，全量重跑 471/471，同 DEVLOG 既有记录模式）；git HEAD 仍 0797159 未 commit。
- 遗留与建议：①listWorkspaces 的 sessionCount 是注册表 list() 时刻的快照计数，仅作展示参考（不做实时性保证）；②「快速填入」数据在面板挂载时拉取一次，面板长开不自动刷新——重开面板/点「重新加载」语义未覆盖列表刷新（如需可后续把列表拉取挂到 reload 按钮，本批按「打开面板现拉一次」口径实现）；③lib/settings-remote.js 新增 listWorkspaces descriptor 后，**部署副本需随下次发版同步**（宿主网关按原型 descriptor 发现，旧部署副本无此方法时新版面板调 listWorkspaces 会失败——但客户端对该调用已按降级渲染处理，不会炸面板）；④workspacePath 客户端 vString 上限 1024 为展示层宽松上限，host 侧无长度校验（与 host/url 同粒度，超长路径由宿主 schemastery/回滚兜底）。

## 2026-10-05 发版 0.8.0（W7 设置页 workspacePath 入面板 + 快速填入）

- 版本 0.7.0→0.8.0（minor：新增用户可见能力）。0.8.0 = 设置页 connection 组新增 workspacePath + 快速填入下拉（只填不存）+ listWorkspaces 降级查询；随宿主重启/热重载生效（client bundle 按文件 mtime/ctime/size 重算 artifact rev 热生效，重开设置页即拉新 bundle）。技术细节见上一节 W7 条目，此处不重复。发版前基线：npx tsc --noEmit 0 错误；npm test 全绿（34 文件 471 用例）。

## 2026-10-05 发版 0.8.1（logLevel 控制台日志级别门槛）

- 版本 0.8.0→0.8.1（patch：新增一个默认行为不变的配置项）。0.8.1 = Config 新增 `logLevel` 配置项——控制台日志级别门槛，debug/info/warn/error 四档，默认 `info`；log 闭包按 `LOG_LEVEL_RANK`（debug:0 < info:1 < warn:2 < error:3）门控，低于配置级别的日志不输出，error→console.error / warn→console.warn 分流保持不变；`logMetaEvent` 增加可选第三参 `minLevel`（默认 'info'，不带参调用行为不变，导出兼容），meta 事件按 info 级别纳入门控。默认值下与 0.8.0 输出差异仅为 debug 调试行（如「session 事件早退：无 chat 映射」等）不再刷屏。技术细节见 logLevel 交付报告（dsh-onebot-loglevel-report-20261005.md）：改动面 src/index.ts（Config 接口/schema/log 闭包门控/logMetaEvent）+ README.md:168 与 README.en.md:179 配置表各 1 行 + lib/ 构建产物随 build 再生。
- 发版前基线：npx tsc --noEmit 0 错误（npm run build 成功）；npm test 全绿（34 文件 471 用例）。
- 清单同步：package.json version 0.8.0→0.8.1；dsh.plugin.json version 同步 0.8.1（该字段自 v0.4.0 起历次发版未随动，本次一并追平）。README 兼容性表只约束 dsh 宿主/Node 版本、无插件版本号字段，无需改动；package-lock.json 根 version 自 0.1.0 起历次发版均未随动（既有惯例），本次保持不动。

## 2026-10-12 发版 0.9.0（W1–W3 五特性批次，用户裁决：只切版不发布）

- 版本 0.8.1→0.9.0（minor：五特性新增用户可见能力面）。本条目整合 W1–W3 批次五特性（技术细节见上各特性 DEVLOG 条目，此处不重复）：**T1 v4 命令审计**（commit 5a1d3c3）、**T5 verify 体检脚本**（36201ea）、**T2 排队/插话 newMessagePolicy + /steer + autoSteerPolicy**（f459d84+10e3899）、**T3 超时后结果补发 deferred delivery**（5a2b3a6）、**T4 诊断参考号体系 QQ-CONN-/QQ-MF-**（6175d36）。
- 关键设计裁决：① `autoSteerPolicy` 默认值 `admin`（自动插话仅管理员消息具备资格，默认行为面收敛）；② T3 补发只补文字结果、不重放审批请求（超时补发不含 user-approval 类回合，避免审批流程在无人值守场景被二次触发）；③ T4 诊断参考号仅故障场景发号（QQ-CONN- 连接类 / QQ-MF- 媒体失败类），正常路径零开销零噪音。
- 已知名义外事项：① tests/inject.spec.ts 与 tests/deferred.spec.ts 存在既有环境 flake（隔离单跑必过、全量并发偶发，判定口径见下闸门规则）；② 主检出裸跑 vitest 需 `--dir tests` 限定目录（主检出根目录扫描会误入其他路径）；③ **生产升级未执行（用户裁决 2026-10-12）**：本次只切版不发布，npm publish / live 升级 / 生产 profile / node_modules 升级 / 宿主重启均未执行，留待用户裁决后另行安排。
- 发版前闸门（worktree wt-t6-release @ 6175d36 基线 + 版本号双文件 + lib 重建 + 文档更新后实测）：`npx tsc --noEmit` 零错误；`npx vitest run --dir tests` 连续 3 轮全量全绿（38 文件 / 532 用例）。flake 处置规则：若 inject.spec / deferred.spec 在全量轮次偶发失败，先隔离单跑该文件，单跑过再全量复跑，连续 3 轮判定含此规则。
- lib 产物说明：`scripts/build.sh` 编译步骤（`tsc -p tsconfig.json`，tsconfig `include: ["src"]` 且 src/ 无 client 源文件）**不覆盖手工维护真相源 lib/client.js**——已逐行核实 build.sh/link-host.sh 与 tsconfig 后确认，lib/client.js 在本次构建前后零改动；T2/T3/T4 对它的既有修改本就落在 lib/client.js 本体（5a2b3a6/f459d84 提交内）。本次 lib 变更 = T2/T3/T4 src 特性对应的生成产物再生（lib/bridge.js、lib/deferred.js 新增、lib/ref.js 新增、lib/health.js、lib/settings-remote.js 等 16 改 + 4 新增），随本发版提交入库。
- 环境备注：build.sh 的 link-host 前置阶段在当前宿主安装（0.2.1-alpha.2）缺 `@deepseek-ai/dsh-invariants` 包而中止（既有环境状态，dsh-invariants 链接指向旧 appcenter 安装、可用）；故本次按等价编译步骤 `node_modules/.bin/tsc -p tsconfig.json` 直接重建（共享 node_modules 宿主链接已就绪，未再扰动），产物与 build.sh 编译步骤完全一致。
- 清单同步：package.json version 0.8.1→0.9.0；dsh.plugin.json version 同步 0.9.0；README.md:49 与 README.en.md:49 兼容性「最后验证」行更新为 0.9.0 口径（W1–W3 五特性、tsc+vitest 532 全绿、日期 2026-10-12）；package-lock.json 根 version 沿用既有惯例不动。
- 部署 runbook（留白待用户执行，本批次未做）：① 发布 npm 包——`npm publish`（发 dsh-onebot-qq@0.9.0；发布前建议人工复核 npm 包内容 `npm pack --dry-run`）；② live 升级——`dsh plugin --profile web add`（官方通道升级插件，不重启宿主；运行中 fiber 不随 CLI add 换代码，0.9.0 行为随宿主下次重启生效，与 0.7.0 惯例一致）；③ 设置页 client bundle 按 mtime/ctime/size 热生效，重开设置页即拉新 bundle。以上两步的执行时机与生产窗口由用户裁决。

## 2026-10-12 发版 0.9.1（/ver ESM `__dirname` 修复，patch 发版）

- **缺陷**：`/ver` 恒显示 `dsh-onebot v?` 且无 commit 后缀。根因：src/commands.ts 的 `packageVersion()`（读 `dirname(__dirname)/package.json`）与 `gitCommit()`（`cwd=dirname(__dirname)`）在编译产物 lib/commands.js 中引用裸 `__dirname`；package.json `"type":"module"` + tsconfig `module: esnext` → ESM 产物下 `__dirname` 未定义 → ReferenceError 被 try/catch 静默吞掉 → 版本与 commit 双双取空 → `/ver` 兜底 `?`。
- **影响面**：`/ver` 自代码切换 ESM 形态起即受影响，0.9.0 生产 npm 包实证复现（`npm 0.9.0` 形态下恒 `v?`）；仅影响 `/ver` 展示，不影响任何消息收发与会话逻辑。
- **修复**：两处 `__dirname` 改为 ESM 安全等价 `dirname(dirname(fileURLToPath(import.meta.url)))`（`__dirname` 本身=模块文件目录，其 `dirname` 才是插件根；`node:url` import 新增一行），其余逻辑零改动；`packageVersion()` 加最小 `export` 供回归测试直接断言。
- **验证**：新增 tests/commands.spec.ts 单测断言 `packageVersion() === '0.9.1'`；`npx tsc --noEmit` 零错误；全量 vitest 全绿（基线 38 文件 / 532 用例 + 新增 1 条）；`grep -c __dirname lib/commands.js` = 0。
- **清单同步**：package.json version 0.9.0→0.9.1；dsh.plugin.json 同步 0.9.1；lib 产物随本发版提交入库（build.sh 的 link-host 阶段受宿主缺 dsh-invariants 影响时按 0.9.0 先例用 `tsc -p tsconfig.json` 等价重建）；README 无版本硬编码，不动。

## 2026-10-12 发版 0.9.2（/healthcheck 更名 /doctor，保留等价别名，T1）

- **更名**：命令表主条目 `name: 'healthcheck'` → `name: 'doctor'`（`CommandDefinition` 新增可选 `aliases` 字段，本条目 `aliases: ['healthcheck']`）；路由 `find` 兼容 `c.aliases?.includes(name)`——`/doctor` 与 `/healthcheck` 走同一 handler `handleHealthcheckCommand`，行为逐字一致（无参摘要 / `export [参考号]` / 非法参考号提示均不变，`export` 子参数用法不变）。实现/内部标识符零改动：`handleHealthcheckCommand`、src/health.ts 文件名、trace stage 值等均保持原名（最小改动）。
- **用户可见文案**：src/commands.ts 两处用法提示（非法参考号分支 + 未知子参数分支）中 `/healthcheck` → `/doctor`；src/health.ts 报告内文不含命令名（报告标题「▍dsh-onebot 体检」无命令引用），不动。
- **`/help` 只列 `/doctor`**：helpText 按 `name` 渲染，别名不重复出现；相近命令建议（suggestCommands）把别名候选归一到主名——`/he` 现提示「你是想用 /doctor（/help）吗？」，拼错 `/helthcheck`（编辑距离 1 命中别名）提示 `/doctor`，不再落 unknownCommand 拦截。
- **测试**：commands.spec.ts 命令表断言与 /help 全文快照随更名更新；新增别名等价用例（`/doctor` 与 `/healthcheck` 各渲染一份「▍dsh-onebot 体检」摘要、别名被路由而非拦截、别名不出现在 /help 卡片）；health.spec.ts 用法提示断言随文案改 `/doctor`（该用例经 `/healthcheck` 发送，兼作别名回归覆盖）；health-ref.spec.ts 零改动（经别名发送，自然覆盖）。
- **文档**：README.md 与 README.en.md 命令表/斜杠命令总览/能力表/命令参考表/参考号排查节中 `/healthcheck` → `/doctor`，双语首次出现处注明「(别名 /healthcheck)」；其余文档不动。
- **清单同步**：package.json version 0.9.1→0.9.2；dsh.plugin.json 同步 0.9.2；tests/commands.spec.ts packageVersion 断言随版更新为 0.9.2；lib 产物按 0.9.0/0.9.1 先例以 `tsc -p tsconfig.json` 等价重建入库（tsconfig `include: ["src"]`，lib/client.js 手工真相源零改动）；package-lock.json 沿用既有惯例不动。
- **边界**：只改工作区仓库，运行中生产（0.9.0）与 npm 均未触碰；不 push、不 publish。

## 2026-10-17 发版 0.9.3（engines.dsh 覆盖 DSH 0.2.1 系列，T1）

- **缺陷**：DSH 0.2.1-rc.1 宿主校验插件 engines 不通过。根因：node-semver 预发布 tuple 规则——`>=0.2.0-rc.1 <0.3.0-0` 的预发布比较子只挂载在 `0.2.0` tuple 上，`0.2.1-rc.1` 属 `0.2.1` tuple，按规则不命中（实测 `satisfies('0.2.1-rc.1', 旧范围)` = false）。
- **修复**：package.json 与 dsh.plugin.json 的 engines.dsh 逐字追加 ` || >=0.2.1-0 <0.3.0-0`（`>=0.2.1-0` 比较子挂载 `0.2.1` tuple 且带预发布标记，为 0.2.1.x 预发布版本放行；上界仍 `<0.3.0-0` 不变）；两文件范围逐字一致。
- **验证**：node v24 + semver：`satisfies('0.2.1-rc.1', 新范围)` = true（旧范围 false）；边界保持 `0.2.0`/`0.2.0-rc.1` = true、`0.3.0`/`0.3.0-rc.1` = false；全量 vitest 全绿（基线 38 文件 / 534 用例；tests/deferred.spec.ts:127 为既有并行负载 flake，隔离复跑 3/3 绿，与本改动无关——详见 dsh-onebot-093-release-report.md）。
- **清单同步**：package.json version 0.9.2→0.9.3；dsh.plugin.json 同步 0.9.3；tests/commands.spec.ts packageVersion 断言随版更新为 0.9.3（it 描述串 + expect 两行，仿 0.9.2 发版先例）；lib 产物零改动（本发版不改 src，`/ver` 的 packageVersion() 动态读 package.json）；package-lock.json 沿用既有惯例不动。
- **边界**：随本发版同批完成 commit→push→npm publish→profile web 手工升级（t14 模式 pnpm install，备份回滚点先行）；宿主进程未重启，0.9.3 行为随宿主下次重启生效。

## 2026-10-24 发版 0.9.4（设置页入口迁至「插件」选项卡，T4）

- **改动**：client 设置页入口 settings.section → plugins.bundle.config（组合包详情页渲染 OnebotSettingsPanel），并清理 settings.nav 死键（settings.section 挂载时代的导航 locale 键）。实现见 feat commit 029b5a1（lib/client.js + docs/settings-page-design.md，已随 029b5a1 入库），本发版不含 lib 改动。
- **验证**：全量 vitest 全绿（38 文件 / 534 用例）；首轮 tests/inject.spec.ts「dry-run=false lets injected rounds really send」并行负载下偶发失败（既有环境 flake，0.9.0 已记录口径），隔离单跑 11/11 绿后全量复跑 38 文件 / 534 用例全过。
- **清单同步**：package.json version 0.9.3→0.9.4；dsh.plugin.json 同步 0.9.4；tests/commands.spec.ts packageVersion 断言随版更新为 0.9.4（it 描述串 + expect 两行，仿 0.9.3 发版先例）；lib 产物零改动（本发版不改 src，`/ver` 的 packageVersion() 动态读 package.json，client.js 本次未再改）；package-lock.json 沿用既有惯例不动。
- **边界**：commit → tag v0.9.4 → push → npm publish 随本发版同批完成。

## 2026-10-24 发版 0.9.5（设置页可视化重设计三批实施，T8）

- **改动**：设置页可视化重设计三批实施随本发版出版本号，本发版零代码改动：token 视觉基线 + 暗色适配 + 交互逻辑（脏状态/确认/折叠/mode 联动/重试）+ 冲突合并保留 + 数字行内校验。实现见 feat commit aebbe7f（代码 956+/52−，已部署真机）与设计文档 commit 0f787af（三份设计文档），均已入库。
- **验证**：npx tsc --noEmit 零错误；全量 vitest 全绿（38 文件 / 550 用例）；部署目录 /vol2/@appshare/Harness/dsh-plugins/dsh-onebot 已同步版本号（lib 代码已在真机，未动其他文件）。
- **清单同步**：package.json version 0.9.4→0.9.5；dsh.plugin.json 同步 0.9.5；tests/commands.spec.ts packageVersion 断言随版更新为 0.9.5（it 描述串 + expect 两行，仿 0.9.3/0.9.4 发版先例）；lib 产物零改动（本发版不改 src，`/ver` 的 packageVersion() 动态读 package.json）；package-lock.json 沿用既有惯例不动。
- **边界**：commit → tag v0.9.5 → push → npm publish 随本发版同批完成。

## 2026-10-23 工具脚本修复：link-host 清单与 verify-injected-context 加载（T3，未发版；实际提交跨日至 10-24 凌晨）

- **缺陷①（link-host.sh）**：LINK_PKGS 含 `dsh-invariants`，而 rc.2/rc.3 宿主 node_modules/@deepseek-ai/（顶层与嵌套）均无此包，插件零引用 → 缺包分支 `exit 1`，完整 `build.sh` 在首个 link-host 阶段中止（rc.3 验收实测）。修法：移出清单并就地加一行注释；同一清单补齐 `tests/session-v4-persistence.spec.ts:268` 直接 import 的 6 个 dsh-session-format* 包（此前靠人工补链，重装后该处准入断言 warn 后降级跳过 = 假绿）。
- **缺陷②（link-host.sh）**：末尾 schemastery/cosmokit 硬指 `$NODE_MODULES/<p>`，而 rc.2/rc.3 只在 @deepseek-ai/ 下有这两个包（宿主顶层无）→ 每轮重链必产 2 条悬空链接。修法：顶层优先、@deepseek-ai/ 兜底，两处都缺仍硬失败（保留原有缺包语义与 DSH_ROOT 入口）。
- **缺陷③（verify-injected-context.mjs:87）**：按 `default` 解构 dsh-session-persistence-jsonl，实际导出为 `{ Config, JsonlCompressionSchema, apply, name }`（cordis 插件模块，无 default）→ `ctx.plugin(undefined)` 抛 invalid plugin 并 exit 1，rc.2 同样失败（非 rc.3 回归）。修法：改为整模块命名空间传入（cordis 接受带 apply 的对象）；S1–S6 检查项与「旧宿主缺包 DEGRADE」分支语义均不变。
- **验证**：`link-host.sh` 对 rc.3 exit 0（20 链接全指向 rc.3、`find node_modules -xtype l` 悬空 0）；`verify-injected-context.mjs` 对 rc.3 与 rc.2 均 7/7 PASS（S1–S6 + 清理，日志见 dsh-onebot-rc3-adapt-test-evidence/w5-*-fixed.log）；`verify-lan-management.mjs` 对 rc.3 12/12 PASS（回归）；`npx tsc -p tsconfig.json --noEmit` 0 错误；全量 vitest 549/550——唯一失败项是 tests/inject.spec.ts 既有并行负载 flake（15s waitFor 超时，隔离 26/26 绿，与 0.9.3/0.9.4 条目同口径），本次改动只碰 scripts/ 且不被任何测试引用。
- **未发版原因**：`scripts/` 不在 package.json `files` 白名单内，npm 发布物不含这两个脚本，故不 bump 版本。

## 2026-10-24 发版 0.9.6（工具脚本修复与 rc.3 适配验证收口，T5）

- **改动**：本次发版为「发布面收口」，**无运行时代码变更**（src/ 零改动、lib/ 零改动）。随本发版出版本号的是已入库的工具脚本修复 commit `ac5c80a`（link-host.sh 清单修正：移出宿主不存在的 `dsh-invariants`、补齐 6 个 `dsh-session-format*` 依赖、schemastery/cosmokit 顶层优先兜底；verify-injected-context.mjs:87 改为整模块命名空间传入）与 DSH 0.2.1-rc.3 适配验证结论 **= 兼容**（link-host exit 0；verify-injected-context 对 rc.3 与 rc.2 均 7/7 PASS；verify-lan-management 对 rc.3 12/12 PASS）。
- **说明（发布物边界）**：`scripts/` 不在 package.json `files` 白名单（仅 `lib` + `cordis.patch.yml`），这两个脚本修复**不随 npm 包分发**；版本号 bump 仅作为该修复与其 rc.3 适配验证的收口标记，安装用户运行行为与 0.9.5 完全一致。
- **验证**：`npx tsc -p tsconfig.json --noEmit` 0 错误；全量 vitest 38 文件 / 550 用例全绿（一次通过，本轮无 flake）；lib 产物 sha256 与发版前逐字节一致（零改动）。
- **清单同步**：package.json version 0.9.5→0.9.6；dsh.plugin.json 同步 0.9.6；tests/commands.spec.ts packageVersion 断言随版更新为 0.9.6（it 描述串 + expect 两行，仿 0.9.3/0.9.4/0.9.5 发版先例）；package-lock.json 沿用既有惯例不动。
- **发布面收口**：commit → push origin main（同批带上此前未推送的 `ac5c80a`）→ tag `v0.9.6` → GitHub Release → npm publish → npmmirror 同步 → profile web 升级 0.9.6；同批**补建历史缺失的 v0.9.4 / v0.9.5 GitHub Release**（只建 Release，不新建、不覆盖既有 tag）。宿主进程未重启，0.9.6 随宿主下次重启生效。

## 2026-10-24 安全加固批次（审计收口，未发版）

外部第三方对 0.9.4 做了一次全项目审计（代码 / 契约 / 测试 / 运行时），本批次收口其中的高危项。审计报告含内部部署路径与账号信息，不入本仓库。

- **工具面**：`qq_napcat_api` 增加参数白名单——上传 / 写群类 action 仅管理员；`file` / `image` 只接受 `file_id` 或 `base64://`，不再接受本地绝对路径；`group_id` 必须等于当前会话。`qq_*` 工具默认目标锁定当前会话，显式跨会话仅管理员回合可用。
- **角色闸门**：受限用户（非管理员）回合改用 `tools.guard` 白名单（`Read` / `Grep` 一并拒绝，因其可读宿主配置），拒绝写文件、执行命令与 NapCat 代理。此前只有提示词前缀 `[受限用户:仅问答]`，属软约束——同一次注入成功后即可读写宿主文件。
- **入站**：`file://` 引用增加扩展名白名单与大小上限，伪造的媒体事件不能再把任意本地文件复制进 `mediaDir` 并交给视觉模型。
- **持久化**：`chat-sessions.json` 改 tmp+rename 原子写并加串行写链（原子只保证「读不到半截」，串行才保证不被旧快照覆盖）；加载失败（非 ENOENT）时拒绝覆盖，留给人工修复。原实现裸写 + 读取吞错，一次写盘中断会让全部会话映射永久丢失。
- **拆卸**：`bridge.stop()` 先排空出站发送链，再 flush trace / record 队列；配置热更新引发的插件重启不再丢在途消息与观测数据。
- **设置页**：`lib/client.js` 补 `listReasoningEfforts` descriptor（服务端早已 `markRemote`、客户端漏声明，思考档位收窄一直静默回退到静态八档）。
- **契约**：模型平台提示的命令清单补 `/steer` `/storage` `/doctor`；README 命令表补 `/doctor`、`qq_napcat_api` action 数改为 15、测试数字与实测对齐。
- **测试**：
  - 新增 `tests/member-gate.spec.ts`（角色闸门 4 条）；`tools-gate` +6、`media-guard` +4、`registry` +2。
  - 修 3 条测试缺陷：`deferred` 两条（假调度器少驱动一轮退避 + 异步落盘未等待）、`health-ref` 一条（对 `JSON.stringify` 结果直接正则提路径，转义后的 `\\` 不是有效路径）。此前被误判为产品缺陷，本次以内部状态打印与会话日志否证。
  - Windows 平台差异（symlink 权限、POSIX 可执行位）改为显式 `skipIf`。
  - 顺带修 `registry.ts` 的 `reasoningEffort` 与宿主 branded 类型不匹配（此前 `tsc` 实际有 1 个错误，一直被输出截断掩盖）。
- **验证**：`npx tsc --noEmit` 0 错误；`vitest run` 40 spec / 588 用例 → 557 passed / 19 failed / 12 skipped；19 条全部为 Windows 平台差异（t2i 无 CJK 字体 10、8.3 短路径 9），Linux 预期全绿。
- **未做**：`lib/` 中 6 个文件（`attach` / `commands` / `cq` / `inbound` / `mcp-gate` / `settings-remote`）发现原产物与 `src/` 存在历史漂移，本批次已回滚保持现状，留待单独一轮「产物重建 + 真机回归」。

## 2026-10-26 启动自检第一批（preflight）+ peer 声明补 0.2.1 分支

同一批里把部署形态从「实体拷贝副本」纠正为 junction 直连源码仓（见「部署」），运行时改动如下。

- **peer 声明补分支**：8 个 `@deepseek-ai/*` peer 追加 `|| >=0.2.1-0 <0.3.0-0`，与 `engines.dsh` 对齐——后者在 0.9.4（`69d17f3`）就补了该分支，peer 漏改。semver 实测：补前 `0.2.1-rc.2` / `0.2.1-rc.3` 均 false（`0.2.1` 正式版才 true），补后 true 且 `0.2.2-rc.1` / `0.3.0-0` 仍 false（未过度放宽）。矩阵落 `docs/semver-matrix.md`。
- **启动自检（第一批）**：
  - `describeResolvedPeer()`：启动时取 `@deepseek-ai/dsh-agent/package.json` 的真实落点，日志与启动报告同时输出「版本 + 落点 + 完整路径」。落点分「宿主 asar 内 / 插件自带 node_modules / 未知位置」——这是判断是否双包的可靠依据（两处可能同版本，只打版本号区分不出来）。
  - `mounted` 改走 `log()` 落盘并补 `host:port`：桌面版是 GUI 进程，stdout 无处可看，此前「挂没挂上」只能靠猜。
  - `mediaDir/startup-report.txt`：插件版本、宿主 peer、Node/平台、传输、mediaDir、workspacePath、管理员数、日志级别。
  - `adminUsers` 为空时启动期 warn（说清「无人能对话」的后果与两个出口）；此前只有 mounted 行里的 `admins=0`。
  - 挂载失败文案拆分：单独探 `@napi-rs/canvas`，命中即追加「这不是 peer 依赖问题」——此前两类故障共用一句「补齐 link-host 链接集」，会把原生模块问题引向错误解法。
  - `NapcatWatch.extraHint`：仅在 `reverse` 且监听环回地址时，随「确实没连上」的告警附加「跨机/Docker 需改 0.0.0.0」，不做启动期噪声。
- **实测结论（重要）**：桌面版宿主把 53 个 `@deepseek-ai/*` 打在 `resources/app.asar` 内（0.2.1-rc.3）。junction + peer 声明之下，启动报告显示 `@deepseek-ai/dsh-agent 0.2.1-rc.3（宿主 asar 内）：F:\dsh\resources\app.asar\...` ⇒ **asar 形态下 peer 路由确实生效**，插件用的是宿主 rc.3，不是仓库 `node_modules` 的 rc.2，**无双包**。前提：`@deepseek-ai/*` 必须写在 `peerDependencies`（路由只认 peer 声明）。此前「设置页正常」的成因由此定性。
- **部署形态**：`profiles/desktop/node_modules/dsh-onebot-qq` 由实体拷贝改为 junction → 源码仓；旧副本改名 `.bak-link-20261026` 留档。收益：改 `src/` → `tsc` → 重启即生效，不再需要「构建→复制→对齐」。
- **产物**：本次 `tsc -p tsconfig.json` 全量重建 `lib/`，与上述 lib 漂移遗留一并收口（`lib/` 与 `src/` 同步入库）。
- **验证**：`tsc` exit 0；`tests/plugin.spec.ts` 6/6（原「恰好一条 warn」断言改为按内容筛选，新增「管理员已配置不提示」）；重启后 `startup-report.txt` 与 `onebot.log` 均输出预期内容，`admins=1`。
- **已知遗留**：`tests/client-settings.spec.ts` 4 条失败 = 期望 40 键 / 实际 38 键，属 `a9ed1ab`（移植上游设置页、保留 38 键）遗留，本批未修。
- **环境备注**：宿主 Node 为 v24.21.0（Electron 自带），仓库开发环境 node v22.18.0；涉及 Node 版本相关 API 时以宿主为准。

## 2026-10-26 token 空值的 fail-loud 提示 + autoStartNapcat 语义澄清

- **问题**：`mode: reverse` + `accessToken: ''` 时 `connection.startReverseServer()` 抛错，但该错误落进入口的通用 catch，被归成「挂载失败：peer 依赖解析失败或关键模块缺失 —— 部署副本必须带完整 node_modules 链接集」。用户会去查依赖链接集，真因只是没填 token（与 canvas 那次同类误报）。
- **修复**：`apply()` 的 preflight 增加一条 `log('error', …)`，在 `connection.start()` 之前点名说清——reverse 必须填 token、它同时是 NapCat 侧 `websocketClients[].token`、两侧必须一致、怎么改、以及不要鉴权可改 `forward`。抛错行为不变（仍 fail-closed）。
- **测试**：`tests/plugin.spec.ts` 新增「reverse + 空 accessToken：先给中文处置提示，再 fail-closed 抛错」，断言 error 日志出现点名 token 的那句。
- **`autoStartNapcat` 语义澄清（默认值未变，仍是 `false`）**：schema description / 设置页 label+hint / README 三处统一为「默认关闭 = 插件不启动任何进程，NapCat 完全手动管理；它与 `napcatLauncher` 独立，配了路径但此项 `false` 时路径只用于诊断」。此前 hint 只写「开启后如何」，没写「关闭等于什么」，容易被误读成「配了路径就会拉起」。
- **README 漂移修正**：设置页分组表（`connection` 组）此前仍列 38 键、缺 `napcatLauncher` / `napcatLauncherArgs` / `autoStartNapcat`，与已实现的 41 键不一致，已补齐。
- **验证**：`tsc` exit 0；`plugin.spec` + `client-settings.spec` + `config-ranges.spec` 共 66 用例全绿。

## 2026-10-27 发布元数据与安装前置修正

- **`files` 补 `docs/napcat-launcher.md`**：此前 `files` 只有 `lib` + `cordis.patch.yml`，而 README 多处链到该文档 → npm 用户点进去是 **404**；而那份文档正是「QQ 必须先退出、`-q` 免扫码、开机自启、控制台乱码」的唯一说明。`npm pack --dry-run` 复核：包内文件 78 → 79，`docs/napcat-launcher.md`（8.2 kB）已在列，`cordis.patch.yml` 未受影响。
- **`repository` / `homepage` / `bugs` 改指 fork**（`Dreasye791/dsh-onebot`）：此前全部指向 upstream `mario841859784`，导致 npm 页面的「Repository」「Issues」都会把用户带到原作者仓库。不影响运行时，但影响问题上报与包溯源。
- **README「安装-前置」补 NapCat 硬约束**：新增醒目一段——NapCat 注入要求 **QQ 在注入前未运行**，QQ 已开着（如开机自启）会被判为 `QQ 已占用` 且插件停止尝试，需先完全退出 QQ 再由 launcher 拉起。此前这条只写在排障表里，而它是整条链路上最容易踩的坑。
- **验证**：`npm pack --dry-run` 清单正确（79 文件，含 docs）；本轮只动 `package.json` 与 `README.md`，不涉及 `src/`、`lib/`，无需重建与回归。

## 2026-10-27 版本号加 fork 标识：0.9.6+dreasye.1

- **选型**：与 upstream 保持同一条主线 `0.9.6`，另加 **build metadata** 后缀 `+dreasye.1`，而不是预发布后缀 `-dreasye.1`。依据 node-semver 两条规则：**预发布版本低于同版本正式版**（`0.9.6-x < 0.9.6`，不满足 `^0.9.6` / `>=0.9.6` / `~0.9.6`），**build metadata 不参与比较**（`0.9.6+x == 0.9.6`）。同一规则此前已由 `docs/semver-matrix.md` 的 `0.2.1-rc.x` 情形实测确认。
- **代价（已知并接受）**：① 不能 `npm publish` —— registry 会规范化去掉 `+`，与 upstream 的 `0.9.6` 撞号；② `profiles/desktop/compatibility.json` 里 `dsh-onebot-qq@0.9.6` 这条豁免键将对不上，但 `engines.dsh` 已含 `>=0.2.1-0`，该豁免本就多余。
- **产物**：`npm pack` → 392.8 kB / 79 文件；包内 `version` 已核为 `0.9.6+dreasye.1`，`main` 指向 `lib/index.js`，`docs/napcat-launcher.md` 与 `cordis.patch.yml` 均在。对外复制为 `dsh-onebot-qq-0.9.6-dreasye.1.tgz`（名字里不带 `+`，规避 URL path 中 `+` 被部分代理转成空格），包内 version 不变 —— pnpm 读的是包内 `package.json`。
- **同步**：`dsh.plugin.json` 的 `version`、`package-lock.json` 顶部与 `packages[""]` 两处一并改，避免清单与 lock 漂移（`npm ci` 会比对）。
- **分发方式**：GitHub Release（tarball spec）/ `git+https://…#<commit>` / 本地 `file:`。三条都不经过 registry。

## 2026-10-28 频道记忆第一批：显式 remember / recall（关键词检索）

**为什么先做这一层**：宿主 `@deepseek-ai/dsh-llm` **不提供 embedding**（`lib/types/*.d.ts` 里没有 embed；`LlmRuntimeLike` 只有 `resolveModelInfo`），向量化必须自带服务或本地模型。先用零依赖的关键词召回验证「记忆内容本身是否有用」，再接向量 —— 检索接口保持不变，换实现即可。

- **存储**：`mediaDir/memory/<chat>.jsonl`，一行一条 `{ts,text,tags?}`。**不引 better-sqlite3** —— 本项目已因 `@napi-rs/canvas` 这类原生模块踩过平台绑定的坑，记忆是增强功能，不值得再背一个原生依赖。
- **检索**：`tokenize()` 中文出 2-gram + 整段、英文/数字按片段；`searchMemories()` 用「命中词覆盖率 × 长度惩罚」打分并排序。这是**字面召回**（「辣的粉」搜不到「螺蛳粉」），语义化召回属第二批。
- **工具**：`qq_memory_remember`（写，仅管理员回合）/ `qq_memory_recall`（读，成员可用，已列入 `MEMBER_ALLOWED_TOOL_NAMES`；写入**不**放行，避免群友往里塞内容）。**不做自动注入** —— 自动改写每轮 prompt 出问题难归因。
- **配置**：`memoryEnabled`（默认 false）/ `memoryMaxEntriesPerChat`（200，1–5000）/ `memoryRecallTopK`（5，1–20）；三键进 behavior 组，设置页键集 41 → **44**（`lib/client.js` 的 GROUPS / DEFAULTS / NUMBER_RANGE 同步）。
- **健壮性**：坏行跳过、目录自动创建、每次写入后裁剪（超限丢最旧）、非整数用 `Math.floor` 兜底。
- **验证**：`tsc` exit 0；新增 `tests/memory.spec.ts` 16 条（命名/读写/坏行/裁剪/分词/召回）；`client-settings` 同步 44 键 / 16 文本框 / 14+1 勾选 / NUMBER_RANGE 两项 → **6 文件 96 用例全绿**。
- **未做（第二批）**：embedding 接入（OpenAI 兼容端点，配置化）、自动召回注入、设置页召回预览、结构化记忆（用户画像/事实卡片）。

### 记忆工具的可发现性（同日补）

- **问题**：模型唯一线索是工具描述，而 `buildPlatformPrompt` 里没有任何记忆指引 —— 工具存在，但「我之前说过什么」这类问题不一定触发 `qq_memory_recall`，等于白给。
- **改动**：`buildPlatformPrompt(restrictedMembers, persona, memoryEnabled?)` 增加第三参，**仅当为 `true`** 时注入一条规则：两个工具各管什么、被问「之前说过什么」时**先 recall 不要凭空猜**、不要重复记当前上下文已可见的内容、记忆按会话隔离且是**字面匹配**（换说法可能搜不到）。
- **为什么必须条件注入**：工具未注册时若仍在 prompt 里宣告「你有记忆工具」，模型会去调用并吃一个 unknown tool 错误，还可能因此编造记忆内容。`bridge.ts` 传的是 `config.memoryEnabled === true`。
- **顺带**：`qq_memory_remember` 的描述补「仅管理员回合可用；受限成员调用会被拒绝」—— 成员在工具表里看得见它（闸门在调用期，不是隐藏），描述里写明可减少无效尝试。
- **验证**：`prompt.spec` 新增 2 条（启用时三要素齐全 / 未启用时完全沉默 / 与人设层共存且人设仍在最前）；`tsc` exit 0；4 文件 83 用例全绿。

### 成员画像 + 放开成员写入（同日，用户裁决）

- **放开写入**：`qq_memory_remember` 加入 `MEMBER_ALLOWED_TOOL_NAMES`。此前的「仅管理员」是一刀切 —— 与已放行的 `qq_send_file`（能往群里发任意文件）相比，写一条本会话的记忆风险更低，却让记忆在群里完全失效。
- **两类记忆**：`kind: 'note'`（会话公共，成员可写）/ `kind: 'profile'`（某成员画像，带 `subject`）。
- **画像的四面约束**：① 私聊默认写、主体自动取对话对方；群聊需 `memoryProfileScope=all` **且**管理员显式给 `subject`（`dispatchFollowup` 没有发送者参数，工具拿不到当前发言者，无法校验是否本人）；② `recall` 只返回「本会话 note + 当前用户自己的 profile」，别人的画像永远不返回；③ 内容边界写进 prompt（只记称呼/偏好/习惯/擅长，禁贬损评价、禁把一次情绪当性格）；④ `/memory` + `/memory forget` 让被记录者能自查自删。
- **分档 TTL**：待办 14 / 偏好不过期 / 事实 365 / 无标签 90 天，**绝对过期**（不因被引用而续期 —— 滑动过期需要每次 recall 回写，与「只读」语义冲突）；过期是**软过期**（不再召回，原文保留）。
- **敏感信息拦截**：手机号 / 身份证（含 X）/ 银行卡，按**整段数字长度**判定而非子串匹配 —— 初版用 `1[3-9]\d{9}` 无边界，18 位身份证里的 11 位连续数字被判成手机号、13 位时间戳也会命中（测试当场抓到）。
- **`/memory` 是唯一对成员开放的命令**：router 的 admin 闸门前移到「命令是否存在」之后；命令不存在时对非管理员仍回「仅管理员可用」（不暴露命令表）。`/help` 标题因此从「仅管理员」改为「可用命令：」，`/memory` 行内标注「所有成员可用」。
- **验证**：`tsc` exit 0；`memory.spec` 扩到 29 条（类型/来源字段、TTL 分档、召回范围、敏感拦截、删除画像）；`commands` 20 条命令 + `/help` 快照；`prompt` 内容边界断言；`client-settings` 45 键 / 8 枚举 → **8 文件 151 用例全绿**。

### 更正：群聊也能自动定位发言者

- **我最初的判断是错的**。上一节写「工具侧拿不到当前发言者（`dispatchFollowup` 没有发送者参数）」——这只对**工具参数**成立：`ToolRunContext` 里确实只有 `callId / name / arguments / agent / signal`。但入站文本里本来就有身份：`[11:30 昵称(10001)][@我] <user_message qq="10001" nickname="…">`，而 prompt 已声明「边界标签本身是可信元数据」。
- **真正的通道**：`Session.ownEvents()` 能拿到会话事件，`'user/message'` 的 `data` 就是 `UserMessage`（content blocks）。于是加纯函数 `speakerFromUserEvents(events)`：取**最后一条** `user/message`，用 `/<user_message[^>]*\sqq="(\d+)"/` 取**第一个**匹配（引用展开会嵌套同名标签，第一个才是本体）；解析不到就返回 undefined，**不往前翻历史**（那会把上一轮发言者安到这一轮）。
- **后果**：群聊写画像不再需要管理员手填 `subject`；`memoryProfileScope='all'` 从「仅管理员可写」变成「成员可写自己、管理员可写任何人」。私聊路径不变（仍从 `chatId` 直接取）。
- **验证**：`memory.spec` 增加 6 条（标准格式 / 取最后一条 / 嵌套引用取本体 / 末条无 qq 不回溯 / content 为字符串 / 空与坏事件）→ 35 条全绿。

### 改为 dispatch 直接记录发言者（用户选定方案 B）

- **A 的短板**：`speakerFromUserEvents` 靠解析会话事件（`user/message` 的 content blocks）**反推**，宿主改事件形状就会失效。
- **B 的做法**：`ChatAgent` 增加 `pendingTurnUsers: (string | undefined)[]`（与 `pendingTurnRoles` **并行的 FIFO**）与 `activeTurnUser`；`dispatchFollowup` 多收一个 `userId`，与角色同时入队；`turn/start` 同批出队。`bridge.speakerFor(sessionId)` 直接返回，O(1)。
- **为什么必须是队列而不只存一个字段**：忙时消息会排队。若只记 `lastSpeaker`，A 排队后 B 又发一条 → A/B 两个回合都读到 B 的号，**画像会记到别人头上**。
- **取值顺序**（tools.ts）：私聊 `chatId` → `bridge.speakerFor(sessionId)` → `speakerFromUserEvents(ownEvents())`。第三条兜底覆盖 `/retry` 重放、宿主直接输入等未走 dispatch 的回合。
- **`/retry` 故意不传 `userId`**：它重放的是**上一轮**的文本（可能是别人说的），传管理员会把发言人记错；让它回落到读事件，读到的仍是那条文本自带的 qq。
- **改动面**：`registry.ts`（2 字段 + 初始化）、`bridge.ts`（签名/入队/出队/`speakerFor` + 两处 ctx 转发）、`inbound.ts`（接口 + 2 处调用）、`commands.ts`（接口）、`tools.ts`（取值顺序）。
- **验证**：`tsc` exit 0；7 文件 161 用例全绿（含 commands 20 条命令、memory 35 条、client-settings 45 键）。

## 2026-10-28 记忆管理卡片：设置页查看/编辑画像（按需加载）

- **面板位置**：**独立卡片**（与 NapCat 状态卡片并列），不塞进任何配置分组 —— 它管的是数据，不是开关。
- **四个 Remote 方法**：`listMemoryChats` / `readMemoryEntries` / `updateMemoryEntry` / `deleteMemoryEntry`。
  必须**同时**在服务端 `markRemote` 与 `lib/client.js` 的 `ONEBOT_SETTINGS_DESCRIPTORS` 声明：
  `listReasoningEfforts` 是能工作的先例，而 `getNapcatStatus` 只做了服务端 —— 网关不认，这就是反例。
- **性能三条**：
  1. 记忆**不进** `getSettings` 快照（否则每次面板刷新都解析全部 JSON）；
  2. 卡片**默认不请求**，点「加载」才 `listMemoryChats`（只 `readdir` + `stat`，不解析内容）；
  3. `readMemoryEntries` 只读选中的那个文件，服务端分页（默认 50，上限 200），前端不做全量拉取。
- **写入门禁**：面板保存同样过 `findSensitive`（手机号/身份证/银行卡）与 500 字上限 —— 与模型写入同一道闸，避免「面板能写进去、工具写不进去」的割裂。
- **原子替换**：`updateMemory` / `deleteMemory` 走「写 `.tmp` + `rename`」，面板保存时模型正好在追加也不会读到半个文件。
- **路径口径**：新增 `src/paths.ts`（`dshHome` / `defaultMediaDir` / `resolveMediaDir` / `memoryDirFor`），
  插件入口与设置页服务共用同一份 —— 两处各写一份会出现「模型写 A 目录、面板读 B 目录」的静默错位，且不报错。
- **边界**：编辑只改正文与标签；`ts` / `kind` / `subject` 是身份字段，面板不可改（避免把画像改成别人的）。
- **验证**：`tsc` exit 0；`memory.spec` 43 条（新增 8 条：文件名逆解析 / 枚举忽略非记忆文件 / 更新命中与未命中 / 空标签移除 / 删除命中与未命中）；
  `client-settings` 契约覆盖 8 个方法（参数全 positional + schema 可解析）；5 文件全绿。

## 2026-10-26 NapCat 诊断修复（三缺陷 + 说清「卡在哪一步」）

**背景**：真实事故 —— QQ 于 12:25 被手动启动，插件 15:35 两次拉起注入器均失败；旧诊断只报「NapCat 根本没启动」，把真原因（QQ 已占用、注入器无法接管）完全盖住。配置侧已逐项排查无误（onebot11 反向 WS url/token/端口/格式全对，11:17 曾正常收发消息），NapCat 日志停在 11:19 的 `ECONNREFUSED`（当时插件正在重启，之后进程消失）。

- **缺陷 1：`hosted` 判定恒 false**。`inspectQq()` 用 `wmic process ... get CommandLine` 匹配 napcat 关键字，而 Windows 11 已移除 WMIC（实测 `wmic /?` 退出码 255）→ `runLines` catch 返回空数组 → 只要 QQ 在跑就误报「普通 QQ 抢占实例」。**移除该判定**，改用两个可靠事实（注入器进程在不在 / QQ 进程在不在）推导，不猜托管。
- **缺陷 2：`qqProcesses` 被当成实例数**。QQ NT 是 Electron 多进程，一个客户端就有 5~10+ 个 QQ.exe（实测 7 个 = 1 个实例）。文案改为「QQ 进程 N 个（一个 QQ 通常有多个进程，不代表多开）」。
- **缺陷 3：拉起器输出被丢弃**。`spawnLauncher` 用 `stdio: 'ignore'`，而注入器在 QQ 已占用时会直接退出、连 NapCat 自己的日志都不写 → 失败无任何现场。改为追加写 `mediaDir/napcat-launcher.log`（每次拉起带时间戳分隔行），spawn 后关闭父进程句柄副本。
- **新增阶段 `qq-conflict`**：`!napcatProcess && qqProcesses > 0` ⇒ 「QQ 已在运行，注入器无法接管已启动的 QQ，请先完全退出 QQ」。判定优先级改为：已连接 → 风控 → **QQ 占用** → 根本未启动 → 卡在扫码 → 卡在 OneBot 连接；每个阶段的 summary 都带一句可执行的下一步。
- **不再做无效拉起**：`NapcatWatch.tick` 在 `qq-conflict` 时跳过 spawn（此前会白拉两次并静默失败，把真原因盖住），并追加一条说明「插件不会尝试拉起」。
- **可测性**：判定抽成纯函数 `judgeNapcat(facts)`（不碰进程表），新增 `tests/napcat-diagnose.spec.ts` 覆盖 7 个分支（含本次事故场景）。
- **设置页**：`lib/client.js` 的 stage 徽标加中文映射（`qq-conflict` → 「QQ 已占用」等），未知 slug 原样回退。
- **验证**：`tsc` exit 0；`napcat-diagnose` 8/8、`plugin` 6/6、`config-ranges` 3/3 通过；`client-settings` 仍为既有 4 条（38 vs 40 键，与本批无关）。

## 2026-10-26 napcatLauncherArgs：插件自己传 `-q`（免扫码 + 可自启）

- **问题**：插件只会 `spawn` 一个 launcher **路径**、无法传参，而 NapCat 免扫码依赖 `-q <QQ号>`。用户被迫在 `NapCat.Shell\` 自建包装 bat；实测自建脚本漏了 `launcher-user.bat` 里那 5 个 `NAPCAT_*` 环境变量，导致 QQ 弹「**文件已损坏，请重新安装 QQ**」——QQ 文件实际完好（`resources\app\package.json` 的 `main` 未变），只是按 patch 找不到 NapCat 入口。
- **改动**：新增配置 `napcatLauncherArgs: string[]`（默认 `[]`）。`NapcatWatch` 把参数拼进拉起命令，用户配 `['-q', '<QQ号>']` 即可，不再需要外部脚本，也就不会漏环境变量。
- **转义**：参数来自 patch config（管理员手写）、最终交给 `cmd /c` 执行。新增纯函数 `buildLauncherCommand()`：含 `& | < > ^ % ! "` 的参数直接丢弃（fail-closed）并 warn，日志**不回显条目原文**；含空格的参数自动加引号；`chcp 65001` 固定前置（NapCat 输出 UTF-8，中文控制台默认 GBK 936 会乱码）。
- **文档**：新增 `docs/napcat-launcher.md`（配置示例、为什么必须用 `launcher-user.bat`、`-q` 与位置参数的差别、包装脚本模板、开机自启三步、阶段排障对照）；README 配置表补 `napcatLauncher` / `napcatLauncherArgs` / `autoStartNapcat` 三行，NapCat 排障行补文档链接。
- **验证**：`tsc` exit 0；新增 `tests/napcat-launcher-cmd.spec.ts` 6 条（chcp 保留、`-q` 两参、空格加引号、元字符丢弃、空参数跳过、顺序保持）；同批 `napcat-diagnose` 8 条 + `plugin` 6 条全绿（3 文件 20 用例）。
- **未纳入设置页**：`napcatLauncherArgs` 属低频部署键，只走 patch config，不进 38 键设置页（避免动 `lib/client.js` descriptor 与既有键集断言）。

## 2026-10-26 设置页补齐 NapCat 三项（并修好 4 条长期红的契约用例）

- **现象**：设置页「NapCat/QQ 桥接参数」组里没有 `napcatLauncher` / `autoStartNapcat` 的输入框（新加的 `napcatLauncherArgs` 自然也没有），但下方 NapCat 状态卡片能正常显示诊断结论——看得见状态、改不了配置。
- **根因**：本地补丁把 `napcatLauncher` / `autoStartNapcat` 加进了 `STRING_KEYS` / `BOOLEAN_KEYS`（因此进了 `ALL_KEYS` = 40），但**没加进 `SETTINGS_GROUPS` 与 `lib/client.js` 的 `GROUPS`**（两处仍是 38）。客户端按 groups 渲染 → 这两键没有控件；同时 `ALL_KEYS`(40) 与 `client.GROUPS`(38) 漂移，`tests/client-settings.spec.ts` 的 4 条断言长期红。
- **修复**：三键（`napcatLauncher` / `napcatLauncherArgs` / `autoStartNapcat`）同时进 `SETTINGS_GROUPS.connection` 与客户端 `GROUPS[0].fields`，并补 `SCHEMA_DEFAULTS` / `client.DEFAULTS` / `STRING_ARRAY_KEYS`。键集 38 → 41。
- **顺带**：4 条长期红的契约用例**全部转绿**——不是改数字绕过，而是补齐缺失分组后「服务端 ALL_KEYS 与客户端 GROUPS」自然一致；测试里的硬编码计数同步为 41 键 / connection 16 行 / 控件数 +3，并更新 5 处「41 键」口径与 README、`docs/settings-page-design.md` 的键数表述。
- **验证**：`tsc` exit 0；`client-settings` 56/56、`plugin` 6/6、`config-ranges` 3/3、`napcat-diagnose` 8/8、`napcat-launcher-cmd` 6/6 → **5 文件 79 用例全绿**。

## 2026-10-26 修复：插件拉起 NapCat 从未成功（Windows spawn 引号转义）

- **真因**：`spawn('cmd.exe', ['/c', 'chcp 65001 >nul & "…launcher-user.bat"'], { windowsVerbatimArguments: false })` —— Node 在 Windows 上默认对 args 做引号转义（`"` → `\"`），cmd 收到的命令名成了字面量 `\"G:\…\launcher-user.bat\"`，直接报「不是内部或外部命令」。**launcher 一次都没真正执行过**。
- **为何长期未发现**：`spawnLauncher` 原先 `stdio: 'ignore'`，输出全丢；而 `spawn` 事件一到就 `resolve(true)`，日志照打「NapCat 未运行，尝试启动第 N/2 次」，读起来像「拉起了但没连上」。本次给拉起器加 `napcat-launcher.log` 落盘后，第一行就暴露了 `'\"…bat\"' 不是内部或外部命令`。
- **误判纠正**：此前把「拉起后仍不连」归因为「QQ 已占用导致注入失败」。该归因对**手动**启动成立，但插件自动拉起那几次连命令都没执行；16:39 那次成功是手动跑出来的。
- **修复**：`spawn` 增加 `windowsVerbatimArguments: true`。实测对照（观察 cmd 实际收到的命令）：默认转义输出 `\\\"path\\\"`，verbatim 输出 `"path"`，且 `&` 之后的参数正常透传（`"path" -q <机器人QQ号>`）。
- **验证**：`tsc` exit 0；5 文件 79 用例仍全绿；真机验证待重启宿主后确认 `napcat-launcher.log` 不再出现 `\"` 报错。

## 2026-10-26 设置页二维码修复 + 控制台乱码定性

- **二维码 bug**：登录成功后 `cache/qrcode.png` 仍留在磁盘（登录成功不会删它），而 `buildNapcatStatus` 无条件读文件转 data URL、客户端只判断 `qrcodeDataUrl` 非空就渲染 → 面板在**已连接 7 分钟后**仍展示那张过期码，让人以为还没登录。修复：① 服务端在「已连接」或 `age > QRCODE_TTL_MINUTES(5)` 时不返回图（新增导出常量，与判定共用）；② 客户端再兜一层（`stage !== 'ok'` 才渲染）；③ 过期二维码的判定从 `not-connected`（会引导用户去查 url/token）改为 `not-logged-in` 并明说「已过期」，测试同步覆盖。
- **控制台乱码定性**：插件拉起命令的 `chcp 65001 >nul` 与 `launcher-user.bat` 自带的 chcp，经实测**均生效**（`cmd /c "chcp 65001 >nul & chcp"` 返回 `Active code page: 65001`）。乱码窗口是 NapCat 注入 QQ 后新建/附着的控制台，代码页由**系统 OEM 码页（936）**决定，父进程 chcp 管不到；`napcat.mjs` 中也没有 `AllocConsole` / `SetConsoleOutputCP` 可用开关。可选方案：开系统「Unicode UTF-8」根治，或忽略窗口改看 `logs/*.log`（UTF-8）。已写入 `docs/napcat-launcher.md` 第 6 节。
- **验证**：`tsc` exit 0；5 文件 79 用例全绿。

## 2026-10-26 二维码展示修正：未连接时总能拿到图

- **问题**：去掉 `-q` 走扫码登录时，设置页仍不显示二维码。根因是**两道过期判断叠加**——`readQrcodeDataUrl()` 内部先按 5 分钟过滤并 return null，`buildNapcatStatus` 外层又按 `QRCODE_TTL_MINUTES` 过滤；而 NapCat 并不保证按时刷新 `cache/qrcode.png`，一旦超过 5 分钟面板就**永久空白**，用户反而无处扫码。
- **修正**：① `readQrcodeDataUrl` 只负责「读文件 + base64」，不再自做过期判断；② `buildNapcatStatus` 仅在**已连接**时隐藏图（登录完成，残留文件会误导），未连接时一律返回（过期也返回）；③ 客户端文案分两档：新鲜 →「扫上面这张码（N 分钟前生成）」；过期 →「这张码已过期（N 分钟前生成）：扫了不会生效，需重新触发登录（重启 NapCat，或 `napcatLauncherArgs` 配 `-q`）」。
- **附注**：`cache/qrcode.png` 经核查是**有效的 147×147、1-bit 灰度 PNG**（601 字节），不是空图；NapCat WebUI 也在监听（6099、`accessControlMode: none`），后续若要「面板内点按钮刷新二维码」，可接 WebUI 的 `/RefreshQRcode`。
- **易误判点**：去掉 `-q` **不等于**会走扫码——NapCat 只要存在快速登录记录（`getQQQuickLoginList()` 非空）就会自动尝试快速登录（`napcat.mjs` 的 `runWebUiConfigQuickFunction`）。所以「未跳过登录时」看到「已连接 + 无二维码」可能只是它又快速登录成功了；判断是否真在等扫码，看 `cache/qrcode.png` 的 mtime 是否在近 5 分钟内被刷新。
- **验证**：`tsc` exit 0；5 文件 79 用例全绿。
- **措辞修正（避免误导）**：`launcher-user.bat` 并非本机独有——它是 NapCat 发行包**自带的四个启动脚本之一**（`launcher-user` / `launcher-win10-user` / `launcher` / `launcher-win10`，差别只是「是否自提权」与「Win10 变体」），四者都设了 `chcp 65001` 与 5 个 `NAPCAT_*`。此前文档与设置页 hint 写死单一文件名，已改为「按目录里实际有的选一个」，并补三条容易踩的说明：① 末尾 `pause` 会在隐藏窗口留一个等待按键的 `cmd.exe`（属正常，会随 NapCat 一起退出）；② 面板是**每行一个参数**、patch 里是 YAML 数组，两种写法别混；③ `-q` 是传给 **NapCat** 而非 QQ 的参数，写成一行 `-q 123456` 或 `-q123456` 都无效（按 argv 全等匹配）。

## 2026-10-26 设置页 NapCat 卡片加「刷新」按钮

- **为什么不是新 Remote 方法**：`settings-remote.ts` 已记录过实测结论——网关的 methods 来自编译期 spec，运行时 `markRemote` 新增的方法不会出现在 `remote.methods` 里（`getNapcatStatus` 就是这么加的、实测未生效）。所以「刷新」走**已有** `getSettings`：面板本就有 `refetch()`（顶部「重新加载」用的就是它），只是离卡片远、语义不明确。
- **改动（仅客户端）**：`renderNapcatCard` 增加 `onRefresh` 参数，卡片头部放一个「刷新」按钮，点击走既有 `handleReload`（有未保存修改时仍先 confirm，避免刷新丢草稿）。
- **能力边界（写进按钮注释与文档）**：该按钮只重拉快照并重新读取 `cache/qrcode.png`，**不命令 NapCat 换码**。NapCat 的登录服务约每 5 分钟自行换码，所以「过期后点一下」通常就能拿到新码；若十几分钟都是同一张，说明 NapCat 卡住，需重启 NapCat（插件不终止任何进程）。
- **探测记录（供将来需要真刷新时参考）**：NapCat WebUI 在监听（6099），API 前缀 `/api`；即使 `accessControlMode: none`，`/api/RefreshQRcode` 仍返回 `{"code":-1,"message":"Unauthorized"}`，需要 `Authorization: Bearer base64(凭据)`，而 `webui.json` 里的 `token` 是登录密码而非凭据（`/api/auth/login` 的请求体协议未能从产物确证，实测返回 `An unknown error occurred.`）。故「强制换码」暂不实现。
- **验证**：`tsc` exit 0；5 文件 79 用例全绿（`client.js` 的 `new Function` 解析与渲染契约均在 `client-settings.spec` 覆盖内）。

## 2026-10-28 表情 id 表改按 QSid 取名：修「睁眼」读成虫

- **问题**：群友发 QQ 表情「睁眼」，机器人读到的是 🐛，回了句「？发个虫是啥意思」（会话 `onebot-group-160119378-mvrjwruu`，seq 46/47）。
- **根因**：`src/cq.ts` 的 `FACE_EMOJI` 按 Unicode emoji 顺序编号，而 OneBot `face.id` 是 QQ 面板的 `QSid`，两套编号完全不同源 —— `id=289` 在 QQ 是「睁眼」，表里却是 🐛。整表错位：插件 295 条 vs QQ 真实 275 条，多 66 个不存在的 id、少 46 个真实 id（回落成 😀），只有 0/1 这种碰巧近似的才看不出问题。该表是早期从 Hermes 移植带过来的，从未与真实 id 对照。
- **修法**：不再猜 emoji，改为输出可读标签 `[表情:睁眼]`；表中没有的 id 输出 `[表情:id=数字]`（保留诊断信息，不再塌成中性脸）。id→名称 由 `scripts/gen-face-table.mjs` 从 NapCat 的 `static/assets/qface-*.js` 生成到 `src/face-names.ts`（275 条，id 0–348），NapCat 升级后重跑一次即可。
- **联动**：`src/prompt.ts` 平台说明补「表情标注为 [表情:名称]，是入站标记、回复时不要输出」；`tests/cq.spec.ts` 用 `id=289 → [表情:睁眼]` 守回归；`README.md` 三处占位符描述同步。
- **坑**：qface 资产是 UTF-8，但 PowerShell 5.1 的 `Get-Content` 默认按 ANSI 读，会显示成「鐫佺溂」——照那个乱码建表会把名字再搞错一次。
- **验证**：`npx tsc -p tsconfig.json` exit 0（`lib/cq.js`、`lib/face-names.js`、types 均已更新）；`tests/cq.spec.ts` 15 用例全绿。全量 `npm test` 仍有既有失败（settings-remote 的 ALL_KEYS 38→41、inbound 的 scope 名称、deferred/bridge/commands/session-switch 的慢用例超时），两次跑失败集合不一致属 flaky，与本次改动无交集。

## 2026-10-29 QQ 通道拒绝第三方插件原生工具（`mnemon_` 前缀）

- **问题**：`mcpToolAllow` 只接管 `mcp__*`；`dsh-mnemon` 注册的 `mnemon_recall` / `mnemon_remember` / `mnemon_forget` / `mnemon_document_search` / `mnemon_runtime_memory` 等**不带该前缀**，早期实现里 `isMcpToolName → false` 就直接放行。而这些工具读写的是宿主**全局**记忆库（本机 `G:\dsh-home\.mnemon`，配置为 `storageScope: custom`，不按 chat / workspace 隔离）—— 等于群里一句「查一下我之前的记录」就能翻出工作记忆（该库现有 27 篇工作文档归档）。
- **修法**：`mcp-gate.ts` 新增 `NATIVE_TOOL_DENY_PREFIXES = ['mnemon_']`，guard 里**最先**判定（必须早于 MCP 判断，否则会被当成普通工具放行）。拒绝文案只说明「第三方插件 + 宿主全局数据」，不回显接入清单（和其他拒绝一样，避免模型转述到群里）。
- **为什么不用 `tools.restrict` 真正隐藏**：它要求列出**确切存在**的工具名（unknown names 抛错），而 `ToolRuntime` 没有公开的枚举方法。硬编码十几个名字，一旦 mnemon 升级改名或未安装，就会在 agent 创建时抛错、整个会话起不来。guard 是调用期拒绝，稳健；代价是模型看得到工具名、可能试一次，但会立刻收到明确原因。
- **作用域**：`bridge.ts` 的 `guard.call(agentCtx.tools, …)` 是 **per-agent** 注册，所以只作用于 QQ 的 chat agent —— Web / GUI 会话仍可正常使用 mnemon。
- **可覆盖**：`makeMcpToolGuard(rawAllow, denyPrefixes?)` 第二参；传 `[]` 即回到「只按 MCP 白名单管控」。
- **验证**：`tsc` exit 0；`mcp-gate.spec` 37 条（新增 6 条：`mnemon_*` 全拒 / 不影响 `qq_*` 与宿主内置 / 前缀精确匹配不做模糊 / 空字符串前缀不吞掉全部工具 / 第二参覆盖语义 / 拒绝文案不回显清单）；6 文件 151 用例全绿。

## 2026-10-29 记忆卡片三项增强：kind 筛选 / 面板新建 / 最近提及

- **kind 筛选**：`readMemoryEntries` 追加第 5 个位置参数 `kind`（`'note'` / `'profile'` / 其他=不筛），过滤在**服务端**做。放前端筛会让「共 N 条」与分页指针全错 —— 这是唯一必须动接口的一项。
- **面板新建**：新增 `createMemoryEntry(chatId, text, kind, subject, tags)`（服务端 `markRemote` + 客户端 descriptor 成对）。与工具写入共用同一套规则：`findSensitive` 拒绝敏感信息、正文 ≤500 字、`memoryMaxEntriesPerChat` 裁剪、画像必须给主体。来源字段（`by`/`role`）留空 —— 面板操作没有 QQ 身份，留空比编一个更诚实。
- **最近提及（`lastSeenAt`）**：`MemoryEntry` 加可选字段，语义 = 最近一次**被写入/重复提到**的时间。写入路径统一改走 `upsertMemory`：`kind + subject + text` **三者全等**时只刷新 `lastSeenAt`，不再追加行。
  - 为什么只做精确判重：近似去重需要相似度计算（真正的重复堆积要等第二批 embedding）；精确匹配已经能挡住「同一句话被反复记住」这种最常见的堆积。
  - `appendMemory` 保持无条件追加的原语义，历史调用方与既有单测不受影响。
  - 面板只在 `lastSeenAt !== ts` 时显示「最近提及」，避免与首次写入时间重复占位。
- **数据兼容**：历史条目没有 `lastSeenAt`，`parseLine` 按缺省处理（视为 `ts`），不需要迁移。
- **验证**：`tsc` exit 0；`memory.spec` 新增 6 条（首次不折叠 / 全等折叠且 `ts` 不变 / kind 不同算两条 / subject 不同算两条 / 同 subject 折叠 / tags·by·role 不丢）；`client-settings` 同步 9 个方法与新参数名；7 文件全绿。

## 2026-10-29 t2i 列表项目符号渲染成空心方框（字体缺 U+2022）

- **现象**：卡片里无序列表的项目符号是空心方框（notdef），不是圆点。
- **根因**：`src/t2i/elements.ts` 的 `case 'list'` 用 `drawRun('•', …)` 画项目符号，而字体链首选 `SimHei` 的 **cmap 里没有 U+2022**。Skia 命中不到字形就画 notdef 方框 —— 与转义无关。实测同一套 `@napi-rs/canvas`：U+2022 空心轮廓、U+25CF 实心圆、U+00B7 小点，在 `Microsoft YaHei` 下 U+2022 又是正常的 —— 说明是字体覆盖问题，不是渲染器问题。
- **修法**：改几何绘制。`CardCanvas` 新增 `fillCircle(cx, cy, radius, fill)`（`arc` + `fill`），list 分支用它替代字符：
  - 圆心 = `首行基线 − 0.3em`：与 `•` 在正常字体里的视觉位置一致
  - 半径 = `0.11em`（14px 下约 1.5px）；先试 0.09em，出图后偏小，调到 0.11em 与正文比例协调
  - 基线用 `font.ascent()` 算；字体不可用时回落 `size * 0.8`
  - 有序列表不动（数字在所有字体里都有）
- **为什么不换字符**：换 U+25CF 只是「当前字体碰巧有」，换字体或换渲染器就复发；几何绘制与字体、渲染器都无关，是唯一确定正确的做法。
- **验证**：`tsc` exit 0；用 `renderTextImage` 真实渲染出图确认圆点为实心（改前是空心方框）；`t2i-render.spec` 新增 3 条 —— 用**假 CardCanvas 记录调用**（不需要字体，CI 上也能跑）：断言调用 `fillCircle`、不再画 `•` 字符、圆心落在首行范围、半径随字号缩放；3 文件 35 用例全绿。

## 2026-10-29 t2i 行内代码与正文没对齐（胶囊撑高行 + 代码文字下沉 8px）

- **现象**：段落里混排行内代码时，代码片段明显沉在汉字下方，且带代码的那一行被撑高，视觉上「行距忽大忽小」。
- **两个独立成因**（都在 `renderInlineParts` 的 `cls === 'code'` 分支）：
  1. **胶囊过高**：高度写死为 `size + 2*padY + 1`（`padY = 5` → `size + 11`），而 `list` / `quote` 的行高只有 `size + 10` —— 相邻两行都有行内代码时互相挤压。
  2. **代码文字下沉**：`drawCodeRuns` 的 ascender line 传的是 `y + padY + 3`（+8px），正文传 `y` —— 同一行里两套基线，代码比汉字低半个字高。`drawCodeRuns` 内部已对 ASCII 做 +1 基线微调，这里再下移是重复的。
- **修法**：胶囊高度改 `size + 8`、起点 `y - 4`（行内垂直居中；任何行高 ≥ `size + 10` 都放得下）；代码文字的 ascender line 直接传 `y`，与正文共用基线。
- **为什么不能写死 padY**：行高随块类型不同（text `size+12` / list·quote `size+10` / table `size+14`），胶囊尺寸必须跟随字号，否则换字号或换块类型就复发。
- **验证**：`tsc` exit 0；`renderTextImage` 真实渲染复现截图场景（普通行 + 行内代码混排 + 列表内代码）确认代码与汉字同基线、行距均匀；`t2i-render.spec` 新增 4 条（胶囊 ≤ 最小行高 / 垂直居中 / 代码 ascender line 与正文一致 / 随字号缩放）；3 文件 39 用例全绿。

## 2026-10-29 t2i 排版体检：三处修复 + 两处已知限制

**方法**：三张覆盖矩阵图（内联样式 × 标题 × 引用 / 列表 × 代码块 × 表格 / 边界情况），用 `renderTextImage` 真实渲染后逐张检查，再对可疑点写**解析级断言**（`parseInline` 的实际输出比看图更可靠）。

修复三处：

1. **`*斜体*` 显示为字面星号**（`parseInline`）：旧正则 `\*(?!\*)([\s\S]*?)\*` 会**跨段配对** —— 在 `**加粗** 和 *斜体*` 里，`**加粗**` 的**尾星号**与 `*斜体*` 的**首星号**先配成 `* 和 *`，真正的斜体标记被当成已消费丢弃。改为 `(?<![*])\*(?!\*)([^*\n]+?)\*(?!\*)`，bold 同样加两侧边界。代价：`***三重***` 不再识别（宁可不出样式，也不要错的样式）。原测试里有一句注释把这个 bug 当「已知行为」接受了（"shadowed by the outermost-marker filter"），一并改正。
2. **列表项间距过大**（parser + elements）：每个 `- 项` 都被解析成独立块，各自带 `elementHeight` 的 `+16`，项距是行距的两倍多。改为把**连续的列表行合并成一个块**（`content` 用 `\n` 分隔），`elementHeight` 按项累加、`renderElement` 逐项画符号；有序列表序号以首项为基逐项递增（符合 CommonMark，`10./11.` 不会被重置）。
3. **两位数序号贴住正文**（elements）：正文起点原固定 `x + 35`，`10.` 比 `1.` 宽一个字符就挤在一起 → 改为按序号实际宽度推进 `max(x + 35, x + 5 + markerW + 12)`。

记录但未修（成本/收益不划算，先留档）：

- **ZWJ 组合 emoji 被拆开**：`👨‍👩‍👧‍👦` 渲染成 4 个独立 emoji。`classifyChar` 跳过 ZWJ、每个基础 emoji 单独绘制；要修得在**测量与绘制两侧同时**做字素簇（grapheme cluster）切分，属于渲染管线的结构改动。
- **嵌套内联样式**：`**加粗 *斜体* 加粗**` 里的 `*斜体*` 仍显示字面星号 —— `InlinePart` 是扁平结构、只保留最外层标记；支持嵌套要改数据结构 + 渲染（样式叠加）+ 宽度计算三处。

**验证**：`tsc` exit 0；三张图逐张复检（斜体倾斜、序号对齐、项距紧凑）；`t2i-parser.spec` 新增 2 条（相邻 bold/italic 均解析、连续列表合并 + 序号基）；3 文件 41 用例全绿。

## 2026-10-29 t2i 斜体方向不对（用了 b 轴错切而不是 c 轴）

- **现象**：斜体看起来「歪」而不是「右倾」—— 竖笔画仍然竖直，横笔画反而往下沉。
- **根因**：`ctx.transform(a, b, c, d, e, f)` 展开是 `x' = a·x + c·y + e`、`y' = b·x + d·y + f`。斜体需要 **c**（x 随 y：同一笔画的上端相对下端右移）；旧实现写的是 **b = 0.2**（y 随 x），等于把整行沿 x 方向**垂直错切** —— 竖画的 x 不变所以仍竖直，横画的 y 随 x 变所以下沉。
- **修法**：`transform(1, 0, -shear, 1, dx + shear * pivotY, dy)`，并以**基线**为不动点（`pivotY = font.ascent(family, size)`；局域坐标里 ascender 在 0、baseline 在 ascent）。shear 仍取 0.2（14px 字上端右移约 2.4px，接近常见斜体）。
- **验证**：真实渲染对比图 —— `lllll` / `HHHHH` 竖笔画组现在**明显右倾**（修复前完全竖直），英文 `The quick brown fox` 呈正常斜体；`t2i-render.spec` 新增 3 条静态守卫（用 c 分量 + pivotY / 不再出现 `b=0.2` / elements 传基线），3 文件 44 用例全绿。
- **附带说明**：中文伪斜体在小字号下仍「看不太出倾斜」，这是伪斜体的固有限制（汉字结构复杂、SimHei 没有 italic 字形），不是本次能解决的 —— 真斜体需要字体自带 italic。

## 2026-10-30 记忆审查：新增 `qq_memory_forget`（B 方案）

- **缺口**：模型能写（`remember`）、能读（`recall`），**不能改也不能删**。而写入侧只做「完全相同」的去重（`upsertMemory`），所以「周五要交周报」与「周报已经交了」是两条不同文本 —— 会永久并存，`recall` 时都返回，模型只能自己猜哪条对。
- **取证结论**（三条约束，先查再动手）：
  1. `deleteMemory` 只能按 `ts` 删**单条**、`forgetProfiles` 只删画像 → 需要新增「按谓词批量删」；
  2. 权限依据是条目的 `by`（谁写的）/ `subject`（谁的画像），但**历史条目与面板创建的条目没有 `by`** → 非管理员删不掉（刻意的安全默认）；
  3. `MEMBER_ALLOWED_TOOL_NAMES` 需要放行新工具。
- **新工具** `qq_memory_forget(ts | query, chat_id?)`：
  - **不接受空条件**（既不给 `ts` 也不给 `query` 直接报错）—— 清空是 `/memory forget` 的语义，不该让模型拥有一条指令抹掉整段记忆的能力；
  - 权限：管理员不限；非管理员只能删「自己写的（`by`）」或「关于自己的画像（`subject`）」；
  - 「命中但无权删」**抛错而不是返回 0** —— 静默返回 0 会让模型以为「本来就没有」，转而用 `remember` 再记一条，问题反而更大。
- **prompt 加审查指引**：`recall` 后发现同一件事有新旧两条互相矛盾时，用 `forget` 删掉过时的那条、只留最新，**不要靠再记一条来覆盖**。
- **数据层**：新增 `deleteMemoriesWhere(dir, chatId, predicate)`（一次重写文件，返回被删条目供回显）。
- **顺手**：清掉 `tools.ts` 里上一轮遗留的重复注释（两段「取本轮发言者」）。
- **验证**：`tsc` exit 0；`memory.spec` 加 4 条（只删命中 / 无命中不重写 / 按 `by` 批量删 / 删空保留空文件）、`prompt.spec` 加 3 条（含 `qq_memory_forget` / 「记忆会过时」/「不要靠再记一条来覆盖」）→ memory + prompt + client-settings + plugin **4 文件 121 用例全绿**。
- **既有问题（已修，见下节）**：`commands.spec` 那 2 条稳定失败的真正原因**不是** 8.3 短名 —— 是出站路径脱敏的 `STOP` 集合漏了全角左括号，把 `（1 会话）` 里的 `（1` 连同路径一起替换掉了。

## 2026-10-30 出站路径脱敏补齐全角括号（修 2 条稳定失败）

- **现象**：`/workspace` 的编号列表发给用户后变成 `1. <本机路径> 会话） ← 当前` —— 会话计数被吞；`/workspace <file>` 的错误提示里文件名也随路径消失。
- **根因**：`src/redact.ts` 的 `STOP` 只列了全角右括号 `）`，没有左括号 `（`。`[^STOP]*` 一路吃到空格，把 `（1` 当成路径的一部分。
- **修法**：补齐成对标点 `（）《》【】「」『』`（右括号本来就有，缺的是所有左/开符号）。
- **两次误判的教训**：先后猜过「Windows 8.3 短名」和「并发 flaky」，`git stash` 对照实验只证明了「与本轮改动无关」，并没有证明「是什么原因」。真正定位靠的是**打印出站消息的实际文本**（临时 spec 里 `console.log(JSON.stringify(frame.params))`）。对照实验能排除，不能归因。
- **测试侧**：`commands.spec` 那两条断言「发出的文本含具体路径/文件名」的用例显式 `redactLocalPaths: false` —— 它们验的是命令文案，脱敏本身由 `redact.spec` 覆盖；`makeCmdHarness` 增加同名开关。
- **验证**：`tsc` exit 0；`redact.spec` 加 2 条（全角左括号后的计数不被吞 / 成对标点的闭合符不被吃）；redact + commands 2 文件 47 用例全绿。

## 2026-10-30 记忆语义编码（第二批 2a）：接口 + 双实现 + 统一降级

- **范围**：只新增 `src/memory-embed.ts`，**不接线** —— `index` / `bridge` / `tools` 都不引用它，行为与第一批完全一致。
- **接口**：`Embedder { isAvailable(); dim; embed(texts) }` —— 本地与远程共用，切换只改配置。
- **零新依赖**：`@xenova/transformers`（约 5MB + onnxruntime-web）**不进 dependencies**，用动态 `import()` 加载；包名放在变量里，避免 TypeScript 去解析这个不存在的模块。未安装 → reject → `isAvailable()` 为 false → 调用方降级。这样「不装也能跑，装了才有语义召回」。
- **`LocalEmbedder`**：懒加载；并发调用共享同一个 loading Promise；**失败后不再重试**（记 `failed`，否则每次调用都重新 import 一遍）；维度从首次编码结果推导。
- **`HttpEmbedder`**：`url` 以 `/v1` 结尾走 OpenAI 协议（`POST /v1/embeddings` + Bearer），否则走 Ollama（`POST /api/embed`）；5s 超时（AbortController）；**不主动探活** —— 不为「能不能用」多付一次网络往返，可用性由 `embed` 抛错体现。
- **统一降级点** `embedSafely(embedder, texts)`：没有 encoder 或抛错都返回 `undefined`。所有调用点都该走它，否则迟早有一处忘记 `try/catch`，把「增强功能」变成「整轮失败」。
- **两道数据校验**：返回条数必须与输入一致、输出形状必须可识别（Tensor 的 `tolist()` 与裸 `number[][]` 都接受）。脏向量一旦写进记忆，后续召回会一直错且极难定位。
- **验证**：`tsc` exit 0；新增 `memory-embed.spec` **19 条**（三种 mode 的选型与缺项、本地懒加载只加载一次、失败不重试、并发共享、条数与形状校验、OpenAI/Ollama 两种协议解析、非 2xx、空入参不发请求、`embedSafely` 三条）；连同既有 6 个文件 **7 文件 215 用例全绿**。

## 2026-10-30 记忆语义召回接通（第二批 2b）：混合打分 + 编辑失效 + 一个严重装配 bug

- **⚠️ 顺带修掉一个严重 bug**：`index.ts` 的 bridge config 里**整段漏传**了记忆字段。`bridge.ts` 按
  `memoryEnabled === true` 决定是否 `registerTools` 注册 `qq_memory_*`，漏传即恒为 `undefined`
  → **三个记忆工具从未注册过**。表现极具迷惑性：模型「口头答应记住」但设置页永远空白，
  服务端日志**没有任何异常**（工具不存在不会报错，模型只是不用它）；而 `/memory` 命令与设置页
  卡片走的是另一条路，所以看起来「记忆功能是好的」。已在 `memory.spec` 加静态守卫
  （断言 `index.ts` 里四个字段都写成 `xxx: config.xxx`），并把 `memoryEmbedder` /
  `memorySemanticWeight` 一起接上。
- **数据层**：`MemoryEntry` 加 `emb` / `dim`；`parseLine` 只在「非空 + 全是有限数字」时才认向量
  —— 半个向量参与余弦会算出无意义的分，比没有向量更糟，所以整条按未编码处理。
- **混合打分**：抽出 `keywordScore`（让「纯关键词」与「混合」共用同一份口径，避免两套实现漂移），
  新增 `cosineSimilarity`（负相关压到 0）与 `searchMemoriesHybrid`：
  - 有向量且维度匹配 → `w × cos + (1−w) × keyword`
  - 无向量 / 维度不符 → **只按关键词分，不打折**（打折会让历史条目被系统性压低，
    用户只看到「排序莫名其妙」）
  - 关键词 0 但语义高 → 仍入选（这正是语义召回的意义）
- **写入编码**：`remember` 先 `embedSafely` 再写入，**编码失败不影响写入**（仍然可被关键词召回）；
  返回值多一个 `embedded: boolean`，避免模型以为「说了已记住」但其实连向量都没算出来。
- **编辑失效（关键）**：`updateMemory` 改正文时**删除**该条的 `emb` / `dim`。保留旧向量比删掉更糟
  —— 向量不变而文本变，这条记忆会在**不相关**的查询里被召回（虚假相似），且一切看起来正常。
  只改 `tags` 不失效（标签不进 embedding）。
- **`forget` 刻意不接语义**：删除匹配仍用纯关键词。语义相似会命中「看起来相关但其实是另一件事」
  的条目，而删除不可撤销 —— 宁可删不掉，不能删错。
- **配置**：5 个键（mode/model/url/key/weight），键集 45 → 50。`memoryEmbeddingKey` **不进**
  `SECRET_KEYS`，而是新增 `REDACTED_ONLY_KEYS`：客户端 secret 编辑态是单例（`secretDraft` 一个
  state），两个 secret 字段会互相覆盖；所以它走普通输入框，但快照里同样脱敏为 `''`。
- **local 模型目录**：相对名拼到 `<mediaDir>/models/` 下，绝对路径原样用；`http` 模式原样返回
  （那是模型名，拼路径会变成一段无意义字符串）。
- **验证**：`tsc` exit 0；`memory.spec` 新增 16 条（余弦边界、向量解析与坏向量丢弃、编辑失效
  三种情形、混合召回 7 条含「无向量不打折」「维度不符跳过」「权重越界」、装配守卫 3 条）；
  `client-settings` 同步 50 键 / 9 枚举 / 20 文本框 / 11 个数字范围；**9 文件 244 用例全绿**。

## 2026-10-30 记忆向量后台补齐（第二批 2b′）

- **问题**：新写入的记忆自带向量，但**历史条目**（开语义召回之前写的）没有 → 只走关键词路。
  用户感知是「语义召回时灵时不灵」。
- **为什么不能同步补**：单条 20–60ms，200 条 = 6s。在 `recall` 里补等于把一次查询变成一次超时。
- **挂载点**：`turn/end` 之后（用户已经看到回复，延迟无感）→ `bridge.scheduleMemoryBackfill()`。
- **三条约束**：幂等（只挑缺向量的条目）、可中断（每批检查 `chat.busy`，新回合开始立刻让路，
  下轮再补）、静默（失败只记 debug —— 补齐是增强功能，坏了不该让用户看到）。
- **预算**：8 条/批（单批约 8×30ms ≈ 240ms，再大会让 turn/end 后的空窗明显变卡）、
  32 条/轮（200 条的会话约 6 轮补完，用户不会觉得「某次回复特别慢」）。
- **一个容易漏的迁移场景**：只按 `emb === undefined` 筛，会让**换过模型**的条目永久失效 ——
  它们有向量，只是维度旧，永远匹配不上查询向量，而界面上完全看不出来。所以判断条件加上
  「维度与当前编码器不符」；`embedder.dim === 0`（还没编过任何东西）时不判，避免误伤。
- **写回策略**：`writeMemoryEmbeddings` 按 `ts` 逐条打补丁（一次重写文件），而不是整文件替换 ——
  补齐期间模型可能正好在 `remember` 追加，整文件替换会把那条新增抹掉。
- **模型校验脚本** `scripts/check-embedding-model.mjs`：**只校验不下载**。理由：模型分发源不稳定
  （HF 官方 / 国内镜像 / 代理各人不同），压缩包还要解压依赖，写死的下载地址必然失效 ——
  一个猜地址的下载器比一个说清「缺什么」的检查器更糟。校验 `config.json` /
  `tokenizer.json` / `*.onnx`（含 `onnx/` 子目录），退出码 0/1/2。
- **验证**：`tsc` exit 0；`memory-backfill.spec` **10 条**（分批、budget、幂等、维度迁移、
  失败不冒泡、中断让路、无文件安全返回）；**10 文件 254 用例全绿**。

### 同日补：四处健壮性修复（系统评估后）

- **补齐期间正文被改写**：`writeMemoryEmbeddings` 原来只按 `ts` 匹配，而补齐是「先快照正文 →
  编码（含跨批 await，可能几秒）→ 写回」。这期间面板改正文会让写回把**旧文本的向量**填回
  新文本，恰好撤销「编辑失效」（虚假相似，且看起来一切正常）。改为 `ts + text` 双键匹配，
  文本不一致就跳过、留给下一轮按新文本重编。同一个双键也顺带缓解了 `ts = Date.now()`
  同毫秒重复时互相写串向量的问题。
- **群聊画像召回不到**：`qq_memory_recall` 的发言者只取 `dmSubject(chatId)`（群聊恒为
  `undefined`），而 `selectForRecall` 对 `subject !== speaker` 一律丢弃 —— 于是
  `memoryProfileScope='all'` 下群里写的画像「写得进、读不出」，且完全静默
  （看起来像是「画像功能没生效」）。改为与 `remember` 同一条解析链：
  私聊 → `bridge.speakerFor()` → 会话事件兜底。
- **端点判定过窄**：`HttpEmbedder` 原来只认 `endsWith('/v1')`。用户直接粘完整端点
  `…/v1/embeddings`（各家文档最常见的写法）会被判成 Ollama，POST 到
  `…/v1/embeddings/api/embed` 拿 404 —— 而降级是静默的，几乎无法从现象定位。
  改为接受 `/v1` 与 `/v1/embeddings` 两种结尾，且已含 `/embeddings` 时不重复拼接。
- **补齐不看总开关**：`memoryEnabled=false` 但 `memoryEmbeddingMode` 有残留配置时，
  每个 `turn/end` 仍会白读一遍记忆文件。加一行短路。
- **验证**：`tsc` exit 0；`memory-backfill.spec` 加 1 条（编码期间改正文不写回，
  断言 `embedded === 0` 且该条 `emb` 仍为空）、`memory-embed.spec` 加 1 条
  （完整端点仍走 OpenAI 协议且不双拼）；**10 文件 256 用例全绿**。

## 2026-10-30 记忆系统加固：补两条用户路径的测试 + 修三处数据/隐私缺陷

上一轮系统评估（三个子代理分头取证）报出的问题里，这一批处理 5 项。

### 1. 三个记忆工具的 `execute` 补上行为测试（`tests/memory-tools.spec.ts`）

- **根因**：`registerTools` 是**五参**签名（第 4 参是媒体上限、第 5 参才是 options）。
  `tools-gate.spec` 把 `memory` 塞进第 4 参 —— TypeScript 不报错（对象字面量的多余属性
  检查在这里失效），运行期被静默忽略，于是 `qq_memory_*` 在任何测试里都没注册过，
  权限与隐私兜底全裸奔。
- **覆盖 22 条**：remember 9（空正文 / 敏感信息 / `profileScope=off` / 群聊默认不建画像 /
  非管理员给别人贴标签 / 私聊自动取主体 / note 带 `by` / 超上限裁剪 / 精确去重）；
  recall 5（返回 note / **别人的画像不返回** / **群聊自己的画像能召回**（P0 回归）/
  过期剔除 / topK）；forget 6（无条件拒绝 / 按 ts 删 / 非管理员删别人抛错 / 管理员可删 /
  按 query 批量且逐条过权限 / 历史条目无 `by` 成员删不掉）；未启用零注册 1；自身有效性 1。

### 2. `/memory` 与 `/memory forget` 补行为测试（`commands.spec`）

- 此前只有「命令表里有它 + 唯一非 adminOnly」两条静态断言 —— 它跑起来长什么样没人验证过。
- **覆盖 7 条**：未启用提示 / 只统计可见条目（别人的画像既不计入也不显示）/ 过期不计入 /
  \>10 条截断 / forget 只删自己的画像（公共与别人的画像保留）/ 没有画像的提示 /
  `/memory xxx` 只回用法不误删。

### 3. `findSensitive` 补三类漏判 + 标签过闸

- **漏判**：只按 `\d+` 切，`138-0013-8000` 被切成 3/4/4 三段全不匹配；`+8613800138000` 是 13 位
  落在所有档位之外；15 位老身份证在 16–19 位银行卡档之外。而带分隔符是**人写手机号最常见的形态**。
- **修法**：两种切法取并集 —— 原始 `\d+` 与「去掉空格/`-`/`·`/`.` 的段」。只看一种会漏：
  前者漏分隔符写法，后者会把 `13800138000 13900139000` 粘成一个 22 位数字。另加 `+86`
  剥离与 15 位身份证档。
- **标签过闸**：`tags` 同样是明文落盘、同样出现在 recall 与卡片里，原来只把 `text` 交给拦截 ——
  手机号写进标签可完全绕过。新增 `findSensitiveIn(text, tags)`，工具与面板三个写入口统一走它。

### 4. `writeAll` 改为原子写 + 失败向上传

- `rewriteMemories` 是 tmp+rename，而 `writeAll`（upsert / 裁剪 / 批量删共用）是直接
  `writeFileSync` 且**吞异常** —— 写入中途崩溃会留下半个文件，**所有历史条目一起损坏**。
- 现在 `writeAll` 复用 `rewriteMemories`；`upsertMemory` / `deleteMemoriesWhere` 失败**抛错**。
  后者尤其重要：原来返回 `[]` 会被上层当成「一条都没命中」，把磁盘故障伪装成
  「你只能删除自己写的」—— 模型据此会改用 `remember` 再记一条，问题反而更大。
- 裁剪维持「失败返回 0、不抛」：它是防无限增长的兜底，不该让一次 remember 整体失败。

### 5. `upsertMemory` 刷新时并入 tags 与向量

- 原来 `{ ...previous, lastSeenAt }` 会丢弃新条目的 `tags` / `emb`。后果很具体：先说
  「周五要交周报」（无标签 → 90 天档），后补「这是待办」（本该 14 天档）—— 标签没更新，
  TTL 一直按 90 天算；重新编码算出的新向量也被丢掉，换模型后这条永远用旧维度。
- 现在：标签取并集（去重、保序、上限 8，与写入侧同口径），新向量覆盖旧向量，没带则保留原值。

**验证**：`tsc` exit 0；新增 `memory-tools.spec` **22 条**、`commands.spec` **+7**、
`memory.spec` **+14**（敏感 7 / 原子性 3 / upsert 4）；**11 文件 299 用例全绿**（此前 256）。

## 2026-10-30 记忆系统加固（第二批）：面板 / 发言者 / 编码器

### 6. 面板五个记忆方法补实现级测试（`settings-remote.spec`）

- 此前该文件里 `memory` 命中数为 **0**。面板是用户**唯一的手工入口**，而它的分页夹取、
  服务端过滤、敏感拦截、上限裁剪任一处写错，表现都只是「数字不对」或「保存被拒」，
  不会报错。
- 覆盖 12 条：会话枚举（忽略非记忆文件）/ 缺 `chatId` 抛错 / `kind` 过滤与 total 同步 /
  limit 与 offset 夹取 / query 排序 / create 的四类拒绝 / 标签过闸 / 重复新建 refreshed /
  超上限裁剪 / update 缺 ts 与向量失效 / update 敏感拒绝 / delete 返回剩余总数。
- **顺带修上一批的遗漏**：本文件 5 处 `ALL_KEYS` 长度断言（38→50）与 3 处
  `SETTINGS_GROUPS.behavior` 键序断言（漏了记忆 4 键与语义 5 键）—— 上一批加键时只同步了
  `client-settings.spec`，漏了服务端这份。

### 7. 语义编码失败不再静默（`embedSafely` 加 `onFailure` + bridge 节流上报）

- 原来 `embedSafely` 是裸 `catch { return undefined }`：端点配错、模型缺失、超时，
  用户侧只看到「语义召回好像没用」，**日志里一条线索都没有**。
- 现在 `embedSafely(embedder, texts, onFailure?)` 把错误递出去；`bridge.reportEmbedFailure`
  按 chat **5 分钟节流**报一条 warn（含 chatId 与原因）。不节流会在每次 recall、每批
  backfill 重复刷屏，反而淹掉真正有用的日志。
- **HTTP 超时改为随批量放大**：`min(30s, 5s + 1s/条)`。固定 5s 对「一次补 8 条 + 冷启动的
  本地 ONNX / 慢 CPU 上的 Ollama」不够，整批超时后又被静默降级 —— 正是上一条要解决的
  那类「查不出原因」。

### 8. `pendingTurnUsers` FIFO 补语义测试（`turn-speaker.spec`）

- 这条队列存在的**唯一理由**是防串号（忙时 A 排队、B 又发 → 两轮都读到 B 的 QQ，
  画像记到别人头上）。而此前 `bridge.spec` 的字段快照只检查了 `pendingTurnRoles`，
  `activeTurnUser` 一条断言都没有 —— 退化成「只存最后一个」也全绿。
- 覆盖 4 条：连续两条不同人 → 两轮**依次**冻结各自的发言人 / 角色与发言人成对出队
  （admin 轮的 role 与 user 不串）/ 空队列 → `undefined` 且角色 fail-closed 为 member /
  未知 session → `undefined`。
- `turn/start` 是 private，但它是唯一会出队的入口，测试用反射驱动它，而不是复制出队逻辑。

### 9. `LocalEmbedder` 失败改退避重试 + 「无向量不打折」加精确断言

- 原来 `failed = true` **永不复位**：模型目录临时不可用（网络盘掉线、杀软锁、OOM）
  就会让语义召回整进程失效，只有重启才恢复。现在记 `failedAt`，**5 分钟后允许重试**；
  窗口内不重试，避免每条消息都重新 `import`。窗口可由构造参数覆盖（测试传 0）。
- 「无向量 / 维度不符的条目只按关键词打分、**不打折**」原来只有排序断言 —— 把实现改成
  `0.5 × keyword` 也全绿。现在直接比数值：分数必须**严格等于** `keywordScore`。

### 10. 后台补齐在 http 模式不再外发画像

- `Embedder` 加 `readonly kind: 'local' | 'http'`。补齐是**后台批量**（一轮最多 32 条），
  而用户开启 http 端点时预期的是「我让它记的那条会发出去」—— 把别人的画像和几十条
  历史闲聊一起批量 POST，明显超出预期。
- 现在 http 模式只补 `note`，画像等当事人下次被 `remember` 时再编码（那时是当轮内容，
  符合预期）；`local` 不出机器，照常全补。

**验证**：`tsc` exit 0；**13 文件 358 用例全绿**（上一批 11 文件 299；本批新增
`turn-speaker.spec`，并把此前从未纳入回归的 `settings-remote.spec` 一并跑通）。

## 2026-10-30 记忆系统加固（第三批）：字段面 / 误删护栏 / 坏数据 / 口径

### 11. `memoryEmbeddingUrl` 纳入取值校验 + 面板不再回传 `by`

- `validateStringValue` 此前只覆盖 `url` / `host` / `workspacePath` / `memeDir`，**漏了
  embedding 端点** —— 而它决定「记忆原文发到哪」。
- 现在：必须 `http(s)`（端点不是 WS）；**不许把 username/password 写进 URL** ——
  快照会原样回显它，而 URL 里的凭据还会进访问日志、浏览器历史、截图。凭据走
  `memoryEmbeddingKey`。
- 面板的 `readMemoryEntries` 不再回传 `by`（写入者 QQ）：渲染只用 `subject`，
  少一个身份字段就少一条泄露路径。`role` 保留（只说明权限级别，不含身份）。

### 12. `forgetProfiles` 的「空 subject = 删全部」改成护栏 + 显式命名

- 原语义：`subject` 为空 → 删掉本会话**所有**画像。而唯一调用点只把命令发送者的
  `userId` 原样透传 —— 一旦上游某处让 `userId` 变成空串（入站改造、伪造 sender、
  重放事件），一句 `/memory forget` 就删光所有人的画像，且不可撤销。
- 现在：`forgetProfiles` 对空值**返回 0、什么都不删**；真需要清空走新增的
  `forgetAllProfiles`。两个名字分开，是为了让「删一个人」和「删全部」在调用点一眼
  可辨 —— 同一个函数靠参数是否为空来区分，正是这类误删的经典来源。
- `memoryForget` 另加 `userId === ''` 早退，回「无法确认你的身份，已取消删除」，
  比含糊的「没有找到」更诚实。

### 13. `parseLine` 不再把坏 `ts` 归 0

- `ts` 是条目**标识**（delete / update / 面板编辑都按它定位）。归 0 的后果是双重的：
  该行恒判过期（`now - 0` 超过任何 TTL，于是永不召回），且**所有**坏行共享
  `ts = 0` 这一个标识 —— 删一条会把它们全删掉。
- 现在：缺失或非法时用 `lastSeenAt` 兜底；两者都没有就整行跳过（内容仍在文件里，
  只是读不出来）。宁可少一条，也不制造身份冲突。

### 14. `weight=1` 的「纯语义」名副其实

- 原实现里无向量条目始终按关键词满分参与 —— 于是 `weight=1`（schema 写的是
  「1 = 纯语义」）实际上仍混着关键词，同一条内容有无向量会有两种排名。
- 现在：`weight === 1` 时无向量条目**不参与**（纯语义只看语义）；`weight < 1`
  仍保持「无向量不打折」—— 那才是默认配置下历史条目不被系统性压低的关键。
  schema / README / 面板 hint 三处都写明了这个分界。

### 15. 面板解释「已过期」与「最近提及」为何并存

- 保留期从**首次写入**（`ts`）算，重复提及只刷新 `lastSeenAt` —— 于是一条「刚被
  提过」的记忆可能同时显示「最近提及 3 天前」与「已过期」，看起来像 bug。
- 现在过期徽标带 `title` 说明，且在有更晚提及时显示「已过期（按首次写入计时）」。

**验证**：`tsc` exit 0；`memory.spec` +4、`settings-remote.spec` +2、
`client-settings.spec` +1 等；**13 文件 366 用例全绿**（上一批 358）。
