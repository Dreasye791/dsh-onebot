# NapCat 免扫码启动与开机自启

给「开箱即用」部署用的一页说明。**先说结论**：插件本身能拉起 NapCat，但 NapCat 有三条硬约束，绕不过去——

1. **QQ 必须在 NapCat 注入器启动前处于关闭状态**；
2. **免扫码必须传 `-q <QQ号>`，且 `-q` 与号码是两个独立参数**；
3. **启动时必须带那组 `NAPCAT_*` 环境变量**（否则 QQ 会报「文件已损坏」）。

## 1. 配置（插件侧，两步搞定）

```yaml
- id: dsh-onebot
  config:
    napcatLauncher: __NAPCAT_SHELL__\launcher-user.bat   # 换成你自己 NapCat 目录里的启动脚本
    napcatLauncherArgs: ['-q', '123456789']              # 换成你的机器人 QQ 号
    autoStartNapcat: true
```

### 选哪个启动脚本

NapCat 发行包自带**四个**（都在 `NapCat.Shell\` 根目录，任选其一即可）：

| 脚本 | 适用 |
|---|---|
| `launcher-user.bat` | 普通用户权限（推荐，不需要管理员） |
| `launcher-win10-user.bat` | Windows 10 上的普通用户版 |
| `launcher.bat` | 需要管理员：会自行提权后重启自己 |
| `launcher-win10.bat` | Windows 10 上的管理员版 |

它们**都**做了三件事，这也是别自建脚本的原因：`chcp 65001`（否则中文控制台乱码）、设 5 个 `NAPCAT_*` 环境变量、从注册表定位 `QQ.exe`。

> **`pause` 说明**：这些脚本末尾都有 `pause`。插件后台拉起时会在隐藏窗口里留下一个等待按键的 `cmd.exe`（`tasklist` 能看到），**属正常**，不影响 NapCat 与 QQ；关闭 NapCat 时它一起退出。

### 两种写法别混

| 位置 | 形态 |
|---|---|
| patch config（`cordis.patch.yml`） | YAML 数组：`napcatLauncherArgs: ['-q', '1354553622']` |
| 设置页面板 | 多行文本框，**每行一个参数**：第一行 `-q`，第二行 `1354553622` |

写成一行 `-q 1354553622` 或 `-q1354553622` 都无效（NapCat 按 argv 全等匹配 `-q`），会退回二维码。

### 其它两条

- `-q` 是传给 **NapCat** 的参数（不是给 QQ 的），用于免扫码快速登录；
- 参数里若含 `& | < > ^ % !` 或双引号会被丢弃并记一条 warn（条目原文不打印），避免 patch config 里的手写参数被 cmd 当命令执行。

改完保存 = 插件热重启（QQ 桥断开约 1 秒）。

## 2. 为什么不能自己写包装 bat（除非照抄环境变量）

`launcher-user.bat` 在调用注入器前设了 5 个变量：

```bat
set "NAPCAT_PATCH_PACKAGE=%cd%\qqnt.json"
set "NAPCAT_LOAD_PATH=%cd%\loadNapCat.js"
set "NAPCAT_INJECT_PATH=%cd%\NapCatWinBootHook.dll"
set "NAPCAT_LAUNCHER_PATH=%cd%\NapCatWinBootMain.exe"
set "NAPCAT_MAIN_PATH=%cd%\napcat.mjs"
```

**漏掉它们**（直接 `NapCatWinBootMain.exe QQ.exe Hook.dll`）时，QQ 会弹「**文件已损坏，请重新安装 QQ**」——这不是 QQ 坏了，而是它按 patch 找不到 NapCat 入口。2026-10-26 实测踩过，误以为要重装 QQ。

如果确实需要自定义包装（例如多账号切换），照下面写，**环境变量一个都不能少**：

```bat
@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
set "NAPCAT_PATCH_PACKAGE=%~dp0qqnt.json"
set "NAPCAT_LOAD_PATH=%~dp0loadNapCat.js"
set "NAPCAT_INJECT_PATH=%~dp0NapCatWinBootHook.dll"
set "NAPCAT_LAUNCHER_PATH=%~dp0NapCatWinBootMain.exe"
set "NAPCAT_MAIN_PATH=%~dp0napcat.mjs"
set "QQ_EXE=__PATH_TO_QQ_EXE__"
set "BOT_UIN=__YOUR_BOT_QQ__"
"%NAPCAT_LAUNCHER_PATH%" "%QQ_EXE%" "%NAPCAT_INJECT_PATH%" -q %BOT_UIN%
```

> `chcp 65001` 不能省：NapCat 输出 UTF-8，中文 Windows 控制台默认 GBK 936，省掉就是满屏乱码。

## 3. 免扫码：`-q` 与位置参数的区别

NapCat 的解析代码只认独立的 `-q` / `--qq` token，取它的**下一个** argv：

```js
// napcat.mjs
const W = process.argv, $ = W.findIndex((X) => X === "-q" || X === "--qq");
$ !== -1 && $ + 1 < W.length && (x = W[$ + 1]);
```

因此：

| 写法 | 结果 |
|---|---|
| `launcher-user.bat -q 123456789` | ✅ 快速登录 |
| `launcher-user.bat 123456789` | ❌ 仍出二维码（`quickLoginExample.bat` 里的示例就是这种，已过时） |

快速登录失败（登录态过期）时 NapCat 会自己回退二维码，扫一次即可。

## 4. 开机自启（真正无感）

1. **关掉 QQ 自启**：QQ 设置 → 取消「开机时自动启动」，或删除注册表
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `QQNT` 项。
   否则开机时 QQ 先起来，注入器无法接管 → 阶段变成 `QQ 已占用`。
2. **让 launcher 随登录启动**：把 `launcher-user.bat` 的快捷方式放进
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`。
   - 快捷方式「目标」只填 bat 路径即可；插件侧的 `napcatLauncherArgs` 只影响**插件拉起**，
     开机这一步不会带参数，所以若开机也要免扫码，快捷方式请指向**你自己那个带 `-q` 的包装 bat**。
3. 保留 `autoStartNapcat: true` 作兜底（NapCat 意外退出时插件会尝试拉起，最多 2 次）。

完成后：开机 → 注入版 QQ 起来并快速登录 → 插件连上。日常直接用这个 QQ，无需任何手动步骤。

## 5. 排障对照

插件日志与设置页「NapCat」卡片的阶段结论：

| 阶段 | 含义 | 下一步 |
|---|---|---|
| `QQ 已占用` | QQ 在跑、注入器不在 | 退出 QQ 后由 launcher 启动 |
| `NapCat 未启动` | 注入器与 QQ 都不在 | 跑 launcher（前台跑能看到报错） |
| `等待扫码登录` | 注入器在跑、二维码新鲜 | 扫码，或改用 `-q` |
| `端口未连接` | 注入器与 QQ 都在，但 8643 没连上 | 核对 `onebot11_<QQ号>.json` 的 url/token |
| `疑似风控` | NapCat 日志命中风控关键词 | 手机 QQ 处理登录验证 |
| `已连接` | 通了 | — |

拉起器的原始输出在 `<mediaDir>/napcat-launcher.log`（每次拉起带时间戳分隔行）。

## 6. 控制台乱码（NapCat 那个黑窗口）

**现象**：插件拉起 NapCat 后，NapCat/QQ 的窗口里中文是乱码。

**已经做过的、以及为什么还不够**：

- 插件拉起命令固定前置 `chcp 65001 >nul`，`launcher-user.bat` 自己也 `chcp 65001`；
- 实测（2026-10-26）这两处**都生效**：`cmd /c "chcp 65001 >nul & chcp"` 返回 `Active code page: 65001`；
- 但那个窗口不是插件的 cmd（插件用 `windowsHide: true`，不创建可见窗口），而是 **NapCat 注入 QQ 之后新建/附着的控制台**，其代码页由**系统 OEM 代码页**（简体中文默认 936）决定，父进程的 `chcp` 管不到；
- NapCat 自身也没有对应开关：`napcat.mjs` 里既无 `AllocConsole` 也无 `SetConsoleOutputCP`。

**两个选择**：

| 方案 | 做法 | 代价 |
|---|---|---|
| A. 根治 | Windows 设置 → 时间和语言 → 语言和区域 → 管理语言设置 → 更改系统区域设置 → 勾选「Beta: 使用 Unicode UTF-8 提供全球语言支持」→ 重启 | 全局生效；极少数老程序可能反而乱码，取消勾选即可回滚 |
| B. 忽略窗口 | 不看那个窗口：`NapCat.Shell\logs\<最新>.log` 与插件 `mediaDir/onebot.log` 都是 UTF-8 | 无 |

配了 `-q` 免扫码之后，那个窗口已没有必须看的信息——它的内容都会写进 `logs/*.log`。
