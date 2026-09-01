# Knowledge Continuity（知识连续性）

本 reference 规定治理信息放在哪里，避免 AGENTS、docs、Decision、Postmortem、Handoff、Tests 和 Skill 同时维护同一份完整事实。

## Canonical Ownership（权威归属）

```text
Artifact                  真相类型                   当前职责
AGENTS.md                 Permanent rules 永久规则   项目使命、阶段边界、强制工程和代码规范
docs/architecture.md      Current Truth 当前事实    组件职责、依赖方向、运行时不变量和明确非目标
docs/engineering.md       Current Truth 当前事实    Toolchain、workspace、Feature Branch、Gate 和合并条件
docs/defensive-patterns   Confirmed rules 已确认规则 真实缺陷边界和不得重复的防御模式
README.md                 Product status 产品状态  当前能力、运行命令、环境要求和用户可见说明
Decision / ADR / Agent Note Decision 决定记录      为什么在多个可行方案中选择当前设计
Postmortem                Failure history 事故复盘 以前发生什么、原因和防止重现的措施
Handoff                   Work state 任务交接      当前任务做到哪里、剩余动作和阻塞，不定义永久真相
Tests / Gates             Executable Memory 可执行记忆 可重复验证的行为、边界和机械规则
Skill references          Execution guide 执行指南 如何检查、实施、验证和导航上述来源
logs/                     Raw evidence 原始证据     命令输出或历史运行记录，不自动升级为当前事实
```

## 写入规则

- 永久强规则写入 `AGENTS.md`，不要只写在 Skill 或聊天中。
- 当前架构、依赖、工具链和运行入口写入对应 `docs` 或 README；Skill 只保留执行时必须知道的导航和最小边界。
- 设计取舍写 Decision/ADR，并在需要时从 Current Truth 链接过去；不要把“为什么”散落在多个实现注释中。
- 真实事故或接近事故形成可复核的 Postmortem，再把稳定的防止规则提炼进 `docs/defensive-patterns.md`；不要把一次性日志直接写成通用规则。
- 测试和 Gate 只编码能稳定、重复验证的行为；它们可以是 Executable Memory，但不替代业务文档，也不凭空创造生产消费者。
- Handoff 只描述工作状态；任务完成后过期内容应归档或删除，不得让它与 Current Truth 冲突。

## One Fact, One Home

同一个事实只保留一个权威实现或文档位置。其他位置只写短导航、ID、命令或结果，不复制完整列表和规则。发现冲突时：

1. 先以真实源码、package manifest、测试输出和实际入口确认 Current Reality。
2. 决定该事实的 canonical owner；必要时修正 owner，再让引用方变成导航。
3. 同步直接受影响的测试、Gate、README 和 Skill，删除旧表述，不保留两种“都可能正确”的说法。

项目当前特别需要避免的漂移包括：

```text
Drift risk                         检查方式
Commit 14 是否已合并              git branch/log 与 AGENTS 状态对照
OPENAI_API_KEY 是否启动即必需      对照 ffmpeg-agent 的实际环境检查与 Tool 调用
FFmpeg 工具数量与编辑能力数量      对照注册列表、package exports 和 README 文字
计划/日志是否被当作当前架构        明确 docs/superpowers/plans 与 logs 不是 Current Truth
execution-trace 当前状态            对照当前 package graph、生产 imports 和 `ffmpeg-agent` 的本地 JSONL 输出
```

## 沉淀检查

结束一次治理工作前，确认：

```text
Question                         判断
What changed?                    事实写入正确 owner，且 README/测试/Gate 只保留必要引用
Why this design?                 取舍有 Decision 或现有规则来源
What failed before?              已确认事故才进入 Postmortem/defensive patterns
What remains in this task?       Handoff 明确剩余动作，不伪装成已完成
What can be rerun?               Tests/Gates/real command 给出精确命令和结果
```

若没有新的稳定事实，不新增文档、Decision、测试或 Skill 段落；“完整”不是治理目标，清晰且无漂移才是。
