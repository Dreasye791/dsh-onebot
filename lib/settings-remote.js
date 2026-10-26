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
import { dirname, isAbsolute, join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { QRCODE_TTL_MINUTES, diagnoseNapcat, formatDiagnosis } from './napcat-diagnose.js';
import { MCP_ALLOW_ITEM_MAX_LEN, MCP_ALLOW_MAX_ENTRIES } from './mcp-gate.js';
/** patch insert 中 dsh-onebot 主条目的 id（T1 §2/§3：唯一持久层条目）。 */
export const ENTRY_ID = 'dsh-onebot';
/** Typert Remote 命名空间 = cordis 服务键（T1 §4）。 */
export const NAMESPACE = 'onebotSettings';
/** 快照固定值：38 键均为插件级热重启生效（T1 §5；W1/W2 新增 6 布尔键同粒度）。 */
export const REMOTE_EFFECT = 'restart';
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
export const SETTINGS_GROUPS = {
    connection: ['mode', 'host', 'port', 'url', 'accessToken', 'botQQ', 'workspacePath', 'memeDir', 'attachInboundImages', 'attachMaxImageMB', 'attachmentBudgetMB', 'attachmentRetentionHours', 'attachmentSaveTimeoutMs',
        // 本地补丁：NapCat 看护三项。此前只在 ALL_KEYS 里（服务端可读可写），但没进分组
        // 与客户端 GROUPS —— 结果「设置页看不到输入框」，同时让 ALL_KEYS(40) 与
        // SETTINGS_GROUPS(38) 漂移，tests/client-settings.spec.ts 有 4 条断言长期红。
        'napcatLauncher', 'napcatLauncherArgs', 'autoStartNapcat'],
    permissions: ['requireMention', 'adminUsers', 'dmPolicy', 'groupPolicy', 'allowAllUsers', 'allowFrom', 'groupAllowFrom', 'mcpToolAllow'],
    behavior: ['interimMessages', 'interimRecall', 'interimRecallMs', 'sendErrorNotice', 'unknownCommand', 'rateLimitPerMinute', 'newMessagePolicy', 'autoSteerPolicy', 'deferredTimeoutMs', 'reasoningEffort', 'persona'],
    diagnostics: ['actionAuditEnabled', 'traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun'],
};
/** schema 默认值（T1 §4 表；摘自 src/index.ts:171-245），快照生效值的底层。 */
export const SCHEMA_DEFAULTS = {
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
};
/** 快照返回侧脱敏的键（T1 §3 敏感字段行；写入侧明文落盘属宿主既有行为）。 */
export const SECRET_KEYS = ['accessToken'];
const ENUM_KEYS = {
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
};
const NUMBER_KEYS = ['port', 'interimRecallMs', 'rateLimitPerMinute', 'deferredTimeoutMs', 'attachMaxImageMB', 'attachmentBudgetMB', 'attachmentRetentionHours', 'attachmentSaveTimeoutMs'];
/** 数字键取值范围（评审 B4：port 1–65535、时长/频控 ≥0；越界在 Remote 层拒绝，不再只依赖宿主回滚兜底）。 */
const NUMBER_RANGE = {
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
};
/** 布尔键白名单（T1 §4 + W6 扩展：W1/W2 观测/调试 6 键入列；顺序与
 *  SETTINGS_GROUPS.diagnostics 一致。数值键 dedupWindowSeconds/actionRatePerMinute/
 *  actionRatePerDay/injectIntervalMs 与枚举键 traceLevel 本期不入 UI 白名单——
 *  面板仅布尔开关与既有 19 键，调优键仍走 patch config 手改，取舍见 DEVLOG W6）。 */
const BOOLEAN_KEYS = [
    'requireMention', 'allowAllUsers', 'interimMessages', 'interimRecall', 'sendErrorNotice', 'attachInboundImages',
    'actionAuditEnabled', 'traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun',
    // 本地补丁：NapCat 看护开关（是否允许未连接时自动拉起）
    'autoStartNapcat',
];
const STRING_KEYS = [
    'host', 'url', 'accessToken', 'botQQ', 'workspacePath', 'persona', 'memeDir',
    // 本地补丁：NapCat 启动器路径（诊断据此推导 NapCat.Shell 目录）
    'napcatLauncher',
];
/** 字符串键长度上限（T11：与 client patchSchema `vString(0, 20000)` 同宽，
 *  防止仅经 Remote 直连的调用方绕过面板写入无界大文本进 patch）。
 *  未列出的字符串键不设上限（保持 T1 既有行为）。 */
const STRING_MAX_LEN = { persona: 20000 };
const STRING_ARRAY_KEYS = ['adminUsers', 'allowFrom', 'groupAllowFrom', 'mcpToolAllow',
    // 本地补丁：NapCat 拉起参数（如 ['-q', '<QQ号>']）；逐条按字符串校验。
    'napcatLauncherArgs'];
/** 字符串数组键的单项长度上限（T20：与 client patchSchema `vString(0, 128)` 同宽）。
 *  未列出的数组键不设上限（保持 T1 既有行为）。 */
const STRING_ARRAY_ITEM_MAX_LEN = { mcpToolAllow: MCP_ALLOW_ITEM_MAX_LEN };
/** 字符串数组键的条目数上限（T20：防止 patch 里塞进无界的白名单）。 */
const STRING_ARRAY_MAX_ITEMS = { mcpToolAllow: MCP_ALLOW_MAX_ENTRIES };
/** 全部 41 键（校验与快照的唯一键集；7 枚举 + 8 数字 + 13 布尔 + 8 字符串 + 5 字符串数组）。 */
export const ALL_KEYS = [
    ...Object.keys(ENUM_KEYS), ...NUMBER_KEYS, ...BOOLEAN_KEYS, ...STRING_KEYS, ...STRING_ARRAY_KEYS,
];
/** typert-protocol 不可解析时的降级错误：结构对齐 RemoteError（code/details/
 *  isDSHRemoteError 标记），保证失败路径语义一致。 */
class FallbackRemoteError extends Error {
    code;
    details;
    isDSHRemoteError = true;
    constructor(code, message, details, options) {
        super(message, options);
        this.code = code;
        this.details = details;
        this.name = 'RemoteError';
    }
}
let protocol = null;
try {
    protocol = await import('@deepseek-ai/dsh-typert-protocol');
}
catch {
    protocol = null;
}
/** RemoteError 统一出口：协议在位用宿主类（跨域识别按 isDSHRemoteError），否则降级类。
 *  宿主类对 code 有 RemoteErrorDetailsMap 泛型约束（类型层），本服务使用自有
 *  onebot-settings/* 错误码（运行期任意字符串均可，网关原样透传），故统一收窄为
 *  本模块的宽松构造签名。 */
const RemoteError = (protocol?.RemoteError ?? FallbackRemoteError);
/** 乐观锁/降级以外唯一会抛的宿主依赖缺失情形：configEditor 不在位。 */
function requireConfigEditor(ctx) {
    const editor = ctx?.get?.('configEditor');
    if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
        throw new RemoteError('onebot-settings/no-config-editor', 'configEditor service is unavailable: the onebot-settings-remote row must mount beside the host bundle\'s dsh-config-editor', { entryId: ENTRY_ID });
    }
    return editor;
}
/** 在 profile patch 的可寻址条目中定位 dsh-onebot 主条目；不存在必须显式报错
 *  （T1 §2：条目不存在时返回明确错误，不得静默）。 */
function findEntry(editor) {
    const entry = editor.entries().find((candidate) => candidate?.options?.id === ENTRY_ID);
    if (!entry) {
        throw new RemoteError('onebot-settings/no-entry', `no active "${ENTRY_ID}" entry in the profile patch — mount dsh-onebot first`, { entryId: ENTRY_ID });
    }
    return entry;
}
/** T1 §2/§5：条目 fiber.state === 2 = active（与 configEditor.edit 的活性判据一致）。 */
function entryActiveOf(entry) {
    return entry.fiber !== undefined && entry.fiber.state === 2;
}
export function createRevisionState() {
    return { revision: 0, fingerprint: null };
}
function fingerprintOf(config) {
    return JSON.stringify(config ?? null);
}
/** §3.1 #2：读侧观察——config 指纹相对上次有差异即 +1（任何来源的已提交变更
 *  一视同仁）；首次调用仅建立基线不递增。 */
export function observeRevision(state, config) {
    const fingerprint = fingerprintOf(config);
    if (state.fingerprint !== null && fingerprint !== state.fingerprint)
        state.revision += 1;
    state.fingerprint = fingerprint;
    return state.revision;
}
/** W7：listWorkspaces 纯实现（descriptor 方法体共用；对 registry 形状做防御性
 *  校验——与 requireConfigEditor 同款「运行期再校验形状」风格，但绝不抛错：
 *  缺席/形状不符/list() 失败都归一为 unavailable 空列表）。 */
export function listWorkspaces(registry) {
    if (registry === undefined || typeof registry.list !== 'function') {
        return { available: false, workspaces: [] };
    }
    try {
        const workspaces = registry.list().map((workspace) => ({
            id: String(workspace?.id ?? ''),
            path: String(workspace?.path ?? ''),
            sessionCount: Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.length : 0,
        }));
        return { available: true, workspaces };
    }
    catch {
        // 只读辅助查询：注册表异常（存储失败等）不该炸掉设置页，降级为不可用。
        return { available: false, workspaces: [] };
    }
}
/** W7：惰性解析宿主 workspaceRegistry（不经 static inject——保持可选依赖，
 *  registry 缺席时服务照常挂载，仅 listWorkspaces 降级 unavailable）。 */
function resolveWorkspaceRegistry(ctx) {
    const registry = ctx?.get?.('workspaceRegistry');
    return registry !== undefined && registry !== null && typeof registry.list === 'function' ? registry : undefined;
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
export async function listReasoningEfforts(llm, defaultModel, signal) {
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function')
        return { available: false, efforts: [] };
    if (defaultModel === undefined || typeof defaultModel.currentSelection !== 'function')
        return { available: false, efforts: [] };
    try {
        const selection = defaultModel.currentSelection();
        const provider = typeof selection?.provider === 'string' ? selection.provider : '';
        const model = typeof selection?.model === 'string' ? selection.model : '';
        if (provider === '' || model === '')
            return { available: false, efforts: [] };
        const info = await llm.resolveModelInfo(provider, model, signal);
        const raw = info?.reasoning?.efforts;
        if (!Array.isArray(raw))
            return { available: false, efforts: [] };
        const efforts = [];
        const seen = new Set();
        for (const effort of raw) {
            const id = effort?.id;
            const name = effort?.name;
            if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '')
                continue;
            if (seen.has(id))
                continue;
            seen.add(id);
            efforts.push({ id, name });
        }
        // 空档位集=宿主元数据异常（dsh-llm 自身也把空集判为 INVALID_MODEL_REASONING）
        if (efforts.length === 0)
            return { available: false, efforts: [] };
        const defaultEffort = info?.reasoning?.defaultEffort;
        return typeof defaultEffort === 'string' && seen.has(defaultEffort)
            ? { available: true, efforts, defaultEffort }
            : { available: true, efforts };
    }
    catch {
        // 只读辅助查询：任何失败都不该炸掉设置页（与 listWorkspaces 同款降级）。
        return { available: false, efforts: [] };
    }
}
/** T17：惰性解析宿主 llm 与 agentDefaultModel（与 resolveWorkspaceRegistry 同款
 *  可选依赖——缺席时服务照常挂载，仅 listReasoningEfforts 降级 available=false）。 */
function resolveLlmRuntime(ctx) {
    const llm = ctx?.get?.('llm');
    return llm !== undefined && llm !== null && typeof llm.resolveModelInfo === 'function' ? llm : undefined;
}
function resolveDefaultModel(ctx) {
    const model = ctx?.get?.('agentDefaultModel');
    return model !== undefined && model !== null && typeof model.currentSelection === 'function' ? model : undefined;
}
/** 38 键生效值 = schema 默认值 ← 条目 config 覆盖（T1 §3 合并优先级一句话）。 */
export function effectiveConfig(raw) {
    const effective = {};
    for (const key of ALL_KEYS) {
        const value = raw[key];
        effective[key] = value === undefined ? SCHEMA_DEFAULTS[key] : value;
    }
    return effective;
}
function buildSnapshot(entry, state) {
    const raw = entry.options.config ?? {};
    const revision = observeRevision(state, raw);
    const config = effectiveConfig(raw);
    const secrets = SECRET_KEYS.map((key) => {
        const set = typeof raw[key] === 'string' && raw[key].length > 0;
        config[key] = ''; // 脱敏：快照不回显明文（T1 §3）
        return { path: [key], set };
    });
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
        napcat: buildNapcatStatus(typeof config.napcatLauncher === 'string' ? config.napcatLauncher : '', typeof config.port === 'number' ? config.port : 8643),
    };
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
function validateStringValue(key, value) {
    if (key === 'url' && value !== '') {
        let parsed;
        try {
            parsed = new URL(value);
        }
        catch {
            return 'url 不是合法 URL';
        }
        if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
            return 'url 只支持 ws:// 或 wss://';
        if (parsed.username !== '' || parsed.password !== '')
            return 'url 不能包含用户名/密码';
        return undefined;
    }
    if (key === 'host' && value !== '') {
        // 监听地址：IP（v4/v6）或主机名；空串 = schema 默认 127.0.0.1。
        return /^[A-Za-z0-9.:[\]_-]+$/.test(value) ? undefined : 'host 只接受 IP 或主机名';
    }
    if ((key === 'workspacePath' || key === 'memeDir') && value !== '') {
        if (!isAbsolute(value))
            return key + ' 必须是绝对路径（工作区/表情包目录）';
        if (value.split(/[\\/]/).includes('..'))
            return key + ' 不能包含 .. 段';
        return undefined;
    }
    return undefined;
}
/** updateSettings 入参校验（T1 §4：32 键的任意子集，扁平 JSON）。未知键整单
 *  拒绝（不静默丢弃）；类型/枚举不符拒绝；字符串键另做取值校验（S-05）。 */
export function validatePatch(patch) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new RemoteError('onebot-settings/bad-request', 'patch must be a flat JSON object keyed by setting names', {
            issues: ['patch 必须是扁平 JSON 对象'],
        });
    }
    const issues = [];
    const clean = {};
    for (const [key, value] of Object.entries(patch)) {
        const enums = ENUM_KEYS[key];
        if (enums !== undefined) {
            if (typeof value === 'string' && enums.includes(value))
                clean[key] = value;
            else
                issues.push(`${key} 必须是 ${enums.join(' | ')} 之一`);
        }
        else if (NUMBER_KEYS.includes(key)) {
            const [min, max] = NUMBER_RANGE[key];
            if (typeof value === 'number' && Number.isFinite(value) && value >= min && (max === undefined || value <= max))
                clean[key] = value;
            else
                issues.push(`${key} 必须是 ${max === undefined ? `≥${min}` : `${min}–${max}`} 的有限数字`);
        }
        else if (BOOLEAN_KEYS.includes(key)) {
            if (typeof value === 'boolean')
                clean[key] = value;
            else
                issues.push(`${key} 必须是布尔值`);
        }
        else if (STRING_KEYS.includes(key)) {
            const maxLen = STRING_MAX_LEN[key];
            const valueIssue = typeof value === 'string' ? validateStringValue(key, value) : undefined;
            if (typeof value !== 'string')
                issues.push(`${key} 必须是字符串`);
            else if (maxLen !== undefined && value.length > maxLen)
                issues.push(`${key} 长度不得超过 ${maxLen} 字符（当前 ${value.length}）`);
            else if (valueIssue !== undefined)
                issues.push(valueIssue);
            else
                clean[key] = value;
        }
        else if (STRING_ARRAY_KEYS.includes(key)) {
            if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
                issues.push(`${key} 必须是字符串数组`);
            }
            else {
                const maxItems = STRING_ARRAY_MAX_ITEMS[key];
                const itemMax = STRING_ARRAY_ITEM_MAX_LEN[key];
                const overLong = itemMax === undefined ? [] : value.filter((item) => item.length > itemMax);
                if (maxItems !== undefined && value.length > maxItems) {
                    issues.push(`${key} 最多 ${maxItems} 条（当前 ${value.length}）`);
                }
                else if (overLong.length > 0) {
                    issues.push(`${key} 的单条长度不得超过 ${itemMax} 字符（超限 ${overLong.length} 条）`);
                }
                else {
                    clean[key] = value;
                }
            }
        }
        else {
            issues.push(`未知设置键 "${key}"（仅支持 ${ALL_KEYS.length} 键：${ALL_KEYS.join(', ')}）`);
        }
    }
    if (issues.length > 0) {
        throw new RemoteError('onebot-settings/bad-request', `invalid settings patch: ${issues.join('; ')}`, { issues });
    }
    return clean;
}
/** getSettings 实现（descriptor 方法体共用；descriptor 参数 0 个）。 */
export function getSettings(editor, state) {
    return buildSnapshot(findEntry(editor), state);
}
/** 读出 5 分钟内的二维码并转成 data URL；过期的不返回（扫了也没用）。 */
function readQrcodeDataUrl(napcatDir) {
    const file = join(napcatDir, 'cache', 'qrcode.png');
    if (!existsSync(file))
        return null;
    try {
        if (Date.now() - statSync(file).mtimeMs > 5 * 60_000)
            return null;
        return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
    }
    catch {
        return null;
    }
}
/**
 * 组装 NapCat 状态快照（只读）。
 *
 * 未配置 `napcatLauncher` 时不猜路径，直接返回 unconfigured —— 插件不假设
 * NapCat 装在哪，也不主动探测文件系统。
 */
export function buildNapcatStatus(launcher, port) {
    const trimmed = launcher.trim();
    if (trimmed === '') {
        return {
            stage: 'unconfigured',
            summary: '未配置 napcatLauncher：插件不诊断 NapCat 状态，也不自动启动。',
            detail: '',
            qrcodeDataUrl: null,
            qrcodeAgeMinutes: null,
        };
    }
    const dir = dirname(trimmed);
    try {
        const diagnosis = diagnoseNapcat({ napcatDir: dir, port });
        // 两种情况都不返回图：① 已连接（登录已完成，`cache/qrcode.png` 只是残留文件，
        // 照读会让人以为还没登录）；② 超过 TTL（那张码扫了也没用）。此前面板无条件
        // 读文件，出现过「登录成功 7 分钟后仍在展示过期二维码」。
        const qrAge = diagnosis.qrcodeAgeMinutes;
        const showQr = !diagnosis.wsConnected && qrAge !== null && qrAge <= QRCODE_TTL_MINUTES;
        return {
            stage: diagnosis.stage,
            summary: diagnosis.summary,
            detail: formatDiagnosis(diagnosis),
            qrcodeDataUrl: showQr ? readQrcodeDataUrl(dir) : null,
            qrcodeAgeMinutes: showQr ? qrAge : null,
        };
    }
    catch (error) {
        return {
            stage: 'error',
            summary: `诊断失败：${String(error)}`,
            detail: '',
            qrcodeDataUrl: null,
            qrcodeAgeMinutes: null,
        };
    }
}
/** W6 错误归一：宿主 configEditor.edit 的原生失败（文件锁超时 / 活性检查 /
 *  schema 校验 / home-patch 守卫 / 激活失败回滚后 rethrow）按
 *  docs/m1-characterization/config-editor.md §3 矩阵归类，转成面板可直接渲染的
 *  中文 RemoteError('onebot-settings/edit-failed')，原始错误挂 cause（网关透传
 *  detail 不吞诊断信息）。归类按宿主错误消息特征词匹配，未命中走通用文案；
 *  所有分支的共同事实（该文档 §3 已钉死）：失败时 patch 文件要么从未被写、要么
 *  已被宿主逐字节还原，本模块不做任何补偿写（不重试、不回写），仅归一转发。 */
export const EDIT_FAILED_CODE = 'onebot-settings/edit-failed';
export function describeEditFailure(cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/timed out waiting for the writer lock/i.test(message)) {
        return '写入失败：配置文件被其他写入方占用（等待文件锁超时），本次修改未落盘，请稍后重试';
    }
    if (/no longer available|changed during reload/i.test(message)) {
        return '写入失败：dsh-onebot 条目在编辑期间被替换或失活，本次修改未落盘，请刷新后重试';
    }
    if (/no longer active/i.test(message)) {
        return '写入失败：dsh-onebot 插件当前未激活，本次修改未落盘，请检查插件加载状态';
    }
    if (/overridden by a home patch|command-line overlay/i.test(message)) {
        return '写入失败：该配置被 home patch 或命令行覆盖层接管，修改被宿主拒绝；请改在对应层修改';
    }
    return `写入失败：宿主 configEditor 拒绝了本次修改（${message}），配置保持不变`;
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
export async function updateSettings(editor, state, patch, expectedRevision) {
    const entry = findEntry(editor);
    const actual = observeRevision(state, entry.options.config ?? {});
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision !== actual)) {
        throw new RemoteError('onebot-settings/conflict', `expectedRevision ${String(expectedRevision)} does not match current revision ${actual}; re-read getSettings() and replay`, { expected: expectedRevision, actual });
    }
    const clean = validatePatch(patch);
    const current = entry.options.config ?? {};
    const merged = { ...current, ...clean };
    if (isDeepStrictEqual(merged, current))
        return buildSnapshot(entry, state); // no-op：不递增（§3.1 #4）
    try {
        await editor.edit(entry, (fresh) => ({ ...fresh, ...clean }));
    }
    catch (cause) {
        // W6 错误归一：只翻译、不重试、不补偿写；宿主已保证 patch 文件未被破坏或已逐字节还原。
        // details 带宿主原文（可跨网关序列化），cause 仅进程内诊断。
        throw new RemoteError(EDIT_FAILED_CODE, describeEditFailure(cause), { hostMessage: cause instanceof Error ? cause.message : String(cause) }, { cause });
    }
    return buildSnapshot(findEntry(editor), state);
}
/** 组装 descriptor 方法对象（测试与降级类共用；与类方法同一实现）。
 *  W7：workspaceRegistry 可选注入——省略时 listWorkspaces 降级 unavailable
 *  （与类分支的惰性 ctx 解析同一 listWorkspaces 纯函数出口）。 */
export function createOnebotSettingsMethods(editor, state = createRevisionState(), workspaceRegistry, llm, defaultModel) {
    return {
        getSettings: () => getSettings(editor, state),
        updateSettings: (patch, expectedRevision) => updateSettings(editor, state, patch, expectedRevision),
        listWorkspaces: async () => listWorkspaces(workspaceRegistry),
        listReasoningEfforts: async () => listReasoningEfforts(llm, defaultModel),
    };
}
/** 把 typert-protocol 的 Remote 标记应用到类原型（无原生装饰器语法的 shim，
 *  照抄 dsh-expert-orchestrator/lib/remote.js:99-115；mark() 对同一原型幂等）。 */
function markRemote(klass, methodName) {
    if (!protocol?.Remote)
        return;
    const initializers = [];
    const decorator = protocol.Remote(methodName);
    decorator(undefined, {
        name: methodName,
        private: false,
        static: false,
        addInitializer(fn) { initializers.push(fn); },
    });
    const receiver = Object.create(klass.prototype);
    for (const fn of initializers)
        fn.call(receiver);
}
/** 服务装配：协议在位 → TypertRemoteService 子类（网关按 typertRemote 绑定 +
 *  原型 descriptor 发现）；否则降级为普通 cordis 服务（同名方法面，仅无网关
 *  发现）。两个分支共用上方导出的实现函数与同一 descriptor 形状。 */
// 显式 any：两个分支的类形状在运行期二选一，降级分支没有 Service 基类可声明。
let OnebotSettingsService;
if (protocol?.TypertRemoteService) {
    class OnebotSettingsRemote extends protocol.TypertRemoteService {
        static inject = ['configEditor', 'profileContext'];
        state = createRevisionState();
        /** Service 基类的 ctx 为 protected 且跨包声明，此处自存一份只读引用供惰性解析。 */
        ownerCtx;
        constructor(ctx) {
            super(ctx, NAMESPACE);
            this.ownerCtx = ctx;
        }
        /** 惰性解析宿主 configEditor（static inject 保证在位；运行期再校验形状）。 */
        configEditor() {
            return requireConfigEditor(this.ownerCtx);
        }
        async getSettings() {
            return getSettings(this.configEditor(), this.state);
        }
        async updateSettings(patch, expectedRevision) {
            return updateSettings(this.configEditor(), this.state, patch, expectedRevision);
        }
        /** W7：只读查询宿主 workspace 注册表（惰性解析，缺席降级 unavailable，不抛错）。 */
        async listWorkspaces() {
            return listWorkspaces(resolveWorkspaceRegistry(this.ownerCtx));
        }
        /** T17：只读查询当前默认模型的可用思考档位（惰性解析，失败降级 available=false）。 */
        async listReasoningEfforts() {
            return listReasoningEfforts(resolveLlmRuntime(this.ownerCtx), resolveDefaultModel(this.ownerCtx));
        }
        /**
         * NapCat 状态（本地补丁，只读）：让设置页能显示「卡在哪一步」并直接扫码，
         * 从而不必盯着 NapCat 那个 GBK 乱码的控制台窗口。
         *
         * 只读诊断 + 读二维码文件；不启动、不终止任何进程。
         */
        async getNapcatStatus() {
            const snapshot = getSettings(this.configEditor(), this.state);
            const launcher = typeof snapshot.config.napcatLauncher === 'string' ? snapshot.config.napcatLauncher : '';
            const port = typeof snapshot.config.port === 'number' ? snapshot.config.port : 8643;
            return buildNapcatStatus(launcher, port);
        }
    }
    markRemote(OnebotSettingsRemote, 'getSettings');
    markRemote(OnebotSettingsRemote, 'updateSettings');
    markRemote(OnebotSettingsRemote, 'listWorkspaces');
    markRemote(OnebotSettingsRemote, 'listReasoningEfforts');
    markRemote(OnebotSettingsRemote, 'getNapcatStatus');
    OnebotSettingsService = OnebotSettingsRemote;
}
else {
    console.warn('[dsh-onebot] @deepseek-ai/dsh-typert-protocol unavailable — onebotSettings remote degrades to a plain cordis service');
    class OnebotSettingsPlain {
        static inject = ['configEditor', 'profileContext'];
        name = NAMESPACE;
        state = createRevisionState();
        ctx;
        constructor(ctx) {
            this.ctx = ctx;
        }
        configEditor() {
            return requireConfigEditor(this.ctx);
        }
        getSettings() {
            return getSettings(this.configEditor(), this.state);
        }
        async updateSettings(patch, expectedRevision) {
            return updateSettings(this.configEditor(), this.state, patch, expectedRevision);
        }
        /** W7：与 typert 分支同一惰性解析 + 降级语义。 */
        async listWorkspaces() {
            return listWorkspaces(resolveWorkspaceRegistry(this.ctx));
        }
        /** T17：与 typert 分支同一惰性解析 + 降级语义。 */
        async listReasoningEfforts() {
            return listReasoningEfforts(resolveLlmRuntime(this.ctx), resolveDefaultModel(this.ctx));
        }
    }
    OnebotSettingsService = OnebotSettingsPlain;
}
export default OnebotSettingsService;
export { OnebotSettingsService };
