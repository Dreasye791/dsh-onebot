# docs 索引

本目录存放 **设计契约、审计报告、验收/发布证据**。新增文档请按下表归档，并在本索引登记一行，避免再出现「文档自称是契约唯一来源、实际已漂移 6 个批次」的情况（见审计 `contracts.md` C-06）。

## 1. 架构

| 文件 | 说明 |
|---|---|
| `dsh-onebot-architecture.png` / `.svg` | 通道架构图（README 主图，矢量版） |
| `dsh-onebot-architecture-en.png` / `.svg` | 架构图英文版 |
| `dsh-onebot-architecture.html` | 可交互架构图（暗/亮主题、引导视图） |

## 2. 设计与契约

| 文件 | 说明 | 状态 |
|---|---|---|
| `settings-page-design.md` | 设置页 T1 定案：descriptor / 快照结构 / 生效语义 | ⚠️ **已漂移**：正文仍写「三组 19 键 / 2 个方法」，实现为四组 38 键 / 4 个方法；键集真相源是 `src/settings-remote.ts` 的 `SETTINGS_GROUPS`（审计 C-06） |
| `settings-page-review.md` | 设置页实现评审记录（含「三方逐字对齐」结论） | 参考 |
| `npm-distribution-design.md` | npm 分发设计（含 `dsh.plugin.json` 不随包分发的结论） | 有效 |
| `semver-matrix.md` | 宿主版本 / peer 依赖兼容矩阵 | 有效（仍需人工核对，见审计 C-04） |
| `m1-mit-compliance.md` | M1 计划 MIT 合规说明 | 历史 |
| `v043-next-acceptance.md` | 0.4.3 下一版验收清单 | 历史 |
| `m1-characterization/` | 重构前的特征化基线（`config-editor.md` / `pipeline-hooks.md` / `reconnect.md`），是「行为不得漂移」的证据 | 基线参考 |

## 3. 审计

| 文件 | 说明 |
|---|---|
| `v4-source-audit.md` | 专题审计：会话 v4 `source.kind` producer 准入收口（0.8.1 基线） |

> 涉及**内部部署路径、账号信息、漏洞利用链**的审计报告**不进入本仓库**（本仓库对外公开发布），保存在仓库外的私有目录，归档规则见第 5 节。

## 4. 验收与发布证据

| 目录 | 内容 |
|---|---|
| `acceptance-evidence/` | 设置页验收：patch 前后快照、`getSettings`/`updateSettings` 网关返回、客户端静态契约（8 个 txt/json） |
| `npm-e2e-evidence/` | npm 端到端安装/加载证据（20 个 txt） |
| `market-migration-evidence/` | 应用市场迁移证据（json/txt/ndjson + `README.md`） |
| `release-050-live-evidence/` | 0.5.0 线上发布证据（commits/registry/market/bridge 快照 + `README.md`） |

## 5. 归档约定

1. **一次审计一个目录**：放**仓库外**的私有目录（`<私有根>/<YYYY-MM-DD>-<scope>/`），总览固定叫 `README.md`，分册按维度命名（security / reliability / contracts / testing），原始机器输出放 `evidence/`。含内部路径、账号、漏洞利用链的报告**不得进入本仓库**（对外公开发布）。
2. 报告里的每条结论必须带**文件:行号**或**命令输出**，区分「已确认 / 需运行验证 / 设计如此」。
3. 修完之后**不要删报告**，在对应条目上补一行「修复提交 + 日期」即可追踪闭环。
4. 索引（本文件）是 `docs/` 的唯一入口；新增子目录必须在此登记。
