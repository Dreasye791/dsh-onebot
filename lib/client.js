/**
 * dsh-onebot — client bundle（QQ Bot 设置面板，T4 · T1 定案 B 路径）
 *
 * 结构模板：dsh-expert-orchestrator/lib/client.js（CJS 包裹 + slots/remote 挂载模式），
 * 业务与契约全部对齐本仓库 docs/settings-page-design.md（T1 定案）与宿主侧
 * lib/settings-remote.js（T3 实现）。契约唯一来源：T1 §3 / §3.1 / §4 / §5。
 *
 * 宿主装载契约（对照 0.1.7-alpha.2 dsh-client-modules 校验与 expert-orchestrator 先例）：
 *   - CJS 包裹：banner `window.__ModuleLoader__.load({ id, factory: (require) => {`，
 *     footer `return module.exports; } });`；externals 仅 react（平台冻结模块表）。
 *   - 入口导出 `inject`（宿主客户端服务名数组）与 `apply(ctx) => disposer`。
 *   - 面板注册：`ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
 *     {name, key, locale}, render))`（keyed，key = 组合包 npm 包名）。
 *   - 数据通道：Typert Remote（`ctx.remote.$mount(ONEBOT_SETTINGS_REMOTE)` 后
 *     `ctx.get('remote.onebotSettings')`）；所有读写经 Remote 调 host 侧，host 经
 *     configEditor.edit 写 profile patch 中 dsh-onebot 条目的 config 覆盖行
 *     （T1 §3：设置页/手改 patch/宿主原生设置页三方同源）。
 *
 * descriptor 同步说明（重要）：宿主侧 lib/settings-remote.js（T3）导出的是
 * SETTINGS_GROUPS / SCHEMA_DEFAULTS / SECRET_KEYS / 服务实现，**未导出客户端
 * Typert descriptor 数组**（descriptor 是浏览器侧 client bundle 的挂载清单，
 * host 侧服务经原型发现注册，两侧各持一份）。因此本文件内联定义
 * ONEBOT_SETTINGS_DESCRIPTORS，并以下述不变量与宿主侧逐字对齐（由
 * tests/client-settings.spec.ts 对 src/settings-remote.js 的导出常量断言）：
 *   - namespace/service = `onebotSettings`（T1 §4）；
 *   - 方法集 = getSettings() / updateSettings(patch, expectedRevision) /
 *     listWorkspaces()（W7：只读查询宿主 workspace 注册表，{available, workspaces:
 *     [{id,path,sessionCount}]}；registry 缺席降级 available:false 不抛错），
 *     全 positional（宿主网关 methodParameterNames 拒绝解构/默认值/rest）；
 *   - 快照结构 = T1 §3 OnebotSettingsSnapshot（revision/entryActive/config(38 键)/
 *     secrets/groups/effect='restart'），accessToken 恒 ''（脱敏，T1 §3）；
 *   - 四组 38 键分组与 schema 默认值 = T1 §4 表 + W6 诊断组 + W7 workspacePath + T2 newMessagePolicy + T9 autoSteerPolicy + T10 reasoningEffort + T11 persona + T12 memeDir + T15 attach 三键
 *     = src/settings-remote.ts 常量。
 * 任一侧变更 descriptor/分组/键集/默认值时，必须同步本文件并在 DEVLOG 记录。
 *
 * 生效语义（T1 §5）：19 键统一「保存即热生效」——插件 fiber 秒级原地重启，
 * QQ 桥（NapCat ws-reverse/forward）自动重连；在途回合中断、频控窗口与中间
 * 消息缓冲清零；会话映射/历史不受影响。保存冲突（onebot-settings/conflict）
 * 时提示并重拉快照（revision 语义 = T1 §3.1，任何来源的已提交变更都 +1）。
 */

window.__ModuleLoader__.load({
	id: "dsh-onebot-qq",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		//#region 外部模块（平台冻结表内：react）
		var reactModule = require("react");
		var React = reactModule != null && typeof reactModule.createElement === "function"
			? reactModule
			: reactModule.default;
		if (React == null || typeof React.createElement !== "function") {
			throw new Error("dsh-onebot client: react 不可用");
		}
		//#endregion

		//#region 常量
		var PLUGIN_ID = "dsh-onebot-qq";
		var REMOTE_NS = "onebotSettings"; // Typert Remote 命名空间（T1 §4，与 host 服务键一致）
		var NS = "dsh-onebot"; // locale 命名空间
		//#endregion

		//#region 四组 38 键字段定义（T1 §4 表 + W6 诊断组 + W7 workspacePath + T2 newMessagePolicy + T9 autoSteerPolicy + T10 reasoningEffort + T11 persona + T12 memeDir + T15 attach 三键 + T15 attach 三键：分组/键集/类型/默认值；与
		//  src/settings-remote.ts SETTINGS_GROUPS / SCHEMA_DEFAULTS / 类型分组逐字对齐，
		//  tests/client-settings.spec.ts 断言一致性。数值键 dedupWindowSeconds/
		//  actionRatePerMinute/actionRatePerDay/injectIntervalMs 与枚举键 traceLevel
		//  本期不上面板（host 白名单同样不含），仍走 patch config 手改——取舍见 DEVLOG W6。）
		/** 字段类型：enum（下拉）/ number / boolean / string / stringArray（多行文本，一行一项）/ textarea（多行自由文本，T11 persona）/ secret（密码型）。 */
		var GROUPS = [
			{
				id: "connection",
				title: "连接",
				fields: [
					{ key: "mode", label: "连接模式", type: "enum", options: ["reverse", "forward"], optionLabels: { reverse: "反向 WebSocket（NapCat 连接本插件）", forward: "正向 WebSocket（插件连接 NapCat）" }, hint: "reverse 时监听下方地址与端口；forward 时连接下方服务器地址。" },
					{ key: "host", label: "反向 WS 监听地址", type: "string", hint: "仅 reverse 模式生效。" },
					{ key: "port", label: "反向 WS 监听端口", type: "number", hint: "仅 reverse 模式生效。" },
					{ key: "url", label: "正向 WS 服务器地址", type: "string", hint: "仅 forward 模式生效，如 ws://127.0.0.1:3001。" },
					{ key: "accessToken", label: "访问令牌（AccessToken）", type: "secret", hint: "与 NapCat 侧一致的鉴权令牌；留空 = 不修改，勾选清除后保存 = 清空。" },
					{ key: "botQQ", label: "机器人 QQ 号", type: "string" },
					// W7：workspacePath 入面板（connection 组键序追加）。语义（对齐 README「会话工作区选择」）：
					// 修改只对新会话生效；已设 per-chat /workspace 覆盖的会话不受影响。
					{ key: "workspacePath", label: "会话默认工作区路径", type: "string", hint: "QQ 会话的工作区目录；保存后仅对新会话生效，已用 /workspace 设置 per-chat 覆盖的会话不受影响。留空 = 宿主进程工作目录。（配置键 workspacePath）" },
					// T12：memeDir 入面板（connection 组键序追加）。语义见 README「表情包」：
					// 目录结构 <memeDir>/<情绪标签>/<图片>；留空 = 不注册 qq_send_meme 工具。
					// T16：必须位于 mediaDir 之内（出站围栏只放行 mediaDir），否则工具不注册。
					{ key: "memeDir", label: "表情包目录", type: "string", hint: "表情包根目录，子目录名即情绪标签（如 happy/sad/angry），其下放图片文件；平铺的图片归入 all 标签。留空 = 不启用表情包功能（不注册 qq_send_meme 工具）。必须位于媒体目录（mediaDir）之内且不能就是它本身，否则出站围栏发不出去，工具不会注册。（配置键 memeDir）" },
					// T15：入站图片投递与附件库容量（connection 组键序追加）。语义见 README
					// 「图片与容量管理」；MB 是面板展示单位，schema 侧负责换算成字节。
					{ key: "attachInboundImages", label: "入站图片投递给模型", type: "boolean", hint: "开启后 QQ 里发的图片作为真正的图片内容交给模型（模型能「看见」图），而不是只给一个本地路径。关闭 = 仅提供路径文本，节省附件库空间。（配置键 attachInboundImages）" },
					{ key: "attachMaxImageMB", label: "单张图片投递上限（MB）", type: "number", hint: "超过该大小的图片不投递，改为只提供路径文本。0 = 不限制。默认 10 MB。（配置键 attachMaxImageMB）" },
					{ key: "attachmentBudgetMB", label: "附件库软上限（MB）", type: "number", hint: "本插件投递到附件库的累计容量上限；达到后新图片只提供路径，不会中断对话。宿主按内容去重，同一张图只占一份。0 = 不限制。可用 /storage 查看真实占用。（配置键 attachmentBudgetMB）" },
					{ key: "attachmentRetentionHours", label: "账本回收窗口（小时）", type: "number", hint: "超过该时长未再出现的图片会从本插件的预算记账里移出，把软上限占用还回去（只改记账，不删任何文件）。0 = 不回收，记账只增不减——软上限用满后会一直拒收新图。设了上限又怕用满时填一个，如 72。（配置键 attachmentRetentionHours）" },
					{ key: "attachmentSaveTimeoutMs", label: "投递写盘超时（毫秒）", type: "number", hint: "单张图片交给宿主落盘的等待上限；超时就放弃本次投递、退回路径文本。投递按 mediaDir 全局串行，一次卡住的写盘会堵住所有会话的图片，因此默认 15 秒。0 = 不超时。（配置键 attachmentSaveTimeoutMs）" },
				],
			},
			{
				id: "permissions",
				title: "权限",
				fields: [
					{ key: "requireMention", label: "群聊必须 @ 机器人", type: "boolean" },
					{ key: "adminUsers", label: "管理员用户列表", type: "stringArray", hint: "每行一个 QQ 号。" },
					{ key: "dmPolicy", label: "私聊策略", type: "enum", options: ["open", "allowlist", "disabled"], optionLabels: { open: "开放", allowlist: "白名单", disabled: "禁用" } },
					{ key: "groupPolicy", label: "群聊策略", type: "enum", options: ["open", "allowlist", "disabled"], optionLabels: { open: "开放", allowlist: "白名单", disabled: "禁用" } },
					{ key: "allowAllUsers", label: "允许所有用户", type: "boolean", hint: "关闭时仅管理员可触发。" },
					{ key: "allowFrom", label: "私聊白名单", type: "stringArray", hint: "每行一个 QQ 号，仅白名单策略生效。" },
					{ key: "groupAllowFrom", label: "群聊白名单", type: "stringArray", hint: "每行一个群号，仅白名单策略生效。" },
					{ key: "mcpToolAllow", label: "MCP 工具白名单", type: "stringArray", hint: "每行一条，留给 QQ 通道可调用的 MCP 工具。留空 = 禁用全部 MCP（默认）。写法：* 全部；mcp__akasha__akasha_search 完整名；mcp__akasha__* 或 akasha 整台服务器；akasha_search 任意服务器下的同名工具。通配只认 * 与 mcp__<服务器>__*，其它含 * 的写法会被忽略并记 warn；mcp__<服务器>__* 只覆盖单段工具名（服务器名自身含 __ 或以 _ 结尾时须写全名或显式通配）。生效上限：前 256 条、单条 ≤128 字符，超限条目忽略但不影响插件启动。qq_* 与宿主内置工具不受影响。" },
				],
			},
			{
				id: "behavior",
				title: "行为",
				fields: [
					{ key: "interimMessages", label: "中间消息", type: "boolean", hint: "回合进行中发送流式中间消息。" },
					{ key: "interimRecall", label: "自动撤回中间消息", type: "boolean" },
					{ key: "interimRecallMs", label: "中间消息保留时长（毫秒）", type: "number" },
					{ key: "sendErrorNotice", label: "发送错误通知", type: "boolean" },
					{ key: "unknownCommand", label: "未知命令处理", type: "enum", options: ["intercept", "passthrough"], optionLabels: { intercept: "拦截", passthrough: "透传" } },
					{ key: "rateLimitPerMinute", label: "每分钟消息频率上限", type: "number" },
					{ key: "newMessagePolicy", label: "任务运行中的新消息", type: "enum", options: ["queue", "steer"], optionLabels: { queue: "排队", steer: "插话" }, hint: "任务运行中收到新普通消息：排队=当前任务结束后按序处理（每回合至多提示一次）；插话=作为补充指令加入当前任务。图片/文件/语音/引用消息与受限用户始终按排队处理。（配置键 newMessagePolicy）" },
					{ key: "autoSteerPolicy", label: "自动插话资格", type: "enum", options: ["admin", "all"], optionLabels: { admin: "仅管理员", all: "所有成员" }, hint: "插话模式下运行中收到的新普通纯文字消息谁可自动插话：仅管理员（默认）或所有成员。不具备资格的消息按排队处理；/steer 命令始终仅管理员；受限用户任何档都不自动插话。（配置键 autoSteerPolicy）" },

					{ key: "deferredTimeoutMs", label: "等待模型回复超时（毫秒）", type: "number", hint: "回合超过该时长无任何模型输出时提示超时并登记补发跟踪，任务完成后自动补发最终文字（超时补发）；发送失败最多重试 3 次，结果不确定时停止自动重试；/stop 终止该聊天的补发跟踪。0=关闭。（配置键 deferredTimeoutMs）" },
					{ key: "reasoningEffort", label: "思考强度", type: "enum", options: ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"], optionLabels: { "": "继承宿主默认（继承全局设置）", off: "关闭思考", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "极高" }, hint: "本 QQ 通道创建/恢复会话时覆盖宿主的 reasoningEffort，只影响 QQ 通道，Web/GUI 会话不受全局设置影响。留空（默认）=继承宿主 agent-default-model 的设置（即 0.9.4 及以前的行为）。off=关闭思考（仅模型声明 canDisableThinking 时可用，否则宿主报 UNSUPPORTED_REASONING_EFFORT，此时请退到 low）。保存后对新回合生效（插件级热重启，无需重启 DSH）。（配置键 reasoningEffort）" },
					// T11：人设层——注入 system prompt 最前段，只影响 QQ 通道的语气与说话方式。
					{ key: "persona", label: "角色设定（人设）", type: "textarea", rows: 14, placeholder: "留空 = 不设人设（0.9.4 行为）。示例：\n你是一个说话简短、口语化的人，不用敬语，不每次都总结。", hint: "纯文本注入本通道 system prompt 最前段，用来定语气与说话方式（你是谁、怎么说话、有什么偏好）。留空（默认）=不注入人设层。只影响 QQ 通道，Web/GUI 会话不受影响。保存后对新回合生效（插件级热重启，无需重启 DSH）。（配置键 persona）" },
				],
			},
			{
				id: "diagnostics",
				title: "诊断",
				fields: [
					{ key: "actionAuditEnabled", label: "主动写审计", type: "boolean", hint: "每次主动发送/转发记一行审计到 qq-actions.log（含限额拦截）；关闭后拦截不再留审计痕迹。（配置键 actionAuditEnabled）" },
					{ key: "traceEnabled", label: "决策追踪（trace）", type: "boolean", hint: "把每个入站/出站决策事件写入 qq-trace.jsonl 便于排查；关闭后零文件、行为与关闭时完全一致。（配置键 traceEnabled）" },
					{ key: "recordInbound", label: "入站事件录制", type: "boolean", hint: "把收到的每条消息事件录制到 qq-inbox.jsonl（可离线回放）；关闭后不录制、无法回放。（配置键 recordInbound）" },
					{ key: "inboxRedact", label: "录制脱敏", type: "boolean", hint: "录制时把 QQ 号/群号等 6 位以上数字串打码，并剥离媒体 URL 中的 token/sign 查询参数；默认开启，关闭后录制文件含明文信息，注意隐私。（配置键 inboxRedact）" },
					{ key: "injectEnabled", label: "事件注入（仅调试）", type: "boolean", hint: "轮询 qq-inject.jsonl 把文件里的消息喂进真实管线，离线调试用；生产环境勿开。（配置键 injectEnabled）" },
					{ key: "injectDryRun", label: "注入 dry-run", type: "boolean", hint: "拦截注入回合产生的所有出站发送（默认开）；关闭后注入消息会真实发出，仅限隔离环境。（配置键 injectDryRun）" },
				],
			},
		];
		/** 全部 38 键扁平表（顺序 = 四组声明顺序，与 host ALL_KEYS 语义一致；T2 起含 newMessagePolicy、T9 起含 autoSteerPolicy、T3 起含 deferredTimeoutMs）。 */
		var ALL_FIELDS = [];
		for (var groupIndex = 0; groupIndex < GROUPS.length; groupIndex++) {
			for (var fieldIndex = 0; fieldIndex < GROUPS[groupIndex].fields.length; fieldIndex++) {
				ALL_FIELDS.push(GROUPS[groupIndex].fields[fieldIndex]);
			}
		}
		/** schema 默认值（T1 §4 表；重置按钮与空快照兜底的唯一来源；与
		 *  src/settings-remote.ts SCHEMA_DEFAULTS 逐字对齐）。 */
		var DEFAULTS = {
			mode: "reverse",
			host: "127.0.0.1",
			port: 8643,
			url: "ws://127.0.0.1:3001",
			accessToken: "",
			botQQ: "",
			workspacePath: "",
			memeDir: "",
			attachInboundImages: true,
			attachMaxImageMB: 10,
			attachmentBudgetMB: 500,
			attachmentRetentionHours: 0,
			attachmentSaveTimeoutMs: 15000,
			requireMention: true,
			adminUsers: [],
			dmPolicy: "open",
			groupPolicy: "open",
			allowAllUsers: false,
			allowFrom: [],
			groupAllowFrom: [],
			mcpToolAllow: [],
			interimMessages: true,
			interimRecall: true,
			interimRecallMs: 90000,
			sendErrorNotice: true,
			unknownCommand: "intercept",
			rateLimitPerMinute: 30,
			newMessagePolicy: "queue",
			autoSteerPolicy: "admin",
			deferredTimeoutMs: 600000,
			reasoningEffort: "",
			persona: "",
			actionAuditEnabled: true,
			traceEnabled: false,
			recordInbound: false,
			inboxRedact: true,
			injectEnabled: false,
			injectDryRun: true,
		};
		/** 分组 → 键数组（与 host SETTINGS_GROUPS 同构；供契约核对与快照渲染兜底）。 */
		var GROUP_KEYS = {};
		for (var gk = 0; gk < GROUPS.length; gk++) {
			GROUP_KEYS[GROUPS[gk].id] = GROUPS[gk].fields.map(function (field) { return field.key; });
		}
		//#endregion

		//#region 极简 schema 校验（替代 zod，供 Typert 严格 codec 使用；与模板同款）
		function vString(min, max) {
			return {
				parse(value) {
					if (typeof value !== "string" || value.length < min || value.length > max) {
						throw new TypeError("expected string(" + min + ".." + max + ")");
					}
					return value;
				},
			};
		}
		function vInt(min) {
			return {
				parse(value) {
					if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
						throw new TypeError("expected int>=" + min);
					}
					return value;
				},
			};
		}
		function vNumber(min, max) {
			return {
				parse(value) {
					if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("expected finite number");
					if (min !== undefined && value < min) throw new TypeError("expected number >= " + min);
					if (max !== undefined && value > max) throw new TypeError("expected number <= " + max);
					return value;
				},
			};
		}
		function vBoolean() {
			return {
				parse(value) {
					if (typeof value !== "boolean") throw new TypeError("expected boolean");
					return value;
				},
			};
		}
		function vArray(item) {
			return {
				parse(value) {
					if (!Array.isArray(value)) throw new TypeError("expected array");
					return value.map((entry) => item.parse(entry));
				},
			};
		}
		/** 可选字段：缺席（undefined/null）时保持缺席，不参与 parse。 */
		function vOptional(inner) {
			return {
				parse(value) {
					if (value === undefined || value === null) return undefined;
					return inner.parse(value);
				},
			};
		}
		/** 与 zod object 默认行为一致：声明外字段剥离，声明内字段逐个 parse。 */
		function vObject(shape) {
			return {
				parse(value) {
					if (value === null || typeof value !== "object" || Array.isArray(value)) {
						throw new TypeError("expected object");
					}
					var out = {};
					for (var key of Object.keys(shape)) out[key] = shape[key].parse(value[key]);
					return out;
				},
			};
		}
		function vEnum(values) {
			return {
				parse(value) {
					if (typeof value !== "string" || values.indexOf(value) < 0) {
						throw new TypeError("expected one of " + values.join("|"));
					}
					return value;
				},
			};
		}
		//#endregion

		//#region Remote 契约 schema（与 host lib/settings-remote.js 快照/校验逐字对齐）
		/** 38 键生效值（host buildSnapshot 的 effectiveConfig 全键返回；accessToken 恒 ''）。 */
		var configSchema = vObject({
			mode: vEnum(["reverse", "forward"]),
			host: vString(0, 256),
			port: vNumber(),
			url: vString(0, 512),
			accessToken: vString(0, 256),
			botQQ: vString(0, 64),
			workspacePath: vString(0, 1024),
			memeDir: vString(0, 1024),
			attachInboundImages: vBoolean(),
			attachMaxImageMB: vNumber(0),
			attachmentBudgetMB: vNumber(0),
			attachmentRetentionHours: vNumber(0),
			attachmentSaveTimeoutMs: vNumber(0),
			requireMention: vBoolean(),
			adminUsers: vArray(vString(0, 64)),
			dmPolicy: vEnum(["open", "allowlist", "disabled"]),
			groupPolicy: vEnum(["open", "allowlist", "disabled"]),
			allowAllUsers: vBoolean(),
			allowFrom: vArray(vString(0, 64)),
			groupAllowFrom: vArray(vString(0, 64)),
			// 读侧刻意放宽到 4096：本 schema 挂在 strictCodec 上用来解整份快照，
			// 若这里也写 128，管理员手改 patch 塞进一条超长值时会让整份 getSettings
			// 解码失败（面板全空），而不是只影响这一项。写入侧仍有 128/256 的真校验。
			mcpToolAllow: vArray(vString(0, 4096)),
			interimMessages: vBoolean(),
			interimRecall: vBoolean(),
			interimRecallMs: vNumber(),
			sendErrorNotice: vBoolean(),
			unknownCommand: vEnum(["intercept", "passthrough"]),
			rateLimitPerMinute: vNumber(),
			newMessagePolicy: vEnum(["queue", "steer"]),
			autoSteerPolicy: vEnum(["admin", "all"]),
			deferredTimeoutMs: vNumber(),
			reasoningEffort: vEnum(["", "off", "minimal", "low", "medium", "high", "xhigh", "max"]),
			persona: vString(0, 20000),
			actionAuditEnabled: vBoolean(),
			traceEnabled: vBoolean(),
			recordInbound: vBoolean(),
			inboxRedact: vBoolean(),
			injectEnabled: vBoolean(),
			injectDryRun: vBoolean(),
		});
		var snapshotSchema = vObject({
			revision: vInt(0),
			entryActive: vBoolean(),
			config: configSchema,
			secrets: vArray(vObject({ path: vArray(vString(1, 64)), set: vBoolean() })),
			groups: vObject({
				connection: vArray(vString(1, 64)),
				permissions: vArray(vString(1, 64)),
				behavior: vArray(vString(1, 64)),
				diagnostics: vArray(vString(1, 64)),
			}),
			effect: vEnum(["restart"]), // T1 §5：19 键统一插件级热重启
		});
		/** updateSettings 入参（T1 §4 + W6 + W7 + T10 + T11：38 键任意子集的扁平 JSON；accessToken 缺省=不改，''=清空）。 */
		var patchSchema = vObject({
			mode: vOptional(vEnum(["reverse", "forward"])),
			host: vOptional(vString(0, 256)),
			port: vOptional(vNumber(1, 65535)),
			url: vOptional(vString(0, 512)),
			accessToken: vOptional(vString(0, 256)),
			botQQ: vOptional(vString(0, 64)),
			workspacePath: vOptional(vString(0, 1024)),
			memeDir: vOptional(vString(0, 1024)),
			attachInboundImages: vOptional(vBoolean()),
			attachMaxImageMB: vOptional(vNumber(0)),
			attachmentBudgetMB: vOptional(vNumber(0)),
			attachmentRetentionHours: vOptional(vNumber(0)),
			attachmentSaveTimeoutMs: vOptional(vNumber(0)),
			requireMention: vOptional(vBoolean()),
			adminUsers: vOptional(vArray(vString(0, 64))),
			dmPolicy: vOptional(vEnum(["open", "allowlist", "disabled"])),
			groupPolicy: vOptional(vEnum(["open", "allowlist", "disabled"])),
			allowAllUsers: vOptional(vBoolean()),
			allowFrom: vOptional(vArray(vString(0, 64))),
			groupAllowFrom: vOptional(vArray(vString(0, 64))),
			// patchSchema 是「提交前」的本地快速校验，与写侧真校验同宽（单项 128）。
			// 条数上限（256）由服务端 validateSettingsPatch 兜住，这里只挡明显超长值。
			mcpToolAllow: vOptional(vArray(vString(0, 128))),
			interimMessages: vOptional(vBoolean()),
			interimRecall: vOptional(vBoolean()),
			interimRecallMs: vOptional(vNumber(0)),
			sendErrorNotice: vOptional(vBoolean()),
			unknownCommand: vOptional(vEnum(["intercept", "passthrough"])),
			rateLimitPerMinute: vOptional(vNumber(0)),
			newMessagePolicy: vOptional(vEnum(["queue", "steer"])),
			autoSteerPolicy: vOptional(vEnum(["admin", "all"])),
			deferredTimeoutMs: vOptional(vNumber(0)),
			reasoningEffort: vOptional(vEnum(["", "off", "minimal", "low", "medium", "high", "xhigh", "max"])),
			persona: vOptional(vString(0, 20000)),
			actionAuditEnabled: vOptional(vBoolean()),
			traceEnabled: vOptional(vBoolean()),
			recordInbound: vOptional(vBoolean()),
			inboxRedact: vOptional(vBoolean()),
			injectEnabled: vOptional(vBoolean()),
			injectDryRun: vOptional(vBoolean()),
		});
		//#endregion

		//#region Typert Remote 严格 descriptor（与 host lib/settings-remote.js 服务方法面
		//  逐字对齐：getSettings() / updateSettings(patch, expectedRevision) /
		//  listWorkspaces()（W7），全 positional。
		//  host 侧未导出客户端 descriptor 数组——两侧各自持有一份，本数组为客户端真相源，
		//  变更须同步宿主侧并在 DEVLOG 记录；tests/client-settings.spec.ts 做契约核对。）
		/** W7：listWorkspaces 返回值（host WorkspaceListResult 同构）。 */
		var workspaceListSchema = vObject({
			available: vBoolean(),
			workspaces: vArray(vObject({ id: vString(1, 256), path: vString(0, 1024), sessionCount: vInt(0) })),
		});
		function strictCodec(typeSymbol, schema) {
			return { mode: "strict", typeSymbol: typeSymbol, create: () => schema, schema: schema };
		}
		function jsonParameter(name, typeSymbol, schema) {
			return { name: name, wire: name, source: "json", codec: strictCodec(typeSymbol, schema) };
		}
		function onebotMethod(method, parameters, resultSchema, typeSymbol) {
			return {
				id: PLUGIN_ID + "#" + REMOTE_NS + "/" + method,
				service: REMOTE_NS,
				namespace: REMOTE_NS,
				method: method,
				invocation: { kind: "direct" },
				parameters: parameters,
				result: strictCodec(typeSymbol != null ? typeSymbol : "OnebotSettingsSnapshot", resultSchema || snapshotSchema),
			};
		}
		/** T17：listReasoningEfforts 返回值（host ReasoningEffortsResult 同构：
		 *  available + efforts[{id,name}] + 可选 defaultEffort）。 */
		var reasoningEffortsSchema = vObject({
			available: vBoolean(),
			efforts: vArray(vObject({ id: vString(1, 64), name: vString(1, 128) })),
			defaultEffort: vOptional(vString(0, 64)),
		});
		var ONEBOT_SETTINGS_DESCRIPTORS = [
			onebotMethod("getSettings", []),
			onebotMethod("updateSettings", [
				jsonParameter("patch", "OnebotSettingsPatch", patchSchema),
				jsonParameter("expectedRevision", "number", vOptional(vInt(0))),
			]),
			onebotMethod("listWorkspaces", [], workspaceListSchema, "WorkspaceListResult"),
			onebotMethod("listReasoningEfforts", [], reasoningEffortsSchema, "ReasoningEffortsResult"),
		];
		var ONEBOT_SETTINGS_REMOTE = { package: PLUGIN_ID, descriptors: ONEBOT_SETTINGS_DESCRIPTORS };
		//#endregion

		//#region 双语词条（zh 为 key 集真相源，en 逐 key 对齐；占位符用平台 {word} 形式。
		//  分组标题与字段 label 是中文常量（T4 要求），不走词条。）
		var zh = {
			"settings.title": "QQ Bot（OneBot）设置",
			"settings.desc": "配置持久化为 profile 层 cordis.patch.yml 中 dsh-onebot 条目的 config 覆盖行，与手改 patch、宿主原生设置页同源。",
			"settings.loading": "正在加载设置…",
			"settings.reload": "重新加载",
			"settings.reset": "恢复默认值",
			"save.submit": "保存设置",
			"save.saving": "正在保存…",
			"save.done": "设置已保存。保存即热生效：插件秒级重启，QQ 桥会自动重连。",
			"save.noChanges": "没有需要保存的变更。",
			"save.badNumber": "数字字段不合法：{keys}",
			"effect.hint": "保存即热生效（无需重启宿主）：插件秒级原地重启，QQ 桥会自动重连；在途回合中断、频控窗口与中间消息缓冲清零，会话映射/历史不受影响。",
			"effect.entryInactive": "dsh-onebot 条目当前未激活，保存后可能无法生效，请检查插件加载状态。",
			"secret.set": "已配置（脱敏，不回显）",
			"secret.unset": "未配置",
			"secret.placeholder": "留空 = 不修改",
			"secret.clear": "清除已保存的 AccessToken",
			"conflict.title": "保存冲突：设置已被其他来源修改（revision 不一致），已重新拉取最新配置，请检查后重试。",
			"status.error": "出错",
			"revision.label": "revision",
		};
		var en = {
			"settings.title": "QQ Bot (OneBot) settings",
			"settings.desc": "Settings persist as the config override row of the dsh-onebot entry in the profile-layer cordis.patch.yml — same source as hand-edited patches and the host's native settings page.",
			"settings.loading": "Loading settings…",
			"settings.reload": "Reload",
			"settings.reset": "Reset to defaults",
			"save.submit": "Save settings",
			"save.saving": "Saving…",
			"save.done": "Settings saved. Hot-applied on save: the plugin restarts within seconds and the QQ bridge reconnects automatically.",
			"save.noChanges": "Nothing to save.",
			"save.badNumber": "Invalid number fields: {keys}",
			"effect.hint": "Hot-applied on save (no host restart): the plugin fiber restarts in place within seconds; the QQ bridge reconnects automatically. In-flight turns are interrupted and rate-limit windows/interim buffers reset; session mappings and history are unaffected.",
			"effect.entryInactive": "The dsh-onebot entry is currently inactive; saving may not take effect. Check the plugin's load state.",
			"secret.set": "Configured (redacted, never echoed)",
			"secret.unset": "Not configured",
			"secret.placeholder": "Leave empty = keep current",
			"secret.clear": "Clear the saved AccessToken",
			"conflict.title": "Save conflict: settings were changed by another source (revision mismatch). The latest snapshot has been re-fetched — review and retry.",
			"status.error": "Error",
			"revision.label": "revision",
		};
		/** 双语 key 集一致性自检：缺漏仅告警不致崩溃。 */
		function assertSameKeys(a, b) {
			var missing = Object.keys(a).filter((key) => !(key in b));
			var extra = Object.keys(b).filter((key) => !(key in a));
			if (missing.length > 0 || extra.length > 0) {
				console.warn("[dsh-onebot] 双语词条 key 不齐 zh缺:" + missing.join(",") + " en缺:" + extra.join(","));
			}
		}
		assertSameKeys(zh, en);
		//#endregion

		//#region 面板样式（一次注入，随插件卸载移除；类名前缀 obx-）
		var CSS = [
			".obx-panel{display:flex;flex-direction:column;gap:16px;font-size:14px;line-height:1.5}",
			".obx-title{font-size:16px;font-weight:600;margin:0}",
			".obx-desc{opacity:.72;margin:4px 0 0}",
			".obx-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".obx-spacer{flex:1}",
			".obx-meta{opacity:.72;font-size:12px}",
			".obx-error{border:1px solid #e5484d;background:rgba(229,72,77,.08);color:#e5484d;border-radius:8px;padding:8px 12px}",
			".obx-alert[role=alert]{white-space:pre-wrap}",
			".obx-notice{opacity:.85;min-height:1em}",
			".obx-effect{border:1px dashed rgba(128,128,128,.45);border-radius:8px;padding:8px 12px;opacity:.85}",
			".obx-warn{color:#d97706}",
			".obx-group{display:flex;flex-direction:column;gap:10px;border-top:1px solid rgba(128,128,128,.2);padding-top:12px}",
			".obx-group-title{font-weight:600;margin:0}",
			".obx-field{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}",
			".obx-label{font-size:12px;opacity:.8;min-width:180px}",
			".obx-control{display:flex;flex-wrap:wrap;gap:8px;align-items:center;flex:1;min-width:240px}",
			".obx-input,.obx-select,.obx-textarea{flex:1;min-width:160px;max-width:420px;box-sizing:border-box;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;color:inherit;padding:6px 8px;font:inherit}",
			".obx-textarea{max-width:520px;min-height:56px;resize:vertical}",
			".obx-toggle{display:inline-flex;align-items:center;gap:6px}",
			".obx-hint{opacity:.65;font-size:12px;flex-basis:100%}",
			".obx-secret-badge{font-size:11px;border:1px solid rgba(128,128,128,.4);border-radius:999px;padding:0 8px;opacity:.8}",
			".obx-badge{font-size:11px;border:1px solid rgba(128,128,128,.4);border-radius:999px;padding:0 8px;opacity:.8}",
			".obx-btn{cursor:pointer;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;color:inherit;padding:4px 10px}",
			".obx-btn:hover:not(:disabled){border-color:currentColor}",
			".obx-btn:disabled{opacity:.45;cursor:not-allowed}",
			".obx-btn.primary{border-color:currentColor;font-weight:600}",
		].join("\n");
		//#endregion

		//#region 工具（纯函数，模块级可测）
		function format(template, params) {
			return String(template).replace(/\{(\w+)\}/g, (match, key) =>
				Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
		}
		function messageOf(cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
		/** RemoteResult 解包：{ok:true,value}|{ok:false,error:{message}}。 */
		function unwrap(result) {
			if (result != null && result.ok === true) return result.value;
			var detail = result != null && result.error != null ? result.error.message : "unknown remote error";
			var error = new Error(detail);
			if (result != null && result.error != null && result.error.code != null) error.code = result.error.code;
			throw error;
		}
		/** 保存冲突判定（T1 §3.1：expectedRevision ≠ 当前 revision 拒写，
		 *  host 抛 RemoteError('onebot-settings/conflict')；message 兜底只匹配该
		 *  错误路径本身——不过宽匹配含 "revision" 的无关错误（评审 B5）。 */
		var CONFLICT_RE = /onebot-settings\/conflict/i;
		function isConflictError(cause) {
			if (cause == null) return false;
			return cause.code === "onebot-settings/conflict" || CONFLICT_RE.test(String(cause.message || ""));
		}
		/** 快照生效值 → 表单草稿（展示形态：number/stringArray/secret 均为可编辑文本；
		 *  accessToken 恒 ''，明文绝不进入草稿——host 快照已脱敏）。 */
		function snapshotValueToDraft(field, value) {
			if (field.type === "secret") return ""; // 脱敏回显：密码框恒空（T1 §3 敏感字段行）
			if (field.type === "stringArray") return Array.isArray(value) ? value.join("\n") : "";
			if (field.type === "number") return value === undefined || value === null ? "" : String(value);
			if (field.type === "boolean") return value === true;
			return value === undefined || value === null ? "" : String(value);
		}
		function draftFromSnapshot(snapshot) {
			var config = snapshot != null && snapshot.config != null ? snapshot.config : {};
			var draft = {};
			for (var field of ALL_FIELDS) draft[field.key] = snapshotValueToDraft(field, config[field.key]);
			return draft;
		}
		function draftFromDefaults() {
			return draftFromSnapshot({ config: DEFAULTS });
		}
		/** 草稿展示值 → patch 值（stringArray 文本 → 行数组；number 文本 → 数字）。 */
		function coerceValue(field, raw) {
			if (field.type === "number") {
				var n = typeof raw === "number" ? raw : Number(String(raw).trim());
				return Number.isFinite(n) ? n : NaN;
			}
			if (field.type === "boolean") return raw === true;
			if (field.type === "stringArray") {
				return String(raw == null ? "" : raw).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
			}
			return String(raw == null ? "" : raw);
		}
		function valueEquals(a, b) {
			return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
		}
		/**
		 * 计算保存 patch（T1 §4 + W6 + W7 + T10 + T11：38 键任意子集的扁平 JSON）。
		 * @param draft 表单草稿（snapshotValueToDraft 形态）
		 * @param config 快照生效值（snapshot.config）
		 * @param opts.secretDraft 密码框输入（'' = 不修改 accessToken）
		 * @param opts.clearSecret true = 显式下发 accessToken: ''（host 语义：'' = 清空）
		 * @returns {patch, invalidKeys} 与生效值有差异的键集合；invalidKeys 为未通过
		 *          客户端数字校验的键（host validatePatch 仍会二次校验）。
		 */
		function computePatch(draft, config, opts) {
			var options = opts == null ? {} : opts;
			var config_ = config == null ? {} : config;
			var patch = {};
			var invalidKeys = [];
			for (var field of ALL_FIELDS) {
				if (field.type === "secret") continue; // accessToken 走 secretDraft/clearSecret 专用通道
				var next = coerceValue(field, draft[field.key]);
				if (field.type === "number" && Number.isNaN(next)) {
					invalidKeys.push(field.key);
					continue;
				}
				if (!valueEquals(next, config_[field.key])) patch[field.key] = next;
			}
			var secretDraft = options.secretDraft;
			if (options.clearSecret === true) patch.accessToken = ""; // host 语义：'' = 清空
			else if (typeof secretDraft === "string" && secretDraft !== "") patch.accessToken = secretDraft;
			// secretDraft 为空且未勾选清除 → 不含 accessToken 键 = 不修改（host 缺省语义）
			return { patch: patch, invalidKeys: invalidKeys };
		}

		/**
		 * W7：把选中的 workspace path 填入草稿（「快速填入」的唯一写入口）。
		 * 纯函数、只返回新草稿对象——绝不触达 remote.updateSettings；保存仍走
		 * 「保存设置」显式通道（computePatch → updateSettings）。
		 */
		function fillWorkspacePath(draft, path) {
			var next = Object.assign({}, draft == null ? {} : draft);
			next.workspacePath = String(path == null ? "" : path);
			return next;
		}
		//#endregion

		//#region 渲染（模块级可测的纯渲染函数：renderGroup 不依赖 hooks/副作用）
		function h(ReactImpl, tag, props) {
			var children = Array.prototype.slice.call(arguments, 3);
			return ReactImpl.createElement.apply(ReactImpl, [tag, props].concat(children));
		}
		/**
		 * 渲染一个设置分组（纯函数；值全部经 snapshotValueToDraft 脱敏形态传入，
		 * accessToken 明文按契约绝不进入本函数——host 快照侧已脱敏为 ''）。
		 * @param opts.onChange (field, nextDisplayValue) => void
		 * @param opts.onSecretChange (nextText) => void
		 * @param opts.onClearSecretChange (nextBoolean) => void
		 * @param opts.secretSet boolean（快照 secrets 标记：明文是否已配置）
		 * @param opts.clearSecret boolean（清除勾选态）
		 * @param opts.nonDefaultKeys 与 schema 默认值不同的键数组（W6「非默认」徽标；
		 *        以快照生效值为准而非草稿——徽标描述已保存状态，不是未保存编辑）
		 * @param opts.draft 表单草稿（snapshotValueToDraft 形态）
		 */
		function renderGroup(ReactImpl, group, opts) {
			var options = opts == null ? {} : opts;
			var draft = options.draft == null ? {} : options.draft;
			var nonDefaultKeys = Array.isArray(options.nonDefaultKeys) ? options.nonDefaultKeys : [];
			var onChange = typeof options.onChange === "function" ? options.onChange : function () {};
			var onSecretChange = typeof options.onSecretChange === "function" ? options.onSecretChange : function () {};
			var onClearSecretChange = typeof options.onClearSecretChange === "function" ? options.onClearSecretChange : function () {};
			var fieldNodes = group.fields.map(function (field) {
				var value = draft[field.key];
				var control;
				if (field.type === "boolean") {
					control = h(ReactImpl, "label", { className: "obx-toggle" },
						h(ReactImpl, "input", {
							type: "checkbox", checked: value === true, disabled: options.disabled === true,
							onChange: function (event) { onChange(field, event.target.checked); },
						}),
						value === true ? "开" : "关");
				} else if (field.type === "enum") {
					// T17：动态档位。options.dynamicOptions 是 (field) => {options, optionLabels}
					// 的可选回调——仅对 reasoningEffort 生效（模型真实支持的档位随 provider
					// 变化，xhigh/max 需模型显式声明，否则请求期抛 UNSUPPORTED_REASONING_EFFORT）。
					// 回调缺席/返回空 → 回退字段自带的静态 options（方案 A：查询失败绝不收窄）。
					var dyn = typeof options.dynamicOptions === "function" ? options.dynamicOptions(field) : null;
					var useOptions = dyn != null && Array.isArray(dyn.options) && dyn.options.length > 0 ? dyn.options : field.options;
					var useLabels = dyn != null && Array.isArray(dyn.options) && dyn.options.length > 0 && dyn.optionLabels != null ? dyn.optionLabels : field.optionLabels;
					control = h(ReactImpl, "select", {
						className: "obx-select", value: String(value == null ? "" : value), disabled: options.disabled === true,
						onChange: function (event) { onChange(field, event.target.value); },
						"aria-label": field.label,
					}, useOptions.map(function (option) {
						return h(ReactImpl, "option", { key: option, value: option }, useLabels[option] != null ? useLabels[option] : option);
					}));
				} else if (field.type === "stringArray") {
					control = h(ReactImpl, "textarea", {
						className: "obx-textarea", rows: 3, value: String(value == null ? "" : value), disabled: options.disabled === true,
						placeholder: "每行一个",
						onChange: function (event) { onChange(field, event.target.value); },
						"aria-label": field.label,
					});
				} else if (field.type === "textarea") {
					// T11：多行自由文本（persona）。默认 rows=6，可由 field.rows 覆盖。
					control = h(ReactImpl, "textarea", {
						className: "obx-textarea", rows: typeof field.rows === "number" ? field.rows : 6,
						value: String(value == null ? "" : value), disabled: options.disabled === true,
						placeholder: field.placeholder == null ? "" : field.placeholder,
						onChange: function (event) { onChange(field, event.target.value); },
						"aria-label": field.label,
					});
				} else if (field.type === "secret") {
					// 密码型输入且不明文回显：value 恒为用户本次输入（初始 ''），占位符提示留空不改；
					// 已配置状态只展示脱敏徽标，绝不渲染任何明文。
					control = h(ReactImpl, "span", { className: "obx-control" },
						h(ReactImpl, "input", {
							type: "password", className: "obx-input", value: String(value == null ? "" : value),
							placeholder: "留空 = 不修改", autoComplete: "new-password", disabled: options.disabled === true,
							onChange: function (event) { onSecretChange(event.target.value); },
							"aria-label": field.label,
						}),
						h(ReactImpl, "span", { className: "obx-secret-badge" }, options.secretSet === true ? "已配置（脱敏，不回显）" : "未配置"),
						h(ReactImpl, "label", { className: "obx-toggle" },
							h(ReactImpl, "input", {
								type: "checkbox", checked: options.clearSecret === true, disabled: options.disabled === true,
								onChange: function (event) { onClearSecretChange(event.target.checked); },
							}),
							"清除已保存的 AccessToken"));
				} else {
					control = h(ReactImpl, "input", {
						type: "text", className: "obx-input", value: String(value == null ? "" : value), disabled: options.disabled === true,
						onChange: function (event) { onChange(field, event.target.value); },
						"aria-label": field.label,
					});
				}
				var nodes = [
					h(ReactImpl, "div", { className: "obx-field", key: field.key },
						h(ReactImpl, "span", { className: "obx-label" }, field.label),
						// W6「非默认」徽标（对齐竞品 v0.6.0 行话术）：快照生效值 ≠ schema 默认值
						// 时标注，帮助一眼识别改过哪些开关；「待重启」徽标不适用本插件——
						// 保存经宿主 configEditor.edit 热生效（整条 fiber 秒级原地重启，
						// docs/settings-page-design.md §5），不存在键级「配置文件值≠生效值」稳态。
						nonDefaultKeys.indexOf(field.key) >= 0
							? h(ReactImpl, "span", { className: "obx-badge", title: "与默认值不同" }, "非默认")
							: null,
						control,
						field.hint != null ? h(ReactImpl, "span", { className: "obx-hint" }, field.hint) : null),
				];
				// W7：可选扩展点——字段行后追加组内附加行（connection 组 workspacePath
				// 下方的「快速填入 workspace」行由此注入；独立 class 不计入 obx-field 行数）。
				if (typeof options.renderExtraRow === "function") {
					var extra = options.renderExtraRow(field);
					if (extra != null) nodes.push(extra);
				}
				return nodes;
			});
			return h(ReactImpl, "section", { className: "obx-group", "data-group": group.id },
				h(ReactImpl, "h3", { className: "obx-group-title" }, group.title),
				fieldNodes);
		}
		//#endregion

		/**
		 * W7：渲染 workspacePath 字段下方的「快速填入 workspace」行（纯函数）。
		 * 数据来自面板打开时对 remote.listWorkspaces() 的一次现拉（不缓存陈旧列表）。
		 * 三态：
		 *   - loaded !== true（拉取中/未拉取）→ 不渲染；
		 *   - available !== true 或列表为空 → 隐藏下拉与按钮，仅渲染一行说明
		 *     （可直接输入路径，不阻塞手输）；
		 *   - 正常 → select（选项 = path（N 会话），value = id，避免同名 path 冲突）
		 *     + 「填入」按钮：仅把选中 path 写进输入框当前值（onApply → fillWorkspacePath），
		 *     不自动保存。
		 * @param opts.workspaces host listWorkspaces().workspaces
		 * @param opts.available host listWorkspaces().available
		 * @param opts.loaded 面板打开后拉取是否已完成
		 * @param opts.selectedId 当前选中的 workspace id（'' = 未选）
		 * @param opts.onApply (path: string) => void（填入回调；本函数绝不调用保存）
		 */
		function renderWorkspacePicker(ReactImpl, opts) {
			var options = opts == null ? {} : opts;
			if (options.loaded !== true) return null;
			var workspaces = Array.isArray(options.workspaces) ? options.workspaces : [];
			if (options.available !== true || workspaces.length === 0) {
				return h(ReactImpl, "p", { className: "obx-hint obx-workspace-empty" },
					options.available === true
						? "暂无 workspace 记录，可直接输入路径。"
						: "无法获取 workspace 列表（宿主未提供 workspace 注册表），可直接输入路径。");
			}
			var selectedId = typeof options.selectedId === "string" ? options.selectedId : "";
			var selected = null;
			for (var workspace of workspaces) {
				if (workspace != null && String(workspace.id) === selectedId) selected = workspace;
			}
			var disabled = options.disabled === true;
			return h(ReactImpl, "div", { className: "obx-workspace-row", "data-role": "workspace-picker" },
				h(ReactImpl, "span", { className: "obx-label" }, "快速填入 workspace"),
				h(ReactImpl, "select", {
					className: "obx-select", value: selectedId, disabled: disabled,
					"aria-label": "快速填入 workspace",
					title: "列出宿主 workspace 注册表中的工作区；选中后点「填入」写入上方路径输入框（只填值，保存仍走「保存设置」按钮）",
					onChange: function (event) {
						var onSelectedChange = options.onSelectedChange;
						if (typeof onSelectedChange === "function") onSelectedChange(event.target.value);
					},
				},
					h(ReactImpl, "option", { key: "", value: "" }, "选择 workspace…"),
					workspaces.map(function (workspace) {
						var label = String(workspace.path == null ? "" : workspace.path) + "（" + String(workspace.sessionCount == null ? 0 : workspace.sessionCount) + " 会话）";
						return h(ReactImpl, "option", { key: String(workspace.id), value: String(workspace.id) }, label);
					})),
				h(ReactImpl, "button", {
					className: "obx-btn", type: "button", disabled: disabled || selected == null,
					onClick: function () {
						var onApply = options.onApply;
						if (selected != null && typeof onApply === "function") onApply(selected.path);
					},
				}, "填入"),
				h(ReactImpl, "span", { className: "obx-hint" }, "选中后点「填入」仅写入上方输入框；需点「保存设置」才会保存（对新会话生效，已设 /workspace 覆盖的会话不受影响）。"));
		}

		//#region 面板组件
		/**
		 * QQ Bot 设置面板。
		 * @param props t 为宿主注入的翻译函数（locale: NS，语言切换自动重渲染）；
		 *        remote 为挂载后的 `remote.onebotSettings` API。
		 */
		function OnebotSettingsPanel(props) {
			var t = props.t;
			var remote = props.remote;
			var snapshotState = React.useState(null);
			var snapshot = snapshotState[0];
			var setSnapshot = snapshotState[1];
			var draftState = React.useState(null);
			var draft = draftState[0];
			var setDraft = draftState[1];
			var secretState = React.useState("");
			var secretDraft = secretState[0];
			var setSecretDraft = secretState[1];
			var clearSecretState = React.useState(false);
			var clearSecret = clearSecretState[0];
			var setClearSecret = clearSecretState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var errorState = React.useState(null);
			var error = errorState[0];
			var setError = errorState[1];
			var noticeState = React.useState("");
			var notice = noticeState[0];
			var setNotice = noticeState[1];
			// W7：「快速填入 workspace」数据态——面板打开时（挂载 effect）对
			// remote.listWorkspaces() 现拉一次，不缓存跨会话的陈旧列表。
			var workspaceState = React.useState({ loaded: false, available: false, workspaces: [], selectedId: "" });
			var workspace = workspaceState[0];
			var setWorkspace = workspaceState[1];
			// T17：当前默认模型实际支持的思考档位（面板打开时现拉一次；查询失败
			// 降级 available=false → 回退静态八选一，绝不收窄可选项）。
			var effortsState = React.useState({ loaded: false, available: false, efforts: [] });
			var efforts = effortsState[0];
			var setEfforts = effortsState[1];

			/** 接受新快照：草稿按快照重置（accessToken 明文绝不进入草稿）。 */
			var accept = function (next) {
				setSnapshot(next);
				setDraft(draftFromSnapshot(next));
			};

			React.useEffect(function () {
				var alive = true;
				void remote.getSettings().then(function (result) {
					if (!alive) return;
					accept(unwrap(result));
				}).catch(function (cause) {
					if (alive) setError(messageOf(cause));
				});
				// W7：辅助查询独立拉取——失败（含 RPC 异常）降级为 unavailable 提示行，
				// 绝不阻塞/污染 getSettings 主链路与错误横幅。
				void Promise.resolve().then(function () {
					return remote.listWorkspaces();
				}).then(function (result) {
					if (!alive) return;
					var value = unwrap(result);
					setWorkspace({
						loaded: true,
						available: value != null && value.available === true,
						workspaces: value != null && Array.isArray(value.workspaces) ? value.workspaces : [],
						selectedId: "",
					});
				}).catch(function () {
					if (alive) setWorkspace({ loaded: true, available: false, workspaces: [], selectedId: "" });
				});
				// T17：思考档位独立拉取——与 listWorkspaces 同款降级：失败只让下拉
				// 回退静态八选一，不阻塞主链路、不产生错误横幅。
				void Promise.resolve().then(function () {
					return typeof remote.listReasoningEfforts === "function" ? remote.listReasoningEfforts() : null;
				}).then(function (result) {
					if (!alive) return;
					var value = result == null ? null : unwrap(result);
					var list = value != null && Array.isArray(value.efforts) ? value.efforts : [];
					setEfforts({
						loaded: true,
						available: value != null && value.available === true && list.length > 0,
						efforts: list.filter(function (item) { return item != null && typeof item.id === "string" && item.id !== ""; }),
					});
				}).catch(function () {
					if (alive) setEfforts({ loaded: true, available: false, efforts: [] });
				});
				return function () { alive = false; };
			}, [remote]);

			var refetch = function () {
				void remote.getSettings().then(function (result) {
					accept(unwrap(result));
					setError(null);
					setNotice("");
				}).catch(function (cause) {
					setError(messageOf(cause));
				});
			};

			/** 保存统一通道：updateSettings(patch, expectedRevision)；冲突时提示并重拉快照。 */
			var save = function () {
				if (busy || snapshot == null || draft == null) return;
				setError(null);
				setNotice("");
				var computed = computePatch(draft, snapshot.config, { secretDraft: secretDraft, clearSecret: clearSecret });
				if (computed.invalidKeys.length > 0) {
					var labels = computed.invalidKeys.map(function (key) {
						var field = ALL_FIELDS.find(function (item) { return item.key === key; });
						return field != null ? field.label : key;
					});
					setError(format(t("save.badNumber"), { keys: labels.join("、") }));
					return;
				}
				if (Object.keys(computed.patch).length === 0) {
					setNotice(t("save.noChanges"));
					return;
				}
				setBusy(true);
				void Promise.resolve().then(function () {
					return remote.updateSettings(computed.patch, snapshot.revision);
				}).then(function (result) {
					accept(unwrap(result));
					setNotice(t("save.done")); // 生效方式提示（T1 §5）：热生效、插件秒级重启、桥重连
					setClearSecret(false);
					setSecretDraft("");
				}).catch(function (cause) {
					if (isConflictError(cause)) {
						// T1 §3.1：revision 不一致 → 提示并重拉快照，用户核对后重放
						setError(t("conflict.title"));
						refetch();
					} else {
						setError(messageOf(cause));
					}
				}).finally(function () {
					setBusy(false);
				});
			};

			if (snapshot === null || draft === null) {
				return h(React, "div", { className: "obx-panel" },
					h(React, "p", { className: "obx-hint" }, t("settings.loading")),
					error === null ? null : h(React, "div", { className: "obx-error", role: "alert" }, t("status.error") + "：" + error));
			}

			var secretSet = false;
			if (Array.isArray(snapshot.secrets)) {
				for (var secretEntry of snapshot.secrets) {
					if (secretEntry != null && Array.isArray(secretEntry.path) && secretEntry.path.indexOf("accessToken") >= 0 && secretEntry.set === true) secretSet = true;
				}
			}
			if (clearSecret === true) secretSet = false; // 勾选清除后按“将清空”展示

			// W6「非默认」徽标数据源：快照生效值 vs schema 默认值（DEFAULTS），
			// 反映已保存状态；草稿未保存的改动不打徽标。
			var nonDefaultKeys = [];
			if (snapshot.config != null) {
				for (var field of ALL_FIELDS) {
					if (valueEquals(snapshot.config[field.key], DEFAULTS[field.key]) === false) nonDefaultKeys.push(field.key);
				}
			}

			var changeHandlers = {
				disabled: busy,
				secretSet: secretSet,
				clearSecret: clearSecret,
				nonDefaultKeys: nonDefaultKeys,
				draft: draft,
				// T17：reasoningEffort 的选项按当前模型实际支持的档位动态收窄。
				// 「继承」（''）恒在首位；若已保存值不在可用档位内也保留（否则
				// select 会静默显示成别的值，造成配置与展示不一致），由用户在
				// 保存前自行调整。efforts.available !== true 时返回 null → 走静态
				// 八选一（方案 A：查询失败绝不收窄）。
				dynamicOptions: function (field) {
					if (field.key !== "reasoningEffort") return null;
					if (efforts.available !== true || efforts.efforts.length === 0) return null;
					var ids = [""];
					var labels = { "": field.optionLabels[""] };
					for (var item of efforts.efforts) {
						if (ids.indexOf(item.id) >= 0) continue;
						ids.push(item.id);
						labels[item.id] = item.name != null && item.name !== "" ? item.name : item.id;
					}
					var current = draft[field.key];
					if (typeof current === "string" && current !== "" && ids.indexOf(current) < 0) {
						ids.push(current);
						labels[current] = (field.optionLabels[current] != null ? field.optionLabels[current] : current) + "（当前模型不支持）";
					}
					return { options: ids, optionLabels: labels };
				},
				// W7：workspacePath 字段行下方的「快速填入 workspace」行（独立于
				// obx-field 行；onApply 只写草稿不保存——保存仍走 save() 显式通道）。
				renderExtraRow: function (field) {
					if (field.key !== "workspacePath") return null;
					return renderWorkspacePicker(React, {
						loaded: workspace.loaded,
						available: workspace.available,
						workspaces: workspace.workspaces,
						selectedId: workspace.selectedId,
						disabled: busy,
						onSelectedChange: function (nextId) {
							setWorkspace(Object.assign({}, workspace, { selectedId: nextId }));
						},
						onApply: function (path) {
							setDraft(fillWorkspacePath(draft, path));
						},
					});
				},
				onChange: function (field, nextValue) {
					setDraft(Object.assign({}, draft, (function () { var next = {}; next[field.key] = nextValue; return next; })()));
				},
				onSecretChange: function (nextText) {
					setSecretDraft(nextText);
					setDraft(Object.assign({}, draft, (function () { var next = {}; next.accessToken = nextText; return next; })()));
				},
				onClearSecretChange: function (nextChecked) {
					setClearSecret(nextChecked);
				},
			};

			return h(React, "div", { className: "obx-panel" },
				h(React, "h2", { className: "obx-title" }, t("settings.title")),
				h(React, "p", { className: "obx-desc" }, t("settings.desc")),
				h(React, "div", { className: "obx-toolbar" },
					h(React, "span", { className: "obx-meta" }, t("revision.label") + " " + String(snapshot.revision)),
					snapshot.entryActive === true ? null : h(React, "span", { className: "obx-meta obx-warn" }, t("effect.entryInactive")),
					h(React, "span", { className: "obx-spacer" }),
					h(React, "button", { className: "obx-btn", type: "button", disabled: busy, onClick: refetch }, t("settings.reload")),
					h(React, "button", { className: "obx-btn", type: "button", disabled: busy, onClick: function () { setDraft(draftFromDefaults()); } }, t("settings.reset")),
					h(React, "button", { className: "obx-btn primary", type: "button", disabled: busy, onClick: save }, busy ? t("save.saving") : t("save.submit"))),
				h(React, "div", { className: "obx-effect" }, t("effect.hint")),
				GROUPS.map(function (group) {
					return renderGroup(React, group, changeHandlers);
				}),
				error === null ? null : h(React, "div", { className: "obx-error", role: "alert" }, t("status.error") + "：" + error),
				notice === "" ? null : h(React, "p", { className: "obx-notice" }, notice));
		}
		//#endregion

		//#region 客户端入口
		var inject = ["slots", "locale", "remote"];
		/**
		 * 客户端入口：注入样式与词条、挂载 Typert Remote、注册设置面板。
		 * @returns {() => void} 卸载函数（对照先例：只回收 Remote 挂载；
		 *          样式/词条/slot 注册由宿主 ctx.effect 与 slot 生命周期回收）。
		 */
		async function apply(ctx) {
			ctx.effect(function () {
				var tag = document.createElement("style");
				tag.dataset.plugin = PLUGIN_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return function () { tag.remove(); };
			}, "onebot-settings: style");

			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "onebot-settings: dictionaries");
			var t = ctx.locale.bind(NS);

			// namespace 是独立 Cordis 服务：必须挂载后 ctx.get() 获取，
			// 直接读 ctx.remote.onebotSettings 会要求预先注入并死锁（先例同款注释）。
			var disposeRemote = await ctx.remote.$mount(ONEBOT_SETTINGS_REMOTE);
			var remote = ctx.get("remote." + REMOTE_NS);
			if (remote === undefined) throw new Error("onebot-settings Remote 挂载后不可用");

			ctx.slots.inject("plugins.bundle.config", function () { return ctx.slots.register(
				{ name: "plugins.bundle.config", key: "dsh-onebot-qq", locale: NS },
				function (props) { if (props && props.view === "summary") return t("settings.desc"); return React.createElement(OnebotSettingsPanel, Object.assign({}, props, { remote: remote })); },
			); });

			return function () { void disposeRemote(); };
		}
		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		exports.ONEBOT_SETTINGS_REMOTE = ONEBOT_SETTINGS_REMOTE;
		exports.ONEBOT_SETTINGS_DESCRIPTORS = ONEBOT_SETTINGS_DESCRIPTORS;
		exports.GROUPS = GROUPS;
		exports.ALL_FIELDS = ALL_FIELDS;
		exports.DEFAULTS = DEFAULTS;
		exports.GROUP_KEYS = GROUP_KEYS;
		exports.computePatch = computePatch;
		exports.coerceValue = coerceValue;
		exports.snapshotValueToDraft = snapshotValueToDraft;
		exports.draftFromSnapshot = draftFromSnapshot;
		exports.fillWorkspacePath = fillWorkspacePath;
		exports.renderWorkspacePicker = renderWorkspacePicker;
		exports.isConflictError = isConflictError;
		exports.unwrap = unwrap;
		exports.renderGroup = renderGroup;
		exports.OnebotSettingsPanel = OnebotSettingsPanel;

		return module.exports;
	}
});
