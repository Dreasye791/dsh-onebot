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
export type NapcatStage = 'no-process' | 'instance-conflict' | 'not-logged-in' | 'risk-control' | 'not-connected' | 'ok';
export interface NapcatDiagnosis {
    stage: NapcatStage;
    /** ① NapCatWinBootMain 是否存在 */
    napcatProcess: boolean;
    /** ② QQ.exe 进程数 */
    qqProcesses: number;
    /** ② 是否存在带 NapCat 注入标记的 QQ */
    napcatHostedQq: boolean;
    /** ④ 8643 是否有 ESTABLISHED */
    wsConnected: boolean;
    /** ③ 二维码距今分钟数；无文件为 null */
    qrcodeAgeMinutes: number | null;
    /** ③ 日志里命中的风控关键词（最多 3 条） */
    riskHint: string | null;
    /** 一句话结论（可直接落日志/展示到设置页） */
    summary: string;
}
export interface DiagnoseOptions {
    /** NapCat.Shell 目录（含 cache/ 与 logs/） */
    napcatDir: string;
    port: number;
    /** 扫描日志的风控行数上限 */
    logTailLines?: number;
}
/** 一次性产出完整诊断；调用方负责决定如何呈现。 */
export declare function diagnoseNapcat(options: DiagnoseOptions): NapcatDiagnosis;
/** 把诊断渲染成多行文本（落日志 / 设置页共用）。 */
export declare function formatDiagnosis(d: NapcatDiagnosis): string;
