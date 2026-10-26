/**
 * NapCat 状态诊断（只读）。
 *
 * onebot 插件是 WebSocket **服务端**，NapCat 没连上时通道静默不可用。
 * 「没连上」只是一个结果，真正需要知道的是**卡在哪一步**：
 *
 *   ① 进程   NapCatWinBootMain 有没有在跑
 *   ② 实例   有没有普通 QQ 抢占了实例（NapCat 注入需要独占）
 *   ③ 登录   QQ 是否已登录（二维码新鲜度 + 日志关键词，含风控）
 *   ④ 连接   8643 有没有 ESTABLISHED
 *
 * 本模块**只读**：查进程表、查端口、读日志文件。
 * 不 spawn 任何进程、不 kill 任何进程 —— 决定权留给用户。
 */
/**
 * 卡在哪一步。每个阶段都对应一个**用户可执行**的下一步（见 judgeNapcat 的文案）。
 *
 * 注意 `qq-conflict` 与 `instance-conflict` 的区别：后者曾试图区分「QQ 是否被
 * NapCat 托管」，判据是 WMIC 取命令行 —— 而 Windows 11 已移除 WMIC，该判据在
 * 本机恒为 false，于是只要 QQ 在跑就误报「实例被抢占」（2026-10-26 实测）。
 * 现在只依赖两个可靠事实（NapCat 进程在不在 / QQ 进程在不在）推导，不再猜托管。
 */
export type NapcatStage = 'no-process' | 'qq-conflict' | 'not-logged-in' | 'not-connected' | 'risk-control' | 'ok';
/** 判定所需的原始事实（全部来自只读探测）。judgeNapcat 只吃这些，便于单测。 */
export interface NapcatFacts {
    /** ① NapCatWinBootMain 是否存在 */
    napcatProcess: boolean;
    /** ② QQ.exe 进程数（**进程**，不是实例：QQ NT 一个客户端就有多个进程） */
    qqProcesses: number;
    /** 反向 WS 监听端口（判定文案要引用它） */
    port: number;
    /** ④ 端口上是否有 ESTABLISHED */
    wsConnected: boolean;
    /** ③ 二维码距今分钟数；无文件为 null */
    qrcodeAgeMinutes: number | null;
    /** ③ 日志里命中的风控关键词（最多 3 条） */
    riskHint: string | null;
}
export interface NapcatDiagnosis extends NapcatFacts {
    stage: NapcatStage;
    /** 一句话结论：说清卡在哪一步 + 下一步该做什么 */
    summary: string;
}
export interface DiagnoseOptions {
    /** NapCat.Shell 目录（含 cache/ 与 logs/） */
    napcatDir: string;
    port: number;
    /** 扫描日志的风控行数上限 */
    logTailLines?: number;
}
/**
 * 判定：facts → 阶段 + 结论。纯函数，不碰进程表，便于逐分支覆盖。
 *
 * 文案原则：每个阶段都要说清「卡在哪一步」和「下一步做什么」—— 这条结论会直接
 * 进 onebot.log 与设置页面板，用户不该靠猜。
 */
export declare function judgeNapcat(facts: NapcatFacts): {
    stage: NapcatStage;
    summary: string;
};
/** 一次性产出完整诊断；调用方负责决定如何呈现。 */
export declare function diagnoseNapcat(options: DiagnoseOptions): NapcatDiagnosis;
/** 把诊断渲染成多行文本（落日志 / 设置页共用）。 */
export declare function formatDiagnosis(d: NapcatDiagnosis): string;
