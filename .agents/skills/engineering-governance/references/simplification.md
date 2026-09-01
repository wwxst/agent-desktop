# Simplification（简化审查）

本 reference 吸收原 `find-simplifications` 的长期职责，负责证据驱动的删除、简化、验证层选择和范围控制。默认只 Review，不修改；只有用户明确要求处理、修复、清理或实施时才改代码。

## 范围与入口

默认审查本次修改涉及的模块、直接调用链和验证暴露的问题。全仓库 Review 只有用户明确要求时才执行；开始时列范围，发现第一个 Finding 后仍完成声明范围，满足停止条件就停止，不重复扫描制造噪声。

审查前阅读根 `AGENTS.md`、`docs/architecture.md`、`docs/engineering.md` 和 `docs/defensive-patterns.md`。对 Agent Desktop，优先沿 `example → runTurn → Agent → Model/Session/Registry/SystemPrompt → Tool` 追踪，而不是按文件大小或抽象数量猜测复杂度。

## Consumer Evidence（消费者证据）

准备删除或简化 `type`、`interface`、method、field、config、helper、package、fallback、validation 或 test-only behavior 前：

1. 用 `rg` 搜索精确符号、字符串键、exports、注册点、环境变量和调用形式。
2. 阅读所有命中位置，确认静态调用之外的运行时注册、CLI 组装、配置和公共入口。
3. 分类当前消费者；没有完成分类不得提出删除。

```text
Consumer class           当前含义
Production Consumer      `packages/*/src`、真实 CLI 入口、配置和运行时注册
Test Consumer             `tests`、测试 fixture、fake 或 spy
Documentation Consumer   README、docs、注释和 Skill
Ambiguous Consumer       `examples/*/src`；先确认它是可运行产品入口还是仅示例
```

测试、README、docs 和注释不是生产消费者。所有 package 当前 `private: true`，不存在已发布外部 API 的默认假设；仍需检查仓库内所有 example、脚本和配置。

## 删除安全边界

未覆盖代码、难测试代码和暂时没有静态调用只能是 Review signal，不能单独作为删除依据。删除前必须确认：

```text
Evidence                    必须确认
Real call chain             真实调用方和上下游结果是否仍存在
Runtime registration        Registry、CLI、动态加载或初始化是否引用
Configuration               环境变量、脚本、路径和 package manifest 是否引用
Public API                  exports、类型契约和当前仓库消费者是否依赖
Business consumer           当前视频 Agent 是否仍需要该行为
```

只有以上路径均无用途，且删除会减少实现、状态、公共表面或维护负担，才形成删除 Finding。`0.x` 内部边界错误优先直接修正，不保留无消费者兼容层。

有充分证据时，以下是强简化候选：无生产消费者的公共 API、仅测试或文档消费且非关键行为的 API、重复事实或规则、未来扩展接缝、理论异常 fallback、单一实现却建立的 Factory/Strategy/Adapter、只搬运复杂度的包装层、默认值掩盖的第三方错误，以及已删除功能遗留的兼容代码。以下理由本身不是候选：文件或行数多、风格不统一、真实生产消费者存在、已确认防御规则没有新证据推翻，或只产生无关 churn。

发现手写 parser、retry、glob 或其他基础设施时，先检查 Node builtin（Node 内置能力）和现有成熟依赖是否覆盖实际语义。只有依赖能带来明显净删除，且维护状态、语义覆盖和残留胶水都可接受时，才考虑替换；否则继续使用更短的现有实现。

## Coverage 处理顺序

Coverage 只用于发现未知风险，不用于追求数字：

```text
Uncovered Code
      ↓
Why does it exist?
      ↓
Needed now?
   ┌──┴──┐
  No    Yes
  ↓      ↓
Delete  meaningful test when behavior matters
```

如果行为没有当前生产价值，删除实现及其专用测试；如果行为服务当前调用链且行为重要，增加描述行为的最小测试。测试只能证明行为存在，不能证明行为正确或制造生产消费者。未覆盖本身不要求 100% Gate，难测试本身也不证明应删除。

## 信任边界与防御性编程

`docs/defensive-patterns.md` 记录本项目真实发生或接近发生的缺陷，修改外部解析、进程调用、异常和生命周期前必须遵守：

```text
Boundary                  Project rule
Same-process TypeScript    信任已由类型保证的数据，不为理论异常增加 fallback
User/Model/Tool JSON       只校验当前真正消费的字段
HTTP/config/file/process   在真实边界做必要校验，不跨层重复校验
Malformed external data    当前依赖结构缺失直接失败，不用默认值伪装成功
Program error              非契约错误继续向上暴露，不转换成模糊成功
```

不要为理论并发、低概率异常或“更稳”主动加入锁、重试、补偿、状态机、Lease、复杂事务或通用框架。对 FFmpeg 等副作用操作，未经真实瞬态故障、幂等性和可解释 Session 语义证实，不新增通用 Retry；若将来证据成立，先把重试归属到具体 Provider 或 Tool 边界，不放进 Agent Loop 或 Manager。

## 抽象与新机制审查

单一实现不自动需要 Factory、Strategy、Registry、Adapter、Manager、Runner、Wrapper、Plugin、Hook 或 Event Bus。若提出新 Gate、测试、脚本、依赖或基础设施，先回答：

```text
Question             问题                 Required answer
Current problem      当前真实问题           哪个已观察故障或维护成本需要它
Current rule         当前工程规则           它落实哪条 AGENTS、Architecture 或 Engineering 规则
Validation loss      删除代价               删除它会失去什么可重复证据
Production consumer  生产消费者             哪条真实调用链会使用它
```

无法回答时明确“不实施”。如果复杂度只是搬进新的 Wrapper、Manager、Factory 或文件，净复杂度没有下降；使用现有 package script、Node、TypeScript、Vitest 或真实入口即可解决时，不创建新框架。

## Net Deletion 与 Finding

```text
Net deletion = deleted implementation + deleted dedicated tests + deleted dedicated docs
               - new glue code - new dependency cost - new public surface
```

只因文件长、行数多、风格不统一或静态扫描看起来复杂，不构成 Finding。有生产消费者、关键行为或 `docs/defensive-patterns.md` 已确认的真实边界时，不得仅凭审美删除。

每个 Finding 至少包含：

```text
Location             文件和位置
Current behavior     当前行为
Consumer evidence    生产、测试、文档和待确认消费者证据
Complexity cost      为什么新增复杂度或重复事实
Smallest treatment   最小处理方式
```

没有证据就不报 Finding；若动态消费者、配置或注册仍无法确认，记录不确定性并保持 Review 状态，不把“没搜到”写成“肯定没有”。Review 达到以下状态后停止并输出 `Governance Review PASS`：无无消费者公共表面、无重复事实/规则、无仅测试支撑的理论防御、无当前需求扩展接缝、无掩盖错误的 fallback、无重大文档或实现冲突。
