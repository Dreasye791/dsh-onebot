/**
 * QQ 通道的 MCP 工具闸门（白名单，fail-closed）——类型声明。
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
}
/** 工具名是否属于 MCP（按宿主命名约定判前缀）。 */
export declare function isMcpToolName(name: string): boolean;
/**
 * 按 `mcp__<server>__<tool>` 约定解析工具名。
 *
 * 用 `split('__')` 而不是 `indexOf('__')`：服务器名的字符集允许单下划线
 * （`[A-Za-z0-9_-]{1,32}`），裸工具名也可能含 `__`。段数不足 2 说明不符合
 * 约定，返回 null 由调用方按 fail-closed 处理。
 */
export declare function parseMcpToolName(name: string): McpToolParts | null;
/** 从 `mcp__<server>__<tool>` 取服务器名；不符约定时返回 ''。 */
export declare function mcpServerOf(name: string): string;
/** 从 `mcp__<server>__<tool>` 取裸工具名；不符约定时返回去掉前缀的剩余部分。 */
export declare function mcpBareNameOf(name: string): string;
/**
 * 单条白名单条目是否命中某个 MCP 工具名。
 *
 * 支持四种写法：
 * - `*`：放行全部 MCP 工具。
 * - `mcp__akasha__akasha_search`：完整名精确命中。
 * - `mcp__akasha__*`：按服务器整体放行（也可写成服务器名 `akasha`）。
 * - `akasha_search`：裸工具名，命中**任意**服务器下的同名工具。
 *
 * 服务器名与裸工具名的比较都是**整段全等**，不做子串/前缀匹配。
 */
export declare function matchMcpTool(name: string, allow: readonly string[]): boolean;
/**
 * 归一化配置里的白名单：去空白、丢空项、丢无法识别的通配、去重（保序）。
 *
 * 丢弃不可识别的通配是**收紧**方向，不会放宽授权，所以是安全的；但它意味着
 * 写错的条目不会生效 —— 因此 `describeDroppedEntries` 供接线处记一条 warn。
 */
export declare function normalizeMcpToolAllow(raw: readonly string[] | undefined): string[];
/** 列出被归一化丢弃的条目（供接线处记 warn，便于管理员发现写错的白名单）。 */
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
 * 只接管 `mcp__` 前缀的工具，其余（qq_* 与宿主内置）一律放行。
 *
 * 唯一的例外是**取不到工具名**：此时无法判断这次调用是不是 MCP，选择拒绝 ——
 * 它说明与宿主的执行上下文契约已破裂，宁可让调用失败并暴露问题，也不让权限
 * 闸门静默失效。
 */
export declare function makeMcpToolGuard(rawAllow: readonly string[] | undefined): ToolGuard;
