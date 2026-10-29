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
    // tool 以 `_` 开头 ⇒ 可能有一个下划线属于 server 名（`dbx_` + `query`）。
    return { server, tool, ambiguous: parts.length > 2 || tool.startsWith('_') };
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
/** 把一条原始白名单条目归类；不可识别时返回 null（丢弃并让调用方记 warn）。 */
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
            // 余段必须是一整段工具名：非空、不含 `__`、也不以 `_` 开头
            // （以 `_` 开头说明服务器名其实更长，例如 `dbx_` 而不是 `dbx`）。
            if (rest !== '' && !rest.includes('__') && !rest.startsWith('_'))
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
/** 白名单单条的最大长度；超长条目在归一化时丢弃（收紧，不是放宽）。 */
export const MCP_ALLOW_ITEM_MAX_LEN = 128;
/** 白名单最多接受的条数；超出的尾巴在归一化时截断（收紧）。 */
export const MCP_ALLOW_MAX_ENTRIES = 256;
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
export function normalizeMcpToolAllow(raw) {
    const out = [];
    const seen = new Set();
    for (const item of raw ?? []) {
        if (out.length >= MCP_ALLOW_MAX_ENTRIES)
            break;
        const value = typeof item === 'string' ? item.trim() : '';
        if (value === '' || seen.has(value))
            continue;
        if (value.length > MCP_ALLOW_ITEM_MAX_LEN)
            continue;
        if (classifyEntry(value) === null)
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}
/**
 * 列出被归一化丢弃的条目（供接线处记 warn，便于管理员发现写错的白名单）。
 *
 * 只返回**原因分类计数**，不返回条目原文 —— 条目来自设置页文本框，可能误粘
 * token；插件日志比 QQ 群更持久，也更容易被 /doctor 打包带走。
 */
export function describeDroppedEntries(raw) {
    const dropped = [];
    let overLong = 0;
    let unrecognized = 0;
    let overflow = 0;
    let accepted = 0;
    for (const item of raw ?? []) {
        if (accepted >= MCP_ALLOW_MAX_ENTRIES) {
            // 与 normalizeMcpToolAllow 同口径：按**已接受条数**判断溢出，
            // 而不是按原始下标（空项与重复项不占名额，按下标判会虚报）。
            if (typeof item === 'string' && item.trim() !== '')
                overflow += 1;
            continue;
        }
        if (typeof item !== 'string') {
            unrecognized += 1;
            continue;
        }
        const value = item.trim();
        if (value === '')
            continue;
        if (value.length > MCP_ALLOW_ITEM_MAX_LEN) {
            overLong += 1;
            continue;
        }
        if (classifyEntry(value) === null) {
            unrecognized += 1;
            continue;
        }
        accepted += 1;
    }
    if (overLong > 0)
        dropped.push(`${overLong} 条超长（单项上限 ${MCP_ALLOW_ITEM_MAX_LEN} 字符）`);
    if (unrecognized > 0)
        dropped.push(`${unrecognized} 条写法无法识别`);
    if (overflow > 0)
        dropped.push(`${overflow} 条超出条数上限（最多 ${MCP_ALLOW_MAX_ENTRIES} 条）`);
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
 * 第三方插件注册的**原生工具**前缀黑名单（这些名字不以 `mcp__` 开头，因此
 * `mcpToolAllow` 管不到它们）。
 *
 * 为什么需要：`mcpToolAllow` 只接管 `mcp__*`；而其它插件注册的工具名不带这个前缀 ——
 * `dsh-mnemon` 就注册了二十多个 `mnemon_*`（`recall` / `remember` / `forget` /
 * `document_search` / `runtime_memory` …），它们直接读写宿主**全局**记忆库
 * （本机 `G:\dsh-home\.mnemon`，与工作区共享，不按 chat 隔离）。QQ 会话若能调用，
 * 就等于在群聊里能翻出与群无关的工作记忆。
 *
 * 为什么是常量而不是配置键：这是一条安全默认值，放宽应当经过代码评审；将来若确需
 * 按部署放开某个前缀，再引入配置键（届时键集 +1，设置页与测试同步）。
 *
 * 为什么用 guard 而不是 `tools.restrict`：`restrict({ deny })` 要求列出**确切存在**
 * 的工具名（unknown names 直接抛错），而宿主 `ToolRuntime` 没有公开的工具枚举方法 ——
 * 硬编码十几个名字，一旦 mnemon 升级改名或未安装，就会在 agent 创建时抛错。guard 是
 * 调用期拒绝，代价是模型看得到工具名，但不会因为环境差异而炸掉会话。
 */
export const NATIVE_TOOL_DENY_PREFIXES = ['mnemon_'];
/**
 * 原生第三方工具被拒时给模型/群友看的一句话。
 *
 * 与其他拒绝一样**不回显接入清单**：说明「来自第三方插件、连接宿主全局数据」即可，
 * 不需要让群友知道装了哪些插件。
 */
export function describeNativeDenial(name) {
    return '工具「' + name + '」由第三方插件提供，连接的是宿主的工作区/外部数据，与 QQ 会话无关，'
        + 'QQ 通道已拒绝调用。需要查这些内容请在 Web 端操作。';
}
/**
 * 构造 QQ 通道的工具 guard。
 *
 * 处理三类名字：
 * 1. **原生第三方工具**（`NATIVE_TOOL_DENY_PREFIXES`）→ 拒绝。必须先判，因为它们不带
 *    `mcp__` 前缀，走到下一行就会被当成普通工具放行。
 * 2. `mcp__*` → 按 `mcpToolAllow` 白名单判。
 * 3. 其余（qq_*、宿主内置）→ 放行 —— 本闸门只负责把外部数据源与 QQ 通道隔开。
 *
 * 唯一的例外是**取不到工具名**：此时无法判断这次调用属于哪一类，任何一边的猜测都
 * 可能错（当成非 MCP ⇒ 静默放行所有 MCP；当成 MCP ⇒ 打死全部工具）。这里选择拒绝 ——
 * 它说明与宿主的执行上下文契约已破裂，宁可让调用失败并暴露问题，也不让权限闸门静默失效。
 *
 * `denyPrefixes` 可覆盖（测试与将来放宽用）；传空数组即只按 MCP 白名单管控。
 */
export function makeMcpToolGuard(rawAllow, denyPrefixes = NATIVE_TOOL_DENY_PREFIXES) {
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
        if (denyPrefixes.some((prefix) => prefix !== '' && name.startsWith(prefix))) {
            return describeNativeDenial(name);
        }
        if (!isMcpToolName(name))
            return undefined;
        if (matchMcpTool(name, allow))
            return undefined;
        return describeMcpDenial(name);
    };
}
