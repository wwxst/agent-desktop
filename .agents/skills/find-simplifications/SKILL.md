---
name: find-simplifications
description: 按 Agent Desktop 最小实现规范进行证据驱动的 Review，查找过度设计、防御式编程漂移、重复事实、无生产消费者 API 和未来兼容层。
---

# Find Simplifications（查找简化机会）

本 Skill 用于审查 Agent Desktop 的真实复杂度。核心原则是证据优先、少而确定、拒绝猜测。

## Required Context（必读上下文）

每次执行前完整阅读：

```text
AGENTS.md
docs/architecture.md
docs/engineering.md
docs/defensive-patterns.md
```

先理解当前产品目标、架构边界、工程基线和已经真实发生的缺陷类别，再审查代码。

## Review Mode（审查模式）

默认只 Review（审查）并输出 Findings（问题发现），不修改代码。

只有用户明确要求“处理”“修复”“清理”或“实施”时才允许修改。修改只覆盖证据充分的 Finding，并同步处理直接相关的测试和文档；保持最小 diff，不顺手重构。

## Consumer Evidence（消费者证据）

准备删除或简化任何 `type`、`interface`、method（方法）、field（字段）、config（配置）、helper（辅助函数）、package（包）、fallback（兜底）、validation（校验）或 test-only behavior（仅测试行为）前，先使用 `rg` 搜索精确符号、字符串键和调用形式，再阅读调用位置。

把消费者分为：

```text
Production Consumer     生产代码消费者    packages/*/src 默认属于此类；实际运行脚本和配置也属于此类
Test Consumer           测试消费者        tests 和测试夹具
Documentation Consumer  文档消费者        README、docs、注释和 Skill
Ambiguous Consumer      待确认消费者      examples/*/src，必须根据真实运行用途再分类
```

测试、README、docs 和注释不是生产消费者。`examples/*/src` 不自动算生产消费者；先检查 README、根 scripts、package references、当前产品入口和真实用途，再归类为 Production 或 Non-production。

没有完成消费者分类，不得提出删除或简化。

## Strong Candidates（强简化候选）

以下情况在证据充分时属于强候选：

- 没有 Production Consumer（生产代码消费者）的公共 API。
- 只有测试或文档使用、且不是关键行为的 API。
- 同一个事实存在两个类型、字段或权威实现。
- 为未来需求存在的接口、字段、配置或扩展接缝。
- 为理论异常存在的 fallback、rollback（回滚）、validator（校验器）或专门测试。
- 单一实现却建立 Factory、Strategy、Registry 或 Adapter。
- 包装层只搬运复杂度，没有减少代码、状态或公共表面。
- 第三方异常数据通过默认值伪装成成功。
- 已删除功能遗留的兼容代码或死代码。

## Hand-rolled Infrastructure（手写基础设施审查）

如果发现手写的 parser（解析器）、retry（重试）、glob（文件匹配）或其他基础设施，先检查 Node builtin（Node 内置能力）和成熟依赖是否能覆盖实际语义。

优先使用 Node builtin。只有引入成熟依赖能够产生明显净删除时，才把依赖替换列为候选；继续遵守“不新增无必要依赖”。

按以下公式计算净复杂度：

```text
Net deletion = 删除的实现 + 删除的专用测试 + 删除的专用文档
               - 新增 glue（胶水代码） - 新增依赖成本
```

如果净复杂度没有明显下降，或依赖只把复杂度搬到新的 Wrapper、Adapter 或配置中，拒绝该候选。检查依赖的维护状态、实际语义覆盖和残留胶水后再列 Finding。

## Rejected Candidates（必须拒绝的候选）

以下理由本身不能证明需要简化：

- 只是觉得文件太长、代码不够漂亮或行数太多。
- 只是为了统一目录、命名或风格。
- 存在真实生产消费者，删除会改变产品功能。
- 规则来自 `docs/defensive-patterns.md` 已记录的真实问题，且没有新证据推翻它。
- 重构造成大量无关 churn（改动噪音），却没有减少真实复杂度。

800 行文件本身不是问题。只有证明存在职责混乱、真实修改困难、重复状态、重复规则或不合理依赖时，才能提出拆分。

## Trust Boundary Review（信任边界审查）

审查每个 validator、fallback、defensive copy（防御性复制）、`try/catch` 和 default value（默认值）时，先回答数据来自哪里。

来自同进程 TypeScript 强类型调用的数据，默认不需要额外防御。

来自用户、LLM 或 Tool JSON、HTTP、配置、文件、FFmpeg、ffprobe、进程、环境变量或网络的数据属于真实边界，可以进行当前业务实际需要的校验，但不得跨层重复校验。

## Tests Describe Behavior（测试描述行为）

测试只能证明当前行为存在，不能证明当前行为正确。

发现生产代码没有真实价值、测试是唯一消费者时，应删除或修改行为，并删除或修改对应测试。不得因为“已有测试”强行保留错误行为或过度设计。

## Evidence Before Simplification（简化前需要证据）

按以下顺序审查每个候选：

1. 用 `rg` 搜索精确符号、字符串和调用形式。
2. 按 Production、Test、Documentation 分类全部消费者。
3. 阅读生产调用位置，确认该表面是否承载当前视频剪辑需求。
4. 检查是否与现有类型、状态、规则或事实重复。
5. 检查删除后是否真正减少代码、状态、公共 API 或调用链。
6. 如果复杂度只是被搬到新的 Wrapper、Manager、Factory 或文件中，拒绝该候选。
7. 如果证据不足，不列 Finding。

## Repository-wide Coverage（全仓库范围覆盖）

Repository-wide Review（全仓库审查）必须先完整覆盖用户声明的审查范围一次，才能根据 Stop Condition 输出 `Governance Review PASS`。

开始时列出范围清单并逐项检查。优先检查近期生产代码增量较大、生命周期或外部边界逻辑较集中的区域；Review 要广，Finding 要少。

发现第一个 Finding 后，继续完成剩余范围审查，不得提前结束。完成一轮范围覆盖并满足 Stop Condition 后立即停止，不为了继续寻找问题反复扫描。

## Review Findings（审查结果）

默认按 `P1`、`P2`、`P3` 排序输出。每个 Finding 必须包含：

```text
文件和位置
当前行为
Production Consumer 证据
Test/Docs Consumer 证据
为什么增加复杂度
最小处理方案
```

没有证据就不列 Finding。宁可报告 3 个强问题，不要报告 20 个猜测。

## Stop Condition（停止条件）

Review 达到以下状态后必须停止继续清理：

```text
无生产消费者公共表面              0
重复事实 / 重复规则                0
仅测试支撑的理论防御行为            0
无当前需求的扩展接缝                0
明显掩盖程序错误的 fallback          0
重大文档 / 实现冲突                 0
```

达到后输出：

```text
Governance Review PASS
```

不要为了继续寻找问题而无限 Review。
