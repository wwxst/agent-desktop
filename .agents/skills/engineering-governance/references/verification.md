# Verification（验证）

本 reference 描述当前仓库真实可执行的验证能力。它不把五层或多层验证模型变成每次变更的清单；只选择能够回答当前风险的问题的层。

## 机械 Gate

代码、测试、package、脚本或 CI 变更完成后，使用根 package script 的唯一入口：

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 依次执行：

```text
Command                    作用
pnpm typecheck             tsc -b，验证生产 Project References 和类型边界
pnpm typecheck:tests       独立 noEmit 检查全部测试 TypeScript
pnpm test                  Vitest 全部测试
pnpm check:architecture    Node + TypeScript scanner 的稳定依赖边界检查
git diff --check           空白和补丁格式检查
```

CI 使用 Node.js `24.19.0`、pnpm `11.22.0`，安装锁文件后执行同一 `pnpm check`。本地运行时版本低于声明基线时要在结果中说明；不要把不同运行时下的结果描述成 CI 等价证据。

Architecture Gate 当前检查：真实 `src/` 和 `tests/` imports 必须在 package manifest 声明；Core 不得依赖 React、React DOM、Electron、具体 Provider 或具体 Tool；packages 不得依赖 examples；只有包含 `package.json` 的目录进入扫描。未被静态引用的声明只是 Review signal，不是删除证据。脚本不假装判断运行时注册、生命周期、业务顺序或外部服务结果。

## 自动化测试边界

当前测试覆盖 13 个测试文件、92 个测试（数量是本轮盘点快照，修改后以命令输出为准），集中在 `packages/*/tests` 和 `examples/*/tests`。

测试应优先组合真实内部组件：`runTurn`、`Agent`、`InMemorySession`、`InMemoryToolRegistry` 和真实 Tool 类保持不替换；只在真实外部边界替换：

```text
Boundary                  Test substitution                 Keep real
Model                     deterministic fake Model          runTurn、Session、Registry
HTTP                      local fetch stub                  Provider request mapping
Process                   injected CommandExecutor          Tool input/output contract
Filesystem                temporary fixture or controlled IO  boundary behavior and cleanup
```

不要为了 Mock 方便改变生产接口、加入 DI Container、Factory 或额外的测试专用抽象。测试描述当前行为，不自动证明行为有生产价值；若行为应删除，测试也应随行为删除或改写。

现有关键行为证据包括：Turn/Step 生命周期、多个 Tool Call 的顺序、未知 Tool、Tool Error、Model failure、Session 重建、结果 JSON 序列化、FFmpeg 参数和失败、ffprobe 异常结构、Vision 响应解析、Whisper JSON 时间轴。

## 真实外部能力

涉及下列边界时，必须判断是否需要 Real Verification（真实验证），并记录真实输入、实际组件、输出和可核对结果：

```text
Capability                  真实边界与入口
DeepSeek Model              `model-deepseek` 原生 fetch；`pnpm deepseek-agent`
OpenAI Vision               `vision-openai` Responses API；由 `ffmpeg-agent` 的 `analyze_images` 调用
FFmpeg / ffprobe            `video-ffmpeg` 通过 `execFile` 调用 PATH 中的 `ffmpeg`、`ffprobe`
whisper.cpp                 `speech-whisper-cpp` 调用 `whisper-cli` 或 `WHISPER_CLI_PATH`，读取 JSON timeline
```

当前两个真实执行入口：

```text
Command                 Required environment                                             Scope
pnpm deepseek-agent     DEEPSEEK_API_KEY                                                  DeepSeek + Echo Tool 闭环
pnpm ffmpeg-agent       DEEPSEEK_API_KEY、WHISPER_MODEL_PATH             完整视频 Agent；执行对应 Tool 需 ffmpeg、ffprobe、whisper-cli，视觉调用时还需 OPENAI_API_KEY
```

`OPENAI_BASE_URL` 可选；`ffmpeg-agent` 启动时只强制检查 DeepSeek Key 和 Whisper model path，Vision Tool 在实际调用时检查 `OPENAI_API_KEY`。`WHISPER_CLI_PATH` 可替代默认 PATH 命令。CLI 是交互式入口，以 `/exit` 结束；当前没有独立的 FFmpeg-only、Whisper-only、Vision-only 或非交互通用 E2E 命令。

真实视频链路按现有 System Prompt 组合 `probe_media`、抽帧/视觉、`extract_audio`/`transcribe_audio`、`trim_video` 和 `concat_videos` 等内部组件。视觉模型只观察，剪辑决定由 Agent 根据 Tool Result 作出；采样时间戳是近似证据，边界不确定时继续缩小范围。

## SKIP、FAIL 与 False Green

- 本地缺少非启动必需的 API Key、媒体、二进制或 Whisper model 时，可以把未执行的 Real Verification 标记为 `SKIP`，写明原因、未覆盖能力和风险；启动必需环境变量缺失时应记录入口的非零失败，不要把自动化测试通过写成真实链路通过。
- 如果本次变更确实触及需要真实外部链路的行为，`SKIP` 只能表示当前环境无法执行，不能作为合并或“已完成”结论；只有变更不涉及该外部能力时，Real Verification 才是不适用。
- 如果专用 CI 或验证脚本已经承诺这些环境存在，缺少配置、命令或模型必须 `FAIL` 并暴露原因，不能静默跳过。
- 外部命令返回非零、HTTP 非成功、响应结构缺失或 JSON 损坏都必须保留失败语义；不得用空对象、空数组、默认文本或成功状态制造 False Green。
- 真实验证只整理现有入口。没有稳定真实入口、fixture 或重复需求时，不为统一命名新建 E2E Framework。

## 验证选择

```text
Change                         Minimum evidence
Core/type/dependency           pnpm check + focused Review
Runtime behavior               pnpm check + relevant runTurn/Session/Tool tests
External adapter               pnpm check + boundary tests + applicable real entry
Docs or Skill only             git diff --check + skill validator/reading review
No current risk                Record “不实施”，不新增 Gate 或测试平台
```

报告必须区分 `PASS`、`SKIP` 和 `FAIL`，并给出命令、环境、输入、输出和未验证范围。
