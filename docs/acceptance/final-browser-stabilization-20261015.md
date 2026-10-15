# 浏览器与 Electron 稳定性专项复验报告

日期：2026-10-15。

## 一、范围与版本

独立分支为 `codex/final-browser-stabilization`，从准确候选 `b0973a2ec17109918e57e3e24ed0ddd3ee7dc755` 创建。工作树为 `C:/Users/ww/.codex/worktrees/final-browser-stabilization/agent-desktop`。

本轮受验生产代码及最终测试代码均与该提交相同；相对已通过真实云验收的 `b4dd427c169c9a68a6a41eaa87f02819c39804f5`，生产源码没有变化。本轮交付仅新增本报告，不包含业务修复、测试修复、依赖、配置或持续集成修改。报告提交的准确 SHA、推送及双平台结果由最终交付消息和本机 `logs/browser-stabilization/final-delivery.json` 记录，不能将基线持续集成当作新提交结果。

本轮没有更新 main、发布版本、删除其他工作树或用户文件。检查时本地 main 和远端 main 均为 `9c1a002015925070ba8274b4c20a986acf06fcea`；交付前再次核对。

```text
PASS       通过        对应命令或实际场景在本次执行成功。
FAIL       失败        实际执行失败，后续成功不改写原始记录。
SKIP       跳过        条件不具备或现有项目配置明确不重复运行。
BLOCKED    阻塞        必要的根因或合并门禁尚未关闭。
```

## 二、原始失败与诊断边界

已读取[上一轮最终报告](final-main-merge-20261014.md)、旧工作树 `logs/final-main-merge/` 中两轮日志、结果 JSON、失败截图和上下文。旧运行未生成可用的 Playwright trace，不能补推当时未返回的协议命令、窗口状态或退出调用者。

旧完整套件的 `74 PASS / 18 SKIP / 2 FAIL` 和 `73 PASS / 18 SKIP / 3 FAIL` 均保留，本报告不修改旧结论。

本轮在三个现有测试中临时监听主进程退出、窗口关闭与尺寸事件、页面关闭和崩溃、渲染进程退出及未处理异常；单项 Whisper 另记录窗口和渲染区状态。仅用于诊断，没有添加重开、重试、超时扩展或异常吞没。组合运行移除了缩窗和截图之间的临时查询。组合完成后，三个测试全部恢复为基线内容，再执行完整回归。

原始日志留在本机忽略目录，不提交。子进程使用隔离配置和夹具密钥，没有传入真实云凭据。临时观察器的脱敏正则存在转义问题，因此不声称日志已可靠脱敏；没有将该观察器交付到生产或最终测试代码。

### Vision 提前关闭与输入身份

静态调用链为设置保存、系统加密、SQLite 提交和设置读取，没有发现保存函数触发关闭、重载或退出。各场景各自启动 Electron，使用独立配置目录；没有发现其他场景清理时按进程名全局关闭应用，清理均等待本应用退出。

单项的 21 个场景在模型记录和 Session 中身份一致，`restart-disabled` 没有尾部字符，停用后未调用视觉工具。原 `CASE:restart-disableda` 已证实的身份错误仍保留，字符来源未确认。

本轮 Vision 诊断运行的关闭均对应测试主动重启或最终清理，退出码为 0，没有记录页面崩溃、渲染进程退出或未处理异常。首次配置的系统加密主密钥在正常退出前已实际写盘，不能据旧失败猜测密钥丢失或安全存储超时。

**本轮未复现旧首次保存时的提前关闭；关闭来源仍未确认，没有针对该问题修改生产代码。**

### Whisper 窄窗截图

单项模型下载完成后，窗口为 1120×760，内容区为 1104×721；缩窗后分别为 800×600 和 784×561。窗口可见、有焦点，未最大化、最小化或隐藏，渲染区只读查询正常，窄图成功。

组合恢复原相邻 `setSize → screenshot` 操作。`combined.log` 中主进程返回后收到 `Page.frameResized`；截图读取的渲染区、布局数据和裁剪区均为 784×561，`Page.captureScreenshot` 正常返回 33440 字节。没有依赖中间状态查询才能成功。

这证明本次正确缩窗并完成截图；不能证明旧两次截图超时由尺寸竞态、字体、遮挡、最大化或进程异常造成。旧运行缺少相应协议和窗口事件，原等待阶段仍未知。因此没有加入未经证实的尺寸等待、截图重试或生产窗口修复。

单项与组合均继续执行了中文、英文、混合语音、时间轴、空文件和错误文件、静音、长路径、模型损坏恢复、语义视频交付、长音频、取消、拒绝、卸载重装、更新失败保留、更新回滚及重启识别。单项的 407.1 秒长音频处理约 70.48 秒；取消子进程已回收，SQLite 保留用户取消事实，没有伪造工具完成。

有效媒体未复现历史 `transcript.json` 缺失；空文件和错误文件反证仍可明确失败并包含 `ENOENT`，不能称全程零文件错误。历史有效媒体缺失继续单独观察，不与截图问题合并。

### Settings 保存期间关闭

单项完成新增供应商、密文保存、模型发现、两种协议请求、重启恢复及删除供应商。两个诊断进程正常退出，关闭时序对应主动重启和清理。没有记录页面错误、崩溃、渲染进程退出或未处理异常。

**旧约 8.83 秒时提前关闭仍未复现，来源未确认。** 没有依据修改加密机制、SQLite 事务或持久化等待期限。

## 三、本轮执行结果

原始证据统一位于 `logs/browser-stabilization/`；模型和插件证据位于各次独立的 `logs/vision-plugin/installed-*`、`logs/whisper-plugin/installed-*`。下列耗时取结果 JSON 的整次运行统计。

```text
Run                 结果                    耗时        结果文件
Vision 单项         1 PASS / 0 SKIP / 0 FAIL  57.552 秒   vision-alone.json
Settings 单项       1 PASS / 0 SKIP / 0 FAIL  14.912 秒   settings-alone.json
Whisper 单项        1 PASS / 0 SKIP / 0 FAIL  246.659 秒  whisper-alone.json
三项组合            3 PASS / 0 SKIP / 0 FAIL  323.853 秒  combined.json
```

上述运行退出码均为 0、重试数均为 0。组合中 7 个 Electron 主进程全部正常退出。单项和组合的两个 Whisper 隔离目录均真实下载锁定模型，487601967 字节；没有以预置模型替代下载。

Settings 单项、Whisper 单项及组合的 trace 和测试产物已单独归档。Vision 单项 trace 未在下一次运行前独立归档，已被测试结果目录覆盖；其 JSON、事件和场景证据保留，不能声称该次 trace 可用。

恢复原测试后的首轮完整套件实际执行完毕：`75 PASS / 18 SKIP / 1 FAIL`，717.086 秒，退出码 1，重试数 0，另有一项工作进程收尾错误。94 项测试身份和 18 项跳过身份均与上一轮完整结果一致，没有增加跳过或删除用例。完整日志、JSON、退出码和 trace 分别为 `browser-full.log`、`browser-full.json`、`browser-full-exit.json` 和 `browser-full-artifacts/`。

原三项在该次全套中的实际用例耗时为 Vision 65.292 秒、Whisper 234.627 秒、Settings 12.631 秒，均通过。Whisper 再次真实下载模型并完成后续流程，窄窗截图成功；该次没有临时观察器或额外状态查询。不能由这些通过推导旧失败根因已解决。

### 本次新增失败：强制退出后恢复

`general-agent-recovery.pw.ts` 第一项在第二次重启后，首个 `desktop:save-client-state` 的 SQLite `COMMIT` 返回 `database is locked`；随后恢复请求被既有持久化错误拒绝。包内 `index.cjs:19976` 对应实际提交语句，原始堆栈已保留。这不是该用例故意注入的锁定反证，也没有证据将其归为加密问题。

trace 显示先在等待“恢复后的任务已完成”时超过原 5 秒断言期限，随后 `finally` 中 `app.close()` 未完成，最终到达用例原 150 秒期限；另记录 `Worker teardown timeout of 30000ms exceeded`。因此不能将全部耗时描述为模型或恢复业务持续执行 150 秒，也不能省略工作进程错误。

主进程正常业务只有同步短连接读写；测试进程会额外直接读取同一 SQLite。跨进程读取与自动保存冲突是当前诊断方向，具体锁持有者尚未确认，没有加入锁、等待重试或修改生产事务。

对该既有用例增加临时事务和读取时点记录后，单项诊断复跑 `1 PASS`、4.571 秒、退出 0，证据为 `recovery-diagnostic.json`、对应日志及 trace。此成功不覆盖完整套件的实际失败，也不能独立证明锁冲突已修复。

该次记录有 13 次读取和 29 次提交，未观察到区间重叠或失败，读连接持续 0.2403–0.6842 毫秒。随后对同一既有场景使用 `--repeat-each=10 --workers=1` 做有界诊断，10 次均通过，33.095 秒、退出 0，每项 `retry: 0`；日志、JSON、trace 和各目录时点记录分别保留，没有覆盖完整套件失败。10 次共记录 130 次读取、288 次主进程提交，没有错误或读取连接与提交区间重叠；最近非重叠间隔为 0.0701 毫秒，不能据此确认原故障因果，汇总见 `recovery-diagnostic-repeat-sqlite-summary.json`。仍未取得原锁持有者证据，不以人为延长读锁来冒充原异常复现，不修改生产等待、事务或测试读取方式。恢复场景的临时诊断也已全部撤回，最终测试文件与基线完全一致。

现有 18 条条件跳过逐项如下。前 14 条是 `chromium-800x600` 不重复执行的原生专项；不代表对应桌面项目已通过。后 4 条涉及指定安装配置目录，不能归为全部已废弃的历史兼容。

```text
 1  chromium-800x600  desktop-extensions     插件安装、启用状态和重启持久化。
 2  chromium-800x600  desktop-probe          Probe 权限、生命周期和语义交付。
 3  chromium-800x600  desktop-update         更新 SDK 下载及安装前 SQLite 收尾。
 4  chromium-800x600  desktop-update         打包应用搜索、终端和更新桥。
 5  chromium-800x600  desktop-vision         Vision 安装、协议、审批和生命周期。
 6  chromium-800x600  desktop-whisper        Whisper 下载、识别和生命周期。
 7  chromium-800x600  general-agent-recovery 强制退出后恢复，不重放工具。
 8  chromium-800x600  general-agent-recovery 文件审批、计划和未知命令效果。
 9  chromium-800x600  model-selector         视觉模型选择、真实路由及重启保持。
10  chromium-800x600  new-chat               空会话、项目草稿和模型标题持久化。
11  chromium-800x600  settings               插件、MCP 和市场管理。
12  chromium-800x600  settings               供应商、加密凭据和双协议执行。
13  chromium-800x600  settings               独立 MCP 重启后执行。
14  chromium-800x600  sidebar                项目导航及归档历史持久化。
15  chromium-desktop  desktop-probe          安装器覆盖后保留插件和 Session。
16  chromium-800x600  desktop-probe          同上，且不满足桌面项目条件。
17  chromium-desktop  desktop-probe          FFmpeg 详情真实更新和回滚控件。
18  chromium-800x600  desktop-probe          同上，且不满足桌面项目条件。
```

第 15–18 条缺少 `DESKTOP_UPGRADE_PROFILE`；Windows 平台和安装版可执行文件条件已提供。FFmpeg 更新和回滚仍是当前功能，四条跳过不计为通过，也不以本轮未执行的新安装器专项替代。

测试级跳过与内部协同条件分开计算：Vision 的 `FFmpeg + Vision` 通过；其 `Skill + FFmpeg + Vision + Whisper` 因该独立配置没有就绪 Whisper 模型保持现有条件跳过，不能计为该场景通过。Whisper 自身的真实语义链路实际组合 FFmpeg、Vision、Whisper 和技能并完成正式交付。没有修改这些条件或用模型夹具冒充官方云。

## 四、工程与产物

本机 Node.js 为 24.20.0，pnpm 为 11.22.0；持续集成声明 Node.js 24.19.0。Windows 单元测试按现有持续集成使用 `VITEST_MAX_WORKERS=1`。

```text
Command                                  结果
corepack pnpm install --frozen-lockfile   PASS，锁文件无变化。
corepack pnpm check                       PASS，86 文件、1014 测试通过，含类型检查。
corepack pnpm check:architecture          PASS，19 个工作区。
corepack pnpm desktop:build               PASS，包含三个插件构建。
corepack pnpm client:web:build            PASS。
git diff --check                          PASS，最终报告提交前核对。
```

相应日志和退出码见 `engineering-results.jsonl`。安装版专项使用复制到本轮独立工作树的既有 `win-unpacked`，避免修改其他工作树资源。当前构建及包内主进程、预加载桥、三个插件入口及 MCP 清单、渲染资源共 11 项摘要与既有受验资源相同，本次复算保存在 `resource-hashes.json`，`count: 11`、`allMatch: true`。生产 Electron 行为和安装资源未变，本轮没有重新打包或执行新的 NSIS 安装；继承范围见[上一轮报告](final-main-merge-20261014.md#五windows-构建运行资源及已有安装证据)。不能将旧安装器构建成功或本轮运行 `win-unpacked` 写成新安装器已实际安装。

准确报告提交的 Windows、Ubuntu 持续集成在推送后单独核对；结果和准确 SHA 记录在最终交付消息及本机交付记录，远端入口为[本分支工程持续集成](https://github.com/wwxst/agent-desktop/actions?query=branch%3Acodex%2Ffinal-browser-stabilization)。完整浏览器失败不能由工程持续集成替代。

## 五、云证据与安全边界

生产模型、协议、Vision 工具、供应商调用链与真实受验版本一致，继续引用[DeepSeek Flash 真实云验收报告](deepseek-flash-cloud-20261014.md)。Vision、Responses 原官方门禁证据适用；本轮新增官方请求为 0，没有追加已用尽的 15 次授权额度。

原生 PNG 文件选择、安装包直接连官方云、官方故障注入和实际扣费账单仍为原报告的跳过项；人工 6000 上下文窗口两次摘要后仍超预算的失败保留，恢复真实摘要后的请求成功是另一项结果。供应商不支持的服务端会话、`previous_response_id` 和 `context_management` 没有变成项目缺陷，也没有新增兼容机制。

Agent Core、Session、SQLite、配置加密、文件及外传审批、取消、未知效果、持久化错误传播和专业插件生命周期均未修改。未发现本轮引入的已确认 P0/P1；旧运行故障和新增 SQLite 提交失败仍可能包含未定位的回归，不能据此宣布风险已排除。新增问题尚不能归类为确定的测试夹具缺陷或生产缺陷。

## 六、三项审查与合并结论

审查 A：当前诊断证据真实性通过，根因闭环为 `CHANGES_REQUIRED`。单项和组合均成功，但旧两项提前关闭、Whisper 截图超时及额外字符来源未确认；新增恢复场景也未确认锁持有者，无证据时不做猜测性修复。

审查 B：当前生产与执行安全边界通过。保留原云验收限制，移除对忽略目录临时模块的引用，不以夹具响应替代真实云，不修改旧结果。

审查 C：本地机械检查、构建、资源摘要及证据分类通过；完整浏览器门禁为 `FAIL`，包含恢复场景失败和工作进程收尾错误，工程交付结论为 `BLOCKED`。准确报告提交的双平台持续集成由最终交付记录核对，不替代这项失败。

最终结论：**BLOCKED**。

用户明确要求“仍无法确认的，保留原始诊断证据与阻塞状态”。本轮没有获得旧异常的关闭调用者或截图等待阶段证据，不能把后续未复现写成根因已经修复。剩余门禁是取得旧异常及新增 SQLite 锁定的可靠复现或可核对归因，完成对应最小处理，并取得现有完整套件退出 0、无失败和无新增跳过的结果。诊断单项和工程持续集成通过均不撤销这些要求。

本轮没有提出生产修复提交，也没有正式合并授权。本分支仅交付可审查的复验结果，main 保持原状。
