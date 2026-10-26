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

/**
 * 卡在哪一步。每个阶段都对应一个**用户可执行**的下一步（见 judgeNapcat 的文案）。
 *
 * 注意 `qq-conflict` 与 `instance-conflict` 的区别：后者曾试图区分「QQ 是否被
 * NapCat 托管」，判据是 WMIC 取命令行 —— 而 Windows 11 已移除 WMIC，该判据在
 * 本机恒为 false，于是只要 QQ 在跑就误报「实例被抢占」（2026-10-26 实测）。
 * 现在只依赖两个可靠事实（NapCat 进程在不在 / QQ 进程在不在）推导，不再猜托管。
 */
export type NapcatStage =
  | 'no-process'
  | 'qq-conflict'
  | 'not-logged-in'
  | 'not-connected'
  | 'risk-control'
  | 'ok';

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

/**
 * NapCat 登录二维码有效期（分钟）。
 *
 * NapCat 每约 5 分钟刷新一次二维码，超过这个时长 `cache/qrcode.png` 里的图
 * 已不可用 —— 面板若继续展示，用户扫了也没反应（2026-10-26 实测：登录成功
 * 7 分钟后设置页仍在显示那张旧码）。
 */
export const QRCODE_TTL_MINUTES = 5;

/** 风控相关关键词：命中任意一个就提示「疑似风控」，不改判定为 not-logged-in。 */
const RISK_WORDS = [
  '风控', '风险', '限制登录', '冻结', '封禁', '验证码', '需要验证',
  '踢下线', '被迫下线', '异常登录', '登录失败', '密码错误',
];

/** 执行只读命令并按需回退 GBK 解码（中文 Windows 的 tasklist/netstat 输出可能是 GBK）。 */
function runLines(command: string): string[] {
  try {
    const buffer = execSync(command, {
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const utf8 = buffer.toString('utf8');
    const text = utf8.includes('\uFFFD') ? buffer.toString('latin1') : utf8;
    return text.split(/\r?\n/).filter(line => line.trim() !== '');
  } catch {
    return [];
  }
}

/** ① NapCat 注入器进程是否存在。 */
function hasNapcatProcess(): boolean {
  const lines = runLines('tasklist /FI "IMAGENAME eq NapCatWinBootMain.exe" /NH /FO CSV');
  return lines.some(line => line.toLowerCase().includes('napcatwinbootmain'));
}

/**
 * ② QQ.exe 进程数。
 *
 * 只数进程、不判定「是否被 NapCat 托管」：原实现用 `wmic process ... get CommandLine`
 * 匹配 napcat 关键字，而 Windows 11 已移除 WMIC（实测 `wmic /?` 退出码 255），
 * runLines 的 catch 返回空数组 → hosted 恒为 false → 只要 QQ 在跑就误报「实例被
 * 普通 QQ 抢占」（2026-10-26 实测事故）。另外进程数也不等于实例数：QQ NT 是
 * Electron 多进程架构，一个正常客户端就有 5~10+ 个 QQ.exe。
 */
function countQqProcesses(): number {
  const lines = runLines('tasklist /FI "IMAGENAME eq QQ.exe" /NH /FO CSV');
  return lines.filter(line => line.toLowerCase().includes('"qq.exe"')).length;
}

/** ④ 8643 是否有 ESTABLISHED 连接。 */
function isConnected(port: number): boolean {
  const lines = runLines(`netstat -ano -p TCP`);
  const needle = `:${port}`;
  return lines.some(line => line.includes(needle) && /ESTABLISHED/i.test(line));
}

/** ③ 二维码文件距今分钟数。 */
function qrcodeAge(napcatDir: string): number | null {
  const file = join(napcatDir, 'cache', 'qrcode.png');
  if (!existsSync(file)) return null;
  try {
    return Math.round((Date.now() - statSync(file).mtimeMs) / 60_000);
  } catch {
    return null;
  }
}

/** ③ 读取最新日志尾部，命中风控关键词则返回摘要。 */
function scanRisk(napcatDir: string, tailLines: number): string | null {
  const dir = join(napcatDir, 'logs');
  if (!existsSync(dir)) return null;
  let newest: { path: string; mtime: number } | undefined;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.log')) continue;
      const path = join(dir, name);
      const mtime = statSync(path).mtimeMs;
      if (newest === undefined || mtime > newest.mtime) newest = { path, mtime };
    }
  } catch {
    return null;
  }
  if (newest === undefined) return null;

  try {
    const raw = readFileSync(newest.path);
    const utf8 = raw.toString('utf8');
    const text = utf8.includes('\uFFFD') ? raw.toString('latin1') : utf8;
    const lines = text.split(/\r?\n/).filter(line => line.trim() !== '').slice(-tailLines);
    const hits = lines.filter(line => RISK_WORDS.some(word => line.includes(word)));
    if (hits.length === 0) return null;
    return hits.slice(-3).map(line => line.slice(0, 140)).join(' | ');
  } catch {
    return null;
  }
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
export function judgeNapcat(facts: NapcatFacts): { stage: NapcatStage; summary: string } {
  const { napcatProcess, qqProcesses, port, wsConnected, qrcodeAgeMinutes, riskHint } = facts;

  if (wsConnected) {
    return { stage: 'ok', summary: 'NapCat 已连接，QQ 通道正常。' };
  }
  if (riskHint !== null) {
    return {
      stage: 'risk-control',
      summary: 'NapCat 未连接，且 NapCat 日志出现风控/异常关键词 —— 大概率被风控或需要验证，请在手机 QQ 上处理登录验证。',
    };
  }
  if (!napcatProcess && qqProcesses > 0) {
    // 2026-10-26 实测事故：QQ 先被手动启动（12:25），插件随后两次拉起注入器都失败；
    // 旧判定先走 !napcatProcess 分支，只报「根本没启动」，把真原因（QQ 已占用）盖住。
    // NapCat 要求由注入器独占拉起 QQ，已在运行的 QQ 无法被接管。
    return {
      stage: 'qq-conflict',
      summary: 'QQ 已在运行（' + qqProcesses + ' 个进程），而 NapCat 注入器不在：注入器无法接管已启动的 QQ。'
        + '请完全退出 QQ（托盘退出）后，再由 launcher 启动 NapCat。',
    };
  }
  if (!napcatProcess) {
    return {
      stage: 'no-process',
      summary: 'NapCat 注入器没有运行，QQ 也没在运行：NapCat 根本没启动。请运行 launcher（必要时前台跑一次以看到报错）。',
    };
  }
  if (qrcodeAgeMinutes !== null && qrcodeAgeMinutes <= QRCODE_TTL_MINUTES) {
    return {
      stage: 'not-logged-in',
      summary: 'NapCat 注入器在运行，但 QQ 尚未登录（二维码 ' + qrcodeAgeMinutes + ' 分钟前生成）：卡在扫码，'
        + '请用手机 QQ 扫设置页或 NapCat 窗口里的二维码（超过约 ' + QRCODE_TTL_MINUTES + ' 分钟失效）。',
    };
  }
  if (qrcodeAgeMinutes !== null) {
    // 过期二维码不能归到「OneBot 配置问题」：那会把用户引去查 url/token，
    // 实际问题是他手上那张码早就失效了。
    return {
      stage: 'not-logged-in',
      summary: 'NapCat 注入器在运行，但二维码已过期（' + qrcodeAgeMinutes + ' 分钟前生成，有效期约 '
        + QRCODE_TTL_MINUTES + ' 分钟）：卡在登录 —— 需重新触发登录（重启 NapCat，或用 napcatLauncherArgs 配 `-q <QQ号>` 走快速登录）。',
    };
  }
  return {
    stage: 'not-connected',
    summary: 'NapCat 注入器在运行、QQ 也已过登录阶段，但 ' + port + ' 没有连接：卡在 OneBot 连接这一步 —— '
      + '核对 NapCat 的 onebot11 反向 WS 配置（url 是否为 ws://127.0.0.1:' + port + '/ws、token 是否与插件 accessToken 一致）。',
  };
}

/** 一次性产出完整诊断；调用方负责决定如何呈现。 */
export function diagnoseNapcat(options: DiagnoseOptions): NapcatDiagnosis {
  const facts: NapcatFacts = {
    napcatProcess: hasNapcatProcess(),
    qqProcesses: countQqProcesses(),
    port: options.port,
    wsConnected: isConnected(options.port),
    qrcodeAgeMinutes: options.napcatDir ? qrcodeAge(options.napcatDir) : null,
    riskHint: options.napcatDir ? scanRisk(options.napcatDir, options.logTailLines ?? 400) : null,
  };
  return { ...facts, ...judgeNapcat(facts) };
}

/** 把诊断渲染成多行文本（落日志 / 设置页共用）。 */
export function formatDiagnosis(d: NapcatDiagnosis): string {
  const lines = [
    `[NapCat 诊断] ${d.summary}`,
    `  ① 注入器进程 : ${d.napcatProcess ? '在运行' : '未运行'}`,
    `  ② QQ 进程    : ${d.qqProcesses} 个（一个 QQ 通常有多个进程，不代表多开）`,
    `  ③ 登录/二维码: ${d.qrcodeAgeMinutes === null ? '无二维码' : `${d.qrcodeAgeMinutes} 分钟前生成`}`,
    `  ④ ${d.port} 连接 : ${d.wsConnected ? '已连接' : '未连接'}`,
  ];
  if (d.riskHint !== null) lines.push(`  ⚠ 风控迹象  : ${d.riskHint}`);
  lines.push('  （插件不会启动或终止任何进程；如需处理请手动操作）');
  return lines.join('\n');
}
