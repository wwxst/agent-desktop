---
name: engineering-governance
description: Use when Codex changes, reviews, verifies, or records work in the Agent Desktop repository, including Agent Runtime boundaries, package dependencies, external model or media tools, tests and Gates, simplification, or project knowledge.
---

# Engineering Governance（工程治理）

本 Skill 是 Agent Desktop 的执行治理入口。它把通用工程治理方法裁剪为当前视频 Agent 项目的检查、实施、验证和知识沉淀流程；完整架构、永久规则、决定和事故记录仍由仓库中的 canonical owner（权威来源）负责。

## 适用范围

在以下工作前加载本 Skill：

- 修改 `packages/*`、`examples/*`、workspace 依赖或 TypeScript Project References（项目引用）。
- 修改 Agent、Agent Loop、Session、Model、Tool、Provider 或视频理解调用链。
- 修改 DeepSeek、OpenAI Vision、FFmpeg、ffprobe 或 whisper.cpp 外部边界。
- 增加、删除或调整测试、Gate、package script、CI 或真实验证步骤。
- 审查过度设计、无消费者代码、重复事实、防御性编程、未来兼容层或文档漂移。

仅回答与当前仓库无关的通用问题时，不加载本 Skill。

## Current Reality（当前现实）

项目处于 `0.x` 视频 Agent 阶段，当前重点是视频自动剪辑的可解释运行时。现有能力包括 Agent Runtime、Echo 示例、DeepSeek Provider、FFmpeg 编辑和抽帧、OpenAI Vision 画面观察、whisper.cpp 语音段落时间轴、Agent Execution Trace（智能体执行追踪）以及基于这些结果的多步和内容剪辑。Execution Trace 当前由 `ffmpeg-agent` 写入本地 JSONL，仅用于运行诊断。

每次工作先读根 `AGENTS.md`，并用 `rg --files -g AGENTS.md` 检查子目录规则；再按风险加载：

```text
Change risk              变更风险              Required reference
Package or boundary      包或边界              references/project-rules.md
Test, Gate, external run 测试、门禁、外部运行  references/verification.md
Delete or simplify       删除或简化              references/simplification.md
Docs, decision, handoff  文档、决定、交接        references/knowledge-continuity.md
```

## 执行流程

1. **建立 Current Truth（当前事实）**：阅读 `AGENTS.md`、相关 `docs/architecture.md`、`docs/engineering.md`、`docs/defensive-patterns.md`、README、package manifests（包清单）、源码、测试和 CI。不要把计划、日志或聊天结论当成当前实现。
2. **限定影响范围**：写下 Goal、Problem、Impact scope 和 Non-goals；沿真实 `example → runTurn → Agent → Model/Session/ToolRegistry/SystemPrompt → Tool → Session → next Model` 调用链确认受影响组件、注册、配置和消费者。
3. **判断风险与验证层**：根据 `references/verification.md` 选择现有 `pnpm check`、聚焦测试、架构 Gate 或真实入口。多层验证是风险分类模型，不是每次变更的完成清单。
4. **实施最小修改**：保持 Core、Provider、Tool 和 Example 边界；复用现有 script、Node、TypeScript、Vitest 和真实命令。没有当前故障或消费者的能力明确记为“不实施”。
5. **验证并 Review（审查）**：先运行自动化 Gate，再按 `references/simplification.md` 做范围受限的审查；发现问题后修复并重新验证。只凭测试通过、文件长度或静态搜不到不能宣布简化成功。
6. **沉淀唯一事实**：按 `references/knowledge-continuity.md` 更新最小必要的 canonical owner；同步直接受影响的文档、测试或 Gate，不在 Skill、AGENTS、docs 和测试中重复维护整份事实。

## 最高边界

- `AGENTS.md` 的永久强规则优先于本 Skill；`docs/architecture.md` 和 `docs/engineering.md` 是当前架构与工程基线。
- 删除前必须确认真实调用链、运行时注册、配置引用、公共 API 和当前消费者。未覆盖、难测试或没有静态调用只能触发 Review signal（审查信号）。
- Coverage 依次处理：`Uncovered Code → Why does it exist? → Needed now? → No: Delete → Yes: meaningful test when behavior matters`。
- 只在真实外部边界校验数据；信任同进程 TypeScript 类型，程序错误直接暴露，不用 fallback（兜底）或默认值伪装成功。
- 新 Gate、测试、脚本、Framework、Manager、Runner、Factory、Plugin Runtime、Retry 或兼容层必须证明当前真实价值；否则不实施。
- Real Verification（真实验证）优先复用现有 `pnpm deepseek-agent` 和 `pnpm ffmpeg-agent`。本地缺少依赖或凭据时明确 `SKIP`，但对本次确实要求真实链路的变更，`SKIP` 表示合并条件未完成；专用 CI 承诺环境却缺配置时 `FAIL`，禁止 False Green（假通过）。
- 遵循 `One Fact, One Home`、`One Rule, Smallest Applicable Scope` 和 `Canonical Ownership`；默认只审查本次修改及直接调用链，不借机清理全仓库历史代码。

## 按需加载

```text
Reference                 何时加载                              负责内容
project-rules.md          影响 package、依赖或运行时边界时      项目结构、调用链、不变量和非目标
verification.md           选择测试、Gate 或真实验证时            现有可执行证据、外部能力和 Skip/Fail
simplification.md         评估删除、抽象或防御代码时              消费者证据、Coverage 和简化停止条件
knowledge-continuity.md   更新文档、决定、事故或交接时            知识分类、唯一归属和沉淀方式
```

完成验证后按仓库工程流程汇报事实、命令、结果、未验证范围和主分支状态；不默认 push、merge 或创建发布物。
