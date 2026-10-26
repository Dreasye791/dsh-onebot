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
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { diagnoseNapcat, formatDiagnosis } from './napcat-diagnose.js';
/** 未连接时的提示文案：把「为什么没反应」直接写清楚。 */
const HINT = [
    'NapCat 未连接：插件已在监听，但没有客户端连上，QQ 通道暂时不可用。',
    '请依次确认：',
    '  1. NapCat 已启动（NapCat.Shell\\launcher-user.bat）；',
    '  2. 没有普通 QQ 在运行 —— 它会抢占实例，导致 NapCat 注入失败；',
    '  3. QQ 已完成登录（登录后 NapCat 才会连上来）。',
].join('\n');
/** cmd 元字符：这些出现在参数里会被当成管道/重定向/变量展开。 */
const CMD_UNSAFE = /[&|<>^%!"\r\n]/;
/**
 * 把 launcher 路径与参数拼成一条 `cmd /c` 命令。
 *
 * 参数来自 patch config（管理员手写），必须做转义：含 `& | < > ^ % !"`
 * 的参数会被 cmd 当作命令分隔/重定向/变量展开 —— 轻则拉起失败，重则执行配置里
 * 根本没写的命令。这类参数直接丢弃（fail-closed），`dropped` 交给调用方 warn；
 * 日志里不回显条目原文（防把 token 类内容写进日志，与 mcpToolAllow 同口径）。
 */
export function buildLauncherCommand(launcher, args = []) {
    const kept = [];
    const dropped = [];
    for (const raw of args) {
        const arg = raw.trim();
        if (arg === '')
            continue;
        if (CMD_UNSAFE.test(arg)) {
            dropped.push(arg);
            continue;
        }
        kept.push(/\s/.test(arg) ? '"' + arg + '"' : arg);
    }
    // chcp 65001：NapCat 输出 UTF-8，中文控制台默认 GBK 936 → 乱码。
    const base = 'chcp 65001 >nul & "' + launcher + '"';
    return { command: kept.length === 0 ? base : base + ' ' + kept.join(' '), dropped };
}
export class NapcatWatch {
    options;
    timer;
    poll;
    launches = 0;
    launching = false;
    warned = false;
    stopped = false;
    constructor(options) {
        this.options = options;
    }
    /** 启动看护：延迟首检 + 可选轮询。 */
    start(isConnected) {
        const delay = this.options.initialDelayMs ?? 8_000;
        this.timer = setTimeout(() => { void this.tick(isConnected); }, delay);
        this.timer.unref?.();
        const interval = this.options.pollIntervalMs ?? 0;
        if (interval > 0) {
            this.poll = setInterval(() => { void this.tick(isConnected); }, interval);
            this.poll.unref?.();
        }
    }
    stop() {
        this.stopped = true;
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        if (this.poll !== undefined)
            clearInterval(this.poll);
        this.timer = undefined;
        this.poll = undefined;
    }
    /** 连接状态变化时由外部调用：连上后重置告警与计数。 */
    notifyConnected(connected) {
        if (connected) {
            this.warned = false;
            this.launches = 0;
        }
    }
    async tick(isConnected) {
        if (this.stopped || isConnected())
            return;
        const launcher = this.options.launcher?.trim() ?? '';
        const canLaunch = this.options.autoStart && launcher !== '';
        const max = this.options.maxLaunches ?? 2;
        // 拉起前先只读诊断：注入器进程已存在时**绝不**再拉一套。
        // 原实现只看「未连接」就 spawn，于是每次 tick 都可能再拉一个 NapCat + QQ，
        // 实测出现两三个窗口互相覆盖二维码文件，登录反而更难成功。
        const diagnosis = this.diagnose();
        const alreadyRunning = diagnosis !== null && diagnosis.napcatProcess;
        // QQ 已占用时注入器必然接管失败：此时不 spawn。否则只会在日志里留下两次无意义
        // 的「尝试启动」然后静默消失（注入器直接退出、不写日志），把真原因盖住。
        const qqConflict = diagnosis?.stage === 'qq-conflict';
        if (canLaunch && !alreadyRunning && !qqConflict && this.launches < max && !this.launching) {
            this.launching = true;
            this.launches += 1;
            this.options.log('info', `NapCat 未运行，尝试启动第 ${this.launches}/${max} 次：${launcher}`);
            const ok = await this.spawnLauncher(launcher);
            this.launching = false;
            if (ok) {
                // 拉起来后给它时间连上；下一次 tick 才会判断是否仍然未连
                this.warned = false;
                return;
            }
            this.options.log('warn', `NapCat 启动器执行失败：${launcher}`);
        }
        if (!this.warned) {
            this.warned = true;
            this.options.log('warn', diagnosis !== null ? formatDiagnosis(diagnosis) : HINT);
            const hint = this.options.extraHint?.trim() ?? '';
            if (hint !== '') {
                this.options.log('warn', hint);
            }
            if (alreadyRunning) {
                this.options.log('warn', '（检测到 NapCat 已在运行，插件不会重复启动，也不会终止任何进程）');
            }
            else if (qqConflict) {
                this.options.log('warn', '（QQ 已在运行：插件不会尝试拉起 NapCat —— 已启动的 QQ 无法被注入接管，请先完全退出 QQ）');
            }
            else if (canLaunch && this.launches >= max) {
                this.options.log('warn', `已尝试自动启动 ${this.launches} 次仍未连上；请手动检查 NapCat 与 QQ 登录状态。`);
            }
        }
    }
    /**
     * 只读诊断；目录未知或诊断抛错时返回 null（调用方回退到静态提示）。
     *
     * 诊断只查进程表、端口、日志文件，不 spawn、不 kill。
     */
    diagnose() {
        const dir = this.options.napcatDir
            ?? (this.options.launcher !== undefined ? dirname(this.options.launcher) : '');
        if (dir === '')
            return null;
        try {
            return diagnoseNapcat({ napcatDir: dir, port: this.options.port });
        }
        catch {
            return null;
        }
    }
    /**
     * 用 cmd /c 包一层，路径含空格也能正确执行；detached 让它不随插件卸载而退出。
     *
     * 先 `chcp 65001`：NapCat 的日志与控制台渲染都是 UTF-8，而 cmd 默认代码页是
     * GBK(936)，不切换的话窗口里全是方块乱码（「可用登录 of QQ」那类）。
     */
    spawnLauncher(launcher) {
        return new Promise((resolve) => {
            const file = this.options.logFile?.trim() ?? '';
            let out = 'ignore';
            if (file !== '') {
                try {
                    out = openSync(file, 'a');
                    appendFileSync(out, `\n=== ${new Date().toISOString()} spawn launcher: ${launcher} ===\n`);
                }
                catch {
                    out = 'ignore';
                }
            }
            const { command, dropped } = buildLauncherCommand(launcher, this.options.launcherArgs);
            if (dropped.length > 0) {
                this.options.log('warn', `napcatLauncherArgs 有 ${dropped.length} 个参数含 shell 元字符（& | < > ^ % ! "）已被忽略，`
                    + '条目原文不打印；请在配置里核对');
            }
            try {
                const child = spawn('cmd.exe', ['/c', command], {
                    detached: true,
                    // Windows 必设：Node 默认会给 args 做引号转义（" → \"），cmd /c 不认
                    // \"G:\...\launcher.bat\" 这种命令名，直接报「不是内部或外部命令」——
                    // 拉起静默失败、launcher 一次都没真正执行（2026-10-26 实测：默认转义
                    // 的 cmd 输出 \\\"path\\\"，verbatim 输出 "path"）。
                    windowsVerbatimArguments: true,
                    // 落盘而不是丢弃：注入器在 QQ 已占用时会直接退出、连 NapCat 自己的日志
                    // 都不写，这里是判断失败原因的唯一现场。
                    stdio: ['ignore', out, out],
                    windowsHide: true,
                });
                child.once('error', (error) => {
                    this.options.log('warn', `NapCat 启动器无法执行：${String(error)}`);
                    resolve(false);
                });
                // 只要成功拉起进程就算成功，不等待它退出（launcher 会一直跑着 QQ）
                child.once('spawn', () => {
                    child.unref();
                    resolve(true);
                });
            }
            catch (error) {
                this.options.log('warn', `NapCat 启动器无法执行：${String(error)}`);
                resolve(false);
            }
            finally {
                // 子进程已继承自己的句柄副本；父进程这份用完即关，否则每次拉起泄漏一个 fd。
                if (out !== 'ignore') {
                    try {
                        closeSync(out);
                    }
                    catch { /* 已失效 */ }
                }
            }
        });
    }
}
