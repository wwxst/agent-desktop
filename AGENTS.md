# Project Mission（项目使命）

开发独立、通用、可扩展的 Agent Client。

# Current Phase（当前阶段）

v0.0.1 Agent MVP（Agent 最小可行版本）已完成。

当前阶段为 Real Model Provider（真实模型接入）。

DeepSeek Provider（DeepSeek 模型适配器）已完成。

下一步尚未开始。

# Engineering Rules（工程规则）

* 不提前实现尚未进入当前 milestone 的功能。
* 不为了未来需求创建空壳架构。
* 避免循环依赖。
* 公共接口必须有明确职责。
* 核心行为需要测试。
* 改架构时同步更新文档。
* 创建 package、修改 TypeScript 配置、引入依赖或修改 workspace 前，必须遵守 [`docs/engineering.md`](docs/engineering.md) 工程基线。
* 面向人阅读的文档中，英文术语必须同时提供中文名称和简要说明；代码标识、文件名、命令、协议字段等技术原文可以保留英文。
* 概念说明必须使用固定宽度的 `text` 代码块：英文术语、中文术语和中文介绍分别作为三列，列之间只使用空格分隔，并确保中文术语和介绍的开头在上下各行从同一个固定显示列开始；不使用 Markdown 表格、`|` 分隔符、空行拆分或 `English（中文）：介绍` 的堆叠格式。
* 新增 package 前必须说明 package 的唯一职责。
* 不在 UI（用户界面）中实现 Agent Core（Agent 核心）逻辑。
* 不把模型供应商 SDK（软件开发工具包）泄漏到未来 Agent Core（Agent 核心）。
* 不把 Tool（工具）的具体实现耦合进 Agent Loop（Agent 循环）。
* `0.x` 阶段发现边界错误时优先直接修正，不保留废弃兼容层。

# Code Comment Standard（代码注释规范）

* 核心代码使用中文近逐行注释，重点说明代码“做什么、为什么”。
* 复杂 TypeScript 语法和架构原因必须解释。
* 简单语句无需机械注释。
* 注释必须与代码同步更新。

# Minimal Implementation Principle（最小实现原则）

以下是强制规范：

* 以最小、最直接、最精简的代码完成当前明确需求。
* 不主动增加测试代码，除非任务明确要求。
* 不为假设中的未来问题进行防御性编程。
* 不为尚未出现的场景增加兼容层、兜底逻辑、抽象层或扩展机制。
* 不提前设计未来可能需要的功能。
* 优先使用简单、直接、易理解的实现方式，避免过度封装和过度抽象。
* 只实现当前需求所必需的代码，并尽量保持最小改动范围。
* 对当前需求明确涉及的必要错误处理和输入边界正常处理，不得为了精简而破坏代码正确性。

**核心原则：只解决现在已经存在的问题，不为假设中的未来编写代码。**

# Development Sequence（开发顺序）

```text
1. Repository bootstrap（仓库初始化）
2. MVP and architecture specification（MVP 与架构说明）
3. TypeScript monorepo foundation（TypeScript 单仓库基础）
4. Core service interfaces（核心服务接口）
5. Minimal Agent Loop（最小 Agent 循环）
6. Runnable Echo Agent（可运行的 Echo Agent）
7. Review and tag v0.0.1-agent-mvp（评审并标记 v0.0.1-agent-mvp）
```

Agent 完成 MVP（最小可行版本）后，才考虑 File（文件）、Shell（命令行）、Persistence（持久化）、Context（上下文）、Permission（权限）、Skill（技能）和 UI（用户界面）。
