# 通用智能体核心能力实施验收

2026-10-11，批准方案为 [D4 最小设计](../design/general-agent-core.md)。三轮独立方案审查通过后，用户明确确认开始实施；本记录只把实际执行的验证记为通过。

```text
Implementation          实施              在隔离功能分支逐阶段交付批准的能力。
Independent Review      独立审查          根据实际代码发现问题并核验修正。
PASS                    通过              实际执行并通过的检查或链路。
SKIP                    未执行            缺少环境或尚未实施，不表示通过。
```

## 基线与范围

基线 `main` 为 `49b8da974cc963f7068abb04423bed9628a8f6ae`，隔离工作树使用 `feature/general-agent-core`。主工作区原有 `.workbuddy-ai/`、媒体插件迁移计划、`html.zip` 和 `html/` 未改动。重新核对了 `feature/probe-media-plugin` 的 `6c29b2e` 及 `codex/ffmpeg-plugin` 的 `92901e9` 和其未提交修改；两条分支的插件、媒体与 CLI 业务不纳入本次修改或验收。

本次运行环境为 Windows、Node.js `24.20.0`、pnpm `11.22.0`；CI 固定的 Node.js `24.19.0` 尚未在本工作树执行，不能称为完全同环境验证。

## 阶段 1：架构与执行契约

会话增加只追加的批量保存契约、执行终态、恢复祖先关联、计划/压缩/检查点/宿主及核验事件和纯状态投影。循环使用统一的纯起点，支持执行已提交起点，保留真实取消原因并致命传播保存错误。磁盘解析保留旧历史并校验新索引、来源和恢复顺序。模型/工具增加后续阶段需要的输出额度及失败/检查点字段，尚不代表已接入完整崩溃恢复。

独立审查发现并修正了起点诊断失败无终态、普通取消异常丢失真实原因、保存异常被模型诊断拦截、文本步骤跨版本完成证据丢失、未知效果被计划成功遮蔽，以及非法磁盘恢复关联可形成环的问题。对应路径均要求真实事件测试反证。

`pnpm install --frozen-lockfile` 和 `pnpm check`：PASS，60 个测试文件、722 项测试，19 个正式包架构门禁通过。完整日志在本工作树 `logs/general-agent-core/stage-1-check.log`；未把聚焦运行与全仓运行数量相加。两位独立审查者针对实际 Loop、Session 和磁盘解析复审均为 PASS，无剩余修改要求。真实 SQLite 测试已执行；本阶段没有更改真实模型协议、外部进程或 UI，因此这些新增能力的真实供应商、强杀恢复及视觉验收仍为 SKIP，留待消费者接入。

## 阶段 2：上下文预算与来源压缩

正式模型请求和摘要请求均使用所选模型的明确窗口/输出额度；缺少任一配置时不猜预算。压缩只覆盖完整步骤，保持工具协议完整，用户原文、计划和待核验事实独立保留。摘要校验精确覆盖范围、前摘要链和来源 SHA-256；失败不改原历史。

`pnpm install --frozen-lockfile`、最终 `pnpm check` 和 `pnpm desktop:build`：PASS，63 个测试文件、754 项测试、19 个包架构门禁通过。日志为 `logs/general-agent-core/stage-2-check.log` 与 `stage-2-build.log`。两位独立审查者核对实际 Context、Loop/Main 接线、供应商额度、磁盘解析后均无代码修改要求；SQLite 重启与两个协议的本地 HTTP 完整工具往返均 PASS。

真实 DeepSeek `deepseek-v4-flash`：PASS。每次请求额度覆盖实例默认值；8 额度请求真实截断并保留失败，64 额度请求正常完成。真实 Loop 压缩前估算 11124 超过输入预算 6977，压缩后 6879；摘要与正式请求各一次，输出额度均 2048，最终保留 `ALT-731` 与 `READ_ONLY`，原历史与来源校验通过，额外工具执行为零。证据在 `logs/general-agent-core/deepseek-output-cap.json` 和 `real-context-run.json`。

真实 Responses 供应商：SKIP，缺少 `OPENAI_API_KEY` 及可用的已保存供应商凭据。本地协议测试不冒充真实供应商验收；该外部合并条件仍未满足。当前估算不是服务端精确令牌数，来源完整性也不证明摘要语义准确。计划工具与展示、失败门禁、任务恢复、Windows 强杀和最终集成验收尚未完成。

## 阶段 3：任务计划与事实展示

`UpdatePlanTool` 位于现有 `tools` package，直接依赖 Session 事件并使用 Desktop 注入的唯一事实资格回调。复杂任务可创建或更新最多 32 步计划；步骤 ID、描述和版本保持稳定，工具结果、整调用核验或最终文本事实分别按完成类型确认。计划工具自身、失败结果、未知外部效果、终端输入/启动及未通过视频候选验收不能确认业务完成。当前任务存在计划时，模型会看到带来源索引和资格标签的紧凑证据目录；没有计划的普通对话不增加目录。

共享 Client 展示宿主投影的计划版本、步骤状态和短证据，不提供模型可修改的 UI 操作，也不为简单任务渲染空计划。Session、Loop、Desktop 和 Client 的事实边界测试覆盖计划版本、恢复链、跨轮同名调用 ID、非法证据、候选资格和 UI 投影。

阶段独立审查：Core/Tools、Context/Loop、Desktop/Client 三个范围均 PASS，无剩余修正要求。`pnpm check`：PASS，66 个测试文件、779 项测试、19 个包架构门禁通过；`pnpm install --frozen-lockfile`：PASS；相关聚焦测试 66 项 PASS。计划工具、UI 和资格回调未修改插件运行时或视频工具实现。失败恢复、任务恢复、真实 Windows 计划交互和最终联调尚未完成。

## 阶段 4：失败分类与副作用检查点

Loop 在每个 Tool Call 前保存调用事实，并把工具声明的 `checkpointed` 边界与同步 `tool.effect.prepared` 事件写入同一 Session；文件创建、文件编辑、命令启动和持久终端启动/输入/关闭均在真实副作用前检查点。检查点保存失败会直接阻止副作用。工具错误保留 `permanent`、`denied` 和 `unknown-outcome` 等供应商无关分类，命令非零/超时按结果未知处理，拒绝不重试。模型只对明确的临时服务错误最多追加两次请求，工具调用不会重放。

阶段独立审查：Agent Loop、local-tools、terminal-host 和 model 契约复核 PASS；检查点顺序、取消传播、拒绝分类和非零命令未知结果均有聚焦测试，新增全仓总计 66 个测试文件、780 项测试，`pnpm check` PASS。持久 SQLite 保存健康、失败后的停止策略、恢复入口与崩溃验收留待阶段 5；当前检查点在 InMemory Session 的核心链路已验证，不能提前宣称应用崩溃恢复完成。

## 阶段 5：任务恢复与持久执行事实

Commit `3a926b0` 接入 `DesktopPersistentSession`：Session 事件先以完整快照提交 SQLite，成功后才更新内存；第一次保存失败固定传播，后续取消或诊断不会覆盖原始持久化错误。任务起点先持久化，恢复通过独立 IPC 主动触发，重复恢复和已完成任务被拒绝。`VerifyToolOutcomeTool` 与 `verifyTaskEffect` IPC 为文本文件检查点提供自动和人工核验，未确定的终端、宿主和外部写入保留 `unknownEffects`，不默认成功。终端历史重启后只返回 `disconnected` 快照，不重连、不重放。Renderer 未收到最终 IPC 时，Main 从 Session 终态补回助手结果和产物；子智能体结果使用同一持久化入口。

阶段 5 后续修正 Commit `5c7b42b` 处理三轮独立 Review 的发现：启动时将未结束 Turn 追加 `turn.interrupted(process-exit)`；终端断开事实先于客户端投影写入；过期或缺失的客户端消息按 Session 用户事实重建；扩展关闭和取消时终端关闭纳入宿主操作事实，清理失败不覆盖已提交 Turn；核验 IPC 失败在 Client 显示可见错误。

三轮 Review 结果：第一轮源码事实审查 PASS（所有新增状态均有 Session、Main、Preload、Client 或测试证据）；第二轮架构兼容性审查 PASS（未新增 package，Core 未依赖 UI/Provider/插件，插件和视频工具边界未改）；第三轮失败与工程审查经发现并修正后 PASS（覆盖持久化失败、异常中断、重复恢复、未知副作用、终端断开、清理失败和 UI 核验竞态）。

`pnpm check`：PASS，68 个测试文件、788 项测试，19 个包架构门禁通过。阶段 5 聚焦测试、SQLite 往返和客户端恢复动作均 PASS；纯 Web Playwright UI 测试 7 项 PASS（800x600）。真实 Electron 44 启动与 SQLite 往返：PASS，使用本机已校验的 Electron 二进制和独立用户数据目录完成。强杀恢复验收：PASS，首次模型请求保持挂起后用 `taskkill.exe /PID /T /F` 结束 Electron，重启后请求计数保持 1，界面出现“继续未完成任务”，用户主动继续后第二次请求完成并展示恢复结果。Responses 真实供应商：SKIP，未配置 `OPENAI_API_KEY`；真实 DeepSeek/视频链路：SKIP，本轮未提供外部凭据、媒体和 Whisper 运行条件。

## 阶段 6：联调与回归

`pnpm typecheck`、`pnpm typecheck:tests`、`pnpm test`、`pnpm check:architecture`、`git diff --check`：PASS。`pnpm desktop:build` 和 `pnpm client:web:build`：PASS。Web UI 的聊天滚动、长文本、附件、失败卡片、设置布局和短窗口验收：PASS，7 项；真实 Electron/SQLite 重启和强杀后的 Windows 进程恢复：PASS，新增 `apps/web/tests/browser/general-agent-recovery.pw.ts` 覆盖不重放、主动恢复和恢复结果展示。原有插件、Skill、MCP、视频任务只完成静态边界与全仓自动化回归，未执行需要外部模型、FFmpeg、ffprobe、whisper.cpp 的真实发布链路，标记 SKIP。

最终已交付独立 Commit 顺序：`b35e918` 执行契约与恢复基础事件，`13d8510` Context Manager，`7d5a384` Task Plan，`f81cb93` Failure Recovery，`b206fff` 计划证据修正，`3a926b0` Task Recovery，`5c7b42b` 启动恢复与联调修正。暂缓项仍未建设：操作系统沙箱、后台队列、可写子智能体、多任务并发、分布式/云端恢复和通用 Agent Framework。

已知风险：真实 Responses 协议和带凭据的视频外部工具链未在本环境执行；这些项目保持 SKIP，不能作为已验收能力对外宣称。强杀恢复夹具使用本地 HTTP 模型替身，证明进程、SQLite、Session 和 UI 的恢复边界，不替代真实供应商验收。主工作区未修改，本分支只包含通用 Agent Core 与 Desktop 恢复消费者变更。
