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
import { dirname } from 'node:path';
import { diagnoseNapcat, formatDiagnosis } from './napcat-diagnose.js';
import type { NapcatDiagnosis } from './napcat-diagnose.js';

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
  log: WatchLog;
}

/** 未连接时的提示文案：把「为什么没反应」直接写清楚。 */
const HINT = [
  'NapCat 未连接：插件已在监听，但没有客户端连上，QQ 通道暂时不可用。',
  '请依次确认：',
  '  1. NapCat 已启动（NapCat.Shell\\launcher-user.bat）；',
  '  2. 没有普通 QQ 在运行 —— 它会抢占实例，导致 NapCat 注入失败；',
  '  3. QQ 已完成登录（登录后 NapCat 才会连上来）。',
].join('\n');

export class NapcatWatch {
  private timer: NodeJS.Timeout | undefined;
  private poll: NodeJS.Timeout | undefined;
  private launches = 0;
  private launching = false;
  private warned = false;
  private stopped = false;

  constructor(private readonly options: NapcatWatchOptions) {}

  /** 启动看护：延迟首检 + 可选轮询。 */
  start(isConnected: () => boolean): void {
    const delay = this.options.initialDelayMs ?? 8_000;
    this.timer = setTimeout(() => { void this.tick(isConnected); }, delay);
    this.timer.unref?.();

    const interval = this.options.pollIntervalMs ?? 0;
    if (interval > 0) {
      this.poll = setInterval(() => { void this.tick(isConnected); }, interval);
      this.poll.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.poll !== undefined) clearInterval(this.poll);
    this.timer = undefined;
    this.poll = undefined;
  }

  /** 连接状态变化时由外部调用：连上后重置告警与计数。 */
  notifyConnected(connected: boolean): void {
    if (connected) {
      this.warned = false;
      this.launches = 0;
    }
  }

  private async tick(isConnected: () => boolean): Promise<void> {
    if (this.stopped || isConnected()) return;

    const launcher = this.options.launcher?.trim() ?? '';
    const canLaunch = this.options.autoStart && launcher !== '';
    const max = this.options.maxLaunches ?? 2;

    // 拉起前先只读诊断：注入器进程已存在时**绝不**再拉一套。
    // 原实现只看「未连接」就 spawn，于是每次 tick 都可能再拉一个 NapCat + QQ，
    // 实测出现两三个窗口互相覆盖二维码文件，登录反而更难成功。
    const diagnosis = this.diagnose();
    const alreadyRunning = diagnosis !== null && diagnosis.napcatProcess;

    if (canLaunch && !alreadyRunning && this.launches < max && !this.launching) {
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
        this.options.log(
          'warn',
          '（检测到 NapCat 已在运行，插件不会重复启动，也不会终止任何进程）',
        );
      } else if (canLaunch && this.launches >= max) {
        this.options.log(
          'warn',
          `已尝试自动启动 ${this.launches} 次仍未连上；请手动检查 NapCat 与 QQ 登录状态。`,
        );
      }
    }
  }

  /**
   * 只读诊断；目录未知或诊断抛错时返回 null（调用方回退到静态提示）。
   *
   * 诊断只查进程表、端口、日志文件，不 spawn、不 kill。
   */
  private diagnose(): NapcatDiagnosis | null {
    const dir = this.options.napcatDir
      ?? (this.options.launcher !== undefined ? dirname(this.options.launcher) : '');
    if (dir === '') return null;
    try {
      return diagnoseNapcat({ napcatDir: dir, port: this.options.port });
    } catch {
      return null;
    }
  }

  /**
   * 用 cmd /c 包一层，路径含空格也能正确执行；detached 让它不随插件卸载而退出。
   *
   * 先 `chcp 65001`：NapCat 的日志与控制台渲染都是 UTF-8，而 cmd 默认代码页是
   * GBK(936)，不切换的话窗口里全是方块乱码（「可用登录 of QQ」那类）。
   */
  private spawnLauncher(launcher: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const child = spawn('cmd.exe', ['/c', `chcp 65001 >nul & "${launcher}"`], {
          detached: true,
          stdio: 'ignore',
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
      } catch (error) {
        this.options.log('warn', `NapCat 启动器无法执行：${String(error)}`);
        resolve(false);
      }
    });
  }
}
