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
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
/** 风控相关关键词：命中任意一个就提示「疑似风控」，不改判定为 not-logged-in。 */
const RISK_WORDS = [
    '风控', '风险', '限制登录', '冻结', '封禁', '验证码', '需要验证',
    '踢下线', '被迫下线', '异常登录', '登录失败', '密码错误',
];
/** 执行只读命令并按需回退 GBK 解码（中文 Windows 的 tasklist/netstat 输出可能是 GBK）。 */
function runLines(command) {
    try {
        const buffer = execSync(command, {
            timeout: 5_000,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const utf8 = buffer.toString('utf8');
        const text = utf8.includes('\uFFFD') ? buffer.toString('latin1') : utf8;
        return text.split(/\r?\n/).filter(line => line.trim() !== '');
    }
    catch {
        return [];
    }
}
/** ① NapCat 注入器进程是否存在。 */
function hasNapcatProcess() {
    const lines = runLines('tasklist /FI "IMAGENAME eq NapCatWinBootMain.exe" /NH /FO CSV');
    return lines.some(line => line.toLowerCase().includes('napcatwinbootmain'));
}
/** ② QQ 进程数与「是否为 NapCat 托管」。 */
function inspectQq() {
    const lines = runLines('tasklist /FI "IMAGENAME eq QQ.exe" /NH /FO CSV');
    const count = lines.filter(line => line.toLowerCase().includes('"qq.exe"')).length;
    if (count === 0)
        return { count: 0, hosted: false };
    // 命令行里带 NapCat 注入参数的才是托管实例；用 WMIC 取 CommandLine。
    const detail = runLines('wmic process where "name=\'QQ.exe\'" get ProcessId,CommandLine /format:list');
    const hosted = detail.some(line => /enable-logging|napcat|NapCat/i.test(line));
    return { count, hosted };
}
/** ④ 8643 是否有 ESTABLISHED 连接。 */
function isConnected(port) {
    const lines = runLines(`netstat -ano -p TCP`);
    const needle = `:${port}`;
    return lines.some(line => line.includes(needle) && /ESTABLISHED/i.test(line));
}
/** ③ 二维码文件距今分钟数。 */
function qrcodeAge(napcatDir) {
    const file = join(napcatDir, 'cache', 'qrcode.png');
    if (!existsSync(file))
        return null;
    try {
        return Math.round((Date.now() - statSync(file).mtimeMs) / 60_000);
    }
    catch {
        return null;
    }
}
/** ③ 读取最新日志尾部，命中风控关键词则返回摘要。 */
function scanRisk(napcatDir, tailLines) {
    const dir = join(napcatDir, 'logs');
    if (!existsSync(dir))
        return null;
    let newest;
    try {
        for (const name of readdirSync(dir)) {
            if (!name.endsWith('.log'))
                continue;
            const path = join(dir, name);
            const mtime = statSync(path).mtimeMs;
            if (newest === undefined || mtime > newest.mtime)
                newest = { path, mtime };
        }
    }
    catch {
        return null;
    }
    if (newest === undefined)
        return null;
    try {
        const raw = readFileSync(newest.path);
        const utf8 = raw.toString('utf8');
        const text = utf8.includes('\uFFFD') ? raw.toString('latin1') : utf8;
        const lines = text.split(/\r?\n/).filter(line => line.trim() !== '').slice(-tailLines);
        const hits = lines.filter(line => RISK_WORDS.some(word => line.includes(word)));
        if (hits.length === 0)
            return null;
        return hits.slice(-3).map(line => line.slice(0, 140)).join(' | ');
    }
    catch {
        return null;
    }
}
/** 一次性产出完整诊断；调用方负责决定如何呈现。 */
export function diagnoseNapcat(options) {
    const napcatProcess = hasNapcatProcess();
    const { count: qqProcesses, hosted: napcatHostedQq } = inspectQq();
    const wsConnected = isConnected(options.port);
    const age = options.napcatDir ? qrcodeAge(options.napcatDir) : null;
    const riskHint = options.napcatDir ? scanRisk(options.napcatDir, options.logTailLines ?? 400) : null;
    let stage;
    let summary;
    if (wsConnected) {
        stage = 'ok';
        summary = 'NapCat 已连接，QQ 通道正常。';
    }
    else if (riskHint !== null) {
        stage = 'risk-control';
        summary = 'NapCat 未连接，且日志里出现风控/异常关键词 —— 大概率被风控或需要验证。';
    }
    else if (!napcatProcess) {
        stage = 'no-process';
        summary = 'NapCat 注入器没有运行：NapCat 根本没启动。';
    }
    else if (qqProcesses > 0 && !napcatHostedQq) {
        stage = 'instance-conflict';
        summary = 'NapCat 注入器在跑，但 QQ 实例不是它托管的 —— 普通 QQ 抢占了实例。';
    }
    else if (!wsConnected) {
        stage = 'not-logged-in';
        summary = age === null
            ? 'NapCat 在跑但没有二维码，且未连接 —— 多半卡在登录。'
            : `NapCat 在跑但未连接，二维码 ${age} 分钟前生成 —— 多半卡在扫码（超过约 5 分钟即失效）。`;
    }
    else {
        stage = 'not-connected';
        summary = '未连接（未知原因）。';
    }
    return {
        stage,
        napcatProcess,
        qqProcesses,
        napcatHostedQq,
        wsConnected,
        qrcodeAgeMinutes: age,
        riskHint,
        summary,
    };
}
/** 把诊断渲染成多行文本（落日志 / 设置页共用）。 */
export function formatDiagnosis(d) {
    const lines = [
        `[NapCat 诊断] ${d.summary}`,
        `  ① 注入器进程 : ${d.napcatProcess ? '在运行' : '未运行'}`,
        `  ② QQ 实例    : ${d.qqProcesses} 个${d.napcatHostedQq ? '（NapCat 托管）' : '（无托管实例）'}`,
        `  ③ 登录/二维码: ${d.qrcodeAgeMinutes === null ? '无二维码' : `${d.qrcodeAgeMinutes} 分钟前生成`}`,
        `  ④ 8643 连接  : ${d.wsConnected ? '已连接' : '未连接'}`,
    ];
    if (d.riskHint !== null)
        lines.push(`  ⚠ 风控迹象  : ${d.riskHint}`);
    lines.push('  （插件不会启动或终止任何进程；如需处理请手动操作）');
    return lines.join('\n');
}
