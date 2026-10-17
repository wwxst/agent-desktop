# Project Mission（项目使命）

开发通用智能体客户端：能理解任务、检查本地文件、调用工具并持续推进工作，以视频自动剪辑为重点应用场景。

视频剪辑是当前配置最完整、验证最充分的能力，继续保护其已有行为；但普通问答、文本任务和本地文件任务不以视频附件为执行前提。

Agent Core 保持通用。插件平台能力已进入当前里程碑，但新增抽象仍必须有 Desktop 真实消费者，不把插件协议泄漏到 Agent Core。

# 项目开发总原则

本项目当前处于开发阶段，允许破坏性重构。后续所有开发和审查以以下标准执行，不再将历史兼容性作为验收门禁。

1. 一切以最新确认的产品需求、架构设计和数据契约为准。
2. 不要求兼容旧版本程序、旧 API、旧 SQLite 数据、旧 Session、旧配置和旧插件协议。
3. 可以直接删除过时接口、字段、数据迁移、Fallback（兜底逻辑）和兼容适配层。
4. 需要重新设计模块时，优先选择长期合理、结构清晰的实现，不因历史代码限制新架构。
5. 不为了兼容旧版本引入双实现、重复逻辑和额外抽象。
6. 不要求新版本能读取旧用户数据，也不要求旧程序能读取新数据。
7. 仍必须保证新版本自身的功能正确、事务完整、执行安全和持久化可靠，并运行适用的已有测试。
8. 不得未经授权删除开发者工作树、未提交文件或真实用户数据。
9. 重构后应同步更新文档、测试和工程规范，删除过时断言。
10. 避免无目的的大规模重写。破坏性重构是允许的技术手段，不是必须执行的任务。

# Current Phase（当前阶段）

```text
English status                    中文状态                      说明
Video Agent MVP                   视频智能体最小可行版本        v0.0.2 已完成。
Local Speech Understanding MVP    本地语音理解最小可行版本      已通过真实 whisper.cpp 端到端验证。
Timeline-aware Understanding      带时间轴的视频内容理解        已通过真实 whisper.cpp 与 DeepSeek 端到端验证。
Agent Execution Trace MVP         智能体全链路执行日志最小版本  运行诊断事件写入本地 JSONL；真实成功/失败链路已验证。
Semantic Video Editing             语义视频剪辑              已完成单区间、多区间真实语义剪辑并合并 `main`。
Video Agent Application Layer      视频智能体应用层            已完成并合并 `main`，由 CLI 与 Desktop 共同复用。
Agent Desktop Shell                智能体桌面应用外壳          已完成并合并 `main`。
Multi-turn Agent Session           多轮智能体会话              Commit 20 已完成并合并 `main`。
New Session                        新会话                      Commit 21 已完成并合并 `main`。
Session List & Basic History       会话列表与基础历史          已完成并合并 `main`。
Runtime Settings                  运行时设置                  Commit 26 已完成并合并 `main`。
Turn Cancellation                 任务取消                    Commit 27 已完成并合并 `main`。
DeepSeek Streaming                DeepSeek 流式输出           Commit 28 已完成并合并 `main`。
Conversation Recovery             会话恢复                    Commit 29 已完成并合并 `main`。
Agent Activity & Close Handoff    活动轨迹与关闭收尾           Commit 30–36 已完成并合并 `main`。
General Agent Conversation        通用对话与任务推进           Commit 37 已完成并合并 `main`。
Session Working Directory         会话工作目录与目录授权        Commit 38 已完成。
Directory & File Discovery        目录与文件发现              Commit 39 已完成。
Text File Reading                 文本文件读取                Commit 40 已完成。
Text Content Search               文本内容搜索                Commit 41 已完成（ripgrep 由 `@vscode/ripgrep` 随包提供）。
Text File Creation                经审批创建文本文件          Commit 42 已完成。
Text File Editing                 经审批修改已有文本          Commit 43 已完成。
Execution User Questions           执行中提问并继续            已实现，问题答复继续同一轮。
Public Process Commentary          真实公开过程说明            已实现，不展示内部推理。
Bounded Model Retry                有限模型请求重试            已实现，不重放工具。
Read-only Subagents                受限只读子智能体            已实现，每轮最多两项、一层委派。
Session Persistent Terminal        会话持久终端                已实现，重启只恢复已断开的历史。
Semantic Candidate Acceptance      候选视频语义验收            已实现，逐帧预算与不可确认边界见架构文档。
Codex-style Plugin Runtime         Codex 风格插件运行时       已实现真实公开市场、完整清单、技能缓存与懒加载、版本更新回滚、原子安装、stdio/HTTP/SSE MCP、OAuth 和命令钩子，当前在功能分支；Codex 私有账号云同步及完整应用服务器协议边界见架构文档。
Local Project Sidebar              本地项目与会话侧栏          已实现项目分区、折叠、置顶、归档恢复与自动保存，当前在功能分支。
Desktop Probe Plugin              媒体探测插件试点            已完成独立 probe_media 的宿主授权、统一注入及真实 Windows 验收，当前在功能分支；其余 FFmpeg 能力保留，边界见架构文档。
```

当前 `@agent-desktop/execution-trace` 只负责把 Turn、Model 和 Tool 的执行状态与耗时持久化到本地 JSONL，由 `ffmpeg-agent` 与 Desktop 两个真实入口消费；Trace 不参与 Agent 推理。

Desktop 已支持多会话列表、切换、本地恢复和运行时设置。Commit 27 通过单个 AbortSignal（取消信号）取消当前 Turn，并保持原 InMemorySession 与已完成产物。

Commit 28 让 DeepSeek Provider 改用 SSE 流式响应，Model 文本增量经 Agent Loop 与现有 `desktop:agent-event` 通道实时到达 Shared Client；增量只用于展示，Session 仍然只保存完整 assistant 回复。

# Engineering Rules（工程规则）

* 不提前实现尚未进入当前 milestone 的功能。
* 不为了未来需求创建空壳架构。
* 避免循环依赖。
* 公共接口必须有明确职责。
* 核心行为使用已有测试验证；新增测试遵循本文最小实现规范。
* 改架构时同步更新文档。
* 修改 Desktop UI（桌面端用户界面）时，必须使用 [`.agents/skills/desktop-frontend/SKILL.md`](.agents/skills/desktop-frontend/SKILL.md)，并以 [`docs/desktop-ui.md`](docs/desktop-ui.md) 作为视觉行为的唯一文档来源。
* 插件与技能操作的加载状态和结果提示必须统一遵守 [`docs/desktop-ui.md`](docs/desktop-ui.md) 的强制反馈规范，不得因页面、操作入口或插件来源采用不同提示样式。
* 界面参考图和第三方界面只授权视觉对照；不得据此新增当前 milestone 未明确要求的控件、产品概念或功能。
* 创建 package、修改 TypeScript 配置、引入依赖或修改 workspace 前，必须遵守 [`docs/engineering.md`](docs/engineering.md) 工程基线。
* 面向人阅读的文档中，英文术语必须同时提供中文名称和简要说明；代码标识、文件名、命令、协议字段等技术原文可以保留英文。
* 概念说明必须使用固定宽度的 `text` 代码块：英文术语、中文术语和中文介绍分别作为三列，列之间只使用空格分隔，并确保中文术语和介绍的开头在上下各行从同一个固定显示列开始；不使用 Markdown 表格、`|` 分隔符、空行拆分或 `English（中文）：介绍` 的堆叠格式。
* 新增 package 前必须说明 package 的唯一职责。
* 不在 UI（用户界面）中实现 Agent Core（Agent 核心）逻辑。
* 不把模型供应商 SDK（软件开发工具包）泄漏到未来 Agent Core（Agent 核心）。
* 不把 Tool（工具）的具体实现耦合进 Agent Loop（Agent 循环）。
* 修改异常处理、进程调用、第三方数据解析或生命周期逻辑前，先阅读 [`docs/defensive-patterns.md`](docs/defensive-patterns.md)。
* 从 Commit 14 开始，新增能力禁止直接在 `main` 开发；必须遵守 [`docs/engineering.md`](docs/engineering.md) 定义的 Feature Branch（功能分支）、验证、Review（审查）和合并流程。
* 每次完成已授权的合并、提交和推送，确认本地 `main` 与远端一致后，必须自动清理本次任务已合并的本地及远端功能分支，无需再次询问。删除前确认各分支的全部提交已包含在远端 `main` 中，且分支未被任何工作树使用；保留 `main`、未合并分支和无关分支。分支清理不授权删除工作树、未提交文件或真实用户数据。

# Code Comment Standard（代码注释规范）

* 核心代码使用中文近逐行注释，重点说明代码“做什么、为什么”。
* 复杂 TypeScript 语法和架构原因必须解释。
* 简单语句无需机械注释。
* 注释必须与代码同步更新。

# Minimal Implementation Standard（最小实现规范）

* 只实现当前明确需求，保持最小改动。
* 不主动增加测试，除非任务明确要求。
* 不做无需求驱动的防御性编程。
* 禁止过度设计、过度抽象和提前兼容未来需求。
* 优先选择更少代码、更少层级、更直接的实现。
* 当前功能必需的错误处理、安全边界和异常传播仍需保留。
* 不删除当前功能仍需要的有效测试，不跳过现有 CI（持续集成）门禁。

核心原则：只解决现在的问题，不为假设中的未来写代码。

不为理论并发、极端边界或低概率异常主动增加锁、重试、补偿、兜底、状态机、Lease、复杂事务或通用框架。

信任同进程 TypeScript 强类型边界；静态类型已经保证的数据，不重复增加运行时校验、fallback 或敌意输入测试。

只在用户输入、模型或 Tool JSON、配置、文件、第三方 API、进程和网络等真实边界进行校验；只校验当前业务实际使用的字段，禁止全量防御校验和跨层重复校验。

程序错误直接暴露，不吞异常，不用默认值掩盖问题。

新的防御性规则必须来源于真实发生或接近发生的问题，不为假设 bug class 提前建立规则。

不因单一实现或单一调用方额外新增接口、工厂、策略或扩展层；能直接实现就直接实现，优先代码更少、调用链更短、状态更少的方案。

不新增没有当前生产消费者的接口、字段、方法和配置，不保留“以后可能有用”的兼容代码、备用逻辑和死代码。

测试描述当前行为，不代表当前行为一定正确；行为无价值、错误或属于过度设计时，应修改或删除行为及其测试，不得因“已有测试”强行保留。

简化和删除必须有生产代码证据，不得仅因为代码长、文件大或抽象看起来复杂就重构。

如果复杂度只是被搬到新的 Wrapper、Manager、Factory 或文件中，不算简化。

相同业务事实或规则只保留一个权威实现，禁止多层重复判断。

只修改当前需求直接相关的代码；在符合最新确认需求和架构的前提下沿用现有项目结构，不因历史结构阻碍必要重设计，也不顺手重构无关模块。

不新增无必要的依赖、工具类、公共组件、配置项或数据库字段。

修改完成后保持最小 diff，不为了“统一风格”改动正常代码，不做无关格式化、重命名和目录调整。
