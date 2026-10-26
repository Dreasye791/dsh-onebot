/**
 * QQ 通道的 MCP 工具闸门（白名单，fail-closed）。
 *
 * 为什么需要它：MCP 服务器的工具注册在**加载它的那个 ctx**（profile 根）上，
 * 而 dsh 的作用域视图沿链**向下**继承 —— 子作用域看得见祖先的全部注册。
 * 本插件给每个 QQ 会话建的 agent 也是子作用域，因此 profile 里挂的所有 MCP
 * 服务器（实测 dbx 的 25 个工具）都会出现在 QQ 机器人的工具表里，群友一句话
 * 就能让机器人去连数据库。插件侧此前**没有任何工具门禁**（buildSetup 只做
 * systemPrompt + qq_* 工具注册），必须在这里补一道闸。
 *
 * 为什么不走挂载期过滤（比如不注册）：MCP 工具由宿主另一个插件注册，本插件
 * 既不能拦截它的注册，也不能按 agent 挑选它的可见性 —— 宿主的
 * `tools.restrict()` 只能过滤**继承来的**工具、且要求工具名**在调用时已存在**
 * （MCP 是异步连接，启动时序上写死 `mcp__*` 会抛 unknown tool），还拒绝空
 * filter（`restrict({})` 直接抛错，无法表达「空名单 = 全禁」）。因此改用
 * `tools.guard()`：它在**调用期**按名字判，不依赖注册时序，且天然支持
 * 「白名单为空 ⇒ 一个都不放行」。
 *
 * 代价：guard 是执行期拦截，被禁的工具仍会出现在模型的工具表里，只是调用
 * 会被拒绝并回一条可读的拒绝原因。要真正从工具表里消失，需要在 MCP 连接
 * 完成后另行收窄可见性（宿主暂无该通道），故此处以「拒绝」作为兜底。
 * @module dsh-onebot/mcp-gate
 */
/** MCP 工具的命名前缀（宿主 `dsh-mcp-client` 固定用 `mcp__<server>__<tool>`）。 */
export declare const MCP_TOOL_PREFIX = "mcp__";
/** 一条 guard 拒绝理由：返回字符串即拒绝，返回 undefined 即放行。 */
export type ToolGuard = (exec: {
    name?: unknown;
}) => string | undefined;
/** 解析后的 MCP 工具名。 */
export interface McpToolParts {
    /** 服务器名（`mcp__<server>__<tool>` 的第二段）。 */
    server: string;
    /** 裸工具名（第三段起，允许自身含 `__`）。 */
    tool: string;
    /**
     * 服务器段与工具段之间的边界是否存在歧义。
     *
     * 宿主 serverName 的字符集允许单下划线（`[A-Za-z0-9_-]{1,32}`），所以
     * `mcp__dbx__prod__query` 既可能是 server=`dbx` + tool=`prod__query`，也可能是
     * server=`dbx__prod` + tool=`query` —— **仅凭字符串无法判定**。
     * 段数 > 2 时置 true，所有按段匹配的判定都必须放弃（见 matchMcpTool）。
     */
    ambiguous: boolean;
}
/** 工具名是否属于 MCP（按宿主命名约定判前缀）。 */
export declare function isMcpToolName(name: string): boolean;
/**
 * 按 `mcp__<server>__<tool>` 约定解析工具名。
 *
 * 用 `split('__')` 而不是 `indexOf('__')`：服务器名的字符集允许单下划线
 * （`[A-Za-z0-9_-]{1,32}`），裸工具名也可能含 `__`。约定是「第 2 段是服务器，
 * 其余全部归工具」，因此按段切分才是稳定口径；段数不足 3 说明不符合约定，
 * 返回 null 由调用方按 fail-closed 处理。
 *
 * **段数 > 2 时边界有歧义**（无法区分 server 含 `__` 还是 tool 含 `__`），
 * 此时 `server`/`tool` 是按「server 取第一段」的口径给出的**最佳猜测**，
 * 只可用于展示与完整名精确比较；凡是按段放宽的判定（通配、服务器名简写、
 * 裸工具名）都必须看 `ambiguous` 并放弃 —— 否则 `mcp__dbx__*` 会连带放行
 * 真实服务器名为 `dbx__prod` 的全部工具，等于越权。
 *
 * **tool 以 `_` 开头时同样有歧义**：`mcp__dbx___query` 去掉前缀是
 * `dbx___query`，按 `__` 切得 server=`dbx` / tool=`_query`，但真实切分也可以
 * 是 server=`dbx_` + tool=`query`（`mcp__` + `dbx_` + `__` + `query`）。服务器名
 * 允许单下划线，所以这条不是理论边界。标为 ambiguous 后服务器简写 `dbx` 与
 * 裸工具名 `_query` 都不再命中，只能写完整名或显式通配。
 */
export declare function parseMcpToolName(name: string): McpToolParts | null;
/** 从 `mcp__<server>__<tool>` 取服务器名；不符约定时返回 ''。 */
export declare function mcpServerOf(name: string): string;
/** 从 `mcp__<server>__<tool>` 取裸工具名；不符约定时返回去掉前缀的剩余部分。 */
export declare function mcpBareNameOf(name: string): string;
/**
 * 单条白名单条目是否命中某个 MCP 工具名。
 *
 * 支持四种写法（按书写成本从高到低，便于管理员按需精确或宽松）：
 * - `*`：放行全部 MCP 工具。
 * - `mcp__akasha__akasha_search`：完整名精确命中。
 * - `mcp__akasha__*`：按服务器整体放行（也可写成服务器名 `akasha`）。
 * - `akasha_search`：裸工具名，命中**任意**服务器下的同名工具。
 *
 * 服务器名与裸工具名的比较都是**整段全等**，不做子串/前缀匹配。
 *
 * **通配的边界判定**：`mcp__<S>__*` 命中的条件是「去掉 `mcp__<S>__` 前缀后余下
 * 的部分非空、不含 `__`、且**不以 `_` 开头**」，也就是通配只覆盖**单段**工具名，
 * 且这段不能被一个更长的服务器名吃掉。
 *
 * 两条边界分别挡掉一类越权：
 * - 余段含 `__` ⇒ `mcp__dbx__*` 不命中真实服务器 `dbx__prod` 的
 *   `mcp__dbx__prod__query`（余段 `prod__query`）。含 `__` 的服务器仍可显式授权
 *   （写 `mcp__dbx__prod__*`，余段 `query` 单段 ⇒ 命中）。
 * - 余段以 `_` 开头 ⇒ `mcp__dbx__*` 不命中 `mcp__dbx___query`。后者的真实切分是
 *   服务器 `dbx_` + 工具 `query`（`mcp__` + `dbx_` + `__` + `query`），余段
 *   `_query` 正是被多吃的那个下划线。服务器名允许单下划线（`[A-Za-z0-9_-]{1,32}`），
 *   所以这条边界不是假设，是名字空间的真实情况。
 *
 * 服务器名简写与裸工具名依赖段边界，歧义名（`ambiguous`）一律不命中，只能用
 * `*`、完整名或显式通配授权 —— 宁可多写一个字，也不静默放大权限。
 */
export declare function matchMcpTool(name: string, allow: readonly string[]): boolean;
/** 白名单单条的最大长度；超长条目在归一化时丢弃（收紧，不是放宽）。 */
export declare const MCP_ALLOW_ITEM_MAX_LEN = 128;
/** 白名单最多接受的条数；超出的尾巴在归一化时截断（收紧）。 */
export declare const MCP_ALLOW_MAX_ENTRIES = 256;
/**
 * 归一化配置里的白名单：去空白、丢空项、丢无法识别的通配、丢超长项、
 * 截断超出条数上限的尾巴、去重（保序）。
 *
 * 这里承担**全部限幅**，而上游 Config schema 刻意不做 `max()` 校验。原因是
 * schemastery 的 `max()` 在解析期直接抛 ValidationError，cordis 捕获后会把整个
 * 插件置为 INACTIVE —— 手改 patch 写进一条 129 字符的条目，后果是 QQ 通道整条
 * 不启动，而不是「这条白名单不生效」。限幅在这里做，超限条目被丢弃并由
 * `describeDroppedEntries` 记一条 warn，符合「只让该项不生效」的承诺。
 *
 * 丢弃与截断都是**收紧**方向，不会放宽授权，所以是安全的。
 */
export declare function normalizeMcpToolAllow(raw: readonly string[] | undefined): string[];
/**
 * 列出被归一化丢弃的条目（供接线处记 warn，便于管理员发现写错的白名单）。
 *
 * 只返回**原因分类计数**，不返回条目原文 —— 条目来自设置页文本框，可能误粘
 * token；插件日志比 QQ 群更持久，也更容易被 /doctor 打包带走。
 */
export declare function describeDroppedEntries(raw: readonly string[] | undefined): string[];
/**
 * 生成 guard 拒绝时给模型/群友看的一句话说明。
 *
 * **不回显白名单内容**：模型可能把这句话原样转述到 QQ 群，逐条列出已授权的
 * MCP 服务器/工具等于向群友公开管理员的接入清单。排障需要时看插件日志。
 */
export declare function describeMcpDenial(name: string): string;
/**
 * 构造 QQ 通道的工具 guard。
 *
 * 只接管 `mcp__` 前缀的工具，其余（qq_* 与宿主内置）一律放行 —— 本闸门只负责
 * 把 profile 级的 MCP 权限与 QQ 通道隔开，不改变其它工具的可用性。
 *
 * 唯一的例外是**取不到工具名**：此时无法判断这次调用是不是 MCP，任何一边的
 * 猜测都可能错（当成非 MCP ⇒ 静默放行所有 MCP；当成 MCP ⇒ 打死全部工具）。
 * 这里选择拒绝 —— 它说明与宿主的执行上下文契约已破裂，宁可让调用失败并暴露
 * 问题，也不让权限闸门静默失效。
 */
export declare function makeMcpToolGuard(rawAllow: readonly string[] | undefined): ToolGuard;
