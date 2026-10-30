/**
 * The chat↔agent bridge: one Agent per QQ chat, inbound message pipeline
 * (policy → parse → media → STT → quote/forward expansion → followup),
 * outbound delivery driven by session events (assistant/message, turn/end),
 * typing indicator, per-chat send ordering, and chat→session mapping
 * persistence for restart resume. Ported from the Hermes OneBotAdapter
 * gateway-interaction half onto the dsh headless-runner agent pattern.
 * @module dsh-onebot/bridge
 */

import type { AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'


import type { OneBotConnection, OneBotEvent } from './connection.js'
import type { MediaStore } from './media.js'
import type { Transcriber } from './stt.js'
import { transcriptLabel } from './stt.js'
import type { MediaRef } from './cq.js'
import type { ChatId, UserRole } from './chat.js'
import { buildChatId, classifyUserRole, splitChatId } from './chat.js'
import type { AccessPolicyConfig } from './chat.js'
import { buildPlatformPrompt } from './prompt.js'
import { registerTools } from './tools.js'
import { forgetProfiles, readAllMemories, selectForRecall } from './memory.js'
import { makeMcpToolGuard, describeDroppedEntries } from './mcp-gate.js'
import { tryHandleCommand as routeCommand, STEER_ACCEPTED_NOTICE, type CommandContext } from './commands.js'
import { relayHostCards as relayCards, type CardRelayContext } from './card-relay.js'
import { OutboundPipeline } from './outbound.js'
import type { OutboundSegment, SendOptions } from './outbound.js'
import { ChatRegistry } from './registry.js'
import type { ChatAgent } from './registry.js'
import { InboundPipeline, normalizeOneBot11 } from './inbound.js'
import type { NormalizedInbound } from './inbound.js'
import { InterimTracker } from './interim.js'
import { DeferredDelivery } from './deferred.js'
import { DEFAULT_DEFERRED_TIMEOUT_MS } from './deferred.js'
import { describeError, errorStack } from './errors.js'
import { currentTrace, newTraceId, runWithTrace, TRACE_REASONS } from './trace.js'
import type { TraceSink, TraceScope } from './trace.js'
import { runInjectRound, currentInjectRound, isWriteAction, INTERCEPTED_MESSAGE_ID } from './inject.js'
import type { InjectChannel } from './inject.js'
import type { InboundRecorder } from './record.js'
import { healthReport, exportDiagnostics, redactSnapshot } from './health.js'
import type { HealthDeps } from './health.js'
import { FailureRefRegistry, failureRefSuffix } from './ref.js'
import type { FailureRefKind } from './ref.js'
import type { TraceStage } from './trace.js'
import type { ImageAttachmentRef } from './attach.js'
import { deliverImage, resolveAttachPolicy, formatStorageStats, storageStats } from './attach.js'
/** T15：一条入站用户消息的内容块（文本 + 已投递的图片）。
 *
 * 为什么不直接标注宿主的 `UserMessageContent`：该类型名不在本插件的类型面上
 * （`@deepseek-ai/dsh-llm` 只在此处按需 import 具体的构造器与模型信息类型），
 * 直接写会得到 TS2304「找不到名称」，使 `npm run build`（tsc -p tsconfig.json，
 * strict）整条构建失败——src 侧从此无法被编译器校验。
 *
 * 形状按宿主实现对齐（`dsh-llm` 的 `contentHasImage` / `replaceImagesForTextModel`
 * 都以 `block.type === 'image'` 且读 `block.attachment` 判别 image 块），
 * 因此这里的联合与宿主是可结构兼容的。
 *
 * 用判别联合而非「type + 两个可选字段」：若宿主 `UserMessageContent` 的每个变体
 * 都把 `text` / `attachment` 声明为必填，`text?: string` 无法赋给任一分支，
 * tsc 仍会在 createUserMessage 调用点报 TS2345（错误码变了但构建还是碎）。
 * 判别联合让每个变体各自带上必填字段，两侧赋值都能通过。 */
export type InboundContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }
/** T2 (P1): the queue notice sent to a chat when a message arrives while its
 * task is running under the default 'queue' policy — at most ONE per running
 * turn (the flag resets at turn/end) so a burst of queued messages never
 * spams the chat. Exported for the deterministic text wait in tests. */
export const QUEUE_NOTICE_TEXT = '⏳ 当前任务运行中，新消息已排队，将在当前任务结束后依次处理。'

/** Resolved runtime configuration for the bridge. */
export interface BridgeConfig {
  botQQ: string
  ignoreSelf: boolean
  requireMention: boolean
  /** Unknown slash-command handling (R1): 'intercept' (default) consumes the
   * message with a closest-match suggestion or a hint; 'passthrough' restores
   * the old fall-through to the model. */
  unknownCommand?: 'intercept' | 'passthrough'
  interimMessages: boolean
  /** Per-interim auto-recall delay (ms) from each interim's send completion
   * while the turn is still running (QQ recall window ~2 min); absent → 90s.
   * At turn/end the remaining originals are recalled immediately regardless. */
  interimRecallMs?: number
  /** M3-D2b degrade switch: false = send-only interims — no auto-recall
   * timers, no turn/end immediate recall and no summary card (the turn ends
   * with the final text only). Absent/true = the full recall behavior. */
  interimRecall?: boolean
  sendErrorNotice: boolean
  /** B7: per-chat per-minute sliding-window cap for normal (non-command)
   * messages; absent → 30, 0 disables. */
  rateLimitPerMinute?: number
  restrictedMemberPrefix: boolean
  sensitivePatterns: readonly string[]
  /** 出站回复中的本机绝对路径（盘符 / UNC）替换为 <本机路径>；缺省 = 开启。 */
  redactLocalPaths?: boolean
  /** S-08：OneBot access token（只给诊断包脱敏用；空串 = 未配置）。
   * 原先 HealthDeps.secrets 恒为空数组，导致「归档里不得含明文密钥」的
   * fail-closed 断言空转，只剩 access_token/bearer 一类正则兜底。 */
  accessToken?: string
  mediaDir: string
  maxImageBytes: number
  maxVoiceBytes: number
  maxFileBytes: number
  textImageThreshold: number
  cardFooter: string
  fontFiles: readonly string[]
  fontFamilies: readonly string[]
  agentPreset: string
  /** QQ 通道的思考强度覆盖：''/缺省 = 继承宿主 agent-default-model（0.9.4 及
   * 以前的行为）；非空 = 本通道 agent 的 reasoningEffort，Web/GUI 会话不受影响。 */
  reasoningEffort?: string
  /** T11：QQ 通道的角色设定（人设）文本；空串/缺省 = 不注入人设层，行为与
   *  0.9.4 一致。仅影响本通道的 system prompt，Web/GUI 会话不受影响。 */
  persona?: string
  /** T12：表情包目录（`<memeDir>/<tag>/<file>.jpg`，与 dsh-meme 图库同构）。
   *  空串/缺省 = 不注册 qq_send_meme；非空则本通道 agent 多一个只读该目录的
   *  发图工具。目录必须在 mediaDir 之内才能通过出站围栏。 */
  memeDir?: string
  /** T20：QQ 通道可调用的 MCP 工具白名单；空/缺省 = 禁用全部 MCP 工具。 */
  mcpToolAllow?: string[]
  /** T15：入站图片是否投递为真图片块（默认 true）；false = 只给路径文本。 */
  attachInboundImages?: boolean
  /** T15：单张入站图片投递上限（字节）；0 = 不限。 */
  attachMaxImageBytes?: number
  /** T15：附件库软上限（字节）；0 = 不限。 */
  attachmentBudgetBytes?: number
  /** T15：账本回收窗口（毫秒）；0 = 不回收（只增不减）。 */
  attachmentRetentionMs?: number
  /** T15：单次投递的宿主写盘超时（毫秒）；0 = 不超时。 */
  attachmentSaveTimeoutMs?: number
  workspacePath: string
  /** Max inbound file bytes fetched via QQ direct link / base64 (0 = no cap). */
  maxInboundFileBytes: number
  /** B8c: chats idle longer than this many days are evicted on the next
   * inbound message (0 disables; default 7). Evicted chats keep their
   * chat→session mapping, so a later message resumes the same session. */
  chatIdleEvictDays?: number
  /** 频道记忆（第一批）：为 true 时注册 `qq_memory_remember` / `qq_memory_recall`。
   * 三个字段都可选，缺席按「关闭 / 默认值」处理，不影响既有装配。 */
  memoryEnabled?: boolean
  /** 单会话记忆条数上限（每次写入后裁剪，超出丢最旧）。 */
  memoryMaxEntriesPerChat?: number
  /** `qq_memory_recall` 默认返回条数。 */
  memoryRecallTopK?: number
  /** 成员画像能在哪写：`'dm'`（默认，仅私聊）/ `'all'`（群聊也允许）/ `'off'`。主体由本轮发言者决定。 */
  memoryProfileScope?: 'dm' | 'all' | 'off'
  /** T2 (P1): how a new ordinary message is handled while the chat's task
   * (agent turn) is running; absent → 'queue' (the default). 'queue' = the
   * message keeps the 0.8.1 dispatch path (agent.followup queues it as the
   * next turn — consumed AFTER the current turn ends, in arrival order) and
   * the chat gets at most one queue notice per running turn; 'steer' = plain
   * text (no media/quote/forward, non-restricted senders) is submitted as a
   * supplementary instruction into the running turn via the same
   * agent.steer kernel as steerTranscript, with a per-message submit notice. */
  newMessagePolicy?: 'queue' | 'steer'
  /** T9-B (用户裁决 2026-10-12)：steer 模式下自动插话的发送者资格档位；
   * absent → 'admin'（缺省）。'admin' = 仅管理员可自动插话；'all' = 所有
   * 非受限发送者均可。不改变 /steer 命令（始终仅管理员）与 queue 模式行为，
   * 也不放宽受限用户软限制（受限消息任何档都排队）。 */
  autoSteerPolicy?: 'admin' | 'all'
  /** T3 (P2)：等待模型回复超时阈值（ms）——回合超过该时长没有任何模型输出
   * 时提示超时并登记补发跟踪（deferred delivery），回合完成后向原聊天补发
   * 最终文字（「（超时补发）」前缀，走既有 outbound 管线）；absent →
   * 600000（保守 10 分钟），0 = 关闭超时补发。 */
  deferredTimeoutMs?: number
}

/** W1 trace/config extensions: the observability knobs ride as optional
 * members (same pattern as the W2-②③ gate keys) so the declared BridgeConfig
 * shape above stays untouched; absent = the feature is off (0.6.0 behavior). */
export interface TraceBridgeConfig {
  /** W1: decision-trace sink; absent/disabled = no traceIds, no jsonl, zero
   * behavior difference vs 0.6.0. */
  trace?: TraceSink | undefined
  /** W1/T5: inbound recorder (recordInbound); absent = recording off. */
  recorder?: InboundRecorder | undefined
  /** W1/T5: inject channel (injectEnabled, DEBUG-ONLY); absent = channel off. */
  inject?: InjectChannel | undefined
}

/** Agent-preset service (dsh-agent-presets): joins agents to a preset composition. */
export interface AgentPresetsLike {
  /** The preset id a new session gets when none is named (deployment default). */
  readonly defaultId: string
  /** Resolve one preset by id (undefined = default); throws when no root supplies it. */
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: unknown, id?: string): Promise<{ id: string }>
}

/** Structural slice of one logged session event the /session preview reads
 * — only the preview's fields are named, and the host's SessionEvent (whose
 * 'user/message' payload is a UserMessage) satisfies it. */
export interface SessionPreviewEvent {
  type?: string
  data?: {
    agentPreset?: string
    source?: { kind?: string }
    content?: readonly { type?: string; text?: string }[]
  }
}

/** Narrowed read handle over one stored session (dsh-session-persistence's
 * `SessionHandle` from `open(id, 'read')`): the /session preview reads the
 * immutable header plus a small event prefix and then MUST close the handle
 * (AsyncDisposable — a leaked read handle pins backend resources). */
export interface SessionReadHandleLike {
  readonly header: { createdAt?: number; agentPreset?: string }
  read(offset?: number, length?: number): Promise<{ events: readonly SessionPreviewEvent[] }>
  close(): Promise<void>
}

/** Durable session persistence (dsh-session-persistence): cold-read what a session recorded. */
export interface SessionPersistenceLike {
  /** Existence probe (dsh-session-persistence 0.1.6 `stat`): resolves the
   * stored snapshot, or undefined when the id owns no durable log. Replaces
   * the retired host `inspect` convenience. */
  stat(id: SessionId): Promise<object | undefined>
  /** Open an existing stored session for reading: 'read' never takes write
   * ownership and works while a live writer holds the session. */
  open(id: SessionId, access: 'read'): Promise<SessionReadHandleLike>
}

/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceLike {
  id: string
  path: string
  sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<void>
}

/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  create(path: string, title?: string): Promise<WorkspaceLike>
  list(): WorkspaceLike[]
}

/** Default model service (dsh-agent-default-model): read/save the default selection. */
export interface AgentDefaultModelLike {
  currentSelection(): ModelSelection | undefined
  saveSelection(next: ModelSelection): Promise<void>
}

/** Live model-catalog port (M2-C5b): the only llm surface the command domain
 * reads (/model). index.ts implements it over a live llm-service lookup so
 * late-registered providers stay visible; commands never touch Context. */
export interface LlmCatalogPort {
  listProviders(): LlmProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
}

/** Session-event feed port (M2-C5b): the narrowed event-bus surface the bridge
 * subscribes to, replacing the whole-plugin Context. index.ts satisfies it
 * with the host context itself (its event-bus `on` IS the implementation); the
 * BridgeDeps field keeps the historical name `ctx` because existing test
 * assemblies pass the host context directly. */
export interface SessionEventPort {
  on(type: 'session/event', handler: (session: Session, event: SessionEvent) => void): () => void
  on(type: 'session/flush', handler: (session: Session) => void): () => void
}

/** Services the bridge needs (M2-C5b: the plugin Context enters only through
 * the two explicit ports below — session events and the /model catalog). */
export interface BridgeDeps {
  ctx: SessionEventPort
  /** Resolves once the host's boot-time configuration (the loader service) is
   * fully applied; index.ts owns the 'loader' lookup and swallows its errors.
   * Absent in test assemblies = no gate (matches the previously swallowed
   * lookup). Must not reject. */
  hostReady?: (() => Promise<void>) | undefined
  /** Live model-catalog port for /model (M2-C5b); index.ts implements it over
   * the live llm service. Absent only in assemblies that never route /model. */
  llmCatalog?: LlmCatalogPort | undefined
  connection: OneBotConnection
  /** The dsh data home (default <home>/.dsh); used to enumerate agent presets. */
  dshHome?: string | undefined
  media: MediaStore
  transcriber: Transcriber
  agents: AgentRegistry
  sessions: SessionStore
  agentPresets: AgentPresetsLike | undefined
  /** Host command runtime: forwards /plan and /permission so QQ reaches the
   * native commands. dsh ≥0.1.5-rc.1: `submittedAttachments` (always pass an
   * empty array) and `signal` are both REQUIRED (the host reads `.length` /
   * `.aborted` unconditionally); the settled return is the
   * `{ commandId, result: { kind, text } }` wrapper (older hosts: flat). */
  commands?: { execute(agent: unknown, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<{ kind?: string; text?: string; result?: { kind?: string; text?: string } }> } | undefined
  /** Durable persistence for cold reads: the recorded preset at resume and
   * the /session list's per-item content previews; absent = config/default
   * fallback and preview-less list items. */
  sessionPersistence: SessionPersistenceLike | undefined
  workspaceRegistry: WorkspaceRegistryLike | undefined
  agentDefaultModel: AgentDefaultModelLike | undefined
  defaultModel: (() => ModelSelection | undefined) | undefined
  config: BridgeConfig & TraceBridgeConfig
  policy: AccessPolicyConfig
  /** W1/T5 health: the ALREADY-redacted plugin config snapshot (secrets
   * replaced by 已配置/未配置 — see health.redactSnapshot). Absent = the
   * /healthcheck diagnostics export renders without a config section. */
  configSnapshot?: (() => Record<string, unknown>) | undefined
  /** T15: 附件库根（宿主所有，`<dshHome>/attachments/v1`）；仅用于容量统计。 */
  attachmentsDir?: string | undefined
  /** T15: 宿主附件服务的**实时**取值器（`ctx.attachments`）。用函数而非快照：
   * 服务可能在插件挂载之后才就绪。缺省 = 视作宿主不支持，入站图片退回路径文本。 */
  attachments?: (() => unknown) | undefined
  /** Log line callback (level, message). */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
}

/**
 * Bridge between OneBot events and dsh agents. Create via the constructor and
 * call start() from the plugin's effect; call stop() on disposal.
 */
/**
 * S-02：受限用户（member 回合）可用的工具白名单 —— **默认拒绝**。
 *
 * 为什么用白名单而不是「拦住 write/bash」：宿主的写/执行类工具名由 bundle 动态
 * 注册（peer 包里查不到），黑名单漏一个名字就静默失效；而受限用户的语义本来
 * 就是「只能问问题」。注意「只读」也不等于安全 —— `Read` 能读
 * `napcat/NapCat.Shell/config/*.json`（含 accessToken），因此本地文件读取
 * （read/glob/grep 等）对 member 同样不放行。
 *
 * 放行项：
 * - `mcp__*`：MCP 已有独立白名单闸门（mcpToolAllow）；
 * - `qq_send_*` / `qq_group_history`：发送类，走媒体围栏与主动写闸门；
 * - `web_search` / `web_fetch`：外网只读检索；
 * - 交互卡与 todo：无文件/命令副作用。
 */
const MEMBER_ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'qq_send_image', 'qq_send_voice', 'qq_send_video', 'qq_send_file',
  'qq_send_forward', 'qq_send_meme', 'qq_group_history',
  // 频道记忆：三个都放行。note 写的是**本会话自己的**记忆（chat_id 跨会话仍限管理员），
  // 与已放行的 qq_send_file（能往群里发任意文件）相比风险更低；早期的「只让管理员写」
  // 一刀切会让记忆在群里完全失效。forget 的删除范围在 tools.ts 里按 by/subject 收窄
  // （成员只能删自己写的、或关于自己的画像），profile 的写入限制也同理。
  'qq_memory_recall', 'qq_memory_remember', 'qq_memory_forget',
  'web_search', 'web_fetch',
  'ask_user_question', 'exit_plan_mode', 'todo_write',
  // 只读浏览类（2026-10-24 补）：受限成员的边界是「能看不能改」，
  // 原先连 glob/grep/read 都拒，导致「列一下你能用的工具」这类纯只读请求
  // 也会触发工具被拒 —— 而宿主在拒绝后还会撞 "prepare" 空指针把整轮打挂。
  // 只读工具没有写盘/执行副作用，放进白名单既符合模型也不扩大攻击面。
  'glob', 'grep', 'read',
  'list_mcp_resources', 'list_mcp_resource_templates',
])

/** member 回合的工具拒绝理由；`undefined` = 放行。 */
function memberToolDenialReason(name: string): string | undefined {
  if (name === '') return '无法确定工具名，受限用户回合默认拒绝该调用'
  if (name.startsWith('mcp__')) return undefined
  if (MEMBER_ALLOWED_TOOL_NAMES.has(name)) return undefined
  return '当前是受限用户回合（非管理员）：只能问答、只读检索与发送消息，'
    + '工具「' + name + '」已被拒绝。需要读写文件或执行命令请让管理员来问。'
}

export class ChatBridge {
  private readonly deps: BridgeDeps
  /** Outbound pipeline (D1-PR2): the same-name bridge methods below delegate here. */
  private readonly outbound: OutboundPipeline
  /** The chat↔session registry (D1-PR3): chats/bySession dual index, the
   * persistence pair, per-chat settings and the create/resume assembly. */
  private readonly registry: ChatRegistry
  /** Inbound pipeline (D1-PR4): normalizeOneBot11 + the policy→media→quote→
   * dispatch path; the same-name bridge methods below delegate here. */
  private readonly inbound: InboundPipeline
  /** Interim domain (D1-PR5): the assistant/message interim routing, the
   * per-message recall timers and the turn/end settlement. */
  private readonly interim: InterimTracker
  /** T3 (P2): the deferred-delivery tracker (超时补发) — timeout timers, the
   * JSONL registry, bounded send retries and restart recovery. */
  private readonly deferred: DeferredDelivery
  /** T4 (P3): the bounded registry of recent fault references — every minted
   * QQ-CONN-/MF- number is recorded here for the /healthcheck report and the
   * diagnostics archive file name. */
  private readonly failureRefs = new FailureRefRegistry()
  /** Live registry indexes — the inbound/outbound/interim/turn links keep
   * reading them through these same-name views. */
  private get chats(): Map<ChatId, ChatAgent> { return this.registry.chats }
  private get bySession(): Map<string, ChatId> { return this.registry.bySession }
  private sessionEventOff: (() => void) | undefined
  private sessionFlushOff: (() => void) | undefined
  /** W1: chat-level traceId association table — session events arrive on a
   * different async chain than the inbound pipeline, so dispatchFollowup
   * records the initiating traceId per chat here and onSessionEvent reads it
   * back (agent 回复事件归属发起 traceId). Last dispatch wins; entries are
   * dropped when the chat is removed. Not cleared at turn/end: the interim
   * settle loop sends the final reply AFTER turn/end, and clearing there
   * would orphan exactly that reply's outbound events. One entry per chat
   * id (bounded by the chat population), so growth is not a concern. */
  private readonly traceByChat = new Map<ChatId, string>()
  /** W1/T5: chatId → the traceId of the chat's unsettled INJECTED round
   * (independent of the trace sink, so the dry-run guard covers the async
   * agent reply even with tracing off). Cleared by a real dispatch to the
   * chat or when the chat is removed. */
  private readonly injectRoundByChat = new Map<ChatId, string>()
  /** T2 (P1): chats that already got the QUEUE_NOTICE_TEXT for their current
   * running turn (one notice per turn; cleared at turn/end and on chat
   * removal — bounded by the chat population). */
  private readonly queueNoticeChats = new Set<ChatId>()
  /** Plugin version + git commit, read once for /ver. */
  private pluginVersion: string | undefined
  private pluginCommit: string | undefined
  private stopping = false
  /** T20：mcpToolAllow 的无效条目 warn 是否已打过。installChannelScope 在每次
   * create 与 resume 都会执行，一条写错的条目会随聊天数重复刷日志 —— 只报一次。 */
  private mcpAllowWarned = false

  constructor(deps: BridgeDeps) {
    this.deps = deps
    this.registry = new ChatRegistry({
      agents: deps.agents,
      sessions: deps.sessions,
      sessionPersistence: deps.sessionPersistence,
      workspaceRegistry: deps.workspaceRegistry,
      agentPresets: deps.agentPresets,
      defaultModel: deps.defaultModel,
      config: deps.config,
      log: (level, message) => deps.log(level, message),
      isStopping: () => this.stopping,
      onChatRemoved: chat => {
        this.stopTyping(chat)
        // W1/T5: forget the chat's injected round (and its trace mapping).
        this.deps.config.inject?.clearChat(chat.chatId)
        this.traceByChat.delete(chat.chatId)
        this.injectRoundByChat.delete(chat.chatId)
        this.queueNoticeChats.delete(chat.chatId)
      },
      installChannelScope: (agentCtx, chatId) => this.installChannelScope(agentCtx, chatId),
    })
    this.outbound = new OutboundPipeline({
      getChat: chatId => this.chats.get(chatId),
      connected: () => this.deps.connection.connected,
      selfId: () => this.deps.connection.selfId,
      call: (action, params, chatId) => this.guardedConnectionCall(action, params, chatId),
      isStopping: () => this.stopping,
      log: (level, message) => this.deps.log(level, message),
      config: deps.config,
      // W1: outbound decision events ride the chat's initiating traceId; a
      // write with no mapped trace (proactive tool sends) starts a fresh one.
      trace: (chatId, event) => {
        const sink = deps.config.trace
        if (sink === undefined || !sink.enabled) return
        const mapped = this.traceByChat.get(chatId)
        sink.emit({ traceId: mapped ?? newTraceId(sink.now()), chatId, ...event })
      },
    })
    this.inbound = new InboundPipeline({
      call: (action, params) => this.guardedConnectionCall(action, params),
      selfId: () => this.deps.connection.selfId,
      policy: deps.policy,
      getChat: chatId => this.chats.get(chatId),
      getSettings: chatId => this.registry.getSettings(chatId),
      sweepIdleChats: () => this.registry.sweepIdleChats(),
      media: deps.media,
      transcriber: deps.transcriber,
      steerTranscript: (chatId, text) => this.steerTranscript(chatId, text),
      tryHandleCommand: (chatId, text, userId, nickname) => this.tryHandleCommand(chatId, text, userId, nickname),
      buildBody: (text, media, chatId, images) => this.buildBody(text, media, chatId, images),
      expandQuote: messageId => this.expandQuote(messageId),
      dispatchFollowup: (chatId, text, role, nickname, images, userId) => this.dispatchFollowup(chatId, text, role, nickname, images, userId),
      deliverInboundImage: (path, chatId) => this.deliverInboundImage(path, chatId),
      interceptBusyTurn: (chatId, text, role, nickname, plain, images, userId) => this.interceptBusyTurn(chatId, text, role, nickname, plain, images, userId),
      sendToChat: (chatId, text) => this.sendToChat(chatId, text),
      log: (level, message) => this.deps.log(level, message),
      config: deps.config,
    })
    this.interim = new InterimTracker({
      sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, options),
      sendMsg: (chatId, segments, options) => this.sendMsg(chatId, segments, options),
      call: (action, params) => this.guardedConnectionCall(action, params),
      chainTail: chatId => this.outbound.chainTail(chatId),
      relayHostCards: (chatId, content) => this.relayHostCards(chatId, content),
      effectiveInterim: chatId => this.effectiveInterim(chatId),
      log: (level, message) => this.deps.log(level, message),
      config: deps.config,
    })
    this.deferred = new DeferredDelivery({
      sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, options),
      isTurnRunning: chatId => this.chats.get(chatId)?.agent.status === 'running',
      takePendingText: chatId => {
        const chat = this.chats.get(chatId)
        if (chat === undefined || chat.loopPending === null) return null
        const text = chat.loopPending
        chat.loopPending = null
        return text
      },
      traceIdFor: chatId => this.traceByChat.get(chatId),
      log: (level, message) => this.deps.log(level, message),
      trace: (chatId, event) => {
        const sink = deps.config.trace
        if (sink === undefined || !sink.enabled) return
        const mapped = this.traceByChat.get(chatId)
        sink.emit({ traceId: mapped ?? newTraceId(sink.now()), chatId, ...event })
      },
      mediaDir: deps.config.mediaDir,
      timeoutMs: deps.config.deferredTimeoutMs ?? DEFAULT_DEFERRED_TIMEOUT_MS,
      isStopping: () => this.stopping,
    })
  }

  /** Start listening: wire connection handlers and the session event feed. */
  start(): void {
    const { connection, ctx: sessionEvents } = this.deps
    connection.selfId = this.deps.config.botQQ
    this.sessionEventOff = sessionEvents.on('session/event', (session: Session, event: SessionEvent) => {
      this.onSessionEvent(session, event)
    })
    this.sessionFlushOff = sessionEvents.on('session/flush', (session: Session) => {
      void this.onSessionFlush(session)
    })
    connection.onStatus = (connected: boolean) => {
      this.deps.log(connected ? 'info' : 'warn', 'OneBot ' + (connected ? 'connected' : 'disconnected'))
      if (connected) this.outbound.drainPendingSends()
    }
    this.registry.mappingLoaded = this.ready().then(async () => {
      await this.registry.loadRetired()
      await this.registry.loadSwitchable()
      await this.registry.loadMapping()
      // T3 (P2): restore deferred-delivery tracking（未完结条目在该会话的
      // 下一次 turn/end 兑现；损坏行降级跳过）。
      await this.deferred.loadPersisted()
    }).then(() => {
      if (this.stopping) return
      this.deps.log('info', 'bridge ready (' + this.registry.chats.size + ' resumed chat(s))')
    })
  }

  /** Stop everything: dispose agents, save mapping, cancel timers. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.sessionEventOff !== undefined) {
      this.sessionEventOff()
      this.sessionEventOff = undefined
    }
    if (this.sessionFlushOff !== undefined) {
      this.sessionFlushOff()
      this.sessionFlushOff = undefined
    }
    // R-02：先把已排队的发送结算完，再拆 registry（热重启时 socket 随后关闭，
    // 在途消息若还挂在链上会全部变成 OneBotNotConnectedError）。
    await this.outbound.drain()
    await this.registry.stop()
    // T3 (P2): disarm the deferred silent-wait timers（pending 条目已落盘，
    // 重启后 loadPersisted 恢复跟踪续投）。
    this.deferred.stopAll()
  }

  /** Map an agent session id back to its chat (for model tools). */
  chatForSession(sessionId: string): ChatId | undefined {
    return this.bySession.get(sessionId)
  }

  /** 记忆目录（与 tools.ts 里 registerTools 用的同一处）。 */
  private memoryDir(): string {
    return join(this.deps.config.mediaDir, 'memory')
  }

  /**
   * `/memory`：本会话记忆统计 + 调用者**自己的**画像。
   *
   * 只算调用者可见的条目（`selectForRecall` 会滤掉过期与别人的画像），所以
   * 「公共 3 / 你的画像 2」这类数字不会泄露别人的画像条数。
   */
  private memoryReport(chatId: ChatId, userId: string): string {
    if (this.deps.config.memoryEnabled !== true) {
      return '⚠️ 频道记忆未启用（设置页「启用频道记忆」打开后可用）。'
    }
    const dir = this.memoryDir()
    const visible = selectForRecall(readAllMemories(dir, chatId), { speaker: userId })
    const notes = visible.filter((entry) => (entry.kind ?? 'note') === 'note')
    const profiles = visible.filter((entry) => entry.kind === 'profile')
    const lines = ['🧠 本会话记忆：' + visible.length + ' 条（公共 ' + notes.length + ' / 你的画像 ' + profiles.length + '）']
    if (profiles.length === 0) {
      lines.push('（还没有关于你的画像）')
      return lines.join('\n')
    }
    lines.push('')
    lines.push('关于你的画像（别人看不到）：')
    for (const entry of profiles.slice(-10)) {
      const day = entry.ts > 0 ? new Date(entry.ts).toISOString().slice(0, 10) : '时间未知'
      lines.push('- [' + day + '] ' + entry.text)
    }
    if (profiles.length > 10) lines.push('…（仅显示最近 10 条）')
    lines.push('')
    lines.push('发 /memory forget 可删除你自己的全部画像。')
    return lines.join('\n')
  }

  /** `/memory forget`：删掉调用者本人的全部画像（note 与别人的画像不受影响）。 */
  private memoryForget(chatId: ChatId, userId: string): string {
    if (this.deps.config.memoryEnabled !== true) {
      return '⚠️ 频道记忆未启用（设置页「启用频道记忆」打开后可用）。'
    }
    const removed = forgetProfiles(this.memoryDir(), chatId, userId)
    return removed > 0 ? '🧹 已删除关于你的 ' + removed + ' 条画像。' : '没有找到关于你的画像，无需删除。'
  }

  /** Whether a caller backing an agent session may perform file edits. QQ chats
   * require the currently running turn's initiator to be an admin (role frozen
   * from the dispatch queue at turn/start); non-QQ sessions (Web and other
   * channels) are trusted by default (A1 scoping). Unknown states fail closed
   * as member. */
  canEditFiles(sessionId: string): boolean {
    const chatId = this.bySession.get(sessionId)
    if (chatId === undefined) return true
    return this.chats.get(chatId)?.activeTurnRole === 'admin'
  }

  /**
   * 当前回合发起者的 QQ 号 —— 记忆工具用它定位「这话是谁说的」。
   *
   * 与 `activeTurnRole` 同源（turn/start 时从派发队列冻结），所以两者永远指向同一轮。
   * 返回 `undefined` 表示这轮不是插件派发的（宿主 Web 输入 / 重放），调用方应回落到
   * 别的判断（读会话事件）或要求显式 `subject`。
   */
  speakerFor(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) return undefined
    const chatId = this.bySession.get(sessionId)
    if (chatId === undefined) return undefined
    return this.chats.get(chatId)?.activeTurnUser
  }

  /**
   * Outbound media fence roots for one agent session's current turn (M1-A3b):
   * the plugin media dir always, plus the chat's workspace directory when the
   * running turn's initiator is an admin. The role reuses the M1-A2 turn-level
   * semantics (canEditFiles: frozen at turn/start, fail-closed member); a
   * session with no known chat stays mediaDir-only even though canEditFiles
   * would trust it — the media gate itself fails closed. Roots are
   * realpath-normalized here; the MediaStore fence re-checks containment
   * (the double check is harmless).
   */
  async mediaSendRoots(sessionId: string | undefined): Promise<{ roots: string[]; isTurnAdmin: boolean }> {
    const isTurnAdmin = sessionId !== undefined && this.canEditFiles(sessionId)
    const chatId = sessionId !== undefined ? this.bySession.get(sessionId) : undefined
    const candidates = [this.deps.config.mediaDir]
    if (chatId !== undefined && isTurnAdmin) candidates.push(this.effectiveCwd(chatId))
    const roots: string[] = []
    for (const root of candidates) {
      try {
        roots.push(await realpath(root))
      } catch {
        roots.push(root) // missing root: kept as-is; the fence skips it (cannot contain anything)
      }
    }
    return { roots, isTurnAdmin }
  }

  /** Whether the connection is usable for sends. */
  get connected(): boolean {
    return this.deps.connection.connected
  }

  /**
   * Send plain text to a chat with the full outbound pipeline (forward
   * blocks, Markdown strip, sentence splitting).
   * @param chatId - target chat.
   * @param text - model-produced text.
   * @param options - optional reply target.
   * @returns the sent message ids.
   */
  sendToChat(chatId: ChatId, text: string, options: SendOptions = {}): Promise<string[]> {
    return this.outbound.sendToChat(chatId, text, options)
  }

  /**
   * Send raw OneBot segments (used by the media tools).
   * @param chatId - target chat.
   * @param segments - outbound segments.
   * @returns the sent message id.
   */
  sendSegments(chatId: ChatId, segments: OutboundSegment[]): Promise<string | undefined> {
    return this.outbound.sendSegments(chatId, segments)
  }

  /**
   * Wait for the loader's complete application (model selection, settings,
   * persistence) before reading the default model — the same gate the
   * headless runner uses, so the pinned selection is never a half-loaded
   * default.
   */
  private async ready(): Promise<void> {
    await this.deps.hostReady?.()
  }

  // ------------------------------------------------------------ inbound

  /**
   * Inbound OneBot message event → agent turn. All policy and media work is
   * contained: a failure here logs and drops the message, never the host.
   * W1: the whole inbound chain runs inside one trace scope (ALS), so every
   * pipeline decision point can attribute its event to this message's
   * traceId; disabled = no scope, no id, 0.6.0 behavior. W1/T5: injected
   * events (opts.injected) run inside their inject round (ALS) so the
   * dry-run guard covers the whole synchronous chain, and real events are
   * recorded by the inbound recorder when recordInbound is on (injected
   * events are never recorded — no inject→record→replay feedback loop).
   */
  async handleInbound(event: OneBotEvent, opts: { injected?: boolean } = {}): Promise<void> {
    const run = (): Promise<void> => this.handleInboundOnce(event, opts.injected === true)
    return opts.injected === true
      ? runInjectRound({ traceId: newTraceId(), intercepted: 0 }, run)
      : run()
  }

  private async handleInboundOnce(event: OneBotEvent, injected: boolean): Promise<void> {
    // Recording: skipped for injected events (they would otherwise feed the
    // injector again through replay) and skipped when no recorder exists.
    const recorder = injected ? undefined : this.deps.config.recorder
    const session = recorder?.begin(event) ?? undefined
    const trace = this.beginInboundTrace(event)
    const scope = trace !== undefined
      ? (session !== undefined ? session.wrapScope(trace) : trace)
      : session?.captureScope()
    try {
      await runWithTrace(scope, async () => {
        if (this.stopping) {
          this.deps.log('debug', '插件停止中，入站消息丢弃')
          scope?.emit('inbound', { ok: false, reason: TRACE_REASONS.inboundStopping })
          return
        }
        const inbound = normalizeOneBot11(event)
        if (inbound === null) {
          this.deps.log('debug', '非聊天消息事件，不处理（post_type=' + String(event.post_type) + '）')
          scope?.emit('normalize', { ok: false, reason: TRACE_REASONS.inboundNotChat })
          return
        }
        await this.processInbound(inbound)
      })
    } catch (error) {
      scope?.emit('dispatch', { ok: false, reason: '入站处理失败: ' + describeError(error) })
      this.deps.log('error', 'inbound handling failed: ' + describeError(error) + errorStack(error))
    } finally {
      session?.end()
    }
  }

  /** W1: mint the inbound traceId + scope and record the first (收到消息)
   * event; undefined when tracing is off (zero overhead, zero difference).
   * W1/T5: an injected event REUSES its inject round's traceId, so the whole
   * injected round (pipeline decisions + intercepted outbound calls) shares
   * one traceId in the trace stream. */
  private beginInboundTrace(event: OneBotEvent): TraceScope | undefined {
    const sink = this.deps.config.trace
    if (sink === undefined || !sink.enabled) return undefined
    const kind = event.message_type === 'group' ? 'group' : event.message_type === 'private' ? 'private' : undefined
    const chatId = kind !== undefined
      ? buildChatId(kind, String(kind === 'group' ? event.group_id ?? '' : event.user_id ?? ''))
      : ''
    const messageId = event.message_id === undefined || event.message_id === null ? undefined : String(event.message_id)
    const traceId = currentInjectRound()?.traceId ?? newTraceId(sink.now())
    const scope = sink.scope(traceId, chatId, messageId)
    sink.emit({ traceId: scope.traceId, stage: 'inbound', ok: true, chatId, messageId, data: { messageType: String(event.message_type ?? '') } })
    return scope
  }

  private async processInbound(inbound: NormalizedInbound): Promise<void> {
    await this.inbound.processInbound(inbound)
  }

  /** Feed one user message into a chat's agent (create on demand). Records
   * the base text for /retry, queues the initiator's turn role + QQ, and
   * applies per-chat /goal + /plan prefixes.
   *
   * `userId` 与 `role` 一起入队（并行 FIFO）：记忆工具要靠它判断「这句话是谁说的」，
   * 只存单个字段会在忙时排队时串号（A 排队、B 又发一条 → 两者都读到 B）。 */
  private async dispatchFollowup(chatId: ChatId, text: string, role: UserRole, nickname?: string, images: ImageAttachmentRef[] = [], userId?: string): Promise<void> {
    const final = this.prefixTurn(chatId, text)
    const fallback = this.chats.get(chatId)?.lastNickname ?? ''
    const chat = await this.ensureChat(chatId, nickname ?? fallback)
    if (nickname !== undefined && nickname !== '') chat.lastNickname = nickname
    chat.lastFollowup = text
    chat.lastActivityAt = Date.now()
    // M3-D2a: a dispatched user turn starts a fresh interim cycle (the
    // inbound residue reset already cleared the loop fields directly).
    this.interim.onNewUserTurn(chat)
    // Queue this turn's initiator role; the host's turn/start freezes it as
    // the running turn's role (M1-A2). Push and followup happen synchronously,
    // so the role cannot interleave with another dispatch.
    chat.pendingTurnRoles.push(role)
    // 发起者 QQ 与角色同队列（同一个 FIFO 语义，防止忙时串号）。
    chat.pendingTurnUsers.push(userId)
    this.deps.log('info', 'followup from ' + chatId + ': ' + final.slice(0, 120))
    // T15：这条消息里已投递成功的图片按出现顺序跟在文本块后面（模型能看像素）。
    // 引用由调用方随消息传入（inbound pipeline 的局部数组），**不再**从 per-chat
    // settings 里取——那是共享可变状态，同 chat 并发入站会串图/丢图。
    const content: InboundContentBlock[] = [{ type: 'text', text: final }]
    for (const attachment of images) content.push({ type: 'image', attachment })
    // Plugin-originated user message: the session log attributes QQ inbound
    // messages to this plugin's own producer-owned source kind, keeping them
    // distinguishable from host/web UI inputs.
    chat.agent.followup(createUserMessage({
      content,
      source: { kind: 'plugin:dsh-onebot' },
    }))
    // W1 cross-stream join: the turn's session events arrive on a different
    // async chain, so record this dispatch's traceId per chat for
    // onSessionEvent to pick up (runs inside the inbound ALS scope — command
    // dispatches reach here through the same await chain).
    const trace = currentTrace()
    if (trace !== undefined) {
      this.traceByChat.set(chatId, trace.traceId)
      trace.emit('dispatch', { ok: true, reason: '消息已投递给模型' })
    }
    // W1/T5 inject bookkeeping: an injected dispatch registers its round for
    // this chat (the async reply stays attributable — INDEPENDENT of tracing,
    // so the dry-run guard also works with the trace sink off); a real
    // dispatch clears any leftover injected round so real users are never
    // collaterally intercepted by the dry-run guard.
    const injectedRound = currentInjectRound()
    if (injectedRound !== undefined) this.injectRoundByChat.set(chatId, injectedRound.traceId)
    else this.injectRoundByChat.delete(chatId)
    this.deps.config.inject?.noteDispatch(chatId)
    this.startTyping(chat)
  }

  /** Prepend per-chat context directives (/goal reminder) to a turn's user
   * text. Plan mode is host-owned now (/plan forwards to the host command),
   * so the agent's own plan-mode instruction section governs planning. */
  private prefixTurn(chatId: ChatId, text: string): string {
    let out = text
    const goal = this.registry.getSettings(chatId).goal
    if (goal !== undefined && goal.trim() !== '') {
      out = '【当前目标】' + goal + '\n' + out
    }
    return out.trim()
  }

  /** Per-chat outbound-mode override (/mode), falling back to the global config. */
  private effectiveInterim(chatId: ChatId): boolean {
    return this.registry.getSettings(chatId).interimOverride ?? this.deps.config.interimMessages
  }

  /** Tool calls whose host-plane UI has no QQ equivalent; relay them to the chat. */
  private relayHostCards(chatId: ChatId, content: readonly unknown[]): void {
    // S-10：计划书（exit_plan_mode 全文）与提问卡是给「发起者」看的。群聊里
    // 非管理员发起的回合把它整份发到群里，等于把内部计划/待确认选项暴露给
    // 所有人；私聊只有本人可见，保持原行为。
    const chat = this.chats.get(chatId)
    if (chatId.startsWith('group:') && chat?.activeTurnRole !== 'admin') {
      this.deps.log('debug', '跳过群聊非管理员回合的宿主卡片中继（chat=' + chatId + '）')
      return
    }
    relayCards(this.cardRelayCtx, chatId, content)
  }

  /** The CardRelayContext handed to the card relay (D1-PR2): the outbound
   * send path plus the bridge log — the only capabilities the relay touches. */
  private get cardRelayCtx(): CardRelayContext {
    return {
      sendToChat: (chatId, text) => this.sendToChat(chatId, text),
      log: (level, message) => this.deps.log(level, message),
    }
  }

  /**
   * Slash-command router. Commands are admin-only (the Hermes member
   * slash-command block) and are matched on the first word; a leading
   * @mention glued to the command (QQ group at + text) is stripped first.
   * A path like /tmp/x is never a command (command words are
   * /[A-Za-z][A-Za-z0-9_-]* only). Unknown commands return false so the
   * message reaches the model, matching the Hermes "fall through" behavior.
   * @param chatId - the chat the command arrived in.
   * @param text - parsed inbound text.
   * @param userId - sender QQ number.
   * @param nickname - sender display name (pre-sanitized; T9-A /steer boundary).
   * @returns true when the message was consumed by a command.
   */
  private tryHandleCommand(chatId: ChatId, text: string, userId: string, nickname?: string): Promise<boolean> {
    return routeCommand(this.commandCtx, chatId, text, userId, nickname)
  }

  /**
   * The CommandContext handed to the command table (D1-PR1): exposes exactly
   * the bridge capabilities the routed commands use, resolved live per
   * invocation (the llm catalog especially must stay a live service lookup).
   */
  private get commandCtx(): CommandContext {
    const bridge = this
    return {
      sendToChat: (chatId, text) => bridge.sendToChat(chatId, text),
      log: (level, message) => bridge.deps.log(level, message),
      isAdmin: userId => classifyUserRole(userId, bridge.deps.policy.adminUsers) === 'admin',
      getChat: chatId => bridge.chats.get(chatId),
      hasChat: chatId => bridge.chats.has(chatId),
      resetChat: chatId => bridge.resetChat(chatId),
      // commands 不传 images（void 跳过），userId 走第 6 参
      dispatchFollowup: (chatId, text, role, nickname, userId) => bridge.dispatchFollowup(chatId, text, role, nickname, undefined, userId),
      // T3 (P2): /stop 也显式终止该聊天的超时补发跟踪（其他聊天不受影响）。
      stopDeferredTracking: chatId => bridge.deferred.cancelChat(chatId),
      // T2 (P1): /steer — the bridge-owned steer core keeps the createUserMessage
      // source write point in bridge.ts (producer-owned kind, session-v4 guard).
      steerRunningTurn: (chatId, text) => bridge.steerMessage(chatId, text),
      effectiveCwd: chatId => bridge.effectiveCwd(chatId),
      sessionIdFromMapping: chatId => bridge.sessionIdFromMapping(chatId),
      resolvePresetId: chatId => bridge.resolvePresetId(chatId),
      // T3: /workspace persists with the chat mapping (debounced). When the
      // chat is not live, noteWorkspaceOverride snapshots it into the registry
      // so the flush actually reaches the mapping file instead of being
      // dropped by the chats/evictedChats-only rewrite.
      setChatWorkspacePath: (chatId, path) => {
        bridge.registry.getSettings(chatId).workspacePath = path
        bridge.registry.noteWorkspaceOverride(chatId)
        bridge.registry.saveMappingDebounced()
      },
      presetOverride: chatId => bridge.registry.getSettings(chatId).presetOverride,
      setPresetOverride: (chatId, id) => { bridge.registry.getSettings(chatId).presetOverride = id },
      hasPresetOverride: chatId => bridge.registry.getSettings(chatId).presetOverride !== undefined,
      interimOverride: chatId => bridge.registry.getSettings(chatId).interimOverride,
      // D4b: /mode and /goal persist with the chat mapping (debounced).
      setInterimOverride: (chatId, value) => { bridge.registry.getSettings(chatId).interimOverride = value; bridge.registry.saveMappingDebounced() },
      goal: chatId => bridge.registry.getSettings(chatId).goal,
      setGoal: (chatId, value) => { bridge.registry.getSettings(chatId).goal = value; bridge.registry.saveMappingDebounced() },
      deleteGoal: chatId => { bridge.registry.getSettings(chatId).goal = undefined; bridge.registry.saveMappingDebounced() },
      lastImagePath: chatId => bridge.registry.getSettings(chatId).lastImagePath,
      // R2: pending serial-number selection snapshot (lazy TTL lives in commands).
      pendingSelection: chatId => bridge.registry.getSettings(chatId).pendingSelection,
      setPendingSelection: (chatId, value) => { bridge.registry.getSettings(chatId).pendingSelection = value },
      // /session: the per-chat switchable history and the switch itself.
      switchableSessions: chatId => bridge.registry.switchableSessions(chatId),
      switchSession: (chatId, targetSessionId) => bridge.registry.switchSession(chatId, targetSessionId),
      // /session list previews: cold-read each retired session's first user
      // input through the persistence port (read handle, small prefix).
      sessionPersistence: bridge.deps.sessionPersistence,
      takePendingImageRef: chatId => {
        const settings = bridge.registry.getSettings(chatId)
        const ref = settings.pendingImageRef
        if (ref !== undefined) settings.pendingImageRef = undefined
        return ref
      },
      resolveMediaRef: (ref, chatId) => bridge.resolveMediaRef(ref, chatId),
      llmCatalog: bridge.deps.llmCatalog,
      workspaceRegistry: bridge.deps.workspaceRegistry,
      agentDefaultModel: bridge.deps.agentDefaultModel,
      agentPresets: bridge.deps.agentPresets,
      commands: bridge.deps.commands,
      connection: bridge.deps.connection,
      dshHome: bridge.deps.dshHome,
      // W1/T5: the healthcheck command renders/packs through the bridge.
      healthReport: () => bridge.buildHealthReport(),
      // T15: /storage renders the media/attachment snapshot through the bridge
      // (attach owns the fs walk; the command layer only forwards the text).
      storageReport: () => formatStorageStats(storageStats(
        bridge.deps.config.mediaDir,
        bridge.deps.attachmentsDir ?? '',
        resolveAttachPolicy({
          enabled: bridge.deps.config.attachInboundImages ?? true,
          maxImageBytes: bridge.deps.config.attachMaxImageBytes ?? 0,
          budgetBytes: bridge.deps.config.attachmentBudgetBytes ?? 0,
          retentionMs: bridge.deps.config.attachmentRetentionMs ?? 0,
          saveTimeoutMs: bridge.deps.config.attachmentSaveTimeoutMs ?? 0,
        }),
      )),
      // 频道记忆：/memory 与 /memory forget（后者对成员开放 —— 被记录的人要能自己删）。
      memoryReport: (chatId, userId) => bridge.memoryReport(chatId, userId),
      memoryForget: (chatId, userId) => bridge.memoryForget(chatId, userId),
      // T4 (P3): export takes an optional trigger reference (file-name stamp).
      exportDiagnostics: triggerRef => bridge.exportDiagnosticsPackage(triggerRef),
      // T4 (P3): command-plane failures (/retry) mint an MF- reference through
      // the bridge's single entry point (registry + trace + structured log).
      reportFailure: (chatId, stage, detail) => bridge.registerMessageFailure(chatId, stage, detail),
      config: { interimMessages: bridge.deps.config.interimMessages, maxImageBytes: bridge.deps.config.maxImageBytes, unknownCommand: bridge.deps.config.unknownCommand },
    }
  }

  /** Read the chat→session mapping file (for /id and /status when no live chat). */
  private async sessionIdFromMapping(chatId: ChatId): Promise<string | undefined> {
    return this.registry.sessionIdFromMapping(chatId)
  }

  /**
   * Build the message body text: placeholders become annotated local paths
   * (images/voices/videos) and voice files are transcribed when enabled.
   */
  private buildBody(text: string, media: MediaRef[], chatId: ChatId, images?: ImageAttachmentRef[]): Promise<string> {
    return this.inbound.buildBody(text, media, chatId, images)
  }

  /** Resolve one media ref to a text annotation with a local path. */
  private resolveMediaRef(ref: MediaRef, chatId: ChatId): Promise<string> {
    return this.inbound.resolveMediaRef(ref, chatId)
  }

  /** T15：把一张入站图片投递成宿主附件引用（inbound ctx.deliverInboundImage）。
   *
   * 三道闸门（单图大小 / 总预算 / 宿主能力）都在 `attach.deliverImage` 里，
   * 这里只负责把「运行时取到的服务」与「配置解析出的策略」接线过去。任何
   * 异常都吞掉并记 debug：视觉增强失败绝不能影响消息本身可达。 */
  private async deliverInboundImage(path: string, chatId: ChatId): Promise<ImageAttachmentRef | undefined> {
    const attachment = this.deps.attachments
    if (attachment === undefined) return undefined
    let host: unknown
    try {
      host = attachment()
    } catch {
      return undefined
    }
    const policy = resolveAttachPolicy({
      enabled: this.deps.config.attachInboundImages ?? true,
      maxImageBytes: this.deps.config.attachMaxImageBytes ?? 0,
      budgetBytes: this.deps.config.attachmentBudgetBytes ?? 0,
      retentionMs: this.deps.config.attachmentRetentionMs ?? 0,
      saveTimeoutMs: this.deps.config.attachmentSaveTimeoutMs ?? 0,
    })
    const result = await deliverImage(host, path, policy, this.deps.config.mediaDir)
    if (result.ref !== undefined) {
      if (result.dedupHit === true) {
        this.deps.log('debug', '入站图片命中去重（未重复占用空间）: ' + chatId)
      }
      return result.ref
    }
    if (result.skipped !== undefined && result.skipped !== 'disabled') {
      // R-08：带上 detail（宿主异常原文），否则 save-failed 无法区分超时/配额/权限。
      this.deps.log('debug', '入站图片未投递为图片块（' + result.skipped
        + (result.detail !== undefined ? ': ' + result.detail : '')
        + '），退回路径文本: ' + path)
    }
    return undefined
  }

  /** M3-D4c: steer a completed voice transcript into the chat's agent — the
   * running turn consumes it at its nearest step boundary; an idle agent
   * opens a turn. No live chat (dispatch dropped/never happened) drops it. */
  private steerTranscript(chatId: ChatId, text: string): void {
    if (this.steerMessage(chatId, transcriptLabel(text))) return
    this.deps.log('debug', 'voice transcript dropped (no live chat): ' + chatId)
    currentTrace()?.emit('dispatch', { ok: false, reason: TRACE_REASONS.transcriptNoChat })
  }

  /** T2 (P1): the single agent.steer write point — one createUserMessage with
   * the producer-owned source kind (the session-v4 guard counts the source
   * write points; this and dispatchFollowup are the only two). Shared by the
   * voice transcript path (steerTranscript), the 'steer' policy and /steer.
   * Returns false when the chat has no live agent (nothing was steered). */
  private steerMessage(chatId: ChatId, text: string): boolean {
    const chat = this.chats.get(chatId)
    if (chat === undefined) return false
    chat.agent.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-onebot' },
    }))
    return true
  }

  /**
   * T2 (P1): the busy-turn policy seam (inbound ctx.interceptBusyTurn).
   * Called for every non-command message AFTER all gates, only when deciding
   * what to do with it while the chat's task is running:
   * - no running turn → false (caller dispatches normally; the 0.8.1 path,
   *   byte-identical — also the path for newMessagePolicy缺省 idle traffic);
   * - 'steer' policy + plain text + non-restricted sender + autoSteerPolicy
   *   eligibility ('admin' 档缺省 = 仅管理员；'all' 档不限，T9-B 用户裁决
   *   2026-10-12) → the message is submitted into the running turn via the
   *   steerMessage kernel (consumed at the nearest step boundary, NO new turn)
   *   and a submit notice goes out;
   * - otherwise (queue policy default / media-quote-forward message /
   *   restricted group member / 不具备自动插话资格) → the 0.8.1 dispatch path
   *   (agent.followup queues it as the next turn: consumed after the current
   *   turn ends, in arrival order) plus the queue notice at most once per
   *   running turn.
   * The running check reads the agent's own lifecycle state — the same
   * authoritative signal /stop uses; chat.busy (turn/start..turn/end view)
   * can lag the host driver and is deliberately NOT consulted.
   */
  private async interceptBusyTurn(chatId: ChatId, text: string, role: UserRole, nickname: string | undefined, plain: boolean, images: ImageAttachmentRef[] = [], userId?: string): Promise<boolean> {
    const chat = this.chats.get(chatId)
    if (chat === undefined || chat.agent.status !== 'running') return false
    // The restricted-member soft limit ([受限用户:仅问答]) is never widened by
    // the steer policy: restricted senders' messages queue like everyone
    // else's media. The condition mirrors the RESTRICTED_PREFIX application
    // in the inbound pipeline (group + non-admin + restrictedMemberPrefix).
    const restricted = splitChatId(chatId).kind === 'group'
      && role !== 'admin' && this.deps.config.restrictedMemberPrefix
    // T9-B: auto-steer eligibility (user ruling 2026-10-12) — 'admin' (缺省)
    // = admins only; 'all' = anyone. Restricted members stay excluded under
    // both; /steer remains admin-only regardless of this knob; queue mode is
    // untouched.
    const autoSteerAllowed = (this.deps.config.autoSteerPolicy ?? 'admin') === 'all' || role === 'admin'
    if ((this.deps.config.newMessagePolicy ?? 'queue') === 'steer' && plain && !restricted && autoSteerAllowed) {
      this.steerMessage(chatId, text)
      currentTrace()?.emit('dispatch', { ok: true, reason: TRACE_REASONS.busyTurnSteered })
      this.sendToChat(chatId, STEER_ACCEPTED_NOTICE).catch((error: unknown) => {
        this.deps.log('debug', '插话提交提示发送失败: ' + describeError(error))
        currentTrace()?.emit('notice', { ok: false, reason: '插话提交提示发送失败: ' + describeError(error) })
      })
      return true
    }
    await this.dispatchFollowup(chatId, text, role, nickname, images, userId)
    currentTrace()?.emit('dispatch', { ok: true, reason: TRACE_REASONS.busyTurnQueued })
    if (!this.queueNoticeChats.has(chatId)) {
      this.queueNoticeChats.add(chatId)
      this.sendToChat(chatId, QUEUE_NOTICE_TEXT).catch((error: unknown) => {
        this.deps.log('debug', '排队提示发送失败: ' + describeError(error))
        currentTrace()?.emit('notice', { ok: false, reason: '排队提示发送失败: ' + describeError(error) })
      })
    }
    return true
  }

  /** Expand a quoted (reply) message into [引用] text via get_msg. */
  private expandQuote(messageId: string): Promise<string> {
    return this.inbound.expandQuote(messageId)
  }

  // ------------------------------------------------------------ outbound

  /** Send one message to a chat and return its message id. */
  private async sendMsg(chatId: ChatId, segments: OutboundSegment[], options: SendOptions): Promise<string | undefined> {
    return this.outbound.sendMsg(chatId, segments, options)
  }

  /** Send [[qq_forward]] nodes as a merged-forward message. */
  async sendForward(chatId: ChatId, nodes: Array<{ name: string; content: string }>): Promise<void> {
    return this.outbound.sendForward(chatId, nodes)
  }

  // ------------------------------------------------------------ inject dry-run guard

  /**
   * W1/T5: the single connection-call gate every bridge pipeline
   * (inbound/outbound/interim/typing) routes through. In inject dry-run
   * mode, WRITE actions of an injected round are intercepted at this
   * outbound action layer: counted, traced with the original text, resolved
   * with the marker message id — the real OneBot connection never sees them.
   * Attribution: (a) the synchronous chain via the inject round's ALS, (b)
   * the async agent reply via the chat→round association (injectRoundByChat,
   * independent of the trace sink), (c) recalls of already-intercepted sends
   * via the marker message id (a real OneBot id is never negative).
   */
  private guardedConnectionCall(action: string, params: Record<string, unknown>, chatId?: ChatId): Promise<unknown> {
    const inject = this.deps.config.inject
    if (inject === undefined || !inject.intercepting || !isWriteAction(action)) {
      return this.deps.connection.call(action, params)
    }
    const alsRound = currentInjectRound()
    if (alsRound !== undefined) return inject.intercept(alsRound, action, params)
    if (chatId !== undefined) {
      const round = inject.activeRoundFor(chatId)
      if (round !== undefined && this.injectRoundByChat.get(chatId) === round.traceId) {
        return inject.intercept(round, action, params)
      }
    }
    if ((params as { message_id?: unknown }).message_id === INTERCEPTED_MESSAGE_ID) {
      // Recall of an intercepted send (interim path has no chatId): count it
      // on the marker rule even without a resolvable round.
      return inject.intercept(undefined, action, params)
    }
    return this.deps.connection.call(action, params)
  }

  // ------------------------------------------------------------ health (W1/T5)

  /** The health deps the /healthcheck command renders from (resolved live). */
  private healthDeps(): HealthDeps {
    const conn = this.deps.connection as unknown as {
      reverseRetryAttempts?: number
      reconnectAttempts?: number
      selfHealing?: boolean
      config?: { mode?: string; host?: string; port?: number }
    }
    const transport = conn.config ?? {}
    const recorder = this.deps.config.recorder
    const inject = this.deps.config.inject
    return {
      mediaDir: this.deps.config.mediaDir,
      connection: { connected: this.deps.connection.connected, selfId: this.deps.connection.selfId },
      transport: { mode: String(transport.mode ?? '未知'), host: String(transport.host ?? ''), port: Number(transport.port ?? 0) },
      retryState: {
        reverseRetryAttempts: conn.reverseRetryAttempts,
        reconnectAttempts: conn.reconnectAttempts,
        selfHealing: conn.selfHealing,
      },
      dedup: {
        entries: this.inbound.dedupWindowEntries,
        // The W2-② window key rides as an optional intersection member.
        windowSeconds: (this.deps.config as { dedupWindowSeconds?: number }).dedupWindowSeconds ?? 300,
      },
      writeGate: this.outbound.writeGateStats(),
      ...(recorder !== undefined
        ? { recorder: { enabled: true, redact: recorder.redact, written: recorder.getStats().written } }
        : {}),
      ...(inject !== undefined
        ? {
            inject: {
              enabled: true, dryRun: inject.intercepting,
              consumed: inject.getStats().consumed, intercepted: inject.getStats().intercepted,
              skippedHistory: inject.getStats().skippedHistory,
            },
          }
        : {}),
      // S-08：真实 token 交给诊断包 scrub，让 fail-closed 断言（归档字节里
      // 不得含任何 secret）真正生效；空 token 不占位，避免 split('') 破坏文本。
      secrets: this.deps.config.accessToken !== undefined && this.deps.config.accessToken !== ''
        ? [this.deps.config.accessToken]
        : [],
      configSnapshot: this.deps.configSnapshot?.() ?? {},
      // T4 (P3): the recent fault references for the report section.
      failureRefs: () => this.failureRefs.recent(),
      log: (level, message) => this.deps.log(level, message),
    }
  }

  /** /healthcheck: render the health summary. */
  private async buildHealthReport(): Promise<string> {
    return healthReport(this.healthDeps())
  }

  /** /healthcheck export: pack the redacted diagnostics archive. T4 (P3): the
   * file name carries the trigger reference — the explicit command argument,
   * or the most recent recorded fault reference when omitted. */
  private async exportDiagnosticsPackage(triggerRef?: string): Promise<string> {
    const deps = this.healthDeps()
    return exportDiagnostics({ ...deps, triggerRef: triggerRef ?? this.failureRefs.recent(1)[0]?.ref })
  }

  // ------------------------------------------------------------ session events

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (this.stopping) return
    const chatId = this.bySession.get(session.id)
    if (chatId === undefined) {
      // pipeline-hooks.md #20: non-QQ sessions (web/host) ride this same bus;
      // keep the early exit visible at debug without emitting any trace.
      this.deps.log('debug', 'session 事件早退：无 chat 映射（session=' + session.id + ' type=' + String(event.type) + '）')
      return
    }
    const chat = this.chats.get(chatId)
    if (chat === undefined || chat.sessionId !== session.id) return
    const trace = this.traceForChat(chatId)
    if (event.type === 'turn/start') {
      trace?.emit('agent', { ok: true, reason: '模型回合开始' })
      // B8: a new turn begins — prune the previous turn's recalled-id
      // residue (see InterimTracker.onTurnStart for the safety analysis).
      this.interim.onTurnStart(chat)
      // Freeze the running turn's initiator role from the dispatch FIFO
      // (M1-A2): turns the plugin did not dispatch (host/web input) find an
      // empty queue and fail closed as member.
      chat.activeTurnRole = chat.pendingTurnRoles.shift() ?? 'member'
      // 发起者 QQ 与角色同批出队；空队列 = 宿主直接输入（Web/重放），没有 QQ 身份。
      chat.activeTurnUser = chat.pendingTurnUsers.shift()
      chat.lastActivityAt = Date.now()
      chat.busy = true
      // T3 (P2): arm the deferred silent-wait window for this turn（每次模型
      // 输出重置；turn/end 解除；deferredTimeoutMs<=0 时为 no-op）。
      this.deferred.onTurnStart(chatId, session.id)
      return
    }
    if (event.type === 'assistant/message') {
      // T3 (P2): a deferred-registered (timed-out) turn is muted — its text
      // messages are captured for the final补发 only（不插播 interim、不转
      // 审批/提问卡：超时后只补最终文字与终态通知）。
      if (this.deferred.onAssistantMessage(chatId, session.id, event.data.message)) return
      this.interim.onAssistantMessage(chatId, chat, event.data.message)
      return
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason
      // T4 (P3): a message-turn fault mints ONE MF- reference before any
      // consumer runs — the trace event (data.ref), the structured log line,
      // the ⚠️ notice tail and the deferred terminal text all carry the same
      // number. Normal (completed/cancelled) turns mint nothing.
      const errorRef = reason.kind === 'error'
        ? this.mintFailureRef('msg', 'agent', '模型回合出错: ' + reason.error.message, { chatId })
        : undefined
      // T3 (P2): complete a deferred entry（补发异步进行）；true = the turn was
      // under deferred tracking — the terminal-state notice rides the补发
      // path, so the normal error notice below is suppressed（同一故障不双发）.
      const deferredTracked = this.deferred.onTurnEnd(chatId, session.id, reason, errorRef)
      this.interim.onTurnEnd(chatId, chat)
      if (reason.kind === 'error') {
        // T4: the ok:false agent event is emitted by mintFailureRef (with
        // data.ref) — no second event for the same decision point.
      } else {
        trace?.emit('agent', { ok: true, reason: '模型回合结束（' + reason.kind + '）' })
      }
      if (reason.kind === 'error') {
        const message = reason.error.message
        // 基线语义保持：碰撞自愈原本挂在 sendErrorNotice 分支内；deferred
        // 回合的终态走补发通道，也必须自愈，故闸为 sendErrorNotice || deferredTracked。
        if ((this.deps.config.sendErrorNotice || deferredTracked)
          && /persisted log on disk that does not match this live session|id collision/i.test(message)) {
          void this.healSessionCollision(chatId)
        }
        if (!deferredTracked && this.deps.config.sendErrorNotice) {
          this.sendToChat(chatId, '⚠️ 运行出错：' + message + failureRefSuffix(errorRef), { queuable: true }).catch((error: unknown) => {
            // pipeline-hooks.md #21: the send failure used to be swallowed.
            this.deps.log('debug', '错误通知发送失败: ' + describeError(error))
            trace?.emit('notice', { ok: false, reason: TRACE_REASONS.noticeErrorSendFailed })
          })
        }
      }
      this.stopTyping(chat)
      chat.lastActivityAt = Date.now()
      chat.busy = false
      // T2 (P1): the turn that armed the queue notice is over — a later
      // running turn notifies again.
      this.queueNoticeChats.delete(chatId)
      this.deps.log('info', 'turn/end for ' + chatId + ': ' + event.data.reason.kind)
      // Durable: flush the session so a later restart can resume it.
      void this.deps.sessions.flush(chat.agent.session).catch((error: unknown) => {
        this.deps.log('warn', 'session flush failed: ' + String(error))
        trace?.emit('notice', { ok: false, reason: '会话落盘失败: ' + String(error) })
      })
      void this.saveMappingDebounced()
    }
  }

  /** W1: the trace scope for one chat's session events, resolved through the
   * chat-level association table; undefined when tracing is off or the chat
   * has no recorded dispatch (host-initiated turns stay untraced). */
  private traceForChat(chatId: ChatId): TraceScope | undefined {
    const sink = this.deps.config.trace
    if (sink === undefined || !sink.enabled) return undefined
    const traceId = this.traceByChat.get(chatId)
    return traceId !== undefined ? sink.scope(traceId, chatId) : undefined
  }

  // ------------------------------------------------------ failure references (W3/T4)

  /**
   * T4 (P3): the single fault-reference entry point. Mints one QQ-CONN-/MF-
   * number, records it in the bounded registry, emits the ok:false trace
   * event carrying `data.ref` (traceId = the chat's mapped id, or a fresh id
   * for chat-less connection faults), and writes the structured error log
   * line — every surface of the fault shares this one number. Called only on
   * fault events: normal traffic mints nothing (zero overhead).
   */
  private mintFailureRef(kind: FailureRefKind, stage: TraceStage, detail: string, opts: { chatId?: ChatId } = {}): string {
    const ref = this.failureRefs.mint(kind)
    const traceId = opts.chatId !== undefined ? this.traceByChat.get(opts.chatId) : undefined
    this.failureRefs.record({ ref, kind, ts: Date.now(), stage, detail, traceId })
    const sink = this.deps.config.trace
    if (sink !== undefined && sink.enabled) {
      sink.emit({
        traceId: traceId ?? newTraceId(sink.now()),
        chatId: opts.chatId,
        stage,
        ok: false,
        reason: detail,
        data: { ref, refKind: kind },
      })
    }
    this.deps.log('error', '故障参考号 ' + ref + ' [' + stage + ']: ' + detail)
    return ref
  }

  /** T4: connection-fault reference entry (wired from index.ts via
   * `connection.onFailure`); the returned reference is appended to the
   * transport's own log line. */
  registerConnectionFailure(stage: string, detail: string): string {
    return this.mintFailureRef('conn', 'connection', detail)
  }

  /** T4: message-fault reference entry for command-plane failures (e.g. the
   * /retry dispatch throw); the caller appends the returned reference to the
   * user-visible ⚠️ notice. */
  registerMessageFailure(chatId: ChatId, stage: TraceStage, detail: string): string {
    return this.mintFailureRef('msg', stage, detail, { chatId })
  }

  private async onSessionFlush(session: Session): Promise<void> {
    if (this.stopping) return
    const chatId = this.bySession.get(session.id)
    if (chatId === undefined) return
    // M1-E2: arbitrary session flushes debounce like turn/end — stop() still
    // forces the final saveMapping directly.
    this.saveMappingDebounced()
  }

  // ------------------------------------------------------------ registry facades

  /** Same-name delegations to the chat registry (D1-PR3): the command table's
   * ctx, the interim/turn event links and the outbound pipeline keep calling
   * the bridge exactly as before the split. */

  /** Get (or create) the agent for a chat. */
  private ensureChat(chatId: ChatId, nickname: string): Promise<ChatAgent> {
    return this.registry.ensureChat(chatId, nickname)
  }

  private effectiveCwd(chatId?: ChatId): string {
    return this.registry.effectiveCwd(chatId)
  }

  private resolvePresetId(chatId: ChatId): Promise<string | undefined> {
    return this.registry.resolvePresetId(chatId)
  }

  private saveMappingDebounced(): void {
    this.registry.saveMappingDebounced()
  }

  private healSessionCollision(chatId: ChatId): Promise<void> {
    return this.registry.healSessionCollision(chatId)
  }

  /**
   * /new: the registry disposes the agent and retires its session id so the
   * next inbound message creates a brand-new session (fresh history; the old
   * conversation stays on disk). The confirmation is sent directly through
   * the outbound pipeline since no agent is left to reply.
   */
  private async resetChat(chatId: ChatId): Promise<void> {
    await this.registry.resetChat(chatId)
    this.sendToChat(chatId, '✅ 已开启新会话，下一条消息将进入全新会话，旧对话历史保留在之前的会话中。').catch((error: unknown) => {
      this.deps.log('warn', 'reset notice send failed: ' + String(error))
    })
  }

  /**
   * Compose the QQ channel's scoped world for one agent: the QQ platform
   * prompt section, the qq_* tools, and the MCP tool gate.
   *
   * Everything here is registered on `agentCtx` (the agent's own scope) instead
   * of the plugin context, so Web/local sessions never see the channel
   * instructions or the media tools — they cannot (and should not) push
   * messages to QQ.
   */
  private installChannelScope(agentCtx: Context, chatId: string): void {
    agentCtx.systemPrompt.section({
      // section 名必须按 chat 唯一：宿主的作用域层会把同名 section 当作
      // 重复注册而抛错，第二个 agent（群聊／另一个私聊）就建不起来。
      name: `channel:dsh-onebot:${chatId}`,
      order: 90,
      text: buildPlatformPrompt(
        this.deps.config.restrictedMemberPrefix,
        this.deps.config.persona,
        // 记忆工具未启用时不提它们：否则模型会去调不存在的工具并报错。
        this.deps.config.memoryEnabled === true,
      ),
    })
    registerTools(agentCtx, this, this.deps.connection, {
      maxImageBytes: this.deps.config.maxImageBytes,
      maxVoiceBytes: this.deps.config.maxVoiceBytes,
      maxFileBytes: this.deps.config.maxFileBytes,
    }, {
      memeDir: this.deps.config.memeDir,
      mediaDir: this.deps.config.mediaDir,
      // 频道记忆（第一批）：目录放 mediaDir/memory（与附件、表情包同源，
      // 备份时一起带走）；未启用时不注册任何记忆工具。
      memory: {
        enabled: this.deps.config.memoryEnabled === true,
        dir: join(this.deps.config.mediaDir, 'memory'),
        maxEntriesPerChat: this.deps.config.memoryMaxEntriesPerChat ?? 200,
        recallTopK: this.deps.config.memoryRecallTopK ?? 5,
        profileScope: this.deps.config.memoryProfileScope ?? 'dm',
      },
    })
    // T20：MCP 工具闸门。profile 里的 MCP 服务器把工具注册在根作用域，作用域
    // 视图沿链向下继承 ⇒ 本 agent 会自动获得全部 MCP 工具（实测 dbx 的 25 个
    // 数据库工具在每一个 QQ 会话里都可见）。宿主的 tools.restrict() 只能过滤
    // 继承工具、要求工具名调用时已存在（MCP 异步连接，启动期写死会抛 unknown
    // tool），且拒绝空 filter（无法表达「空名单=全禁」），所以用调用期 guard：
    // 只接管 mcp__ 前缀，白名单外的调用一律拒绝并回可读原因。
    //
    // guard 缺失时显式抛错而不是跳过：跳过等于把 profile 里所有 MCP 工具原样
    // 交给群友，权限闸门静默失效比通道不可用危险得多。显式抛错能立刻暴露契约
    // 破裂（宿主升级改名、或测试桩漏实现）。
    const guard = agentCtx.tools.guard
    if (typeof guard !== 'function') {
      throw new Error('T20：agentCtx.tools.guard 不可用，无法安装 QQ 通道的 MCP 白名单闸门（拒绝降级为全开）')
    }
    const allow = this.deps.config.mcpToolAllow
    const dropped = describeDroppedEntries(allow)
    if (dropped.length > 0 && !this.mcpAllowWarned) {
      this.mcpAllowWarned = true
      // dropped 只含「原因 + 计数」，不含条目原文：这些条目来自设置页的多行
      // 文本框，管理员可能误把 token 或带凭据的串粘进来，而插件日志比 QQ 群
      // 更持久、更容易被翻出来（还会进 /doctor 的诊断包）。
      this.deps.log('warn', 'mcpToolAllow 有 ' + dropped.join('、') + ' 已被忽略。仅支持 * 与 mcp__<server>__* 两种通配，其它含 * 的写法会被忽略；条目原文不打印，请在设置页「权限」组核对')
    }
    guard.call(agentCtx.tools, makeMcpToolGuard(allow))
    // S-02：受限用户回合的工具闸门。角色按回合冻结在 activeTurnRole（turn/start
    // 时从派发队列取），所以必须在 guard 内部**实时**判定 —— 注册时写死会让第一个
    // admin 回合之后永久放行（或反过来）。取不到会话时按 member 处理（fail-closed）。
    guard.call(agentCtx.tools, (exec: unknown) => {
      const e = exec as { name?: unknown; agent?: { session?: { id?: unknown } } } | null
      const name = typeof e?.name === 'string' ? e.name : ''
      const rawId = e?.agent?.session?.id
      const sessionId = typeof rawId === 'string' ? rawId : undefined
      // canEditFiles 对「查不到 chat 映射」的 session 返回 true（非 QQ 会话默认
      // 信任），所以必须先要求它确实映射到一个 QQ chat，否则未知上下文会被当成
      // 管理员放行 —— 这个闸门本身就会 fail-open。
      const chatId = sessionId !== undefined ? this.chatForSession(sessionId) : undefined
      if (chatId !== undefined && sessionId !== undefined && this.canEditFiles(sessionId)) return undefined
      return memberToolDenialReason(name)
    })
  }

  // ------------------------------------------------------------ typing

  /** Start the NapCat typing indicator (private chats only). */
  private startTyping(chat: ChatAgent): void {
    const ref = splitChatId(chat.chatId)
    if (ref.kind !== 'private') return
    this.stopTyping(chat)
    const pulse = (): void => {
      if (this.stopping) return
      void this.guardedConnectionCall('set_input_status', {
        user_id: Number(ref.target),
        event_type: 1,
      }, chat.chatId).catch(() => undefined)
    }
    pulse()
    chat.typingTimer = setInterval(pulse, 5_000).unref()
  }

  /** Stop the typing indicator. */
  private stopTyping(chat: ChatAgent): void {
    if (chat.typingTimer !== undefined) {
      clearInterval(chat.typingTimer)
      chat.typingTimer = undefined
    }
    const ref = splitChatId(chat.chatId)
    if (ref.kind !== 'private') return
    void this.guardedConnectionCall('set_input_status', {
      user_id: Number(ref.target),
      event_type: 0,
    }, chat.chatId).catch(() => undefined)
  }
}

export { OneBotNotConnectedError, OneBotActionError } from './connection.js'
