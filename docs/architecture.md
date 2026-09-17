# Agent Desktop Architecture

本文档定义 Agent Runtime MVP（智能体运行时最小可行版本）及当前视频智能体应用层的核心边界。它描述职责、事实流和依赖方向，不预先设计当前范围之外的系统。

## Core Relationship（核心关系）

```text
                    User
                    用户
                     │
                     ▼
                ┌─────────────┐
                │    Agent    │
                │    智能体    │
                ├─────────────┤
                │ Model       │
                │ Session     │
                │ Tool Registry ─────► Tools
                │ System Prompt │       工具集合
                └──────┬──────┘
                       ▲
                       │ operates on
                       │ 操作 Agent
                ┌──────┴──────┐
                │ Agent Loop  │
                │  智能体循环  │
                └─────────────┘
```

核心关系可以概括为：Agent 持有 Model、Session、Tool Registry 和 System Prompt；Agent Loop 通过 Agent 使用这些能力；Tool Registry 管理当前 Agent 可以调用的 Tools。

### Video Agent Application Layer（视频智能体应用层）

`@agent-desktop/video-agent` 负责组装当前正式视频 Agent 的 Model、InMemorySession、System Prompt 和视频相关 Tool。它不读取环境变量、不创建终端或界面，也不拥有 Trace 持久化。`examples/ffmpeg-agent` 与 `apps/desktop` 负责各自的配置和入口交互，并共同调用 `createVideoAgent(...)`。

```text
Video Agent Application
视频智能体应用层
        │
        ├── examples/ffmpeg-agent
        │   CLI（命令行入口）
        │
        └── apps/desktop
            Desktop（桌面应用入口）
```

### Desktop Application Boundary（桌面应用边界）

`@agent-desktop/client` 是 Web（网页）与 Desktop（桌面）共用的产品级 React Client（客户端），只依赖显式传入的 `AgentClientApi`（客户端宿主能力接口），并拥有唯一的 App、Session UI、Runtime Settings UI（运行时设置界面）、Tool Activity、Artifact Card 和样式实现。`cancelTask`（取消任务）由同一接口提供；`apps/desktop` 通过 preload API 提供真实 Electron 宿主，`apps/web` 提供可取消的内存模拟 Turn，不执行本地视频 Agent，也不使用浏览器存储。

`apps/desktop` 是 Electron（桌面运行时）44.0.0、React（界面库）19.2.8、Vite（构建工具）8.2.2 和 esbuild（打包工具）0.27.4 组成的桌面宿主。它只负责当前视频任务所需的入口和展示：选择或移除一个或多个待提交视频文件、提交自然语言剪辑任务、按轮展示共享 Execution Trace（执行追踪）的 Tool Activity（工具活动）、执行期间的实时助手文本、最终回复与输出文件。任务文本可以在没有视频附件时独立提交；选择视频后仍沿用视频剪辑链路。

每个 Desktop 窗口维护一个最小 `Map<sessionId, DesktopSessionState>`，并将必要状态保存到 Electron `app.getPath('userData')/session-state.json`。每个会话只长期持有 InMemorySession（内存会话）、待提交视频路径和输出文件映射；`activeSessionId` 决定后续文件选择、任务执行和产物打开操作的目标。输出序号随状态文件保存，以避免重启后不同任务为同一输入生成相同文件名。

每次用户 Turn（用户任务轮次）开始时，Electron Main 重新读取最新 Runtime Settings（运行时设置）并创建一个 Video Agent（视频智能体）；该 Agent 在完整 Turn 内保持不变，下一个 Turn 才重新创建。每次创建都注入会话原有的同一个 InMemorySession，因此 Agent Loop 仍只根据 Session 事件重建 Model Context（模型上下文）。Renderer 为每个会话保存消息、草稿和附件等 UI History（界面历史），但不把这些消息重新拼接进模型请求。每轮 Tool Activity（工具活动）、Artifact（产物）和 Trace ID 都归属发起该轮任务的会话与 Agent 回复。

Turn 执行期间，Model 的 assistant text 增量沿现有 `desktop:agent-event` 通道实时推送到 Renderer，只更新当前 `processing`（处理中）的 Agent 回复。该临时文本不写入 Session，也不进入持久化快照；完成、取消或失败时由完整回复替换或直接丢弃。

Electron Main 同时只保存一个 `{ sessionId, controller }` 活动任务。`AbortController` 产生的同一个 AbortSignal（取消信号）依次传入 `runTurn`、Model 请求和 Tool 执行；Agent Loop 在 Model 前、Tool 前和 Tool 后检查它，Provider 将它交给 `fetch`，FFmpeg 与 whisper.cpp 的进程执行边界在 abort 时终止 child process（子进程）。取消不清空 Session，不回滚已完成 Tool 结果，也不删除已生成 Artifact（产物）；旧 controller 只清理自身对应的活动任务。

用户点击“新会话”时，Main 只创建新的 InMemorySession 并保留旧会话；点击侧栏会话时切换 `activeSessionId` 并恢复对应界面历史。执行中的 Turn 不允许新建、切换会话或保存设置，当前仍只有一个前台任务。应用重启时从状态文件恢复会话、SessionEvent、附件路径、产物路径和 Client Snapshot；Web Dev Host 返回空快照且不做持久化。

非敏感设置写入 `app.getPath('userData')/runtime-settings.json`。DeepSeek 与 Vision API Key（接口密钥）由 Electron `safeStorage` 加密后以密文写入 `runtime-secrets.json`；Renderer 只能读取“已配置 / 未配置”和来源，不能读取真实 Key。`safeStorage` 不可用时保存或读取本机密钥明确失败，不降级为明文。运行配置优先级为本机保存值、环境变量、Provider 默认值；缺少 Vision Key 或 Whisper Model Path 时分别不注册 `analyze_images` 或 `transcribe_audio`，其余能力继续运行。FFmpeg 继续只使用系统 PATH。

```text
Layer                 中文名称         职责
Renderer              渲染进程         保存运行期会话列表与各会话 UI 历史，收集任务和脱敏设置并切换展示
Preload contextBridge 预加载安全桥     通过 contextBridge 暴露受限桌面 API
Electron Main         Electron 主进程  按会话持有 Session、附件和产物，并负责设置与密钥持久化
createVideoAgent      组装视频智能体   每个 Turn 创建 Model、System Prompt 和当前可用视频 Tool
runTurn               执行任务轮次     驱动一次 Turn 的 Model 与 Tool 执行
```

Desktop 不把 Agent Core（智能体核心）逻辑放入 UI；当前取消只扩展 Model、Tool、Agent Loop 和 Trace 的最小信号契约，不实现 Pause / Resume（暂停恢复）、Task Queue（任务队列）、多任务并发、自动重试、已完成 Tool 回滚、云同步、Provider Registry（提供商注册表）或复杂状态机。

## Core Concepts（核心概念）

每个核心概念都必须有清晰职责，并且能够在不阅读内部实现的情况下被其他模块使用。

### Model

```text
English field       中文字段    说明
Responsibilities    职责        接收 Model Request 并返回 Model Response 或 Model Events
Owns                拥有        模型请求与响应的核心抽象，不拥有具体供应商客户端
Does Not Own        不负责      不驱动 Agent Loop，不保存 Session，不执行 Tool
Dependencies        依赖        只依赖核心请求、响应和事件值类型
Consumers           使用者      Agent Loop 和测试替身 Model
```

Model（模型）只表达模型交互的通用能力。其输出至少能够表达 assistant text（助手文本）和 tool calls（工具调用），但 Core 不出现 OpenAI、DeepSeek 或 Anthropic SDK 类型。

Model Request（模型请求）可以携带可选的文本增量回调。Provider 在流式响应中把 assistant text 增量实时上报给该回调，但回调只服务实时展示：Model 仍然返回完整 Model Response，Session 仍然只追加完整 `assistant.message`，任何 token 或增量都不会成为 Session 事实。

### Session

```text
English field       中文字段    说明
Responsibilities    职责        追加并读取一次 Agent 执行过程中发生的事实
Owns                拥有        append-only event log（只追加事件日志）
Does Not Own        不负责      不调用 Model，不执行 Tool，不决定 Loop 算法
Dependencies        依赖        核心事件类型和可重建历史的值类型
Consumers           使用者      Agent、Agent Loop 和测试
```

Session（会话）不是简单的聊天消息数组，而是 Agent 执行历史的事实来源。MVP 阶段 Session 可以只存在内存中，但数据模型从第一版开始必须支持 append-only（只追加）。

### System Prompt

```text
English field       中文字段    说明
Responsibilities    职责        组装基础 Agent 指令和当前运行所需的系统文本
Owns                拥有        基础系统提示词的来源和组装结果
Does Not Own        不负责      不执行 Model，不读取隐藏的 Session 状态，不实现 Skill 注入
Dependencies        依赖        Agent 配置和明确传入的基础工具描述
Consumers           使用者      Agent Loop 的 Model Request 构建阶段
```

System Prompt（系统提示词）必须有独立边界。Agent Loop 可以请求它构建系统指令，但不能在多个分支中到处拼接字符串。

### Tool

```text
English field       中文字段    说明
Responsibilities    职责        暴露一个可调用能力并执行一次合法输入
Owns                拥有        name、description、input schema 和 execute 行为
Does Not Own        不负责      不注册自己，不控制 Agent Loop，不直接修改 Session
Dependencies        依赖        核心工具调用输入、输出和错误结果类型
Consumers           使用者      Tool Registry 和 Agent Loop
```

Tool（工具）是一个可调用能力。MVP 不规定具体 schema library；工具只需要有稳定的名称、说明、输入约束和执行边界。

### Agent

```text
English field       中文字段    说明
Responsibilities    职责        表示一次运行所需的 Agent 依赖
Owns                拥有        Model、Session、Tool Registry 和 System Prompt
Does Not Own        不负责      不拥有驱动多 Step 的算法，不把所有行为塞进一个巨型类
Dependencies        依赖        Model、Session、Tool Registry 和 System Prompt 抽象
Consumers           使用者      当前示例入口和 Agent Loop
```

Agent（智能体）只持有 Loop 执行所需的依赖，不等于 Loop 算法本身。

### Agent Loop

```text
English field       中文字段    说明
Responsibilities    职责        驱动 Turn、Step、Model 调用和顺序 Tool 执行
Owns                拥有        执行算法、当前控制流和下一步决策
Does Not Own        不负责      不拥有 Model Provider 类型，不替代 Session 事实，不实现 Tool 细节
Dependencies        依赖        Agent 暴露的 Model、Session、Tool Registry 和 System Prompt
Consumers           使用者      Agent 的运行入口
```

Agent Loop（智能体循环）是当前驱动执行过程的算法。

## Agent and Agent Loop Separation（Agent 与循环分离）

两者必须保持不同职责：

```text
Agent
智能体
持有一次运行所需的依赖。

Agent Loop
智能体循环
驱动一次 Turn 内的 Step、Model 调用、Tool 调用和结束判断。
```

Loop 可以操作 Agent 提供的抽象，但不能把 Agent 设计成包含所有执行分支的巨大类。

## Turn and Step（轮次与步骤）

```text
English term    中文术语    定义
Turn            轮次        一次用户任务从开始到产生最终结果的完整生命周期
Step            步骤        Turn 内的一次模型调用以及由该调用触发的工具执行阶段
```

一个 Turn 可以包含 `1..N` 个 Step。不能把“一条 user message（用户消息）”写死为“一次 model request（模型请求）”。

示例：

```text
Turn 1

Step 1
Model → echo Tool Call
模型 → echo 工具调用

Step 2
Model ← echo Tool Result
模型 ← echo 工具结果
Model → Final Answer
模型 → 最终回答
```

## Session Event Log（会话事件日志）

Session 必须采用 append-only event log（只追加事件日志）思想：

```text
历史 Event 不原地修改。
新的事实通过追加 Event 表达。
失败通过新的事件或失败结果表达，不能修改旧事件来伪装成功。
```

MVP 只定义以下最小事件集合：

```text
Event name           中文含义    记录内容
turn.started         轮次开始    Turn 身份
user.message         用户消息    进入本次 Turn 的用户输入
step.started         步骤开始    Step 身份及所属 Turn
assistant.message    助手消息    Model 产生的文本输出或可关联的调用信息
tool.called          工具调用    Tool 名称、调用身份和经过约束的输入
tool.result          工具结果    Tool 返回值及 success 或 error 状态
step.completed       步骤完成    Step 的完成状态
turn.completed       轮次完成    Turn 已完成
```

`tool.result` 的 `error` 状态表达 Tool Error（工具错误），因此 MVP 不额外增加复杂的错误事件类型；语义上仍然必须区分 Tool Call、Tool Result 和 Tool Error。

必须满足：

> Model-visible information should be reconstructable from Session history.

模型真正看到过的历史信息，应当能够根据 Session 中保存的事实重新构建，而不是依赖只存在于内存中的隐藏状态。

Agent Loop 只把已存在 `step.completed` 的 Step 中的 `assistant.message` 与 `tool.result` 投影到 Model Context（模型上下文）。取消或失败的未完成 Step 仍作为 append-only Session（只追加会话）事实保留，但其中不完整的 Tool Calling（工具调用）链不会发送给后续 Model 请求。从状态文件恢复 Session 时，未完成 Step 及其 dangling Tool Call（悬空工具调用）等运行时残留被排除，恢复后的 Session 事件本身不包含它们；恢复只读取磁盘事实，不改写已追加的历史。

### Session Invariants（Session 不变量）

1. Session Event 只能追加。
2. 每个 Step 必须属于一个 Turn。
3. Tool Result 必须能够关联到对应 Tool Call。
4. Turn 正常完成后必须有明确完成状态。
5. 失败不能通过修改旧 Event 来伪装成成功。
6. Session 不应该保存无法解释来源的模型上下文。

## Model Abstraction（模型抽象）

Model 的通用边界是：

```text
Input                输入        Model Request
Output               输出        Model Response 或 Model Events
Minimum content      最小内容    assistant text 和 tool calls
Streaming text       流式文本   文本增量只用于实时展示，最终事实仍是完整 Model Response
Provider boundary    提供商边界  具体 SDK 类型只停留在 Provider package
```

Core 不得绑定以下具体接口或 SDK：

```text
OpenAI Responses API
DeepSeek API
Anthropic Messages API
```

Provider-specific types（提供商专属类型）必须停留在具体 Provider package（提供商包），不能泄漏到 Agent、Agent Loop 或 Session。

## Tool and Tool Registry（工具与工具注册表）

```text
English term     中文术语      职责
Tool             工具          一个可调用能力
Tool Registry    工具注册表    当前 Agent 可以发现和查找的 Tool 集合
```

Tool 至少包含以下概念字段：

```text
name             名称        稳定且可识别的调用名称
description      描述        供 Agent 和 Model 理解用途
input schema     输入约束    描述合法输入的形状和限制
execute          执行        接收合法输入并返回结果或错误
```

Tool Registry 负责注册、查找和返回 Tool，不负责执行 Loop 算法。MVP 不要求使用 Zod、JSON Schema library 或 Valibot，当前通过 Tool 的 inputSchema 描述输入约束。

## Tool Execution Failure（工具执行失败）

Tool 执行失败不能直接让 Session 历史丢失。MVP 采用最小方案：使用 `tool.result` 事件表达结果，并通过状态区分成功和失败。

```text
Tool Call        工具调用    记录请求已经被 Agent Loop 发起
Tool Result      工具结果    记录工具执行返回，状态为 success 或 error
Tool Error       工具错误    表示 Tool Result 的 error 状态及可解释错误信息
```

Tool 不存在、输入不合法或 execute 失败，都必须产生可追溯的失败结果，并允许 Agent Loop 决定是否结束当前 Turn。MVP 不设计复杂 Retry Policy（重试策略）。

## Agent Loop State Machine（Agent 循环状态机）

MVP Loop 的最小状态机如下：

```text
START
  │
  ▼
Begin Turn
  │
  ▼
Append User Message
  │
  ▼
Begin Step
  │
  ▼
Build Model Input
  │
  ▼
Call Model
  │
  ▼
Model Response
  │
   ▼
Has Tool Calls?
   │
   ├── NO ───────────────► Complete Step
   │                         │
   │                         ▼
   │                     Complete Turn
   │                         │
   │                         ▼
   │                        END
   │
   └── YES
         │
         ▼
   Begin ordered Tool Calls
   同一 Step 内按顺序开始
         │
         ▼
    Execute next Tool
         │
         ▼
   Append Tool Result
         │
         ▼
   More Tool Calls?
         │
         ├── YES ─────────► Execute next Tool
         │
         └── NO ──────────► Complete Step
                              │
                              └────────────► Next Step
```

一次 Model Response 可以包含多个 Tool Call。MVP 中这些 Tool Calls 属于同一个 Step，并按顺序执行；只有所有 Tool Results 都记录完成后，才完成当前 Step 并进入下一 Step。不引入并行 Tool execution（工具并行执行）。

## Dependency Rules（依赖规则）

允许的主要关系：

```text
Agent
  │
  ├── uses Model
  ├── uses Session
  ├── uses Tool Registry
  └── uses System Prompt

Agent Loop
  │
  └── operates on Agent abstractions
```

必须禁止以下依赖：

```text
Model 不依赖 Agent Loop。
Tool 不依赖 Agent Loop。
Session 不依赖具体 Model Provider。
Core 不依赖 Electron。
Core 不依赖 React。
Core 不依赖具体 Tool implementation。
Agent Loop 不依赖 OpenAI 或 DeepSeek SDK。
Session 不依赖 UI。
```

## Architecture Invariants（架构不变量）

```text
ID        English invariant                                      中文说明
INV-001   Core is UI independent.                                核心与 UI 无关。
INV-002   Agent Core is model-provider independent.              Agent Core 不绑定具体模型供应商。
INV-003   Agent and Agent Loop are separate responsibilities.    Agent 与 Agent Loop 必须职责分离。
INV-004   Session history is append-only.                        Session 历史只追加，不原地修改。
INV-005   Every Step belongs to a Turn.                          每个 Step 必须属于一个 Turn。
INV-006   Every Tool Result is traceable to its Tool Call.       每个 Tool Result 必须能追溯到对应 Tool Call。
INV-007   Tool implementations do not control the Agent Loop.    Tool 实现不能反向控制 Agent Loop。
INV-008   Model-visible facts are reconstructable from Session.  模型看到过的历史事实能够从 Session 重建。
```

这些不变量是 MVP 的设计约束。新增不变量必须服务于当前核心边界，不超过实际需要。

## Failure Boundaries（失败边界）

MVP 至少需要能够解释以下失败：

```text
Failure boundary          失败边界            MVP 处理方式
Model failure             模型失败            异常向上抛出，保留失败前已写入的 Session 事件
Tool not found            工具不存在          产生可追溯的 Tool Result error
Tool execution failure    工具执行失败        产生带错误状态的 Tool Result
Malformed tool call       工具调用格式错误    不执行未知输入，记录可解释失败
```

当前不加入 Retry、Backoff 或 Circuit Breaker。失败边界的目标是让 Session 状态可解释，而不是一次性解决所有恢复策略。

## Agent Execution Trace（智能体执行追踪）

Agent Execution Trace（智能体执行追踪）用于定位一次 Agent Turn 在 Model、Tool 或 Turn 哪一层发生问题。Agent Loop 通过最小 `ExecutionTrace` callback（执行追踪回调）产生语义事件，`@agent-desktop/execution-trace` 只负责本地 JSONL 持久化，并由 `ffmpeg-agent` 与 Desktop 两个真实入口消费；每次用户输入创建独立 `traceId`。

Session（会话）与 Trace 必须保持不同职责：

```text
Concept            中文概念    职责
Session            会话        保存模型可见业务事实，用于重建 Model Context
Execution Trace    执行追踪    保存运行顺序、状态、耗时和错误定位信息
```

Trace 不参与 Agent 推理，不能用于重建 Model Context，也不复制完整 Session Event、用户输入、Model 内容或 Tool 内容。

```text
traceId
  │
  ▼
Turn
  │
  ▼
Model Call
  │
  ▼
Tool Call
  │
  ▼
Tool Result
  │
  ▼
Final Response
```

MVP 事件集合如下：

```text
Event              中文事件    记录内容
turn.started       轮次开始    turnId
model.started      模型开始    turnId、stepId、messageCount、toolDefinitionCount
model.completed    模型完成    durationMs、toolCallCount、hasText
model.failed       模型失败    durationMs、errorName、errorMessage
tool.started       工具开始    turnId、stepId、toolCallId、toolName
tool.completed     工具完成    durationMs
tool.failed        工具失败    durationMs、errorName（如有）
turn.completed     轮次完成    durationMs、stepCount
turn.failed        轮次失败    durationMs、errorName、errorMessage
```

JSONL Writer（JSONL 写入器）在每行增加同一个 `traceId` 和写入时的 ISO `timestamp`。Agent Loop 使用 `Date.now()` 计算毫秒耗时，并 `await` 每次 callback（回调）写入，使日志顺序与实际串行执行顺序一致。Tool 返回 `status: error` 时记录 `tool.failed`；AbortSignal 已取消时记录 `turn.cancelled`，其他 `runTurn` 异常记录 `turn.failed`。正常写入时 Trace 不改变既有错误传播和 Session 行为；Trace 写入本身失败时，callback 的异常按程序错误向上暴露。

Trace 当前固定写入仓库根目录下的 `logs/agent-trace.jsonl`。CLI 与 Desktop 都将入口工作目录解析到该路径。日志只包含关联 ID、事件类型、计数、状态和 Model/Turn 错误信息；Tool 失败不保存错误消息，避免间接写入 Tool input/output。日志不保存完整用户 Prompt、Model Request/Response、Tool input/output、Transcript、Vision analysis、图片、视频内容、API Key、环境变量值或错误 stack。

Desktop 会消费 Trace callback 中的 Tool 活动并展示执行状态，但不提供独立的 Trace 日志 UI。当前不实现日志上传、搜索、过滤、rotation（轮转）、retention（保留策略）、版本探测、queue（队列）、buffer（缓冲）、retry（重试）、fallback logger（兜底日志器）、OpenTelemetry、ELK、Jaeger、Zipkin 或 Sentry integration；这些能力当前没有生产消费者。
