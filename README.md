# Project（项目）

这是一个从零开发、以视频自动剪辑为核心目标的 Agent Client。

# Current Status（当前状态）

项目处于非常早期的 `0.x` 开发阶段。

当前优先级是通过最小桌面入口交付可用的视频 Agent 闭环，而不是扩展无关功能。

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
Agent Desktop Shell             智能体桌面应用外壳       单页 Electron 客户端提供选视频、输入任务、查看 Tool 活动、读取回复和打开输出文件的闭环。
```

# Current Engineering Foundation（当前工程基础）

项目采用 Node.js 24 LTS、pnpm workspace、TypeScript ESM 和 Vitest。当前 Agent Runtime 已具备核心接口、最小 Agent Loop、可运行 Echo Agent、DeepSeek 真实模型适配器、FFmpeg 视频处理、视觉理解、本地语音时间轴和基于内容的剪辑能力；`apps/desktop` 使用 Electron 44.0.0、React 19.2.8、Vite 8.2.2 和 esbuild 0.27.4 组装单页桌面客户端。

# Run Agents（运行 Agent）

```text
Command               中文入口           说明
pnpm echo-agent       确定性示例入口     无需 API Key，不调用真实 LLM API
pnpm deepseek-agent   DeepSeek 命令行    需要 DEEPSEEK_API_KEY，调用真实 DeepSeek API
pnpm ffmpeg-agent     视频命令行入口     需要 DEEPSEEK_API_KEY、WHISPER_MODEL_PATH；按任务使用本机媒体工具
pnpm desktop          桌面应用入口       构建并启动 Electron 单页客户端，环境与媒体工具要求同视频命令行入口
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

本地语音 Tool 接入、自动化测试、真实 FFmpeg WAV 提取、真实 whisper.cpp JSON 时间轴和 DeepSeek + Local Speech 端到端链路均已验证。`transcribe_audio` 返回完整 `text`，并通过 `segments.start`、`segments.end` 和 `segments.text` 表示每段语音在视频第几秒说了什么。真实运行仍需要在仓库外准备官方 whisper.cpp `whisper-cli` 和 `ggml-small.bin`。

基于内容剪辑时，Agent 会先分析整段画面，在需要时进一步检查局部时间范围，然后自主选择保留片段并使用现有裁剪和拼接 Tool 生成新视频。

多步骤视频剪辑时，Agent 会在一个 Turn 中按模型选择的顺序连续调用多个 FFmpeg Tool，并把上一步的输出文件传给下一步；中间文件保留在最终输出文件所在目录。

```bash
pnpm ffmpeg-agent
```

所有 CLI 都输入 `/exit` 退出。仓库不会读取 `.env` 文件，也不会保存或输出 API Key。

运行 Desktop（桌面应用）前必须提供 `DEEPSEEK_API_KEY` 和 `WHISPER_MODEL_PATH`：

```bash
pnpm desktop
```

Desktop 根据任务按需调用 `ffmpeg`、`ffprobe` 和 `whisper-cli`；视觉分析按需读取 `OPENAI_API_KEY`。可选的 `WHISPER_CLI_PATH`、`DEEPSEEK_BASE_URL` 和 `OPENAI_BASE_URL` 与 `ffmpeg-agent` 使用相同含义。每个窗口只保留一个内存 Session（会话），当前不提供历史记录、设置、任务管理或播放器。

```text
Layer                 中文名称         职责
Renderer              渲染进程         收集文件和自然语言任务，展示回复与 Tool 活动
Preload contextBridge 预加载安全桥     暴露受限的桌面 API
Electron Main         Electron 主进程  持有窗口状态并调用应用层
createVideoAgent      组装视频智能体   创建正式视频 Agent
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
