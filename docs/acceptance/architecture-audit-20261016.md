# 通用智能体平台第二版：架构基线审计

实际审计日期为 2026-10-18，文件名沿用本次任务指定名称。唯一代码基线为本地 `main` 提交 `3b7ad275536e5a00e85428330b13074853794b89`；已缓存的 `origin/main` 相同。首次 `git fetch origin` 因 GitHub 443 连接失败未完成，因此尚不能确认远端实时状态。实施分支为 `codex/agent-platform-v2`。

本次需求明确授权全部平台升级阶段、测试、提交和推送功能分支，不包含正式合并授权。原有 `.workbuddy-ai/`、`docs/superpowers/plans/2026-10-11-probe-media-plugin-migration-plan.md`、`html.zip`、`html/` 均为任务前未跟踪内容，必须保留。

## 分类与事实

```text
Confirmed Bug         确认缺陷      可由当前源码及运行证据确认的错误。
Architecture Debt     架构欠账      行为存在但职责或统一边界仍未收口。
Documentation Drift   文档漂移      文档与当前生产源码不一致。
Missing Capability    能力缺失      本轮明确要求而当前没有生产消费者的能力。
Intentional Behavior  有意行为      当前合理约束，不能误报为缺陷。
No Action Required    无需变更      已满足要求，应直接复用。
```

### 已确认缺陷

- Provider 的 Chat 与 Responses 流读取均已在 `[DONE]`、协议异常、取消和结束路径释放读取器；聚焦测试覆盖 56 项。

### 架构欠账

- `apps/desktop/src/main/index.ts` 的任务处理器同时拥有任务提交、控制器、扩展准备、组装、执行和收尾。现有活动任务检查有效，但缺少可由 Desktop 与子智能体共同消费的通用运行时控制面。
- `packages/agent-loop/src/index.ts` 已有 `prepareTurnStart` 与 `runStartedTurn`，可复用宿主先保存起点再执行的契约。普通轮次预算目前可完全省略；需要落实默认步骤数 64、工具调用数 128。
- 工具执行仍直接位于循环，按响应顺序串行运行；注册表只有注册、查询和枚举职责。需要统一路由、工具契约、策略入口及全局输出上限，不能把现有注册表误称为已完成的路由器。
- 会话以事件索引稳定排序，但没有完整的会话标识、序号、时间戳与语义条目标识封装。应保留单份只追加日志，以投影补齐消费所需元数据。
- 模型设置已有供应商目录、引用、两种协议、三态视觉能力及加密密钥；实际运行已统一到 `OpenAICompatibleModel` 和 `model*` 配置字段。模型模态尚未定义到 Tool Contract capability 的可靠映射，因此没有凭静态猜测筛选扩展工具。
- 审批唯一决策入口为 `ToolApprovalGate`。聊天任务的 Model、子智能体、远程 MCP、OAuth 和 Vision 端点已接入 `NetworkAccessPolicy`；市场/媒体下载和更新器仍属于显式安装边界。当前没有操作系统沙箱，不得把真实路径检查或工作目录宣传为沙箱。

### 文档漂移

- 根 `AGENTS.md` 已补充本轮架构升级处于 `codex/agent-platform-v2` 的状态；未合并能力不再描述为 `main` 事实。
- 架构文档已补充统一网络准入、MCP 凭据脱敏、恢复工具集合快照和 VideoJob 检查点；同名工具 schema/实现指纹仍是明确风险。

### 能力缺失

- 代码工具、Playwright Browser、Windows UIA Computer 和 PDF/DOCX/XLSX/CSV Document host 已接入 Desktop composition root，并有聚焦测试。
- 视频已有候选、验收、摘要与交付事实；长视频语义验收已写入 VideoJob 分段、视觉批次和语音时间轴检查点，并在候选摘要相同且中间帧仍存在时恢复。
- 子智能体已有独立会话、只读工具、步骤与寿命限制，并复用 Runtime；其模型请求已接入宿主网络策略。
- 产物已使用 `FileArtifact` 内容摘要、类型、大小和来源元数据；VideoJob 检查点和恢复投影位于 `@agent-desktop/video-agent`，跨进程崩溃仍需真实媒体验收确认。

### 必须复用的既有能力

- `packages/session`：只追加事实、完整步骤恢复、恢复祖先链、未知效果与计划证据投影。
- `packages/agent-loop/src/context.ts`：上下文预算、完整步骤压缩、来源摘要校验及未明效果保留。
- 模型请求有限重试：只重试未形成有效输出的请求，不重放工具；截断响应不能伪装成功。
- `ToolResult.failureKind = 'unknown-outcome'` 与执行前检查点已存在。未知效果不是普通失败，不允许重放。
- `DesktopPersistentSession.commitStart` 原子保存执行起点、消息身份和展示快照，保存失败不得启动外部动作。
- 本地工具已有真实路径授权、读取摘要、精确编辑、审批期间版本复核、命令首尾输出预算与进程树取消。
- 插件已有市场、安装、技能懒加载、MCP、OAuth 与生命周期钩子，不需要第二套插件平台。
- 视频已有生产归属、候选摘要、逐帧语义验收及最终发布拒绝覆盖，不能因通用化削弱。

## 基线验证

本轮初始复跑 `pnpm check`：96 个测试文件、1078 项测试通过，1 项跳过，19 个工作区包架构检查通过；`pnpm desktop:build` 通过。之后接入网络策略与脱敏的聚焦测试通过，包含 MCP、Provider 和恢复覆盖。随后重跑 `apps/desktop/tests/main-entry.test.ts` 整文件有 5 项失败，错误位于任务起点 `parseDesktopState` 校验或其后测试收尾；其中部分用例隔离运行通过，完整原因仍在确认，因此最终整库门禁尚未通过。真实供应商、浏览器、Windows 和媒体验收仍需按专门入口执行。

## 实施顺序

先建立运行时与默认执行预算，再统一事件与工具路由、策略和输出边界；供应商通用化与代码工具可独立并行。此后接入子智能体、浏览器、Windows、文档、分段视频、技能和产物，最后收口恢复、旧兼容代码、文档及三轮审查。环境阻塞逐项记录，其他阶段继续；最终结论仍需完整门禁、双平台持续集成和必要真实验收。
