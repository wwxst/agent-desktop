# Project Mission（项目使命）

开发独立、通用、可扩展的 Agent Client。

# Current Phase（当前阶段）

v0.0.2 Video Agent MVP 已完成并通过 Review。

当前 Agent 已具备：
- 真实 DeepSeek 推理
- FFmpeg 多步骤视频处理
- 视频抽帧与视觉理解
- 局部时间范围检查
- 基于视觉内容自主决定保留/删除片段
- 使用 trim + concat 生成最终视频

当前暂未进入下一开发阶段。

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

# Minimal Implementation Standard（最小实现规范）

只实现当前明确需求，不为假设场景或未来需求提前设计。

默认禁止无真实需求支撑的防御性编程、过度校验和提前抽象。

不主动增加锁、重试、补偿、兜底、状态机、Lease、复杂事务或通用框架。

校验只放在用户输入、权限、文件、第三方接口等真实边界；禁止跨层重复校验。

程序错误直接暴露，不吞异常，不用默认值掩盖问题。

不因单一实现、单一调用方额外新增接口、工厂、策略或扩展层。

能直接实现就直接实现，优先代码更少、调用链更短、状态更少的方案。

任何额外复杂度都必须能对应当前真实业务需求，否则不实现。

只修改当前需求直接相关的代码，禁止顺手重构无关模块。

不新增无必要的依赖、工具类、公共组件、配置项或数据库字段。

不为了“统一风格”改动已经正常工作的代码。

发现潜在风险时可以说明，但没有当前真实需求支撑，不得自行增加处理机制。

优先沿用现有项目结构，禁止因单个需求引入新的架构模式。

不为理论并发、极端边界或低概率异常提前增加复杂处理。

不新增没有当前消费者的接口、字段、方法和配置。

第三方数据只校验当前业务实际使用的字段，不做全量防御校验。

不保留“以后可能有用”的兼容代码、备用逻辑和死代码。

相同业务规则只保留一个权威实现，禁止多层重复判断。

修改完成后保持最小 diff，不做与当前需求无关的格式化、重命名和目录调整。

原则：用最少、最直接、最容易维护的代码完成当前需求。

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
