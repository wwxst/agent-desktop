# Project Rules（项目规则）

本 reference 只保留执行治理时必须快速确认的项目事实。详细架构和永久规则以 [`docs/architecture.md`](../../../../docs/architecture.md)、[`docs/engineering.md`](../../../../docs/engineering.md) 和根 [`AGENTS.md`](../../../../AGENTS.md) 为准。

## 产品与阶段

项目使命与当前阶段以根 [`AGENTS.md`](../../../../AGENTS.md) 为准：开发通用智能体客户端，视频自动剪辑是重点场景，普通问答、文本与本地文件任务不以视频附件为前提。新增能力服务当前明确需求，Agent Core（智能体核心）保持通用与供应商无关。

当前生产意图中的主要能力：

```text
Capability                    中文能力                    Current boundary
Agent Runtime                 智能体运行时                Model、Session、Tool 和 Loop 的最小闭环
DeepSeek Provider             DeepSeek 模型提供商          原生 fetch，具体协议留在 Provider
FFmpeg editing                FFmpeg 视频编辑             ffmpeg/ffprobe 进程工具，不引入 SDK
Visual inspection             视觉画面观察                抽帧后由 OpenAI Responses API 返回观察
Speech timeline               语音时间轴                  标准 WAV 交给 whisper.cpp JSON 输出
Content-aware editing         基于内容剪辑                Agent 根据观察和时间轴选择 trim/concat
Agent execution trace         智能体执行追踪              execution-trace 将 Turn、Model 和 Tool 的诊断事件写入本地 JSONL，由 ffmpeg-agent 与 Desktop 消费
Desktop application           桌面应用                    Electron 单页入口承载当前视频任务的文件选择、自然语言任务、Tool 活动、最终回复和输出文件打开
```

## 核心调用链

所有变更先沿这条真实链路核对，不按文件名猜测职责：

```text
Entry                  中文入口       负责内容
CLI or Desktop entry   命令行或桌面入口  读取入口配置并提交用户任务
createVideoAgent       组装视频智能体  组装正式视频 Agent 依赖
runTurn                执行任务轮次    驱动一次 Turn 的 Model 与 Tool 执行
```

```text
CLI or Desktop entry
  → createVideoAgent
  → runTurn
  → Agent
  → Model.complete / Session.events / ToolRegistry / SystemPrompt.build
  → Tool.execute
  → Session.append(tool.result)
  → next Model.complete
```

`packages/agent-loop/src/index.ts` 负责 Turn、Step、模型请求、按响应顺序执行 Tool 和结束判断。CLI 与 Desktop 只组装依赖并展示事件；Tool 不控制 Loop；Session 是 append-only（只追加）事实来源。Desktop 的调用链为 Renderer（渲染进程）→ Preload contextBridge（预加载安全桥）→ Electron Main（Electron 主进程）→ `createVideoAgent` → `runTurn`。

## Workspace 与依赖图

正式 workspace 只有包含 `package.json` 的 `packages/*`、`examples/*` 和 `apps/*` 目录。当前 package 关系以 manifests 和真实 imports 同时为准：

```text
Package                                  Depends on
@agent-desktop/tools                    @agent-desktop/model
@agent-desktop/session                  @agent-desktop/model
@agent-desktop/agent                    model, session, system-prompt, tools
@agent-desktop/agent-loop               agent, model, session
@agent-desktop/execution-trace          agent-loop
@agent-desktop/model-deepseek           model
@agent-desktop/video-ffmpeg             model, tools
@agent-desktop/vision-openai            model, tools
@agent-desktop/speech-whisper-cpp       model, tools
example-echo-agent                      agent, agent-loop, model, session, system-prompt, tools
example-deepseek-agent                  agent, agent-loop, model, model-deepseek, session, system-prompt, tools
example-ffmpeg-agent                    agent, agent-loop, execution-trace, model, model-deepseek, session, speech-whisper-cpp, system-prompt, tools, video-ffmpeg, vision-openai
apps/desktop                            agent-loop, execution-trace, model, session, video-agent
```

Core package 是 `model`、`session`、`system-prompt`、`tools`、`agent` 和 `agent-loop`。`execution-trace` 是独立的运行诊断 package，只负责本地 JSONL 持久化，由 `ffmpeg-agent` 与 Desktop 消费，不属于 Agent Core；`model-deepseek` 是具体 Provider；`video-ffmpeg`、`vision-openai` 和 `speech-whisper-cpp` 是具体 Tool/外部边界；三个 example 与 `apps/desktop` 是可运行组装入口，不属于 Core。

必须保持：Core 不依赖 UI、具体 Provider 或具体 Tool；Provider 只能适配 Core Model；Tool package 只能使用 Tool/Model 契约；package 依赖必须反映真实 imports；examples 可以向下依赖，packages 不能反向依赖 examples。

## 当前运行时注册

`examples/ffmpeg-agent/src/index.ts` 当前把以下能力注册到同一个 `InMemoryToolRegistry`：

```text
Tool name                  中文用途
probe_media                媒体信息探测
extract_video_frames       全片代表性抽帧
extract_video_range_frames 局部范围抽帧
extract_audio              提取 16 kHz 单声道 PCM WAV
analyze_images             OpenAI Vision 观察图片
transcribe_audio           whisper.cpp 文字与段落时间轴
trim_video                 裁剪视频片段
concat_videos              拼接视频
add_audio                  替换或添加音频
add_subtitles              烧录 SRT 字幕
resize_video               调整分辨率
crop_video                 裁剪画面
set_speed                  调整播放速度
```

删除或重命名其中任何能力前，必须同时检查注册位置、System Prompt、README、测试和真实示例消费者。

## Project Invariants（项目不变量）

架构不变量来自 `docs/architecture.md`，工程不变量来自 `docs/engineering.md`；以下 ID 是审查时使用的稳定索引：

```text
ID        English invariant                                      中文说明
INV-001   Core is UI independent.                                核心与 UI 无关
INV-002   Agent Core is model-provider independent.              Agent Core 不绑定具体模型供应商
INV-003   Agent and Agent Loop are separate responsibilities.    Agent 与 Agent Loop 职责分离
INV-004   Session history is append-only.                        Session 历史只追加，不原地修改
INV-005   Every Step belongs to a Turn.                          每个 Step 必须属于一个 Turn
INV-006   Tool Result is traceable to its Tool Call.              Tool Result 必须能追溯到 Tool Call
INV-007   Tool implementations do not control the Agent Loop.    Tool 实现不能反向控制 Agent Loop
INV-008   Model-visible facts reconstruct from Session.           模型可见事实必须能从 Session 重建
ENG-001   Workspace dependencies reflect real imports.           workspace 依赖必须反映真实源码引用
ENG-002   Core packages remain UI-independent.                   核心 package 保持 UI 无关
ENG-003   Provider SDKs cannot enter core packages.               供应商 SDK 不得进入核心 package
ENG-004   Root TypeScript config represents the graph.            根 TypeScript 配置代表项目引用图
ENG-005   No empty shells for future features.                   不为未来功能创建空壳
```

## 非目标与边界

当前能力与非目标以根 `AGENTS.md` 和 `docs/architecture.md` 为准；已实现的会话历史、设置、任务执行、插件、命令钩子和 SQLite 持久化不再列为未来功能。新增能力仍须有当前明确需求和生产消费者，不为未来兼容创建接口。Desktop 已消费共享 Trace callback（追踪回调）中的 Tool 活动；`packages/execution-trace` 仍只负责本地 JSONL 运行诊断，不扩展为通用 Trace 平台。

桌面依赖与允许的安装脚本以 `docs/engineering.md`、当前包清单和 `pnpm-workspace.yaml` 为准，不在本指引维护另一份允许列表。

发现真实需求时，先写 Design（目标、问题、影响范围、非目标）并给出生产调用链和证据；不要因为通用方法论列出该能力就提前实施。
