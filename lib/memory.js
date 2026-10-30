/**
 * Channel memory: per-chat append-only notes, per-member profiles, keyword recall.
 *
 * 两个粒度：
 * - `note`：会话公共记忆（谁都能写，属于这个群/这个私聊）；
 * - `profile`：某个成员的特征（称呼、偏好、习惯），`subject` 是主体 QQ 号。
 *
 * 为什么先做关键词而不是向量：宿主 `@deepseek-ai/dsh-llm` 不提供 embedding
 * （只有 resolveModelInfo），向量化必须自带服务/模型。先用零依赖的关键词召回
 * 验证「记忆对体验是否有用」，再接向量 —— `searchMemories` 的签名不用变。
 *
 * 存储选型：**JSONL 追加写**，不引 better-sqlite3 —— 本项目已因
 * `@napi-rs/canvas` 这类原生模块踩过平台绑定的坑，记忆是增强功能，不值得
 * 再背一个原生依赖。单 chat 量级（默认 200 条）用纯文本完全够。
 *
 * @module dsh-onebot/memory
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * 按标签决定的 TTL（天）。`0` = 不过期。
 *
 * 为什么要分档：一刀切会让两类内容都不合适 —— 「周五要交周报」留着半年只会
 * 误导；「叫他小明」却是长期有效的事实。这里只看第一个命中的标签，未命中用
 * 默认值。
 */
export const TTL_DAYS_BY_TAG = {
    待办: 14,
    偏好: 0,
    事实: 365,
};
/** 没有命中任何标签时的默认 TTL（天）。 */
export const DEFAULT_TTL_DAYS = 90;
/** 该条记忆的 TTL（天）；`0` = 永不过期。 */
export function ttlDaysFor(entry) {
    for (const tag of entry.tags ?? []) {
        const days = TTL_DAYS_BY_TAG[tag];
        if (days !== undefined)
            return days;
    }
    return DEFAULT_TTL_DAYS;
}
/**
 * 是否已过期（**绝对过期**：从写入时刻起算，被 recall 多少次都不续期）。
 *
 * 为什么不做滑动过期：那需要每次 recall 回写 `lastUsedAt`，而 recall 的语义
 * 是只读（工具描述里写明了「只读，不修改记忆」）；「常用的记忆」也不等于
 * 「正确的记忆」。过期只是**不再被召回**，文件里的原文保留（软过期）。
 */
export function isExpired(entry, now = Date.now()) {
    const days = ttlDaysFor(entry);
    if (days <= 0)
        return false;
    return now - entry.ts > days * 24 * 60 * 60 * 1000;
}
/**
 * 按范围筛出可被召回的条目。
 *
 * 规则：
 * - 过期的**一律**排除（不论 note 还是 profile）；
 * - `note` 属于整个会话，总是候选；
 * - `profile` 只为「当前发言者自己」返回 —— 别人的画像不该在你面前被翻出来。
 */
export function selectForRecall(entries, scope = {}) {
    const now = scope.now ?? Date.now();
    const includeProfiles = scope.includeProfiles !== false;
    const speaker = scope.speaker;
    return entries.filter((entry) => {
        if (isExpired(entry, now))
            return false;
        if ((entry.kind ?? 'note') === 'note')
            return true;
        if (!includeProfiles)
            return false;
        if (speaker === undefined || speaker === '')
            return false;
        return entry.subject === speaker;
    });
}
/**
 * 敏感信息识别：命中即拒绝写入。
 *
 * 只覆盖「一眼可辨、误记代价高」的三类。刻意不做宽松匹配（如任意长数字），
 * 否则正常编号也会被拦。返回人类可读的类别名，`null` = 未命中。
 */
export function findSensitive(text) {
    // 按「整段连续数字」判长度，而不是在长串里找子串：
    // 最初用 `1[3-9]\d{9}` 无边界匹配，18 位身份证里的 11 位连续数字会被当成手机号，
    // 13 位时间戳也会被截取命中（`1` + `7` + 9 位）。长度口径没有这个问题。
    //
    // 18 位里最后一位可能是 X（校验位），单独判一次。
    if (/(^|\D)\d{17}[Xx](\D|$)/.test(text))
        return '身份证号';
    for (const match of text.matchAll(/\d+/g)) {
        const digits = match[0];
        const length = digits.length;
        if (length === 18)
            return '身份证号';
        if (length === 11 && /^1[3-9]/.test(digits))
            return '手机号';
        // 16–19 位纯数字按银行卡处理。19 位订单号之类会被误拦 —— 宁可多拦，
        // 记错的代价远高于拦错的代价。
        if (length >= 16 && length <= 19)
            return '银行卡号';
    }
    return null;
}
/**
 * chatId → 安全文件名。
 *
 * chatId 形如 `private:123456` / `group:789`，冒号在 Windows 文件名里非法，
 * 因此把所有非 `[A-Za-z0-9._-]` 换成下划线。碰撞风险可接受：chatId 的字符集
 * 来自 OneBot 的纯数字 id 与固定前缀。
 */
export function memoryFileName(chatId) {
    return chatId.replace(/[^A-Za-z0-9._-]/g, '_') + '.jsonl';
}
/** 某个 chat 的记忆文件绝对路径。 */
export function memoryFilePath(memoryDir, chatId) {
    return join(memoryDir, memoryFileName(chatId));
}
/** 追加一条记忆；目录不存在时自动创建。 */
export function appendMemory(memoryDir, chatId, entry) {
    mkdirSync(memoryDir, { recursive: true });
    appendFileSync(memoryFilePath(memoryDir, chatId), JSON.stringify(entry) + '\n', 'utf8');
}
/**
 * 写入一条记忆，并把「完全相同的条目」折成一次提及。
 *
 * 判重口径是 **kind + subject + text 三者全等**，只做精确匹配 —— 近似去重需要相似度
 * 计算（第二批上 embedding 之后再做）。这样重复说同一件事不会堆成几十行，同时
 * `lastSeenAt` 能回答「这条印象最近一次被提到是什么时候」。
 *
 * 注意 `appendMemory` 保持原语义（无条件追加），单测与历史调用方不受影响。
 */
export function upsertMemory(memoryDir, chatId, entry) {
    const entries = readAllMemories(memoryDir, chatId);
    const kindOf = (item) => item.kind ?? 'note';
    const index = entries.findIndex((existing) => kindOf(existing) === kindOf(entry)
        && (existing.subject ?? '') === (entry.subject ?? '')
        && existing.text === entry.text);
    if (index < 0) {
        appendMemory(memoryDir, chatId, { ...entry, lastSeenAt: entry.ts });
        return { refreshed: false };
    }
    entries[index] = { ...entries[index], lastSeenAt: entry.ts };
    writeAll(memoryDir, chatId, entries);
    return { refreshed: true };
}
/** 把条目序列化回 JSONL（裁剪/删除共用）。 */
function writeAll(memoryDir, chatId, entries) {
    try {
        mkdirSync(memoryDir, { recursive: true });
        writeFileSync(memoryFilePath(memoryDir, chatId), entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf8');
        return true;
    }
    catch {
        return false;
    }
}
/** 解析一行；非法返回 null（坏行跳过，不让整个文件失效）。 */
function parseLine(line) {
    const trimmed = line.trim();
    if (trimmed === '')
        return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed.text !== 'string' || parsed.text === '')
            return null;
        const tags = Array.isArray(parsed.tags)
            ? parsed.tags.filter((t) => typeof t === 'string')
            : undefined;
        const kind = parsed.kind === 'profile' ? 'profile' : undefined;
        const role = parsed.role === 'admin' ? 'admin' : parsed.role === 'member' ? 'member' : undefined;
        const by = typeof parsed.by === 'string' && parsed.by !== '' ? parsed.by : undefined;
        const subject = typeof parsed.subject === 'string' && parsed.subject !== '' ? parsed.subject : undefined;
        const lastSeenAt = typeof parsed.lastSeenAt === 'number' && Number.isFinite(parsed.lastSeenAt) && parsed.lastSeenAt > 0
            ? parsed.lastSeenAt
            : undefined;
        // 向量只在「全是有限数字且非空」时才认；任何一项坏了就整条丢弃 —— 半个向量
        // 参与余弦会算出无意义的分，比没有向量更糟（正确做法是当作未编码，走关键词）。
        const emb = Array.isArray(parsed.emb)
            && parsed.emb.length > 0
            && parsed.emb.every((value) => typeof value === 'number' && Number.isFinite(value))
            ? parsed.emb
            : undefined;
        const dim = emb !== undefined ? emb.length : undefined;
        return {
            ts: typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) ? parsed.ts : 0,
            text: parsed.text,
            ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(by !== undefined ? { by } : {}),
            ...(role !== undefined ? { role } : {}),
            ...(subject !== undefined ? { subject } : {}),
            ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
            ...(emb !== undefined ? { emb } : {}),
            ...(dim !== undefined ? { dim } : {}),
        };
    }
    catch {
        return null;
    }
}
/** 读取某个 chat 的全部记忆（旧→新）。 */
export function readAllMemories(memoryDir, chatId) {
    const file = memoryFilePath(memoryDir, chatId);
    if (!existsSync(file))
        return [];
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    }
    catch {
        return [];
    }
    const entries = [];
    for (const line of raw.split('\n')) {
        const entry = parseLine(line);
        if (entry !== null)
            entries.push(entry);
    }
    return entries;
}
/** 读取某个 chat 的记忆（旧→新），`max` 只保留最近的若干条。 */
export function readMemories(memoryDir, chatId, max = 200) {
    const entries = readAllMemories(memoryDir, chatId);
    return entries.length > max ? entries.slice(entries.length - max) : entries;
}
/**
 * 把某个 chat 的记忆裁剪到最近 `max` 条（原地重写）。
 *
 * 追加式存储不裁剪会无限增长；这里在每次写入后调用，代价是每次重写整个文件
 * —— 200 条量级下可以接受。
 *
 * @returns 被丢弃的条数（0 表示未裁剪）。
 */
export function trimMemories(memoryDir, chatId, max) {
    if (max <= 0)
        return 0;
    const all = readAllMemories(memoryDir, chatId);
    if (all.length <= max)
        return 0;
    const kept = all.slice(all.length - max);
    return writeAll(memoryDir, chatId, kept) ? all.length - kept.length : 0;
}
/**
 * 删掉某个主体的全部画像（`/memory forget`）。
 *
 * `subject` 为空时删掉所有 profile（管理员清理用，调用方负责判权）。
 *
 * @returns 被删除的条数。
 */
export function forgetProfiles(memoryDir, chatId, subject) {
    const all = readAllMemories(memoryDir, chatId);
    const kept = all.filter((entry) => {
        if ((entry.kind ?? 'note') !== 'profile')
            return true;
        if (subject === undefined || subject === '')
            return false;
        return entry.subject !== subject;
    });
    const removed = all.length - kept.length;
    if (removed === 0)
        return 0;
    return writeAll(memoryDir, chatId, kept) ? removed : 0;
}
/**
 * 按谓词批量删除（`qq_memory_forget` 用），一次重写整个文件。
 *
 * 为什么不复用 `deleteMemory`：那个按 `ts` 删**单条**，而 forget 需要「关键词命中
 * + 权限过滤」的组合条件，逐条删会重写 N 次文件。
 *
 * @returns 被删除的条目（调用方用它回显「删了什么」，否则模型只能猜）。
 */
export function deleteMemoriesWhere(memoryDir, chatId, predicate) {
    const all = readAllMemories(memoryDir, chatId);
    const removed = [];
    const kept = [];
    for (const entry of all) {
        if (predicate(entry))
            removed.push(entry);
        else
            kept.push(entry);
    }
    if (removed.length === 0)
        return [];
    return writeAll(memoryDir, chatId, kept) ? removed : [];
}
/** `private_123.jsonl` → `private:123`；不是记忆文件时返回 undefined（`memoryFileName` 的逆）。 */
export function chatIdFromFileName(name) {
    if (!name.toLowerCase().endsWith('.jsonl'))
        return undefined;
    const base = name.slice(0, name.length - '.jsonl'.length);
    const match = /^(private|group)_(.+)$/.exec(base);
    return match === null ? undefined : match[1] + ':' + match[2];
}
/**
 * 列出所有记忆文件（**只 stat，不解析内容**）。
 *
 * 面板会话列表靠它：解析上千条 JSON 只为显示「有几个会话」不值得，
 * 大小与 mtime 足以排序与展示；具体条目由 `readMemoryEntries` 按需分页读取。
 */
export function listMemoryFiles(memoryDir) {
    let names;
    try {
        names = readdirSync(memoryDir);
    }
    catch {
        return [];
    }
    const files = [];
    for (const name of names) {
        const chatId = chatIdFromFileName(name);
        if (chatId === undefined)
            continue;
        try {
            const info = statSync(join(memoryDir, name));
            if (!info.isFile())
                continue;
            files.push({ chatId, bytes: info.size, mtimeMs: info.mtimeMs });
        }
        catch {
            // 遍历过程中被删：跳过
        }
    }
    return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}
/**
 * 整文件原子重写（update/delete 共用）。
 *
 * 面板保存时模型可能正好在 `appendMemory`，直接覆盖会丢掉那次追加 —— 先写 `.tmp` 再
 * `rename` 保证读到的永远是完整文件；代价是极端并发下仍可能丢一条追加，与「记忆是
 * 增强功能、不阻塞主链路」的既有取舍一致。
 */
function rewriteMemories(memoryDir, chatId, entries) {
    mkdirSync(memoryDir, { recursive: true });
    const body = entries.length === 0 ? '' : entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    const file = memoryFilePath(memoryDir, chatId);
    const temp = file + '.tmp';
    writeFileSync(temp, body, 'utf8');
    renameSync(temp, file);
}
/** 按 `ts` 更新一条记忆；返回是否命中（同毫秒多条时只改第一条）。 */
export function updateMemory(memoryDir, chatId, ts, patch) {
    const entries = readAllMemories(memoryDir, chatId);
    const index = entries.findIndex((entry) => entry.ts === ts);
    if (index < 0)
        return false;
    const next = { ...entries[index] };
    const textChanged = patch.text !== undefined && patch.text !== entries[index].text;
    if (patch.text !== undefined)
        next.text = patch.text;
    if (patch.tags !== undefined) {
        if (patch.tags.length === 0)
            delete next.tags;
        else
            next.tags = patch.tags;
    }
    // 正文改了 → 旧向量指向的是**旧语义**，必须失效。
    //
    // 保留它比删掉更糟：向量不变而文本变，这条记忆会在**不相关**的查询里被召回
    // （虚假相似），而且看起来「一切正常」，极难发现。`dim` 也一并清掉，让后台补齐
    // 任务按 `emb === undefined` 统一处理「新增未编码」与「编辑后失效」两种来源。
    //
    // 只改 tags 不失效：标签只参与关键词打分，不进 embedding。
    if (textChanged) {
        delete next.emb;
        delete next.dim;
    }
    entries[index] = next;
    rewriteMemories(memoryDir, chatId, entries);
    return true;
}
/** 按 `ts` 删除一条记忆；返回是否命中。 */
export function deleteMemory(memoryDir, chatId, ts) {
    const entries = readAllMemories(memoryDir, chatId);
    const kept = entries.filter((entry) => entry.ts !== ts);
    if (kept.length === entries.length)
        return false;
    rewriteMemories(memoryDir, chatId, kept);
    return true;
}
/** 中文按 2-gram、英文/数字按连续片段切词；结果去重并小写。 */
export function tokenize(text) {
    const lower = text.toLowerCase();
    const tokens = new Set();
    // 英文/数字片段
    for (const m of lower.matchAll(/[a-z0-9]+/g)) {
        if (m[0].length >= 2)
            tokens.add(m[0]);
    }
    // 连续汉字：长度 1 保留单字，长度 ≥2 出 2-gram 与整段
    for (const m of lower.matchAll(/[\u4e00-\u9fa5]+/g)) {
        const run = m[0];
        if (run.length === 1) {
            tokens.add(run);
            continue;
        }
        tokens.add(run);
        for (let i = 0; i + 1 < run.length; i += 1)
            tokens.add(run.slice(i, i + 2));
    }
    return [...tokens];
}
/** 取一条 user/message 事件的纯文本（content 可能是字符串或 blocks 数组）。 */
function textOfUserEvent(data) {
    if (data === null || typeof data !== 'object')
        return undefined;
    const content = data.content;
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return undefined;
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object')
            continue;
        const typed = block;
        if (typed.type === 'text' && typeof typed.text === 'string')
            parts.push(typed.text);
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
}
/**
 * 从会话事件里取「本轮发言者」的 QQ 号。
 *
 * 入站文本形如 `[11:30 昵称(10001)][@我] <user_message qq="10001" nickname="…">…`，
 * 而 prompt 已声明「边界标签本身是可信元数据」。所以只需要**最后一条** user/message：
 * 解析不到就返回 undefined（不要往前翻历史 —— 那会把上一轮的发言者安到这一轮头上）。
 *
 * 为什么要取**第一个** `<user_message`：引用/转发展开会在内部再嵌一层同名标签，
 * 第一个才是本体。
 *
 * 纯函数，便于单测（工具侧只负责把 `session.ownEvents()` 喂进来）。
 */
export function speakerFromUserEvents(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === null || typeof event !== 'object')
            continue;
        if (event.type !== 'user/message')
            continue;
        const text = textOfUserEvent(event.data);
        if (text === undefined)
            return undefined;
        return /<user_message[^>]*\sqq="(\d+)"/.exec(text)?.[1];
    }
    return undefined;
}
/**
 * 一条记忆的关键词相关度（0~1）：命中词数 / 查询词数，长词加权，长度做轻微惩罚。
 *
 * 抽成独立函数是为了让「纯关键词」与「混合召回」用**同一份口径** —— 两套实现
 * 会慢慢漂移，表现为同一条记忆在 recall 与面板搜索里的命中顺序不一样。
 *
 * @param entry - 记忆条目（正文 + 标签一起参与匹配）。
 * @param queryTokens - 已切好的查询词（调用方负责，避免每条重复分词）。
 */
export function keywordScore(entry, queryTokens) {
    if (queryTokens.length === 0)
        return 0;
    const haystack = entry.text + (entry.tags !== undefined ? ' ' + entry.tags.join(' ') : '');
    const entryTokens = new Set(tokenize(haystack));
    let weight = 0;
    let matched = 0;
    for (const token of queryTokens) {
        if (!entryTokens.has(token))
            continue;
        matched += 1;
        // 长词更能代表意图（「螺蛳粉」比「粉」更有区分度）
        weight += Math.min(token.length, 4);
    }
    if (matched === 0)
        return 0;
    const coverage = matched / queryTokens.length;
    const lengthPenalty = 1 / (1 + Math.log10(1 + entry.text.length / 100));
    return Number((coverage * lengthPenalty + weight * 0.001).toFixed(4));
}
/**
 * 关键词召回：命中词数 / 查询词数，长词加权，长度做轻微惩罚。
 *
 * 这是「字面召回」——「辣的粉」搜不到「螺蛳粉」。语义召回见 `searchMemoriesHybrid`。
 */
export function searchMemories(entries, query, topK = 5) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || topK <= 0)
        return [];
    const hits = [];
    for (const entry of entries) {
        const score = keywordScore(entry, queryTokens);
        if (score <= 0)
            continue;
        hits.push({ entry, score });
    }
    hits.sort((a, b) => (b.score - a.score) || (b.entry.ts - a.entry.ts));
    return hits.slice(0, topK);
}
/**
 * 余弦相似度（0~1，负相关压到 0）。
 *
 * 维度不一致直接返回 0 —— 它只是一个打分分量，不该抛错；真正的「维度不兼容」
 * 由调用方按 `emb.length` 过滤（见 `searchMemoriesHybrid`）。
 */
export function cosineSimilarity(left, right) {
    if (left.length === 0 || left.length !== right.length)
        return 0;
    let dot = 0;
    let normLeft = 0;
    let normRight = 0;
    for (let index = 0; index < left.length; index += 1) {
        const a = left[index];
        const b = right[index];
        dot += a * b;
        normLeft += a * a;
        normRight += b * b;
    }
    if (normLeft === 0 || normRight === 0)
        return 0;
    const cosine = dot / Math.sqrt(normLeft * normRight);
    // 负相关当成 0：语义相反不该得到「半个命中」，否则它会挤掉真正无关但中性的条目。
    return cosine > 0 ? Number(cosine.toFixed(4)) : 0;
}
/**
 * 混合召回：关键词分与语义分加权。
 *
 * 三条口径：
 * 1. **有向量且维度匹配** → `w × cos + (1−w) × keyword`；
 * 2. **无向量 / 维度不符**（历史条目、编码失败、换过模型）→ **只按关键词分**，
 *    不打折。打折会让历史条目被系统性压低，而用户看到的只是「排序莫名其妙」；
 * 3. 关键词为 0 但语义很高 → 仍然入选，这正是语义召回存在的意义。
 */
export function searchMemoriesHybrid(entries, query, options = {}) {
    const topK = options.topK ?? 5;
    if (topK <= 0)
        return [];
    const queryTokens = tokenize(query);
    const queryVector = options.queryVector;
    const semantic = queryVector !== undefined && queryVector.length > 0;
    if (queryTokens.length === 0 && !semantic)
        return [];
    const weight = Number.isFinite(options.weight) ? Math.max(0, Math.min(1, options.weight)) : 0.6;
    const hits = [];
    for (const entry of entries) {
        const keyword = keywordScore(entry, queryTokens);
        let score = keyword;
        if (semantic && entry.emb !== undefined && entry.emb.length === queryVector.length) {
            score = weight * cosineSimilarity(queryVector, entry.emb) + (1 - weight) * keyword;
        }
        if (score <= 0)
            continue;
        hits.push({ entry, score: Number(score.toFixed(4)) });
    }
    hits.sort((a, b) => (b.score - a.score) || (b.entry.ts - a.entry.ts));
    return hits.slice(0, topK);
}
