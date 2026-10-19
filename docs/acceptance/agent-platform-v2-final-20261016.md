# Agent Platform V2 最终验收记录

实际复核日期：2026-10-19。最终决定：`CHANGES_REQUIRED`。

原实施分支为 `codex/agent-platform-v2`。工作树迁移到 `4bdd` 后，原分支仍由 `fc46` 使用；当前续接分支为 `codex/agent-platform-v2-validation`，基于同一 `dbd2e62`，保留全部任务改动。本文是实施中记录，不代表全部交付或允许合并。

## 1. 要求逐项核对

```text
01 Architecture            总体架构          Core 通用，Desktop 组合具体能力，无通用调度框架。
02 AgentRuntime            运行时控制面      提交、等待、取消、恢复与收尾统一，主/子任务均消费。
03 Session / Turn          会话与轮次        追加事实与配置快照已接入；统一事件封装仍缺失。
04 Context                 模型上下文        完整步骤投影、预算压缩和来源保存，临时增量不持久化。
05 ToolRouter              工具路由          统一目录/执行，策略工具强制准备，嵌套调用受名单约束。
06 Policy                  执行策略          文件、进程和网络准入由宿主强制。
07 Approval                操作审批          固定目标批准后执行，取消未执行证明不冒充工具结果。
08 Execution Boundary      执行边界          受限模式拒绝任意未隔离进程；完整访问明确放行。
09 Model Provider          模型供应商        两协议、流式/完整响应、工具/推理/并行与有限重试。
10 Capability Catalog      能力目录          十项模型能力已消费；完整工具搜索和延迟发现未完成。
11 Code                    代码能力          文件、精确修改、补丁、命令与只读 Git 已接入。
12 Subagent                子智能体          独立运行时只读委派已接入；后续控制权转交未实现。
13 Browser                 浏览器能力        独立页面、快照引用、交互、上传与请求准入已接入。
14 Computer Use            计算机操作        Windows UIA 实机记事本、计算器、对话框和截图通过。
15 Document / Data         文档与数据        PDF/DOCX/XLSX/CSV 真实文件解析与 PDF 渲染有测试。
16 Video Job               视频作业          候选内容摘要关联分段、视觉和语音检查点。
17 Long Video              长视频处理        工具级缓存有测试；Desktop 强杀语义续跑尚缺闭环。
18 Plugin                  插件              市场、原子安装、更新/回滚、钩子及脱敏由宿主承担。
19 Skill                   技能              元数据目录和正文懒加载，引用资源复用目录授权。
20 MCP                     工具服务协议      实际调用进入同一路由；第三方恢复缺目录时安全拒绝。
21 Artifact                产物              真实路径与摘要登记，取消/失败保留此前成功产物。
22 Recovery                任务恢复          普通文件强杀重启及未知命令效果核验有真实桌面证据。
23 Compatibility Cleanup   历史兼容清理      已核对的旧文件迁移和旧活动/产物/附件转换已移除。
24 Documentation           文档同步          架构事实随实现更新，本文保持未完成结论。
25 Tests                   自动化测试        兼容清理后完整门禁通过，1171 项通过、1 项跳过。
26 CI                      持续集成          历史提交双平台通过，当前未提交工作区尚无对应结果。
27 Review 1                架构审查          CHANGES_REQUIRED；事件封装、控制权转交、工具发现缺口。
28 Review 2                安全恢复审查      取消证明与网络准入专项独立复核通过，全局尚待收口。
29 Review 3                产品完整性审查    CHANGES_REQUIRED；完整外部链路与长视频恢复未全部验收。
30 Real Acceptance         真实验收          桌面协议、更新下载、恢复、网络跳转和 UIA 已实测。
31 Known Issues            已知问题          后文逐项列明，不用自动化通过替代缺失功能。
32 Unimplemented           未实现能力        事件封装、转交、完整工具搜索等仍需实施。
33 Architecture Risk       架构风险          第三方工具恢复和语义部分进度恢复边界仍需处理。
34 Decision                最终决定          CHANGES_REQUIRED；不合并 main，不宣称完整交付。
```

## 2. 当前执行事实

`AgentRuntime` 控制会话唯一活动轮次。Desktop 起点事务提交后准备能力并执行循环；Session 是状态、恢复、上下文与产物的事实来源。具体供应商、Electron、浏览器、Windows UIA、媒体和插件协议不进入 Core。子任务复用同一运行时并收紧到只读文件能力。

工具目录与调用共用 `ToolRouter`。策略工具缺少 `prepare` 时不可见也不可执行；批准和执行闭包共享规范化目标。准备失败/拒绝/超时保存未执行结果；准备或审批取消另存宿主 `entire-call/not-applied` 证明，再传播原取消错误，不写 `tool.result`。已开始的不透明父工具不能继承子工具未执行证明。原始保存失败仍致命传播。

模型配置包含文本、图片、工具、流式、推理、并行和两协议十项三态能力。未知工具不暴露工具，未知流式使用完整响应，未知并行不发送 `parallel_tool_calls` 且循环串行，未知协议拒绝执行。修改模型 ID、地址或协议后重新确认能力与推理值。DeepSeek 官方 Chat 的推理工具往返因未保存所需 `reasoning_content` 而明确拒绝。

恢复校验实际工具集合；未知效果核验只使用原集合安全子集。随包 FFmpeg/Whisper/Vision 在本地重建同一工具定义，比较前不连接；第三方 MCP 仍跳过。此修改修复了普通文件恢复也因随包工具消失而被拒绝的真实回归。名称快照不检测同名结构、实现或插件版本变化，这是已知风险，不自创为附件未要求的指纹门禁。

## 3. 网络与执行边界

`NetworkAccessPolicy` 覆盖聊天模型、子任务、远程 MCP、OAuth、视觉端点及显式用户安装/更新操作。媒体使用独立非持久 Electron 分区，在请求及 CDN（内容分发网络）跳转前逐次准入；更新器对 SDK 分区逐请求准入；npm 元数据/包分别授权，npm/Git 的 HTTP 下载禁止自动跳转。默认随包资源初始化离线执行。用户操作准入不另存第二份持久授权记录。

Windows 没有操作系统级进程/网络沙箱。受限模式在创建前拒绝任意命令、终端、第三方 stdio 和命令钩子；用户明确选择完整访问后以当前用户权限执行。Git SSH 也是受信任本机进程传输。附件允许先采用宿主强制边界，不能仅因缺 OS 沙箱机械列为 P1，也不能宣传已有完整沙箱。

## 4. 本轮验证

历史兼容清理后的完整门禁：

```text
pnpm install --frozen-lockfile  PASS  Node 24.20.0 / pnpm 11.22.0。
pnpm check                      PASS  99 个文件、1171 项通过，1 个真实桌面默认跳过。
pnpm check:architecture          PASS  19 个工作区包。
pnpm desktop:build               PASS  主进程、预加载、渲染层及随包媒体资源。
git diff --check                PASS  无补丁格式错误。
```

构建有两条已有 CommonJS `import.meta` 告警，来自 `computer-host.ts` 和 `document-host.ts`；打包运行分支优先使用 `__dirname/__filename`。迁移后的媒体资源从原工作树已校验缓存复制，再由原构建入口重校摘要；主动结束的重复资源下载不算产品下载失败。

真实 Windows UIA 命令：

```text
AGENT_DESKTOP_COMPUTER_ACCEPTANCE=1
pnpm exec vitest run apps/desktop/tests/computer-real-acceptance.test.ts
PASS  1/1：记事本中文输入/保存、过期引用拒绝、文件对话框、计算器、截图。
```

真实 Electron 与浏览器：

- 设置、模型选择、更新、恢复及媒体的联合实测共 19 项：15 项通过、3 项安装版前置条件跳过、1 项因首次准备尚在进行而未在默认 5 秒内出现审批。该 Vision 夹具按真实准备边界改为等待 30 秒，单独重跑通过；16 个可执行场景均已有当前源码的通过证据。
- 两协议真实 IPC 保存、重启及请求验证通过；两处流式能力漏确认的 SSE 夹具已修复，生产配置快照逻辑没有串用协议。
- `general-agent-recovery.pw.ts` 2/2 通过：强杀后两次重启不重放读取并继续；命令退出 7 后未知效果阻止写入，人工核验后继续并再次重启。
- `desktop-update.pw.ts` 真实 SDK 下载、摘要校验、SQLite 保存后的安装握手通过；最后安装器调用被夹具拦截，不代表真实 NSIS 覆盖安装。
- `desktop-probe.pw.ts` 与 `desktop-whisper.pw.ts` 通过真实 FFmpeg/ffprobe、whisper.cpp Small 模型和 Windows 合成中英文语音验证；包括裁剪/解码/语义交付、67.85 秒音频、中文长路径、运行中取消和重启。模型及视觉响应使用本机 HTTP 夹具，不能据此宣布真实云 Vision 通过。
- `pnpm echo-agent` 与 `pnpm deepseek-agent` 改为现有 esbuild 打包后启动；原源码入口因相对 `.js` 文件不存在而失败，已修复。交互式退出与输入提前结束均通过；官方 `https://api.deepseek.com` 的默认 `deepseek-v4-pro` 真实完成 echo 工具调用、结果回传和最终回复，退出码为 0。没有覆盖模型地址或 ID，没有记录密钥。

媒体证据分别在 `logs/ffmpeg-plugin/electron-1792371023763`、`logs/whisper-plugin/electron-1792371057777`、`logs/vision-plugin/electron-1792371312020`。各目录的 `cleanup.json` 确认测试配置及临时媒体已清理；Vision 的可选完整音频组合分支因没有 `DESKTOP_ACCEPTANCE_AUDIO` 按既有条件跳过，其真实语音链由 Whisper 场景单独覆盖。

恢复证据：`logs/general-agent-core-20261012/electron-recovery-1792335907523`、`electron-tools-1792335915385`。修复前失败保留在 `electron-recovery-1792335676201`，证明验收能捕获工具集合漂移。

Electron 44 网络证据：`logs/acceptance/network-admission-20261018-2259/result.json`。拒绝跳转目标未触达、允许跳转下载、含凭据/非网络目标拒绝、原生重定向上限均通过。真实外网大文件、下载中取消与实际 Git SSH 传输未由该反证覆盖。

## 5. 三轮独立审查

### Review 1：架构审查

`CHANGES_REQUIRED`。独立审查确认：Core 无具体能力或界面依赖、生产依赖图无循环、Session 唯一事实、主/子任务复用运行时、MCP 与语义嵌套无 Router 旁路、钩子复用唯一审批与进程准入入口。

旧文件与快照兼容代码已按无当前写入者证据清理。仍缺统一事件身份/时间封装、后续控制权转交、完整工具搜索/延迟发现。Renderer 经宿主事件和投影工作符合附件要求，直接消费 Core 原始协议不是另一个强制条件。

### Review 2：行为、安全与恢复审查

全局保持 `CHANGES_REQUIRED`。本轮取消未执行证明与网络准入分别经另一代理只读复核，两个专项均未发现阻断项；不能代替全部能力的安全验收。

### Review 3：真实产品完整性审查

`CHANGES_REQUIRED`。文件/命令/未知效果恢复、模型协议、独立 MCP、更新下载、UIA、真实本机媒体和官方 DeepSeek 工具闭环已实测。真实云 Vision、长视频强杀语义续跑和 NSIS 安装后首次启动尚未全部验收。

## 6. 尚未完成与实际风险

- 统一事件所需 `sessionId/turnId/itemId/sequence/timestamp/type/payload` 尚未完整交付；稳定数组索引只能保证顺序。
- 子智能体后续控制权转交，以及模型转向/工具搜索协商仍缺失。只读委派和随包懒启动不能称为完整实现。
- 语义工具强杀后会形成未知效果，Desktop 安全恢复集移除该工具；自动核验仅支持文本文件。现有缓存测试直接第二次调用语义工具，不能作为跨进程真实恢复通过证据。候选摘要不变和临时文件存在也不能证明上传未发生或整次调用未应用；需明确表达已核验的部分进度，而非放宽通用安全门禁。
- 第三方 MCP 缺定义时普通恢复安全拒绝；同名工具/插件/技能内容变化仍有配置漂移风险。
- 历史 `2d3ac88`、`6f372ac` 的 Windows/Ubuntu CI 成功不能覆盖当前未提交实现。
- 安装包构建和 `win-unpacked` 启动曾通过；NSIS 安装后启动未执行，避免覆盖当前用户已有同 appId 安装注册。
- Codex 私有云同步和完整应用服务器协议未实现；没有新增无消费者的生成模型框架。

## 7. 清理与分支状态

设置、模型选择、独立 MCP、UIA、普通文件恢复及其失败反证使用隔离目录，已退出进程并清理测试配置/工作目录，必要 JSON、SQLite 副本和 PNG 作为证据保留。三个媒体场景的测试配置与临时媒体均已清理，准确路径保存在各用例 `cleanup.json`。CLI 仅产生已有忽略规则下的构建产物，没有创建本机供应商或持久会话。

自动审批拒绝清理 `logs/acceptance/network-admission-20261018-2259/user-data/`，仅返回 `blocked by policy`、没有具体原因；该目录及同处 `download.cjs` 保留。重复下载的两个 `apps/desktop/bundled-media/**/*.partial` 文件清理也被自动审批拒绝，尚未删除。它们没有作为日常配置使用。原工作树及任务前 `.workbuddy-ai/`、`html.zip`、`html/`、指定 Probe 计划文件均保留。

未合并 `main`。剩余实现、最终机械门禁、当前提交双平台 CI、三轮全局审查及必要真实验收全部通过前，决定保持 `CHANGES_REQUIRED`。
