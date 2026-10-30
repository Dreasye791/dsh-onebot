# dsh-onebot

> **[English](README.en.md) | 中文**

给 DeepSeek Harness 加上 QQ 通道。A QQ channel for dsh.

本插件把 dsh 变成一个 QQ 机器人（**OneBot 11 协议**，兼容 NapCat / Lagrange / LLOneBot / go-cqhttp），
与 [dsh-vision](https://github.com/dsh-external/dsh-vision) 同款的外部插件形态：**零 Python、纯 TS、
原生 Cordis 插件**，挂载进 dsh 宿主进程，不改任何核心代码。

```
用户(QQ) ←→ NapCat ←→ dsh-onebot 插件 ←→ dsh Agent（每个会话一个）
                        ├─ 反向 WS 服务器 / 正向 WS 客户端（自动重连）
                        ├─ 入站：CQ 解析、图片下载、语音转写(STT)、引用/合并转发展开
                        └─ 出站：单条/t2i 卡片发送、Markdown 剥离、[[qq_forward]]、图片/语音/视频/文件工具
```

## 架构

![dsh-onebot QQ 通道架构](docs/dsh-onebot-architecture.png)

> 可交互版本（暗/亮主题切换 + 引导视图）：[docs/dsh-onebot-architecture.html](docs/dsh-onebot-architecture.html)；矢量版：[docs/dsh-onebot-architecture.svg](docs/dsh-onebot-architecture.svg)。

## 功能

| 类别 | 能力 |
|---|---|
| 连接 | 反向 WS（NapCat ws-reverse 拨入，默认端口 8643）或正向 WS（拨出，默认 ws://127.0.0.1:3001）；断线自动重连（2s→60s 退避） |
| 入站 | 私聊/群聊、段数组优先解析（CQ 字符串回退）、CQ 反转义、@/回复触发检测（fail-closed；回复仅认机器人自己的消息）、图片四路解析（url/base64/file/hash）、**图片投递给模型**（T15：落盘后交给宿主附件库，作为 `image` 块进入消息 content，模型能真正「看见」图；未投递时退回 `[图片:<路径>]` 文本，详见「图片与容量管理」）、大图自动压缩（长边 ≤`inboundImageMaxPx`，GIF 不压）、文件段双通道接收（CDN 直链 get_private_file_url + get_file base64/url 回退）、表情 id→中文名标签（`[表情:睁眼]`；id 表由 NapCat 的 qface 资产生成，表中没有的 id 输出 `[表情:id=数字]`）/卡片/戳一戳段类型、引用消息自动取原文（get_msg）、合并转发自动展开（get_forward_msg） |
| 语音 | ffmpeg 转 16kHz WAV + whisper 转写（openai-whisper / whisper.cpp / 自定义命令）；**非阻塞**：语音消息先以 [语音] 占位进入回合（不阻塞回复），转写完成后以「（语音转写：…）」补递（默认超时 60s）；转写失败/超时保留 [语音] 占位 |
| 文字图 | t2i 卡片渲染器（@napi-rs/canvas）：标题/粗斜体/删除线/引用/列表/代码块/表格/行内 code 胶囊/彩色 emoji/中文标点禁则；与 Hermes 原版同款数值（800px/26px/禁则集合/右缘 790） |
| 出站 | 正文 ≤ `textImageThreshold`（默认 150）字符单条发送、**超过阈值渲染 t2i 文字图卡片**（AstrBot 风格：标题/引用/列表/表格/代码块/彩色 emoji；渲染失败、PNG 超 `outboundImageMaxBytes` 或 `<=0` 禁用卡片时回退单条纯文本）、Markdown 剥离为 QQ 纯文本、[[qq_forward]] 合并转发（群/私聊）、**实时中间消息**（interimMessages：每条中间文本立即发出、实时可见；各自在 `interimRecallMs`（默认 90s）后自动单独撤回；回合结束时先把整轮中间消息渲染成一张 **t2i 小结卡**、立即撤回仍在屏幕上的原文、再发送最终回复——不用回合末合并转发，避免长回合「原文超 2 分钟撤不回+转发卡重复」；`interimRecall: false` 时降级为只发不撤（无小结卡、不撤回））、**宿主「计划书/提问卡」自动中继**（模型调用 exit_plan_mode / ask_user_question 时把计划全文/问题选项发到 QQ）、正在输入提示（set_input_status，仅私聊） |
| 命令 | 斜杠命令（仅管理员）：`/new` 开新会话、`/stop` 停止生成、`/steer <补充内容>` 向运行中的任务补充指令（无运行任务时回用法提示；详见下方命令表与 `newMessagePolicy` 配置）、`/model` 查看或切换当前会话模型（`--default` 修改部署默认；无参输出两级序号列表，回复序号选 provider → 再回复序号选模型）、`/workspace` 查看或切换工作区（无参编号列表，回复序号即选）、`/preset` 查看或切换 agent 预设（无参编号列表，回复序号即选）、`/session` 查看可切回历史会话并按序号切回（`/new`、`/workspace`、`/preset` 切换下来的旧会话进列表，可来回切，历史上下文恢复）、`/status` 会话全景、`/storage` 存储占用（媒体目录 / 附件库 / 本插件贡献 / 软上限）、`/doctor [export [参考号]]`（别名 `/healthcheck`）运行体检（export [参考号] 导出脱敏诊断包 qq-diagnostics-*.zip，文件名含触发参考号）、`/retry` 重跑上一条、`/id` 会话标识、`/ver` 版本、`/ocr` 识别最近图片、`/mode` 切换出站模式（跨重启持久化）、`/plan` 计划模式、`/permission` 切换宿主权限预设（QQ 别名 `w`=工作区可写+需审批、`f`=全权+免审批；完整预设名照传，未知名由宿主报错并回显可用列表；无参查看当前与可用列表，序号按 available 顺序）、`/goal` 目标记录（跨重启持久化）、`/help` 帮助；未知斜杠命令默认拦截并提示相近命令（`unknownCommand: passthrough` 改为透传给模型） |
| 工具 | `qq_send_image`（≤9 张，路径或 URL）、`qq_send_voice`、`qq_send_video`、`qq_send_file`、`qq_send_forward`、`qq_send_meme`（配 `memeDir` 后出现，按情绪/关键词抽预置表情包）、`qq_napcat_api`（15 个白名单 action，仅管理员可调用上传/写群类；`file` 只收 file_id 或 `base64://`）、`qq_group_history`、`qq_memory_remember` / `qq_memory_recall` / `qq_memory_forget`（配 `memoryEnabled` 后出现；按 chat 分区、关键词检索；`remember` 支持会话公共记忆 `note` 与成员画像 `profile`，note 所有成员可写、画像默认只在私聊、敏感信息会被拒绝；`forget` 按 `ts` 或关键词删条目，**不接受空条件**，成员只能删自己写的或关于自己的画像）（文件编辑工具 `code_safe_edit` 等已拆至独立插件 dsh-safe-edit，见下文「安全编辑」） |
| 权限 | 管理员白名单（`ONEBOT_ALLOWED_USERS`）、dm/group 策略（open/allowlist/disabled）、群聊 @提及 gating、受限用户 [受限用户:仅问答] 软限制、出站敏感内容审计 |
| 会话 | 每个 QQ 会话一个持久 Agent（session id 稳定派生），重启后自动 resume；按 `agentPreset`/`workspacePath` 挂载到 preset 与工作区；每轮结束 flush 落盘 |
| 运维 | 热加载：profile 层 patch 的 **config 覆盖**与 **insert 新增/删除**均热生效——插件 fiber 秒级原地重启（宿主进程不重启；代价：QQ 桥一次秒级重连、在途回合中断）；touch/内容未变不触发任何动作；bundle 自带 patch、仓库模板、部署副本的 patch 文件与根配置 `cordis.yml` 的改动**不**热生效；临时媒体 TTL 过期清理 |
| 提示词 | 自动注入 QQ 平台说明（纯文本输出、图片/语音/表情标注 `[图片]`/`[语音]`/`[表情:名称]` 占位、工具与命令指引、禁宿主交互卡）；按**每个 QQ 会话 agent 自身作用域**注入，Web 会话不可见 |

## 兼容性

| 项 | 要求 |
|---|---|
| dsh | ≥ 0.1.5-rc.1（`engines.dsh`：0.1.5/0.1.6/0.1.7 全线 + 0.2.0 线 ≥0.2.0-rc.1；@deepseek-ai/* peer 依赖同范围，JsonValue 由 dsh-util-values 提供） |
| Node.js | ≥ 22 |
| OneBot 11 实现 | NapCat / Lagrange / LLOneBot / go-cqhttp（reverse 或 forward WebSocket） |
| 可选依赖 | 语音转写需 ffmpeg + whisper CLI；t2i 文字图在 Linux 需 Noto CJK 字体 |

最后验证：2026-10-24（安全加固批次：`qq_napcat_api` 参数白名单、member 回合工具闸门、入站 `file://` 扩展名白名单 + 大小上限、会话映射原子写与串行落盘、设置页 descriptor 补齐——`npx tsc --noEmit` 零错误；vitest 40 个 spec / 588 用例，Linux 预期全绿，Windows 存在平台相关跳过与 19 条已知失败（t2i 字体与 8.3 短路径）。M0 安全语义保持：reverse 空 token 拒绝启动、默认仅监听 127.0.0.1 为 BREAKING 变更，见下方配置表说明）。

### 从 0.9.4 升级到本版本的行为变化

以下几条会**改变现有部署的行为**，升级前请先核对：

| 变化 | 说明 |
|---|---|
| MCP 工具默认全禁（T20） | 新增 `mcpToolAllow`，**默认 `[]`**。此前 QQ 通道与 Web GUI 继承同一套工具，群友可以直接调用 profile 里挂载的全部 MCP 服务器（含数据库工具）。升级后不配置这一项，机器人将**一个 MCP 工具都用不了**；想沿用旧行为就填 `*`（不推荐，等于把数据库权限交给群友）。 |
| 工具名含 `__` 的 MCP 通配收窄（T20） | `mcp__<服务器>__*` 只覆盖**单段**工具名。服务器名自身含 `__`（如 `dbx__prod`）或工具名含 `__` 时，必须写 `mcp__dbx__prod__*` 或完整工具名。旧配置里若有这类泛化条目，升级后**会静默少放行一批工具**（条数见启动日志的 warn）。 |
| 宿主必须提供 `tools.guard` | 缺失时插件**直接停止启动**（而不是跳过闸门继续跑）。宿主 ≥ 0.1.5-rc.1 的 `@deepseek-ai/dsh-tools` 均有该 API，但极老版本需先升级宿主。 |
| 入站图片改为真图片块（T15） | 此前只给模型一段 `[图片:路径]` 文本，模型看不到图。现在按 `attachInboundImages`（默认 `true`）投递为真正的图片块；不想要这个行为（省 token / 换非视觉模型）请设成 `false`。 |

## 安装

**前置**：dsh（≥0.1.5-rc.1）在 PATH 上；NapCat 或其他 OneBot 11 实现已运行。

> ⚠️ **NapCat 用户必读**：NapCat 的注入方式要求 **QQ 在注入前未运行**。若 QQ 已经开着（例如开了开机自启），注入器无法接管它，插件会判为 `QQ 已占用` 并停止尝试。请先**完全退出 QQ**（托盘退出），再由 `launcher-user.bat` 拉起，届时它自己会启动被注入的 QQ。免扫码、开机自启与排障见 [docs/napcat-launcher.md](docs/napcat-launcher.md)。

### npm 安装（发布通道，与下方源码安装二选一，勿混装）

```sh
dsh plugin --profile web add dsh-onebot-qq
```

（或用 Web 界面的 Plugins 页安装。）随后：

1. 在 profile 目录 `<DSH_HOME>/profiles/web/` 的 `pnpm-workspace.yaml` 中写入两行
   （实测 pnpm 12 不读项目级 `.npmrc`，见 `docs/npm-e2e-report.md` D1）：

   ```yaml
   autoInstallPeers: false
   hoist: false
   ```

   ——防止 pnpm 自动拉入 registry 上陈旧的 `@deepseek-ai/*` 独立副本。npm/pnpm 版本差异：
   此配置仅 pnpm 12 用户必须（pnpm 12 已不读 `.npmrc`）；npm 用户无此问题——实测 npm 默认
   peer 自动安装拉入的 registry 现版本满足 peer 范围（`docs/npm-e2e-report.md` §1 #2）。
   运行期 peer 统一由宿主解析层完成：插件 import 的 `@deepseek-ai/*`
   只要声明在该包 peerDependencies 里，就会被宿主拦截并重定向到宿主安装树的同一实例，
   无需任何 npm override。
2. 把包内 `cordis.patch.yml` 模板的两行 insert 合并进 profile 层
   `<DSH_HOME>/profiles/web/cordis.patch.yml`：主条目 `name: 'dsh-onebot-qq'`，
   host-plane 行 `name: 'dsh-onebot-qq/settings-remote'`；config 覆盖须挂
   patch 顶层同 id 行（详见模板头注释）。
3. **不要**在 profile 的 package.json 手写任何 `@deepseek-ai/*` 依赖——手写副本会
   覆盖宿主安装树成为拦截目标，造成版本错位双包。
4. 若安装被兼容门拒绝（dsh 版本不在 peer 范围内），按官方口径用
   `dsh plugin allow-version ... --accept-risk` 显式豁免。

### 方式二：git clone 源码安装

```sh
git clone <repo> ~/dsh-plugins/dsh-onebot
cd ~/dsh-plugins/dsh-onebot
npm install --include=dev
./scripts/build.sh          # 链接宿主 @deepseek-ai 包 + tsc 编译 src/ → lib/
```

> **部署副本必须带完整 node_modules 链接集**（`scripts/link-host.sh` 产物）：`files` 只打包 `lib/`，
> 但运行时 peer 依赖 `@deepseek-ai/*` 是链接到宿主安装的——只复制 `lib/` 会挂载失败（插件入口会
> 显式报「peer 依赖解析失败」错误）。宿主无 `dsh` 在 PATH 上（如 fnOS 应用形态）时用逃生门：
> `DSH_ROOT=<宿主node_modules路径> ./scripts/build.sh`。

**fnOS 应用形态宿主构建**：fnOS 应用中心安装的 dsh 没有 `dsh` CLI 在 PATH 上，`build.sh` 的自动定位
（PATH 二进制 → npx store）会失败并显式报 `cannot locate the dsh install`。此时用 `DSH_ROOT` 显式指定
宿主 node_modules 根（该目录下须有 `@deepseek-ai/`，否则报错退出而非静默回退）：

```sh
DSH_ROOT=<fnOS 应用数据目录>/node_modules ./scripts/build.sh
```

构建完成后把部署副本（`lib/` + 完整 node_modules 链接集）放到目标位置再挂载；运行副本缺链接集同样会挂载失败（见上方说明）。

挂载到 ~/.dsh/config.yaml（没有就新建）：

```yaml
- insert:
    - id: dsh-onebot
      name: '$HOME/dsh-plugins/dsh-onebot/lib/index.js'
      config:
        mode: reverse        # reverse = NapCat 拨入；forward = 插件拨出
        port: 8643
        # accessToken: '与NapCat一致的token'   # 必配：reverse 模式留空将拒绝启动（M0 安全加固）
        # botQQ: ''          # 留空自动从 meta 事件学习
        adminUsers: ['你的QQ号']   # 必配：至少一个管理员，否则私聊/斜杠命令不可用
```

> ⚠️ **首次配置必须设置至少一个管理员**（`adminUsers` 或环境变量 `ONEBOT_ALLOWED_USERS`）：
> `dmPolicy: open`（默认）只允许管理员私聊，斜杠命令也仅管理员可用；不设置则无人能对话。
> 开发调试可临时 `allowAllUsers: true`（或 `ONEBOT_ALLOW_ALL_USERS=true`）放行所有用户。

重启 dsh（`dsh web` 或你的启动方式），日志出现 `[dsh-onebot] mounted` 即挂载成功。

**NapCat 侧（必须配置，两种模式二选一）**：

- **reverse 模式（NapCat 拨入 dsh，推荐）**：NapCat 网络设置里新增「**WebSocket 客户端**」，
  「上报地址」填 dsh 的 WS 地址 `ws://<dsh 所在机器 IP>:<port>/ws`（如 `ws://192.168.1.100:8643/ws`），
  「token」填插件 `accessToken` 相同的值；dsh 与 NapCat 不同机时不能用 `127.0.0.1`。
- **forward 模式（dsh 拨出到 NapCat）**：NapCat 网络设置里启用「**WebSocket 服务端**」（默认监听
  `0.0.0.0:3001`），插件 `url` 配置为 `ws://<NapCat 所在机器 IP>:3001`（同机可用
  `ws://127.0.0.1:3001`），token 两边一致。

两侧 token 必须一致；消息上报格式建议选「**数组**」（插件段数组优先解析，CQ 字符串仅回退）。
配置完成后重启 dsh，日志出现 `[dsh-onebot] mounted` 且 NapCat 显示连接成功即就绪。

**部署位置要求**：NapCat 必须部署在 dsh **可达的局域网**内（同一网段/能互通），
WS 连接、图片下载、文件解析都依赖这条网络通路；NapCat 与 dsh 不在同一台机器时，
需要在 NapCat 侧**开启「文件转 URL」开关**，`get_file` 才会返回可下载的 http(s) url
（否则返回容器内路径，本插件无法访问）。

## 配置

完整配置项见 [src/index.ts](src/index.ts) 的 `Config` schema（schemastery 校验，均有默认值）。常用：

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `reverse` | `reverse`/`forward` |
| `host` / `port` | `127.0.0.1` / `8643` | reverse 监听；跨机部署（NapCat 从其他机器拨入）需显式改为 `0.0.0.0` |
| `url` | `ws://127.0.0.1:3001` | forward 目标 |
| `reconnectMaxAttempts` | `100` | 自动重连放弃上限：连续失败达到该次数后停止重连，日志输出上限值与恢复指引；`0` = 无限重连（退避封顶 60s） |
| `accessToken` | 空 | OneBot token；**reverse 模式必填**，留空插件拒绝启动（fail-closed），启动期会先给一条点名 token 的中文处置提示（不再只报「peer 依赖解析失败」）；forward 可为空。它同时是 NapCat 侧 `onebot11_<QQ号>.json` 的 `websocketClients[].token`，两侧必须一致 |
| `botQQ` | 空 | 机器人 QQ（空=自动学习） |
| `ignoreSelf` | `true` | 忽略机器人自己发出的消息（防自循环） |
| `requireMention` | `true` | 群聊需 @ 或回复机器人的消息才响应（回复他人消息不触发）。回复判定走一次 `get_msg` 取被回复消息的作者 QQ 来比对（OneBot 的 reply 段只带 message_id、不带 qq）；被回复消息已撤回/查不到/机器人 QQ 未知时一律视为**未提及**（fail-closed，宁可不答也不误答）。`botQQ` 为空时会被动从 meta 事件学习 |
| `rateLimitPerMinute` | `30` | 每会话每分钟普通消息上限（60s 滑动窗口）：超限跳过处理并限流提示（每窗口至多一条），命令不受限；`0` = 禁用 |
| `dedupWindowSeconds` | `300` | 入站消息去重窗口（秒，W2-②）：同一会话内相同 message_id 在该窗口内重投（断线重连重放等）只处理第一条，后续静默跳过并记 debug；仅对会触发回复处理的消息事件生效（notice/meta 类不经过此闸）；`0` = 禁用去重 |
| `actionRatePerMinute` | `20` | 主动写操作每分钟全桥合计上限（W2-③）：约束 qq_send_image/voice/video/file/segments 与 qq_send_forward 等工具发起的主动发送（回合内的被动回复/interim/通知不受此闸，由 rateLimitPerMinute 与离线队列上限约束）；超限拒发并记 warn 与审计；`0` = 禁用分钟限额 |
| `actionRatePerDay` | `500` | 主动写操作每日（本地自然日）全桥合计上限（W2-③）：口径同 `actionRatePerMinute`；超限拒发并记 warn 与审计，次日自动恢复；`0` = 禁用日限额 |
| `actionAuditEnabled` | `true` | 主动写审计（W2-③）：每次主动写（成功/失败）与拒发事件追加写一行 JSON 到 `mediaDir/qq-actions.log`（含 ts/chatId/action/ok/reason）；写失败仅 warn 不影响发送 |
| `traceEnabled` | `false` | 链路追踪（W1）：为每条入站消息生成 traceId 并贯穿入站→模型回合→出站，决策事件（含限流/去重/白名单/@ 门控/闸门拒发与每个静默丢弃分支的中文 reason）逐行 JSON 落盘 `mediaDir/qq-trace.jsonl`（4MiB 改名轮转，保留 `qq-trace.1/2.jsonl`；同一原因 5 分钟限频；异步队列写不阻塞管线）；默认关闭——关闭时不生成 traceId、不落盘、决策行为与 0.6.0 完全一致 |
| `traceLevel` | `debug` | 追踪事件级别（W1）：`debug` 记录全部决策事件；`warn` 仅记录 ok:false（被拒/失败/丢弃）事件 |
| `logLevel` | `info` | 控制台日志级别门槛（debug < info < warn < error）：低于该级别的日志不输出。`debug` 全部输出（含「session 事件早退」等调试行）；`info` 常规信息（启动、连接建立、meta 事件等，默认）；`warn` 仅警告与错误；`error` 仅错误 |
| `recordInbound` | `false` | 入站录制（W1）：把收到的每条入站事件（含被门控跳过的，附当时决策 reason）按可回放形状逐行 JSON 追加写 `mediaDir/qq-inbox.jsonl`（2MiB 改名轮转，保留 `qq-inbox.1/2.jsonl`；注入的帧不会被二次录制，杜绝「注入→录制→回放→注入」自激）；纯旁路：写失败仅 warn 限频，绝不影响回复管线 |
| `inboxRedact` | `true` | 录制脱敏（W1）：落盘前把帧中 6 位以上的数字串（QQ 号/群号等）脱敏为前 3 位+`****`（数字型 id 字段一并处理），并剥离媒体 URL 中 token/sign 类查询参数；默认开启（录制文件长期留在 `mediaDir`，还可能被打进诊断包），需要完整原文排障时显式关闭后配 `npm run replay` 使用 |
| `injectEnabled` | `false` | 事件注入通道（W1，**仅调试用**）：开启后按 `injectIntervalMs` 轮询 `mediaDir/qq-inject.jsonl`，把新行（每行一个 OneBot 消息事件 JSON）喂进**真实入站管线**（trace 事件标 `stage=inject`）；启动时已存在的历史行跳过并记一条说明。信任边界：注入是调试通道，默认全关，勿在生产开启 |
| `injectDryRun` | `true` | 注入干跑（W1，**强烈建议保持 `true`**）：注入回合触发的全部出站写操作（发消息/撤回等，**含异步模型回合的最终回复**——拦截点在出站动作层）被拦截计数、原文进 trace 事件、绝不真发 QQ；真实消息到达同一会话立即解除拦截（不连坐真人）；`false` = 注入内容会真实发送，仅限隔离环境实验 |
| `injectIntervalMs` | `2000` | 注入队列轮询间隔（毫秒，W1；最小 500） |
| `unknownCommand` | `intercept` | 未知斜杠命令处置：`intercept`（默认）拦截并提示相近命令（前缀匹配优先，编辑距离 ≤2 兜底且仅输入长度 ≥4 时启用，至多 3 个候选；无候选提示发 `/help` 或去掉开头 `/` 重发）；`passthrough` 维持旧行为透传给模型。非 `/纯单词` 开头的文本（如路径 `/tmp/x`）不受影响 |
| `newMessagePolicy` | `queue` | 任务运行中收到新普通消息的处理策略（P1）：`queue`（默认）=排队——消息在当前任务结束后按序处理为后续回合，等待期间每运行回合至多回复一次排队提示；`steer`=插话——运行中收到的新普通纯文字消息作为补充指令加入当前任务（模型在下一步读取）并回复提交提示。例外：图片/文件/语音/带引用或合并转发消息与 `[受限用户:仅问答]` 群成员消息两种模式下都按排队处理（软限制不放宽、媒体管线不被绕过）；自动插话资格由 `autoSteerPolicy` 控制；`/steer` 命令两种模式下均可用；无运行中任务时行为与该配置无关（与 0.8.1 一致）。设置页 behavior 组可改，热重启生效 |
| `autoSteerPolicy` | `admin` | steer 模式下自动插话的发送者资格（T9，用户裁决 2026-10-12）：`admin`（默认）=仅管理员可自动插话；`all`=所有非受限发送者均可。不具备资格的消息按排队处理（入队+排队提示）；`/steer` 命令始终仅管理员、不受本项影响；`queue` 模式行为完全不变。设置页 behavior 组可改，热重启生效 |
| `deferredTimeoutMs` | `600000` | 等待模型回复超时阈值（毫秒，T3/P2 超时补发）：回合超过该时长没有任何模型输出时，向聊天回复一条超时提醒并把回合登记进补发注册表（继续运行、不放弃）；回合完成后向原聊天补发最终文字（带「（超时补发）」前缀，走既有出站分段/t2i 规则），只补最终文字与终态通知——不重放审批/提问卡/文件工具调用/图片；发送明确失败最多尝试 3 次（退避 2s/10s），发送结果不确定（动作超时/非网关错误，消息可能已到达）时保留记录并停止自动重试防重复；注册表逐行 JSONL 落盘 `mediaDir/deferred-delivery.jsonl`（原子写、逐行损坏降级、缺失=全新），插件重启后自动恢复未完结条目的跟踪；`/stop` 只终止当前聊天提交的回合并显式终止该聊天的补发跟踪（其他聊天不受影响）；正常完成（未超时）零注册表写入、零补发。设置页 behavior 组可改，热重启生效；`0`=关闭 |
| `reasoningEffort` | `''` | QQ 通道思考强度覆盖（T10）：留空（默认）=继承宿主 `agent-default-model` 的 `reasoningEffort`，即 0.9.4 及以前的行为；填 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` 则本通道创建或恢复的每个会话都使用该值，**只影响 QQ 通道，Web / GUI 会话不受影响**。取值必须是 pi-ai 的档位名——关闭思考写作 `off`（**不是 `none`**：`none` 只是上游 `codebuddy-cli` 在 `canDisableThinking` 模型上的 wire 拼写，宿主层不存在名为 `none` 的档位，填它会被 `resolveReasoningLevel` 抛 `UNSUPPORTED_REASONING_EFFORT`）。`off` 也仅当模型报告可禁用思考时可用，否则同样报错，此时请退到 `low`。宿主的全局默认通常是 `high`，QQ 侧常因等待思考而显得慢，降到 `low` 通常明显更快且质量损失很小。**设置页的下拉框会按当前默认模型实际支持的档位动态收窄**（T17：读宿主 `llm.resolveModelInfo` 的 `reasoning.efforts`），所以换 provider 后选项会跟着变；拿不到该信息时（旧宿主、非推理模型、上游报错）回退为静态八选一（`''` + 宿主七档），绝不因查询失败而少给选项。若已保存的档位当前模型不支持，该值仍会保留并标注「（当前模型不支持）」，不会静默改成别的值。保存后由插件级热重启生效。 |
| `persona` | `''` | QQ 通道角色设定（T11）：纯文本注入本通道 system prompt **最前段**，用来定语气与说话方式（你是谁、怎么说话、有什么偏好）。留空（默认）=不注入人设层，行为与 0.9.4 完全一致；非空时在平台规则之前加一段「## 角色设定」，并声明与下方规则冲突时以规则为准（人设只调语气，不解除任何安全/平台约束）。**只影响 QQ 通道，Web / GUI 会话不受影响**。上限 20000 字符，首尾空白自动 trim。设置页 behavior 组（多行文本框，14 行）可改，保存后对新回合生效。 |
| `memoryEnabled` | `false` | 频道记忆总开关：开启后模型可用 `qq_memory_remember`（写一条记忆，支持会话公共 `note` 与成员画像 `profile`）、`qq_memory_recall`（检索本会话记忆）与 `qq_memory_forget`（删掉过时条目）。记忆按 chat 分区存到 `mediaDir/memory/<chat>.jsonl`，跨群/跨私聊不共享、重启不丢。**默认是关键词检索**（中文 2-gram + 英文按词）；开启 `memoryEmbeddingMode` 后变成「关键词 + 语义」混合，才可能回答「上次那个方案」这种换个说法的提问。不会自动改写每轮 prompt；启用后平台提示词会**额外注入记忆使用指引**（被问「之前说过什么」时先 `recall`；**出现长期有效的信息时主动记下，不等用户说「记住」**，一轮最多一条；发现新旧矛盾用 `forget` 删旧留新），未启用则完全不出现，避免模型去调不存在的工具。权限：`recall` 只返回本会话 note + 自己的画像；`remember` 所有成员可写 note，写**别人**的画像需管理员；`forget` 只能删自己写的或关于自己的画像 |
| `memoryMaxEntriesPerChat` | `200` | 单个会话保留的记忆条数上限（1–5000）：每次写入后裁剪，超出按时间丢弃最旧；每个 chat 独立计算。设置页 behavior 组可改 |
| `memoryRecallTopK` | `5` | `qq_memory_recall` 的默认返回条数（1–20），调用时可用 `limit` 覆盖。设置页 behavior 组可改 |
| `memoryProfileScope` | `dm` | 成员画像（`kind: profile`）能在哪写：`dm`（默认，只有私聊）/ `all`（群聊也允许）/ `off`（关闭画像）。**主体自动取「本轮发言者」**：私聊是对话对方，群聊读本轮消息里的 `<user_message qq="…">`；非管理员只能写自己（显式填别人会被拒），管理员不限。群聊默认关只是产品取舍（群里给某人建画像容易被当成议论别人），不是技术限制。设置页 behavior 组可改 |
| 保留时长（按 `tags`） | — | 不单独配置：`待办` 14 天、`偏好` 不过期、`事实` 365 天、无标签 90 天。**绝对过期**（从写入时刻起算，被 recall 多少次都不续期）；过期只是不再被检索，文件里的原文保留（软过期），可用 `/memory forget` 真删 |
| `memoryEmbeddingMode` | `off` | 语义召回：`off`（默认，纯关键词）/ `local`（进程内 ONNX）/ `http`（外部端点）。开启后 `recall` 按「语义相似 × 权重 + 关键词 × (1−权重)」混合打分，能回答「上次那个方案」这类模糊描述。**任何编码失败都自动退回纯关键词**，不影响记忆写入；没有向量或维度不符的条目只按关键词打分（不会被压低） |
| `memoryEmbeddingModel` | `''` | `local`：模型目录（相对名会拼到 `<mediaDir>/models/` 下，也可填绝对路径）；`http`：模型名（如 `bge-m3` / `nomic-embed-text`）。`local` 依赖可选的 `@xenova/transformers`（未安装则自动退回关键词）。放好模型后跑 `node scripts/check-embedding-model.mjs` 校验 `config.json` / `tokenizer.json` / `*.onnx` 是否齐全 |
| `memoryEmbeddingUrl` | `''` | `http` 端点：**以 `/v1` 结尾走 OpenAI 协议**（`POST {url}/embeddings` + Bearer），否则走 Ollama 协议（`POST {url}/api/embed`）。⚠️ 该模式会把记忆原文发送到该端点 |
| `memoryEmbeddingKey` | `''` | `http` + OpenAI 协议的 Bearer。**快照脱敏不回显**（与访问令牌同款处理），留空 = 不修改 |
| `memorySemanticWeight` | `0.6` | 混合召回的语义权重（0–1）：0 = 纯关键词，1 = 纯语义。设置页 behavior 组可改 |
| `memeDir` | `''` | 表情包目录（T12）：按 `<目录>/<情绪标签>/<图片>` 组织的图库，与 dsh-meme 图库同构，可直接把它的 pack 目录拷进来。配置后本通道 agent 多一个 `qq_send_meme` 工具——按情绪标签随机抽一张，或按关键词（文件名/标签子串，空格分隔多词、整词不中自动拆词）搜一张发到 QQ。留空（默认）=不注册该工具，模型看不到它。**只影响 QQ 通道**。目录必须位于 `mediaDir` 之内**且不能等于 `mediaDir`**（后者会让工具把 `mediaDir` 根下别的会话的入站临时图当表情发出去）；两个条件都在**注册阶段**用 `realpath` 校验并判定，不满足则工具直接不注册（不会出现「看到工具但发不出」）。可在设置面板「连接」组配置，也可在 patch config 手改。 |
| `dmPolicy` | `open` | 私聊策略：`open`(仅管理员)/`allowlist`(白名单)/`disabled` |
| `groupPolicy` | `open` | 群聊策略：`open`(所有人)/`allowlist`/`disabled` |
| `restrictedMemberPrefix` | `true` | 群聊非管理员消息注入 `[受限用户:仅问答]` 前缀（软限制） |
| `adminUsers` | `[]` | 管理员 QQ；也可用 `ONEBOT_ALLOWED_USERS` 环境变量。**必须至少设置一个**，否则私聊（dmPolicy=open）与斜杠命令无人可用。为空且未开 `allowAllUsers` 时，插件会在启动期 warn 一次并说明后果 |
| `allowFrom` / `groupAllowFrom` | `[]` | 白名单用户/群 |
| `mcpToolAllow` | `[]` | QQ 通道 MCP 工具白名单（T20）：**留空（默认）= 禁用全部 MCP 工具**（刻意的 fail-closed 默认。MCP 服务器挂在 profile 根作用域上，QQ 通道与 Web GUI 继承同一套工具，等于把这些能力直接交给群友）。非空时按任一写法匹配、命中才放行：`mcp__akasha__akasha_search`（完整工具名，最精确）、`mcp__akasha__*`（该服务器全部工具）、`akasha`（服务器名简写）、`akasha_search`（任意服务器下同名工具）、`*`（全部 MCP 工具，慎用）。**通配只有 `*` 与 `mcp__<服务器>__*` 两种**，其它含 `*` 的写法（如 `akasha*`）会被忽略并记一条 warn，避免无意放大授权范围；服务器名与工具名一律整段全等比较，不做前缀/子串匹配。**`mcp__<服务器>__*` 只覆盖单段工具名**：服务器名自身含 `__`（如 `dbx__prod`）时，`mcp__dbx__*` 不会连带放行它的工具（否则一个泛化条目就能越权到别的服务器），必须写成 `mcp__dbx__prod__*` 或完整工具名。单项 ≤128 字符、最多 256 条（设置页与 schema 均限；读侧刻意放宽到 4096 字符，这样手改配置写了超长值只会让该项不生效，不会让整份设置解码失败、面板全空）。拒绝时只回「不在白名单内」，不回显白名单内容（避免模型把它转述到群里）。`qq_*` 工具与宿主内置工具（`read`/`bash` 等）**不受本项影响**。**只影响 QQ 通道，Web / GUI 会话不受影响**。设置页「权限」组可改，保存后由插件级热重启生效。**第三方插件注册的原生工具不受本项管控，但在 QQ 通道上一律拒绝**：如 `dsh-mnemon` 的 `mnemon_recall` / `mnemon_remember` / `mnemon_document_search` 等（`NATIVE_TOOL_DENY_PREFIXES = ['mnemon_']`）。这类工具连的是宿主**全局**数据（工作区记忆库、文档库，不按 chat 隔离），与 QQ 会话无关 —— 不拦的话，群里一句「查一下我之前的记录」就能翻出你的工作记忆。 |
| `interimMessages` | `true` | 工具调用之间的中间文本是否立即发送；`false` 只发最终回复 |
| `interimRecallMs` | `90000` | 每条中间消息发送完成后多久自动单独撤回（毫秒；QQ 撤回时限约 2 分钟，建议 ≤110000；运行期下限 3000，避免配错成「发完即撤」） |
| `interimRecall` | `true` | 中间消息撤回与回合末小结卡开关；`false` = 只发不撤（降级：无小结卡、不撤回，中间消息留在屏幕上） |
| `sendErrorNotice` | `true` | 一轮运行出错时向用户发送 ⚠️ 错误提示 |
| `sensitivePatterns` | `[]` | 出站敏感内容审计正则（内置 `rm -rf`/关机/删库/密钥 等模式；留空用内置默认） |
| `redactLocalPaths` | `true` | 出站正文里的本机绝对路径（盘符 / UNC / `\\?\` 长路径）替换为 `<本机路径>`：模型用绝对路径读文件后常把它复述进回复，群里会泄露目录结构；`false` = 原样发送。命中会打 warn 日志并进 trace |
| `sttEnabled` | `true` | 语音转写（需 ffmpeg + whisper CLI） |
| `sttEngine` | `auto` | STT 引擎：`auto`(自动探测 whisper-cli/whisper/mlx_whisper)/`openai`/`whisper-cpp`/`custom` |
| `sttModel` | `small` | whisper 模型 |
| `sttCommand` | 空 | `custom` 引擎的程序名/路径 |
| `sttArgs` | `[]` | `custom` 引擎参数模板，`{file}` 与 `{out}` 会被替换 |
| `sttTimeoutMs` | `60000` | 语音转写超时（毫秒；v0.4.0 起默认 60s，此前 300s）：超时保留 [语音] 占位；`<=0` 回落内置 60s |
| `textImageThreshold` | `150` | t2i 卡片阈值：正文长度 ≤ 该值单条发送；> 该值渲染为文字图卡片。渲染失败、PNG 超 `outboundImageMaxBytes` 或 `<=0` 禁用卡片时回退单条纯文本 |
| `cardFooter` | `dsh` | 卡片页脚品牌（"Powered by <brand>"） |
| `fontFiles` / `fontFamilies` | `[]` | t2i 字体文件/家族覆盖（Linux 部署必看：需安装 Noto CJK） |
| `mediaDir` | `<dsh-home>/media/onebot` | 入站媒体/映射文件目录 |
| `tempTtlHours` | `6` | 入站临时媒体文件保留时长（小时），到期自动清理 |
| `inboundImageMaxPx` | `2048` | 入站图片长边上限（px）：超过则等比压缩后交给视觉模型（透明 PNG 保留、GIF 不压）；`<=0` 禁用（旧名 `imageMaxSize` deprecated，本版兼容读取） |
| `attachInboundImages` | `true` | 入站图片投递（T15）：把落盘的入站图片交给宿主附件库，作为真正的 `image` 块进入消息 content，模型能直接看图；`false` = 退回旧行为（只在文本里给 `[图片:<路径>]`，模型得自己读文件）。投递受宿主附件服务可用性与下方两个上限约束，任一环节不满足就自动回退成文本，不影响回复 |
| `attachMaxImageMB` | `10` | 单张图片投递上限（MB，T15）：超过该大小的图不投递给模型，退回 `[图片:<路径>]` 文本注解（模型仍可自行读文件），避免一张巨图吃掉配额；`0` = 不限 |
| `attachmentBudgetMB` | `500` | 附件库软上限（MB，T15）：本插件账本累计占用达到该值后，**新的入站图片不再投递**（退回路径文本），`/storage` 以该值为分母给百分比并标出「已达上限」；**不自动删除**附件（附件库由宿主统一管理、跨插件共享，插件不擅自清理别人的东西）。`0` = 不限（只统计） |
| `attachmentRetentionHours` | `0` | 账本回收窗口（小时，T18）：超过该时长未再被投递的附件对象会从本插件的**预算记账**里移出，把 `attachmentBudgetMB` 的占用还回去；`0` = 不回收（旧行为：记账只增不减，软上限用满后永久降级）。**只改记账、不删任何文件**——`mediaDir` 与宿主附件库里的对象仍由宿主的清理策略回收，本插件不动别人的数据。设了软上限又担心用满后一直收不了新图时打开它，如 `72` |
| `attachmentSaveTimeoutMs` | `15000` | 单张入站图片交给宿主落盘的超时（毫秒，T18）：超时即放弃本次投递、退回路径文本。投递临界区按 `mediaDir` 全局串行，一次卡住的宿主写盘会堵住**所有会话**的图片投递，因此默认 15 秒；`0` = 不超时 |
| `outboundImageMaxBytes` | `8388608` | 出站图片大小上限（字节）：t2i 小结卡等出站图片超限时自动回退纯文本（旧名 `maxImageBytes` deprecated，本版兼容读取） |
| `maxVoiceBytes` | `15728640` | 出站语音大小上限（字节） |
| `maxFileBytes` | `20971520` | 出站视频/文件大小上限（字节） |
| `inboundFileMaxBytes` | `20971520` | QQ 入站文件大小上限（字节）：超限文件拒收并提示（旧名 `maxInboundFileBytes` deprecated，本版兼容读取） |
| `allowPrivateHosts` | `false` | 下载媒体 URL 时允许私网/环回地址（仅跳过私网检查，协议白名单与限长仍生效）；仅本机反代等可信场景开启，公网部署保持 `false` |
| `agentPreset` | 空 | 会话挂载的 agent preset（留空=默认） |
| `workspacePath` | 空 | 会话挂载的工作区（留空=宿主进程 cwd；未配置时插件启动会 warn 一次建议显式配置——宿主未提供可编程查询的默认工作区）。`/workspace` 的 per-chat 覆盖已持久化进映射文件，重启不丢 |
| `chatIdleEvictDays` | `7` | 会话空闲淘汰天数：chat 超过该天数无任何活动时，在下一条入站消息处理前清理其内存态 agent（会话先 flush 落盘、映射保留，同一 chat 之后再发消息可 resume 恢复原会话）；`0` = 禁用 |
| `napcatLauncher` | 空 | NapCat 启动器路径（可选）。留空则只在未连接时打印排查提示；配合 `autoStartNapcat` 使用。**用 NapCat 自带的启动脚本**（`launcher-user.bat` / `launcher-win10-user.bat` / `launcher.bat` / `launcher-win10.bat`，任选其一）：它们都带 `chcp 65001` 与 5 个 `NAPCAT_*` 环境变量；自建脚本漏环境变量会让 QQ 报「文件已损坏」。末尾 `pause` 会留一个隐藏的 cmd 进程，属正常 |
| `napcatLauncherArgs` | `[]` | 传给 `napcatLauncher` 的参数（给 **NapCat** 的，不是给 QQ 的）。免扫码登录：patch 里写 `['-q', '<机器人QQ号>']`，设置页面板里**每行一个**（`-q` 一行、号码一行）。写成一行 `-q 123456` 或 `-q123456` 都无效——NapCat 按 argv 全等匹配 `-q`，会退回二维码。参数含 shell 元字符（`&` `\|` `<` `>` `^` `%` `!` 双引号）会被忽略并记 warn，条目原文不打印 |
| `autoStartNapcat` | `false` | 未检测到 NapCat 连接时是否自动执行 `napcatLauncher`（最多 2 次，不杀任何进程）。**默认 `false` = 插件不启动任何进程，NapCat 完全由你手动管理**；它与 `napcatLauncher` 独立——配了路径但此项为 `false` 时，路径只用于诊断。诊断为 `QQ 已占用`（QQ 先启动）时即使开启也不会拉起——已运行的 QQ 无法被注入接管。详见 [docs/napcat-launcher.md](docs/napcat-launcher.md) |

> ⚠️ **BREAKING（M0 安全加固）**：reverse 模式下 `accessToken` 留空会拒绝启动（fail-closed）；`host` 默认从 `0.0.0.0` 改为 `127.0.0.1`（仅本机监听），跨机部署需显式配置 `host: 0.0.0.0`。

环境变量：`ONEBOT_ALLOWED_USERS`（逗号分隔管理员）、`ONEBOT_ALLOW_ALL_USERS=true`（开发用）。

## 录制 · 回放 · 注入 · 体检（W1）

| 能力 | 开关（默认） | 用法 |
|---|---|---|
| 入站录制 | `recordInbound`（**false**）+ `inboxRedact`（true） | 开启后每条入站事件逐行 JSON 追加写 `mediaDir/qq-inbox.jsonl`（含被门控跳过的事件与当时决策 reason；2MiB 改名轮转）；纯旁路，写失败仅 warn 限频 |
| 离线回放 | 无需开关 | `npm run build` 后 `npm run replay -- <inbox.jsonl> [--media-dir <dir>] [--limit <n>] [--require-mention] [--bot-qq <qq>] [--admin <qq>] [--out report.json]`：读录制文件喂**真实入站管线**（强制 dry-run：不启 WebSocket、出站写全部拦截计数），输出每条消息的 traceId+决策链汇总；不依赖宿主运行。回放门控取自命令行参数（默认全放行），需复现线上门控请传相同策略 |
| 事件注入 | `injectEnabled`（**false**）+ `injectDryRun`（**true**）+ `injectIntervalMs`（2000，最小 500） | **仅调试用**：往 `mediaDir/qq-inject.jsonl` 追加一行 OneBot 消息事件 JSON（可直接复制 `qq-inbox.jsonl` 的行），桥按间隔轮询喂进真实管线；dry-run 下该回合全部出站写（含异步模型回复）被拦截计数、原文进 trace（`stage=inject`），绝不真发 QQ。启动时已存在的历史行跳过并记一条说明 |
| 体检+诊断包 | 无需开关 | QQ 里发 `/doctor`（仅管理员，等价别名 `/healthcheck`）：连接态/重试与自愈/去重与写闸门计数/trace·inbox·audit 文件大小/最近 5 条 ok:false 事件/最近故障参考号；`/doctor export [参考号]` 打包 trace+inbox+actions log+脱敏配置快照为 `mediaDir/qq-diagnostics-<ts>[-<参考号>].zip`（参考号省略时自动用最近一次故障的参考号；token/accessToken 强制脱敏，含最终字节扫描 fail-closed） |
| 诊断参考号 | 无需开关 | 连接/桥类故障发 `QQ-CONN-<时间戳><随机>`、消息类故障发 `MF-<时间戳><随机>` 参考号（仅故障事件生成，正常流量零发号；参考号本身不含任何用户消息内容）。同一参考号贯穿四处：⚠️ 错误提示尾部、宿主日志「故障参考号 …」行、trace 事件 `data.ref`、`/doctor` 报告「最近故障参考号」节；诊断包导出文件名含触发参考号 |

## 图片与容量管理（T15）

入站图片落盘后可以**投递给模型**，让视觉模型真正「看见」图（此前只给文本路径，模型得自己读文件）。

| 环节 | 行为 |
|---|---|
| 什么时候投递 | 仅入站**图片**段（png/jpg/jpeg/webp/gif）；表情、卡片、文件段不走这条 |
| 怎么投递 | 先把图落进 `mediaDir`（既有逻辑不变：四路解析、大图按 `inboundImageMaxPx` 压缩、GIF 不压），再把**同一份字节**交给宿主附件服务 `ctx.attachments`，拿回 content-addressed 引用，拼成 `{ type: 'image', attachment }` 块放进消息 content |
| 三道闸门（都不抛错） | ① 单图超 `attachMaxImageMB` → `too-large`；② 本插件账本累计已达 `attachmentBudgetMB` → `budget`；③ 宿主附件服务不可用 / 类型不支持 / 写入失败（含 `attachmentSaveTimeoutMs` 超时）→ `host-unavailable`、`unsupported-type`、`save-failed` |
| 闸门不过怎么办 | 掉回旧行为：content 里给 `[图片:<路径>]`，消息照常可达（模型仍可自行 `read` 该文件）。**视觉增强失败绝不影响消息本身** |
| 去重 | 账本按 `attachmentId` 记 `hits`；同一张图重复进来命中宿主内容寻址去重，**不占新空间**，仅 `hits+1` |
| 账本位置 | `<mediaDir>/attachment-ledger.json`（本插件自己写的贡献记录，用于统计「我占了多少」，不碰宿主附件库里的其它对象） |
| 记账回收 | `attachmentRetentionHours` > 0 时，每次投递前先把 `lastSeenAt` 超出窗口的条目移出账本（把软上限占用还回去）；只改记账、不删文件 |
| 卡死保护 | 宿主写盘受 `attachmentSaveTimeoutMs`（默认 15 秒）约束：超时即放弃本次投递，避免一个卡住的写盘因临界区串行而堵死全部会话 |
| 容量统计 | QQ 里发 `/storage`（仅管理员）：`mediaDir` 总占用与文件数、宿主附件库总量、本插件贡献（对象数/字节/去重命中次数）、`attachmentBudgetMB` 软上限与已用百分比、`attachmentRetentionHours` 回收窗口是否启用 |

**为什么不自动清理附件库**：附件库由宿主统一管理、跨插件共享，插件看不出哪些对象是别人还在用的。所以 `attachmentBudgetMB` 只做统计口径与降级闸门——达到上限后**新图片自动降级为文本路径**，`/storage` 会标出「已达上限」；**不删任何东西**。想自动让出配额而不删文件，把 `attachmentRetentionHours` 设成非 0（如 `72`）：过期对象只是从记账里移出，磁盘文件仍在，宿主按内容寻址去重后再次投递不会重复占用。投递被闸门拦下的具体原因（`too-large` / `budget` / `host-unavailable` / `unsupported-type` / `save-failed`）走 `logLevel=debug` 日志，不刷 warn——因为预算长期超限时每张图都会触发一条，warn 级会淹没真故障。

`mediaDir` 本身的临时文件仍由既有 `tempTtlHours`（默认 6 小时）定期清理。

## 设置页

dsh Web GUI 的设置页提供本插件的可视化配置（host-plane Remote `onebotSettings`，写入 profile 层
`cordis.patch.yml` 中 `dsh-onebot` 条目的 config 覆盖行——与手改 patch、宿主原生设置页是同一个持久层）。

### 四组 44 键

| 组 | 键 |
|---|---|
| connection（连接） | `mode`、`host`、`port`、`url`、`accessToken`、`botQQ`、`workspacePath`、`memeDir`、`attachInboundImages`、`attachMaxImageMB`、`attachmentBudgetMB`、`attachmentRetentionHours`、`attachmentSaveTimeoutMs`、`napcatLauncher`、`napcatLauncherArgs`、`autoStartNapcat` |
| permissions（权限） | `requireMention`、`adminUsers`、`dmPolicy`、`groupPolicy`、`allowAllUsers`、`allowFrom`、`groupAllowFrom`、`mcpToolAllow` |
| behavior（行为） | `interimMessages`、`interimRecall`、`interimRecallMs`、`sendErrorNotice`、`unknownCommand`、`rateLimitPerMinute`、`newMessagePolicy`、`autoSteerPolicy`、`deferredTimeoutMs`、`reasoningEffort`、`persona`、`memoryEnabled`、`memoryMaxEntriesPerChat`、`memoryRecallTopK`、`memoryProfileScope` |
| diagnostics（诊断） | `actionAuditEnabled`、`traceEnabled`、`recordInbound`、`inboxRedact`、`injectEnabled`、`injectDryRun` |

`accessToken` 在设置页做密码型输入，快照返回侧脱敏（不回显明文）；写入侧仍在 patch 文件明文落盘。

### 与 patch config 的优先级

**schema 默认值 ← bundle/底层 patch（继承层） ← profile 覆盖行（设置页写这里）**；同一层内后写的 patch
条目胜出。设置页键与手改 patch 是同一层的同一行，不存在两套优先级。四组 44 键之外的键
（media/STT/性能/`agentPreset` 等低频键）不设 UI，仍在同一行 config 手改 patch。

### 生效方式

每次保存（设置页或手改同一覆盖行）= 插件 fiber 秒级原地重启生效，宿主进程与 Web GUI 不重启；
代价：QQ 桥一次秒级重连、在途回合中断、频控窗口与中间消息缓冲清零（会话映射/历史不受影响）。
与当前覆盖行全等的保存是 no-op，不触发重启；写入导致插件激活失败时 patch 文件自动回滚、旧配置继续运行。

### 记忆管理卡片（独立面板）

设置页在配置分组之上有一块**独立的记忆卡片**（与 NapCat 状态卡片并列），用于查看与编辑频道记忆：

| 操作 | 说明 |
|---|---|
| 加载 | 点「加载」才读目录 —— 卡片默认不发任何请求，**打开设置页本身零磁盘开销** |
| 会话选择 | 下拉列出所有有记忆的会话（私聊 / 群），显示文件大小 |
| 分页 | 默认 50 条/页，服务端分页（上限 200）；无关键字时新→旧 |
| 搜索 | 关键字匹配（与模型召回同一套分词），回车或点搜索 |
| 编辑 | 行内改正文，保存立即落盘；与模型写入共用敏感信息与 500 字闸门 |
| 删除 | 逐条删除（二次确认），不可撤销 |
| 过期标注 | 超出保留时长的条目标「已过期」——模型不再召回，文件仍保留 |
| 筛选 | 「全部 / 仅记忆 / 仅画像」下拉。过滤在**服务端**做（`kind` 参数），不是前端筛 —— 否则总数与分页会错乱 |
| 新建 | 卡片内直接添加：选类型（记忆 / 画像）、画像需填主体 QQ、正文 ≤500 字、标签可选（决定 TTL 档位）。与工具写入共用同一套规则（敏感信息拒绝、单会话上限裁剪） |
| 最近提及 | 每条显示首次写入时间；**同一事实被再次记录时不再新增行，只刷新「最近提及」**（判重口径：`kind` + `subject` + `text` 三者全等） |

记忆**不进** `getSettings` 快照（每次刷新都解析全部 JSON 会拖慢设置页），数据走四个按需方法：`listMemoryChats`（只 `readdir`+`stat`）/ `readMemoryEntries`（只读选中的文件、分页）/ `updateMemoryEntry` / `deleteMemoryEntry`。

> 编辑只改正文与标签；`ts`（标识）、`kind`（记忆/画像）、`subject`（画像主体）不可改 —— 它们是身份字段。

## 会话工作区（workspace）选择

每个 QQ 会话创建时按以下优先级确定工作目录（写入 session meta，**创建时冻结**，不随配置变化）：

1. 该会话的 `/workspace` 覆盖（per-chat 记录，跨 `/new` 保留）
2. 配置 `workspacePath`
3. 宿主进程 cwd（`process.cwd()`）

`/workspace <目录>` 切换（realpath + 目录校验）：记录覆盖后会 retire 当前 agent，
下一条消息以新目录重建会话，旧会话保留在磁盘。`/workspace` 无参数输出编号列表
（当前目录标「← 当前」），回复 `/workspace <序号>` 即可切换；`/workspace list` 列出全部 workspace 记录。

`/workspace` 的 per-chat 覆盖已持久化进映射文件（chat-sessions.json，加法格式、兼容旧文件）：
重启、会话恢复失败均不丢失，对 `/new` 同样保持——只要该 chat 用的是非默认目录，
重启后 `/workspace` 与新会话都会继续使用原目录。

会话自动挂载到 GUI 工作区：仅当会话 cwd 等于配置的 `workspacePath`（未配置时为宿主 cwd）
才自动创建 workspace；沿用旧 cwd 的遗留会话只在已有 workspace 拥有该路径时挂载，不会自动新建。

## 斜杠命令速查（全部仅管理员）

| 命令 | 作用 |
|---|---|
| `/new` | 开启新会话（清空上下文，旧会话保留在磁盘） |
| `/stop` | 停止当前生成 |
| `/steer <补充内容>` | 向运行中的任务补充一条指令（agent 在下一步读取并回复提交提示）；两种 `newMessagePolicy` 模式下均可用；无运行中任务或参数为空时回复中文用法提示（不炸、不静默） |
| `/model [--default] <provider> <model>` | 查看或切换当前会话模型；`--default` 修改部署默认。无参输出两级序号列表：回复序号选 provider → 再回复序号选模型并切换当前会话 |
| `/workspace [路径\|序号\|list]` | 查看或切换工作区；无参输出编号列表（标「← 当前」），回复 `/workspace <序号>` 即切换；`/workspace list` 列出全部记录 |
| `/preset [id\|序号]` | 查看当前/可用预设（无参编号列表，回复序号即选），或切换 preset（重建会话，新会话 header 记录） |
| `/session [序号]` | 查看本会话可切回的历史会话（无参编号列表，每项含内容预览、建立时间与退休时间，id 截短显示；日志不可读的项显示「（内容不可读）」且不影响其余项），回复序号切回：当前会话退休进列表、目标会话恢复其历史上下文（含 per-chat 设置），支持来回切换；列表跨重启保留（switchable-sessions.json，每 chat 上限 20 条） |
| `/status` | 会话全景：chat/session/preset/model/cwd/出站模式/agent/可切回数 状态 |
| `/storage` | 存储占用：`mediaDir` 总占用与文件数、本插件在宿主附件库里的贡献（`/storage` 会实时遍历附件库按本插件的写入路径统计）、`attachmentBudgetMB` 软上限与百分比、`attachmentRetentionHours` 回收窗口（未启用时会显式标注「记账只增不减」） |
| `/memory [forget]` | **所有成员可用**（目前唯一非管理员命令）：查看本会话记忆条数 + 关于你自己的画像（别人的画像看不到）；`forget` 删除你自己的全部画像。这是隐私兜底 —— 被记录的人要能自己查、自己删 |
| `/doctor [export [参考号]]` | 运行体检（别名 `/healthcheck`）：连接/工具/存储/最近故障参考号全景；`export` 导出脱敏诊断包 `qq-diagnostics-*.zip`（文件名带触发参考号），非法参考号回用法提示且不落盘 |
| `/retry` | 重跑上一条用户消息（上一轮出错后重试） |
| `/id` | 只看 chat/session/cwd（排查用） |
| `/ver` | 插件版本 + git commit |
| `/ocr` | 识别本会话最近一张入站图片（NapCat ocr_image） |
| `/mode [interim\|instant]` | 切换本会话出站模式（per-chat 覆盖，跨重启持久化） |
| `/plan [off\|内容]` | 宿主计划模式（`/plan` 进入；`/plan off` 直接退出，无 Web 审批卡；`/plan <内容>` 进入并处理该内容） |
| `/permission [w\|f\|预设名\|序号]` | 切换宿主权限 preset（沙箱模式+审批策略，切换立即生效）：`w`/`ws`/`write`/`工作区`→workspace-write（工作区内可写+需审批）、`f`/`full`/`danger`/`全权`→danger-full-access（全盘读写+免审批）；完整预设名照原样转发（未知名由宿主报错并回显可用列表）；无参渲染中文权限菜单（当前权限+可用预设编号列表+用法行，未知预设名标「部署自定义」；宿主回文格式变化时回退转发原文+快捷提示），纯数字序号按 available 顺序（现场解析，不落快照） |
| `/goal [目标\|clear]` | 记录/更新本会话目标（每轮自动附带提醒，跨重启持久化） |
| `/help` | 分组命令卡片（▍会话/输出/查询/操作/其他），每条带参数用法；报错提示均附用法或下一步动作 |

`/preset` 切换为进程内 per-chat 覆盖（跨 `/new` 保留）：下一条消息重建会话并以新 preset
写入 header，重启后 resume 按记录恢复；`/mode`、`/goal` 的 per-chat 状态已持久化进映射文件（v0.4.0 起，跨重启
保留），`/workspace` 的覆盖同样持久化；`/plan` 仍为进程内覆盖，重启回退到默认。
`/session` 的可切回列表按 chat 持久化在媒体目录的 switchable-sessions.json（读写纪律与 retired-sessions.json
一致：文件缺失=全新、损坏保留内存、原子写；每 chat 上限 20 条、去重、最新在前）。列表每项渲染一条内容预览
（该会话事件日志第一条真实用户输入：kind 'user' 或本插件署名的 QQ 消息优先，缺失时回退任何 user/message；
提取全部 text 块拼接、剥去 QQ 入站的 <user_message> 包裹与拼接在边界外的可信前缀（[受限用户:仅问答] / [HH:MM 昵称(QQ)]，包裹不完整或空正文则原样回退）后换行折叠、按码点截断 ≤40 字，emoji 不拆半；找不到用户输入显示「（无对话内容）」）、
建立时间（会话 header 的 createdAt，取不到则省略）、退休时间与截短 id（前 8+…+后 8 字符，保留两侧便于辨认）。
预览经 sessionPersistence 的 read handle 冷读日志前 24 个事件取得（不开写所有权，读完即 close）；单会话日志
缺失/损坏/读取失败只降级该项为「（内容不可读）」，其余项与切回功能不受影响。切换成功后目标会话解除退休
标记，重启 resume 与空闲淘汰后的再激活都走常规路径找回它；切回目标 resume 失败时该 id 立即硬退休并移出列表，
chat 回退到下一条消息新建会话，不会卡死。损坏（碰撞/恢复失败）退休的会话绝不进列表、不可切回。
序号选择基于命令输出列表的快照，5 分钟内有效（过期提示重新查看）；纯数字参数仅在有对应有效列表时
按序号解释，否则维持原参数语义。例外：`/permission` 的纯数字序号不落快照，每次现场取宿主 available 列表解释（1/2），越界或不可解析时回退用法提示。未知斜杠命令默认拦截并提示相近命令，配置 `unknownCommand: passthrough`
可改为透传给模型。

## 安全编辑（code_safe_edit）

受守卫的宿主文件编辑由**独立插件 dsh-safe-edit** 提供（`~/dsh-plugins/dsh-safe-edit/`，2026-08-18 从本插件拆出，对所有通道全局注册）。三个工具：
思路借鉴 [irmia_devkit_open](https://github.com/irmia2026/irmia_devkit_open) 的 safe_edit（AGPL-3.0，独立 TypeScript 清洁实现）。工具与边界见 dsh-safe-edit 仓库/说明：

- `code_safe_edit`：read → 路径白名单 → **自动备份** → 匹配（精确 → 剥行号前缀 → 空白对齐/Aider 式）→ 替换 → 语法检查（js/cjs/mjs 走 `node --check`）→ **失败自动回滚**
- `code_safe_rollback` / `code_list_backups`
- 边界随会话 sandbox 策略：`danger-full-access` 无限制、`workspace-write` 限会话工作区、`read-only` 拒绝；无策略服务回落 `safeEditRoot`（默认 `/Users/mario/workspace`）
- 模型可优先使用此工具（`code-safe-edit` skill 全渠道引导；QQ 平台提示词引导内置 read/edit 惯例，不绑定具体工具名）

## dm / group 访问策略（初始化必选）

私聊（`dmPolicy`）与群聊（`groupPolicy`）各自三选一，选项含义如下：

| 选项 | dmPolicy（私聊） | groupPolicy（群聊） |
|---|---|---|
| `open` | **仅管理员**可私聊（adminUsers/`ONEBOT_ALLOWED_USERS`；设 `allowAllUsers: true` 则所有人可） | **所有群**可聊（群内消息受 `requireMention` 控制：需 @ 或回复机器人的消息才触发；群成员带 [受限用户:仅问答] 软限制） |
| `allowlist` | 仅 **`allowFrom`** 白名单 QQ 可私聊（不要求是管理员） | 仅 **`groupAllowFrom`** 白名单群可聊 |
| `disabled` | 私聊全部拒绝 | 群聊全部拒绝 |

**初始化建议**：
- 只想自己用 → `dmPolicy: open` + 配好 `adminUsers`（私聊只有你能发）；
- 想开放给几个熟人 → `dmPolicy: allowlist` + `allowFrom: ['QQ1','QQ2']`；
- 群聊专用机器人 → `groupPolicy: open`（配合默认 `requireMention: true`，群成员需 @ 才触发）；
- 只允许特定群 → `groupPolicy: allowlist` + `groupAllowFrom`。

## t2i 字体依赖

文字图卡片需要三类字体（CJK / 等宽 / 彩色 emoji），插件启动时从系统与固定路径自动注册，
缺失时对应字符渲染为豆腐块。

- **macOS**：零安装——自动使用系统自带 Hiragino Sans GB / Songti SC、Menlo、Apple Color Emoji。
- **Linux**（Debian/Ubuntu，一条命令补齐）：

  ```sh
  sudo apt install fonts-noto-cjk fonts-dejavu-core fonts-noto-color-emoji
  ```

  | 依赖 | 提供文件（插件自动注册路径） | 用途 |
  |---|---|---|
  | `fonts-noto-cjk` | `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc` | 中文正文/标题（ttc 自动提取 SC 面，回退 JP/Mono 面） |
  | `fonts-dejavu-core` | `/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf` | 代码块/行内 code 等宽 |
  | `fonts-noto-color-emoji` | `/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf` | 彩色 emoji |
  | 可选 `fonts-wqy-zenhei` / `fonts-wqy-microhei` | `/usr/share/fonts/truetype/wqy/*.ttc` | CJK 备选（Noto 缺失时） |
  | 可选 `fonts-unifont` | `/usr/share/fonts/opentype/unifont/*.otf` | 最后兜底 |

- **自定义**：`fontFiles` 指定额外字体文件（重启生效）；`fontFamilies` 指定优先使用的家族名。
  渲染器带墨水自检——缺字体的家族会被自动剔除并回退，不会静默出豆腐块卡片。

## 权限与数据

- **网络**：与 OneBot 11 网关建立 WebSocket 连接（reverse 监听或 forward 拨出）；入站图片/文件从 QQ CDN 下载。
- **文件**：入站媒体与会话映射写入 `<dsh-home>/media/onebot/`（`mediaDir`，6 小时过期清理）；会话数据由 dsh 宿主持久化。
- **系统调用**：语音转写调用本机 ffmpeg 与 whisper CLI（可 `sttEnabled: false` 关闭）。
- **敏感信息**：`accessToken` 与管理员白名单存于 dsh 配置，不写入日志；出站内容经敏感信息审计。
- **不收集**：无遥测，除用户配置的 OneBot 网关与图片 CDN 外不调用任何第三方服务。

## 给模型的平台说明（自动注入）

- QQ 不渲染 Markdown → 输出纯文本（编号/短横线列表、行内反引号）。
- 发图/文件/语音/视频用 `qq_send_*` 工具；合并转发用 `qq_send_forward`。
- 用户发来的图片/语音/视频在文本中标注为 `[图片]`/`[语音]`/`[视频]` 占位（路径不进入文本）；QQ 表情标注为 `[表情:名称]`，表中没有的 id 标注为 `[表情:id=数字]`——这些都是入站标记，回复时不要输出；无可用看图工具时如实告知用户。
- 群聊消息带 `[HH:MM 昵称(QQ)]` 前缀；受限用户消息带 `[受限用户:仅问答]` 前缀（仅回答，禁止文件/终端/配置操作）。
- 本通道为 QQ，宿主无 Web 交互卡：禁止调用 `ask_user_question` / `exit_plan_mode`（确认卡仅 Web 可用，会阻塞对话），提问/确认走纯文本；宿主计划模式下输出纯文本计划并提示「/plan off 退出」。
- 斜杠命令由插件拦截（18 个，仅管理员，`/help` 查看）；未知斜杠命令默认拦截并提示相近命令，配置 `unknownCommand: passthrough` 时透传给模型；非 `/纯单词` 开头的文本（如路径）仍正常交给模型。
- 修改宿主文件走内置 read/edit（行级 hash 锚点、dsh-better-edit 自动 undo），勿用 write 整文件覆盖（清空 undo 历史）。

## 卸载

1. 从 `~/.dsh/profiles/<profile>/cordis.patch.yml` 删除 dsh-onebot 的 insert 条目；
2. 重启 dsh，日志不再出现 `[dsh-onebot] mounted` 即卸载完成；
3. 可选：删除插件目录与 `<dsh-home>/media/onebot/` 残留媒体。

## 开发

```sh
./scripts/build.sh                 # 编译 src/ → lib/
./node_modules/.bin/vitest run     # 40 个 spec / 588 用例：单元 + 真实 WS 对端 + 全管线
                                   # Linux 预期全绿；Windows 上 19 条已知失败（t2i 无 CJK 字体 + 8.3 短路径差异）
```

要点（来自移植源 DEVLOG 的教训）：

- **CQ 反转义**：NapCat 会把 URL 里的 `&` 转成 `&amp;`，下载前必须反转义（CDN 403 的根因）。
- **@ / 回复检测 fail-closed**：不知道机器人 QQ 时，群消息一律视为未提及，不自动回复；回复他人消息时被回复者身份查不到（已撤回/`get_msg` 失败）同样按未提及处理——宁可漏答也不错答。
- **断线即失败 pending**：WS 断开时立即 reject 所有未完成 action，避免 10-30s 干等与泄漏。
- **重连去重**：并发断线只允许一个重连任务，防止双 WS 连接。
- **int(target) 兜底**：chat_id 解析进 try/catch，坏目标不能炸掉宿主。
- **临时媒体 6h 过期清理**：只写不删会无限堆积。
- **t2i 按码点迭代**：JS 字符串索引会拆开 emoji 代理对（高代理位被分类成 CJK → 渲染成黑色字形），绘制/测量必须用 `Array.from`/for...of。
- **t2i 度量=绘制**：换行/列宽统一走 `segWidth`（胶囊/粗体/斜体附加宽），像素级右缘验证 ≤790（非白判定 `not(r>245&&g>245&&b>245)`）。

## 故障排查

| 症状 | 原因与处理 |
|---|---|
| 群聊不响应 | `requireMention: true` 时需 @ 或回复机器人的消息才触发；@ 检测 fail-closed——确认 botQQ 已从 meta 事件学习，或显式配置 |
| NapCat 未连接 / QQ 机器人没反应 | 先看 `mediaDir/onebot.log` 与设置页「NapCat」卡片的阶段结论：**`QQ 已占用`** = QQ 先启动了，注入器无法接管已运行的 QQ（NapCat 要求由 launcher 独占拉起），请完全退出 QQ 后由 launcher 启动；**`等待扫码登录`** = 扫二维码（超过约 5 分钟失效）；**`端口未连接`** = 注入器在跑但 OneBot 没连上，核对 NapCat 的 onebot11 反向 WS 的 url/token；**`NapCat 未启动`** = 注入器与 QQ 都不在。拉起器的原始输出在 `mediaDir/napcat-launcher.log`。免扫码、开机自启与包装脚本模板见 [docs/napcat-launcher.md](docs/napcat-launcher.md) |
| 图片下载 403 | NapCat 会把 URL 中的 `&` 转成 `&amp;`（解析已自动反转义）；仍失败可查日志中 media 下载行 |
| 文件接收失败 | 非本机部署 NapCat 时需开启「文件转 URL」开关，否则 get_file 返回容器内路径不可达；确认 dsh 与 NapCat 网络互通 |
| 文字图中文豆腐块 | Linux 未装 CJK 字体：`apt install fonts-noto-cjk`，并用 `fontFiles` 指定 SC 字体文件 |
| 崩溃循环 / 工具注册冲突 | 同一插件文件被 insert 两次（双实例）——检查 patch 无重复条目 |
| 语音一直只有 [语音] 占位、没有转写补递 | ffmpeg 或 whisper 不可用，或转写超时：安装后重启、调大 `sttTimeoutMs`，或 `sttEnabled: false` 关闭 |
| 插件挂载失败 / peer 依赖解析失败 | 部署副本缺完整 node_modules 链接集：只复制 `lib/` 不够，运行时 peer 依赖 `@deepseek-ai/*` 需经 `scripts/link-host.sh` 链接到宿主安装；插件入口会 fail-loud 显式报「peer 依赖解析失败」，按报错补齐链接集后重启 |
| `build.sh` 报 `cannot locate the dsh install` | 宿主无 `dsh` 在 PATH（如 fnOS 应用形态）且未找到 npx store：设 `DSH_ROOT=<宿主 node_modules 路径>` 后重跑 `./scripts/build.sh`（该目录下须有 `@deepseek-ai/`，设错路径会显式报错而非静默回退） |
| 改了设置页 / patch 但不生效 | 按顺序排查：① 确认改的是**被监视的文件**——profile 层 `<DSH_HOME>/profiles/web/cordis.patch.yml` 或 home 层 `<DSH_HOME>/cordis.patch.yml`（仓库 patch 模板、部署副本、bundle 自带 patch 均不被监视，需同步到上述文件）；② 内容须真的变化（touch 同内容文件是 no-op）；③ 看宿主日志有无激活失败——insert 新增条目激活失败（如 peer 缺失）会显式报错、条目失活，等待重启重试；④ 设置页的持久层是 profile 层 `dsh-onebot` 覆盖行，改到别处（如已被宿主废弃改名的 settings.yaml）不会生效 |
| 日志在哪 | dsh 宿主日志；桌面版（GUI 进程）里插件的 `mounted` 与连接日志同时落盘 `mediaDir/onebot.log`；插件历史根因与修复见 [DEVLOG.md](DEVLOG.md) |
| 挂没挂上、用的是哪套宿主依赖 | 看 `mediaDir/startup-report.txt`（每次启动生成：插件版本、宿主 peer 版本与落点、Node/平台、传输、mediaDir、workspacePath、管理员数）或 `mediaDir/onebot.log` 的「宿主 peer 解析」行。落点写「宿主 asar 内」= 走宿主安装树（正常）；写「插件自带 node_modules」= 用了本包自带的 peer 副本，存在双包风险（通常是 `peerDependencies` 未声明该包，或本地残留了副本） |
| 凭参考号查故障全过程 | 任何 `⚠️` 错误提示/连接故障日志尾部的参考号（`MF-…` 消息类 / `QQ-CONN-…` 连接类）都可在 `mediaDir/qq-trace.jsonl` 中检索：`grep <参考号> mediaDir/qq-trace.jsonl` 即列出该次故障的全部决策事件（stage/reason/耗时/traceId）。也可在 QQ 里发 `/doctor` 查看「最近故障参考号」节（含每号的 traceId 与阶段），或 `/doctor export <参考号>` 导出文件名含该号的脱敏诊断包离线分析。参考号仅在故障事件生成，正常流量零开销，不含用户消息正文 |

## 开发记录

完整时间线/根因/修复见 [DEVLOG.md](DEVLOG.md)（移植自 Hermes onebot 插件的 DEVLOG 惯例）。

## License

BSD-3-Clause

