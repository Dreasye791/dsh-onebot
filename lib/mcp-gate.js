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
export const MCP_TOOL_PREFIX = 'mcp__';
/** 工具名是否属于 MCP（按宿主命名约定判前缀）。 */
export function isMcpToolName(name) {
    return name.startsWith(MCP_TOOL_PREFIX);
}
/** 从 `mcp__<server>__<tool>` 取服务器名；不符约定时返回 ''。 */
export function mcpServerOf(name) {
    if (!isMcpToolName(name))
        return '';
    const rest = name.slice(MCP_TOOL_PREFIX.length);
    const cut = rest.indexOf('__');
    return cut <= 0 ? '' : rest.slice(0, cut);
}
/** 从 `mcp__<server>__<tool>` 取裸工具名；不符约定时返回去掉前缀的剩余部分。 */
export function mcpBareNameOf(name) {
    if (!isMcpToolName(name))
        return name;
    const rest = name.slice(MCP_TOOL_PREFIX.length);
    const cut = rest.indexOf('__');
    return cut <= 0 ? rest : rest.slice(cut + 2);
}
/** 把含 `*` 的通配串转成正则（`*` = 任意长度，其余字符按字面量）。 */
function wildcardToRegExp(pattern) {
    const escaped = pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp('^' + escaped + '$');
}
/**
 * 单条白名单条目是否命中某个 MCP 工具名。
 *
 * 支持四种写法（按书写成本从高到低，便于管理员按需精确或宽松）：
 * - `*`：放行全部 MCP 工具。
 * - `mcp__akasha__akasha_search`：完整名精确命中。
 * - `mcp__akasha__*`：按服务器整体放行（也可写成服务器名 `akasha`）。
 * - `akasha_search`：裸工具名，命中**任意**服务器下的同名工具。
 */
export function matchMcpTool(name, allow) {
    if (!isMcpToolName(name))
        return false;
    const bare = mcpBareNameOf(name);
    const server = mcpServerOf(name);
    for (const raw of allow) {
        const pattern = typeof raw === 'string' ? raw.trim() : '';
        if (pattern === '')
            continue;
        if (pattern === '*')
            return true;
        if (pattern.includes('*')) {
            const re = wildcardToRegExp(pattern);
            if (re.test(name) || re.test(bare) || re.test(server))
                return true;
            continue;
        }
        if (pattern === name)
            return true;
        if (pattern === bare)
            return true;
        if (pattern === server)
            return true;
    }
    return false;
}
/** 归一化配置里的白名单：去空白、丢空项、去重（保序）。 */
export function normalizeMcpToolAllow(raw) {
    const out = [];
    const seen = new Set();
    for (const item of raw ?? []) {
        const value = typeof item === 'string' ? item.trim() : '';
        if (value === '' || seen.has(value))
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}
/** 生成 guard 拒绝时给模型/群友看的一句话说明。 */
export function describeMcpDenial(name, allow) {
    const head = 'MCP 工具「' + name + '」不在 QQ 通道的白名单内';
    if (allow.length === 0) {
        return head + '：当前白名单为空（mcpToolAllow），QQ 通道已禁用全部 MCP 工具。';
    }
    return head + '：已允许 ' + allow.join('、') + '（配置项 mcpToolAllow）。';
}
/**
 * 构造 QQ 通道的工具 guard。
 *
 * 只接管 `mcp__` 前缀的工具，其余（qq_* 与宿主内置）一律放行 —— 本闸门只负责
 * 把 profile 级的 MCP 权限与 QQ 通道隔开，不改变其它工具的可用性。
 */
export function makeMcpToolGuard(rawAllow) {
    const allow = normalizeMcpToolAllow(rawAllow);
    return (exec) => {
        const name = typeof exec?.name === 'string' ? exec.name : '';
        if (!isMcpToolName(name))
            return undefined;
        if (matchMcpTool(name, allow))
            return undefined;
        return describeMcpDenial(name, allow);
    };
}
