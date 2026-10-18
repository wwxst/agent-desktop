# Agent Platform V2 最终验收记录

实际复核日期：2026-10-18
实施分支：`codex/agent-platform-v2`
最终决定：`CHANGES_REQUIRED`

## 1. 本轮交付

本轮在 Agent Desktop 中完成并验证了以下生产链路：

- `AgentRuntime` 统一任务起点、执行、取消、等待、恢复和终态；Desktop 复用同一轮次控制信号。
- Agent Loop 拆分上下文、预算、工具路由、有限模型重试、流式增量和恢复起点。
- OpenAI-compatible Provider 支持 Chat Completions、Responses、SSE、工具调用和网络准入；Provider 请求禁止自动跟随重定向。
- Tool Contract、ToolRouter、Capability Catalog 数据结构、并行安全、超时、输出限制和执行边界已接入核心调用链。
- Local、Code、Video、Browser、Windows UIA Computer、Document、Subagent、MCP、Plugin 和 Skill 已接入 Desktop 组合根。
- 审批、工作目录、网络策略、检查点、未知副作用和取消结果沿同一 Session 事实链记录。
- MCP 结果、错误、审批参数、工具调用和模型历史使用统一凭据脱敏投影；插件钩子输入同样使用脱敏参数。
- 视频候选、语义验收、内容摘要、发布产物和多区间剪辑继续复用既有能力。
- 恢复轮次会校验工具集合；恢复时跳过所有 MCP 服务，避免工具集合校验前连接远程或本地服务。
- Browser 页面请求按页面保存网络生命周期；无活动 Desktop 轮次信号时，后台请求不会借用下一轮信号。

## 2. 自动化验证

以下命令在 Node 24 / pnpm 11 工作区通过：

```text
pnpm install --frozen-lockfile
PASS：依赖已按锁文件安装。

pnpm check
PASS：99 个测试文件通过，1119 项测试通过，1 项跳过。
PASS：19 个 workspace 包架构检查通过。
PASS：git diff --check。

pnpm desktop:build
PASS：Electron 主进程、Preload、Renderer 和随包 FFmpeg/Whisper/Vision 资源构建完成。
WARN：CommonJS 打包时 computer-host.ts 和 document-host.ts 的 import.meta 分支产生两条 esbuild 告警；运行分支优先使用 __dirname/__filename。

pnpm --filter @agent-desktop/desktop package:win
PASS：Windows NSIS 安装包构建完成；Chromium 位于安装包 resources/playwright/chromium/chrome-win64/chrome.exe。另以该分发二进制启动 Chromium 并打开本地 data URL，真实进程 smoke test 通过；安装器安装后的 Electron 应用启动尚未验证。
```

最近的聚焦验证也通过：

```text
pnpm typecheck
pnpm typecheck:tests
pnpm vitest run apps/desktop/tests/browser-host.test.ts
PASS：Browser 6/6；上传审批路径断言使用与生产一致的规范路径。

pnpm exec vitest run apps/desktop/tests/safe-storage.test.ts
PASS：12/12；Windows SQLite 耐久性用例的单项时限调整后通过。

pnpm check（2026-10-18，Node 24.20.0 / pnpm 11.22.0）
PASS：完整门禁通过，99 个测试文件中 1119 项通过、1 项跳过；19 个 workspace 包架构检查通过。

打包桌面应用启动实测（Node 24.20.0 / Playwright 1.63.0）
PASS：从 win-unpacked 目录启动真实 Agent Desktop.exe，独立 userData 下窗口标题为 Agent Desktop、主界面 .app-shell 可见且生成 agent-desktop.sqlite；隔离 userData 已清理，进程已退出。随包 Chromium 可执行文件存在。
SKIP：NSIS 安装器安装后的启动未执行；当前用户已有同 appId 的安装注册，覆盖它会改动其它工作树的验收安装。

pnpm vitest run apps/desktop/tests/extension-runtime.test.ts packages/agent-loop/tests/run-turn.test.ts apps/desktop/tests/agent-task-state.test.ts
PASS：60/60。
```

## 3. 三轮 Review

### Review 1：Architecture Review

结果：`CHANGES_REQUIRED`

已确认 Agent Core 没有依赖 Electron、FFmpeg、Playwright、Windows UIA 或具体 Provider；MCP、Plugin、Skill 和 Media 仍由 Desktop 组合。Session 仍是恢复、未知效果和模型上下文的事实来源，工具执行进入 ToolRouter，Provider 只在适配器内处理协议。

未通过项：

- 受限网络模式已在进程创建前拒绝第三方 stdio MCP、插件 Hook、本机 `run_command` 和 Terminal；Windows OS 级隔离尚未实现，完整访问模式中的任意进程仍不受逐请求网络控制。
- Desktop 已消费 Capability Catalog，按最终注册表和视觉路由筛选模型工具集合，并保留 unknown 能力；模型能力契约仍没有覆盖工具、流式、reasoning、并行和 Tool Search 等字段。
- `ToolRouter` 不读取 `approvalRequirement` 强制执行统一审批；现有内置工具已各自接入审批，但新工具可能遗漏。
- `AgentRuntime.subscribe` 已被 Desktop 用于触发任务状态投影，但 Renderer 仍消费现有宿主事件，而不是直接消费 Runtime 事件协议。

### Review 2：Behavior / Safety / Recovery Review

结果：`CHANGES_REQUIRED`

凭据脱敏、重复调用门禁、检查点未知副作用、取消、MCP 重定向和 Browser 页面网络信号问题已修复并由聚焦测试覆盖。未发现当前 Loop 中会把未知效果误判为普通失败并自动重放的路径。

仍需后续修复的行为边界：

- Windows OS 级进程与网络隔离尚未实现；受限模式以拒绝任意进程 fail closed，完整访问模式中的进程不受逐请求网络控制。
- 安装包已分发 Chromium 到运行时路径；无 Playwright 用户缓存的安装后启动 smoke test 仍未执行。
- 市场下载、Whisper/FFmpeg 资源下载和更新器网络属于安装/更新边界，尚未接入聊天轮次策略；需要单独的显式用户操作准入记录。

### Review 3：真实产品完整性 Review

结果：`CHANGES_REQUIRED`

普通问答、文件发现/读取/搜索/编辑、代码工具、审批、取消、恢复、MCP、Plugin、Skill、Subagent、Browser、Computer、Document 和 Video 均有生产注册及自动化证据。真实 DeepSeek、Vision、Whisper、FFmpeg、浏览器目标机、Windows UIA 实机和长视频崩溃恢复没有在本环境全部执行，因此不能据此宣布产品完整通过。

## 4. 真实验收状态

```text
DeepSeek cloud model      SKIP：本轮未使用真实供应商密钥。
OpenAI Vision             SKIP：自动化使用受控边界和本地夹具，未执行真实云端请求。
FFmpeg / ffprobe          SKIP：构建资源已准备，未执行完整真实用户媒体验收。
whisper.cpp               SKIP：未执行真实模型端到端验收。
Browser                   PARTIAL：Playwright 本地 HTTP 夹具与 Windows Chromium 分发路径通过；真实 win-unpacked Electron 应用以隔离 userData 启动并渲染主界面。NSIS 安装后的启动未执行，避免覆盖当前用户已有的同 appId 安装注册。
Windows UIA Computer     PARTIAL：PowerShell helper 与协议测试通过；目标应用实机验收未在本轮执行。
Document                  PARTIAL：解析边界有测试；真实用户 PDF/DOCX/XLSX/CSV 大文件验收未完整执行。
Long Video Recovery       PARTIAL：VideoJob 身份、分段 checkpoint、候选 SHA、视觉批次和语音时间轴缓存已实现；真实进程崩溃与重启验收仍未完成。
CI Windows / Ubuntu       PASS：提交 2d3ac88 的 Actions run 39119918572 中 Windows 与 Ubuntu job 均成功。此前 65a0b92 的 Windows 路径断言与生产规范化路径不一致，已由 94ace18 修正；提交 18e3ce5 的 Windows 全量门禁曾因 safe-storage.test.ts 默认 5 秒时限超时，2d3ac88 将该真实 SQLite/加密边界用例时限改为 30 秒，生产逻辑未变。
```

## 5. 已知剩余风险

```text
P1  Windows OS 级进程及网络隔离尚未实现；受限模式拒绝任意 Shell/Terminal/stdio/Hook 进程，完整访问模式仍允许其不受限网络访问。
P1  Capability Catalog 已接入 Desktop，但模型能力到完整 Tool Contract 的映射仍缺失。
P1  长视频已有 VideoJob、分段状态、候选 SHA、帧文件复用和视觉/语音证据缓存；跨重启真实崩溃验收仍缺失。
P2  win-unpacked Electron 应用及随包 Chromium 启动证据已通过；NSIS 安装器安装后的应用首次启动尚未执行。
P1  安装/更新网络路径尚未统一记录用户操作准入。
P2  AgentRuntime.subscribe 已接入 Desktop 状态投影，Renderer 尚未直接消费 Runtime 事件。
P2  Session 仍以事件索引为稳定顺序，没有统一持久化 sessionId/sequence/timestamp/itemId 字段。
P2  同名工具 schema、实现、插件版本和 Skill 正文变化不能由 toolNames 快照检测。
P2  恢复时跳过 MCP 会安全拒绝依赖插件工具的普通恢复，产品恢复能力仍不完整。
```

## 6. 未完成能力

本轮没有伪造以下尚未具备真实生产消费者的能力：统一 OS 沙箱、stdio 网络代理、完整 Tool capability exposure、跨重启长视频真实崩溃验收、Codex 私有账号云同步、完整应用服务器协议、未来图片/视频生成模型和跨平台 CI 结果。

## 7. Git 状态

本地功能分支的 Browser 路径修复 `94ace18` 和 safe-storage 测试时限修复 `2d3ac88` 已推送；代码修复提交 `2d3ac88` 的 Actions run `39119918572` 与验收记录提交 `6f372ac` 的 run `39120238708` 中，Windows、Ubuntu jobs 均通过。`main` 尚未合并。必须保留任务前已有未跟踪内容：`.workbuddy-ai/`、`html.zip`、`html/` 和 `docs/superpowers/plans/2026-10-11-probe-media-plugin-migration-plan.md`。由于仍存在 P1 风险和未完成真实验收，不执行最终合并或发布结论。

最终结论保持 `CHANGES_REQUIRED`，不能将本轮自动化门禁通过等同于完整架构交付通过。

## 8. 2026-10-18 实施跟进

语义视频验收的内部媒体与 Vision 调用现在只允许访问自身声明的子工具名称，并重新经 `ToolRouter` 校验注册与当前能力集合、应用子工具超时。调用使用注册表中的同一授权包装实例，保留外层 `toolCallId`、进度回调和检查点归属，不增加伪造的 Session 子调用。聚焦验证覆盖未注册或能力排除的子工具、父取消、子工具超时、检查点及结果未知语义。

独立审查发现并修复了钩子包装丢失子工具名单、未执行的能力拒绝被误标为未知效果、无审批观察工具在准备阶段提前读取，以及媒体适配器丢失脱敏投影四类问题。`ToolRoutingError` 只表示进入子工具前的路由拒绝，语义验收将其报告为能力受阻；已执行工具的未知效果分类仍保留。`ToolRouter` 现在隐藏缺少 `prepare` 的策略工具，并统一执行 `PreparedToolAction`；Browser、Computer、Document 和插件钩子均在真实操作前完成准备与审批。相关聚焦测试覆盖 Router、包装器、文档和媒体适配器，真实 `runTurn` 仍只生成外层 Session 调用。

本轮实施跟进的自动化门禁在最终验证后记录实际数量；Windows OS 级隔离、完整真实外部链路、长视频崩溃恢复、Renderer 直接 Runtime 事件消费和模型能力完整映射仍未完成，因此最终决定继续保持 `CHANGES_REQUIRED`。
