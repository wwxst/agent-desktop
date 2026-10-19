# Agent Platform V2 架构边界验收

核对日期：2026-10-18。实施分支：`codex/agent-platform-v2`。

本文记录源码边界、依赖方向和自动检查的覆盖范围。当前架构的权威说明是 [架构文档](../architecture.md)，实施范围见 [第二版设计](../design/agent-platform-v2.md)，完整门禁、独立审查和真实验收结论见 [最终验收记录](agent-platform-v2-final-20261016.md)。本文不单独给出整体通过结论，也不复制最终报告的测试数量和外部验收状态。

```text
Core                    智能体核心        保存通用契约、会话事实和轮次执行算法。
Capability              能力实现          提供文件、代码、媒体、浏览器、计算机和文档操作。
Extension               扩展适配          在宿主中发现技能、连接工具服务并包装插件行为。
Application             应用组装          选择配置、组合运行时与能力，接收用户命令。
Execution Boundary      执行边界          在真实文件、进程、网络和界面操作前实施授权。
Persistence             持久化            保存原始事实及宿主配置，供投影和恢复读取。
```

## 核心与实际依赖

Core 的六个包是 `model`、`session`、`system-prompt`、`tools`、`agent` 和 `agent-loop`。它们通过通用接口协作，不导入 Electron、SQLite 实现、FFmpeg、Playwright、Windows UIA、具体模型供应商或插件协议。包清单的当前内部依赖如下；箭头表示左侧依赖右侧。

```text
model
system-prompt
session       -> model
tools         -> model, session
agent         -> model, session, system-prompt, tools
agent-loop    -> agent, model, session, tools
```

[`AgentRuntime`](../../packages/agent-loop/src/runtime.ts) 位于现有 `agent-loop` 包，负责每个会话唯一活动轮次、起点提交、取消、等待及恢复入口。执行算法仍在 [`loop.ts`](../../packages/agent-loop/src/loop.ts)，上下文构造在 [`context.ts`](../../packages/agent-loop/src/context.ts)，终态从 Session 事实投影；运行时没有自己的第二份终态存储。

[`ToolRouter`](../../packages/tools/src/router.ts) 负责工具解析、能力筛选、执行时限与受限子调用。策略工具没有 `prepare` 时不会暴露或执行；[`PreparedToolAction`](../../packages/tools/src/contract.ts) 将规范化目标固定为同一份审批与执行闭包。工具注册表只保存工具，不承担循环算法。模型能力设置到供应商请求、工具暴露和并行执行的映射需要沿真实消费者验收，不能仅凭配置字段或目录结构存在判为完成。

## 能力、扩展与应用组装

具体实现位于 `local-tools`、`video-ffmpeg`、`speech-whisper-cpp`、`vision-openai` 及 Desktop 的 [`browser-host.ts`](../../apps/desktop/src/main/browser-host.ts)、[`computer-host.ts`](../../apps/desktop/src/main/computer-host.ts)、[`document-host.ts`](../../apps/desktop/src/main/document-host.ts)。这些实现向 Core 提供通用工具，Core 不反向创建具体能力。

[`video-agent`](../../packages/video-agent/package.json) 是由 CLI 与 Desktop 共同消费的应用层；它依赖通用包和 `local-tools`，接收注入的媒体实现。`video-ffmpeg` 只列为该包的测试开发依赖，不是生产组装依赖。历史包名 [`model-deepseek`](../../packages/model-deepseek/src/index.ts) 中的 `OpenAICompatibleModel` 处理供应商协议映射，不把 Chat Completions、Responses 或流式传输协议放入 Core。

Desktop 的 [`index.ts`](../../apps/desktop/src/main/index.ts) 是组合根，连接运行时、设置、授权、能力、扩展与持久化。[`extension-runtime.ts`](../../apps/desktop/src/main/extension-runtime.ts) 在宿主内准备技能、MCP 工具和插件钩子；包装保留工具契约、准备入口、脱敏投影与子工具名单，带命令钩子的通用工具仍按不透明执行边界处理。Core 只接收注册后的工具和系统指令。

语义验收的媒体与视觉调用通过同一个 Router 解析当前已授权的注册实例，受外层声明的子工具名单及子工具时限约束。子调用保留外层身份和检查点，不制造独立 Session 子调用。Renderer 经 Preload 消费客户端命令、事件和投影；共享客户端不获得本机文件、进程或数据库访问权限。`AgentRuntime.subscribe` 已由宿主用于触发状态投影，原始 Core 事件保留在宿主，不为界面展示复制一套执行事实。

## 执行边界与持久化

[`execution-policy.ts`](../../apps/desktop/src/main/execution-policy.ts) 同时拥有 `NetworkAccessPolicy` 和 `WindowsExecutionBoundary`。聊天模型、子任务、远程 MCP、OAuth 与固定视觉供应商请求在宿主网络边界准入；受限模式在启动前拒绝无法逐请求约束网络的任意 Shell、Terminal、第三方 stdio MCP 和命令钩子。完整访问模式允许不受限进程。这是宿主准入与拒绝策略，尚不是操作系统级沙箱。市场、远程媒体资源和更新器已接入显式用户操作准入，媒体与更新器的重定向逐请求授权；默认随包安装保持离线。该入口不维护第二份持久授权记录。

[`desktop-database.ts`](../../apps/desktop/src/main/desktop-database.ts) 和 [`session-persistence.ts`](../../apps/desktop/src/main/session-persistence.ts) 在宿主中保存 SQLite 数据、执行事实及消息绑定；Core 的 Session 保留追加式事实接口。模型上下文、任务状态、界面活动和 JSONL 执行诊断都是消费者，不能成为另一套执行真相。原始保存错误必须中止执行，不能转换为普通工具失败后继续。

每轮快照保存公开模型设置、工作目录、权限与实际工具名称集合。普通恢复要求工具集合一致，未知效果核验恢复只允许原集合的安全子集；恢复准备仅在本地重建随包服务定义，第三方 MCP 不建立连接或列举，因此依赖第三方 MCP 的普通恢复会明确拒绝。工具名称快照不能检测同名工具结构、实现、插件版本或技能正文变化。Session 已统一持久化 `sessionId/turnId/itemId/sequence/timestamp/type/payload`，来源引用仍使用稳定数组索引。身份只由 Session 追加入口分配，Desktop 写盘后提交同一批内存事实；恢复验证封装并保留原身份、序号和时间。准备或审批取消的未执行证明复用宿主 `effect.outcome.verified`，不保存普通工具结果，也不制造未知副作用。

[`video-job.ts`](../../packages/video-agent/src/video-job.ts) 和 [`semantic-check.ts`](../../packages/video-agent/src/semantic-check.ts) 复用匹配候选内容摘要的连续帧、视觉观察和语音时间轴检查点；最终语义判断每次重新执行。该源码路径与检查点自动化证据不等于真实跨进程崩溃、重启及长视频验收已经通过。

## 自动架构检查覆盖范围

[`scripts/check-architecture.mjs`](../../scripts/check-architecture.mjs) 扫描 `packages`、`examples`、`apps` 下有 `package.json` 的一级子目录，并读取其 `src`、`tests` 中的 TypeScript 文件。词法扫描器识别静态导入、导出和字符串字面量动态导入。当前可机械检查：

- 六个 Core 包不得导入或声明依赖 React、React DOM、Electron、`model-deepseek`、`video-ffmpeg`、`vision-openai`、`speech-whisper-cpp`。
- 共享客户端不得导入或声明依赖列明的 Electron、文件、子进程和进程模块。
- 非示例包不得依赖示例包；已导入的工作区包必须在清单中声明。

扫描器不是完整依赖图证明：它不检查全图循环，也没有枚举所有本机 API 和具体能力包；例如 `local-tools` 不在 Core 禁止依赖列表中。计算式动态加载、注册顺序、审批顺序、执行隔离、持久化事务和恢复安全仍需沿源码、现有行为测试与真实入口审查。自动检查通过不能替代这些验收。

本次文档核对时运行 `pnpm check:architecture`，结果为 19 个工作区包通过。其余门禁与最终决定以 [最终验收记录](agent-platform-v2-final-20261016.md) 为准。
