# 通用智能体升级的最小实施设计

版本 D4，2026-10-11，用户已确认实施。此文件保存本轮批准的设计与取舍，不表示全部能力已经实现；当前事实以源码、验证记录与 architecture.md 为准。三轮独立方案审查已通过，实际代码仍需逐阶段验证。D4 明确已有持久终端在强杀后的持续执行事实边界。

## 1. 模块及权威归属

```text
Session               原始会话       保存只追加事件和通用的纯状态投影。
Agent Loop            执行循环       预算、协议完整性、请求预算和每次工具调用前的门禁。
Model                 模型契约       保持供应商无关消息、输出额度和错误分类。
Tool                  工具契约       计划更新及副作用前的同步检查点。
Desktop Main          桌面宿主       SQLite、工具证据资格、外部核验、宿主阶段和恢复入口。
Shared Client         共享界面       展示 Main 投影，发起用户恢复或人工核验动作。
Execution Trace       执行追踪       仅诊断耗时及活动，不成为任务事实库。
```

不新增 package、任务数据库、工具策略框架或 Agent Framework（智能体框架，通用执行基础设施）。Agent 仍只持有 model/session/tools/systemPrompt。Session 不导入 video-agent、Electron、具体工具或插件协议；Provider 不导入 Session。

`tools → session` 新依赖只服务 UpdatePlanTool；Session 目前只依赖 model，方向无环。Loop 选项新增的门禁和上下文预算各有 Desktop 真实消费者。Domain（领域，工具输出的业务含义）只在 Desktop 的现有组装边界判断。

## 2. 事件、身份与纯投影

原事件保留。以下是需要在第 1 个 Commit 固定的新增字段及事件，命名以此为准：

```ts
// 指向同一 Session append-only 数组的稳定位置，不把模型 ToolCallId 当全局 ID。
type SourceEventIndex = number;
type ExecutionBoundary = 'not-executed' | 'read-only' | 'checkpointed' | 'opaque';
type TaskPlanStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';
type TaskPlanStep = {
  id: string; description: string; requestedStatus: TaskPlanStatus;
  completionKind: 'tool' | 'response'; evidenceEventIndexes: readonly number[];
};

// tool.called 增加可选 boundary；缺省表示旧记录，不能猜成只读。
// checkpointed：真实工具的全部副作用有执行前 checkpoint；
// opaque：任意外部/包裹工具，无法证明全部副作用。
type NewSessionEvent =
  | { type: 'turn.failed'; turnId: TurnId; errorName: string; errorMessage: string }
  | { type: 'turn.cancelled'; turnId: TurnId; reason: 'user' | 'window-closed' | 'external' }
  | { type: 'turn.interrupted'; turnId: TurnId; reason: 'process-exit' | 'legacy-unknown' }
  | { type: 'turn.recovery.started'; turnId: TurnId; sourceTurnId: TurnId;
      mode: 'continue' | 'verify' }
  | { type: 'context.compacted'; turnId: TurnId;
      coveredStepEndEventIndexes: readonly number[]; previousSummaryEventIndex?: number;
      sourceDigest: string; summary: string; estimatorVersion: 1;
      estimatedBefore: number; estimatedAfter: number }
  | { type: 'plan.updated'; turnId: TurnId; revision: number; explanation: string;
      steps: readonly TaskPlanStep[] }
  | { type: 'tool.effect.prepared'; turnId: TurnId; sourceEventIndex: number; data: unknown }
  | { type: 'host.operation.started'; turnId: TurnId; operation: string; description: string }
  | { type: 'host.operation.result'; turnId: TurnId; sourceEventIndex: number;
      status: 'completed' | 'failed' | 'cancelled'; errorName?: string; errorMessage?: string }
  | { type: 'effect.outcome.verified'; turnId: TurnId; sourceEventIndex: number;
      scope: 'file-effect' | 'entire-call'; outcome: 'completed' | 'not-applied' | 'unresolved';
      evidence: { source: 'tool' | 'user' | 'host'; reference: string; description: string } };
```

`scope:'file-effect'` 的唯一原因是：文件摘要只能核验文件，不能解除包裹工具钩子的其他未知效果。Session 只消费 scope 和真实来源，不理解文件字段。核验事件不修改原结果，不补造 success、产物或业务验收。source='host' 只由 Main 用于无法确认的宿主观察，不能由模型或客户端指定；当前唯一新消费者是启动时发现已持久化 running 的终端，其 outcome 固定 unresolved。

所有引用都校验整数、范围、事件类型及同一 Session 归属。Tool Result 原始配对仍使用 turnId/stepId/toolCallId 组合；计划引用结果事件索引，核验引用 tool.called 或 host.operation.started 索引。不同轮次可以复用相同模型调用 ID，不能碰撞。

`packages/session/src/index.ts` 增加真实消费者需要的 `appendMany(events):void`。内存实现一次 push；Desktop 实现一次 SQLite 提交，成功后才更新内存。`append` 委托单事件批次。`SessionPersistenceError(cause)` 在 session 定义并导出，由 local-tools、Loop、Main 导入同一个类；保存原错误，不用 error.name 文案猜测，不反向导入 Main。

纯投影函数：

- `projectTurnState(events, turnId)`：started/completed/failed/cancelled/interrupted。
- `projectRecoveryFacts(events)`：同一会话的未知外部效果、原已成功请求、拒绝事实及来源；唯一计算规则同时供门禁、恢复 UI 和上下文使用。
- `projectTaskPlan(events, rootTurnId, qualifyToolEvidence)`：核对任务链、索引、真实结果，再调用宿主证据资格函数；不硬编码具体工具。
- `projectTaskState(events, rootTurnId, planProjection)`：最新恢复后继、未知效果优先 blocked；未完成计划且轮次已结束也 blocked；否则沿用最近 continue/原根执行终态。verify 轮次只核验，不把原 failed/cancelled/interrupted 工作变成完成；无计划时核验为 not-applied 后原工作仍可继续。completed 仅表示执行已结束且无未解决事实，不承诺任意自然语言目标的语义正确。

rootTurnId 由 recovery ancestry（恢复祖先链，源轮次关联）得到，不另存 Task 状态。旧未完整 Step 的真实结果和待核验事实作为带事件索引的普通派生文本进模型；完整工具协议仍只投影完整 Step，不造 tool 消息或 step.completed。

## 3. 上下文预算与压缩

修改既有 `runtime-settings.ts` 下传 contextWindow。`RunTurnOptions.contextBudget` 为 `{contextWindow:number,maxOutputTokens:number}`；**仅在两者都已明确、且 Provider 真正限制输出时启用**。只配窗口不配输出上限时，沿用原行为并注明没有预算保证；不猜模型名或供应商默认输出，不新增设置 UI。

ModelRequest 增加 `maxOutputTokens?`；Chat Completions（聊天补全协议，使用消息数组）和 Responses（响应协议，使用输入项目）都落实本次上限，覆盖摘要请求和正常请求，不能只修改供应商实例的默认配置。保留当前协议适配与流式不重复请求规则。

`packages/agent-loop/src/context.ts` 用直接函数实现构建、估算、压缩；无新 Manager。预算涵盖最终 systemPrompt、全部原始用户文本、动态工具 schema、调用 JSON、结果、最新计划、未知效果、摘要及协议开销。动态工具、插件指令和长期记忆准备完成后才计算。

估算使用 UTF-8 字节数加协议开销，注明保守估计而非供应商精确 token usage（令牌用量，服务端实际计费及窗口单位）。可用输入 `B = window - outputCap - ceil(window * 0.05)`；B 不可用或必须保留部分超过 B 时，ContextBudgetError 明确失败，历史不变。达到 B 的 80% 才压缩旧完整 Step，优先保留最近两个完整 Step，必要时减少完整尾部数量，不拆调用/结果组。

**覆盖范围唯一表示为 coveredStepEndEventIndexes**：每项必须是对应完整 Step 的 step.completed 索引；通过 turnId/stepId 精确选择该 Step 的 assistant.message 与全部 tool.result。没有“覆盖到某位置就包含所有中间事件”的含糊范围。user.message、最新计划、未知效果和生命周期事件不被摘要替代。前摘要使用 previousSummaryEventIndex 引用，它自己的覆盖集合加本次新集合形成累计覆盖，不能重复覆盖或引用未来摘要。

sourceDigest 是 SHA-256，对固定结构 `{previousSummarySourceDigest,previousSummaryText,newStepSources}` 的 UTF-8 JSON 求摘要；newStepSources 按原始事件顺序，包含每条源事件索引及原始字段，对象键递归排序、数组保持顺序。此表示与实际摘要输入一致，重启可复算。摘要中的事实引用只能落在本次/前摘要累计覆盖集合；来源校验证明范围，不能证明语义准确。

tools=[] 的摘要请求不能执行返回的调用；结果须非空、无 Tool Call、来源合法、输入与产出均在预算内，之后才 append context.compacted。摘要指令也计入预算。超长区间按完整 Step 分块滚动；每次正式请求前至多两次摘要请求，每次只有一次请求、无额外模型重试。不可拆分的单 Step 过大时失败，不截断为“压缩成功”。

压缩回退只适用于明确的摘要模型失败或摘要格式失败，且原投影仍在硬预算内。AbortError、SessionPersistenceError、程序错误一律传播；摘要落盘失败不能被“压缩失败可回退”吞掉。即使先前滚动块摘要已成功追加，后块失败也不损坏原历史；只有完整覆盖且预算合规的投影用于本次请求。

所有原始用户约束以原文确定性保留。摘要不提升为系统指令，不写入长期记忆，不采用 Responses 专属加密压缩项。用户原文本或工具 schema 自身太大时需缩小输入/调整配置，不能承诺无限长度对话。

## 4. 计划与事实资格

`packages/tools/src/plan.ts` 的 `UpdatePlanTool(session, qualifyToolEvidence)` 追加 plan.updated，返回 revision/step ID 确认。Desktop 在扩展工具组装后将计划与核验工具直接注册为**不经插件 hooks 包裹**的宿主工具；简单任务无需调用。模型 JSON 只校验当前使用的字段、步数/描述预算、稳定 ID、来源范围和真实证据；不给 Session 新增领域解析规则。

同一任务最新声明是计划意图的唯一来源；实际状态只由投影生成：

- tool 类型 completed 必须引用原任务链的真实成功结果，或 completed 的核验事实。计划工具自身、无关轮次、失败结果、新一次 blocked 结果均不能作为完成证据。
- response 类型只证明“文本回复已生成”：该声明之后原根/continue 轮次的真实最终 assistant 文本及 turn.completed 齐备时由投影完成；verify 轮次最终说明不能成为原任务文本交付证据。UI 必须保留这个证据口径，不能把它显示为“文件已修改”。不能靠关键词检查证明模型是否把写入错标为文本步骤，也不宣称防住任意语义误报。
- failed 必须有实际错误来源；blocked 来自未知效果、真实等待用户交互或终态中断。模型无依据的 completed/failed 声明拒绝；未取得资格的成功结果只显示“工具已返回”，不确认业务完成。
- 更新计划追加完整新版本和 explanation；已取得完成证据的稳定步骤不允许被删除或退回 pending。新工作新 ID，旧版本仍可审计。

以下回调类型在 session 定义/导出，tools/Loop 只导入 Core 类型；Desktop `agent-task-state.ts` 直接实现并注入同一个精确回调，不允许 Core 反向依赖 Main：

```ts
type PlanEvidenceSource = Extract<SessionEvent,
  { type: 'tool.result' | 'effect.outcome.verified' }>;
type QualifyToolEvidence = (source: PlanEvidenceSource,
  events: readonly SessionEvent[]) => { eligible: boolean; label: string };
```

UpdatePlanTool 声明 completed 时以同一函数验证 eligible，纯投影用同一函数重建状态和 label；不能两个消费者各写规则。本地读取/写入使用已有成功结果含义；delegate_tasks 必须 children 全部 completed；终端输入/开启仅为“输入已发送/终端已启动”，不能证明命令结束；未知 MCP 成功只证明返回，不能确认外部业务验收；视频继续使用现有结果，不重建视频验收。已完成的 entire-call 核验可以提供人工/只读来源证据，不能补造原成功结果。eligible=false 只能显示该事实 label，不能让步骤成为 completed。

资格函数是宿主纯函数及一个现有回调消费者，不增通用工具策略注册表。Core 只校验事件和通用资格。Main 通过现有 agent-event 发送步骤/证据，Client 在回复内显示轻量列表，更新 docs/desktop-ui.md 并执行 desktop-frontend 技能验收；不做任务中心、领域模板或前端成功判定。

## 5. 失败分类和每次执行门禁

ToolResult.error 新增可选 `failureKind:'transient'|'permanent'|'denied'|'cancelled'|'unknown-outcome'`，原 message/output 不变；旧未分类结果不猜为临时。真实边界也可抛结构化 ToolExecutionError；AbortError 始终终止 Turn，不能转成普通失败继续。保留现有模型每 Step 最多一次、每 Turn 总计最多两次附加请求、等待上限及部分流禁重试；本期没有自动 Tool 重试。

`RunTurnOptions.beforeToolCall` 为同步、实际执行前的宿主门禁：

```ts
beforeToolCall(input: {
  turnId: TurnId; stepId: StepId; call: ToolCall;
  tool: Tool | undefined; sourceEventIndex: number;
}): { boundary: Exclude<ExecutionBoundary, 'not-executed'>;
      blocked?: { message: string; sourceEventIndexes: number[] } };
```

Loop 查到**最终实际 Tool 实例**后、append tool.called 和任何 Tool.execute 前调用。sourceEventIndex 是同步拟追加索引（当前 events.length），回调只读、不能追加事件或 await；随后立即追加 called，保证引用不漂移。Main 闭包读取当前 Session 的 projectRecoveryFacts。允许时 called 保存返回的 boundary；门禁拒绝或不存在工具时，Loop 以 boundary='not-executed' 一次 appendMany called+真实 error/permanent 结果，output 仅带原事实索引，不新建 success 或 artifacts。not-executed 从不形成未知副作用，不能让被门禁拦截的 opaque 请求制造新阻塞。工具执行后每个后续调用重新投影；同一模型响应中的第二个调用、同一轮新 Step、恢复轮次和普通新任务全部受约束，不能只过滤模型工具描述。

Main 用具体组装实例识别边界，不让模型指定只读：未经包装的已知读工具为 read-only；完成执行前检查点接入的原文件/命令/终端为 checkpointed；通用 MCP 包装层在请求前保存检查点并声明 checkpointed，服务端失败/断连仍形成 unknown-outcome；其他外部能力、任何 hooks 包裹后的工具为 opaque，hooks 的内层只读声明不能向外透传。计划/核验工具虽然追加内部事实，但不产生外部写入，可以在核验模式使用；保存失败仍致命。安全模式直接构建未包裹的三个已有读取工具加计划/核验工具；已有终端/历史存在时还允许未包裹的 read_terminal 读有界输出/历史，不能重建进程，不 prepareExtensions、不启动服务或 hooks。**安全轮次工具集固定到结束，即使自动核验解除全部未知，也不在运行中转为正常扩展模式**；用户结束后再主动开始新的 continue 恢复轮次。没有通用只读声明协议。

未知集合规则在 Session 中一处实现：

- not-executed 无论结果如何都没有本次副作用；read-only 无结果不是写入阻塞。
- checkpointed 无结果只有存在 tool.effect.prepared 才存在未知效果；未准备的取消/审批拒绝不等于外部操作已经发生。
- checkpointed 有 prepared 且错误未能证明没有效果时同样待核验；明确 permanent/denied 且该原工具能证明未执行写入时不造未知。旧缺省 boundary 的调用按 opaque 核验能力处理，但不把旧无终态轮次伪称 process-exit。
- opaque 的无结果、未分类异常、取消或错误即无法证明无副作用，形成 entire-call 待核验；底层 denied/permanent 也不能证明外层 hooks 没有效果。
- 成功结果保留成功；error/unknown-outcome 进入待核验。明确拒绝的原工具不重试；原批准不继承到新调用。
- 最新的 entire-call unresolved 核验/宿主观察可以使原 success 的外部效果待核验，原 ToolResult 仍为成功。这里成功的是发送/启动事实，不由成功默认推断后续异步命令效果已经结束。仅明确 completed/not-applied 的 entire-call 核验解除；file-effect 和 disconnected 展示都不能解除。
- 新 scope=entire-call 的 completed/not-applied 核验才能解除整个不确定项；file-effect 仅证明文件部分。原失败原因始终存在。

**拒绝与防重放**：本轮 denied 的准确相同工具+规范化 JSON 输入再次请求时直接 blocked，不再次审批。新的明确用户动作可以重新申请，但必须重新批准；恢复不能把旧拒绝解释为授权。当前根 Turn 及其恢复链中相同已成功副作用或 entire-call verified completed 调用也 blocked，模型取得原事件引用而非伪造本次成功。JSON 去重不保证识别同义命令/变化参数；恢复器从不遍历原输入自动调用工具。普通新任务不能绕过仍未解决的会话级未知效果。

恢复/核验轮次固定 `maxSteps=24,maxToolCalls=48`（内部常量，不新增用户配置）；Loop 增加 maxToolCalls 的唯一真实消费者是这些轮次。每次尝试含 blocked 都计入调用预算；至多 24 次正式模型请求、2 次附加重试、48 次无重试摘要请求，总至多 74 次该轮 Loop/摘要模型请求，且最多 48 次工具尝试。此数字不涵盖已有工具内部视觉、语音或子模型请求，它们继续使用现有独立预算；不新增全局调度。普通轮次保留既有执行策略，不谎称全应用已有后台调度或全局时限。

## 6. 副作用前检查点与核验

`ToolExecutionContext.checkpoint(data:unknown):void` 同步追加 tool.effect.prepared，sourceEventIndex 由 Loop 闭包提供。local-tools 在审批及最后版本检查之后、真实 writeFile 之前记录 `{kind:'text-file',path,beforeSha256:null|string,expectedAfterSha256,expectedBytes}`；具体结构由 local-tools 导出并解析。命令在 spawn 前、终端在启动/发送输入/关闭进程树前都追加自身外部操作的 prepared 数据；close_terminal 未接入此前必须按 opaque，不能冒称 checkpointed。Main 的取消/关闭收尾属宿主阶段，不伪造工具调用。这些不提供通用外部状态核验，只证明跨过了执行边界。集成后的通用 MCP 工具在审批通过后、client.callTool 前记录 `{kind:'mcp',pluginId,serverName,toolName}`；检查点保存失败原样传播，不发送请求。审批拒绝为 denied、请求前参数错误为 permanent，请求异常及服务端 isError 为 unknown-outcome；hooks 外层仍按 opaque 记录。

**持久终端持续执行的最小事实**：Main 拥有 prepared 数据 `{kind:'terminal',terminalId,operation:'open'|'input'|'close'}`。open 在已有 UUID 机制中先分配 terminalId，再 checkpoint，再构造 SessionTerminal/spawn；write/close 使用真实实例 ID。Session 不解析这些字段。Main 不另建资源表，只从这些原事件定位最后保存终端的 open/input 来源。

SQLite 的 terminalHistory 保存原始 running/exited 状态，状态转换同步提交；解析层不提前改成 disconnected。Main 对没有活进程句柄的 UI/API 历史单独投影 disconnected，Renderer 保存不能将该派生显示状态覆盖原始事实。输出仍按已有有界缓存/通知策略，不为逐字符输出新增持久化系统。

新宿主读取最后持久化为 running 的终端、且它没有活句柄时，在外部 prepare 之前，为该 terminalId 尚未有 entire-call completed/not-applied 核验的每个原 open/input 来源追加一次 `effect.outcome.verified(scope:'entire-call',outcome:'unresolved',evidence.source:'host')`。明确描述“启动/输入已成功，宿主已失去连接，命令效果及进程是否仍活动未确认”；已有相同 unresolved 观察不重复追加。这是启动时观察，不把原 success 改 error，也不依赖有没有未返回调用。

正常退出/close 的 exited 状态已同步提交时，不由 running 规则凭空制造持续进程；close prepared 后无结果仍按既有规则待核验。若原命令还有已知业务失败/未完成计划则继续保留，exited 不被解释为业务完成。旧历史没有 prepared 来源但保留 running 时，由 Main 使用原工具结果的 terminalId 做可机械匹配；匹配不到则以 sourceEventIndex 指向新追加的 host.operation.started(operation:'terminal-connection-lost') 和失败结果，作为明确旧来源不足的待核验事实，不按文字猜 ToolCallId，也不启动进程。

该旧来源不足观察同时记录 existing evidence.reference='terminal:'+terminalId 的 unresolved 核验事实，来源为上述 host.operation.started；起点/失败/观察使用同一 appendMany 提交。后续启动先按此 reference 查找并复用原 sourceEventIndex；已待核验或已整调用核验均不新造来源。它只关联终端身份，不根据命令文字猜历史归属。

终端这类来源不能通过读取历史或某个文件匹配自动解除 entire-call；用户人工核验的说明必须覆盖旧进程是否已停止/不会继续产生效果及命令结果。read_terminal 在无活句柄时只返回匹配 ID 的历史 disconnected 视图，旧输入不重发。既不提供命令解析/命令退出码伪推断，也不承诺操作系统级隔离或普遍终止保证。

checkpoint 放在业务写入 try/catch 外，且所有相关工具捕获都必须让 SessionPersistenceError 原样穿透；计划/核验/工作目录/子历史保存同样如此。实际 syscall 开始后的文件异常（除能证明未写入的 wx EEXIST）为 unknown-outcome；命令非零/超时有原始输出，但不能证明没有副作用。取消有 Turn 取消终态，已准备但无结果的写入仍未知。

Desktop `VerifyToolOutcomeTool` 输入只接受 sourceEventIndex。它读取原 called/prepared，不允许模型提供目标路径、预期摘要或 user 来源。按现行目录授权读取实际目标：完整后摘要匹配为 completed，原摘要匹配/创建目标不存在为 not-applied，部分写入或其他变化为 unresolved；读取失败不追加伪核验，保留真实错误。原裸文件工具可记录 entire-call；opaque 包裹文件工具只记录 file-effect，其他 hooks 效果仍需人工核验。未知命令、终端、MCP、宿主操作不做通用自动核验。

新增独立 IPC `verifyTaskEffect({sessionId,sourceEventIndex,outcome,description})`，仅空闲时由用户核验按钮发起。Main 校验真实会话、仍待核验的 tool.called/host.operation.started 来源、outcome 为 completed/not-applied、非空说明；由 Main 固定 evidence.source='user'、scope='entire-call'。普通模型工具无法提交人工来源。人工结论不赋予目录权限或新的审批；所有下一次副作用仍重新批准。已完成 Core 但未知 Stop/close 时也保留此核验入口，**只核验，不重跑 Core**。

SQLite 与外部世界没有联合事务：结果保存失败意味着前置 prepared/called 已提交但结果未提交，重启后必须待核验。文件匹配只证明当前文件状态；人类可误判，任意外部状态仍无恰好一次保证。

## 7. 持久化健康与第一次原子起点

DesktopPersistentSession 位于 Main 的 session-persistence.ts 或相邻文件，复用 desktop_documents 的 `session-state` 全快照。每次 appendMany 同步提交完整候选快照；成功后才 push 和通知。runtime 工作目录、完成子记录及必要 UI 更新使用同一写入入口。原始 events 只有一份，不建并行恢复日志或 task.status 字段。

任何 SQLite/序列化保存错误包装为 SessionPersistenceError，保留 cause。Loop、工具业务 catch、压缩回退直接传播；Main 设本会话 transient persistenceFailed 健康标记并停止当前及后续执行，不尝试新终态写入覆盖原错，不回退内存成功。仅已存在进程/连接的取消和关闭收尾继续，不启动新业务操作；关闭错误与原始保存错误分开报告。此标记是运行健康而非第二任务事实；重新打开应用后按磁盘已提交事实恢复。

健康标记保留第一次 SessionPersistenceError；失败之后 append/appendMany/commitStart/runtime 保存直接抛同一原错，不能再尝试 SQLite 或更新内存。即使控制器已经因用户取消而 abort、不能再替换 signal.reason，终态追加也被此权威入口阻止，原保存错误不会被另一个取消状态覆盖。

终端 onExit 的异步回调保存状态失败也走同一 Main 致命处理：记录原 SessionPersistenceError、标记健康失败并以该错误 abort 当前控制器；没有活动轮次也阻止后续执行。不能在 EventEmitter 回调吞错后继续。Loop 在取消检查/最终 catch 中优先传播 signal.reason 中的 SessionPersistenceError，不另写 turn.cancelled 掩盖保存错误；只做现有资源的取消收尾。

**一次事务绑定全部执行起点**：

1. Loop 导出纯 `prepareTurnStart(input,recovery?:{sourceTurnId,mode})`，使用现有 Node randomUUID 生成 turnId，返回 `{turnId,events:[turn.started,user.message,turn.recovery.started?]}`，不执行任何工具。
2. Desktop 在外部准备前构建现有 buildAgentPrompt 的同一完整输入，生成上述起点。Main 校验 IPC `{sessionId,prompt,userMessageId,assistantMessageId,clientState}` 对应两条新消息与附件，不依文字猜归属。
3. 专用 `DesktopPersistentSession.commitStart(start,clientState,turnMessageBinding)` 一次 SQLite 提交：完整新事件批、最新展示快照、两消息 ID 与 turnId 关联。关联记录增加 `executionVersion:1`，明确它是新检查点起点。事务失败，无任何外部执行；事务成功后才更新内存并进入宿主准备。没有先保存 processing 后另存 turn.started 的窗口。
4. 原 `runTurn` 用同一 prepareTurnStart + appendMany，然后调用 `runStartedTurn(agent,turnId,options)`；Desktop 的 agent-task.ts 直接消费已经开始的 Turn，不能再次追加 started/user。runStartedTurn 检查它是最新已开始、无终态、尚未有模型 Step 的轮次；现有单前台任务规则阻止重复启动。

Renderer 快照只保存展示与草稿；saveClientState 从 Main 当前 Session/runtime 拼出存储，不能覆盖原事件或把真实终态降回 processing。加载和保存前都按权威投影修正消息、产物、计划。已提交最终 assistant/turn.completed 而 Renderer 未收到时，从 Session 补回结果，不重复执行。

## 8. 宿主阶段、终态和插件最小兼容

Main 直接定义 operation 字符串 `prepare/session-start/prompt-submit/stop/close`；另有 `terminal-connection-lost` 只用于恢复时的旧终端来源不足观察，不执行外部操作。Session 只保存通用 operation 文本及来源配对，不理解插件事件协议。每次调用外部宿主阶段前 append host.operation.started，成功追加 result completed，失败/取消追加真实结果及原错。缺结果或失败/取消的阶段保守列为未知外部效果，可由同一 sourceEventIndex 核验。不能把宿主未知效果塞进另一个状态字段。

pendingSessionStart 仍是现有宿主待执行意图；真正开始 SessionStart 的事件和消费该意图在同一快照提交，成功后才调用。恢复不重放原 operation occurrence（操作记录实例，由事件索引唯一标识）。**显式 recoverTask 轮次不调用 SessionStart/UserPromptSubmit/Stop 生命周期钩子**，避免把旧启动或原提交命令当恢复步骤重跑；普通新用户轮次保持当前钩子行为。新剩余工具可按次审批并调用现有 wrapper；未解决效果时则连扩展 prepare 都不启动。已完成但未明的 Stop/close 只能独立核验。

Loop 独占自身 completed/failed/cancelled 终态；Main 只为尚未进入 Loop 的 prepare/启动/提交失败给无终态 Turn 追加终态。Core 终态之后的 Stop/close 失败只记录宿主错误，不能改 completed 为 failed。取消 Main 先记录原因，再 abort 一个 name='AbortError' 的真实 Error，使现有插件 signal.reason 路径仍收到 Error；Loop 从明确类型读 user/window-closed/external，不靠消息文案猜。窗口关闭仍沿用现有 cancel→等待→关闭→保存握手。

新宿主加载时，仅 executionVersion:1 的有起点、无终态轮次追加一次 process-exit；已经 completed 但宿主未结束，只保留宿主未知，不造另一个 Turn 终态。旧无关联/版本的事件不自动当进程崩溃；旧 UI failed/cancelled 照旧展示，原因缺失用 legacy-unknown，旧无法关联的轮次只做显式源选择，不能从文本推测消息映射。

与 probe-media-plugin 分支的具体不变量：

- 开始事务和未知效果门禁先于 prepareExtensions；blocked 时走安全读取模式。
- 正常未受阻轮次保留其真实顺序：prepareExtensions → 已授权 Probe → createVideoAgent 使用 extensions.wrapTool(probe) → 其他注册/包裹跳过 Probe。
- Probe 保持同一实例、只包裹一次，语义验收继续共享该实例；不改插件 runtime、hooks、资源、市场或视频验收实现。
- 计划/核验是宿主新增内部工具，包裹过程完成之后注册。预算计算在所有真实动态指令/工具/记忆组装结束后。
- 实施前重核该分支最新提交；重叠 Main 只在本分支做必要接入，不代替其合并或重写业务。
- 交付前另有 codex/ffmpeg-plugin 工作树继承 Probe 并继续修改 Main/媒体插件/CLI；同样完全排除其业务实现，只记录并在实施前重新核对入口及实际工具实例。主工作区测试不作为该未合并分支的验收。

## 9. 用户主动恢复与任务状态

`recoverTask({sessionId,sourceTurnId})` 只接受用户动作且无 activeTask；校验源属于本会话，是该根任务最新后继轮次，尚无另一恢复后继。现有单任务限制和已提交 recovery.started 共同拒绝双击/重复 IPC；旧失败卡不能在后续恢复成功后再次启动。

failed/cancelled/interrupted 可继续；若 Turn completed 但计划仍未完成，可新建关联轮次继续剩余步骤；有未知时用户可先核验或发起 mode=verify 的安全轮次，核验解除后依据原/最新 continue 状态及计划提供继续入口。verify 轮次 completed 不会把原失败工作完成，原目标无计划也能在 not-applied 后继续。Core completed 且所有计划完成、无未知的任务不给恢复入口。用户明确请求补充新工作走普通新 Turn，不能伪称恢复旧已完成执行。

新恢复输入由原目标、当前用户恢复动作及事实投影组成，不重发原工具 JSON 或旧 Promise/进程/审批。先持久化新的起点和 sourceTurnId，再运行；原成功结果可见，未完整 Step 成功事实不再被整个过滤掉。仍有会话级未知时，只能安全读取/核验；解除后由新模型调用决定剩余工作，并重新审批副作用。不得恢复旧终端进程；子任务仅保留完成结果/中断历史，不启动子恢复或可写子代理。

完成含义明确分层：Turn 的自然结束不是任务语义验收；有未知效果、未完成计划的 Task 保持 blocked。Client 显示原任务状态、恢复关联和证据，可对 completed Core 的宿主效果做核验，不出现无入口死锁。

## 10. 提交依赖与必须反证的验证

六阶段顺序保持：接口/文档 → Context → Plan → Failure → Task → 集成。所有阶段在同一隔离功能分支，前期接口不单独合入 main。第 4 阶段的同步 checkpoint 先用真实持久 Session 夹具验证，第 5 阶段接入 Main 全生产链；不能在未接持久化的产品上宣布第 4 阶段已有崩溃保证。

主报告的矩阵加上以下必测杀点：

- 第一次未保存草稿的 atomic start 成功/失败，恢复关联同批提交。
- 计划/核验/目录/子记录/checkpoint 保存失败，后续工具执行计数零；摘要保存失败不继续原投影。
- 同一响应第一写入 unknown 后第二写入被拒绝；普通新任务也不能绕过。
- opaque 请求被门禁/未知工具拒绝时没有新的未知效果；verify-only 自动核验解除后工具集不变，无计划原失败工作仍能新建 continue。
- 已批准但审批取消在 prepared 前后分别分类；denied 同轮重发不再次审批。
- 真文件写入成功而 PostToolUse 失败：file-effect 匹配不清空 entire-call 阻塞。
- Core completed、Stop started 后强杀：完整结果保留、宿主核验入口存在、核验不重跑 Core。
- open/write_terminal success 已提交、持续写文件的命令仍运行、下一模型请求时强杀：重启先保存来源明确的 unresolved，原输入计数不增加，disconnected 不解除；正常 exited 已提交与状态保存失败分别反证。
- 原失败→恢复成功→旧源重复恢复/双 IPC 拒绝；无计划 completed 且 unknown 不被当任务完成。
- 旧 failed/cancelled 无 Core 终态不冒充 process-exit；同名 ToolCallId 跨轮正确归属。
- verified completed 后重复请求 error，无新成功结果、产物或计划证据。
- 两协议完整链、摘要覆盖集合/digest 重启一致、取消/模型失败/保存失败三条分支。
- 全快照在长历史下测实际保存/模型请求延迟；结果不达标先报告证据，再审查必要存储调整，不预建迁移框架。

人工核验、摘要语义和变化参数无法提供普遍正确性；全套自动测试、Windows 实进程/真实文件/SQLite 强杀以及真实供应商调用都是实施验收证据，未执行须 SKIP。
