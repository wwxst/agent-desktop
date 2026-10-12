# 第五阶段 C3：最终安装版通用核心验收

2026-10-12，最终安装版的两个专项场景实际通过：强杀后两次重启与主动继续，以及普通文件、计划证据、命令未知效果和人工核验后的剩余写入。专项未改变生产代码；测试使用已有桌面入口、真实文件与数据库，没有安装媒体插件或要求视频附件。

```text
Agent Core                通用智能体核心    通过实际循环执行任务并保存权威事件。
Desktop                   桌面宿主          启动实际安装版及既有审批和恢复界面。
NSIS Installer            安装程序          将准确候选资源安装到专项目录。
Preload                   预加载桥          把受限桌面接口传递给渲染层。
Renderer                  渲染层            展示实际任务、计划和用户审批。
PowerShell                命令解释器        启动本机真实命令并返回退出结果。
Playwright                浏览器验收工具    操作实际桌面窗口并保存断言证据。
SSE                       服务端事件流      本机模型夹具按生产流式协议返回确定调用。
SQLite                    本地数据库        读取实际任务事件、绑定、计划和展示快照。
Checkpoint                副作用检查点      外部动作执行前保存准确调用与工作目录。
Unknown Outcome           未知执行结果      非零命令后不凭退出码推断实际写入未发生。
Manual Verification       人工效果核验      用户提交事实说明后才释放剩余写入门禁。
SHA-256                   文件摘要          精确修改依赖实际读取摘要并核对安装身份。
```

## 安装身份与运行边界

生产源码为 `8a4d35f393f500733cfc34c8839861ace50314ae`；随后 `f325687` 仅修改持续集成配置。最终 NSIS 安装器摘要为 `19b8e32fe7c3dccd6e3a5830994a2b79738c296a0f4635b37d0c252e8fe949f2`。实际启动路径为 `logs/phase5-integration/最终 安装 验收/Agent Desktop.exe`，其运行器摘要为 `8377d686f863a30c28a5b4be685642783fd397a280bd353017b30d2c90dfd832`；这两个摘要不是同一个文件。

`asar: false` 的实际资源位于 `resources/app`。两项运行前后选定的主进程、预加载、渲染层和插件共 31 个文件不变，按脚本序列化的清单内容摘要为 `aaeb28718389b0e1eb5908076547efceaa736674843b11f38ea14a6a0f974587`，不等于带缩进 JSON 文件自身摘要；主进程为 `15cc03f679511c9e1697646fcdd8dcc81c9949a2d3aa6007d3c8416c302d3279`，预加载为 `5bb17c3683a5d57788b54fbc38f90a9c3913a17468bc3fde580e776019bd6270`。每个证据目录都保存该安装清单；汇总核对为 `logs/phase5-integration/general-installed-final-identity.json`。

每项使用新的专项用户配置和工作目录。编排模型替换为本机确定性 SSE 服务，假密钥只用于该服务；原生目录和附件选择器的返回值由测试提供。实际安装版的主进程、预加载、渲染层、循环、持久化、文件工具、PowerShell 子进程与界面审批均照常运行；测试没有插入任务事件或伪造工具成功。计划引用的事件索引直接读取真实 SQLite。该范围不等于原生选择器验收或真实云模型质量验收。

## 命令与最终结果

工作树为 `C:/Users/ww/.codex/worktrees/phase5-integration/agent-desktop`，以下命令在 `apps/web` 执行，专项配置使用独立端口 4175：

```powershell
$env:DESKTOP_ACCEPTANCE_EXECUTABLE = 'C:/Users/ww/.codex/worktrees/phase5-integration/agent-desktop/logs/phase5-integration/最终 安装 验收/Agent Desktop.exe'
corepack pnpm exec playwright test --config ../../logs/phase5-integration/playwright-core-installed.config.ts general-agent-recovery.pw.ts --project chromium-desktop --workers=1
```

原始日志 `logs/phase5-integration/general-installed-core-final-pass-run.log`：**2 passed，23.6 秒，退出码 0**。冻结测试文件 `apps/web/tests/browser/general-agent-recovery.pw.ts` 的摘要为 `3ed53a9706a552465c878227e276a5e00561a7aaa8abfaf0d82d86eefcd76561`。

## 强杀、两次重启与主动继续

准确成功目录为 `logs/general-agent-core-20261012/installed-recovery-1791811079634/`。

- 新草稿第一次发送时，实际用户消息、助手消息与精确轮次绑定一同保存。中文输入、`input.wav` 音频角色、工作目录、另一草稿和侧栏状态均保持。音频只用于附件身份；不调用媒体工具。
- 实际 `read_file` 读取工作目录中的文件并成功返回；第二次模型请求流式输出未完成文本时，通过 `taskkill.exe /PID … /T /F` 强杀准确安装进程。
- 两次重启只保存一条该轮次的 `turn.interrupted`，原因是 `process-exit`；未完成流式文本没有变成正式回复，原消息标识和绑定不变。两次重启均没有模型请求或工具重放；任务请求计数保持 2，实际工具调用和结果各为 1。
- 用户点击“继续未完成任务”后才发出第三次任务请求；新增准确绑定和 `turn.recovery.started`，原始轮次与恢复轮次关系正确。实际读取仍只有一次，最终任务完成。

该目录保留 `01-before-first-send` 至 `06-after-user-continue` 的状态、截图及强杀后/继续后 SQLite 副本，`evidence.json` 标记完成。最终任务和总模型请求均为 3。

## 普通文件、计划与未知效果门禁

准确成功目录为 `logs/general-agent-core-20261012/installed-tools-1791811088597/`。

- 用户拒绝创建 `denied.txt`；模型再次提交本轮相同调用时，没有第二个审批，事件为 `boundary: not-executed`，失败为永久拒绝去重，目标文件始终不存在。
- 用户允许创建 `普通 文件.txt`，真实字节为 `before-edit\n`；`read_file` 返回实际摘要。编辑审批显示原内容与新内容，批准后字节为 `after-edit\n`。计划完成证据引用真实创建和编辑结果，不依赖模型自述。
- 命令审批展示准确 PowerShell、工作目录与命令。实际执行 `[System.IO.File]::WriteAllText('command-marker.txt', 'actual-command-effect'); exit 7`，标记文件字节正确，进程以 7 正常退出。执行前检查点引用准确命令调用事件；返回为 `unknown-outcome`，保留 `exitCode: 7` 和 `termination: exited`。
- 人工核验前，剩余 `after-verification.txt` 写入被门禁阻止，工具边界为 `not-executed`，引用的来源事件就是该命令。文件不存在；计划修订 3 中两个文件步骤完成、命令步骤受阻，任务保留未知效果。
- “确认已完成”按钮在说明为空时禁用。测试先实际读取标记字节与退出结果，再在现有界面填写“已读取 command-marker.txt，字节为 actual-command-effect；进程退出码为 7，确认该命令实际写入已完成。”批准后保存用户来源、整次调用范围的 `effect.outcome.verified` 完成证据。
- 用户主动继续后，更新计划引用该核验事件，剩余写入才出现审批并实际完成。最终字节为 `written-after-manual-verification`；原命令仍仅执行一次。计划修订 5 的四项均完成，任务完成。
- 正常关闭再重启，实际事件与关闭前完整相同，模型请求数没有增加，计划和完成回复保持，核验输入区不再出现。

审批顺序准确为 `create-file`、`create-file`、`edit-file`、`command`、`create-file`，只有第一次创建被拒绝；总模型请求为 16，包含标题请求。证据含 `00-final-text-before-snapshot`、`01-before-manual-verification`、`02-after-manual-continue`、`03-restart-with-plan`、SQLite 副本与实际三个产物文件。已实际查看核验前、完成重启和恢复重启截图，计划状态、必要说明、附件及输入区没有遮挡或溢出。

## 失败记录与结论边界

此前运行均保留，不能计入最终通过次数：

- `general-installed-final-run.log`：模型夹具把未知命令的计划步骤请求为完成，生产正确拒绝“尚无真实完成证据”；夹具改为受阻。
- `general-installed-final-verified-run.log`：普通工具用例 150 秒超时，工作进程清理另有 30 秒超时；保留场景显示任务会话已结束而展示快照仍处于旧状态。没有确认根因，没有据此修改生产代码，也不声称超时已由某个产品修复解决。
- `general-installed-core-diag-run.log`：夹具精确比较继续请求文本，遗漏生产追加的“本次没有选择输入附件”段落，误重放了原场景；改为识别实际继续请求前缀。最终文件同时等待实际异步展示快照保存后再断言数据库，没有放宽业务断言。

冻结后相关类型检查通过，原始日志为 `general-installed-fixture-final-types.log`；文件创建/编辑/命令、核验、任务状态、安全恢复、计划持久化和计划界面专项共 8 文件、51 测试通过，日志为 `general-installed-related-focused.log`。本报告的两个最终安装场景通过，不能替代全部工程回归、媒体链、真实云供应商或其他未执行的通用工具验收。测试由本报告作者编写，属于作者验证；独立架构源码审查范围由 [架构报告](phase5-review-architecture-20261012.md) 明确维护。本报告不授权合并 `main` 或发布。
