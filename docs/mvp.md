# Agent Desktop MVP

## MVP Goal（MVP 目标）

MVP（最小可行版本）只验证一个完整、可解释、可自动测试的 Agent 执行闭环：

```text
User Input       用户输入
     │
     ▼
Agent            智能体
     │
     ▼
Agent Loop       智能体循环
     │
     ▼
Model            模型
     │
     ▼
Tool Call        工具调用
     │
     ▼
Tool Execution   工具执行
     │
     ▼
Tool Result      工具结果
     │
     ▼
Model            模型继续处理
     │
     ▼
Final Answer     最终回答
```

全过程必须记录进入 Session（会话）。Session 是这次执行发生过的事实来源，而不是只保留最后一条聊天消息。

## MVP Scenario（MVP 场景）

第一版使用一个非常小的 Echo Agent（回声智能体）场景验证闭环。

用户输入：

```text
Use the echo tool to echo "hello".
```

预期过程：

1. 用户消息进入 Agent。
2. Agent Loop 构建模型输入。
3. Model 返回一个 echo Tool Call（工具调用）。
4. Tool Registry（工具注册表）找到 echo 工具。
5. echo 工具执行并返回 `hello`。
6. Tool Result（工具结果）被记录到 Session。
7. Agent Loop 再次调用 Model。
8. Model 根据工具结果生成最终回答。
9. Turn（轮次）正常结束。

重点不是 Echo 功能本身，而是证明以下闭环成立：

```text
Model  →  Tool  →  Result  →  Model
模型      工具      结果       模型
```

## MVP Scope（MVP 范围）

MVP 必须包含以下能力：

```text
English term                  中文术语            说明
Model abstraction             模型抽象            以稳定接口表达模型请求和响应
In-memory Session             内存会话            在内存中保存一次执行的事实
Append-only Session Events    只追加会话事件      通过追加新事件表达新事实
System Prompt                 系统提示词          组装基础 Agent 指令
Tool definition               工具定义            描述一个可调用能力
Tool Registry                 工具注册表          保存并查找当前 Agent 可调用的工具
Agent                         智能体              持有一次运行中的 Agent 实例状态
Agent Loop                    智能体循环          驱动模型调用、工具调用和继续执行
Turn                          轮次                表示一次用户任务的完整生命周期
Step                          步骤                表示 Turn 内的一次模型调用阶段
Echo Tool                     Echo 工具           提供最小可验证的回声能力
Mock/Fake Model               模拟模型            在测试中返回预设模型响应
Runnable Echo Agent           可运行回声智能体    跑通完整 Echo 闭环
Automated tests               自动化测试          验证核心行为和失败边界
```

第一版允许使用 Mock/Fake Model（模拟模型），不要求接入真实在线模型 API。真实 Model Provider（模型提供商）属于 MVP 之后的工作。

## Explicit Non-Goals（明确不做）

以下能力不属于 MVP：

```text
Electron UI           Electron 用户界面
React UI              React 用户界面
Real Model Provider   真实模型提供商
File operations       文件操作
Shell                 命令行操作
Git                   Git 操作
SQLite                SQLite 持久化
JSONL persistence     JSONL 持久化
Skills                技能系统
Context injection     上下文注入
Permission system      权限系统
MCP                   MCP 集成
LSP                   LSP 集成
SubAgent               子智能体
Workflow               工作流
Compaction             上下文压缩
Memory                 长期记忆
Remote runtime        远程运行时
Sandbox                沙箱
```

这些能力未来可以增加，但不能反向扩大第一版 Core（核心）的职责边界。

## MVP Acceptance Criteria（MVP 验收标准）

1. 可以创建一个 Agent。
2. 可以向 Agent 发送一个用户输入。
3. Agent Loop 可以调用 Model。
4. Model 可以请求 Tool Call。
5. Tool Registry 可以找到并执行指定 Tool。
6. Tool Result 可以重新进入模型上下文。
7. Model 可以在下一 Step 产生最终回答。
8. Session 可以完整记录整个执行过程。
9. 一次 Turn 可以包含多个 Step。
10. 没有 Tool Call 时，Turn 可以正常结束。
11. Tool 不存在或执行失败时，Session 状态仍然可解释。
12. 核心行为必须有自动化测试。

MVP 成功的判断标准是闭环和事实记录成立，而不是支持的工具数量或 UI 完成度。
