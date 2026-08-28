# Project（项目）

这是一个从零开发的通用 Agent Client。

# Current Status（当前状态）

项目处于非常早期的 `0.x` 开发阶段。

当前优先级是建立正确的 Agent Runtime 基础，而不是追求功能数量或 UI 完成度。

当前已经完成：

```text
English term                    中文术语                 介绍
Core Interfaces                 核心接口                 定义 Model、Session、Tool、System Prompt 和 Agent 边界。
Minimal Agent Loop              最小 Agent 循环          跑通 Model、Tool、Result、Model 的执行闭环。
Runnable Echo Agent             可运行 Echo Agent        从终端组装并运行第一个完整 Agent 示例。
DeterministicEchoModel          确定性 Echo 模拟模型     只验证 Runtime，不调用真实 LLM API，也不进行大模型推理。
DeepSeek Real Model Provider    DeepSeek 真实模型适配器  通过原生 fetch 接入真实 DeepSeek Chat Completions API。
FFmpeg Basic Video Editing      FFmpeg 基础视频编辑      通过本机 FFmpeg 提供八个基础视频处理工具。
Multi-step Video Editing        多步骤视频剪辑          Agent 可以在一个 Turn 中连续组合多个 FFmpeg Tool 完成视频处理任务。
Visual Media Inspection         视频视觉理解            FFmpeg 抽取代表性视频帧，OpenAI Vision 分析画面，DeepSeek 继续推理。
Content-aware Editing           基于内容的剪辑          Agent 可进一步检查局部范围，自主选择保留片段并使用 FFmpeg 重新拼接。
```

# Long-term Direction（长期方向）

未来大致包括：

```text
English term              中文术语             介绍
Agent Core                Agent 核心           定义 Agent 的基础状态、请求和执行结果等核心概念。
Agent Loop                Agent 循环           负责驱动 Agent 持续处理输入、调用能力并产生下一步行动。
Model abstraction         模型抽象             用统一接口连接不同模型，避免核心逻辑绑定具体模型厂商。
Tool system               工具系统             为 Agent 提供可发现、可调用、可扩展的外部能力。
Session/event log         会话与事件日志       记录 Agent 执行过程，作为恢复和审计的事实来源。
Context                   上下文               管理 Agent 在一次执行中可使用的历史、输入和相关信息。
Skills                    技能系统             将面向特定任务的知识、流程和能力组织为可扩展技能。
Permission                权限系统             控制 Agent 是否可以执行敏感操作，并保留明确的授权边界。
Persistence               持久化               保存会话、配置和其他需要跨进程或跨时间保留的数据。
Client protocol           客户端协议           定义 Agent Runtime 与不同客户端之间的通信契约。
Electron desktop client   Electron 桌面客户端  在后续阶段提供本地优先的桌面交互界面。
```

这些都属于未来方向，不代表当前已经实现。

# Current Engineering Foundation（当前工程基础）

项目采用 Node.js 24 LTS、pnpm workspace、TypeScript ESM 和 Vitest。当前 Agent Runtime 已具备核心接口、最小 Agent Loop、可运行 Echo Agent、DeepSeek 真实模型适配器和 FFmpeg 基础视频编辑能力。

# Run Agents（运行 Agent）

```text
Command               模型类型           说明
pnpm echo-agent       确定性模拟模型     无需 API Key，不调用真实 LLM API
pnpm deepseek-agent   DeepSeek 真模型    需要 DEEPSEEK_API_KEY，调用真实 DeepSeek API
pnpm ffmpeg-agent     DeepSeek 真模型    需要 DEEPSEEK_API_KEY，以及 PATH 中的 ffmpeg 和 ffprobe
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

视觉分析会先抽取六张代表性 JPG，再通过 OpenAI Vision 返回结构化画面描述；DeepSeek 负责调用 Tool 和回答问题。运行视觉分析需要 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ffmpeg` 和 `ffprobe`。OpenAI-compatible 中转站可以通过 `OPENAI_BASE_URL` 指定，未设置时使用 OpenAI 官方地址。

基于内容剪辑时，Agent 会先分析整段画面，在需要时进一步检查局部时间范围，然后自主选择保留片段并使用现有裁剪和拼接 Tool 生成新视频。

多步骤视频剪辑时，Agent 会在一个 Turn 中按模型选择的顺序连续调用多个 FFmpeg Tool，并把上一步的输出文件传给下一步；中间文件保留在最终输出文件所在目录。

```bash
pnpm ffmpeg-agent
```

所有 CLI 都输入 `/exit` 退出。仓库不会读取 `.env` 文件，也不会保存或输出 API Key。

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
