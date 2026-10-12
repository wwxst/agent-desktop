# Project（项目）

这是一个从零开发的通用智能体客户端：能回答问题、使用工具完成任务并持续推进工作，以视频自动剪辑为重点应用场景。

## 插件和技能

左侧入口提供按 Codex 参考图实现的插件与技能管理页：分类双列、搜索、详情、技能来源及已安装导航。默认进入个人插件，展示内置资源与实际安装；已撤下未接通服务的官方推荐目录。支持主动添加市场、本地导入、安装、启停、更新、回滚和卸载。已启用技能按任务描述匹配，也可输入 `$local-file-review` 指定。内置“语义视频剪辑”插件包含 `semantic-editing` 与 `short-drama-editing`。

Desktop 的十四项 FFmpeg 专业工具由独立“FFmpeg”插件提供；Windows x64 用户在插件页安装后即可使用，无需另装 Node、FFmpeg 或填写程序路径。安装从可信固定来源下载并校验 FFmpeg 8.1.2，支持禁用、更新、回滚和卸载。“语义视频剪辑”仅提供工作方法并声明工具依赖。缺少 FFmpeg 插件时普通任务继续，依赖媒体工具的验收明确受阻；CLI 仍显式使用本机实现。权限、结果契约及分发边界见 [FFmpeg 插件边界](docs/architecture.md#desktop-ffmpeg-插件) 和 [验收记录](docs/acceptance/ffmpeg-plugin-20261011.md)。

Whisper 独立提供 `transcribe_audio`：插件详情安装官方 CPU 运行资源及 Small 多语言模型，支持本地导入、完整性检查和模型删除；卸载插件保留模型。可独立识别 WAV，也可与 FFmpeg 和视频剪辑技能组合。禁用或卸载后没有 Desktop 内置语音回退，带音轨的语义验收明确受阻。边界及真实安装版证据见 [Whisper 插件](docs/architecture.md#desktop-whisper-插件) 和 [第三阶段验收](docs/acceptance/whisper-plugin-baseline-20261012.md)。

Vision（视觉理解）独立提供 `analyze_images`：安装后使用设置页当前选择的视觉供应商、模型、协议和加密密钥，观察已授权的 JPG/PNG 图片及视频抽帧。插件没有模型或程序下载；视觉请求会发送图片内容到所选服务，调用前审批展示该服务地址。禁用、卸载或缺少视觉配置时没有 Desktop 内置回退，普通任务继续，视觉语义验收明确受阻。边界与本阶段验证范围见 [Vision 插件](docs/architecture.md#desktop-vision-插件) 和 [验收记录](docs/acceptance/vision-plugin-20261012.md)。

技能支持 `agents/openai.yaml` 的图标、展示信息、工具依赖与显式调用策略，元数据缓存、正文按需加载。外部改文件后管理页自动刷新；“刷新”同步内置资源与市场目录，详情可检查更新并回滚。远程工具支持 HTTP/SSE 传输、加密配置和浏览器账户授权；命令钩子执行前审批。实现与外部服务边界见 [三轮核对记录](docs/acceptance/codex-extensions-three-reviews-20261004.md)。

```text
Plugin                    插件包          包含技能、工具服务、应用连接或钩子的目录。
Skill                     任务技能        SKILL.md 中的描述与操作指令。
MCP                       工具协议        为智能体提供可审批调用的本地或远程工具。
```

单独技能目录提供 `SKILL.md`：

```markdown
---
name: config-review
description: 检查项目配置文件时使用。
---

先确认工作目录，再阅读配置并报告实际发现。
```

已确认目录中的 `.agents/skills/**/SKILL.md` 自动发现；扫描只保留 frontmatter 元数据，正文在模型调用 `load_skill` 或打开详情时读取。安装先进入暂存目录校验，再原子移动到应用数据目录，版本和启停状态存 SQLite；迁移电脑需复制数据库与 `extensions` 目录，无需保留原导入目录。

插件目录支持 `.codex-plugin/plugin.json` 或 Agent Plugins v1（标准插件格式）的根 `plugin.json`。前者示例：

```json
{"name":"local-tools","description":"本地工具与技能","skills":"./skills","mcpServers":"./.mcp.json"}
```

可以只提供技能或只提供服务；显式声明的路径必须存在。`.mcp.json` 示例：

```json
{"mcpServers":{"local":{"command":"node","args":["${PLUGIN_ROOT}/server.mjs"],"type":"stdio"}}}
```

脚本需随包提供服务依赖，`node` 使用 Electron 自带运行时。远程服务可声明 `{"type":"http","url":"https://example.com/mcp"}`，也支持 `sse`。请求头或环境变量中的 `${TOKEN}` 在详情“配置”中填写并加密保存；任务中的启动和每次工具调用继续独立审批，结束或取消关闭连接。应用清单的 ID 可配置实际账户网关，命令钩子按任务生命周期执行。

默认不提供第三方推荐目录；用户主动添加 Git 市场需要网络和本机 Git，npm 包解包需要本机 tar。账号、云端安装同步与分享发布服务按产品要求对接自有后端，当前尚未接入；现有接口使用 Electron 进程通信，不宣称完整兼容 Codex 应用服务器协议。浏览器只有界面夹具，真实安装、授权和调用由桌面应用提供。

服务端接入按用户要求留待后续实施，接口建议、认证、安装同步、分享权限及联调验收见 [插件与技能自有后端对接文档](docs/plugin-backend-integration.md)。

# Current Status（当前状态）

项目处于非常早期的 `0.x` 开发阶段。

Windows 安装版已接入应用更新：自动检查并下载正式发布版本，下载完成后在左下设置上方显示蓝色入口，点击直接保存会话并安装。源码开发模式不显示更新入口。安装包使用 `corepack pnpm desktop:package:win` 生成；发布附件要求与当前线上验收限制见 `docs/engineering.md` 的 Windows 安装包与更新章节。

新会话在首次发送前只保存为草稿，不增加历史条目；重复点击复用输入，历史可全部删除。桌面首轮成功后由模型概括任务标题，手动名称保留。交互细节见 `docs/desktop-ui.md`。

当前优先级是让桌面入口跑通通用任务闭环，视频剪辑作为配置最完整的能力继续可用。

普通问答和文字任务不以视频附件为前提。模型可以用 `set_working_directory` 请求会话工作目录，经用户确认后，用 `list_directory` 发现文件、用 `read_file` 按行读取文本、用 `search_text` 按字面文本搜索内容，并用 `write_text_file` 经用户逐次确认后创建新的文本文件。对已经读取的 UTF-8 文本，`edit_text_file` 会展示确切文件、原内容和新内容，只在用户批准且文件版本未变化时完成一次唯一匹配的精确替换。新建文件会显示为本轮产物，修改已有文件只记录为活动，不冒充新产物。所有本地文件操作只限已确认的目录，越界会明确要求重新指定工作目录。

文本搜索由随包提供的 ripgrep 执行（`@vscode/ripgrep`），不依赖运行环境 PATH 上是否安装 `rg`。安装包内的资源落地由打包阶段验收。

Desktop 现已支持执行中提问后继续同一轮、真实公开过程说明、有限模型请求重试、最多两个并行只读子任务，以及逐次审批的会话终端。视频语义验收对候选全部帧与完整语音证据独立判定，并与发布前文件摘要绑定；首期最多 600 帧，缺少服务、超过预算或无法确认的内容要求仍阻止发布。终端只在当前应用运行期间持久，重启只显示已断开的输出历史。具体边界见 `docs/architecture.md`，本次证据见 `docs/acceptance/six-capabilities-20261001.md`。

当前已经完成：

```text
English term                    中文术语                 介绍
Core Interfaces                 核心接口                 定义 Model、Session、Tool、System Prompt 和 Agent 边界。
Minimal Agent Loop              最小 Agent 循环          跑通 Model、Tool、Result、Model 的执行闭环。
Runnable Echo Agent             可运行 Echo Agent        从终端组装并运行第一个完整 Agent 示例。
DeterministicEchoModel          确定性 Echo 模拟模型     只验证 Runtime，不调用真实 LLM API，也不进行大模型推理。
DeepSeek Real Model Provider    DeepSeek 真实模型适配器  通过原生 fetch 接入真实 DeepSeek Chat Completions API。
FFmpeg Basic Video Editing      FFmpeg 基础视频编辑      通过本机 FFmpeg 提供八项基础视频编辑能力。
Multi-step Video Editing        多步骤视频剪辑          Agent 可以在一个 Turn 中连续组合多个 FFmpeg Tool 完成视频处理任务。
Visual Media Inspection         视频视觉理解            FFmpeg 抽取代表性视频帧，OpenAI Vision 分析画面，DeepSeek 继续推理。
Content-aware Editing           基于内容的剪辑          Agent 可进一步检查局部范围，自主选择保留片段并使用 FFmpeg 重新拼接。
Local Speech Understanding      本地语音理解             FFmpeg 提取标准 WAV，whisper.cpp 本地转录，DeepSeek 根据 transcript 继续理解；Tool 接入、自动化验证和真实端到端验证均已完成。
Timeline-aware Understanding    带时间轴的视频内容理解   Local Speech 提供按秒的 segment-level semantic timeline，DeepSeek 已能基于时间范围理解视频语音内容。
Agent Execution Trace           智能体全链路执行日志     独立 package 将 CLI 与 Desktop 的 Model、Tool 和 Turn 诊断事件写入本地 JSONL。
Semantic Video Editing          语义视频剪辑             Agent 根据语音时间轴和必要的视觉确认，自主裁剪并拼接语义片段；已完成真实单区间和多区间验证。
Video Agent Application Layer   视频智能体应用层         `@agent-desktop/video-agent` 统一组装正式视频 Agent，由 CLI 与 Desktop 共同复用。
Agent Desktop Shell             智能体桌面应用外壳       单页 Electron 客户端提供选择一个或多个视频、输入任务、查看 Tool 活动、读取回复和打开输出文件的闭环。
Multi-turn Agent Session        多轮智能体会话          Desktop 复用并持久化每个会话的 SessionEvent，重启后继续模型上下文。
Runtime Session List            运行期会话列表          Desktop 保存多个独立会话，可新建、切换并在重启后恢复各自上下文。
```

# Current Engineering Foundation（当前工程基础）

项目采用 Node.js 24 LTS、pnpm workspace、TypeScript ESM 和 Vitest。当前 Agent Runtime 已具备核心接口、最小 Agent Loop、可运行 Echo Agent、DeepSeek 真实模型适配器、FFmpeg 视频处理、视觉理解、本地语音时间轴和基于内容的剪辑能力；`packages/client` 提供 Web 与 Electron Desktop 共用的 Agent Client UI，`apps/web` 是 UI 开发与自动化测试宿主，`apps/desktop` 继续承载真实本地 Agent。Desktop 会话、设置和加密密钥统一保存在本机 Electron `userData/agent-desktop.sqlite`，使用 SQLite（本地嵌入式数据库）且不上传；API Key 只以系统安全存储加密后的密文保存。旧 JSON 文件首次启动时自动导入并保留原文件；Web Dev Host 不做持久化。

# Run Agents（运行 Agent）

```text
Command               中文入口           说明
pnpm echo-agent       确定性示例入口     无需 API Key，不调用真实 LLM API
pnpm deepseek-agent   DeepSeek 命令行    需要 DEEPSEEK_API_KEY，调用真实 DeepSeek API
pnpm ffmpeg-agent     视频命令行入口     需要 DEEPSEEK_API_KEY、WHISPER_MODEL_PATH；按任务使用本机媒体工具
pnpm desktop          桌面应用入口       构建并启动 Electron；模型在设置页配置，专业工具按插件安装
pnpm client:web       Web 开发入口        启动共享 Agent Client 的浏览器开发宿主
pnpm client:web:build Web 构建            构建 Web 开发宿主
```

运行 Echo Agent：

```bash
pnpm install
pnpm echo-agent
```

运行 DeepSeek Agent 前，必须由运行环境提供 `DEEPSEEK_API_KEY`：

```bash
pnpm deepseek-agent
```

运行 FFmpeg Agent 前，需要本机安装 `ffmpeg` 和 `ffprobe` 并加入 `PATH`：

当前支持媒体探测、裁剪时间、视频拼接、替换音频、烧录 SRT 字幕、调整分辨率、裁剪画面和视频变速。

视觉分析会先抽取六张代表性 JPG，再通过 OpenAI Vision 返回结构化画面描述；本地语音理解会先由 FFmpeg 提取单声道 16 kHz 16-bit PCM WAV，再由 whisper.cpp 在本机返回完整文字和按秒的段落时间轴；DeepSeek 负责调用 Tool 和回答问题。运行视觉分析需要 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ffmpeg` 和 `ffprobe`；运行本地语音理解需要 `DEEPSEEK_API_KEY`、`WHISPER_MODEL_PATH`、`ffmpeg`、`ffprobe` 和本机 `whisper-cli`，也可以通过 `WHISPER_CLI_PATH` 指定可执行文件路径。

本地语音 Tool 接入、自动化测试、真实 FFmpeg WAV 提取、真实 whisper.cpp JSON 时间轴和 Desktop 插件端到端链路均已验证。`transcribe_audio` 返回完整 `text`，并通过 `segments.start`、`segments.end` 和 `segments.text` 表示每段语音在视频第几秒说了什么。Desktop 的 Whisper 插件在 Windows x64 上从锁定的官方来源安装 CPU 运行资源，模型在插件详情中单独下载或导入并校验；不要求用户安装 Node、配置 `WHISPER_CLI_PATH` 或填写模型路径。CLI 仍是显式本机实现消费者。

基于内容剪辑时，Agent 会先分析整段画面，在需要时进一步检查局部时间范围，然后自主选择保留片段并使用现有裁剪和拼接 Tool 生成新视频。

多步骤视频剪辑时，Agent 会在一个 Turn 中按模型选择的顺序连续调用多个 FFmpeg Tool，并把上一步的输出文件传给下一步；中间文件保留在最终输出文件所在目录。

```bash
pnpm ffmpeg-agent
```

所有 CLI 都输入 `/exit` 退出。仓库不会读取 `.env` 文件，也不会保存或输出 API Key。

运行 Desktop（桌面应用）时，文字任务只需要当前对话模型的 API 密钥；需要语音理解时，在“插件和技能”中安装 Whisper 插件及其模型：

```bash
pnpm desktop
```

Desktop 根据任务按需调用已安装 FFmpeg、Whisper 和 Vision 插件；Vision 只使用当前视觉模型配置，缺少密钥或选择“不使用视觉模型”时不注册 `analyze_images`。`DEEPSEEK_BASE_URL` 和 `OPENAI_BASE_URL` 仍可用于 CLI 或模型供应商配置。设置页可新增、编辑与删除自定义模型供应商，支持 Chat Completions（对话补全）与 Responses（响应）协议、真实模型目录查询和对话/视觉模型选择；模型输出上限进入请求，密钥由系统安全存储加密，保存后下一次任务生效。每个窗口持有多个独立的 InMemorySession（内存会话），每个 Turn（任务轮次）使用该会话创建对应的 Video Agent（视频智能体）；侧栏可添加本地项目、在项目中新建会话，并支持项目与最近分区、折叠、置顶、重命名、归档恢复和删除；项目管理状态随会话自动保存。已有会话移到项目只改变归属，保留其原工作目录。会话事件、消息、草稿、附件、Tool Activity（工具活动）、Artifact（产物）和 Trace（执行追踪）展示保存在本机并可在重启后恢复；Renderer History（渲染层历史）只负责界面显示，模型上下文仍只来自对应 InMemorySession。当前不提供会话搜索。

```text
Layer                 中文名称         职责
Renderer              渲染进程         维护会话列表的界面副本，收集任务并展示消息、Tool 活动与产物
Preload contextBridge 预加载安全桥     暴露受限的桌面 API
Electron Main         Electron 主进程  按会话持有 Session 和文件状态，持久化会话并调用应用层
createVideoAgent      组装视频智能体   为当前 Turn 创建正式视频 Agent
runTurn               执行任务轮次     驱动 Model 与 Tool 执行
```

# Mechanical Gate（机械门禁）

提交代码前执行统一本地门禁：

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 包含源码和测试类型检查、全部测试、稳定架构边界检查和 `git diff --check`。门禁定义与 CI 入口以 [`docs/engineering.md`](docs/engineering.md#step-3-automated-validation自动化验证) 为准；当前架构职责和不变量以 [`docs/architecture.md`](docs/architecture.md) 为准。

`@agent-desktop/execution-trace` 只负责把本地执行诊断追加到 `logs/agent-trace.jsonl`，当前由 `ffmpeg-agent` 与 Desktop 两个真实入口消费。Trace 只记录关联 ID、事件类型、计数、状态、耗时和受控错误定位信息，不记录完整用户 Prompt、Model 请求或响应、Tool 输入或输出、Transcript、Vision 分析、API Key 或环境变量值。Session（会话）仍保存模型可见业务事实，Trace（执行追踪）只用于运行诊断；详细边界与事件定义见 [`docs/architecture.md`](docs/architecture.md#agent-execution-trace智能体执行追踪)。

# Development Workflow（开发流程）

从 Commit 14 开始，所有新增能力必须从 `main` 创建 `feature/<short-name>` 分支，在完成自动化验证、Review（审查）和必要的真实验证后合并回 `main`；禁止直接在 `main` 开发新功能。完整规则以 [`docs/engineering.md`](docs/engineering.md#feature-branch-workflow功能分支工作流) 为准。

# Development Philosophy（开发原则）

1. 从最小可运行 Agent 开始。
2. 每个阶段只解决一个清晰问题。
3. 核心不依赖用户界面（UI）。
4. 智能体不绑定具体模型厂商。
5. 工具不绑定具体智能体。
6. 会话将成为智能体执行历史的事实来源。
7. 优先建立明确模块边界，再增加功能。
8. `0.x` 阶段允许破坏性重构，不为未发布 API 保留无意义兼容层。
9. 不因为“以后可能需要”而提前实现复杂系统。
10. 所有重要架构决策必须进入仓库文档，而不能只存在于聊天上下文。
