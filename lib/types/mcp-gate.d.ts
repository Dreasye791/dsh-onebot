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
/** 工具名是否属于 MCP（按宿主命名约定判前缀）。 */
export declare function isMcpToolName(name: string): boolean;
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
 */
export declare function matchMcpTool(name: string, allow: readonly string[]): boolean;
/** 归一化配置里的白名单：去空白、丢空项、去重（保序）。 */
export declare function normalizeMcpToolAllow(raw: readonly string[] | undefined): string[];
/** 生成 guard 拒绝时给模型/群友看的一句话说明。 */
export declare function describeMcpDenial(name: string, allow: readonly string[]): string;
/**
 * 构造 QQ 通道的工具 guard。
 *
 * 只接管 `mcp__` 前缀的工具，其余（qq_* 与宿主内置）一律放行。
 */
export declare function makeMcpToolGuard(rawAllow: readonly string[] | undefined): ToolGuard;
