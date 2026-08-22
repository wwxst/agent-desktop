# Project Mission（项目使命）

开发独立、通用、可扩展的 Agent Client。

# Current Phase（当前阶段）

当前阶段为 Bootstrap（仓库初始化）。

本阶段没有 Agent Runtime。

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
