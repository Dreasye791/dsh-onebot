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
import { NapcatWatch } from './napcat-watch.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// R1 部署加固：peer 依赖解析失败/关键模块缺失时必须显眼报错并 fail-loud，
// 不能静默不挂载。静态 import 会在本模块任何代码运行之前就以晦涩的
// ERR_MODULE_NOT_FOUND 失败（宿主侧表现为插件被静默跳过），因此运行时
// 值依赖改为入口顶部受控动态加载：失败时先输出含「peer/依赖」的显式
// 错误，再把原错误抛出。
let z;
let OneBotConnection;
let ChatBridge;
let MediaStore;
let IMAGE_MAX_BYTES;
let VOICE_MAX_BYTES;
let MEDIA_MAX_BYTES;
let Transcriber;
let TraceSink;
let InboundRecorder;
let InjectChannel;
let redactSnapshot;
let describeError;
let MIB;
try {
    ;
    ({ default: z } = await import('@deepseek-ai/schemastery'));
    ({ OneBotConnection } = await import('./connection.js'));
    ({ ChatBridge } = await import('./bridge.js'));
    ({ MediaStore, IMAGE_MAX_BYTES, VOICE_MAX_BYTES, MEDIA_MAX_BYTES } = await import('./media.js'));
    ({ Transcriber } = await import('./stt.js'));
    ({ TraceSink } = await import('./trace.js'));
    ({ InboundRecorder } = await import('./record.js'));
    ({ InjectChannel } = await import('./inject.js'));
    ({ redactSnapshot } = await import('./health.js'));
    ({ describeError } = await import('./errors.js'));
    ({ MIB } = await import('./attach.js'));
}
catch (error) {
    // 原生模块缺失与 peer 缺失是两类完全不同的故障：@napi-rs/canvas 属于本包
    // dependencies（自带、不经宿主 peer 路由），装不上是平台/架构或安装不完整；
    // 而「补齐 link-host 链接集」只对 @deepseek-ai/* 有意义。这里单独探一次，
    // 把两类原因分开报，避免用户拿着 peer 的解法去修原生模块。
    let nativeHint = '';
    try {
        await import('@napi-rs/canvas');
    }
    catch (nativeError) {
        nativeHint = '\n另：原生模块 @napi-rs/canvas 也无法加载（'
            + (nativeError instanceof Error ? nativeError.message : String(nativeError))
            + '）—— 这不是 peer 依赖问题：确认平台/架构有预编译包、node_modules 未被裁剪。';
    }
    console.error('[dsh-onebot] 挂载失败：peer 依赖解析失败或关键模块缺失 —— 部署副本必须带完整 node_modules 链接集（scripts/link-host.sh 产物），只复制 lib/ 不够。原始错误：' + (error instanceof Error ? error.message : String(error)) + nativeHint);
    throw error;
}
export const name = 'dsh-onebot';
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions', 'agentDefaultModel', 'agentPresets', 'sessionPersistence', 'workspaceRegistry', 'commands', 'llm'];
const ENV = (name) => process.env[name] ?? '';
/** Default media dir: <dsh-home>/media/onebot (dsh-home = $DSH_HOME or ~/.dsh). */
export function defaultMediaDir() {
    // os.homedir() reads $HOME first and falls back to the passwd entry — the
    // systemd service runs without HOME, so `?? '/tmp'` used to resolve to
    // /tmp/.dsh and preset enumeration hit ENOENT (web log line 14429).
    const home = ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(homedir() || '/tmp', '.dsh');
    return join(home, 'media', 'onebot');
}
/** The dsh data home ($DSH_HOME or ~/.dsh); source of the .agent-presets dir. */
export function dshHome() {
    return ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(homedir() || '/tmp', '.dsh');
}
/** D4a: schema defaults for the renamed fields (referenced by the deprecated-name fallback). */
const INBOUND_IMAGE_MAX_PX = 2048;
const OUTBOUND_IMAGE_MAX_BYTES = IMAGE_MAX_BYTES;
const INBOUND_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const Config = z.object({
    mode: z.union([z.const('reverse'), z.const('forward')]).default('reverse')
        .description('连接模式：reverse = NapCat ws-reverse 拨入（本插件监听端口）；forward = 本插件主动连接 NapCat 的 ws 服务'),
    host: z.string().default('127.0.0.1')
        .description('reverse 模式监听地址；跨机部署（NapCat 从其他机器拨入）需显式改为 0.0.0.0'),
    port: z.number().default(8643)
        .description('reverse 模式监听端口'),
    url: z.string().default('ws://127.0.0.1:3001')
        .description('forward 模式的 NapCat ws 地址'),
    accessToken: z.string().role('secret').default('')
        .description('OneBot access_token（reverse 校验 / forward 发送 Authorization: Bearer）'),
    reconnectMaxAttempts: z.number().default(100)
        .description('forward 模式重连上限：连续失败达到该次数后放弃重连并打印恢复指引；0 = 无限重试（退避间隔封顶 60s）'),
    botQQ: z.string().default('')
        .description('机器人自身 QQ 号；留空则从 meta 事件自动学习'),
    requireMention: z.boolean().default(true)
        .description('群聊是否仅在 @机器人（或回复其消息）时响应'),
    unknownCommand: z.union([z.const('intercept'), z.const('passthrough')]).default('intercept')
        .description('未知斜杠命令处理：intercept（默认）=拦截并提示相近命令或 /help；passthrough=透传给模型（旧行为）'),
    newMessagePolicy: z.union([z.const('queue'), z.const('steer')]).default('queue')
        .description('任务运行中的新消息处理策略（P1）：queue（默认）=排队——新消息在当前任务结束后按序处理为后续回合，等待期间至多提示一次；steer=插话——运行中收到的新普通纯文字消息作为补充指令加入当前任务（模型在下一步读取）并回复提交提示；图片/文件/语音/带引用消息与 [受限用户:仅问答] 消息两种模式下都按排队处理，/steer 命令两种模式下均可用'),
    autoSteerPolicy: z.union([z.const('admin'), z.const('all')]).default('admin')
        .description('steer 模式下自动插话的发送者资格（T9-B 用户裁决 2026-10-12）：admin（默认）=仅管理员可自动插话；all=所有非受限发送者均可。不具备资格的消息按排队处理；/steer 命令始终仅管理员、不受本项影响；queue 模式行为不变'),
    deferredTimeoutMs: z.number().default(600_000)
        .description('等待模型回复超时阈值（毫秒，T3/P2 超时补发）：回合超过该时长没有任何模型输出时提示超时并登记补发跟踪，任务完成后向原聊天自动补发最终文字（走既有出站管线）；发送明确失败最多尝试 3 次（退避），结果不确定时保留记录停止自动重试；/stop 终止该聊天的补发跟踪；0=关闭超时补发'),
    dmPolicy: z.union([z.const('open'), z.const('allowlist'), z.const('disabled')]).default('open')
        .description('私聊策略：open=仅管理员；allowlist=仅 allowFrom；disabled=拒绝所有私聊'),
    groupPolicy: z.union([z.const('open'), z.const('allowlist'), z.const('disabled')]).default('open')
        .description('群聊策略：open=所有群；allowlist=仅 groupAllowFrom；disabled=拒绝所有群'),
    allowFrom: z.array(z.string()).default([])
        .description('dmPolicy=allowlist 时允许私聊的 QQ 号'),
    groupAllowFrom: z.array(z.string()).default([])
        .description('groupPolicy=allowlist 时允许的群号'),
    adminUsers: z.array(z.string()).default([])
        .description('管理员 QQ 号（也可用环境变量 ONEBOT_ALLOWED_USERS 逗号分隔指定）'),
    // 刻意不在 schema 上做 max() 限幅：schemastery 的 max() 在解析期抛
    // ValidationError，cordis 捕获后把整个插件置为 INACTIVE —— 手改 patch 写进一条
    // 129 字符的条目会让 QQ 通道整条不启动，而不是「这条白名单不生效」。限幅改在
    // normalizeMcpToolAllow 里做（丢弃超长项、截断超量尾巴并记 warn），后果收敛到
    // 单个条目。这里放宽到读侧同级的 4096 字符上限，只为挡住明显非法的巨值。
    mcpToolAllow: z.array(z.string().max(4096)).default([])
        .description('QQ 通道可调用的 MCP 工具白名单（默认空 = 禁用全部 MCP）。写法：* 表示全部；mcp__akasha__akasha_search 完整名；mcp__akasha__* 或 akasha 表示整台服务器；akasha_search 表示任意服务器下的同名工具。实际生效的条目为前 256 条、单条 ≤128 字符，超限条目会被忽略并记一条 warn（不影响插件启动）。非 MCP 工具（qq_* 与宿主内置）不受影响'),
    allowAllUsers: z.boolean().default(false)
        .description('放行所有用户（仅开发用；也可用 ONEBOT_ALLOW_ALL_USERS=true）'),
    napcatLauncher: z.string().default('')
        .description('NapCat 启动器路径（可选）。用 NapCat 自带的 launcher-user.bat / launcher-win10-user.bat / launcher.bat / launcher-win10.bat（任选其一：它们已设好 chcp 65001 与 5 个 NAPCAT_* 环境变量，自建脚本漏掉会让 QQ 报「文件已损坏」；末尾 pause 会留一个隐藏 cmd 进程，属正常）。留空则只在未连接时打印排查提示。配合 autoStartNapcat 使用'),
    napcatLauncherArgs: z.array(z.string()).default([])
        .description('传给 napcatLauncher 的额外参数（默认空）。免扫码登录填 ["-q", "<机器人QQ号>"]——NapCat 只认独立的 -q 参数，launcher 示例里的「launcher 123456」位置参数无效；参数中含 shell 元字符（& | < > ^ % ! 双引号）会被忽略并记一条 warn，条目原文不打印'),
    autoStartNapcat: z.boolean().default(false)
        .description('未检测到 NapCat 连接时，是否自动执行 napcatLauncher（默认 false = 插件不启动任何进程，NapCat 完全由你手动管理；开启后最多尝试 2 次，不会杀任何进程）。注意它与 napcatLauncher 是独立的：配了路径但此项为 false 时，路径只用于诊断，不会被拉起'),
    memoryEnabled: z.boolean().default(false)
        .description('是否启用频道记忆工具 qq_memory_remember / qq_memory_recall（默认 false）。记忆按 chat 分区存到 mediaDir/memory/<chat>.jsonl，跨会话不共享、重启不丢；本版是关键词检索（无 embedding），只提供显式工具，不会自动改写每轮 prompt'),
    memoryMaxEntriesPerChat: z.number().min(1).max(5000).default(200)
        .description('单个会话保留的记忆条数上限（超出按时间丢弃最旧，每次写入后裁剪）。每个 chat 独立计算；非整数在工具侧向下取整'),
    memoryRecallTopK: z.number().min(1).max(20).default(5)
        .description('qq_memory_recall 的默认返回条数；调用时可用 limit 覆盖，硬上限 20'),
    memoryProfileScope: z.union([z.const('dm'), z.const('all'), z.const('off')]).default('dm')
        .description('成员画像（kind: profile）能在哪写：dm（默认，只有私聊）/ all（群聊也允许）/ off（关闭画像）。主体自动取「本轮发言者」——私聊是对话对方，群聊从会话最后一条消息的 <user_message qq="…"> 里取；非管理员只能写自己（显式填别人会被拒），管理员不限。群聊默认关只是因为群里给某人建画像容易被当成议论别人，不是技术限制'),
    ignoreSelf: z.boolean().default(true)
        .description('忽略机器人自己发出的消息（防自循环）'),
    interimMessages: z.boolean().default(true)
        .description('是否把模型每步（含工具调用之间的中间回复）的文本立即发出；false 则只发最终回复。true 时：中间消息实时可见、每条在 interimRecallMs 后自动单独撤回、回合结束先发一张整轮 t2i 小结卡再发最终回复'),
    interimRecallMs: z.number().default(90_000)
        .description('中间消息各自发送完成后多久自动单独撤回（毫秒；QQ 撤回时限约 2 分钟，建议 ≤110000）'),
    interimRecall: z.boolean().default(true)
        .description('中间消息撤回开关：true（默认）=每条中间消息在 interimRecallMs 后自动撤回，回合结束先发整轮 t2i 小结卡再立即撤回原消息；false=只发不撤——中间消息照常实时发出但保留在聊天里：不排自动撤回定时器、回合结束不发小结卡也不撤回原消息，只发最终回复'),
    sendErrorNotice: z.boolean().default(true)
        .description('一轮运行出错时向用户发送 ⚠️ 错误提示'),
    rateLimitPerMinute: z.number().default(30)
        .description('每 chat 每分钟允许的普通消息条数上限（60 秒滑动窗口）；命令消息不计入也不受限；超限时每窗口最多提示一次；0=禁用频控'),
    restrictedMemberPrefix: z.boolean().default(true)
        .description('群聊非管理员消息注入 [受限用户:仅问答] 前缀（软限制）'),
    sensitivePatterns: z.array(z.string()).default([])
        .description('出站敏感内容审计正则（默认内置 rm -rf/关机/删库/密钥 等模式；留空用默认）'),
    mediaDir: z.string().default('')
        .description('入站媒体与映射文件目录；留空默认 <dsh-home>/media/onebot'),
    tempTtlHours: z.number().default(6)
        .description('入站临时媒体文件保留时长（小时），到期自动清理'),
    outboundImageMaxBytes: z.number().default(OUTBOUND_IMAGE_MAX_BYTES)
        .description('出站图片大小上限（字节）'),
    maxImageBytes: z.number().deprecated()
        .description('[deprecated] 旧名别名（现 outboundImageMaxBytes）：出站图片大小上限（字节）；本版兼容读取，新配置请用新名'),
    inboundImageMaxPx: z.number().default(INBOUND_IMAGE_MAX_PX)
        .description('入站图片长边上限（像素）；超过则等比压缩后交给视觉模型，<=0 禁用'),
    imageMaxSize: z.number().deprecated()
        .description('[deprecated] 旧名别名（现 inboundImageMaxPx）：入站图片长边上限（像素）；本版兼容读取，新配置请用新名'),
    maxVoiceBytes: z.number().default(VOICE_MAX_BYTES)
        .description('出站语音大小上限（字节）'),
    maxFileBytes: z.number().default(MEDIA_MAX_BYTES)
        .description('出站视频/文件大小上限（字节）'),
    sttEnabled: z.boolean().default(true)
        .description('入站语音是否转写（需要 ffmpeg 和 whisper CLI；失败时降级为 [语音] 占位）'),
    sttEngine: z.union([z.const('auto'), z.const('openai'), z.const('whisper-cpp'), z.const('custom')]).default('auto')
        .description('STT 引擎：auto 自动探测 whisper-cli / whisper / mlx_whisper'),
    sttCommand: z.string().default('')
        .description('custom 引擎的程序名/路径'),
    sttArgs: z.array(z.string()).default([])
        .description('custom 引擎参数模板，{file} 与 {out} 会被替换'),
    sttModel: z.string().default('small')
        .description('whisper 模型（openai: small/base/medium...；whisper.cpp: 模型名或 .bin 绝对路径）'),
    sttTimeoutMs: z.number().default(60_000)
        .description('单次转写超时（毫秒，默认 60000）；超时后占位即终态，不追加转写'),
    textImageThreshold: z.number().default(150)
        .description('回复正文超过该长度（字符数）时渲染为文字图卡片发送；<=0 禁用卡片路径'),
    cardFooter: z.string().default('dsh')
        .description('文字图卡片页脚品牌文字（"Powered by <brand>"）'),
    fontFiles: z.array(z.string()).default([])
        .description('t2i 渲染器注册的字体文件路径（Linux/自定义字体；macOS 自动用系统字体）'),
    fontFamilies: z.array(z.string()).default([])
        .description('t2i 渲染器优先使用的字体家族名（覆盖平台默认）'),
    agentPreset: z.string().default('')
        .description('QQ 会话加入的 agent 预设 id；留空用部署默认（settings 的 agent-presets.default，当前为 router-flash）。创建时总是解析有效预设并写入会话 header，Web 界面可见；resume 优先恢复会话自己记录的预设'),
    reasoningEffort: z.union([z.const(''), z.const('off'), z.const('minimal'), z.const('low'), z.const('medium'), z.const('high'), z.const('xhigh'), z.const('max')]).default('')
        .description('QQ 通道的思考强度覆盖：留空（默认）=继承宿主 agent-default-model 的 reasoningEffort（即 0.9.4 及以前的行为）；填 off/minimal/low/medium/high/xhigh/max 则只影响 QQ 通道创建的会话，Web/GUI 会话不受影响。off = 关闭思考（仅当模型报告 canDisableThinking 时可用，否则宿主会抛 UNSUPPORTED_REASONING_EFFORT，此时请退到 low）；xhigh/max 仅当模型显式声明才合法。面板会按当前模型的真实档位动态收窄可选项'),
    persona: z.string().max(20000).default('')
        .description('QQ 通道的角色设定（人设）：纯文本注入本通道 system prompt 的最前段，用来定语气与说话方式。留空（默认）=不注入，行为与 0.9.4 一致。只影响 QQ 通道，Web/GUI 会话不受影响。保存后对新回合生效（插件级热重启，无需重启 DSH）'),
    memeDir: z.string().default('')
        .description('表情包目录：按 <目录>/<情绪标签>/<图片> 组织的图库（与 dsh-meme 图库同构，可直接拷入）。配置后本通道 agent 多一个 qq_send_meme 工具，可按情绪随机抽或按关键词搜一张发到 QQ。留空（默认）=不注册该工具。该目录必须位于 mediaDir 之内（且不能等于 mediaDir），否则出站围栏会拒发——此时工具在注册阶段就被跳过，模型看不到它'),
    attachInboundImages: z.boolean().default(true)
        .description('入站图片投递给模型的方式（T15）：true（默认）=把图片作为真正的图片块（image block）交给视觉模型，模型能看到像素；false=退回旧行为，只给 [图片:<本地路径>] 文本注解（模型读不到像素）。投递前会经单图大小与总预算两道闸门，任一不过自动退回文本注解，不影响消息可达'),
    attachMaxImageMB: z.number().default(10)
        .description('单张入站图片投递上限（MB，T15）：超过该大小的图片不进附件库，只给路径文本，避免一张巨图吃掉配额；0 = 不限。仅在 attachInboundImages=true 时生效'),
    attachmentBudgetMB: z.number().default(500)
        .description('附件库软上限（MB，T15）：本插件累计贡献的附件字节数达到该值后，新图片不再投递（只给路径文本），软上限本身不删除任何已有文件；0 = 不限。注意宿主附件库按内容寻址去重——同一张图重复出现不会重复占用空间，可用 /storage 查看真实占用与去重命中次数'),
    attachmentRetentionHours: z.number().default(0)
        .description('账本回收窗口（小时，T15）：超过该时长未再出现的附件对象会从本插件的预算记账里移出，把软上限占用还回去；0（默认）= 不回收、记账只增不减。它只改预算记账，不删除 mediaDir 或宿主附件库里的任何文件（宿主对象由宿主自己的清理策略回收）。设了软上限又担心用满后永久拒收时打开它，例如 72'),
    attachmentSaveTimeoutMs: z.number().default(15000)
        .description('单张入站图片投递的宿主写盘超时（毫秒，T15）：超过即放弃本次投递、退回路径文本。因为投递临界区按 mediaDir 全局串行，一次卡死的宿主写盘会堵住所有会话的图片投递，所以默认 15 秒超时；0 = 不超时'),
    workspacePath: z.string().default('')
        .description('QQ 会话的工作区目录（写入会话 cwd，并自动归入该工作区，不存在则创建）；留空时使用宿主进程工作目录并在启动时告警提醒（宿主未提供可编程查询的默认工作区），单聊 /workspace 覆盖优先且已持久化到会话映射文件，重启/恢复失败均不丢失'),
    inboundFileMaxBytes: z.number().default(INBOUND_FILE_MAX_BYTES)
        .description('QQ 入站文件最大字节数（直链/base64 拉取，0 = 不限制）'),
    maxInboundFileBytes: z.number().deprecated()
        .description('[deprecated] 旧名别名（现 inboundFileMaxBytes）：QQ 入站文件最大字节数；本版兼容读取，新配置请用新名'),
    allowPrivateHosts: z.boolean().default(false)
        .description('下载 SSRF 防护逃生门：默认拒绝解析到私网/环回/链路本地地址的下载目标（协议仅 http/https、重定向逐跳复检仍生效）；NapCat 文件服务器或反代部署在本机/内网时置 true 跳过私网检查'),
    chatIdleEvictDays: z.number().default(7)
        .description('会话空闲淘汰天数：chat 超过该天数无任何活动时，在下一条入站消息处理前清理其 agent（会话先落盘 flush、映射保留，之后同一 chat 的消息可 resume 恢复原会话）；0 = 禁用'),
    dedupWindowSeconds: z.number().default(300)
        .description('入站消息去重窗口（秒，W2-②）：同一会话内相同 message_id 在该窗口内重投（断线重连重放等）只处理第一条，后续静默跳过并记 debug；仅对会触发回复处理的消息事件生效（notice/meta 类不经过此闸）；0 = 禁用去重'),
    actionRatePerMinute: z.number().default(20)
        .description('主动写操作每分钟全桥合计上限（W2-③）：约束 qq_send_image/voice/video/file/segments 与 qq_send_forward 等工具发起的主动发送（回合内的被动回复/interim/通知不受此闸，由 rateLimitPerMinute 与离线队列上限约束）；超限拒发并记 warn 与审计；0 = 禁用分钟限额'),
    actionRatePerDay: z.number().default(500)
        .description('主动写操作每日（本地自然日）全桥合计上限（W2-③）：口径同 actionRatePerMinute；超限拒发并记 warn 与审计，次日自动恢复；0 = 禁用日限额'),
    actionAuditEnabled: z.boolean().default(true)
        .description('主动写审计（W2-③）：每次主动写（成功/失败）与拒发事件追加写一行 JSON 到 mediaDir/qq-actions.log（含 ts/chatId/action/ok/reason）；写失败仅 warn 不影响发送'),
    traceEnabled: z.boolean().default(false)
        .description('链路追踪（W1）：为每条入站消息生成 traceId 并贯穿入站→模型回合→出站，决策事件（含限流/去重/白名单/@ 门控/闸门拒发与每个静默丢弃分支的中文 reason）逐行 JSON 落盘 mediaDir/qq-trace.jsonl（4MiB 改名轮转，保留 qq-trace.1/2.jsonl；同一原因 5 分钟限频）；默认关闭——关闭时不生成 traceId、不落盘、决策行为与 0.6.0 完全一致'),
    traceLevel: z.union([z.const('debug'), z.const('warn')]).default('debug')
        .description('追踪事件级别（W1）：debug=记录全部决策事件；warn=仅记录 ok:false（被拒/失败/丢弃）事件'),
    recordInbound: z.boolean().default(false)
        .description('入站录制（W1）：把收到的每条入站事件（含被门控跳过的，附当时决策 reason）按可回放形状逐行 JSON 追加写 mediaDir/qq-inbox.jsonl（2MiB 改名轮转，保留 qq-inbox.1/2.jsonl；注入的帧不会被二次录制）；纯旁路：写失败仅 warn 限频，绝不影响回复管线；默认关闭——零文件零开销'),
    inboxRedact: z.boolean().default(true)
        .description('录制脱敏（W1）：落盘前把帧中 6 位以上的数字串（QQ 号/群号等）脱敏为前 3 位+****（数字型 id 字段一并处理），并剥离媒体 URL 里的 token/sign 类查询参数值；默认开启（录制文件会长期留在 mediaDir 并可能进诊断包）。需要完整原文排障时显式关闭'),
    injectEnabled: z.boolean().default(false)
        .description('事件注入通道（W1，仅调试用——信任边界：注入是调试通道，默认全关，勿在生产开启）：开启后按 injectIntervalMs 轮询 mediaDir/qq-inject.jsonl，把新行喂进真实入站管线（trace 事件标 stage=inject）；启动时已存在的历史行跳过并记一条说明；默认关闭'),
    injectDryRun: z.boolean().default(true)
        .description('注入干跑（W1）：true（默认，强烈建议保持）=注入回合触发的全部出站写操作（发消息/撤回等，含异步模型回合的最终回复——拦截点在出站动作层）被拦截计数、原文进 trace 事件、绝不真发 QQ；false=注入内容会真实发送，仅限隔离环境实验'),
    injectIntervalMs: z.number().default(2000)
        .description('注入队列轮询间隔（毫秒，W1；最小 500）'),
    logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default('info')
        .description('控制台日志级别门槛（debug < info < warn < error）：低于该级别的日志不输出。debug=全部输出（含「session 事件早退」等调试行）；info=常规信息（启动、连接建立、meta 事件等，默认）；warn=仅警告与错误；error=仅错误'),
});
/** D4a: the deprecated config names kept for one release, mapped onto their
 * renamed fields. */
const DEPRECATED_CONFIG_ALIASES = [
    ['imageMaxSize', 'inboundImageMaxPx', INBOUND_IMAGE_MAX_PX],
    ['maxImageBytes', 'outboundImageMaxBytes', OUTBOUND_IMAGE_MAX_BYTES],
    ['maxInboundFileBytes', 'inboundFileMaxBytes', INBOUND_FILE_MAX_BYTES],
];
/** Map deprecated config names onto their renamed fields: a legacy value is
 * honored only while the new name still sits at its schema default (the new
 * name wins when both are configured), each legacy use warns once, and the
 * legacy keys never leak into the effective config. */
export function resolveDeprecatedConfig(config) {
    const resolved = { ...config };
    for (const [oldName, newName, defaultValue] of DEPRECATED_CONFIG_ALIASES) {
        const legacy = resolved[oldName];
        if (legacy === undefined)
            continue;
        console.warn('[dsh-onebot] config "' + oldName + '" is deprecated; rename it to "' + newName + '"');
        delete resolved[oldName];
        if (resolved[newName] === defaultValue)
            resolved[newName] = legacy;
    }
    return resolved;
}
/** Resolve env-var fallbacks into the effective access policy. */
function resolvePolicy(config) {
    const envAdmins = ENV('ONEBOT_ALLOWED_USERS')
        .split(',')
        .map(v => v.trim())
        .filter(v => v !== '');
    const adminUsers = [...new Set([...config.adminUsers, ...envAdmins])];
    return {
        dmPolicy: config.dmPolicy,
        groupPolicy: config.groupPolicy,
        allowFrom: config.allowFrom,
        groupAllowFrom: config.groupAllowFrom,
        adminUsers,
        allowAllUsers: config.allowAllUsers || ENV('ONEBOT_ALLOW_ALL_USERS').toLowerCase() === 'true',
        requireMention: config.requireMention,
    };
}
/**
 * Where does the host peer actually land for this plugin instance?
 *
 * 同一份插件代码在「宿主安装树」与「插件自带 node_modules」两处都能解析成功、
 * 也都能挂载，区别只在类身份是否与宿主同源（双包会静默降级 Remote / instanceof）。
 * 这里取真实落点：宿主对 ESM 与 CJS 两套解析器都做了 peer 路由，因此这条路径
 * 能反映插件实际拿到的是哪一份 —— 只打版本号是区分不出来的（两处可能同版本）。
 */
function describeResolvedPeer() {
    try {
        const pkgPath = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent/package.json');
        const raw = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const version = typeof raw.version === 'string' ? raw.version : '?';
        const where = pkgPath.includes('.asar')
            ? '宿主 asar 内'
            : /[\\/]node_modules[\\/]@deepseek-ai[\\/]/.test(pkgPath) ? '插件自带 node_modules' : '未知位置';
        return '@deepseek-ai/dsh-agent ' + version + '（' + where + '）：' + pkgPath;
    }
    catch (error) {
        return '解析失败：' + (error instanceof Error ? error.message : String(error));
    }
}
/** Loopback bind check (reverse mode): 127.0.0.0/8、::1、localhost。 */
function isLoopbackHost(host) {
    const value = host.trim().toLowerCase();
    return value === 'localhost' || value === '::1' || value === '[::1]' || /^127\./.test(value);
}
/** Plugin version read straight from the package root (lib/ 的上一级)。 */
function readPluginVersion() {
    try {
        const raw = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return typeof raw.version === 'string' ? raw.version : '未知';
    }
    catch {
        return '未知';
    }
}
/** Write the boot report; a failure here must never block mounting. */
function writeStartupReport(mediaDir, lines) {
    try {
        mkdirSync(mediaDir, { recursive: true });
        writeFileSync(join(mediaDir, 'startup-report.txt'), lines.join('\n') + '\n', 'utf8');
    }
    catch (error) {
        console.warn('[dsh-onebot] startup-report 写入失败：' + (error instanceof Error ? error.message : String(error)));
    }
}
/** Severity rank for the logLevel gate (debug < info < warn < error). */
const LOG_LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
/** Log a meta event; periodic heartbeat events are silenced to keep the log readable. */
export function logMetaEvent(selfId, event, minLevel = 'info') {
    const metaType = typeof event.meta_event_type === 'string' ? event.meta_event_type : '';
    if (metaType === 'heartbeat')
        return;
    if (LOG_LEVEL_RANK.info < LOG_LEVEL_RANK[minLevel])
        return;
    console.log('[dsh-onebot] meta event; bot QQ: ' + selfId + '; ' + metaType);
}
/** Mount the plugin. */
export function apply(ctx, config) {
    // D4a: honor the deprecated config names before any consumer reads them.
    config = resolveDeprecatedConfig(config);
    const mediaDir = config.mediaDir !== '' ? config.mediaDir : defaultMediaDir();
    const policy = resolvePolicy(config);
    /** Console log line callback (level, message) — shared by the bridge deps,
     * the connection log port and the host-ready boot gate below (M2-C5b). */
    const log = (level, message) => {
        if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[config.logLevel])
            return;
        const prefix = '[dsh-onebot] ';
        if (level === 'error')
            console.error(prefix + message);
        else if (level === 'warn')
            console.warn(prefix + message);
        else
            console.log(prefix + message);
        // 落盘（本地补丁）：dsh 桌面版是 GUI 进程，stdout 无处可看 —— 这一天里
        // 「插件明明挂了却没有任何提示」的问题根源就在这里。NapCat 相关提示必须
        // 能从文件读到，否则等于没做。写到 mediaDir/onebot.log，按天不轮转但量很小。
        try {
            appendFileSync(join(mediaDir, 'onebot.log'), new Date().toISOString() + ' [' + level + '] ' + message + '\n', 'utf8');
        }
        catch { /* 日志写失败不影响主流程 */ }
    };
    // T20：MCP 白名单闸门依赖宿主的 tools.guard。若宿主没有这个能力，QQ 通道
    // 就没有任何 MCP 权限隔离（profile 根作用域上的全部 MCP 工具会原样交给群友）。
    // 这里在**启动期探测一次**并直接停用通道：
    //   - 不探测的话，失败发生在每个会话的 create 里，会被 registry 的
    //     「retire 后用新 sessionId 重建」循环反复放大约 2 倍，且每条消息都新增
    //     一条 retired id；
    //   - 降级成「跳过闸门继续跑」等于权限闸门静默失效，比通道不可用更危险。
    const toolsPort = ctx.tools;
    if (typeof toolsPort?.guard !== 'function') {
        log('error', 'T20：宿主未提供 tools.guard，无法安装 QQ 通道的 MCP 工具白名单闸门。'
            + '为避免把 profile 里全部 MCP 工具（含数据库工具）直接暴露给群友，'
            + '本插件已停止启动。请升级宿主或改用带 guard 能力的版本。');
        return;
    }
    // T3 方案 B: the host exposes no queryable default workspace —
    // WorkspaceRegistry has no default getter and the session controller's
    // defaultCwd is assembly-internal — so the unconfigured fallback stays the
    // host process cwd. Say so once at mount so a /root surprise is explainable.
    // reverse 模式空 token 会让 connection.start() 抛错，而那个错误会落进入口的通用
    // catch、被归成「peer 依赖解析失败或关键模块缺失」——把用户引去查依赖链接集
    // （与 canvas 那次同类误报）。这里前移成明确中文提示：说清约束、怎么改、有没有替代。
    if (config.mode === 'reverse' && config.accessToken === '') {
        log('error', 'reverse 模式必须配置 accessToken（当前为空，插件将拒绝启动）：它同时是 NapCat 侧 onebot11 反向 WS 的鉴权令牌，'
            + '两侧必须一致。处置：填一个非空字符串，并把 NapCat 的 config/onebot11_<QQ号>.json 中 websocketClients[].token 改成同一个值；'
            + '若确实不需要鉴权，可改用 mode: forward（由 NapCat 开正向 WS 服务端）。');
    }
    if (config.workspacePath === '') {
        log('warn', '未配置 workspacePath：QQ 会话默认目录将使用宿主进程工作目录 ' + process.cwd() + '，建议在配置中设置 workspacePath，避免会话工作区落在宿主启动目录');
    }
    // 启动自检：管理员为空是首装最常见的「装好了但没人能说话」—— dmPolicy=open 的
    // 语义是「只允许管理员私聊」，两者叠加会让通道静默不可用，而 mounted 行里的
    // admins=0 只是个数字，没人会注意。这里显式说清后果与两个出口。
    if (policy.adminUsers.length === 0 && !policy.allowAllUsers) {
        log('warn', '未配置管理员（adminUsers 与 ONEBOT_ALLOWED_USERS 都为空）：dmPolicy=' + config.dmPolicy
            + ' 下私聊只允许管理员，斜杠命令也仅管理员可用，等于无人能与机器人对话。请填 adminUsers，或临时 allowAllUsers: true（仅开发）');
    }
    // 启动自检：把实际解析到的宿主 peer 记进日志与 startup-report。插件代码在
    // 「宿主安装树」与「插件自带 node_modules」两处都能解析成功、也都能挂载，
    // 唯一区别是类身份是否与宿主同源（双包）。不记路径就无法事后判断用的是哪套。
    const peerLine = describeResolvedPeer();
    log('info', '宿主 peer 解析：' + peerLine);
    const connection = new OneBotConnection({
        mode: config.mode,
        host: config.host,
        port: config.port,
        url: config.url,
        accessToken: config.accessToken,
        reconnectMaxAttempts: config.reconnectMaxAttempts,
        callTimeoutMs: 30_000,
        log,
    });
    const media = new MediaStore(mediaDir, config.tempTtlHours, config.inboundImageMaxPx, { maxBytes: config.inboundFileMaxBytes, allowPrivateHosts: config.allowPrivateHosts });
    // W1: the trace sink exists only when explicitly enabled — default off
    // means no sink, no traceIds, no jsonl, zero behavior difference.
    const traceSink = config.traceEnabled
        ? new TraceSink({ dir: mediaDir, level: config.traceLevel, log: (level, message) => log(level, message) })
        : undefined;
    // W1/T5: the inbound recorder exists only when recordInbound is on (pure
    // bypass: its own writer, failures only warn); the inject channel only
    // when injectEnabled is on (DEBUG-ONLY) — both absent by default.
    const recorder = config.recordInbound
        ? new InboundRecorder({ dir: mediaDir, redact: config.inboxRedact, log: (level, message) => log(level, message) })
        : undefined;
    const injectChannel = config.injectEnabled
        ? new InjectChannel({
            dir: mediaDir,
            dryRun: config.injectDryRun,
            intervalMs: config.injectIntervalMs,
            handleEvent: async (event) => bridge.handleInbound(event, { injected: true }),
            trace: traceSink,
            log: (level, message) => log(level, message),
        })
        : undefined;
    const transcriber = new Transcriber({
        enabled: config.sttEnabled,
        engine: config.sttEngine,
        command: config.sttCommand,
        args: config.sttArgs,
        model: config.sttModel,
        timeoutMs: config.sttTimeoutMs,
    });
    connection.onMessage = (event) => {
        void bridge.handleInbound(event);
    };
    connection.onMeta = (event) => {
        logMetaEvent(connection.selfId, event, config.logLevel);
    };
    // W2-②③ gate keys: BridgeConfig (bridge.ts) keeps its declared shape; the
    // pipelines read them off the runtime object via optional intersection
    // members (see InboundContext/OutboundContext.config), so the spread here
    // is the wiring — no bridge.ts change.
    const gateConfig = {
        dedupWindowSeconds: config.dedupWindowSeconds,
        actionRatePerMinute: config.actionRatePerMinute,
        actionRatePerDay: config.actionRatePerDay,
        actionAuditEnabled: config.actionAuditEnabled,
    };
    const bridge = new ChatBridge({
        ctx,
        // M2-C5b: the bridge sees only explicit ports — the session-event feed
        // (this context's own `on`) and the two injectables below; the 'loader'
        // service lookup lives here, not in the bridge.
        hostReady: async () => {
            try {
                const loader = ctx.get('loader');
                await loader?.await();
            }
            catch (error) {
                log('debug', 'loader.await failed: ' + describeError(error));
            }
        },
        // Live llm lookup per call — same semantics as the pre-port live getter.
        llmCatalog: {
            listProviders: () => ctx.llm.listProviders(),
            listModels: provider => ctx.llm.listModels(provider),
        },
        connection,
        dshHome: dshHome(),
        /** T15：宿主附件服务的实时取值器。用函数而非快照——服务可能在插件挂载
         * 之后才就绪；缺失/取值抛错都由 attach.deliverImage 归为 host-unavailable，
         * 自动退回路径文本，绝不影响消息可达。 */
        attachments: () => {
            try {
                return ctx.attachments;
            }
            catch {
                return undefined;
            }
        },
        /** T15：附件库根（宿主所有，仅用于 /storage 容量统计）。 */
        attachmentsDir: join(dshHome(), 'attachments', 'v1'),
        media,
        transcriber,
        agents: ctx.agents,
        sessions: ctx.sessions,
        agentPresets: ctx.agentPresets,
        commands: ctx.commands,
        sessionPersistence: ctx.sessionPersistence,
        workspaceRegistry: ctx.workspaceRegistry,
        agentDefaultModel: ctx.agentDefaultModel,
        defaultModel: () => {
            try {
                return ctx.agentDefaultModel.currentSelection();
            }
            catch {
                return undefined;
            }
        },
        config: {
            botQQ: config.botQQ,
            ignoreSelf: config.ignoreSelf,
            requireMention: config.requireMention,
            unknownCommand: config.unknownCommand,
            newMessagePolicy: config.newMessagePolicy,
            autoSteerPolicy: config.autoSteerPolicy,
            deferredTimeoutMs: config.deferredTimeoutMs,
            interimMessages: config.interimMessages,
            // R-07：读取侧补下限。schema 上刻意不加 min()（解析期抛错会让整个插件
            // 变 INACTIVE），但 <3000ms 的撤回延时等于「中间消息发完就被撤」，是配置
            // 手误的典型后果，这里收敛掉（不静默改配置，只影响运行期行为）。
            interimRecallMs: Math.max(3_000, config.interimRecallMs),
            interimRecall: config.interimRecall,
            sendErrorNotice: config.sendErrorNotice,
            rateLimitPerMinute: config.rateLimitPerMinute,
            restrictedMemberPrefix: config.restrictedMemberPrefix,
            sensitivePatterns: config.sensitivePatterns,
            accessToken: config.accessToken,
            mediaDir,
            maxImageBytes: config.outboundImageMaxBytes,
            maxVoiceBytes: config.maxVoiceBytes,
            maxFileBytes: config.maxFileBytes,
            textImageThreshold: config.textImageThreshold,
            cardFooter: config.cardFooter,
            fontFiles: config.fontFiles,
            fontFamilies: config.fontFamilies,
            agentPreset: config.agentPreset,
            reasoningEffort: config.reasoningEffort,
            persona: config.persona,
            // 留空即不注册 qq_send_meme（与 schema/README 的「留空=不启用」一致）。
            // 不做 mediaDir/memes 隐式回退：那会让「没配置」和「显式配置」不可区分，
            // 也会在用户不知情时把工具塞进模型可见的工具集。
            memeDir: config.memeDir,
            // T20：MCP 工具白名单。默认空数组 = QQ 通道禁用全部 MCP 工具（fail-closed）。
            mcpToolAllow: config.mcpToolAllow,
            // T15：入站图片投递策略（MB → 字节由 attach.MIB 换算，负数/NaN 按不限）。
            attachInboundImages: config.attachInboundImages,
            attachMaxImageBytes: config.attachMaxImageMB * MIB,
            attachmentBudgetBytes: config.attachmentBudgetMB * MIB,
            // 账本回收窗口（小时 → 毫秒）与宿主写盘超时（已是毫秒）。
            attachmentRetentionMs: config.attachmentRetentionHours * 60 * 60 * 1000,
            // R-07：0 = 显式不超时（保留）；>0 时下限 1s —— 原实现里一个极小的值会让
            // 宿主写盘「几乎必然超时」，且投递临界区按 mediaDir 全局串行，等于把所有
            // 会话的图片投递都堵住。
            attachmentSaveTimeoutMs: config.attachmentSaveTimeoutMs <= 0
                ? 0
                : Math.max(1_000, config.attachmentSaveTimeoutMs),
            workspacePath: config.workspacePath,
            maxInboundFileBytes: config.inboundFileMaxBytes,
            chatIdleEvictDays: config.chatIdleEvictDays,
            ...gateConfig,
            trace: traceSink,
            recorder,
            inject: injectChannel,
        },
        policy,
        // W1/T5 health: the config snapshot is redacted at the source — secrets
        // (token/password/apikey…) never leave this closure in the clear.
        configSnapshot: () => redactSnapshot(config),
        log,
    });
    // W3/T4 (P3): connection faults mint QQ-CONN-… references through the
    // bridge (registry + trace + structured log); the transport appends the
    // returned reference to its own log line, so host logs and qq-trace.jsonl
    // share the same number for one fault.
    connection.onFailure = (stage, detail) => bridge.registerConnectionFailure(stage, detail);
    // Lifecycle: start the bridge and transport; unwind everything on unload.
    ctx.effect(() => {
        bridge.start();
        connection.start();
        injectChannel?.start();
        // NapCat 看护（本地补丁）：插件是 WebSocket**服务端**，NapCat 没起来时
        // 通道静默不可用。这里在启动后与运行期定期检查连接状态：未连接则打印
        // 可执行的排查提示；若配置了 napcatLauncher 且 autoStartNapcat 为真，
        // 则尝试自动拉起（最多 2 次，不杀任何进程）。
        const napcatWatch = new NapcatWatch({
            launcher: config.napcatLauncher,
            launcherArgs: config.napcatLauncherArgs,
            autoStart: config.autoStartNapcat,
            // NapCat.Shell 目录由 launcher 的父目录推导；未配置 launcher 时留空，
            // 诊断会退化成静态提示（不猜路径）。
            port: config.port,
            pollIntervalMs: 60_000,
            // 监听地址提示只在「确实没连上」时随诊断一起出现：127.0.0.1 是安全默认值，
            // 但 NapCat 在容器/另一台机器时它必然连不上，做成启动期 warn 就是纯噪声。
            extraHint: config.mode === 'reverse' && isLoopbackHost(config.host)
                ? '提示：当前只监听 ' + config.host + ':' + config.port + '（仅本机可达）。若 NapCat 在 Docker 或另一台机器上，需把 host 改为 0.0.0.0 并放行防火墙'
                : undefined,
            // 拉起器的 stdout/stderr 落盘：注入失败时它会直接退出且不写自己的日志。
            logFile: join(mediaDir, 'napcat-launcher.log'),
            log,
        });
        napcatWatch.start(() => connection.connected);
        // QQ 平台说明与 qq_* 工具现按会话 agent 注入（见 ChatBridge.installChannelScope）
        return async () => {
            napcatWatch.stop();
            await injectChannel?.stop();
            await bridge.stop();
            await connection.stop();
            // R-02：配置热更新会原地重启插件，拆卸时若不 flush，内存里最多 1000 条
            // trace 事件与全部待写录制行会直接丢弃 —— 恰好是排障最需要的那一段。
            await traceSink?.flush().catch(() => undefined);
            await recorder?.flush().catch(() => undefined);
        };
    }, 'dsh-onebot.lifecycle');
    const mountedLine = 'mounted (mode=' + config.mode + ', host=' + config.host + ':' + config.port
        + ', media=' + mediaDir + ', admins=' + policy.adminUsers.length + ')';
    // 桌面版是 GUI 进程，stdout 无处可看 —— mounted 必须经 log 落盘（mediaDir/onebot.log），
    // 否则「挂没挂上、挂的是哪份代码」事后全无线索（排障时已踩过这个坑）。
    log('info', mountedLine);
    writeStartupReport(mediaDir, [
        'dsh-onebot 启动报告 ' + new Date().toISOString(),
        '插件版本：' + readPluginVersion(),
        '宿主 peer：' + peerLine,
        'Node：' + process.version + '（' + process.platform + '/' + process.arch + '）',
        '传输：' + (config.mode === 'reverse' ? 'reverse 监听 ' + config.host + ':' + config.port : 'forward 拨出 ' + config.url),
        'mediaDir：' + mediaDir,
        'workspacePath：' + (config.workspacePath !== '' ? config.workspacePath : '（未配置，使用宿主进程 cwd ' + process.cwd() + '）'),
        '管理员：' + policy.adminUsers.length + (policy.allowAllUsers ? '（allowAllUsers=true）' : ''),
        '日志级别：' + config.logLevel,
    ]);
}
