/**
 * Model-facing tools for the OneBot channel: media sends, merged forwards,
 * the whitelisted NapCat API proxy, and group history. Tools infer the target
 * chat from the calling agent's session; an explicit chat_id overrides.
 * @module dsh-onebot/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChatBridge } from './bridge.js';
import type { OneBotConnection } from './connection.js';
/**
 * Register all qq_* tools on the context. Registration is effect-based: the
 * returned disposer unregisters them.
 * @param ctx - plugin context.
 * @param bridge - the chat bridge.
 * @param connection - the OneBot connection.
 * @param limits - media size caps.
 * @returns the disposer.
 */
export declare function registerTools(ctx: Context, bridge: ChatBridge, connection: OneBotConnection, limits: {
    maxImageBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
}, options?: {
    memeDir?: string;
    mediaDir?: string;
    /**
     * 频道记忆：`enabled` 为 false 时两个记忆工具都不注册。
     *
     * `profileScope` 控制「成员画像」能在哪写：`'dm'`（默认，只有私聊）、
     * `'all'`（群聊也允许，但仍需管理员显式给 subject）、`'off'`（完全关闭）。
     */
    memory?: {
        enabled: boolean;
        dir: string;
        maxEntriesPerChat: number;
        recallTopK: number;
        profileScope: 'dm' | 'all' | 'off';
    };
}): () => void;
