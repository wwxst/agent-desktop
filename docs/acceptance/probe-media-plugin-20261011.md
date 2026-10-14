# Desktop 媒体探测插件验收

日期：2026-10-11。分支：`feature/probe-media-plugin`。起点：`6f81e77`。

本阶段已完成：Desktop 的独立 `probe_media` 由内置目录中安装的 MCP 插件提供，公开工具与语义验收消费同一宿主适配器。其他 FFmpeg 工具保留原实现，CLI 显式注入本机 Probe；不宣称 FFmpeg 已全面插件化。当前权威边界见 [架构文档](../architecture.md#desktop-媒体探测插件)。

实现位于 `C:/Users/ww/.codex/worktrees/probe-media-plugin/agent-desktop`。原仓库 `D:/Develop/Projects/agent-desktop` 的用户 UI 改动未暂存、覆盖或提交。没有推送、合并到 `main`、打标签或生成正式安装发行版。

```text
PASS      通过          已执行并取得符合要求的可复核输出。
FAIL      失败          实际结果不符合预期，必须修复或解释后重新验证。
BASELINE  原始基线      改造前的测试事实，单独记录，不混入新增回归。
DEFERRED  后续阶段      当前方案明确不实施的正式分发与资产管理能力。
```

## 基线与最终门禁

本机 Node 为 `24.20.0`，pnpm 为 `11.22.0`，Electron 为 `44.0.0`；正式文档中的 Node 基线仍是 `24.19.0`，本次没有声称在该精确版本运行。

- 干净起点 `pnpm install --frozen-lockfile` 和 `pnpm check`：57 个测试文件、624 项测试全部通过，日志 `logs/probe-media-plugin/baseline-check.log`。
- 原审计复审所述两个失败未作为本次改造失败处理。原工作树在受限环境曾实际观测四个进程取消/清理失败，干净、不受限基线没有复现它们；没有修改那些进程树实现或删除失败测试。
- 最终 `pnpm check`：59 个测试文件、639 项测试全部通过；生产类型、测试类型、19 个正式 workspace 包的架构检查和补丁空白检查全部通过，日志 `final-check.log`。
- 最终冻结锁文件安装通过；锁文件只增加当前消费者的导入声明，未变更传递依赖版本。Desktop 构建成功，日志 `final-install.log`、`desktop-build.log`。
- 两个真实 Electron 用例通过，日志 `electron-final-check.log`；补全跨重启审批及取消进程证据后，Probe 用例再次通过，日志 `electron-evidence-check.log`。
- 标准 `pnpm ffmpeg-agent` 命令、真实本地 ffprobe、中文及空格文件名、稳定工具名及六字段结果通过，日志 `cli-check.log`。

其中一次最终检查暴露既有 `app.test.tsx` 的异步等待竞态：只等待 `switchSession` 被调用，尚未等待历史消息进入 DOM。修正为等待 `assistant A` 出现后断言；没有修改渲染层行为。该次失败记录后由最终完整门禁重新验证通过，没有标成原始基线失败。

## 五个可回退提交

### 提交 1：`300cb99`

`feat: bundle read-only media Probe MCP plugin`

修改文件：`apps/desktop/package.json`、`apps/desktop/tsconfig.json`、`pnpm-lock.yaml`；`apps/desktop/resources/plugins/video-editing/.codex-plugin/plugin.json`、`.mcp.json`；`apps/desktop/src/plugins/probe-media.ts`、`apps/desktop/src/main/extensions.ts`；`apps/desktop/tests/extensions.test.ts`、`extension-runtime.test.ts`、`extension-platform.test.ts`、`probe-media-server.test.ts`。

验收：58 个测试文件、626 项测试通过；插件自包含构建、真实媒体六字段和缺少显式 `FFPROBE_PATH` 的失败通过。仅增加资源，不切换正式 Agent，原内置探测保持可用。审查确认复用原参数/解析器和既有 SDK，没有新框架、下载器或二进制资源平台；无未修复问题。日志 `commit-1-check.log`。

回滚：`git revert 300cb99`，恢复资源与构建声明；不删除用户安装、历史或产物。主线未合并。

### 提交 2：`d7d1377`

`feat: enforce host authorization and Probe result contract`

修改文件：`apps/desktop/src/main/extension-runtime.ts`、`index.ts`、`probe-media-tool.ts`；`apps/desktop/tests/probe-media-tool.test.ts`；`packages/video-agent/src/delivery-tools.ts`、`index.ts`。

验收：59 个测试文件、632 项测试通过；真实路径授权、选定附件、未选择邻居、目录链接越界、URL/UNC 拒绝、成功生产候选的来源授权、错误结果和取消通过；真实 MCP + Agent Turn 保存稳定 `probe_media` 名称及六字段。Desktop 中间版本排除尚未切换的同名插件工具，继续使用内置工具。审查确认宿主授权不由模型声明或 MCP 审批替代，生产归属复用交付权威规则。日志 `commit-2-check.log`。

回滚：`git revert d7d1377`，资源仍未接入正式 Agent，不删除用户授权或插件目录。主线未合并。

### 提交 3：`a910f6a`

`refactor: share injected Probe with semantic acceptance`

修改文件：`packages/video-agent/src/index.ts`、`semantic-check.ts`；`packages/video-agent/tests/video-agent.test.ts`、`semantic-check.test.ts`。

验收：59 个测试文件、636 项测试通过；公开注册保留注入对象，语义验收收到相同执行上下文，缺少 Probe 或调用失败在外部视觉请求前阻塞，注入时长决定语音时间轴检查，取消继续抛出。中间提交保留入口尚未切换时的默认 Probe，语义组件自身不再创建第二实例。审查确认没有插件协议进入共享应用层或 Core。日志 `commit-3-check.log`。

回滚：`git revert a910f6a`，恢复原组装与语义内部调用；插件适配器仍未接入 Desktop。主线未合并。

### 提交 4：`79e907d`

`feat: source Desktop Probe exclusively from enabled plugin`

修改文件：`apps/desktop/src/main/index.ts`；`apps/desktop/tests/main-entry.test.ts`；`apps/web/tests/browser/desktop-extensions.pw.ts`。

验收：59 个测试文件、636 项测试通过；先准备插件再组装 Agent，Probe 唯一注入，既有 Session 保留。插件工具内部审批及钩子使用同一适配器，公开工具不重复包装。缺少插件明确传入当时的无 Probe 状态，普通任务继续。审查确认扩展关闭仍在已有 finally，其他视频注册及发布链路保留。日志 `commit-4-check.log`。

回滚：在仅包含前四提交的状态下 `git revert 79e907d` 恢复提交 3 的默认路径；最终版本应按逆序先回滚提交 5，再回滚此提交。主线未合并。

### 提交 5：本文件所在最终提交

`feat: complete Probe migration and Windows acceptance`

修改文件：

- `packages/video-agent/src/index.ts`、`semantic-check.ts`、`delivery-tools.ts`；`packages/video-agent/tests/video-agent.test.ts`、`delivery.test.ts`。
- `examples/ffmpeg-agent/src/index.ts`、`examples/ffmpeg-agent/package.json`、根 `package.json` 和 `pnpm-lock.yaml`。
- `apps/desktop/src/main/index.ts`、`probe-media-tool.ts`、`apps/desktop/src/plugins/probe-media.ts`。
- `apps/desktop/tests/main-entry.test.ts`、`app.test.tsx`、`probe-media-tool.test.ts`、`probe-media-server.test.ts`、`fixtures/probe-process.cs`。
- `apps/web/tests/browser/desktop-probe.pw.ts`。
- `AGENTS.md`、`README.md`、`docs/architecture.md`、`docs/engineering.md` 和本验收记录。
- `.github/workflows/ci.yml`：为真实媒体契约测试安装 ffmpeg，测试中的程序定位兼容 Linux；原生 .NET 子进程夹具仅在 Windows 执行。

验收：最终全部门禁及下述真实链路通过。移除过渡默认值和 `null` 兼容路径；CLI 显式创建 Probe。标准 CLI 命令的原生 TypeScript 启动曾失败于 `.js` 子模块导入，现以同版本 esbuild 构建；外置 ripgrep 保留真实平台程序定位，两者由示例包声明，未引入新库。stdin 断开明确关闭服务并取消在途原生探测进程。删除过的历史附件不阻塞其他授权附件。缺少 Probe 导致的无摘要语义阻塞保留原原因，不误报候选内容变化；只有实际完整证据及匹配摘要才能通过验收。

回滚：先 `git revert HEAD`，再按 4 → 3 → 2 → 1 逆序回滚；不清除 FFmpeg、用户配置、插件安装、会话历史或已完成产物。单独回滚提交 5 后 Desktop 仍使用提交 4 的明确插件注入/无 Probe 路径，CLI 保留当时默认组装行为。主线未合并。

## 真实 Windows 证据

最终原始证据目录：`logs/probe-media-plugin/electron-1791715341465`。其中 `evidence.json` 保存工具目录、公开结果、跨重启审批及取消前后的进程 ID，`requests.json` 保留模型消费的工具输出，`published.png` 是真实成片发布后的窗口截图。独立 profile 中的 `agent-desktop.sqlite` 保存真实 Session 事实和安装记录，未读写开发者实际用户数据。

真实输入由 FFmpeg 创建：中文及空格文件名的 1 秒、160×120、5fps、H.264 红色视频，无音轨。安装后的服务资源在 profile 的扩展目录中；`FFPROBE_PATH` 指向 WinGet 的 FFmpeg 8.1.1 中 `ffprobe.exe`。该安装来源和许可证尚未作为正式分发来源核查。

```text
Installed Tool    安装工具        安装和启用后仅有一个公开 probe_media，成功结果严格六字段。
Path Permission   路径授权        工作目录和精确选定附件允许；邻居、目录联接越界和 URL 在 MCP 调用前拒绝。
Call Approval     调用审批        启动与每次调用单独审批；拒绝保留原错误，语义内部调用仍收到审批。
Cancellation      任务取消        待决工具审批取消后插件进程消失；原生夹具另证在途取消及断开杀死子进程。
Network Indirect  间接网络        真实 ffprobe 拒绝本地 HLS 播放列表，没有访问反例 HTTP 服务器。
Delivery          视频交付        裁剪 0.6 秒、完整解码、公开时长探测、三帧语义证据、候选验收及发布全部完成。
Evidence Use      证据消费        时长要求指向公开 Probe 调用，语义要求指向独立验收，发布只接受全项通过。
Disable Remove    停用卸载        下一轮无独立 Probe，普通任务及剪辑保留，依赖探测的验收阻塞并拒绝发布。
Restart Restore   重启恢复        停用跨重启保留；启用、卸载、重新安装及重启后探测恢复，Session 保留。
CLI Local Probe   命令行探测      标准入口使用显式本机 Probe、真实 ffprobe 和相同六字段结果。
```

成片再次由独立 ffprobe 确认 0.6 秒及 160 像素宽度；由 FFmpeg 解码原始像素确认红色画面。模型和视觉响应使用本地确定性协议夹具；真实 JPEG 和三个时间戳经过视觉 Provider。此证据证明调用、审批、覆盖和证据消费，不代表真实 DeepSeek、OpenAI 视觉或 Whisper 的理解质量。CLI 没有调用语音或视觉服务。

反证：临时把共享组装层改回 `options.probeMedia ?? new ProbeMediaTool()` 并重建后，同一真实 Electron 用例在停用插件后仍发现 `probe_media`，对应断言明确失败，记录于 `counter-proof.log`。随后移除临时修改、重建，完整验收通过。缺陷版本未提交。

复现命令：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm desktop:build
corepack pnpm --filter @agent-desktop/web exec playwright test tests/browser/desktop-probe.pw.ts tests/browser/desktop-extensions.pw.ts --project chromium-desktop --workers=1
```

## 范围审查结论

按工程治理技能完成本次修改及直接消费者的范围审查，`Decision: PASS`，无未修复的阻塞问题；这是实现方的工程审查，不冒充独立人工复审。没有 Core/Loop 的插件协议依赖，没有空壳资产框架，新增公开方法由 Desktop 授权真实消费，结果解析只位于真实 MCP 边界。已有剪辑工具、候选归属、摘要绑定、独占发布和取消行为保留，并有自动化及真实媒体证据。

已修复审查发现：stdin 结束未通知 SDK；缺少 Probe 的语义阻塞被误报摘要变化；删除的历史附件影响其他有效授权附件；标准 CLI 无法启动；既有测试只等待 IPC 调用而未等待界面更新；新真实媒体测试的程序定位和 CI 工具安装未明确区分 Linux 与 Windows；目录链接下的候选引用路径与插件真实路径未共同匹配时长证据。最终本机运行没有未处理的基线失败，远端 Linux CI 尚未运行。正式插件自带程序、SHA-256、签名、版本来源验证、Whisper 模型管理、共享缓存与自动回收全部留待独立阶段；当前没有实施或发布它们。
