/**
 * Model-facing tools for the OneBot channel: media sends, merged forwards,
 * the whitelisted NapCat API proxy, and group history. Tools infer the target
 * chat from the calling agent's session; an explicit chat_id overrides.
 * @module dsh-onebot/tools
 */

import { realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import type { ChatBridge } from './bridge.js'
import type { OneBotConnection } from './connection.js'
import { fileToBase64, isUrl } from './media.js'
import { findSensitive, readAllMemories, readMemories, searchMemories, selectForRecall, speakerFromUserEvents, trimMemories, upsertMemory } from './memory.js'
import { splitChatId } from './chat.js'
import type { OneBotSegment } from './cq.js'
import { parseMessage, cqUnescape } from './cq.js'

/** OneBot actions a model may invoke through qq_napcat_api. */
const NAPCAT_API_WHITELIST = [
  'get_group_member_list',
  'get_group_member_info',
  'get_stranger_info',
  'get_forward_msg',
  'get_record',
  'get_file',
  'upload_group_file',
  'upload_private_file',
  'get_group_root_files',
  'get_group_files_by_folder',
  'get_group_file_url',
  'get_private_file_url',
  'ocr_image',
  'get_ai_characters',
  'send_group_ai_record',
]

/**
 * S-01：会写入群/私聊或让 NapCat 接触宿主文件系统的 action —— 仅管理员回合可用。
 * 白名单本身只挡 action 名，参数是原样透传给 NapCat 的，所以上传类 action
 * 一旦带上本地绝对路径就绕过了所有出站围栏（已真机验证）。
 */
const NAPCAT_PRIVILEGED_ACTIONS = new Set(['upload_group_file', 'upload_private_file', 'send_group_ai_record'])

/** Whether a string names a host-local file instead of a OneBot file id / base64 body. */
function looksLikeLocalPath(value: string): boolean {
  return value.startsWith('file://')
    || value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.includes('..')
}

/**
 * S-01/S-03：`qq_napcat_api` 的参数收口。
 * - 上传/写群类 action 仅管理员回合；
 * - `file` / `image` 只接受 file_id 或 `base64://`，本地路径一律拒（要发本地文件
 *   请用 qq_send_*，那条路径有围栏 + 大小限制 + 主动写闸门）；
 * - 群参数必须等于当前会话的群，避免借工具跨群写/读。
 */
function assertNapcatParams(
  action: string,
  params: Record<string, unknown>,
  chatId: string | undefined,
  isAdmin: boolean,
): void {
  if (NAPCAT_PRIVILEGED_ACTIONS.has(action) && !isAdmin) {
    throw new Error('qq_napcat_api: ' + action + ' 会写入群/私聊或让 NapCat 读取本地文件，仅管理员回合可用')
  }
  for (const key of ['file', 'image'] as const) {
    const value = params[key]
    if (typeof value === 'string' && looksLikeLocalPath(value)) {
      throw new Error('qq_napcat_api: ' + key + ' 只接受 file_id 或 base64:// 内容；本地文件请用 qq_send_file（受出站围栏与大小限制）')
    }
  }
  const target = params.group_id
  if (target !== undefined && chatId !== undefined) {
    const parted = splitChatId(chatId)
    if (parted.kind === 'group' && String(target) !== parted.target) {
      throw new Error('qq_napcat_api: group_id 必须等于当前会话的群号（拒绝跨群操作）')
    }
  }
}

/** Output projection shared by the send tools (unconstrained JSON value). */
function sendOutput() {
  return {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: unknown) => {
      const v = value as { messageId?: string | null }
      return [{ type: 'text' as const, text: v.messageId != null ? '已发送（message_id=' + v.messageId + '）' : '已发送' }]
    },
  }
}

/**
 * Resolve the target chat for a tool call.
 *
 * S-03：工具的默认目标永远是**调用者自己的会话**。显式 `chat_id` 只有在管理员
 * 回合才允许指向别的会话 —— 否则一条群消息里的提示注入就能让 bot 以自己身份
 * 向任意 QQ/群投递，或读任意群的历史（dm/group 策略在这些路径上不起作用）。
 * 取不到会话 id 时 fail-closed（QQ 工具只注册在 QQ agent 作用域内，取不到
 * 说明上下文契约已破裂）。
 */
function resolveChat(bridge: ChatBridge, exec: ToolRunContext, chatIdArg: unknown): string {
  const sessionId = exec.agent?.session.id
  const own = sessionId !== undefined ? bridge.chatForSession(String(sessionId)) : undefined
  const explicit = typeof chatIdArg === 'string' && chatIdArg !== '' ? chatIdArg : undefined
  if (explicit !== undefined) {
    if (own !== undefined && explicit === own) return own
    if (sessionId !== undefined && own !== undefined && bridge.canEditFiles(String(sessionId))) return explicit
    throw new Error('qq_* 工具：只有管理员回合可以指定别的 chat_id；当前会话为 ' + (own ?? '未知')
      + '，请省略 chat_id 或传当前会话')
  }
  if (own !== undefined) return own
  throw new Error('无法确定目标会话：当前调用没有关联到 QQ 会话（请省略 chat_id 使用默认目标）')
}

/**
 * Outbound media fence roots for the calling session's current turn
 * (M1-A3b): the plugin media dir always, plus the chat workspace on admin
 * turns. An unknown caller session degrades to mediaDir-only inside the
 * bridge — fail-closed.
 */
async function mediaRoots(bridge: ChatBridge, exec: ToolRunContext): Promise<string[]> {
  const gate = await bridge.mediaSendRoots(exec.agent?.session.id)
  return gate.roots
}

/**
 * Read one local media file behind the outbound fence, translating the
 * fence refusal (which reaches the model verbatim) into an actionable
 * hint; size-cap and OS errors keep their original message.
 */
async function fencedMediaFile(path: string, maxBytes: number, allowedRoots: string[]): Promise<string> {
  try {
    return await fileToBase64(path, maxBytes, allowedRoots)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('path not allowed or does not exist')) {
      throw new Error('本地路径不在允许的媒体目录内（管理员回合可另读会话工作区），或文件不存在：' + path)
    }
    throw error
  }
}

/**
 * S-11：`qq_send_image` 的 URL 分支把地址原样交给 NapCat 去取（SSRF 面在 NapCat
 * 进程），此前零校验——与本地路径的严格围栏形成明显落差。这里做三件低成本的事：
 * 只允许 http/https、拒绝带用户信息的 URL、拒绝指向本机/内网的字面量地址。
 *
 * 已知边界：域名解析到内网（DNS rebinding / 内网域名）在插件侧拦不住，取图动作
 * 发生在 NapCat；需要更强保证时应在 NapCat 侧做出站限制。
 */
function assertOutboundImageUrl(raw: string): void {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('qq_send_image: 图片 URL 不合法：' + raw)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('qq_send_image: 图片 URL 只支持 http/https（收到 ' + parsed.protocol + '）')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('qq_send_image: 图片 URL 不能包含用户名/密码')
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopbackOrPrivate = host === 'localhost' || host === '::1' || host === '0.0.0.0'
    || host.endsWith('.localhost') || host.endsWith('.local')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)
  if (loopbackOrPrivate) {
    throw new Error('qq_send_image: 图片 URL 不能指向本机/内网地址（SSRF 防护）：' + host)
  }
}

/** Image extensions a meme pack may contain. */
const MEME_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

/**
 * Resolve the meme pack directory, or `undefined` when the tool must not
 * register. Registration is skipped (not deferred to a send-time failure)
 * whenever the directory is missing or escapes `mediaDir`:
 *
 * - empty config → feature off;
 * - the outbound fence only allows `mediaDir` (+ the admin-turn workspace),
 *   so a `memeDir` outside it could never deliver a meme;
 * - `memeDir === mediaDir` is refused too: the temp dir for inbound images
 *   lives directly under `mediaDir`, so that layout would let the tool send
 *   some other chat's inbound picture as a "meme".
 *
 * Both sides are compared through `realpath`, so a symlink or `..` segment
 * cannot smuggle the pack out of the media root. Fail-closed: an unresolvable
 * root refuses the feature.
 */
function resolveMemeDir(memeDir: string, mediaDir: string): string | undefined {
  // Both must be configured: an empty mediaDir would otherwise make
  // realpathSync('') resolve to the process cwd and silently "contain" the
  // pack — a containment proof that means nothing.
  if (memeDir === '' || mediaDir === '') return undefined
  let memeReal: string
  let mediaReal: string
  try {
    memeReal = realpathSync(memeDir)
  } catch {
    return undefined // missing/unreadable pack
  }
  try {
    mediaReal = realpathSync(mediaDir)
  } catch {
    return undefined // unknown media root: cannot prove containment
  }
  const prefix = mediaReal.endsWith(sep) ? mediaReal : mediaReal + sep
  if (!memeReal.startsWith(prefix)) return undefined // outside, or equal to, mediaDir
  return memeReal
}

/** One meme candidate: its pack (tag) and absolute path. */
interface MemeEntry {
  tag: string
  name: string
  path: string
}

/**
 * Scan a meme directory laid out as `<memeDir>/<tag>/<file>.jpg` — the same
 * shape dsh-meme packs use, so a pack can be copied in as-is. Subdirectories
 * are the emotion tags; a flat directory (files directly under memeDir) is
 * read as one implicit `all` tag. Missing/unreadable directories yield an
 * empty list so the tool degrades to a clear "no memes" error instead of
 * throwing at registration time.
 */
async function scanMemes(memeDir: string): Promise<MemeEntry[]> {
  const out: MemeEntry[] = []
  let top: Array<{ name: string; isDir: boolean }>
  try {
    top = await readdir(memeDir, { withFileTypes: true }).then((list) =>
      list.map((d) => ({ name: d.name, isDir: d.isDirectory() })),
    )
  } catch {
    return out
  }
  const isImage = (name: string): boolean => MEME_IMAGE_EXTS.includes(name.slice(name.lastIndexOf('.')).toLowerCase())
  for (const item of top) {
    if (item.isDir) {
      const dir = join(memeDir, item.name)
      try {
        for (const file of await readdir(dir, { withFileTypes: true })) {
          if (file.isFile() && isImage(file.name)) out.push({ tag: item.name, name: file.name, path: join(dir, file.name) })
        }
      } catch {
        // unreadable pack: skip, keep the rest usable
      }
    } else if (isImage(item.name)) {
      out.push({ tag: 'all', name: item.name, path: join(memeDir, item.name) })
    }
  }
  return out
}

/** Pick one meme by tag/query; returns the match plus the tags that exist. */
function pickMeme(memes: MemeEntry[], tag: string, query: string): { hit?: MemeEntry; tags: string[] } {
  const tags = [...new Set(memes.map((m) => m.tag))].sort()
  let pool = memes
  const wanted = tag.trim().toLowerCase()
  if (wanted !== '') pool = pool.filter((m) => m.tag.toLowerCase() === wanted)
  const q = query.trim().toLowerCase()
  if (q !== '') {
    // Keyword search runs over the file name and the tag; unmatched words are
    // retried individually so "猫 比心" still hits "bixin.jpg".
    const words = q.split(/\s+/).filter((w) => w !== '')
    const match = (m: MemeEntry, w: string): boolean =>
      m.name.toLowerCase().includes(w) || m.tag.toLowerCase().includes(w)
    let hits = pool.filter((m) => words.every((w) => match(m, w)))
    if (hits.length === 0) hits = pool.filter((m) => words.some((w) => match(m, w)))
    pool = hits
  }
  if (pool.length === 0) return { tags }
  return { hit: pool[Math.floor(Math.random() * pool.length)], tags }
}

/**
 * Register all qq_* tools on the context. Registration is effect-based: the
 * returned disposer unregisters them.
 * @param ctx - plugin context.
 * @param bridge - the chat bridge.
 * @param connection - the OneBot connection.
 * @param limits - media size caps.
 * @returns the disposer.
 */
export function registerTools(
  ctx: Context,
  bridge: ChatBridge,
  connection: OneBotConnection,
  limits: { maxImageBytes: number; maxVoiceBytes: number; maxFileBytes: number },
  options: {
    memeDir?: string
    mediaDir?: string
    /**
     * 频道记忆：`enabled` 为 false 时两个记忆工具都不注册。
     *
     * `profileScope` 控制「成员画像」能在哪写：`'dm'`（默认，只有私聊）、
     * `'all'`（群聊也允许，但仍需管理员显式给 subject）、`'off'`（完全关闭）。
     */
    memory?: {
      enabled: boolean
      dir: string
      maxEntriesPerChat: number
      recallTopK: number
      profileScope: 'dm' | 'all' | 'off'
    }
  } = {},
): () => void {
  const disposers: Array<() => void> = []
  const register = (tool: Parameters<typeof ctx.tools.register>[0]): void => {
    try {
      disposers.push(ctx.tools.register(tool))
    } catch (error) {
      // 宿主的工具 registry 不按 agent 隔离：第二个 agent（群聊／另一个私聊）
      // 注册同名工具会抛 "tool ... is already registered"，整条 dispatch 直接
      // 失败。工具实现是 bridge 级的（靠 chat_id 参数或 exec.agent.session 反查
      // 目标），重复注册没有意义，跳过即可；否则会退化成「只有第一个 chat 能用」。
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('already registered')) return
      throw error
    }
  }

  register(defineTool({
    name: 'qq_send_image',
    description: '向 QQ 会话发送一张或多张图片（本地文件路径或 http(s) URL，最多 9 张）。用于回复用户时附带截图/生成图等。',
    parameters: {
      sources: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '图片来源：本地绝对路径或 http(s) URL，最多 9 个',
      },
      chat_id: {
        type: 'string',
        description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话',
      },
      caption: {
        type: 'string',
        description: '图片说明文字（可选，作为图片前的文本发送）',
      },
    },
    output: sendOutput(),
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = args as { sources?: unknown; chat_id?: unknown; caption?: unknown }
      const sources = Array.isArray(a.sources) ? a.sources.filter((s): s is string => typeof s === 'string') : []
      if (sources.length === 0) throw new Error('qq_send_image: sources 不能为空')
      if (sources.length > 9) throw new Error('qq_send_image: 一次最多 9 张图片')
      const chatId = resolveChat(bridge, exec, a.chat_id)
      const allowedRoots = await mediaRoots(bridge, exec)
      const segments: Array<{ type: string; data: Record<string, unknown> }> = []
      if (typeof a.caption === 'string' && a.caption !== '') {
        segments.push({ type: 'text', data: { text: a.caption } })
      }
      for (const source of sources) {
        if (isUrl(source)) {
          assertOutboundImageUrl(source)
          segments.push({ type: 'image', data: { url: source } })
        } else {
          segments.push({ type: 'image', data: { file: await fencedMediaFile(source, limits.maxImageBytes, allowedRoots) } })
        }
      }
      const messageId = await bridge.sendSegments(chatId, segments)
      return { sent: true, messageId: messageId ?? null }
    },
  }))

  register(defineTool({
    name: 'qq_send_voice',
    description: '向 QQ 会话发送一条语音消息（本地音频文件路径，mp3/wav/silk 等；NapCat 负责转码）。',
    parameters: {
      path: { type: 'string', required: true, description: '本地音频文件绝对路径' },
      chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
    },
    output: sendOutput(),
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = args as { path?: unknown; chat_id?: unknown }
      if (typeof a.path !== 'string' || a.path === '') throw new Error('qq_send_voice: path 必填')
      const chatId = resolveChat(bridge, exec, a.chat_id)
      const allowedRoots = await mediaRoots(bridge, exec)
      const messageId = await bridge.sendSegments(chatId, [
        { type: 'record', data: { file: await fencedMediaFile(a.path, limits.maxVoiceBytes, allowedRoots) } },
      ])
      return { sent: true, messageId: messageId ?? null }
    },
  }))

  register(defineTool({
    name: 'qq_send_video',
    description: '向 QQ 会话发送一条视频消息（本地视频文件绝对路径）。',
    parameters: {
      path: { type: 'string', required: true, description: '本地视频文件绝对路径' },
      chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
    },
    output: sendOutput(),
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = args as { path?: unknown; chat_id?: unknown }
      if (typeof a.path !== 'string' || a.path === '') throw new Error('qq_send_video: path 必填')
      const chatId = resolveChat(bridge, exec, a.chat_id)
      const allowedRoots = await mediaRoots(bridge, exec)
      const messageId = await bridge.sendSegments(chatId, [
        { type: 'video', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots) } },
      ])
      return { sent: true, messageId: messageId ?? null }
    },
  }))

  register(defineTool({
    name: 'qq_send_file',
    description: '向 QQ 会话发送一个文件（本地文件绝对路径）。',
    parameters: {
      path: { type: 'string', required: true, description: '本地文件绝对路径' },
      name: { type: 'string', description: '文件名（默认取路径文件名）' },
      chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
    },
    output: sendOutput(),
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = args as { path?: unknown; name?: unknown; chat_id?: unknown }
      if (typeof a.path !== 'string' || a.path === '') throw new Error('qq_send_file: path 必填')
      const chatId = resolveChat(bridge, exec, a.chat_id)
      const allowedRoots = await mediaRoots(bridge, exec)
      const name = typeof a.name === 'string' && a.name !== '' ? a.name : a.path.split('/').pop() ?? 'file'
      const messageId = await bridge.sendSegments(chatId, [
        { type: 'file', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots), name } },
      ])
      return { sent: true, messageId: messageId ?? null }
    },
  }))

  register(defineTool({
    name: 'qq_send_forward',
    description: '以「合并转发」形式向 QQ 会话发送多条消息（每条含发送者名和内容，适合代码+说明、分步报告等）。',
    parameters: {
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '显示名（≤24 字）' },
            content: { type: 'string', description: '消息内容（≤500 字，必填）' },
          },
          additionalProperties: true,
        },
        required: true,
        description: '合并转发的消息节点列表',
      },
      chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
    },
    output: sendOutput(),
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = args as { messages?: unknown; chat_id?: unknown }
      if (!Array.isArray(a.messages) || a.messages.length === 0) throw new Error('qq_send_forward: messages 不能为空')
      const nodes = a.messages.map(m => {
        const node = m as { name?: unknown; content?: unknown }
        return {
          name: typeof node.name === 'string' && node.name !== '' ? node.name : '助手',
          content: typeof node.content === 'string' ? node.content : '',
        }
      })
      if (nodes.some(n => n.content === '')) throw new Error('qq_send_forward: 每条消息都需要 content')
      const chatId = resolveChat(bridge, exec, a.chat_id)
      await bridge.sendForward(chatId, nodes)
      return { sent: true, messageId: null }
    },
  }))

  register(defineTool({
    name: 'qq_napcat_api',
    description: '调用 NapCat 白名单内的 OneBot 扩展 API（群成员列表/信息、文件、OCR、AI 语音等）。非白名单 action 会被拒绝。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: '白名单 action：' + NAPCAT_API_WHITELIST.join(' / '),
      },
      params: {
        type: 'object',
        additionalProperties: true,
        description: 'action 参数（JSON 对象）',
      },
    },
    output: { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = args as { action?: unknown; params?: unknown }
      if (typeof a.action !== 'string' || !NAPCAT_API_WHITELIST.includes(a.action)) {
        throw new Error('qq_napcat_api: action 不在白名单内（' + NAPCAT_API_WHITELIST.join(', ') + '）')
      }
      const params = typeof a.params === 'object' && a.params !== null ? a.params as Record<string, unknown> : {}
      // S-01/S-03：先按 action 与参数收口，再交给 NapCat。isAdmin 必须同时要求
      // 「会话存在」——canEditFiles 对未知 session 返回 true（非 QQ 会话默认信任），
      // 直接用它会把「查不到 chat 映射」当成管理员。
      const sessionId = exec.agent?.session.id
      const chatId = sessionId !== undefined ? bridge.chatForSession(String(sessionId)) : undefined
      const isAdmin = chatId !== undefined && sessionId !== undefined && bridge.canEditFiles(String(sessionId))
      assertNapcatParams(a.action, params, chatId, isAdmin)
      return await connection.call(a.action, params) as JsonValue
    },
  }))

  register(defineTool({
    name: 'qq_group_history',
    description: '拉取群聊最近消息历史（供总结群内上下文、查看用户之前的发言）。仅群聊可用。',
    parameters: {
      chat_id: { type: 'string', description: '目标群会话 group:<群号>；省略时默认当前会话（须为群聊）' },
      count: { type: 'number', description: '拉取条数（≤50，默认 20）' },
      message_seq: { type: 'number', description: '起始消息序号（翻页用，可选）' },
    },
    output: {
      schema: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      render: (_args: unknown, value: unknown) => {
        const list = Array.isArray(value) ? value : []
        return [{ type: 'text', text: list.length + ' 条历史消息' }]
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const a = args as { chat_id?: unknown; count?: unknown; message_seq?: unknown }
      const chatId = resolveChat(bridge, exec, a.chat_id)
      if (splitChatId(chatId).kind !== 'group') throw new Error('qq_group_history: 仅支持群聊')
      const groupId = Number(splitChatId(chatId).target)
      const count = Math.min(Math.max(typeof a.count === 'number' ? Math.floor(a.count) : 20, 1), 50)
      const params: Record<string, unknown> = { group_id: groupId, count }
      if (typeof a.message_seq === 'number') params.message_seq = a.message_seq
      const data = await connection.call('get_group_msg_history', params) as { messages?: unknown }
      const messages = Array.isArray(data.messages) ? data.messages : []
      return messages.map(m => {
        const msg = m as Record<string, unknown>
        const sender = (msg.sender ?? {}) as Record<string, unknown>
        const message = msg.message
        const segments = Array.isArray(message) ? message as OneBotSegment[] : undefined
        const raw = typeof msg.raw_message === 'string' ? msg.raw_message : ''
        const parsed = parseMessage(segments, raw)
        return {
          message_id: msg.message_id != null ? String(msg.message_id) : null,
          time: msg.time != null ? String(msg.time) : null,
          user_id: sender.user_id != null ? String(sender.user_id) : msg.user_id != null ? String(msg.user_id) : null,
          nickname: typeof sender.card === 'string' && sender.card !== '' ? sender.card
            : typeof sender.nickname === 'string' && sender.nickname !== '' ? sender.nickname
              : String(sender.user_id ?? ''),
          text: cqUnescape(parsed.text),
        }
      })
    },
  }))

  // Meme sending is optional: the tool registers only when the configured
  // directory both exists and resolves inside the media root, so the model
  // never sees a tool that cannot deliver (see resolveMemeDir).
  const memeDir = resolveMemeDir(options.memeDir !== undefined ? options.memeDir : '', options.mediaDir !== undefined ? options.mediaDir : '')
  if (memeDir !== undefined) {
    register(defineTool({
      name: 'qq_send_meme',
      description: '发一张表情包（MME）。按情绪标签随机抽一张，或按关键词搜。表情包目录由管理员预置，你只能从里面挑，不能自己生成或指定任意路径。气氛对了就主动发，不用等用户要求；发完正文保持简短，让图自己说话。',
      parameters: {
        tag: {
          type: 'string',
          description: '情绪标签（可选）：happy / angry / sad / shy / confused / daily / like / see / sleep / work / meow / baka / cpu / color / fool / givemoney / morning / sigh / surprised。只给 tag = 在该情绪里随机抽一张。',
        },
        query: {
          type: 'string',
          description: '关键词（可选）：按文件名或情绪标签子串搜，比只抽情绪准。中文词，空格分隔多个；整词没命中会自动拆词重试。',
        },
        chat_id: {
          type: 'string',
          description: '目标会话；省略时默认当前会话',
        },
      },
      output: {
        schema: { type: 'json' as const },
        render: (_args: unknown, value: unknown) => {
          const v = value as { sent?: boolean; tag?: string; name?: string }
          return [{ type: 'text' as const, text: v.sent === true ? ('已发送表情包（' + String(v.tag) + '/' + String(v.name) + '）') : '未发送' }]
        },
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const a = args as { tag?: unknown; query?: unknown; chat_id?: unknown }
        const tag = typeof a.tag === 'string' ? a.tag : ''
        const query = typeof a.query === 'string' ? a.query : ''
        const memes = await scanMemes(memeDir)
        if (memes.length === 0) throw new Error('qq_send_meme: 表情包目录为空或不可读：' + memeDir)
        const picked = pickMeme(memes, tag, query)
        if (picked.hit === undefined) {
          throw new Error(
            'qq_send_meme: 没有匹配的表情包（tag=' + tag + ' query=' + query + '）。可用标签：' + picked.tags.join(' / ') +
            '。换个 tag/query 再试，或直接回文字。',
          )
        }
        const hit = picked.hit
        // The meme dir lives inside mediaDir, so this file already satisfies the
        // outbound fence; keep using it so the size cap and containment check
        // stay in one place.
        const allowedRoots = await mediaRoots(bridge, exec)
        const chatId = resolveChat(bridge, exec, a.chat_id)
        const messageId = await bridge.sendSegments(chatId, [
          { type: 'image', data: { file: await fencedMediaFile(hit.path, limits.maxImageBytes, allowedRoots) } },
        ])
        return { sent: true, messageId: messageId ?? null, tag: hit.tag, name: hit.name }
      },
    }))
  }

  // 频道记忆（第一批）：显式 remember / recall 两个工具。
  //
  // 为什么先不做自动注入：记忆的价值取决于「记下来的内容是否真的有用」，
  // 而这只能靠实际用一段时间才知道；自动召回会改写每条消息的 prompt，出问题
  // 时难以归因。先把写入/检索打通，第二批再接 embedding 与自动注入。
  const memory = options.memory
  if (memory !== undefined && memory.enabled) {
    const memoryDir = memory.dir
    const cap = Math.max(1, Math.floor(memory.maxEntriesPerChat))
    const defaultTopK = Math.max(1, Math.min(20, Math.floor(memory.recallTopK)))
    const profileScope = memory.profileScope
    /** 私聊会话的主体就是对方本人；群聊取不到（需显式 subject）。 */
    const dmSubject = (chatId: string): string | undefined =>
      chatId.startsWith('private:') ? chatId.slice('private:'.length) : undefined

    register(defineTool({
      name: 'qq_memory_remember',
      description: '把一条值得长期记住的信息写进当前会话的记忆（按 chat 隔离，跨群/跨私聊不共享，重启不丢）。'
        + '两种 kind：note（默认，会话公共记忆）与 profile（某个成员的特征画像：称呼、偏好、习惯）。'
        + '适合记：重要约定、用户偏好、待办线索、需要反复引用的结论。不建议记：一次性闲聊、当前上下文已可见的内容、'
        + '对别人的负面评价（「他很烦」这类）、手机号/身份证/银行卡等敏感信息（会被直接拒绝）。'
        + '写之前建议先 qq_memory_recall 看有没有重复，避免同一事实反复记。',
      parameters: {
        text: {
          type: 'string',
          required: true,
          description: '要记住的内容，一句话为宜（超过 500 字会被截断）',
        },
        kind: {
          type: 'string',
          description: 'note（默认）= 会话公共记忆；profile = 某个成员的特征画像',
        },
        subject: {
          type: 'string',
          description: '画像主体 QQ 号。可省略：私聊默认取对话对方，群聊取本轮发言者（消息里的 qq 属性）。非管理员只能填自己，填别人会被拒绝',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选标签（偏好 / 待办 / 事实），参与检索打分，也决定保留时长：待办 14 天、偏好不过期、事实 365 天、无标签 90 天',
        },
        chat_id: {
          type: 'string',
          description: '目标会话（仅管理员回合可指定其他会话）；省略 = 当前会话',
        },
      },
      output: {
        schema: { type: 'json' as const },
        render: (_args: unknown, value: unknown) => {
          const v = value as { stored?: unknown; kind?: unknown }
          const stored = typeof v.stored === 'number' ? v.stored : 0
          return [{ type: 'text' as const, text: '已记住（' + (v.kind === 'profile' ? '画像' : '记忆') + '，当前会话共 ' + stored + ' 条）' }]
        },
      },
      // 写入是追加 + 可能重写裁剪，不做并发安全标记
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const a = args as { text?: unknown; tags?: unknown; chat_id?: unknown; kind?: unknown; subject?: unknown }
        const text = typeof a.text === 'string' ? a.text.trim() : ''
        if (text === '') throw new Error('qq_memory_remember: text 不能为空')
        const clipped = text.length > 500 ? text.slice(0, 500) : text
        const tags = Array.isArray(a.tags)
          ? a.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').slice(0, 8)
          : undefined
        // 敏感信息先拦：记忆以明文落盘，宁可拦错也不能把手机号/身份证写进文件。
        const sensitive = findSensitive(clipped)
        if (sensitive !== null) {
          throw new Error('qq_memory_remember: 内容疑似包含' + sensitive + '，已拒绝写入。'
            + '记忆是明文 JSONL 存盘，请不要记录手机号 / 身份证 / 银行卡等敏感信息。')
        }
        const chatId = resolveChat(bridge, exec, a.chat_id)
        const dm = dmSubject(chatId)
        // 「本轮发言者」：私聊就是对方；群聊从会话最后一条 user/message 的
        // `<user_message qq="…">` 里取（边界标签在 prompt 里已声明为可信元数据）。
        // 这一步替代了此前「群聊靠管理员手填 subject」的限制。
        // 取「本轮发言者」：私聊直接是对方；群聊**先问 bridge**（dispatch 时已把 QQ 与
        // 角色一起入队，turn/start 冻结成 activeTurnUser —— O(1) 且不依赖事件形状），
        // 拿不到再回落到读会话事件（覆盖 /retry 重放、宿主直接输入等未走 dispatch 的回合）。
        const sessionId = exec.agent?.session.id
        const speaker = dm
          ?? bridge.speakerFor(sessionId === undefined ? undefined : String(sessionId))
          ?? speakerFromUserEvents(exec.agent?.session?.ownEvents?.() ?? [])
        const role = bridge.canEditFiles(String(exec.agent?.session.id ?? '')) ? 'admin' as const : 'member' as const
        const kind = a.kind === 'profile' ? 'profile' as const : 'note' as const

        let subject: string | undefined
        if (kind === 'profile') {
          if (profileScope === 'off') {
            throw new Error('qq_memory_remember: 当前未启用成员画像（memoryProfileScope=off）。'
              + '如果这是会话公共信息，请改用 kind: note。')
          }
          if (dm === undefined && profileScope !== 'all') {
            throw new Error('qq_memory_remember: 群聊里默认不建个人画像（memoryProfileScope=' + profileScope + '）。'
              + '如果这是本群公共信息，请改用 kind: note；需要群内画像请让管理员把 memoryProfileScope 设为 all。')
          }
          const explicit = typeof a.subject === 'string' ? a.subject.trim() : ''
          if (explicit !== '') {
            // 显式指定：非管理员只能写自己（防止给别人贴标签），管理员不受限。
            if (role !== 'admin' && explicit !== speaker) {
              throw new Error('qq_memory_remember: 只能记录你自己的画像（当前发言者 '
                + (speaker ?? '未知') + '）；要记别人请让管理员操作。')
            }
            subject = explicit
          } else if (speaker !== undefined) {
            subject = speaker
          } else {
            throw new Error('qq_memory_remember: 取不到当前发言人（本轮消息里没有 qq 属性）。'
              + '请在 subject 里显式指定 QQ 号（非管理员只能填自己）。')
          }
        }

        // upsert：完全相同的条目只刷新「最近提及」，不重复堆行（与面板新建同一口径）。
        const write = upsertMemory(memoryDir, chatId, {
          ts: Date.now(),
          text: clipped,
          ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
          ...(kind === 'profile' && subject !== undefined ? { kind: 'profile' as const, subject } : {}),
          ...(speaker !== undefined ? { by: speaker } : {}),
          role,
        })
        const dropped = trimMemories(memoryDir, chatId, cap)
        const stored = readMemories(memoryDir, chatId, cap).length
        return { ok: true, stored, dropped, kind, refreshed: write.refreshed }
      },
    }))

    register(defineTool({
      name: 'qq_memory_recall',
      description: '按关键词检索当前会话的记忆，返回最相关的若干条（含写入时间）。'
        + '范围是「本会话的公共记忆」+「当前用户自己的画像」—— 别人的画像不会被返回。'
        + '当需要引用「之前记过什么」时先调用它，不要凭空猜测。只读，不修改记忆。'
        + '注意这是字面匹配（中文按 2-gram、英文按词）：问法换个词可能搜不到；'
        + '超过保留时长的条目也不会再返回。',
      parameters: {
        query: { type: 'string', required: true, description: '检索关键词' },
        limit: {
          type: 'number',
          description: '返回条数，默认 ' + defaultTopK + '，上限 20',
        },
        chat_id: {
          type: 'string',
          description: '目标会话（仅管理员回合可指定其他会话）；省略 = 当前会话',
        },
      },
      output: {
        schema: { type: 'json' as const },
        render: (_args: unknown, value: unknown) => {
          const v = value as { hits?: Array<{ text?: unknown; ts?: unknown; kind?: unknown }> }
          const hits = Array.isArray(v.hits) ? v.hits : []
          if (hits.length === 0) return [{ type: 'text' as const, text: '（没有匹配的记忆）' }]
          const fmt = (list: ReadonlyArray<{ text?: unknown; ts?: unknown }>): string => list.map((hit, index) => {
            const when = typeof hit.ts === 'number' && hit.ts > 0
              ? new Date(hit.ts).toISOString().slice(0, 16).replace('T', ' ')
              : '时间未知'
            return (index + 1) + '. [' + when + '] ' + String(hit.text ?? '')
          }).join('\n')
          const notes = hits.filter((hit) => hit.kind !== 'profile')
          const profiles = hits.filter((hit) => hit.kind === 'profile')
          const parts: string[] = []
          if (notes.length > 0) parts.push('相关记忆：\n' + fmt(notes))
          // 画像单独成段并标注「仅供参考」：它是观察不是定论，别让模型拿它当事实断言。
          if (profiles.length > 0) parts.push('关于当前用户的观察（画像，仅供参考，不要当定论）：\n' + fmt(profiles))
          return [{ type: 'text' as const, text: parts.join('\n\n') }]
        },
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const a = args as { query?: unknown; limit?: unknown; chat_id?: unknown }
        const query = typeof a.query === 'string' ? a.query.trim() : ''
        if (query === '') throw new Error('qq_memory_recall: query 不能为空')
        const rawLimit = typeof a.limit === 'number' && Number.isFinite(a.limit) ? Math.floor(a.limit) : defaultTopK
        const topK = Math.max(1, Math.min(20, rawLimit))
        const chatId = resolveChat(bridge, exec, a.chat_id)
        // 先按范围过滤（过期条目 / 别人的画像），再打分 —— 否则 top-k 会被不可见的条目占满。
        const visible = selectForRecall(readAllMemories(memoryDir, chatId), { speaker: dmSubject(chatId) })
        const hits = searchMemories(visible, query, topK)
        return {
          total: visible.length,
          hits: hits.map((hit) => ({
            ts: hit.entry.ts,
            text: hit.entry.text,
            tags: hit.entry.tags ?? [],
            score: hit.score,
            kind: hit.entry.kind ?? 'note',
          })),
        }
      },
    }))
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}
