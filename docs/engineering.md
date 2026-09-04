# Engineering Baseline

本文档是当前项目立即生效的工程技术基线。创建 package、修改 TypeScript 配置、引入依赖或修改 workspace 前，必须先遵守本文档。

## Complexity, Evidence, and Decision（复杂度、证据与决策）

这是项目的最高工程原则：不是追求最少代码，也不是追求最专业架构，而是要求每一份复杂度都有当前理由，每一个关键行为都有验证证据，每一个重要决策都有唯一出处。

```text
Complexity  复杂度  只有在当前需求、边界或验证要求明确支撑时才引入
Evidence    证据    关键行为必须有可复现的测试、检查或真实链路结果
Decision    决策    重要取舍必须记录唯一来源，避免同一规则在多处重复定义
```

## Runtime（运行时）

Node.js 24.19.0 LTS 是正式运行时基线。Node.js 26 允许开发测试；Node.js 27 及以上版本暂不声明兼容。

## Package Manager（包管理器）

项目使用 pnpm workspace（pnpm 工作区）。当前根项目固定使用 pnpm 11.22.0，并提交 `pnpm-workspace.yaml` 和 `pnpm-lock.yaml`。Workspace 包含 `packages/*` 和 `examples/*`。

## Language（开发语言）

项目使用 TypeScript 7.0.x。当前根开发依赖固定为 TypeScript 7.0.2。

## Module System（模块系统）

所有 package 使用 ESM（ECMAScript 模块），TypeScript 模块解析使用 NodeNext。Core package 不使用 CommonJS。

## Package Layout（包布局）

目录职责如下：

```text
Directory   中文名称       职责
packages/   正式模块目录   保存 Agent Core、具体 Provider 与具体 Tool 模块
examples/   可运行示例目录 保存消费正式模块公共 API 的示例，不属于 Agent Core
```

核心 package 使用以下结构：

```text
packages/<package-name>/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts
└── tests/
```

Echo Agent 示例使用以下结构：

```text
examples/echo-agent/
├── package.json
├── tsconfig.json
├── src/
│   ├── echo.ts
│   └── index.ts
└── tests/
    └── echo-agent.test.ts
```

DeepSeek Agent 示例使用以下结构：

```text
examples/deepseek-agent/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

FFmpeg Agent 示例使用以下结构：

```text
examples/ffmpeg-agent/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

`tests/` 只有在真正有测试时才创建，不为了目录完整创建空目录。

## Package Naming（包命名）

公开 workspace package 统一使用 `@agent-desktop/*` 命名空间：

```text
@agent-desktop/model                   模型包
@agent-desktop/session                 会话包
@agent-desktop/system-prompt           系统提示词包
@agent-desktop/tools                   工具包
@agent-desktop/agent                   智能体包
@agent-desktop/agent-loop              智能体循环包
@agent-desktop/model-deepseek          DeepSeek 模型适配器包
@agent-desktop/video-ffmpeg            FFmpeg 视频工具包
@agent-desktop/vision-openai           Vision 视觉工具包
@agent-desktop/speech-whisper-cpp      whisper.cpp 本地语音时间轴工具包
@agent-desktop/example-echo-agent      Echo Agent 示例
@agent-desktop/example-deepseek-agent  DeepSeek Agent 示例
@agent-desktop/example-ffmpeg-agent    FFmpeg Agent 示例
```

六个 Core package 当前都是 private ESM package，只暴露 `.` 根入口，对应 `src/index.ts`。Agent Loop 只暴露最小 Trace 回调契约；`ffmpeg-agent` 在自身 `src/trace.ts` 中把运行诊断事件写入本地 JSONL，不属于 Agent Core。`@agent-desktop/model-deepseek` 是具体模型 Provider package，`@agent-desktop/video-ffmpeg` 是具体 FFmpeg Tool package，`@agent-desktop/vision-openai` 是具体视觉 Tool package，`@agent-desktop/speech-whisper-cpp` 是具体本地语音转录与段落时间轴 Tool package，四者也不属于 Agent Core；三个 example package 是可运行示例，同样不属于 Agent Core。

## Source Rules（源码规则）

源码只放在 `src/`，测试只放在 `tests/`，不要把测试混入 `src/`。每个 workspace project 使用 Project References（项目引用）接入根 `tsconfig.json`。

## Dependency Rules（依赖规则）

依赖方向遵守 [`docs/architecture.md`](./architecture.md) 已定义的架构边界：

```text
底层 package 不能反向依赖高层 Agent Loop。
Core package 不依赖 Electron。
Core package 不依赖 React。
Core package 不依赖具体模型厂商 SDK。
具体 Tool implementation 不能侵入 Agent Loop。
examples 可以依赖 Core package，Core package 不能反向依赖 examples。
具体 Provider 可以依赖 model，Core package 不能反向依赖具体 Provider。
具体 Tool package 可以依赖 tools，Core package 不能反向依赖具体 Tool package。
```

当前依赖以各 package 的 `package.json` 和源码 imports 为准：`tools` 依赖 `model`，`session` 依赖 `model`，`agent` 依赖 `model`、`session`、`system-prompt` 和 `tools`，`agent-loop` 依赖 `agent`、`model` 和 `session`，`model-deepseek` 依赖 `model`，`video-ffmpeg`、`vision-openai` 和 `speech-whisper-cpp` 依赖 `model`、`tools`，三个 example 只依赖各自实际使用的 package。

package 依赖必须反映当前真实源码引用，不能因为以后可能需要而提前创建。

## TypeScript Configuration（TypeScript 配置）

根 `tsconfig.json` 是 Solution Config（解决方案配置），使用 `files: []` 并通过 Project References（项目引用）显式引用当前所有 workspace TypeScript projects，不把整个 monorepo 粗暴 include 成一个巨大 TypeScript Program。

`tsconfig.base.json` 保持 strict（严格模式）并启用当前有明确收益的选项：

```text
strict
noUncheckedIndexedAccess
exactOptionalPropertyTypes
noImplicitOverride
noFallthroughCasesInSwitch
forceConsistentCasingInFileNames
isolatedModules
verbatimModuleSyntax
```

Project References 使用 `composite`。根 `pnpm typecheck` 通过 `tsc -b` 验证 package graph（包依赖图）。

## Feature Branch Workflow（功能分支工作流）

从 Commit 14 开始，所有新增能力禁止直接在 `main` 开发。完整流程如下：

```text
main
  │
  ▼
feature/<short-name>
  │
  ▼
Design → Implementation → Automated Validation → Review → Real Verification
设计     实现             自动化验证              审查     真实验证
  │
  ▼
commit and push feature branch
提交并推送功能分支
  │
  ▼
merge feature branch → main
合并功能分支到主分支
  │
  ▼
tag (milestone)
里程碑完成后创建标签
```

Feature Branch（功能分支）统一使用 `feature/<short-name>` 命名，`short-name` 必须简短并能表达当前能力。

```text
Valid branch name                  有效分支名称
feature/video-understanding        视频理解
feature/agent-trace                智能体执行追踪
feature/batch-editing              批量剪辑

Invalid branch name                无效分支名称
test                               无明确含义
tmp                                无明确含义
fix123                             无明确含义
new                                无明确含义
```

### Step 1 Design（设计）

开发前必须明确以下内容：

```text
Goal             目标        本阶段要交付的真实结果
Problem          问题        当前要解决的具体问题
Impact scope     影响范围    允许修改的模块、接口和行为
Non-goals        不做什么    本阶段明确排除的能力
```

除非当前需求已经证明确实需要，否则不得引入未来抽象、Plugin Runtime（插件运行时）、Provider Factory（供应商工厂）、Manager（管理器）或 Framework（框架）。

### Step 2 Implementation（实现）

只实现当前需求，保持最小改动，不污染 Agent Core（智能体核心），不重复已有能力，不增加无生产消费者 API（应用程序编程接口）。

### Step 3 Automated Validation（自动化验证）

每个功能阶段必须执行以下统一门禁：

```text
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 是本地机械检查的唯一入口，依次执行 `pnpm typecheck`、`pnpm typecheck:tests`、`pnpm test`、`pnpm check:architecture` 和 `git diff --check`。CI 在准备相同版本的 Node.js 与 pnpm 后执行同一入口，并额外使用 GitHub 事件的基线提交到当前 `HEAD` 执行 `git diff --check`；新分支没有有效基线提交时检查空树到当前 `HEAD`，确保干净检出中的已提交差异也进入补丁格式检查。

### Architecture Gate（架构门禁）

`pnpm check:architecture` 使用 Node.js 和仓库已有的 TypeScript 词法扫描器读取各正式 workspace package 的 `src/` 与 `tests/` imports，并与 `package.json` 声明对照。它只自动检查能够稳定判断的边界：

```text
Rule                         规则                         检查内容
Declared imports             声明与引用                   src 和 tests 引用的 workspace package 必须在 package.json 声明；未被静态引用的声明只作为 Review 信号
Core UI boundary             核心与 UI 边界                 Core package 不得依赖 React、React DOM 或 Electron
Provider boundary            Provider 边界                  Core package 不得依赖具体 Model Provider 或 Tool implementation
Example direction            示例依赖方向                 packages 不得反向依赖 examples
Package boundary             package 边界                   只有包含 package.json 的目录进入当前 workspace 检查
```

Session、Turn、Step、Tool Result、异常传播和 Agent 与 Agent Loop 的行为不变量继续由 `tests/` 与 Review 验证；脚本不对无法可靠静态判断的行为做假检查。

### Validation Scope（验证范围）

五层验证体系是分类模型，不是每次变更都必须完成的清单。只实施当前有真实需求、稳定基础和合理收益支撑的层；没有对应问题的建议明确记为不实施。

```text
Review signal             审查信号       未覆盖代码、难测试代码或暂时无静态调用只能触发审查，不能单独作为删除依据
Deletion evidence         删除证据       删除前必须确认真实调用链、运行时注册、配置引用、公共 API 和当前业务消费者均无用途
Review scope              审查范围       Simplification Review 只覆盖本次修改模块、直接调用链和本次验证暴露的问题
Reuse first               优先复用       新 Gate、测试脚本和 CI 优先复用现有脚本、TypeScript、Vitest 和 Node 能力
Real verification         真实验证       只整理已有稳定入口；缺少本机依赖或凭据时明确 FAIL/SKIP，不把跳过伪装成 PASS
```

这套边界不改变 `AGENTS.md` 的强规则；本文件只定义验证层选择、工程 Gate 和审查范围。

当前验证层适用性如下：

```text
Static / Architecture Gate       已实施       `pnpm check:architecture` 检查稳定的依赖与 import 边界
Unit / Contract / Integration    已具备       现有 Vitest 测试覆盖 Runtime 和 Tool 的关键行为，`pnpm typecheck:tests` 检查测试类型
Expected Output / Build Smoke    不实施       `tsc -b` 已由 typecheck 覆盖，当前没有独立发布或消费者构建流程
Real E2E                         已有入口     复用 `pnpm deepseek-agent` 和 `pnpm ffmpeg-agent` 的真实执行方式
```

### Step 4 Review（审查）

每个 Commit 完成后，必须基于实际变更进行 Review，不能用“代码看过”或“测试通过”代替。至少检查以下内容：

#### Architecture（架构）

* 是否修改 Core？
* 是否产生重复职责？
* 是否增加未来扩展接缝？
* 是否引入当前需求不需要的抽象、层次或依赖？
* 是否违反现有架构边界？

#### Code（代码）

* 是否存在防御式编程？
* 是否存在默认值掩盖错误？
* 是否存在无生产消费者代码？
* 是否存在不必要的复杂度、重复逻辑或无效封装？
* 是否正确处理错误、边界条件和资源生命周期？
* 是否符合 [`docs/defensive-patterns.md`](./defensive-patterns.md)？

#### Tests（测试）

* 测试是否描述真实行为？
* 是否为了测试制造不存在的契约？
* 是否覆盖本次变更的关键路径和失败路径？
* 是否存在只验证实现细节、没有验证实际行为的测试？

#### Documentation（文档）

* 是否和实际实现一致？
* 是否需要同步更新架构、工程流程或使用说明？
* 是否存在过时、含糊或相互矛盾的描述？

#### Simplification（简化）

* 是否可以用更简单的实现完成当前需求？
* 是否存在可以删除的代码、配置、依赖或抽象？
* 是否符合 [`.agents/skills/engineering-governance/SKILL.md`](../.agents/skills/engineering-governance/SKILL.md) 及其简化审查 reference？

Review 必须明确记录：

```text
Review:
- Findings:
- Required changes:
- Decision: PASS / CHANGES_REQUIRED
```

发现问题后，必须先修复并重新执行 Automated Validation（自动化验证）和 Review。只有 `Decision: PASS` 后才能进入合并流程。

### Step 5 Real Verification（真实验证）

变更涉及 FFmpeg、Whisper、Vision 或 Model API（模型接口）时，必须运行真实链路，不能只报告 `tests passed`。

```text
Real chain       真实链路    实际经过的模型、工具和外部运行时
Input            输入        真实使用的任务和媒体输入
Output           输出        工具结果、模型结果或生成文件
Result           结果        是否通过以及可核对的证据
```

当前可重复执行的真实入口如下：

```text
pnpm deepseek-agent   DeepSeek 真实模型链路       需要 DEEPSEEK_API_KEY，交互式输入任务
pnpm ffmpeg-agent     完整视频 Agent 链路         入口启动需 DEEPSEEK_API_KEY、WHISPER_MODEL_PATH；执行对应 Tool 需 ffmpeg、ffprobe、whisper-cli，视觉调用时另需 OPENAI_API_KEY
```

当前没有独立的 FFmpeg-only、Whisper-only、Vision-only 或完整 E2E 非交互命令；这些能力在现有 `ffmpeg-agent` 入口中组合验证。入口启动时缺少其必需环境变量会以非零状态退出；外部二进制、模型或 Vision Key 在 Tool 执行边界暴露失败。对承诺存在环境的专用验证任务，缺配置必须 FAIL；本地未执行的真实链路可以 SKIP，但不能将跳过伪装为通过。

无法执行真实验证时，必须明确说明原因、未验证范围和风险，不得将 Real Verification 标记为通过。

### Step 6 Merge Main（合并主分支）

只有以下条件全部满足，才允许把 Feature Branch 合并到 `main`：

```text
Gate                         Required result
pnpm check                   PASS
Review                       PASS
Real Verification            PASS（仅涉及真实外部链路时要求）
```

合并方式为 `merge feature branch → main`。只有 milestone（里程碑）完成后才创建 tag（标签）。

### Commit Report（提交汇报）

每个 Commit 完成后必须按以下格式汇报：

```text
Commit:
Message:

Changed:

Validation:

Review:
- Findings:
- Required changes:
- Decision:

Real verification:

Main status:
```

任一自动化验证、Review 或必要的真实验证未通过时，不得合并到 `main`，不得进入下一阶段；必须先修复并重新执行完整流程。

## Test Runner（测试框架）

项目使用 Vitest 4.1.11。当前已有 Agent Runtime 和 FFmpeg Tool 行为测试，`pnpm test` 运行现有测试套件。

## Dependencies（依赖）

根开发依赖保持最小：

```text
Dependency       Version   用途
typescript       7.0.2     TypeScript 编译器和 Project References
vitest           4.1.11    测试运行器
@types/node      24.13.3   Node.js 类型声明
```

不引入 ESLint、Prettier、bundler、Electron、React、模型供应商 SDK、第三方 FFmpeg SDK、Tool schema library 或 Agent Framework。

## 0.x Policy（0.x 策略）

项目仍处于 `0.x`。发现 package 边界、命名或 TypeScript 配置错误时，优先直接修正；不要为了尚未发布的内部 API 创建兼容层。

## Engineering Invariants（工程不变量）

```text
ENG-001  Workspace dependencies reflect real imports.
         工作区依赖必须反映真实源码引用。
ENG-002  Core packages remain UI-independent.
         核心 package 与 UI 无关。
ENG-003  Provider-specific SDKs cannot enter core packages.
         具体模型供应商 SDK 不得进入核心 package。
ENG-004  The root TypeScript config represents the project-reference graph.
         根 TypeScript 配置代表 Project Reference 依赖图。
ENG-005  Empty architectural shells are not created for future features.
         不为未来功能提前创建空壳模块。
```
