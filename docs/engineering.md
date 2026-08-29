# Engineering Baseline

本文档是当前项目立即生效的工程技术基线。创建 package、修改 TypeScript 配置、引入依赖或修改 workspace 前，必须先遵守本文档。

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
@agent-desktop/example-echo-agent      Echo Agent 示例
@agent-desktop/example-deepseek-agent  DeepSeek Agent 示例
@agent-desktop/example-ffmpeg-agent    FFmpeg Agent 示例
```

六个 Core package 当前都是 private ESM package，只暴露 `.` 根入口，对应 `src/index.ts`。`@agent-desktop/model-deepseek` 是具体模型 Provider package，`@agent-desktop/video-ffmpeg` 是具体 FFmpeg Tool package，`@agent-desktop/vision-openai` 是具体视觉 Tool package，三者都不属于 Agent Core；三个 example package 是可运行示例，同样不属于 Agent Core。

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

当前依赖以各 package 的 `package.json` 和源码 imports 为准：`tools` 依赖 `model`，`session` 依赖 `model`，`agent` 依赖 `model`、`session`、`system-prompt` 和 `tools`，`agent-loop` 依赖 `agent`、`model` 和 `session`，`model-deepseek` 依赖 `model`，`video-ffmpeg` 和 `vision-openai` 依赖 `model`、`tools`，三个 example 只依赖各自实际使用的 package。

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
