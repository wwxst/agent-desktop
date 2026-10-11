# 通用智能体核心能力实施验收

2026-10-11，批准方案为 [D4 最小设计](../design/general-agent-core.md)。三轮独立方案审查通过后，用户明确确认开始实施；本记录只把实际执行的验证记为通过。

```text
Implementation          实施              在隔离功能分支逐阶段交付批准的能力。
Independent Review      独立审查          根据实际代码发现问题并核验修正。
PASS                    通过              实际执行并通过的检查或链路。
SKIP                    未执行            缺少环境或尚未实施，不表示通过。
```

## 基线与范围

基线 `main` 为 `49b8da974cc963f7068abb04423bed9628a8f6ae`，隔离工作树使用 `feature/general-agent-core`。主工作区原有 `.workbuddy-ai/`、媒体插件迁移计划、`html.zip` 和 `html/` 未改动。重新核对了 `feature/probe-media-plugin` 的 `6c29b2e` 及 `codex/ffmpeg-plugin` 的 `92901e9` 和其未提交修改；两条分支的插件、媒体与 CLI 业务不纳入本次修改或验收。

本次运行环境为 Windows、Node.js `24.20.0`、pnpm `11.22.0`；CI 固定的 Node.js `24.19.0` 尚未在本工作树执行，不能称为完全同环境验证。

## 阶段 1：架构与执行契约

会话增加只追加的批量保存契约、执行终态、恢复祖先关联、计划/压缩/检查点/宿主及核验事件和纯状态投影。循环使用统一的纯起点，支持执行已提交起点，保留真实取消原因并致命传播保存错误。磁盘解析保留旧历史并校验新索引、来源和恢复顺序。模型/工具增加后续阶段需要的输出额度及失败/检查点字段，尚不代表已接入完整崩溃恢复。

独立审查发现并修正了起点诊断失败无终态、普通取消异常丢失真实原因、保存异常被模型诊断拦截、文本步骤跨版本完成证据丢失、未知效果被计划成功遮蔽，以及非法磁盘恢复关联可形成环的问题。对应路径均要求真实事件测试反证。

`pnpm install --frozen-lockfile` 和 `pnpm check`：PASS，60 个测试文件、722 项测试，19 个正式包架构门禁通过。完整日志在本工作树 `logs/general-agent-core/stage-1-check.log`；未把聚焦运行与全仓运行数量相加。两位独立审查者针对实际 Loop、Session 和磁盘解析复审均为 PASS，无剩余修改要求。真实 SQLite 测试已执行；本阶段没有更改真实模型协议、外部进程或 UI，因此这些新增能力的真实供应商、强杀恢复及视觉验收仍为 SKIP，留待消费者接入。

## 阶段 2：上下文预算与来源压缩

正式模型请求和摘要请求均使用所选模型的明确窗口/输出额度；缺少任一配置时不猜预算。压缩只覆盖完整步骤，保持工具协议完整，用户原文、计划和待核验事实独立保留。摘要校验精确覆盖范围、前摘要链和来源 SHA-256；失败不改原历史。

`pnpm install --frozen-lockfile`、最终 `pnpm check` 和 `pnpm desktop:build`：PASS，63 个测试文件、754 项测试、19 个包架构门禁通过。日志为 `logs/general-agent-core/stage-2-check.log` 与 `stage-2-build.log`。两位独立审查者核对实际 Context、Loop/Main 接线、供应商额度、磁盘解析后均无代码修改要求；SQLite 重启与两个协议的本地 HTTP 完整工具往返均 PASS。

真实 DeepSeek `deepseek-v4-flash`：PASS。每次请求额度覆盖实例默认值；8 额度请求真实截断并保留失败，64 额度请求正常完成。真实 Loop 压缩前估算 11124 超过输入预算 6977，压缩后 6879；摘要与正式请求各一次，输出额度均 2048，最终保留 `ALT-731` 与 `READ_ONLY`，原历史与来源校验通过，额外工具执行为零。证据在 `logs/general-agent-core/deepseek-output-cap.json` 和 `real-context-run.json`。

真实 Responses 供应商：SKIP，缺少 `OPENAI_API_KEY` 及可用的已保存供应商凭据。本地协议测试不冒充真实供应商验收；该外部合并条件仍未满足。当前估算不是服务端精确令牌数，来源完整性也不证明摘要语义准确。计划工具与展示、失败门禁、任务恢复、Windows 强杀和最终集成验收尚未完成。

## 阶段 3：任务计划与事实展示

`UpdatePlanTool` 位于现有 `tools` package，直接依赖 Session 事件并使用 Desktop 注入的唯一事实资格回调。复杂任务可创建或更新最多 32 步计划；步骤 ID、描述和版本保持稳定，工具结果、整调用核验或最终文本事实分别按完成类型确认。计划工具自身、失败结果、未知外部效果、终端输入/启动及未通过视频候选验收不能确认业务完成。当前任务存在计划时，模型会看到带来源索引和资格标签的紧凑证据目录；没有计划的普通对话不增加目录。

共享 Client 展示宿主投影的计划版本、步骤状态和短证据，不提供模型可修改的 UI 操作，也不为简单任务渲染空计划。Session、Loop、Desktop 和 Client 的事实边界测试覆盖计划版本、恢复链、跨轮同名调用 ID、非法证据、候选资格和 UI 投影。

阶段独立审查：Core/Tools、Context/Loop、Desktop/Client 三个范围均 PASS，无剩余修正要求。`pnpm check`：PASS，66 个测试文件、779 项测试、19 个包架构门禁通过；`pnpm install --frozen-lockfile`：PASS；相关聚焦测试 66 项 PASS。计划工具、UI 和资格回调未修改插件运行时或视频工具实现。失败恢复、任务恢复、真实 Windows 计划交互和最终联调尚未完成。

## 阶段 4：失败分类与副作用检查点

Loop 在每个 Tool Call 前保存调用事实，并把工具声明的 `checkpointed` 边界与同步 `tool.effect.prepared` 事件写入同一 Session；文件创建、文件编辑、命令启动和持久终端启动/输入/关闭均在真实副作用前检查点。检查点保存失败会直接阻止副作用。工具错误保留 `permanent`、`denied` 和 `unknown-outcome` 等供应商无关分类，命令非零/超时按结果未知处理，拒绝不重试。模型只对明确的临时服务错误最多追加两次请求，工具调用不会重放。

阶段独立审查：Agent Loop、local-tools、terminal-host 和 model 契约复核 PASS；检查点顺序、取消传播、拒绝分类和非零命令未知结果均有聚焦测试，新增全仓总计 66 个测试文件、780 项测试，`pnpm check` PASS。持久 SQLite 保存健康、失败后的停止策略、恢复入口与崩溃验收留待阶段 5；当前检查点在 InMemory Session 的核心链路已验证，不能提前宣称应用崩溃恢复完成。
