/**
 * dsh-onebot: a QQ (OneBot 11 / NapCat) chat channel for DeepSeek Harness.
 *
 * Mounts inside the dsh host process: a reverse- or forward-WebSocket link to
 * NapCat, one Agent per QQ chat, inbound images/voice handled for the model
 * (whisper STT when enabled), outbound replies split at sentence boundaries,
 * [[qq_forward]] merged forwards, allowlist/mention access control, and a set
 * of qq_* tools for media and NapCat APIs.
 * @module dsh-onebot
 */
import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import type ToolRuntime from '@deepseek-ai/dsh-tools';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type Z from '@deepseek-ai/schemastery';
import type { OneBotEvent } from './connection.js';
type Context = CordisContext & {
    tools: ToolRuntime;
    systemPrompt: SystemPrompt;
    agents: AgentRegistry;
    sessions: SessionStore;
    agentDefaultModel: {
        currentSelection(): ModelSelection | undefined;
        saveSelection(next: ModelSelection): Promise<void>;
    };
    agentPresets: {
        readonly defaultId: string;
        resolve(id?: string): Promise<{
            id: string;
        }>;
        mount(agentCtx: unknown, id?: string): Promise<{
            id: string;
        }>;
    };
    sessionPersistence: {
        /** dsh-session-persistence 0.1.6 `stat`: the stored snapshot, or
         * undefined when the id owns no durable log (the retired `inspect`
         * convenience no longer exists on the host service). */
        stat(id: string): Promise<object | undefined>;
        /** /session list previews: open a stored session read-only (never takes
         * write ownership), read the header + a small event prefix, then close. */
        open(id: string, access: 'read'): Promise<{
            header: {
                createdAt?: number;
                agentPreset?: string;
            };
            read(offset?: number, length?: number): Promise<{
                events: readonly {
                    type?: string;
                    data?: {
                        agentPreset?: string;
                        source?: {
                            kind?: string;
                        };
                        content?: readonly {
                            type?: string;
                            text?: string;
                        }[];
                    };
                }[];
            }>;
            close(): Promise<void>;
        }>;
    };
    workspaceRegistry: {
        resolveByPath(path: string): Promise<{
            id: string;
            path: string;
            sessionIds: readonly string[];
            attachSession(sessionId: string): Promise<void>;
        } | undefined>;
        create(path: string, title?: string): Promise<{
            id: string;
            path: string;
            sessionIds: readonly string[];
            attachSession(sessionId: string): Promise<void>;
        }>;
        list(): Array<{
            id: string;
            path: string;
            sessionIds: readonly string[];
        }>;
    };
    commands: {
        execute(agent: unknown, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<{
            kind?: string;
            text?: string;
            result?: {
                kind?: string;
                text?: string;
            };
        }>;
    };
};
export declare const name = "dsh-onebot";
export declare const inject: string[];
/** QQ 通道可选的思考强度档位。'' = 不覆盖，继承宿主 agent-default-model
 * 的 reasoningEffort（保持 0.9.4 及以前的行为）。其余取值必须是 pi-ai 的
 * THINKING_LEVELS 档位名（off/minimal/low/medium/high/xhigh/max）——宿主
 * 的 installModelSelection 会把它原样塞进 agent/request 的 modelOptions，再由
 * 适配器的 resolveReasoningLevel 逐个比对 getSupportedThinkingLevels(model)，
 * 名字不在其中直接抛 UNSUPPORTED_REASONING_EFFORT。
 * 注意「关闭思考」的档位名是 off，不是 none：none 只是 codebuddy-cli 在
 * canDisableThinking 模型上的 wire 拼写，pi-ai 层面不存在名为 none 的档位。 */
export type ReasoningEffort = '' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Plugin configuration (validated by schemastery). */
export interface Config {
    mode: 'reverse' | 'forward';
    host: string;
    port: number;
    url: string;
    accessToken: string;
    /** Forward-mode reconnect attempt limit; 0 = retry forever. */
    reconnectMaxAttempts: number;
    botQQ: string;
    requireMention: boolean;
    /** Unknown slash-command handling: intercept（默认）=拦截并给建议；passthrough=透传给模型。 */
    unknownCommand: 'intercept' | 'passthrough';
    /** T2 (P1): 任务运行中的新消息处理策略：queue=排队（默认）；steer=插话进当前任务。 */
    newMessagePolicy: 'queue' | 'steer';
    /** T9-B (用户裁决 2026-10-12)：steer 模式下自动插话资格：admin=仅管理员（默认）；all=不限。 */
    autoSteerPolicy: 'admin' | 'all';
    /** T3 (P2): 等待模型回复超时阈值（毫秒）——超时后登记补发跟踪、回合完成后向原聊天补发最终文字；0=关闭。 */
    deferredTimeoutMs: number;
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    allowFrom: string[];
    groupAllowFrom: string[];
    adminUsers: string[];
    allowAllUsers: boolean;
    ignoreSelf: boolean;
    /**
     * NapCat 启动器路径（本地补丁，可选）。
     *
     * NapCat 是插件的**外部依赖**：插件在 8643 上监听，等它以反向 WebSocket
     * 连进来。NapCat 没起来时通道静默不可用，只能靠翻它的日志猜。配上这个路径
     * 后，插件能在检测到未连接时自己把 NapCat 拉起来（需配合 autoStartNapcat）。
     * 留空 = 只在未连接时打印排查提示，不启动任何进程。
     */
    napcatLauncher: string;
    /** 是否允许插件在未连接时自动执行 napcatLauncher（默认 false，需显式开启） */
    autoStartNapcat: boolean;
    interimMessages: boolean;
    /** Per-interim auto-recall delay (ms) from each interim's send completion. */
    interimRecallMs: number;
    /** M3-D2b: interim recall degrade switch (false = send-only interims). */
    interimRecall: boolean;
    sendErrorNotice: boolean;
    /** Per-chat per-minute sliding-window cap for normal (non-command) messages; 0 disables. */
    rateLimitPerMinute: number;
    restrictedMemberPrefix: boolean;
    sensitivePatterns: string[];
    mediaDir: string;
    tempTtlHours: number;
    outboundImageMaxBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
    inboundImageMaxPx: number;
    /** @deprecated D4a alias of inboundImageMaxPx; honored for one release. */
    imageMaxSize?: number;
    /** @deprecated D4a alias of outboundImageMaxBytes; honored for one release. */
    maxImageBytes?: number;
    sttEnabled: boolean;
    sttEngine: 'auto' | 'openai' | 'whisper-cpp' | 'custom';
    sttCommand: string;
    sttArgs: string[];
    sttModel: string;
    sttTimeoutMs: number;
    textImageThreshold: number;
    cardFooter: string;
    fontFiles: string[];
    fontFamilies: string[];
    agentPreset: string;
    /** QQ 通道的思考强度覆盖：留空（默认）=继承宿主 agent-default-model 的
     * reasoningEffort；非空则本通道创建/恢复的每个 agent 都用该值，不影响
     * Web/GUI 会话。合法值取自 codebuddy-cli 适配器的 STANDARD_EFFORTS。 */
    reasoningEffort: ReasoningEffort;
    /** T11：QQ 通道角色设定（人设）文本；'' = 不注入（0.9.4 行为）。 */
    persona: string;
    /** T12：表情包目录；'' = 不注册 qq_send_meme。须位于 mediaDir 之内。 */
    memeDir: string;
    /** T20：QQ 通道的 MCP 工具白名单（fail-closed）。
     *
     * MCP 工具注册在 profile 根作用域，而作用域视图沿链向下继承 —— 不设闸门时
     * QQ 会话（子作用域）会白拿 profile 里所有 MCP 服务器（含 dbx 的数据库工具）
     * 的调用权。这里按调用期 guard 拦截，只放行名单内的 MCP 工具；**空数组 =
     * 禁用全部 MCP 工具**（默认值，与 mcpToolAllow 未配置时行为一致）。
     * 支持 `*`、完整工具名 `mcp__akasha__akasha_search`、`mcp__akasha__*`、
     * 服务器名 `akasha`、裸工具名 `akasha_search` 五种写法。非 MCP 工具
     * （qq_* 与宿主内置）不受本闸门影响。 */
    mcpToolAllow: string[];
    /** T15：入站图片是否投递为真图片块（默认 true）；false = 只给路径文本，
     * 与 T15 之前的行为一致。 */
    attachInboundImages: boolean;
    /** T15：单张入站图片投递上限（MB）；超过则只给路径文本。0 = 不限。 */
    attachMaxImageMB: number;
    /** T15：附件库软上限（MB），按本插件贡献的字节数计；0 = 不限。 */
    attachmentBudgetMB: number;
    /** T15：账本回收窗口（小时）——`lastSeenAt` 早于 now-该时长的条目在下次
     * 投递前移出记账，把软上限占用还回去。只改本插件的预算记账，不删任何文件。
     * 0 = 不回收（保持只增不减的旧行为）。 */
    attachmentRetentionHours: number;
    /** T15：单次入站图片投递的宿主写盘超时（毫秒）；0 = 不超时。 */
    attachmentSaveTimeoutMs: number;
    workspacePath: string;
    inboundFileMaxBytes: number;
    /** @deprecated D4a alias of inboundFileMaxBytes; honored for one release. */
    maxInboundFileBytes?: number;
    /** B8c: chats idle longer than this many days are evicted (0 disables). */
    chatIdleEvictDays: number;
    /** Escape hatch: skip the download private-address check (local reverse proxy). */
    allowPrivateHosts: boolean;
    /** W2-②: inbound (chatId, message_id) dedup window in seconds; 0 disables. */
    dedupWindowSeconds: number;
    /** W2-③: bridge-wide proactive-write (qq_send_* tools) cap per minute; 0 disables. */
    actionRatePerMinute: number;
    /** W2-③: bridge-wide proactive-write cap per calendar day; 0 disables. */
    actionRatePerDay: number;
    /** W2-③: proactive-write audit jsonl (mediaDir/qq-actions.log). */
    actionAuditEnabled: boolean;
    /** W1: decision-trace jsonl (mediaDir/qq-trace.jsonl); default off — zero
     * file, zero behavior difference vs 0.6.0. */
    traceEnabled: boolean;
    /** W1: trace level; 'warn' records only ok:false (rejected/failed/dropped) events. */
    traceLevel: 'debug' | 'warn';
    /** W1/T5: record every inbound event into mediaDir/qq-inbox.jsonl (default off). */
    recordInbound: boolean;
    /** W1/T5: mask 6+ digit runs (QQ/group numbers) in the recording (default off). */
    inboxRedact: boolean;
    /** W1/T5 (DEBUG-ONLY): enable the qq-inject.jsonl injection channel (default off). */
    injectEnabled: boolean;
    /** W1/T5: intercept all outbound writes of injected rounds (default true). */
    injectDryRun: boolean;
    /** W1/T5: inject queue poll interval in ms (min 500). */
    injectIntervalMs: number;
    /** Console log gate: messages below this level are dropped (debug < info < warn < error). */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}
/** Default media dir: <dsh-home>/media/onebot (dsh-home = $DSH_HOME or ~/.dsh). */
export declare function defaultMediaDir(): string;
/** The dsh data home ($DSH_HOME or ~/.dsh); source of the .agent-presets dir. */
export declare function dshHome(): string;
export declare const Config: Z<Config>;
/** Map deprecated config names onto their renamed fields: a legacy value is
 * honored only while the new name still sits at its schema default (the new
 * name wins when both are configured), each legacy use warns once, and the
 * legacy keys never leak into the effective config. */
export declare function resolveDeprecatedConfig(config: Config): Config;
/** Log a meta event; periodic heartbeat events are silenced to keep the log readable. */
export declare function logMetaEvent(selfId: string, event: OneBotEvent, minLevel?: Config['logLevel']): void;
/** Mount the plugin. */
export declare function apply(ctx: Context, config: Config): void;
export {};
