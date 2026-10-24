# dsh-onebot 插件设置页可视化方案 · 整合定案（T3）

> - **编排者**：lead · attempt `att-onebot-int-01` · 任务板 `onebot-visual.json`
> - **输入**：`settings-page-ux-proposal.md`（UX 架构师，338 行）＋ `settings-page-visual-proposal.md`（UI 设计师，357 行）
> - **性质**：只做一致性核对与冲突消解，不写代码；本文件为 T3 唯一新增产出，未修改任何既有文件

## 1. 契约一致性核对（通过）

| 项 | 结论 |
| --- | --- |
| 键数口径 | 两案一致：以源码为权威 = 4 组 29 键（connection 7 / permissions 7 / behavior 9 / diagnostics 6）；docs 19、DEVLOG 26、注释 28 均为滞后口径，勘误另行任务 |
| 保存契约 | 两案均保留 `updateSettings(patch, expectedRevision)` 乐观锁与 `onebot-settings/conflict` 语义 |
| 密文契约 | 两案均保留脱敏链路（SECRET_KEYS 仅 accessToken、不回显、缺省=不改、`''`=清空） |
| 技术约束 | 两案一致：React-only、externals 仅 react、零新依赖、全部改动收敛 `lib/client.js` 单文件、host 与协议零改动 |
| 降级基线 | 两案共同采纳经验池「UI 热生效 vs fiber 重建」教训：remote 方法缺失按一等公民降级（UX §7 总规则） |

## 2. UI §4.3 五个「待 UX 对齐」项裁定

1. **成功横幅消隐**：采用 UX §5.5 —— 成功 6s 自动消失、错误/冲突常驻；UI 提议的手动关闭钮不做（保持 locale 零新增键第一档），列为可选后续。
2. **冲突/错误焦点策略**：采用 UX §5.5 —— 结果条 `scrollIntoView({ block:'nearest' })` 并移入焦点（`tabIndex=-1`，`role=alert` 保留）。
3. **视口外滚动定位**：由第 2 条同一规则覆盖；结果条上移至工具栏正下方后常态在视口内。
4. **清除密文反馈**：合并两案 —— 徽标三态（UX §6：未配置 / 已配置脱敏 / 保存后清空）＋ 勾选清除时输入框描边转 `--obx-warning` 并显示行内提示「将清除已保存的值」（UI §3.4）；互斥规则按 UX §6（输入自动取消勾选，清除优先）。提示文案入第二档词条（zh/en 同步 + `assertSameKeys`）。
5. **组描述文案与诊断折叠默认态**：文案采用 UX §2.2（连接=NapCat/QQ 桥接参数；权限=谁能触发与使用；行为=回复与限流；诊断=观测与调试开关；UI §2 备选文案存档不采用）；诊断组**默认折叠**（UX §3.1 行为规则：折叠不隐藏变更、sessionStorage 记忆、summary 行「● 含未保存修改」脏标记），实现机制采用 UI §2 的原生 `<details>/<summary>`（键盘可达、零 JS 依赖）。

## 3. 合并实施口径

- 总量级 ≈350–550 行，全部收敛 `lib/client.js`；分三批交付，每批以 artifact rev 热生效验证（重开宿主「插件 → 组合包详情」页即见）：
  1. **批 1 · 视觉基线**：UI 方案 §1–§6 全量（token 表、栅格、卡片、控件、开关、响应式）＋ 结果条上移（= UX P0 位置部分）；locale 零新增键档。
  2. **批 2 · 交互逻辑**：UX P1+P2 —— 脏状态 badge、危险操作确认、恢复默认值补重置密文、密文徽标三态与互斥、初始失败重试按钮、诊断折叠、mode 联动变暗、工作区重试；词条第二档。
  3. **批 3 · 冲突合并保留**：UX P3 —— `mergeOnConflict` 纯函数（逐键一致保留/不一致跟随+行内橙标、密文例外清空），必须单测护航后上线。
- 共同验收基线：UX §7 降级总规则 ＋ UI §5 WCAG AA token（修复现状 4 处对比度不达标）。

## 4. 遗留（本轮范围外，另行任务）

1. `src/settings-remote.ts` L156/L306/L335 与构建产物 d.ts「28 键」注释勘误 → 29。
2. docs 三份 19 键旧口径文档（settings-page-design.md / settings-page-review.md / README 相关节）下次内容性修订时同步。
3. 向宿主提「plugins.bundle.config 未保存更改拦截（leave-guard）扩展点」提案（UX A3 边界）。
4. 验收证据严禁包含明文 accessToken；上线后做真机首挂载探针。

---
*lead 整合 · 2026-10-24 · 两份源方案见同目录*
