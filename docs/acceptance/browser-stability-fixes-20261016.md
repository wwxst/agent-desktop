# 浏览器验收修正与完整回归

日期：2026-10-16。分支：`codex/final-browser-stabilization`。本轮修复提交和完整浏览器受验提交均为 `f07ede3eb90d8231dda415bcc0a687d9052acde0`。本报告补充[上一轮调查](browser-root-cause-followup-20261015.md)，不覆盖其失败、隔离事故及未知影响记录。

本轮完整运行 **76 PASS / 18 SKIP / 0 FAIL**，退出码 0，540.135 秒，重试 0，全局错误为空。准确修复提交的 Windows、Ubuntu 持续集成均成功。当前运行门禁通过；历史异常的根因审查仍有未闭环项，因此最终结论保留 **BLOCKED**，不自动合并 main。

## 最小修改

- `packages/local-tools/tests/run-command.test.ts`：三个真实输出命令改用 `[Console]::WriteLine`，去除 `Write-Output` 触发的 PowerShell Utility 模块首次发现和准备。保留真实进程、输出、中文、非零退出等断言及原 5 秒期限。隔离缓存量测证实这项额外初始化存在，但不能证明旧持续集成的 5065 毫秒全部花在模块准备上；旧失败是测试总期限，不能写成工具自行报告超时。
- `apps/web/tests/browser/general-agent-recovery.pw.ts`：应用运行时通过 Electron 主进程执行原始只读 SQLite 查询，使验收读取与生产同步提交串行；强杀后仍由验收进程直接读盘。保留全部持久化、审批、未知效果、禁止重放断言及原 150 秒期限，没有生产重试或锁等待。
- `apps/web/tests/browser/desktop-probe.pw.ts`：为既有首项的手动 Electron 上下文显式采集页面快照、截图和源码，分别保存三次实例轨迹；正常重启前释放引用，采集启动失败时关闭刚创建的实例。原命令行 `--trace=on` 没有自动采集该上下文，这是已确认的诊断缺口。没有改变联合安装与设置调用、定位器、断言、超时或重试。

没有新增测试用例、依赖、跳过条件或生产改动。Agent Core、Session、数据库契约、加密、模型协议、文件与外传审批、取消和插件运行时保持受验实现。相对最终集成候选 `b0973a2` 的生产源码差异为空，DeepSeek 官方云证据可继续引用。

## 故障证据与处理界限

SQLite 机制量测同时覆盖本机 Node 和实际安装产物 Electron 44 / Node 24.18.1 / SQLite 3.53.1：`.get()` 返回后不继续持有读锁；在查询实际执行期间，其他连接的提交可以产生同样的 `ERR_SQLITE_ERROR / errcode 5`。这纠正了先前关于查询返回后继续持锁的假设。应用生产连接均为同步短事务，验收进程额外读取是实际存在的竞争窗口，本轮移除了该窗口。机制反证不等于取得旧失败的准确锁持有者和时序。

旧保存失败后的关闭耗尽预算也有源码链路：首次持久化错误被保留，后续保存继续失败，关闭处理因此保留窗口并显示错误。没有据此修改生产关闭保护或加密实现。两项既有恢复专项各执行一次，2 PASS、11.415 秒；完整套件中的两项也通过。

Whisper 旧完整运行的模型安装 1448.346 秒、FFmpeg 安装 182.387 秒，已经成功但耗去原 30 分钟预算的约 90.6%；最后一次启动只剩约 0.4 秒。这是预算耗尽的直接证据，不是下载断言失败或已证明的启动挂死。当前系统代理下官方锁定下载地址能及时返回，独立直连量测超时；未改变系统网络、下载源、下载器、期限或重试。短网络样本不能解释旧时段具体慢在哪一跳。

本轮完整 Whisper 用例从新目录冷下载模型，249.189 秒内完成窄窗截图、中文/英文/混合语音、长音频、时间轴、取消、语义视频交付、更新回滚和重启。模型最终为 487601967 字节，SHA-256 为 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`。没有预置模型替代下载。

Probe 原附件按钮缺失没有可靠历史现场。源码复核确认按钮无条件渲染，初始视图为对话；安装插件和直接保存设置没有导航或重载路径。新完整运行的 Probe 通过并保存三份真实 Electron 轨迹，仍不能据此确定旧失败时页面隐藏或渲染异常的原因。旧 Vision/Settings 提前关闭、Whisper 截图超时及额外输入字符的准确来源同样不能从缺失的旧现场恢复。用户曾操作窗口但已忘记详情，不能把人工操作定为这些故障的原因。

## 完整回归与工程检查

命令：`corepack pnpm client:web:test --workers=1 --trace=on --reporter=line,json --output=<本轮目录>/artifacts`。原始记录位于 `logs/browser-stabilization/fixed-full-20261016-080301/`，含 `metadata.json`、`environment-preflight.json`、`results.json`、`run.log`、`exit.json`、`case-comparison.json`、`resource-check-after.json` 和 `artifacts/`。

```text
Scenario                      场景                    实际结果及耗时
Probe                         媒体探测及语义交付      PASS，80.554 秒。
Vision                        视觉协议与插件周期      PASS，48.219 秒；模型为本地协议夹具。
Whisper                       冷下载及完整识别周期    PASS，249.189 秒；真实官方资源和本地识别。
Forced-exit recovery          强杀后两次重启恢复      PASS，2.892 秒。
File and command recovery     文件审批及未知效果      PASS，3.122 秒。
Provider settings             加密凭据及双协议执行    PASS，12.514 秒。
Full browser suite            完整浏览器套件          76 通过、18 跳过、0 失败；540.135 秒。
```

94 项测试身份及 18 项跳过与上轮逐项一致。原有 14 项窄窗不重复执行的原生专项和 4 项缺少指定安装配置目录的专项仍为跳过，分类见[原清单](final-browser-stabilization-20261015.md)。这些跳过不计为通过。Vision 内部缺少 Whisper 模型的四插件协同仍是原条件跳过；Whisper 自身的技能、FFmpeg、Vision 和语音语义交付链实际完成。

环境清理使用 `Remove-Item Env:<名称>`，并由子 Node 确认相关键确实不存在；未使用空字符串配置目录。所有原生运行使用本工作树安装产物及新建隔离配置，未操作默认用户配置。提醒过用户不要操作测试窗口，但没有独立证明全程无人操作。

本机 Node 24.20.0、pnpm 11.22.0；持续集成 Node 24.19.0。本轮完成 `corepack pnpm install --frozen-lockfile`、`pnpm check`、`pnpm client:web:build`、`git diff --check`；`check` 含生产和测试类型检查、86 个文件和 1014 项测试、19 个工作区架构检查。`client:web:test` 已完成 `desktop:build`。Windows 单元测试使用现有 `VITEST_MAX_WORKERS=1`。

受验构建与包内主进程、预加载桥、三个插件、协议清单及渲染资源共 11 项摘要全部相同。未重新打包或执行新的安装器覆盖；生产和安装资源未变，不将运行 `win-unpacked` 写成新安装器已安装。

准确修复提交的[持续集成 38827250098](https://github.com/wwxst/agent-desktop/actions/runs/38827250098)中，[Windows](https://github.com/wwxst/agent-desktop/actions/runs/38827250098/job/116737465852)和[Ubuntu](https://github.com/wwxst/agent-desktop/actions/runs/38827250098/job/116737465995)均通过工程门禁、Desktop 构建和已提交差异检查。最终报告提交推送后另核对其准确提交的双平台结果，不用旧提交结果代替。

## 审查与最终门禁

审查 A：最小修改与当前运行证据通过；历史根因闭环仍为 `CHANGES_REQUIRED`。已处理无关模块初始化、验收跨进程读锁窗口和 Electron 现场缺失，未将机制验证或一次完整通过冒充旧异常准确归因。

审查 B：当前产品与执行安全通过，未发现本轮新增的已确认 P0/P1。生产调用链不变，继续继承[DeepSeek 官方 Vision、Responses 验收](deepseek-flash-cloud-20261014.md)及其覆盖限制。本轮没有新增付费请求；历史隔离事故没有全进程网络审计，不能据此宣称事故整体请求数为零。

审查 C：当前完整浏览器运行、工程检查、安装产物一致性和准确修复提交双平台持续集成通过。旧报告中的失败继续保留为历史结果。

最终结论：**BLOCKED**。当前没有复现中的运行失败，但用户要求“仍无法确认的，保留原始诊断证据与阻塞状态”。旧提前关闭、截图超时、额外字符、Probe 按钮缺失的准确原因，以及旧 SQLite 冲突的准确持锁者仍不能追溯。没有可据以追加生产修复的证据，不通过重复运行或推测性重构制造闭环。

隔离事故入口已修正，历史用户配置影响因缺少事前快照仍未知，属于已披露事故限制；本轮不自动恢复或删除用户数据，也不把它伪装成尚未修复的产品功能。后续若复发，应依实际现场定位对应最小修改。

最新抓取的 `origin/main` 为 `9c1a002015925070ba8274b4c20a986acf06fcea`，是当前候选祖先，未出现新的待集成 main 提交。本轮只推送独立分支，不合并 main、不发布、不清理其他分支、工作树或用户文件。
