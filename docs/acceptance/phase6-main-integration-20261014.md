# 第六阶段：最新主线与第五阶段统一候选

本轮仅在 `codex/phase6-main-integration` 独立候选实施。主线界面与模型路由、第五阶段通用核心、三个媒体插件及开发规范已经汇合；工程验收结果在下文逐项记录。真实云 Vision（视觉模型）及 Responses（响应协议）尚无获授权测试凭据，保持 `SKIP`，最终 main 合并门禁为 `BLOCKED`，不能用本机协议服务替代。

```text
PASS       检查通过        已有可核对的实际执行或审查证据。
SKIP       尚未执行        缺少所需环境或该检查不适用，不能计为通过。
BLOCKED    合并受阻        必需外部验证没有完成，候选可以交付但不能宣称全部门禁通过。
```

## 版本、历史与保护范围

2026-10-14 拉取远端后核对：

- `main`、`origin/main`：`9c1a002015925070ba8274b4c20a986acf06fcea`。
- 第五阶段 `codex/phase5-policy-integration`：`5bc555062e51ee61d303d0c7092d6e75ea1396d7`。
- 共同祖先：`49b8da974cc963f7068abb04423bed9628a8f6ae`。
- 第六阶段工作树：`C:/Users/ww/.codex/worktrees/phase6-main-integration/agent-desktop`。

候选从准确 `origin/main` 创建，再以 `git merge --no-ff --no-commit 5bc5550` 合入第五阶段，保留两边有效历史。最终候选准确提交与远端相同提交的持续集成结果由本报告后续交付记录和 `git log --format=fuller codex/phase6-main-integration` 核对；不把未提交工作树的日志冒充另一提交的证据。

实施期间重新拉取后主线保持上述准确提交；双方均为最终候选祖先。基线持续集成分别为 [main 的已有失败](https://github.com/wwxst/agent-desktop/actions/runs/38492995054) 与 [第五阶段 Windows/Ubuntu 通过](https://github.com/wwxst/agent-desktop/actions/runs/38500529871)，不以基线结果代替本候选的验证。

原 main 未跟踪的 `.workbuddy-ai/`、`docs/superpowers/plans/2026-10-11-probe-media-plugin-migration-plan.md`、`html.zip`、`html/` 均保留。其他开发工作树和分支未清理；没有重写已推送历史、强制推送、修改 main、发布版本或删除用户数据。

## 主线新增成果与处理

共同祖先后的十个非合并提交均已核对，没有按分支名重复引入功能：

- `f6b0ea8`、`7c39f97`：统一扩展操作反馈及页面顶部位置。与第五阶段反馈能力重叠，保留主线有效表现，结合第五阶段插件模型管理动作。
- `c10a2a6`：输入区对话模型选择、四项模型能力、视觉路由、Web 设置契约。额外合入，并在 Desktop 的插件准备和任务启动快照中接入。
- `ee849ec`、`51ef5bc`、`f8e06f1`、`ae1dfae`：品牌图标、模型菜单宽度和紧凑布局、输入区模型选择归属。保留主线现有组件与样式。
- `de95315`：用户显式启用的备用视觉选择及简化设置。保留 `fallbackVisionModel/fallbackVisionEnabled`；它是当前产品功能，并非历史兼容兜底。
- `b398b9e`、`4329e91`：供应商删除及普通配置身份。保留，不恢复不可删除的特殊内置供应商。

主线在此区间没有新增另一套通用核心、执行宿主或任务恢复架构；这些能力沿第五阶段实际实现引入。没有遗漏已提交的输入区、模型配置或扩展管理成果。已废弃的旧独立视觉设置、旧字段转换不作为当前需求恢复。

## 实际冲突及解决

共 24 个文本冲突，均逐段处理，未整文件选择一方覆盖另一方。清单如下：

```text
README.md
apps/desktop/src/main/index.ts
apps/desktop/src/main/runtime-settings.ts
apps/desktop/tests/app.test.tsx
apps/desktop/tests/main-entry.test.ts
apps/desktop/tests/runtime-settings.test.ts
apps/web/src/webClientApi.ts
apps/web/tests/browser/desktop-extensions.pw.ts
apps/web/tests/web-client-api.test.ts
docs/architecture.md
docs/desktop-ui.md
packages/client/src/App.tsx
packages/client/src/api.ts
packages/client/src/components/ExtensionsPage.tsx
packages/client/src/components/RuntimeSettingsPanel.tsx
packages/client/src/components/SkillDialog.tsx
packages/client/src/styles.css
packages/client/tests/app.test.tsx
packages/client/tests/client-api.test.ts
packages/client/tests/extensions.test.tsx
packages/client/tests/model-settings.test.tsx
packages/video-agent/src/index.ts
packages/vision-openai/src/index.ts
packages/vision-openai/tests/vision-openai.test.ts
```

Desktop 主入口保留第五阶段当前任务请求、检查点、恢复与安全边界，接入主线模型预算和视觉路由。配置保留当前供应商目录、普通身份、备用模型与事务加密链；等待加密依赖后重新读取最新设置，再原子提交。旧平面设置、旧 `images` 能力转换、独立 `visionModel` 迁移、手动 Whisper 路径不恢复。

共享客户端保留主线输入区、品牌图标和模型设置，结合第五阶段项目侧栏、任务计划、恢复、插件管理及终态投影。Web、预加载和主进程统一当前请求契约。视频应用层仅接收注入的 `mediaTools/visionTool` 及当前视觉不可用原因，Desktop 不构造内置媒体回退；视觉协议继续支持本轮路由的协议和预算。

自动合并文件同样核对了生产消费者：核心、会话、工具审批、MCP（模型上下文协议）身份、取消、候选交付以及当前 SQLite（本地数据库）契约未被替换。三个独立媒体插件的公共工具为 FFmpeg 14 项、Whisper 1 项、Vision 1 项；视频技能独立安装，语义验收消费同一授权工具实例。

没有新增依赖、框架、公共抽象或测试场景。相对主线新增的大量代码和测试来自第五阶段已有提交。既有夹具仅同步当前模型能力、备用视觉、插件管理及 IPC（进程间通信）契约；废弃配置迁移断言删除，当前有效测试保留。

## 工程与真实验收

本机 Node.js `24.20.0`、pnpm `11.22.0`；远端持续集成使用仓库规定的 Node.js `24.19.0`。本地结果不描述为相同运行时的远端证据。

```text
corepack pnpm install --frozen-lockfile  PASS  锁文件和依赖一致。
pnpm check                             PASS  86 个文件、1014 项测试，生产与测试类型检查通过。
pnpm check:architecture                PASS  19 个工作区边界，另外独立运行。
pnpm desktop:build                     PASS  主进程、预加载、渲染层和三插件入口。
pnpm client:web:build                  PASS  Web 客户端生产构建。
pnpm desktop:package:win               PASS  Windows x64 NSIS 安装器。
git diff --check                       PASS  工作树和暂存差异。
pnpm client:web:test                   PASS  首轮 74 通过、18 跳过；两项失败均保留断言聚焦复验通过。
Windows / Ubuntu CI                    待补  必须核对最终准确候选提交。
```

首轮全量检查揭示旧模型能力及 Whisper 路径夹具与当前契约不符，已同步现有夹具。默认设置断言补上当前 `fallbackVisionEnabled: false`。Vision 缺密钥场景改为保存未启用的备用候选，保留工具不可见和零上传断言；没有弱化生产配置校验。构建环境缺少 Electron 已下载运行程序，复用既有工作树相同 `44.0.0` 的忽略依赖资源后打包通过，源码和锁文件未因此改动。

### 安装身份与数据隔离

最后重建的安装器 `apps/desktop/dist/installer/Agent-Desktop-Setup-0.0.2-x64.exe` 为 `127582028` 字节，SHA-256：

```text
baf2b88b469dd9d2324f8404c8142414111e3693e9ab95fe1ff003f817a5038b
```

安装到本候选 `logs/phase6-integration/最终 安装验收/`，NSIS 退出码 0，候选 8144 个文件。原 Vision 工作树安装的 8120 个文件逐一核对保持不变，应用注册键与快捷方式恢复并核对。没有覆盖真实应用安装或用户数据。保护结果见 `install-isolated-repaired.log`；此前 `322234…` 摘要仅属于上一轮安装器。

最后安装中的主进程、预加载桥、三插件入口/清单、MCP 清单及视频技能清单与当前构建逐一核对一致（`final-resource-hashes.json`）。相比先前验收安装，仅 Whisper 入口摘要改变；Core、FFmpeg、Vision 和渲染产物保持一致，所以保留先前对应真实入口的证据，同时对改变的 Whisper 入口重新执行完整专项。

Vision 首轮使用 `media-profile`；Whisper 最后复验使用独立新目录 `whisper-final-profile`，起始仅复制资源锁指定的 Whisper Small 模型：`487601967` 字节，SHA-256 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`；不带旧配置或会话。其他现有用例各自创建隔离配置目录。模型预置意味着网络模型下载项必须单独记录 `SKIP`，不伪称本轮从远端下载通过。

### 运行结果与证据

首轮已有完整浏览器套件执行结果为 `74 passed / 18 skipped / 2 failed`（`browser-installed.log`）。两项失败分别为 Probe 最终文本等待和 Whisper 共用外部指定配置目录。Probe 的真实回退、工具结果及最终持久化均正确，原五秒等待未覆盖一次实际十五秒收尾；仅调整既有等待到 120 秒，保留全部业务断言，聚焦复验通过（`browser-retest.log`）。收尾延迟的具体原因没有证据，不归因于某个模块。Whisper 重复安装拒绝来自 Vision 与 Whisper 共用目录的状态污染，独立目录复验已越过该步骤，生产重复安装保护未修改。

Whisper 独立目录的下一轮复验在长音频读取 `transcript.json` 时出现 `ENOENT`。该输入实际为 `407.1` 秒，文件名中的“70 秒”不代表真实时长。官方进程直接运行与实际 `TranscribeAudioTool` 单独运行均成功，后者产出 204 段；尚未确认原始缺失输出根因。仅在真实输出读取失败时补充该进程 stderr，保留原异常及取消、清理行为，没有重试、空转录或伪成功。新包独立安装后最后专项为 `1 passed (3.3m)`，长音频、取消、生命周期及重启均通过；此结果关闭当前复验失败项，但不声称诊断增强修复了未经确认的根因。证据为 `browser-whisper-final.log` 与 `logs/whisper-plugin/installed-1791948797738/summary.json`。

`DESKTOP_ACCEPTANCE_EXECUTABLE` 仅由 FFmpeg、Vision、Whisper、通用任务恢复用例消费；模型设置、模型选择、项目侧栏等现有原生用例使用开发 Electron，更新专项使用打包目录。不得把整套浏览器测试都统称 NSIS 安装版验收。18 项跳过为窄窗口重复的原生专项及依赖指定旧安装覆盖目录的两项；不计入通过。

已执行的真实入口：

- 安装版 FFmpeg：14 个工具、目录与附件授权、拒绝、取消、中文/空格路径、Skill 协同、语义候选与正式交付、启停卸载及更新回退复验通过。
- 安装版 Vision：本机 Chat Completions 与 Responses 协议、图片外传授权、结构化结果、缺密钥、禁用卸载、生命周期及 FFmpeg/Vision/Whisper/Skill 协同通过。供应商为本机协议夹具，真实媒体进程为 FFmpeg 和 Whisper，不能称真实云视觉通过。
- 最后安装版 Whisper：中文、英文、混合语音及秒级时间轴，407 秒长音频、超过 260 字符路径、损坏模型识别与恢复、真实进程取消、拒绝、FFmpeg 和技能协同、语义验收与正式交付、禁用卸载、失败更新保留、更新及回退、重启通过。21 个既有场景覆盖；缺模型与恢复登记通过，模型网络下载单独 `SKIP`。
- 安装版通用核心：普通任务、文件读写与审批、计划、命令未知效果核验、强制退出、两次重启、无工具重放和用户主动继续通过。
- 开发 Electron：供应商目录、系统加密密钥及 SQLite 设置写入、模型切换与重启、项目侧栏、会话与草稿恢复通过；更新专项的 SDK 与打包目录链路通过。
- 真实渲染：默认/窄窗口、暗色设置与模型菜单、长附件和活动、恢复后的任务计划、Whisper 模型详情已检查，未观察到本轮新回归。

原始日志位于 `logs/phase6-integration/`；媒体与执行证据由现有专项写入 `logs/ffmpeg-plugin/installed-1791947822193/`、`logs/vision-plugin/installed-1791947521274/`、`logs/whisper-plugin/` 和 `logs/general-agent-core-20261012/`。真实渲染截图位于 `apps/web/test-results/` 及专项日志目录。最终准确提交之后重跑工程门禁并核对同提交持续集成，既有运行证据仅覆盖对应相同生产产物。

## 交付提交记录

本轮代码集成为 [26f09683521adba34a77cb1561ce0740a0d3f560](https://github.com/wwxst/agent-desktop/commit/26f09683521adba34a77cb1561ce0740a0d3f560)，提交标题为 `merge: integrate latest main with phase5 core and media plugins`。两个父提交依次为 `9c1a002015925070ba8274b4c20a986acf06fcea` 和 `5bc555062e51ee61d303d0c7092d6e75ea1396d7`。相对 main 的 201 个文件、14244 行新增及 1012 行删除主要是完整引入第五阶段已有历史，并非本轮另写一套核心或插件；完整文件差异可以从上述提交及 `git diff --name-status 9c1a002 26f0968` 核对。

本轮特有修改为上述 24 处冲突解决、主入口的模型路由接入、当前配置/测试夹具同步、三处说明漂移、Probe 既有异步完成等待和 Whisper 真实失败诊断；没有新增测试场景。验收报告四份记录本轮范围、证据及审查。

对准确代码提交已经重新执行冻结锁安装、`pnpm check`（86 文件、1014 项）、独立架构检查（19 工作区）、Desktop/Web 构建及已提交差异检查，全部通过，证据为 `final-engineering.json` 和 `final-*.log`。提交后构建的受测资源摘要再次与最后安装包核对一致，安装运行和真实媒体证据对应同一生产源码。

首次远端 [Windows/Ubuntu 候选持续集成](https://github.com/wwxst/agent-desktop/actions/runs/38507495465) 为 Ubuntu 通过、Windows 失败。Windows 的 `run-command.test.ts` 中三个真实 PowerShell 用例触及 Vitest 默认五秒时限，其余 1011 项通过，未显示业务断言失败；不能把该运行记为通过。最小修正仅把这一组真实进程验收等待设为 30 秒，生产命令超时、取消和所有结果断言不变，没有新增用例、跳过测试或全局放宽时限。现有 14 项聚焦回归及测试类型检查通过，新准确提交的双平台持续集成待补记。

## 三轮审查及最终门禁

- [第一轮集成完整性](phase6-review-integration-20261014.md)：核对主线界面及模型组件、第五阶段核心、唯一视觉注入和当前跨进程契约，没有未关闭 P0/P1。
- [第二轮功能与安全](phase6-review-security-20261014.md)：核对当前事务、保存失败、恢复、未知效果、审批、加密、授权及交付，发现并修正缺密钥旧夹具，没有未关闭 P0/P1。
- [第三轮工程与交付](phase6-review-engineering-20261014.md)：核对工程规范、现有测试、打包资源及安装保护；发现终态事件、视觉配置说明、失败对象跨桥三处文档漂移并修正。本地安装运行最终复验通过；准确提交持续集成待补记。

不要求兼容旧 API、Session、SQLite、配置、插件协议或跨版本数据回滚。当前事务完整、工具授权、凭据加密、取消与异常传播、未知效果核验、当前版本保存及恢复、媒体候选验收和现有持续集成仍为必需要求。没有未解决的开发规范冲突，也没有擅自取消外部模型门禁。

真实云 Vision 和真实 Responses 都仍为 `SKIP`：缺少明确授权的测试凭据，未消耗生产额度；本机 HTTP 协议、真实 MCP 子进程和真实媒体进程的通过不能替代云供应商能力验证。

完成工程及持续集成后可以推送本独立候选。最终整体判断仍为 `BLOCKED`，须取得授权凭据并通过两项真实云验收，再核对最新 main 是否前进，才可作最后合并决定。本轮不合并 main。后续若决定合并，应保留合并历史；发现当前版本回归时通过新撤销提交回退代码，不承诺旧程序读取当前数据库，也不删除用户数据。
