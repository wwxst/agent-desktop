# 第五阶段候选开发规范整合与兼容审查

本轮候选为 `codex/phase5-policy-integration`，独立工作树为 `C:/Users/ww/.codex/worktrees/phase5-policy/agent-desktop`。最新开发规范已经引入，当前版本的安全、持久化及现有工程门禁继续保留；真实云 Vision（视觉分析）和 Responses（响应协议）仍为 `SKIP`，阻塞 `main` 合并。

## 基线与提交来源

2026-10-14 以远端实际引用核对：

```text
Candidate        集成候选        codex/phase5-integration，932652585ce5b616e4a62454ab8591a2c4b033b5。
Main             主分支          9c1a002015925070ba8274b4c20a986acf06fcea，已不同于旧验收报告的 49b8da9。
Policy           开发规范        codex/development-policy，195219fcf33f8d8bae544e0d047f61325893abe4，当时未推送。
Common Ancestor  共同祖先        49b8da974cc963f7068abb04423bed9628a8f6ae。
```

原候选、规范、Vision 和通用核心工作树均干净。主工作树保留原未跟踪的 `.workbuddy-ai/`、`docs/superpowers/plans/2026-10-11-probe-media-plugin-migration-plan.md`、`html.zip`、`html/`。本轮未清理其他分支或工作树，未删除用户文件。

两个规范提交完整差异仅涉及根规范、工程文档及工程治理指引。规范分支包含共同祖先之后额外的模型设置和界面历史，所以不合并整条分支；以 `git cherry-pick -x` 独立应用两个提交，无冲突：

```text
bfaa62a95a9b0740bbdd096524105a26d811e172 → d08b2438694ed3944d73d8ff77fab1a5448e705d
195219fcf33f8d8bae544e0d047f61325893abe4 → b1fbc121311c67a8e6562f69e03776a6beb74e0d
```

`9326525` 是本轮候选祖先。`git range-diff bfaa62a^..195219f 9326525..b1fbc12` 仅显示来源追踪说明及候选已有上下文差异，没有额外引入主分支功能。

## 规范一致性

权威规则位于 [根 AGENTS](../../AGENTS.md)，工程门禁位于 [工程规范](../engineering.md)。工程治理入口、简化、验证和桌面真实验收指引均引用这一口径：只处理当前明确需求，除任务明确要求外不新增测试，不因覆盖率自动扩建测试，保留必需错误处理、安全边界、异常传播、有效测试及现有 CI（持续集成）。

已取消默认要求：旧程序、API、Session、SQLite、配置和插件协议兼容；旧数据升级或读取；旧程序读取新数据；跨版本数据回滚；为历史兼容保留双实现或额外抽象。必要重设计不受旧接口必须先无调用的限制，但删除无用途代码仍需实际证据。

[架构文档](../architecture.md) 中尚存兼容路径是实现事实，不是继续维持兼容的门禁。旧 [第五阶段验收报告](phase5-integration-20261012.md) 顶部已限定历史范围，保留原 C3（安装升级与回滚专项）运行证据，取消其作为当前默认兼容要求的含义。旧技能指引中视频任务前提、已实现功能仍被列为非目标、安装脚本允许列表重复维护等直接矛盾已经修正。

当前规则之间未发现未解决的冲突。没有新增依赖、公共接口、配置项或兼容框架，未重构 Agent Core（智能体核心）、Session（会话）、插件系统或用户界面。

相对 `9326525` 的实际修改文件如下；新增文件仅为本报告：

```text
AGENTS.md
docs/engineering.md
docs/architecture.md
docs/acceptance/phase5-integration-20261012.md
docs/acceptance/phase5-policy-integration-20261014.md
.agents/skills/engineering-governance/SKILL.md
.agents/skills/engineering-governance/references/project-rules.md
.agents/skills/engineering-governance/references/simplification.md
.agents/skills/engineering-governance/references/verification.md
.agents/skills/engineering-governance/references/desktop-real-acceptance.md
apps/desktop/src/main/runtime-settings.ts
apps/desktop/tests/runtime-settings.test.ts
apps/desktop/tests/desktop-database.test.ts
```

## 历史兼容实现分类

```text
A Current Business       当前业务        当前功能、安全或事务仍需要，保留。
B Obsolete Compatibility 过时兼容        只服务旧契约；仅处理证据明确且改动很小的分支。
C Uncertain Scope        范围待确认      存在入口或安全影响，保持现状，不猜测性删除。
```

A 类保留：

- `desktop-database.ts` 的当前表创建和事务回滚，以及 `session-persistence.ts` 的先持久化后推进内存。
- `safe-storage.ts` 的系统主密钥落盘等待；当前版本强退后恢复需要这一顺序。
- `.codex-plugin/plugin.json` 读取：四个当前内置插件均使用此格式，变量名含 `legacy` 不构成删除证据。
- 插件暂存发布、失败恢复及用户版本回滚：现有 IPC（进程间通信）和界面均有真实消费者，这是当前安装事务和产品能力。
- Desktop（桌面端）的统一插件注入、禁用或卸载后不提供内置媒体绕过；CLI（命令行入口）的显式本机工具仍是正常入口。
- 内存运行配置的 `deepSeekApiKey`、`deepSeekBaseUrl`、`visionApiKey` 等字段仍由主任务、子智能体、插件与命令行消费。

B 类最小删除：

- `runtime-settings.ts` 移除旧磁盘 `deepSeekBaseUrl/deepSeekModel/visionBaseUrl` 向供应商目录转换，以及旧独立 `deepSeekApiKey/visionApiKey` 向密钥目录转换。当前保存端和客户端只产生 `modelProviders/providerApiKeys`，约八行分支移除；环境变量、当前目录校验、加密、选择和事务不变。
- `runtime-settings.test.ts` 仅删除一个专门保证旧 SQLite 配置与密钥迁移的废弃用例。`desktop-database.test.ts` 原有导入及损坏数据保护用例，仅替换受影响的旧配置夹具，事务失败、数据库权威性与原文件保留检查继续执行。没有新增测试文件或用例。

其余 B 类只记录：旧工具活动 `tools/toolsExpanded`、旧产物 `outputFilePaths/outputFileName`、旧视频附件 `selectedVideos/selectedVideoPaths` 解析，以及无当前生成方的 `legacy-unknown` 原因。它们涉及 Session 解析或核心契约，超过本轮小范围删除约束，不做清理。

C 类保持：JSON（结构化文本格式）到 SQLite 导入仍有启动注册；终端历史匹配及无来源宿主观察涉及未知副作用恢复；旧 `ffmpeg-probe` 拒启动规则涉及防止绕过授权；无任务绑定时仍需保持合法空会话与历史展示。安装器保留用户数据、更新前保存与收尾属于用户文件保护，没有发现生产实现要求旧安装程序读取新数据。没有发现独立的 SQLite 版本迁移链。

## 已有验证与审查

本地 Node.js 为 `24.20.0`，pnpm 为 `11.22.0`；CI 继续使用仓库规定的 Node.js `24.19.0`，以远端实际作业为准，不把本地结果当成完全相同运行时证据。

```text
Check                          结果        可核对证据
pnpm install --frozen-lockfile PASS        453 个包复用本机存储，锁文件未改。
Existing focused regression   PASS        runtime-settings 与 desktop-database，2 个文件、24 个用例。
pnpm check                    PASS        85 个测试文件、975 个测试；生产和测试类型检查通过。
pnpm check:architecture        PASS        19 个正式工作区包，另单独执行。
pnpm desktop:build             PASS        三插件、主进程、预加载和渲染产物构建完成。
git diff --check               PASS        未提交差异及最终已提交差异分别核对。
Real Cloud Vision             SKIP        缺少获授权测试凭据，不发送伪造请求。
Real Cloud Responses          SKIP        缺少获授权测试凭据，本机协议夹具不是云验收。
```

全量测试较原候选的 976 个减少一个，正是上述废弃旧配置迁移用例；有效当前功能用例和全部 CI 步骤保留。旧解析或迁移测试没有为了通过门禁而整组删除。

两项独立只读审查分别核对兼容消费者与最小删除、规范一致性与云门禁。发现架构仍描述旧供应商字段转换，已同步修正；复核结论及准确最终候选的 Windows（微软桌面系统）、Ubuntu（Linux 系统发行版）CI 作业结果随最终交付记录。本机日志保留于 `logs/phase5-policy/`，未把任何密钥写入源码、提交或日志。

## 剩余主分支合并条件

真实云 Vision 与 Responses 两项必须取得获授权凭据并完成真实验收，当前保持明确阻塞，不将 `SKIP` 改为 `PASS`。准确最终候选还须通过 Windows、Ubuntu CI，随后再审查已前进 `main` 的需求与实现增量。本轮仅推送独立候选，未合并 `main`、发布版本或创建标签。

当前仍必须保证新版本自身功能正确、事务完整、加密与授权安全、持久化往返、关闭及重启恢复、异常与未知效果准确传播。取消历史兼容不取消这些安全与验收要求。公开发布的签名、全新环境及线上升级门禁继续与本轮候选整合分开处理。

本报告所在提交及远端准确 HEAD 由 `git log --oneline 9326525..HEAD` 和最终交付消息核对。远端 CI 记录保留完整提交摘要和作业 URL（网络地址），不以旧提交通过代替本轮最终提交。
