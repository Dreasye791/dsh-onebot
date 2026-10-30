/**
 * dsh-onebot — `onebotSettings` Typert Remote service（T3 · T1 定案 B 路径）
 *
 * Host-plane root service declared in cordis.patch.yml（仓库模板同名文件）via an
 * independent insert row (`- id: onebot-settings-remote / name:
 * <DEPLOY_DIR>/lib/settings-remote.js`)，so the api-gateway discovers the
 * `onebotSettings` Remote namespace and the settings page client（T4,
 * lib/client.js）can read/write the dsh-onebot entry's config override row.
 * 契约唯一来源：docs/settings-page-design.md（T1 定案）§2 / §3 / §3.1 / §4。
 *
 * Contract — namespace `onebotSettings`，每方法一个 descriptor，全 positional
 * （宿主网关按 descriptor 位置序调用，methodParameterNames 拒绝解构/默认值/
 * rest，dsh-api-gateway/lib/index.js:1458-1495）：
 *
 *   getSettings()                            → OnebotSettingsSnapshot
 *   updateSettings(patch, expectedRevision)  → OnebotSettingsSnapshot
 *   listWorkspaces()                         → WorkspaceListResult（W7：只读查询宿主
 *     dsh-workspace 注册表，供设置页「快速填入 workspace」；registry 缺席/list()
 *     失败一律降级为 {available:false, workspaces:[]}，不抛错——辅助查询绝不
 *     阻塞 getSettings/updateSettings 主链路，也绝不打开 registry 内部态）
 *
 * 持久层 = profile patch 中 `dsh-onebot` 条目的 config 覆盖行（T1 §3——设置页
 * /手改 patch/宿主原生设置页三方同源，无第二优先级）。写入经宿主
 * configEditor.edit（dsh-config-editor/lib/index.js:63-123：文件锁 + 原子写 +
 * reconcile 热生效 + 激活失败自动回滚），本模块不发明第二条写路径。
 *
 * revision 语义（T1 §3.1，对齐宿主 SettingsForms）：
 * - 每宿主进程、每服务实例一个内存计数器，从 0 开始，不持久化；
 * - 读侧每次调用将 entry.options.config 序列化为指纹与上次比较，任何来源的
 *   已提交变更都 +1（本 Remote / 宿主原生设置页 / HMR 后的手改 patch）；
 * - updateSettings 的 expectedRevision ≠ 当前值 → 拒写，抛
 *   RemoteError('onebot-settings/conflict', {expected, actual})；undefined =
 *   无条件写（对齐宿主 settingsController 的 expectedRevision 语义，
 *   dsh-api-settings-controller/lib/index.js:404）；
 * - 不递增：写入被拒（校验失败 / 锁冲突 / 激活失败回滚）、no-op（合并结果与
 *   当前生效 config 全等，跳过 edit）。
 *
 * 敏感字段：accessToken 快照返回侧脱敏——snapshot.config.accessToken 恒为
 * ''，明文是否已配置由 snapshot.secrets 标记（T1 §3 敏感字段行；写入侧在
 * patch 文件明文落盘是宿主既有管道默认行为，加密存储范围外）。
 *
 * @deepseek-ai/dsh-typert-protocol 不可解析时（裸 dev checkout；装好的 profile
 * 内可解析）降级为普通 cordis 服务而非炸掉插件加载（照抄
 * dsh-expert-orchestrator/lib/remote.js 的降级骨架）。
 */

import { dirname, isAbsolute, join } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { diagnoseNapcat, formatDiagnosis } from './napcat-diagnose.js'

import type { Context } from '@deepseek-ai/cordis'

/** 宿主 dsh-workspace 注册表（src/bridge.ts:152 已有结构面；本模块只读消费
 *  list()，不打开 registry 内部态——import type 零运行时依赖，不改 bridge.ts）。 */
import type { WorkspaceRegistryLike } from './bridge.js'
import { MCP_ALLOW_ITEM_MAX_LEN, MCP_ALLOW_MAX_ENTRIES } from './mcp-gate.js'
import { deleteMemory, findSensitive, isExpired, listMemoryFiles, readAllMemories, searchMemories, trimMemories, updateMemory, upsertMemory } from './memory.js'
import { memoryDirFor } from './paths.js'

/** patch insert 中 dsh-onebot 主条目的 id（T1 §2/§3：唯一持久层条目）。 */
export const ENTRY_ID = 'dsh-onebot'
/** Typert Remote 命名空间 = cordis 服务键（T1 §4）。 */
export const NAMESPACE = 'onebotSettings'
/** 快照固定值：38 键均为插件级热重启生效（T1 §5；W1/W2 新增 6 布尔键同粒度）。 */
export const REMOTE_EFFECT = 'restart'

/** 设置页 UI 四组 38 键（T1 §4 + T9 autoSteerPolicy + T3 deferredTimeoutMs + T10 reasoningEffort + T11 persona；与 src/index.ts Config schema 一一对应）。
 *  W6：permissions/behavior 三组 19 键保持不动，W1/W2 的 6 个布尔键独立成
 *  「diagnostics（诊断）」组——它们全部默认关（除 actionAuditEnabled 默认开）、
 *  属观测/调试面，与连接权限行为组的使用频率与风险等级都不同，独立分组让
 *  「默认全关的调试开关」一眼可辨（对齐竞品 v0.6.0 面板的开关分组话术）。
 *  W7：connection 组追加 workspacePath（会话默认工作区；schema 已有该键
 *  src/index.ts:287，本批次起入面板白名单，键序追加在组尾）。
 *  T12：connection 组追加 memeDir（表情包目录；schema 已有该键 src/index.ts:318，
 *  本批次起入面板白名单，键序追加在组尾。留空 = 不注册 qq_send_meme 工具；
 *  T16 起要求它位于 mediaDir 之内且不等于 mediaDir，否则注册期即跳过）。
 *  T15：connection 组追加 attachInboundImages / attachMaxImageMB / attachmentBudgetMB
 *  三键（入站图片投递与附件库容量）。面板里 MB 是**展示单位**，schema 侧换算成字节。
 *  T18：再追加 attachmentRetentionHours / attachmentSaveTimeoutMs（账本回收窗口
 *  与宿主写盘超时），解决「软上限用满后永久拒收」和「临界区被卡死的写盘堵住」。
 *  T20：permissions 组追加 mcpToolAllow（QQ 通道 MCP 工具白名单；空 = 全禁）。 */
export const SETTINGS_GROUPS: Readonly<Record<string, readonly string[]>> = {
  connection: ['mode', 'host', 'port', 'url', 'accessToken', 'botQQ', 'workspacePath', 'memeDir', 'attachInboundImages', 'attachMaxImageMB', 'attachmentBudgetMB', 'attachmentRetentionHours', 'attachmentSaveTimeoutMs',
    // 本地补丁：NapCat 看护三项。此前只在 ALL_KEYS 里（服务端可读可写），但没进分组
    // 与客户端 GROUPS —— 结果「设置页看不到输入框」，同时让 ALL_KEYS(40) 与
    // SETTINGS_GROUPS(38) 漂移，tests/client-settings.spec.ts 有 4 条断言长期红。
    'napcatLauncher', 'napcatLauncherArgs', 'autoStartNapcat'],
  permissions: ['requireMention', 'adminUsers', 'dmPolicy', 'groupPolicy', 'allowAllUsers', 'allowFrom', 'groupAllowFrom', 'mcpToolAllow'],
  behavior: ['interimMessages', 'interimRecall', 'interimRecallMs', 'sendErrorNotice', 'unknownCommand', 'rateLimitPerMinute', 'newMessagePolicy', 'autoSteerPolicy', 'deferredTimeoutMs', 'reasoningEffort', 'persona',
    // 频道记忆：开关、两个上限、画像范围。关闭时不注册任何记忆工具。
    'memoryEnabled', 'memoryMaxEntriesPerChat', 'memoryRecallTopK', 'memoryProfileScope',
    // 第二批：语义召回（off/local/http + 模型/端点/key + 混合权重）。
    'memoryEmbeddingMode', 'memoryEmbeddingModel', 'memoryEmbeddingUrl', 'memoryEmbeddingKey', 'memorySemanticWeight'],
  diagnostics: ['actionAuditEnabled', 'traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun'],
}

/** schema 默认值（T1 §4 表；摘自 src/index.ts:171-245），快照生效值的底层。 */
export const SCHEMA_DEFAULTS: Readonly<Record<string, unknown>> = {
  mode: 'reverse',
  host: '127.0.0.1',
  port: 8643,
  url: 'ws://127.0.0.1:3001',
  accessToken: '',
  botQQ: '',
  // W7：会话默认工作区路径（schema 默认 ''，src/index.ts:287——留空 = 宿主进程 cwd）。
  workspacePath: '',
  // T12：表情包目录（schema 默认 ''，src/index.ts:318——留空 = 不注册 qq_send_meme）。
  memeDir: '',
  // 本地补丁：NapCat 看护（schema 默认 ''/[]/false；配置后设置页才能诊断与展示二维码）。
  napcatLauncher: '',
  napcatLauncherArgs: [],
  autoStartNapcat: false,
  // 频道记忆：默认关闭；上限与画像范围均与 src/index.ts schema 默认值一致。
  memoryEnabled: false,
  memoryMaxEntriesPerChat: 200,
  memoryRecallTopK: 5,
  memoryProfileScope: 'dm',
  // 频道记忆（第二批）：默认关闭语义召回 —— 与 src/index.ts 的 schema 默认值一致。
  memoryEmbeddingMode: 'off',
  memoryEmbeddingModel: '',
  memoryEmbeddingUrl: '',
  memoryEmbeddingKey: '',
  memorySemanticWeight: 0.6,
  // T15：入站图片投递（schema 默认 true / 10 / 500 / 0 / 15000，src/index.ts T15 五键）。
  attachInboundImages: true,
  attachMaxImageMB: 10,
  attachmentBudgetMB: 500,
  attachmentRetentionHours: 0,
  attachmentSaveTimeoutMs: 15000,
  requireMention: true,
  adminUsers: [],
  // T20：MCP 工具白名单（schema 默认 [] = QQ 通道禁用全部 MCP 工具）。
  mcpToolAllow: [],
  dmPolicy: 'open',
  groupPolicy: 'open',
  allowAllUsers: false,
  allowFrom: [],
  groupAllowFrom: [],
  interimMessages: true,
  interimRecall: true,
  interimRecallMs: 90_000,
  sendErrorNotice: true,
  unknownCommand: 'intercept',
  rateLimitPerMinute: 30,
  // T2 (P1)：任务运行中的新消息处理策略（queue=排队默认；steer=插话）。
  newMessagePolicy: 'queue',
  // T9-B (用户裁决 2026-10-12)：自动插话资格档位（admin=仅管理员默认；all=不限）。
  autoSteerPolicy: 'admin',
  // T3 (P2)：等待模型回复超时阈值（毫秒；0=关闭超时补发）。
  deferredTimeoutMs: 600_000,
  // 思考强度覆盖（src/index.ts:310 默认 ''=继承宿主 agent-default-model）。
  reasoningEffort: '',
  // T11：角色设定（人设）文本（src/index.ts default '' = 不注入人设层）。
  persona: '',
  // W6：W1/W2 可观测/调试布尔键（schema 默认值摘自 src/index.ts:297-317）。
  actionAuditEnabled: true,
  traceEnabled: false,
  recordInbound: false,
  inboxRedact: true,
  injectEnabled: false,
  injectDryRun: true,
}

/** 快照返回侧脱敏的键（T1 §3 敏感字段行；写入侧明文落盘属宿主既有行为）。 */
export const SECRET_KEYS: readonly string[] = ['accessToken']

/**
 * 只做「快照脱敏」、不进 `SECRET_KEYS` 的键。
 *
 * 为什么单独一组：客户端的 secret 编辑态是**单例**（`secretDraft` / `clearSecret` 各
 * 一个 state），整套「留空=不修改 / 勾选清除 / 已配置徽标」只为 accessToken 设计。
 * 把 embedding key 也标成 `type: 'secret'` 会让两个字段共写同一份草稿 —— 填一个，
 * 另一个被清空。所以它走普通输入框，但**快照里同样不回显**（安全不打折），
 * 代价只是界面上看不到「是否已配置」的徽标。
 */
export const REDACTED_ONLY_KEYS: readonly string[] = ['memoryEmbeddingKey']

const ENUM_KEYS: Readonly<Record<string, readonly string[]>> = {
  mode: ['reverse', 'forward'],
  dmPolicy: ['open', 'allowlist', 'disabled'],
  groupPolicy: ['open', 'allowlist', 'disabled'],
  unknownCommand: ['intercept', 'passthrough'],
  // T2 (P1)：queue=排队（默认）；steer=插话进运行中任务。
  newMessagePolicy: ['queue', 'steer'],
  // T9-B (用户裁决 2026-10-12)：admin=仅管理员（默认）；all=不限。
  autoSteerPolicy: ['admin', 'all'],
  // 思考强度覆盖：''=继承宿主 agent-default-model（默认）；其余档位只影响 QQ 通道。
  // 值是 pi-ai 的档位名，关闭思考写作 off（不是 none——none 只是上游 wire 拼写）。
  reasoningEffort: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  // 频道记忆：成员画像能在哪写。dm=仅私聊（默认）；all=群聊也允许（需管理员显式 subject）；off=关闭。
  memoryProfileScope: ['dm', 'all', 'off'],
  // 频道记忆（第二批）：语义编码器来源。off=纯关键词（默认）；local=进程内；http=外部端点。
  memoryEmbeddingMode: ['off', 'local', 'http'],
}
const NUMBER_KEYS: readonly string[] = ['port', 'interimRecallMs', 'rateLimitPerMinute', 'deferredTimeoutMs', 'attachMaxImageMB', 'attachmentBudgetMB', 'attachmentRetentionHours', 'attachmentSaveTimeoutMs',
  // 频道记忆（第一批）：单会话条数上限与召回条数。
  'memoryMaxEntriesPerChat', 'memoryRecallTopK',
  // 频道记忆（第二批）：混合召回的语义权重。
  'memorySemanticWeight']
/** 数字键取值范围（评审 B4：port 1–65535、时长/频控 ≥0；越界在 Remote 层拒绝，不再只依赖宿主回滚兜底）。 */
const NUMBER_RANGE: Readonly<Record<string, readonly [number, number | undefined]>> = {
  port: [1, 65535],
  interimRecallMs: [0, undefined],
  rateLimitPerMinute: [0, undefined],
  deferredTimeoutMs: [0, undefined],
  // T15：MB 单位上限；0 表示「不限」，因此下限是 0 而不是 1。
  attachMaxImageMB: [0, 1024],
  attachmentBudgetMB: [0, 1024 * 1024],
  // T18：回收窗口按小时（0=不回收），上限一年；超时按毫秒（0=不超时），
  // 上限 10 分钟——再长就等于没超时了，这闸门存在的意义是别让临界区卡死。
  attachmentRetentionHours: [0, 8760],
  attachmentSaveTimeoutMs: [0, 600_000],
  // 频道记忆：与 schema 的 1..5000 / 1..20 对齐（0 条/0 召回没有意义，下限 1）。
  memoryMaxEntriesPerChat: [1, 5000],
  memoryRecallTopK: [1, 20],
  // 频道记忆（第二批）：0=纯关键词，1=纯语义。
  memorySemanticWeight: [0, 1],
}
/** 布尔键白名单（T1 §4 + W6 扩展：W1/W2 观测/调试 6 键入列；顺序与
 *  SETTINGS_GROUPS.diagnostics 一致。数值键 dedupWindowSeconds/actionRatePerMinute/
 *  actionRatePerDay/injectIntervalMs 与枚举键 traceLevel 本期不入 UI 白名单——
 *  面板仅布尔开关与既有 19 键，调优键仍走 patch config 手改，取舍见 DEVLOG W6）。 */
const BOOLEAN_KEYS: readonly string[] = [
  'requireMention', 'allowAllUsers', 'interimMessages', 'interimRecall', 'sendErrorNotice', 'attachInboundImages',
  'actionAuditEnabled', 'traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun',
  // 本地补丁：NapCat 看护开关（是否允许未连接时自动拉起）
  'autoStartNapcat',
  // 频道记忆（第一批）总开关：关时两个记忆工具都不注册
  'memoryEnabled',
]
const STRING_KEYS: readonly string[] = [
  'host', 'url', 'accessToken', 'botQQ', 'workspacePath', 'persona', 'memeDir',
  // 本地补丁：NapCat 启动器路径（诊断据此推导 NapCat.Shell 目录）
  'napcatLauncher',
  // 频道记忆（第二批）：模型目录/模型名、端点、Bearer（key 在 SECRET_KEYS 里脱敏）。
  'memoryEmbeddingModel', 'memoryEmbeddingUrl', 'memoryEmbeddingKey',
]
/** 字符串键长度上限（T11：与 client patchSchema `vString(0, 20000)` 同宽，
 *  防止仅经 Remote 直连的调用方绕过面板写入无界大文本进 patch）。
 *  未列出的字符串键不设上限（保持 T1 既有行为）。 */
const STRING_MAX_LEN: Readonly<Record<string, number>> = { persona: 20000 }
const STRING_ARRAY_KEYS: readonly string[] = ['adminUsers', 'allowFrom', 'groupAllowFrom', 'mcpToolAllow',
  // 本地补丁：NapCat 拉起参数（如 ['-q', '<QQ号>']）；逐条按字符串校验。
  'napcatLauncherArgs']
/** 字符串数组键的单项长度上限（T20：与 client patchSchema `vString(0, 128)` 同宽）。
 *  未列出的数组键不设上限（保持 T1 既有行为）。 */
const STRING_ARRAY_ITEM_MAX_LEN: Readonly<Record<string, number>> = { mcpToolAllow: MCP_ALLOW_ITEM_MAX_LEN }
/** 字符串数组键的条目数上限（T20：防止 patch 里塞进无界的白名单）。 */
const STRING_ARRAY_MAX_ITEMS: Readonly<Record<string, number>> = { mcpToolAllow: MCP_ALLOW_MAX_ENTRIES }
/** 全部 45 键（校验与快照的唯一键集；8 枚举 + 10 数字 + 14 布尔 + 8 字符串 + 5 字符串数组）。 */
export const ALL_KEYS: readonly string[] = [
  ...Object.keys(ENUM_KEYS), ...NUMBER_KEYS, ...BOOLEAN_KEYS, ...STRING_KEYS, ...STRING_ARRAY_KEYS,
]

/** OnebotSettingsSnapshot（T1 §3 快照结构）。 */
export interface OnebotSettingsSnapshot {
  /** §3.1 乐观锁计数器。 */
  revision: number
  /** dsh-onebot 条目 fiber 是否 active（fiber.state === 2，同 configEditor.edit 的活性判据）。 */
  entryActive: boolean
  /** 38 键生效值；accessToken 脱敏为 ''。 */
  config: Record<string, unknown>
  /** 脱敏键标记：明文是否已配置。 */
  secrets: Array<{ path: string[]; set: boolean }>
  groups: Record<string, string[]>
  effect: typeof REMOTE_EFFECT
  /** NapCat 诊断（本地补丁，只读）；未配置 launcher 时为 unconfigured */
  napcat: NapcatStatusResult
}

/** §3.1 revision 计数器状态（内存态，随宿主进程/服务实例存续）。 */
export interface RevisionState {
  revision: number
  /** 上次观察到的 entry.options.config 序列化指纹；null = 尚未建立基线。 */
  fingerprint: string | null
}

/** configEditor（dsh-config-editor）本模块实际消费的最小面。 */
export interface ConfigEditorEntry {
  options: { id?: string; name?: string; config?: Record<string, unknown> }
  fiber?: { state?: number } | undefined
}
export interface ConfigEditorLike {
  entries(): readonly ConfigEditorEntry[]
  edit(entry: ConfigEditorEntry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

interface RemoteErrorLike extends Error {
  code: string
  details?: unknown
  isDSHRemoteError?: boolean
}
type RemoteErrorCtor = new (code: string, message: string, details?: unknown, options?: ErrorOptions) => RemoteErrorLike

/** typert-protocol 不可解析时的降级错误：结构对齐 RemoteError（code/details/
 *  isDSHRemoteError 标记），保证失败路径语义一致。 */
class FallbackRemoteError extends Error implements RemoteErrorLike {
  code: string
  details?: unknown
  isDSHRemoteError = true
  constructor(code: string, message: string, details?: unknown, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.details = details
    this.name = 'RemoteError'
  }
}

let protocol: typeof import('@deepseek-ai/dsh-typert-protocol') | null = null
try {
  protocol = await import('@deepseek-ai/dsh-typert-protocol')
} catch {
  protocol = null
}
/** RemoteError 统一出口：协议在位用宿主类（跨域识别按 isDSHRemoteError），否则降级类。
 *  宿主类对 code 有 RemoteErrorDetailsMap 泛型约束（类型层），本服务使用自有
 *  onebot-settings/* 错误码（运行期任意字符串均可，网关原样透传），故统一收窄为
 *  本模块的宽松构造签名。 */
const RemoteError = (protocol?.RemoteError ?? FallbackRemoteError) as unknown as RemoteErrorCtor

/** 乐观锁/降级以外唯一会抛的宿主依赖缺失情形：configEditor 不在位。 */
function requireConfigEditor(ctx: { get(key: string): unknown } | undefined): ConfigEditorLike {
  const editor = ctx?.get?.('configEditor') as ConfigEditorLike | undefined
  if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
    throw new RemoteError(
      'onebot-settings/no-config-editor',
      'configEditor service is unavailable: the onebot-settings-remote row must mount beside the host bundle\'s dsh-config-editor',
      { entryId: ENTRY_ID },
    )
  }
  return editor
}

/** 在 profile patch 的可寻址条目中定位 dsh-onebot 主条目；不存在必须显式报错
 *  （T1 §2：条目不存在时返回明确错误，不得静默）。 */
function findEntry(editor: ConfigEditorLike): ConfigEditorEntry {
  const entry = editor.entries().find((candidate) => candidate?.options?.id === ENTRY_ID)
  if (!entry) {
    throw new RemoteError(
      'onebot-settings/no-entry',
      `no active "${ENTRY_ID}" entry in the profile patch — mount dsh-onebot first`,
      { entryId: ENTRY_ID },
    )
  }
  return entry
}

/** T1 §2/§5：条目 fiber.state === 2 = active（与 configEditor.edit 的活性判据一致）。 */
function entryActiveOf(entry: ConfigEditorEntry): boolean {
  return entry.fiber !== undefined && entry.fiber.state === 2
}

export function createRevisionState(): RevisionState {
  return { revision: 0, fingerprint: null }
}

function fingerprintOf(config: unknown): string {
  return JSON.stringify(config ?? null)
}

/** §3.1 #2：读侧观察——config 指纹相对上次有差异即 +1（任何来源的已提交变更
 *  一视同仁）；首次调用仅建立基线不递增。 */
export function observeRevision(state: RevisionState, config: unknown): number {
  const fingerprint = fingerprintOf(config)
  if (state.fingerprint !== null && fingerprint !== state.fingerprint) state.revision += 1
  state.fingerprint = fingerprint
  return state.revision
}

/** W7：listWorkspaces 返回的单条 workspace 摘要（sessionCount = 注册表里挂在
 *  该 workspace 下的会话数，纯展示用途）。 */
export interface WorkspaceSummary {
  id: string
  path: string
  sessionCount: number
}

/** W7：listWorkspaces 返回值。available=false = 宿主 workspaceRegistry 缺席或
 *  list() 抛错（降级语义：空列表 + 标注，不抛错——设置页隐藏快速填入行并提示
 *  可直接输入路径）。 */
export interface WorkspaceListResult {
  available: boolean
  workspaces: WorkspaceSummary[]
}

/** W7：listWorkspaces 纯实现（descriptor 方法体共用；对 registry 形状做防御性
 *  校验——与 requireConfigEditor 同款「运行期再校验形状」风格，但绝不抛错：
 *  缺席/形状不符/list() 失败都归一为 unavailable 空列表）。 */
export function listWorkspaces(registry: WorkspaceRegistryLike | undefined): WorkspaceListResult {
  if (registry === undefined || typeof registry.list !== 'function') {
    return { available: false, workspaces: [] }
  }
  try {
    const workspaces = registry.list().map((workspace) => ({
      id: String(workspace?.id ?? ''),
      path: String(workspace?.path ?? ''),
      sessionCount: Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.length : 0,
    }))
    return { available: true, workspaces }
  } catch {
    // 只读辅助查询：注册表异常（存储失败等）不该炸掉设置页，降级为不可用。
    return { available: false, workspaces: [] }
  }
}

/** W7：惰性解析宿主 workspaceRegistry（不经 static inject——保持可选依赖，
 *  registry 缺席时服务照常挂载，仅 listWorkspaces 降级 unavailable）。 */
function resolveWorkspaceRegistry(ctx: { get(key: string): unknown } | undefined): WorkspaceRegistryLike | undefined {
  const registry = ctx?.get?.('workspaceRegistry') as WorkspaceRegistryLike | undefined
  return registry !== undefined && registry !== null && typeof registry.list === 'function' ? registry : undefined
}

/** T17：思考档位查询用到的宿主 llm 服务最小面（@deepseek-ai/dsh-llm 的
 *  LlmRuntime.resolveModelInfo）。该方法的返回里 reasoning.efforts 才是模型
 *  真实支持的档位；同包的 listModels 返回值不含 reasoning 字段，故不能用它。 */
export interface LlmRuntimeLike {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    reasoning?: { efforts?: Array<{ id?: unknown; name?: unknown }>; defaultEffort?: unknown }
  }>
}

/** T17：宿主 agentDefaultModel 服务最小面（本通道沿用它作为模型来源，
 *  与 registry.modelWiring() 的 inheritance 一致）。 */
export interface DefaultModelLike {
  currentSelection(): { provider?: unknown; model?: unknown } | undefined
}

/** T17：listReasoningEfforts 返回值。available=false 表示拿不到通道——面板据此
 *  回退到静态八选一（'' + 宿主七档；方案 A：绝不因查询失败而收窄可选项，
 *  不引入新的失败面）。 */
export interface ReasoningEffortsResult {
  available: boolean
  efforts: Array<{ id: string; name: string }>
  defaultEffort?: string
}

/** T17：查询「当前默认模型实际支持哪些思考档位」（纯函数，绝不抛错）。
 *
 *  为什么需要它：插件的 reasoningEffort 是静态八选一（'' + 宿主七档），但宿主
 *  getSupportedThinkingLevels 的结果随模型变化——`xhigh`/`max` 只有模型显式
 *  声明才合法，否则请求期抛 UNSUPPORTED_REASONING_EFFORT（选了能存，用时报错）。
 *
 *  取证来源（@deepseek-ai/dsh-llm/lib/index.js）：:1816 `super(ctx, "llm")` 说明
 *  该服务即 ctx.llm；:2111-2163 resolveModelInfo 返回 `reasoning: { efforts:
 *  [{id,name,description?}], defaultEffort? }`；:2086-2101 listModels 不含
 *  reasoning。失败（服务缺席/无默认模型/无 reasoning 元数据/抛错）统一归一为
 *  available=false。 */
export async function listReasoningEfforts(
  llm: LlmRuntimeLike | undefined,
  defaultModel: DefaultModelLike | undefined,
  signal?: AbortSignal,
): Promise<ReasoningEffortsResult> {
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return { available: false, efforts: [] }
  if (defaultModel === undefined || typeof defaultModel.currentSelection !== 'function') return { available: false, efforts: [] }
  try {
    const selection = defaultModel.currentSelection()
    const provider = typeof selection?.provider === 'string' ? selection.provider : ''
    const model = typeof selection?.model === 'string' ? selection.model : ''
    if (provider === '' || model === '') return { available: false, efforts: [] }
    const info = await llm.resolveModelInfo(provider, model, signal)
    const raw = info?.reasoning?.efforts
    if (!Array.isArray(raw)) return { available: false, efforts: [] }
    const efforts: Array<{ id: string; name: string }> = []
    const seen = new Set<string>()
    for (const effort of raw) {
      const id = effort?.id
      const name = effort?.name
      if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '') continue
      if (seen.has(id)) continue
      seen.add(id)
      efforts.push({ id, name })
    }
    // 空档位集=宿主元数据异常（dsh-llm 自身也把空集判为 INVALID_MODEL_REASONING）
    if (efforts.length === 0) return { available: false, efforts: [] }
    const defaultEffort = info?.reasoning?.defaultEffort
    return typeof defaultEffort === 'string' && seen.has(defaultEffort)
      ? { available: true, efforts, defaultEffort }
      : { available: true, efforts }
  } catch {
    // 只读辅助查询：任何失败都不该炸掉设置页（与 listWorkspaces 同款降级）。
    return { available: false, efforts: [] }
  }
}

/** T17：惰性解析宿主 llm 与 agentDefaultModel（与 resolveWorkspaceRegistry 同款
 *  可选依赖——缺席时服务照常挂载，仅 listReasoningEfforts 降级 available=false）。 */
function resolveLlmRuntime(ctx: { get(key: string): unknown } | undefined): LlmRuntimeLike | undefined {
  const llm = ctx?.get?.('llm') as LlmRuntimeLike | undefined
  return llm !== undefined && llm !== null && typeof llm.resolveModelInfo === 'function' ? llm : undefined
}

function resolveDefaultModel(ctx: { get(key: string): unknown } | undefined): DefaultModelLike | undefined {
  const model = ctx?.get?.('agentDefaultModel') as DefaultModelLike | undefined
  return model !== undefined && model !== null && typeof model.currentSelection === 'function' ? model : undefined
}

// ---------------------------------------------------------------- 记忆管理
//
// 面板要「查看/编辑画像」，但网关只认 `getSettings` / `updateSettings` 这两个原有方法
// （运行时 markRemote 新增的方法不进 remote.methods —— `getNapcatStatus` 实测踩过）。
// `listReasoningEfforts` 能工作是因为它在**服务端 markRemote 与客户端 descriptors
// 双向声明**，所以这里照同一模式加四个方法：服务端 markRemote + lib/client.js 的
// ONEBOT_SETTINGS_DESCRIPTORS 各加一条。
//
// 性能取舍：记忆**不进** getSettings 的返回（那会让每次面板刷新都扫盘解析全部 JSON），
// 而是按需分页：
//   listMemoryChats  只 readdir + stat，不解析内容
//   readMemoryEntries 只读选中的那个文件（已按 memoryMaxEntriesPerChat 裁剪过）
// 读取上限 200/页，前端默认 50。

/** 面板用：一个会话的记忆概览。 */
export interface MemoryChatSummary {
  chatId: string
  /** 从 chatId 前缀判断，便于前端分组显示 */
  kind: 'private' | 'group'
  /** 文件字节数（不解析内容，仅展示与排序） */
  bytes: number
  /** 文件最后修改时间（epoch ms） */
  mtimeMs: number
}

export interface MemoryChatsResult {
  /** 记忆根目录（便于用户定位与备份） */
  dir: string
  /** 记忆功能是否开启；关闭时列表仍可读（历史可见，只是不再写入） */
  enabled: boolean
  chats: MemoryChatSummary[]
}

/** 面板用：一条记忆的视图。 */
export interface MemoryEntryView {
  ts: number
  text: string
  tags: string[]
  kind: 'note' | 'profile'
  subject?: string
  by?: string
  role?: string
  /** 最近一次被提及的时间（缺省 = 从未刷新，等于 `ts`） */
  lastSeenAt?: number
  /** 已超保留时长：面板标注「已过期」，模型不再召回（文件未删） */
  expired: boolean
}

export interface MemoryEntriesResult {
  chatId: string
  /** 过滤后的总数（分页前） */
  total: number
  offset: number
  limit: number
  entries: MemoryEntryView[]
}

export interface MemoryMutationResult {
  ok: boolean
  /** 变更后该会话的总条数 */
  total: number
  /** 仅新建时出现：true = 命中了完全相同的既有条目，只刷新了「最近提及」而没新增行 */
  refreshed?: boolean
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(min, Math.min(max, num))
}

/** 从条目 config 解析记忆目录（与工具写入口径同一处：paths.memoryDirFor）。 */
function memoryDirOf(editor: ConfigEditorLike): string {
  const raw = findEntry(editor).options.config ?? {}
  return memoryDirFor(typeof raw.mediaDir === 'string' ? raw.mediaDir : '')
}

/** 会话列表：只 stat 不解析，几百个文件也是毫秒级。 */
export function listMemoryChats(editor: ConfigEditorLike): MemoryChatsResult {
  const raw = findEntry(editor).options.config ?? {}
  const dir = memoryDirOf(editor)
  return {
    dir,
    enabled: raw.memoryEnabled === true,
    chats: listMemoryFiles(dir).map((file) => ({
      chatId: file.chatId,
      kind: file.chatId.startsWith('group:') ? 'group' as const : 'private' as const,
      bytes: file.bytes,
      mtimeMs: file.mtimeMs,
    })),
  }
}

/**
 * 分页读取某个会话的记忆（新→旧；给 query 时按相关度排序）。
 *
 * `kind` 只看某一类：`'note'` / `'profile'`，其他值（含 `''`）表示不筛 —— 面板的
 * 「全部 / 记忆 / 画像」下拉就靠它，否则画像条数一多就把普通记忆淹了。
 */
export function readMemoryEntries(
  editor: ConfigEditorLike,
  chatId: unknown,
  offset: unknown,
  limit: unknown,
  query: unknown,
  kind: unknown,
): MemoryEntriesResult {
  const id = typeof chatId === 'string' ? chatId : ''
  if (id === '') throw new RemoteError('onebot-settings/bad-chat-id', '缺少 chatId，无法读取记忆', { chatId: id })
  const dir = memoryDirOf(editor)
  const all = readAllMemories(dir, id)
  // 历史条目缺 kind，按 note 处理（与 selectForRecall / tools 的口径一致）。
  const wanted = kind === 'profile' ? 'profile' as const : kind === 'note' ? 'note' as const : undefined
  const scoped = wanted === undefined ? all : all.filter((entry) => (entry.kind ?? 'note') === wanted)
  const keyword = typeof query === 'string' ? query.trim() : ''
  // 无关键字：新→旧（面板默认看最近的）；有关键字：按相关度（searchMemories 已排序）
  const ordered = keyword === ''
    ? [...scoped].reverse()
    : searchMemories(scoped, keyword, scoped.length).map((hit) => hit.entry)
  const pageSize = clampInt(limit, 1, 200, 50)
  const start = clampInt(offset, 0, Math.max(0, ordered.length - 1), 0)
  const now = Date.now()
  return {
    chatId: id,
    total: ordered.length,
    offset: start,
    limit: pageSize,
    entries: ordered.slice(start, start + pageSize).map((entry) => ({
      ts: entry.ts,
      text: entry.text,
      tags: entry.tags ?? [],
      kind: entry.kind ?? 'note',
      ...(entry.subject !== undefined ? { subject: entry.subject } : {}),
      ...(entry.by !== undefined ? { by: entry.by } : {}),
      ...(entry.role !== undefined ? { role: entry.role } : {}),
      ...(entry.lastSeenAt !== undefined ? { lastSeenAt: entry.lastSeenAt } : {}),
      expired: isExpired(entry, now),
    })),
  }
}

/** 编辑一条记忆的正文/标签（身份字段 ts/kind/subject 不可改）。 */
export function updateMemoryEntry(
  editor: ConfigEditorLike,
  chatId: unknown,
  ts: unknown,
  text: unknown,
  tags: unknown,
): MemoryMutationResult {
  const id = typeof chatId === 'string' ? chatId : ''
  if (id === '') throw new RemoteError('onebot-settings/bad-chat-id', '缺少 chatId，无法保存', { chatId: id })
  const stamp = typeof ts === 'number' && Number.isFinite(ts) ? ts : 0
  if (stamp <= 0) throw new RemoteError('onebot-settings/bad-memory-id', '缺少记忆标识（ts）', { chatId: id })
  const next = typeof text === 'string' ? text.trim() : ''
  if (next === '') throw new RemoteError('onebot-settings/bad-memory-text', '记忆正文不能为空', { chatId: id })
  // 与工具写入同一道闸：面板保存也不能把手机号/身份证写进明文文件。
  const sensitive = findSensitive(next)
  if (sensitive !== null) {
    throw new RemoteError('onebot-settings/sensitive-memory', '内容疑似包含' + sensitive + '，已拒绝保存', { chatId: id })
  }
  const nextTags = Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '').slice(0, 8)
    : []
  const dir = memoryDirOf(editor)
  const ok = updateMemory(dir, id, stamp, { text: next.length > 500 ? next.slice(0, 500) : next, tags: nextTags })
  return { ok, total: readAllMemories(dir, id).length }
}

/** 删除一条记忆（按 ts）。 */
export function deleteMemoryEntry(editor: ConfigEditorLike, chatId: unknown, ts: unknown): MemoryMutationResult {
  const id = typeof chatId === 'string' ? chatId : ''
  if (id === '') throw new RemoteError('onebot-settings/bad-chat-id', '缺少 chatId，无法删除', { chatId: id })
  const stamp = typeof ts === 'number' && Number.isFinite(ts) ? ts : 0
  if (stamp <= 0) throw new RemoteError('onebot-settings/bad-memory-id', '缺少记忆标识（ts）', { chatId: id })
  const dir = memoryDirOf(editor)
  const ok = deleteMemory(dir, id, stamp)
  return { ok, total: readAllMemories(dir, id).length }
}

/**
 * 面板新建一条记忆。
 *
 * 与工具写入共用同一套规则：敏感信息拒绝、正文 ≤500 字、`kind: 'profile'` 必须给主体。
 * 走 `upsertMemory`（而不是无条件 append）—— 面板重复添加同一句话时只刷新「最近提及」，
 * 与模型侧的判重口径保持一致。
 *
 * 来源字段（`by` / `role`）留空：面板操作没有 QQ 身份，留空比编一个更诚实。
 */
export function createMemoryEntry(
  editor: ConfigEditorLike,
  chatId: unknown,
  text: unknown,
  kind: unknown,
  subject: unknown,
  tags: unknown,
): MemoryMutationResult {
  const id = typeof chatId === 'string' ? chatId : ''
  if (id === '') throw new RemoteError('onebot-settings/bad-chat-id', '缺少 chatId，无法新建', { chatId: id })
  const body = typeof text === 'string' ? text.trim() : ''
  if (body === '') throw new RemoteError('onebot-settings/bad-memory-text', '记忆正文不能为空', { chatId: id })
  // 与工具写入同一道闸：面板也不能把手机号/身份证写进明文文件。
  const sensitive = findSensitive(body)
  if (sensitive !== null) {
    throw new RemoteError('onebot-settings/sensitive-memory', '内容疑似包含' + sensitive + '，已拒绝保存', { chatId: id })
  }
  const kindValue = kind === 'profile' ? 'profile' as const : 'note' as const
  const subjectValue = typeof subject === 'string' ? subject.trim() : ''
  if (kindValue === 'profile' && subjectValue === '') {
    throw new RemoteError('onebot-settings/bad-subject', '画像必须指定主体 QQ 号', { chatId: id })
  }
  const nextTags = Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '').slice(0, 8)
    : []
  const raw = findEntry(editor).options.config ?? {}
  const cap = typeof raw.memoryMaxEntriesPerChat === 'number' && raw.memoryMaxEntriesPerChat > 0
    ? Math.floor(raw.memoryMaxEntriesPerChat)
    : 200
  const dir = memoryDirOf(editor)
  const result = upsertMemory(dir, id, {
    ts: Date.now(),
    text: body.length > 500 ? body.slice(0, 500) : body,
    ...(nextTags.length > 0 ? { tags: nextTags } : {}),
    ...(kindValue === 'profile' ? { kind: 'profile' as const, subject: subjectValue } : {}),
  })
  // 面板新建同样要遵守单会话上限（与工具写入一致）。
  trimMemories(dir, id, cap)
  return {
    ok: true,
    total: readAllMemories(dir, id).length,
    ...(result.refreshed ? { refreshed: true } : {}),
  }
}

/** 38 键生效值 = schema 默认值 ← 条目 config 覆盖（T1 §3 合并优先级一句话）。 */
export function effectiveConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const effective: Record<string, unknown> = {}
  for (const key of ALL_KEYS) {
    const value = raw[key]
    effective[key] = value === undefined ? SCHEMA_DEFAULTS[key] : value
  }
  return effective
}

function buildSnapshot(entry: ConfigEditorEntry, state: RevisionState): OnebotSettingsSnapshot {
  const raw = entry.options.config ?? {}
  const revision = observeRevision(state, raw)
  const config = effectiveConfig(raw)
  const secrets = SECRET_KEYS.map((key) => {
    const set = typeof raw[key] === 'string' && (raw[key] as string).length > 0
    config[key] = '' // 脱敏：快照不回显明文（T1 §3）
    return { path: [key], set }
  })
  // 只脱敏、不暴露 secret 编辑态的键（见 REDACTED_ONLY_KEYS 的注释）。
  for (const key of REDACTED_ONLY_KEYS) config[key] = ''
  return {
    revision,
    entryActive: entryActiveOf(entry),
    config,
    secrets,
    groups: Object.fromEntries(Object.entries(SETTINGS_GROUPS).map(([group, keys]) => [group, [...keys]])),
    effect: REMOTE_EFFECT,
    // NapCat 状态（本地补丁）：挂在既有 getSettings 的返回里，而不是新增一个
    // Remote 方法 —— 网关的 methods 来自编译期 spec，运行时 markRemote 加的方法
    // 不会出现在其中（实测 remote.methods 里没有新方法）。扩展返回结构则不受此限。
    napcat: buildNapcatStatus(
      typeof config.napcatLauncher === 'string' ? config.napcatLauncher : '',
      typeof config.port === 'number' ? config.port : 8643,
    ),
  }
}

/**
 * S-05：字符串键的**取值**校验（此前只校验类型/长度）。
 *
 * 为什么必须有：`url` 决定插件主动连接谁——把它改成攻击者的 WS 服务，对方就成了
 * OneBot 对端，可以伪造任意 `user_id`（鉴权唯一信任源就是 WS 对端），等于把管理员
 * 身份交出去。`workspacePath` / `memeDir` 则是 Agent 的工作目录，写进相对路径或
 * `..` 段会让围栏与工作区判定落空。
 *
 * 返回 undefined = 合法；返回字符串 = 拒绝原因（整单拒绝，不做静默修正）。
 * 不限制「必须连本机」：跨机部署是合法场景，这里只排除协议错误与用户信息。
 */
function validateStringValue(key: string, value: string): string | undefined {
  if (key === 'url' && value !== '') {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      return 'url 不是合法 URL'
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return 'url 只支持 ws:// 或 wss://'
    if (parsed.username !== '' || parsed.password !== '') return 'url 不能包含用户名/密码'
    return undefined
  }
  if (key === 'host' && value !== '') {
    // 监听地址：IP（v4/v6）或主机名；空串 = schema 默认 127.0.0.1。
    return /^[A-Za-z0-9.:[\]_-]+$/.test(value) ? undefined : 'host 只接受 IP 或主机名'
  }
  if ((key === 'workspacePath' || key === 'memeDir') && value !== '') {
    if (!isAbsolute(value)) return key + ' 必须是绝对路径（工作区/表情包目录）'
    if (value.split(/[\\/]/).includes('..')) return key + ' 不能包含 .. 段'
    return undefined
  }
  return undefined
}

/** updateSettings 入参校验（T1 §4：32 键的任意子集，扁平 JSON）。未知键整单
 *  拒绝（不静默丢弃）；类型/枚举不符拒绝；字符串键另做取值校验（S-05）。 */
export function validatePatch(patch: unknown): Record<string, unknown> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new RemoteError('onebot-settings/bad-request', 'patch must be a flat JSON object keyed by setting names', {
      issues: ['patch 必须是扁平 JSON 对象'],
    })
  }
  const issues: string[] = []
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const enums = ENUM_KEYS[key]
    if (enums !== undefined) {
      if (typeof value === 'string' && enums.includes(value)) clean[key] = value
      else issues.push(`${key} 必须是 ${enums.join(' | ')} 之一`)
    } else if (NUMBER_KEYS.includes(key)) {
      const [min, max] = NUMBER_RANGE[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= min && (max === undefined || value <= max)) clean[key] = value
      else issues.push(`${key} 必须是 ${max === undefined ? `≥${min}` : `${min}–${max}`} 的有限数字`)
    } else if (BOOLEAN_KEYS.includes(key)) {
      if (typeof value === 'boolean') clean[key] = value
      else issues.push(`${key} 必须是布尔值`)
    } else if (STRING_KEYS.includes(key)) {
      const maxLen = STRING_MAX_LEN[key]
      const valueIssue = typeof value === 'string' ? validateStringValue(key, value) : undefined
      if (typeof value !== 'string') issues.push(`${key} 必须是字符串`)
      else if (maxLen !== undefined && value.length > maxLen) issues.push(`${key} 长度不得超过 ${maxLen} 字符（当前 ${value.length}）`)
      else if (valueIssue !== undefined) issues.push(valueIssue)
      else clean[key] = value
    } else if (STRING_ARRAY_KEYS.includes(key)) {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        issues.push(`${key} 必须是字符串数组`)
      } else {
        const maxItems = STRING_ARRAY_MAX_ITEMS[key]
        const itemMax = STRING_ARRAY_ITEM_MAX_LEN[key]
        const overLong = itemMax === undefined ? [] : value.filter((item) => (item as string).length > itemMax)
        if (maxItems !== undefined && value.length > maxItems) {
          issues.push(`${key} 最多 ${maxItems} 条（当前 ${value.length}）`)
        } else if (overLong.length > 0) {
          issues.push(`${key} 的单条长度不得超过 ${itemMax} 字符（超限 ${overLong.length} 条）`)
        } else {
          clean[key] = value
        }
      }
    } else {
      issues.push(`未知设置键 "${key}"（仅支持 ${ALL_KEYS.length} 键：${ALL_KEYS.join(', ')}）`)
    }
  }
  if (issues.length > 0) {
    throw new RemoteError('onebot-settings/bad-request', `invalid settings patch: ${issues.join('; ')}`, { issues })
  }
  return clean
}

/** getSettings 实现（descriptor 方法体共用；descriptor 参数 0 个）。 */
export function getSettings(editor: ConfigEditorLike, state: RevisionState): OnebotSettingsSnapshot {
  return buildSnapshot(findEntry(editor), state)
}

/** NapCat 状态（供设置页展示）：诊断结论 + 新鲜二维码的 data URL。 */
export interface NapcatStatusResult {
  /** 诊断阶段：ok / qq-conflict / no-process / not-logged-in / not-connected / risk-control / unconfigured / error */
  stage: string
  /** 一句话结论 */
  summary: string
  /** 多行明细（四阶段） */
  detail: string
  /** 二维码 data URL；已连接或没有文件时为 null（过期仍返回图，过期与否看 qrcodeAgeMinutes） */
  qrcodeDataUrl: string | null
  qrcodeAgeMinutes: number | null
}

/**
 * 读出 `cache/qrcode.png` 并转成 data URL。
 *
 * 这里**不做过期过滤**：过期与否由调用方结合年龄与文案判断。原因（2026-10-26 实测）：
 * NapCat 不保证按时刷新这个文件，一旦超过 5 分钟就返回 null，面板会永久空白，
 * 用户反而无处扫码；给图 + 明确标注「已过期」比什么都不给更有用。
 */
function readQrcodeDataUrl(napcatDir: string): string | null {
  const file = join(napcatDir, 'cache', 'qrcode.png')
  if (!existsSync(file)) return null
  try {
    return `data:image/png;base64,${readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}

/**
 * 组装 NapCat 状态快照（只读）。
 *
 * 未配置 `napcatLauncher` 时不猜路径，直接返回 unconfigured —— 插件不假设
 * NapCat 装在哪，也不主动探测文件系统。
 */
export function buildNapcatStatus(launcher: string, port: number): NapcatStatusResult {
  const trimmed = launcher.trim()
  if (trimmed === '') {
    return {
      stage: 'unconfigured',
      summary: '未配置 napcatLauncher：插件不诊断 NapCat 状态，也不自动启动。',
      detail: '',
      qrcodeDataUrl: null,
      qrcodeAgeMinutes: null,
    }
  }
  const dir = dirname(trimmed)
  try {
    const diagnosis = diagnoseNapcat({ napcatDir: dir, port })
    // 已连接 = 登录已完成，`cache/qrcode.png` 只是残留文件，照读会让人以为还没登录。
    // 未连接时**总是**返回图（含已过期）：NapCat 不保证按时刷新该文件，不返回图会让
    // 面板永久空白、用户无处扫码；过期由 summary 与客户端文案标注，不吞掉图。
    const qrAge = diagnosis.qrcodeAgeMinutes
    const showQr = !diagnosis.wsConnected && qrAge !== null
    return {
      stage: diagnosis.stage,
      summary: diagnosis.summary,
      detail: formatDiagnosis(diagnosis),
      qrcodeDataUrl: showQr ? readQrcodeDataUrl(dir) : null,
      qrcodeAgeMinutes: showQr ? qrAge : null,
    }
  } catch (error) {
    return {
      stage: 'error',
      summary: `诊断失败：${String(error)}`,
      detail: '',
      qrcodeDataUrl: null,
      qrcodeAgeMinutes: null,
    }
  }
}

/** W6 错误归一：宿主 configEditor.edit 的原生失败（文件锁超时 / 活性检查 /
 *  schema 校验 / home-patch 守卫 / 激活失败回滚后 rethrow）按
 *  docs/m1-characterization/config-editor.md §3 矩阵归类，转成面板可直接渲染的
 *  中文 RemoteError('onebot-settings/edit-failed')，原始错误挂 cause（网关透传
 *  detail 不吞诊断信息）。归类按宿主错误消息特征词匹配，未命中走通用文案；
 *  所有分支的共同事实（该文档 §3 已钉死）：失败时 patch 文件要么从未被写、要么
 *  已被宿主逐字节还原，本模块不做任何补偿写（不重试、不回写），仅归一转发。 */
export const EDIT_FAILED_CODE = 'onebot-settings/edit-failed'
export function describeEditFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/timed out waiting for the writer lock/i.test(message)) {
    return '写入失败：配置文件被其他写入方占用（等待文件锁超时），本次修改未落盘，请稍后重试'
  }
  if (/no longer available|changed during reload/i.test(message)) {
    return '写入失败：dsh-onebot 条目在编辑期间被替换或失活，本次修改未落盘，请刷新后重试'
  }
  if (/no longer active/i.test(message)) {
    return '写入失败：dsh-onebot 插件当前未激活，本次修改未落盘，请检查插件加载状态'
  }
  if (/overridden by a home patch|command-line overlay/i.test(message)) {
    return '写入失败：该配置被 home patch 或命令行覆盖层接管，修改被宿主拒绝；请改在对应层修改'
  }
  return `写入失败：宿主 configEditor 拒绝了本次修改（${message}），配置保持不变`
}

/** updateSettings 实现（descriptor 参数 (patch, expectedRevision)，全 positional）。
 *
 * 流程：定位条目 → 观察当前 revision → 乐观锁校验 → patch 校验 → no-op 短路
 * （合并结果与当前生效 config 全等则不写、不递增）→ configEditor.edit 合并写
 * （next = fresh config ∪ patch，未知原键原样保留；等于继承层时由宿主整行删
 * 除覆盖行，dsh-config-editor/lib/index.js:93-104）→ 成功后返回新快照（指纹
 * 变化 → revision +1）。
 *
 * W6：edit 失败不再裸抛宿主原生 Error（此前锁超时/激活回滚等错误绕开
 * onebot-settings/* 错误码体系直达网关，面板拿到的是英文技术文案）——按
 * describeEditFailure 归一为 onebot-settings/edit-failed 中文错误并保留 cause；
 * 失败路径 revision 不递增（指纹观察只在成功后的 buildSnapshot 发生）、不重试、
 * 不补偿写，patch 文件由宿主保证未被破坏（config-editor.md §3 矩阵）。 */
export async function updateSettings(
  editor: ConfigEditorLike,
  state: RevisionState,
  patch: unknown,
  expectedRevision?: number,
): Promise<OnebotSettingsSnapshot> {
  const entry = findEntry(editor)
  const actual = observeRevision(state, entry.options.config ?? {})
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision !== actual)) {
    throw new RemoteError(
      'onebot-settings/conflict',
      `expectedRevision ${String(expectedRevision)} does not match current revision ${actual}; re-read getSettings() and replay`,
      { expected: expectedRevision, actual },
    )
  }
  const clean = validatePatch(patch)
  const current = entry.options.config ?? {}
  const merged = { ...current, ...clean }
  if (isDeepStrictEqual(merged, current)) return buildSnapshot(entry, state) // no-op：不递增（§3.1 #4）
  try {
    await editor.edit(entry, (fresh) => ({ ...fresh, ...clean }))
  } catch (cause) {
    // W6 错误归一：只翻译、不重试、不补偿写；宿主已保证 patch 文件未被破坏或已逐字节还原。
    // details 带宿主原文（可跨网关序列化），cause 仅进程内诊断。
    throw new RemoteError(EDIT_FAILED_CODE, describeEditFailure(cause), { hostMessage: cause instanceof Error ? cause.message : String(cause) }, { cause })
  }
  return buildSnapshot(findEntry(editor), state)
}

/** 组装 descriptor 方法对象（测试与降级类共用；与类方法同一实现）。
 *  W7：workspaceRegistry 可选注入——省略时 listWorkspaces 降级 unavailable
 *  （与类分支的惰性 ctx 解析同一 listWorkspaces 纯函数出口）。 */
export function createOnebotSettingsMethods(
  editor: ConfigEditorLike,
  state: RevisionState = createRevisionState(),
  workspaceRegistry?: WorkspaceRegistryLike,
  llm?: LlmRuntimeLike,
  defaultModel?: DefaultModelLike,
): {
  getSettings(): Promise<OnebotSettingsSnapshot> | OnebotSettingsSnapshot
  updateSettings(patch: unknown, expectedRevision?: number): Promise<OnebotSettingsSnapshot>
  listWorkspaces(): Promise<WorkspaceListResult>
  listReasoningEfforts(): Promise<ReasoningEffortsResult>
  listMemoryChats(): MemoryChatsResult
  readMemoryEntries(chatId: string, offset: number, limit: number, query: string, kind: string): MemoryEntriesResult
  createMemoryEntry(chatId: string, text: string, kind: string, subject: string, tags: string[]): MemoryMutationResult
  updateMemoryEntry(chatId: string, ts: number, text: string, tags: string[]): MemoryMutationResult
  deleteMemoryEntry(chatId: string, ts: number): MemoryMutationResult
} {
  return {
    getSettings: () => getSettings(editor, state),
    updateSettings: (patch, expectedRevision) => updateSettings(editor, state, patch, expectedRevision),
    listWorkspaces: async () => listWorkspaces(workspaceRegistry),
    listReasoningEfforts: async () => listReasoningEfforts(llm, defaultModel),
    listMemoryChats: () => listMemoryChats(editor),
    readMemoryEntries: (chatId, offset, limit, query, kind) => readMemoryEntries(editor, chatId, offset, limit, query, kind),
    createMemoryEntry: (chatId, text, kind, subject, tags) => createMemoryEntry(editor, chatId, text, kind, subject, tags),
    updateMemoryEntry: (chatId, ts, text, tags) => updateMemoryEntry(editor, chatId, ts, text, tags),
    deleteMemoryEntry: (chatId, ts) => deleteMemoryEntry(editor, chatId, ts),
  }
}

/** 把 typert-protocol 的 Remote 标记应用到类原型（无原生装饰器语法的 shim，
 *  照抄 dsh-expert-orchestrator/lib/remote.js:99-115；mark() 对同一原型幂等）。 */
function markRemote(klass: object, methodName: string): void {
  if (!protocol?.Remote) return
  const initializers: Array<(this: unknown) => void> = []
  const decorator = protocol.Remote(methodName) as unknown as (
    method: undefined,
    context: { name: string; private: boolean; static: boolean; addInitializer(fn: () => void): void },
  ) => void
  decorator(undefined, {
    name: methodName,
    private: false,
    static: false,
    addInitializer(fn) { initializers.push(fn) },
  })
  const receiver = Object.create((klass as { prototype: object }).prototype)
  for (const fn of initializers) fn.call(receiver)
}

/** 服务装配：协议在位 → TypertRemoteService 子类（网关按 typertRemote 绑定 +
 *  原型 descriptor 发现）；否则降级为普通 cordis 服务（同名方法面，仅无网关
 *  发现）。两个分支共用上方导出的实现函数与同一 descriptor 形状。 */
// 显式 any：两个分支的类形状在运行期二选一，降级分支没有 Service 基类可声明。
let OnebotSettingsService: any
if (protocol?.TypertRemoteService) {
  class OnebotSettingsRemote extends protocol.TypertRemoteService {
    static inject = ['configEditor', 'profileContext']
    readonly state: RevisionState = createRevisionState()
    /** Service 基类的 ctx 为 protected 且跨包声明，此处自存一份只读引用供惰性解析。 */
    private readonly ownerCtx: Context

    constructor(ctx: Context) {
      super(ctx, NAMESPACE)
      this.ownerCtx = ctx
    }

    /** 惰性解析宿主 configEditor（static inject 保证在位；运行期再校验形状）。 */
    configEditor(): ConfigEditorLike {
      return requireConfigEditor(this.ownerCtx)
    }

    async getSettings(): Promise<OnebotSettingsSnapshot> {
      return getSettings(this.configEditor(), this.state)
    }

    async updateSettings(patch: unknown, expectedRevision?: number): Promise<OnebotSettingsSnapshot> {
      return updateSettings(this.configEditor(), this.state, patch, expectedRevision)
    }

    /** W7：只读查询宿主 workspace 注册表（惰性解析，缺席降级 unavailable，不抛错）。 */
    async listWorkspaces(): Promise<WorkspaceListResult> {
      return listWorkspaces(resolveWorkspaceRegistry(this.ownerCtx))
    }

    /** T17：只读查询当前默认模型的可用思考档位（惰性解析，失败降级 available=false）。 */
    async listReasoningEfforts(): Promise<ReasoningEffortsResult> {
      return listReasoningEfforts(resolveLlmRuntime(this.ownerCtx), resolveDefaultModel(this.ownerCtx))
    }

    /**
     * NapCat 状态（本地补丁，只读）：让设置页能显示「卡在哪一步」并直接扫码，
     * 从而不必盯着 NapCat 那个 GBK 乱码的控制台窗口。
     *
     * 只读诊断 + 读二维码文件；不启动、不终止任何进程。
     */
    async getNapcatStatus(): Promise<NapcatStatusResult> {
      const snapshot = getSettings(this.configEditor(), this.state)
      const launcher = typeof snapshot.config.napcatLauncher === 'string' ? snapshot.config.napcatLauncher : ''
      const port = typeof snapshot.config.port === 'number' ? snapshot.config.port : 8643
      return buildNapcatStatus(launcher, port)
    }

    /** 记忆：会话列表（只 stat，不解析内容）。 */
    listMemoryChats(): MemoryChatsResult {
      return listMemoryChats(this.configEditor())
    }

    /** 记忆：分页读取某会话的条目（新→旧；带 query 时按相关度；kind 只看某一类）。 */
    readMemoryEntries(chatId: string, offset: number, limit: number, query: string, kind: string): MemoryEntriesResult {
      return readMemoryEntries(this.configEditor(), chatId, offset, limit, query, kind)
    }

    /** 记忆：面板新建一条（与工具写入共用敏感信息/长度/上限规则）。 */
    createMemoryEntry(chatId: string, text: string, kind: string, subject: string, tags: string[]): MemoryMutationResult {
      return createMemoryEntry(this.configEditor(), chatId, text, kind, subject, tags)
    }

    /** 记忆：编辑一条的正文/标签（与工具写入共用敏感信息与长度闸门）。 */
    updateMemoryEntry(chatId: string, ts: number, text: string, tags: string[]): MemoryMutationResult {
      return updateMemoryEntry(this.configEditor(), chatId, ts, text, tags)
    }

    /** 记忆：删除一条。 */
    deleteMemoryEntry(chatId: string, ts: number): MemoryMutationResult {
      return deleteMemoryEntry(this.configEditor(), chatId, ts)
    }
  }
  markRemote(OnebotSettingsRemote, 'getSettings')
  markRemote(OnebotSettingsRemote, 'updateSettings')
  markRemote(OnebotSettingsRemote, 'listWorkspaces')
  markRemote(OnebotSettingsRemote, 'listReasoningEfforts')
  markRemote(OnebotSettingsRemote, 'getNapcatStatus')
  // 记忆管理：必须与 lib/client.js 的 ONEBOT_SETTINGS_DESCRIPTORS 同步声明，
  // 否则与 getNapcatStatus 一样——服务端有、网关不认。
  markRemote(OnebotSettingsRemote, 'listMemoryChats')
  markRemote(OnebotSettingsRemote, 'readMemoryEntries')
  markRemote(OnebotSettingsRemote, 'createMemoryEntry')
  markRemote(OnebotSettingsRemote, 'updateMemoryEntry')
  markRemote(OnebotSettingsRemote, 'deleteMemoryEntry')
  OnebotSettingsService = OnebotSettingsRemote
} else {
  console.warn('[dsh-onebot] @deepseek-ai/dsh-typert-protocol unavailable — onebotSettings remote degrades to a plain cordis service')
  class OnebotSettingsPlain {
    static inject = ['configEditor', 'profileContext']
    name = NAMESPACE
    state: RevisionState = createRevisionState()
    private ctx: { get(key: string): unknown } | undefined

    constructor(ctx: { get(key: string): unknown }) {
      this.ctx = ctx
    }

    configEditor(): ConfigEditorLike {
      return requireConfigEditor(this.ctx)
    }

    getSettings(): OnebotSettingsSnapshot {
      return getSettings(this.configEditor(), this.state)
    }

    async updateSettings(patch: unknown, expectedRevision?: number): Promise<OnebotSettingsSnapshot> {
      return updateSettings(this.configEditor(), this.state, patch, expectedRevision)
    }

    /** W7：与 typert 分支同一惰性解析 + 降级语义。 */
    async listWorkspaces(): Promise<WorkspaceListResult> {
      return listWorkspaces(resolveWorkspaceRegistry(this.ctx))
    }

    /** T17：与 typert 分支同一惰性解析 + 降级语义。 */
    async listReasoningEfforts(): Promise<ReasoningEffortsResult> {
      return listReasoningEfforts(resolveLlmRuntime(this.ctx), resolveDefaultModel(this.ctx))
    }

    /** 记忆：与 typert 分支同一实现（降级只为「无网关发现」，方法面保持一致）。 */
    listMemoryChats(): MemoryChatsResult {
      return listMemoryChats(this.configEditor())
    }

    readMemoryEntries(chatId: string, offset: number, limit: number, query: string, kind: string): MemoryEntriesResult {
      return readMemoryEntries(this.configEditor(), chatId, offset, limit, query, kind)
    }

    createMemoryEntry(chatId: string, text: string, kind: string, subject: string, tags: string[]): MemoryMutationResult {
      return createMemoryEntry(this.configEditor(), chatId, text, kind, subject, tags)
    }

    updateMemoryEntry(chatId: string, ts: number, text: string, tags: string[]): MemoryMutationResult {
      return updateMemoryEntry(this.configEditor(), chatId, ts, text, tags)
    }

    deleteMemoryEntry(chatId: string, ts: number): MemoryMutationResult {
      return deleteMemoryEntry(this.configEditor(), chatId, ts)
    }
  }
  OnebotSettingsService = OnebotSettingsPlain
}

export default OnebotSettingsService
export { OnebotSettingsService }
