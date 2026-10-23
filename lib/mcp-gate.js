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
 *
 * 本文件与 src/mcp-gate.ts 手工双写（宿主不提供编译链路），两侧语义必须逐函数
 * 一致。改任何一侧都要同步另一侧。
 * @module dsh-onebot/mcp-gate
 */
/** MCP 工具的命名前缀（宿主 `dsh-mcp-client` 固定用 `mcp__<server>__<tool>`）。 */
export const MCP_TOOL_PREFIX = 'mcp__';
/** 工具名是否属于 MCP（按宿主命名约定判前缀）。 */
export function isMcpToolName(name) {
    return name.startsWith(MCP_TOOL_PREFIX);
}
/**
 * 按 `mcp__<server>__<tool>` 约定解析工具名。
 *
 * 用 `split('__')` 而不是 `indexOf('__')`：服务器名的字符集允许单下划线
 * （`[A-Za-z0-9_-]{1,32}`），裸工具名也可能含 `__`。约定是「第 2 段是服务器，
 * 其余全部归工具」，因此按段切分才是稳定口径；段数不足 2 说明不符合约定，
 * 返回 null 由调用方按 fail-closed 处理。
 *
 * **段数 > 2 时边界有歧义**（无法区分 server 含 `__` 还是 tool 含 `__`），
 * 此时 `server`/`tool` 是按「server 取第一段」的口径给出的**最佳猜测**，
 * 只可用于展示与完整名精确比较；凡是按段放宽的判定（通配、服务器名简写、
 * 裸工具名）都必须看 `ambiguous` 并放弃 —— 否则 `mcp__dbx__*` 会连带放行
 * 真实服务器名为 `dbx__prod` 的全部工具，等于越权。
 */
export function parseMcpToolName(name) {
    if (!isMcpToolName(name))
        return null;
    const parts = name.slice(MCP_TOOL_PREFIX.length).split('__');
    if (parts.length < 2)
        return null;
    const server = parts[0] ?? '';
    const tool = parts.slice(1).join('__');
    if (server === '' || tool === '')
        return null;
    return { server, tool, ambiguous: parts.length > 2 };
}
/** 从 `mcp__<server>__<tool>` 取服务器名；不符约定时返回 ''。 */
export function mcpServerOf(name) {
    return parseMcpToolName(name)?.server ?? '';
}
/** 从 `mcp__<server>__<tool>` 取裸工具名；不符约定时返回去掉前缀的剩余部分。 */
export function mcpBareNameOf(name) {
    const parsed = parseMcpToolName(name);
    if (parsed !== null)
        return parsed.tool;
    return isMcpToolName(name) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}
/**
 * 白名单条目分类。
 *
 * 只承认三种形态，其余（含 `*` 但不是这两种通配、或是无意义的碎片）一律丢弃：
 * - `all`：单独的 `*`，放行全部 MCP 工具；
 * - `serverWildcard`：`mcp__<server>__*`，按服务器整体放行；
 * - `literal`：精确写法，可能是完整工具名、服务器名或裸工具名。
 *
 * 之所以要收紧：早期实现把任何含 `*` 的条目都编译成正则，并对「完整名 /
 * 裸工具名 / 服务器名」三个面同时 test，于是 `akasha*`、`*search*` 这类未
 * 文档化的写法会静默放大授权范围。
 *
 * 注意：只靠归类收不干净 `mcp__dbx__*` 连带放行 `mcp__dbx__prod__query` 的问题
 * —— 那条要靠 matchMcpTool 对 `ambiguous` 的判定（见该函数）。
 */
function classifyEntry(raw) {
    const pattern = raw.trim();
    if (pattern === '')
        return null;
    if (pattern === '*')
        return { kind: 'all' };
    if (pattern.includes('*')) {
        // 唯一支持的通配形态：mcp__<server>__*（server 段内不得再有 *）。
        if (!pattern.startsWith(MCP_TOOL_PREFIX) || !pattern.endsWith('__*'))
            return null;
        const server = pattern.slice(MCP_TOOL_PREFIX.length, -3);
        if (server === '' || server.includes('*'))
            return null;
        return { kind: 'serverWildcard', server };
    }
    return { kind: 'literal', value: pattern };
}
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
 * 的部分非空且不含 `__`」，也就是通配只覆盖**单段**工具名。这条规则让
 * `mcp__dbx__*` 不会连带放行真实服务器 `dbx__prod` 的工具
 * （余段是 `prod__query`，含 `__` ⇒ 不命中），而含 `__` 的服务器仍可被显式授权
 * （写 `mcp__dbx__prod__*`，余段 `query` 单段 ⇒ 命中）。
 *
 * 服务器名简写与裸工具名依赖段边界，歧义名（`ambiguous`）一律不命中，只能用
 * `*`、完整名或显式通配授权 —— 宁可多写一个字，也不静默放大权限。
 */
export function matchMcpTool(name, allow) {
    const parsed = parseMcpToolName(name);
    if (parsed === null)
        return false;
    for (const raw of allow) {
        if (typeof raw !== 'string')
            continue;
        const entry = classifyEntry(raw);
        if (entry === null)
            continue;
        if (entry.kind === 'all')
            return true;
        // 完整名精确命中在任何情况下都成立（它是唯一无歧义的判定）。
        if (entry.kind === 'literal' && entry.value === name)
            return true;
        if (entry.kind === 'serverWildcard') {
            const prefix = MCP_TOOL_PREFIX + entry.server + '__';
            if (!name.startsWith(prefix))
                continue;
            const rest = name.slice(prefix.length);
            if (rest !== '' && !rest.includes('__'))
                return true;
            continue;
        }
        // 以下两条依赖「第 2 段就是服务器、其余就是工具」，故歧义名放弃。
        if (parsed.ambiguous)
            continue;
        if (entry.value === parsed.server)
            return true;
        if (entry.value === parsed.tool)
            return true;
    }
    return false;
}
/**
 * 归一化配置里的白名单：去空白、丢空项、丢无法识别的通配、去重（保序）。
 *
 * 丢弃不可识别的通配是**收紧**方向，不会放宽授权，所以是安全的；但它意味着
 * 写错的条目不会生效 —— 因此 `describeDroppedEntries` 供接线处记一条 warn。
 */
export function normalizeMcpToolAllow(raw) {
    const out = [];
    const seen = new Set();
    for (const item of raw ?? []) {
        const value = typeof item === 'string' ? item.trim() : '';
        if (value === '' || seen.has(value))
            continue;
        if (classifyEntry(value) === null)
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}
/** 列出被归一化丢弃的条目（供接线处记 warn，便于管理员发现写错的白名单）。 */
export function describeDroppedEntries(raw) {
    const dropped = [];
    for (const item of raw ?? []) {
        if (typeof item !== 'string') {
            dropped.push(String(item));
            continue;
        }
        const value = item.trim();
        if (value === '')
            continue;
        if (classifyEntry(value) === null)
            dropped.push(value);
    }
    return dropped;
}
/**
 * 生成 guard 拒绝时给模型/群友看的一句话说明。
 *
 * **不回显白名单内容**：模型可能把这句话原样转述到 QQ 群，逐条列出已授权的
 * MCP 服务器/工具等于向群友公开管理员的接入清单。排障需要时看插件日志。
 */
export function describeMcpDenial(name) {
    if (name === '') {
        return '无法确定本次工具调用要访问哪个工具，QQ 通道已拒绝该调用（配置项 mcpToolAllow）。';
    }
    return 'MCP 工具「' + name + '」不在 QQ 通道的白名单内，已拒绝调用（配置项 mcpToolAllow）。';
}
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
export function makeMcpToolGuard(rawAllow) {
    const allow = normalizeMcpToolAllow(rawAllow);
    return (exec) => {
        if (exec === null || typeof exec !== 'object' || typeof exec.name !== 'string') {
            return describeMcpDenial('');
        }
        const name = exec.name;
        // 空名字与「取不到名字」同义：它是契约破裂的结果，不是「非 MCP 工具」的证据。
        // 若在这里走 isMcpToolName('') === false 放行，上面的专用文案就成了死分支，
        // 且「取不到工具名即拒绝」的承诺被自己的实现推翻。
        if (name === '')
            return describeMcpDenial('');
        if (!isMcpToolName(name))
            return undefined;
        if (matchMcpTool(name, allow))
            return undefined;
        return describeMcpDenial(name);
    };
}
