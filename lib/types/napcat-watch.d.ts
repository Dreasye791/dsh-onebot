/**
 * NapCat 连接看护（本地补丁）。
 *
 * onebot 插件是**服务端**：它在 8643 上监听 `/ws`，等 NapCat 以反向 WebSocket
 * 连进来。NapCat 没起来时插件什么也不说，表现成「机器人不回消息、日志空白」，
 * 排查时只能靠翻 NapCat 日志猜。
 *
 * 这里做两件事（都由配置控制，默认不改变既有行为）：
 *   1. 检测：启动后与运行期定期检查是否已有客户端连上，未连则给出明确提示。
 *   2. 可选拉起：配置了 `napcatLauncher` 且 `autoStartNapcat` 为真时执行启动器，
 *      带退避与次数上限，避免反复拉起进程。
 *
 * 刻意不做的事：不杀任何进程。普通 QQ 占用实例是用户环境问题，插件只报告不处理。
 */
export type WatchLog = (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
export interface NapcatWatchOptions {
    /** 该 launcher 可执行文件路径；未配置则只提示，不拉起 */
    launcher?: string;
    /** 是否允许自动拉起（只有配置了 launcher 才有意义） */
    autoStart: boolean;
    /** NapCat.Shell 目录；缺省由 launcher 的父目录推导，用于读二维码与日志 */
    napcatDir?: string;
    /** onebot 监听端口（诊断用） */
    port: number;
    /** 首次检测延迟（毫秒），给 NapCat 自己连上留出时间 */
    initialDelayMs?: number;
    /** 运行期轮询间隔（毫秒）；<= 0 表示不轮询 */
    pollIntervalMs?: number;
    /** 最多自动拉起次数（避免无限重试） */
    maxLaunches?: number;
    /**
     * 额外提示（例如「只监听了环回地址」这类环境侧原因）。
     *
     * 只在首次告警时输出一次：这类提示做启动期 warn 会变成每次启动的噪声，
     * 挂在「确实没连上」的时刻才有信息量。
     */
    extraHint?: string;
    /**
     * 拉起器输出落盘路径（追加写）。留空 = 丢弃。
     *
     * 注入器在 QQ 已被占用时会**直接退出**，连 NapCat 自己的日志都不写 —— 输出一
     * 丢，外部就只能看到「进程不在、没有日志」，无从判断失败原因（2026-10-26 实测）。
     */
    logFile?: string;
    log: WatchLog;
}
export declare class NapcatWatch {
    private readonly options;
    private timer;
    private poll;
    private launches;
    private launching;
    private warned;
    private stopped;
    constructor(options: NapcatWatchOptions);
    /** 启动看护：延迟首检 + 可选轮询。 */
    start(isConnected: () => boolean): void;
    stop(): void;
    /** 连接状态变化时由外部调用：连上后重置告警与计数。 */
    notifyConnected(connected: boolean): void;
    private tick;
    /**
     * 只读诊断；目录未知或诊断抛错时返回 null（调用方回退到静态提示）。
     *
     * 诊断只查进程表、端口、日志文件，不 spawn、不 kill。
     */
    private diagnose;
    /**
     * 用 cmd /c 包一层，路径含空格也能正确执行；detached 让它不随插件卸载而退出。
     *
     * 先 `chcp 65001`：NapCat 的日志与控制台渲染都是 UTF-8，而 cmd 默认代码页是
     * GBK(936)，不切换的话窗口里全是方块乱码（「可用登录 of QQ」那类）。
     */
    private spawnLauncher;
}
