/**
 * Media handling: inbound download/resolution (url / base64:// / file:// /
 * hash via get_image), 6h temp-file cleanup, and outbound base64 encoding.
 * Ported from the Hermes OneBotAdapter media half.
 * @module dsh-onebot/media
 */
/** Size limits (bytes), matching the Hermes adapter's constants. */
export declare const IMAGE_MAX_BYTES: number;
export declare const VOICE_MAX_BYTES: number;
export declare const MEDIA_MAX_BYTES: number;
/** One resolved media file. */
export interface ResolvedMedia {
    /** Absolute local path. */
    path: string;
    /** Mime-ish kind for the caller. */
    kind: 'image' | 'voice' | 'video' | 'file';
}
/** Options for the guarded download path (SSRF fence + size cap). */
export interface MediaStoreDownloadOptions {
    /** Default size cap for downloads issued by resolveInner (0/absent = uncapped). */
    maxBytes?: number;
    /** Escape hatch for local/NAT reverse-proxy deployments: skip the private-address check (protocol whitelist still applies). */
    allowPrivateHosts?: boolean;
}
/**
 * Media storage: a scratch directory under the plugin's media root.
 * Downloads land here with a TTL; cleanup runs on each inbound message.
 */
export declare class MediaStore {
    readonly dir: string;
    private readonly ttlHours;
    private readonly imageMaxSize;
    private readonly downloadMaxBytes;
    private readonly allowPrivateHosts;
    /**
     * @param dir - absolute scratch directory (created on demand).
     * @param ttlHours - files older than this are deleted on cleanup.
     * @param imageMaxSize - inbound-image long-edge cap in px; images larger
     *   than this are downscaled right after download (`<=0` disables).
     * @param download - download guards: the default size cap for resolveInner
     *   URL downloads and the allowPrivateHosts SSRF escape hatch.
     */
    constructor(dir: string, ttlHours: number, imageMaxSize?: number, download?: MediaStoreDownloadOptions);
    /** Ensure the scratch directory exists. */
    ensure(): Promise<void>;
    /** A fresh scratch file path with the given extension. */
    freshPath(ext: string): string;
    /**
     * Delete plugin scratch older than the TTL, whitelisted by name: only
     * `media_*` files and `stt_*` work dirs are ours to delete (state files
     * like chat-sessions.json share this directory and must survive).
     * Called on every inbound message; failures are logged and contained.
     */
    cleanupExpired(): Promise<void>;
    /**
     * Resolve one media reference (from cq.ts MediaRef) to a local file.
     * @param ref - the media reference.
     * @param resolveHash - callback for hash-only refs (calls get_image etc.);
     *   returns { url, file } or undefined when unresolvable.
     * @returns the resolved file, or undefined when the ref cannot be fetched.
     */
    resolve(ref: {
        kind: 'image' | 'voice' | 'video' | 'file';
        url?: string;
        file?: string;
    }, resolveHash: (kind: 'image' | 'voice' | 'video' | 'file', file: string) => Promise<{
        url?: string;
        file?: string;
    } | undefined>): Promise<ResolvedMedia | undefined>;
    /**
     * S-04：`file://` 引用的统一闸门。事件字段不可信，必须先把「不是媒体/文档」
     * 与「超过大小上限」拒掉，再读文件；否则任意宿主文件都会被复制进 mediaDir。
     */
    private assertLocalMediaSource;
    private resolveInner;
    /**
     * Download a URL into the scratch dir, behind the SSRF fence: http/https
     * only, private/loopback targets refused (unless allowPrivateHosts is on),
     * every redirect hop re-checked (max 3), and a hard wall-clock deadline
     * per download. The body is streamed so the size cap aborts mid-flight.
     * @param url - remote URL.
     * @param ext - file extension for the target.
     * @param maxBytes - size cap; `<=0`/undefined disables it.
     * @returns the local path.
     */
    downloadUrl(url: string, ext: string, maxBytes?: number): Promise<string>;
}
/** Guess a file extension for a URL. */
export declare function extForUrl(url: string, kind: 'image' | 'voice' | 'video' | 'file'): string;
/**
 * Whitelisted extension for an inbound (sender-controlled) file name: the
 * name itself never becomes the on-disk path (MediaStore.freshPath mints an
 * unpredictable media_<ts>_<uuid> name), only a validated trailing extension
 * is kept — same rule as extForUrl.
 */
export declare function extForInboundName(name: string): string;
/** Default extension per media kind. */
export declare function extForKind(kind: 'image' | 'voice' | 'video' | 'file'): string;
/**
 * Identify an image container from its magic bytes.
 *
 * `.bmp` 会被识别出来，但**宿主附件服务不支持该 MIME**（`dsh-attachment-local`
 * 的 `mediaTypes` 只有 png/jpeg/webp/gif，见 attach.ts 的 HOST_MEDIA_TYPES 注释）。
 * 因此 BMP 在本插件里的命运是：扩展名被校正成 `.bmp` → 附件投递判定为
 * `unsupported-type` → 退回 `[图片:<路径>]` 文本。识别它仍然有价值（避免一个
 * 真 BMP 被当成 `.jpg` 送给下游），只是不要把"识别"误当成"可投递"。
 * @param data - file bytes (only the head is inspected).
 * @returns the canonical extension ('.png' / '.jpg' / '.gif' / '.webp' /
 *   '.bmp'), or undefined when the bytes are not a recognised image.
 */
export declare function sniffImageExt(data: Buffer): string | undefined;
/**
 * Replace a scratch path's extension with the one its bytes actually carry.
 * The bytes win: QQ (and other OneBot implementations) routinely serve a
 * GIF or PNG under a `.jpg` URL, and a mismatch makes the downstream
 * sniffer refuse to treat the file as an image at all.
 * @param path - scratch path minted from the guessed extension.
 * @param data - the file bytes.
 * @returns `path` itself when the guess was right or the bytes are not a
 *   recognised image, otherwise the same name with the real extension.
 */
export declare function reconcileExt(path: string, data: Buffer): string;
/**
 * Resolve `target` through symlinks and require it to live under one of
 * `allowedRoots`: separator-boundary prefix match on both sides' realpaths,
 * so root /foo/bar does not contain /foo/baz. A symlink escaping every root
 * and a missing target both yield null — outbound media must exist to be
 * read, so there is no deepest-existing-ancestor fallback. Returns the
 * resolved realpath.
 */
export declare function resolveContainedPath(allowedRoots: string[], target: string): Promise<string | null>;
/**
 * Read a local file as a base64 data URI for OneBot media segments.
 * @param path - absolute file path.
 * @param maxBytes - size cap; exceeding it throws.
 * @param allowedRoots - when provided, the path is refused unless it
 *   resolves inside one of the roots (M1-A3a outbound fence; tools pass it
 *   once wired, until then absence keeps the legacy uncaged behavior).
 * @returns "base64://<data>".
 */
export declare function fileToBase64(path: string, maxBytes: number, allowedRoots?: string[]): Promise<string>;
/** Whether a string looks like a remote URL. */
export declare function isUrl(value: string): boolean;
