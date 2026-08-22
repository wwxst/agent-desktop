# Project（项目）

这是一个从零开发的通用 Agent Client。

# Current Status（当前状态）

项目处于非常早期的 `0.x` 开发阶段。

当前优先级是建立正确的 Agent Runtime 基础，而不是追求功能数量或 UI 完成度。

当前提交只完成仓库初始化和文档治理基础，不包含 Agent Runtime 实现。

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

项目已进入 TypeScript Monorepo Foundation（TypeScript 单仓库基础）阶段，采用 Node.js 24 LTS、pnpm workspace、TypeScript ESM 和 Vitest。当前只建立工程骨架，不代表 Agent Runtime 已实现。

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
