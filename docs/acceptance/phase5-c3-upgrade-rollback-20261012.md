# 第五阶段 C3：准确旧版本升级与完整配置回滚

2026-10-12 最终安装版实际执行通过。旧版本为 `main` 的 `49b8da974cc963f7068abb04423bed9628a8f6ae`，候选生产源码为 `8a4d35f393f500733cfc34c8839861ace50314ae`。本验收只操作专项配置目录；不读取或覆盖开发者原用户配置，不合并主分支、不发布。

```text
Electron                  桌面运行时        启动真实主进程、预加载桥和渲染层。
NSIS Installer            安装程序          实际安装候选程序及随包资源。
Full Profile Backup       完整配置备份      一起备份数据库、系统加密依赖和其余配置文件。
SQLite                    本地数据库        保存旧历史、设置、插件配置及新版任务绑定。
SHA-256                   文件摘要          逐字节核对应用版本与完整配置恢复。
IPC                       进程通信          任务经实际桌面入口执行并保存真实会话事实。
Local HTTP Fixture        本机协议夹具      提供确定性回答，验证编排而不代表云模型质量。
Playwright                浏览器验收工具    操作实际桌面窗口并保存断言证据。
```

## 程序和数据身份

准确旧应用不是过往日期的安装器。旧主分支重新构建的六个应用文件与已有原始构建逐字节相同；清单保存在 `logs/phase5-integration/c3-main49-proof/artifact-proof.json`。本次冻结应用位于 `logs/phase5-integration/c3-profile-1791810140790/准确旧 main 应用`，升级执行前重新核对全部六项摘要及旧运行器摘要。旧端使用 Electron 44，运行器摘要为 `1dc2d12e5c60341782e68c4b65a8e49cbd86217f81568f90575547cec13b5610`。

最终安装证据为 `logs/phase5-integration/installer-protection-1791810440955/result.json`。安装器摘要为 `19b8e32fe7c3dccd6e3a5830994a2b79738c296a0f4635b37d0c252e8fe949f2`；实际启动 `logs/phase5-integration/最终 安装 验收/Agent Desktop.exe`，其摘要为 `8377d686f863a30c28a5b4be685642783fd397a280bd353017b30d2c90dfd832`。已读取安装保护记录：原安装 8120 个文件不变，注册项和快捷方式已恢复，隔离安装包含 8140 个文件，没有覆盖原安装。

当前打包配置为 `asar: false`，因此准确版本由 `resources/app` 内真实文件标识，不能仅靠通用运行器摘要判断。专项保存主进程、预加载、渲染层和插件目录共 31 个文件的清单；按脚本序列化的清单内容摘要为 `aaeb28718389b0e1eb5908076547efceaa736674843b11f38ea14a6a0f974587`，不等于带缩进 JSON 文件自身摘要。主进程摘要为 `15cc03f679511c9e1697646fcdd8dcc81c9949a2d3aa6007d3c8416c302d3279`，预加载摘要为 `5bb17c3683a5d57788b54fbc38f90a9c3913a17468bc3fde580e776019bd6270`。全部清单见专项 `candidate-artifact-inventory.json`；执行结束再次核对，没有修改安装资源。后续 `f325687` 只修改持续集成配置，不改变本安装版生产代码。

旧配置由准确旧程序通过真实桌面接口创建：一条已完成历史，带中文和空格的工作目录与附件，一条未发送草稿，置顶及折叠项目、会话侧栏状态，保存的模型选择与加密凭据，以及已安装、配置后停用的本地插件和加密插件凭据。附件只用于身份恢复，不冒充有效音频。模型与插件密钥均是专项假值，未使用真实云凭据；原生目录和附件选择器的返回值由专项脚本提供。

旧程序正常退出后，将整个 `用户 配置` 目录备份为 `完整 旧配置备份`；最终这次共 **55 个文件**，复制后逐文件字节数和摘要均匹配。目录包含实际 `Local State` 和 SQLite；没有单独复制密文数据库或跨目录拼接主密钥。

## 命令与实际断言

工作树为 `C:/Users/ww/.codex/worktrees/phase5-integration/agent-desktop`。使用已有专项脚本及现有 Playwright 依赖：

```powershell
node logs/phase5-integration/c3-upgrade-rollback.mjs --upgrade logs/phase5-integration/c3-profile-1791810140790 'C:/Users/ww/.codex/worktrees/phase5-integration/agent-desktop/logs/phase5-integration/最终 安装 验收/Agent Desktop.exe'
```

实际退出码为 0。原始命令输出为 `logs/phase5-integration/c3-upgrade-rollback-final-run.log`，详细结果为本次专项 `result.json`。

- 升级启动实际安装程序，并断言它使用专项 `用户 配置` 目录。旧模型和插件凭据解密值正确；旧密文记录保持不变。
- 旧消息、事件、附件、工作目录、草稿和侧栏逐字段保持；未绑定旧任务没有被猜测为中断，也未补造新版关联。
- 通过现有输入区发送新版任务，实际主进程和本机模型响应完成。数据库只增加一条 `{ executionVersion: 1, turnId, userMessageId, assistantMessageId }` 绑定，消息标识为 3 和 4，轮次为 `83b175ca-893d-44b9-828f-258c64549ed6`。
- 关闭后两次重新启动同一安装版。每次都核对原有事实和精确绑定相同，新版完成回复仍可见；没有重复绑定或重放模型。整个升级只收到一次模型请求。
- 关闭全部专项程序后，将升级后完整配置移到 `升级后完整配置`，再恢复完整旧备份。启动旧程序之前，恢复目录 55 个文件的清单与原备份完全相同。
- 重新启动摘要匹配的准确旧程序，再次核对历史、草稿、附件、目录、侧栏、模型与插件解密。正常退出后，全部数据库文档与旧基线完全相同；原备份仍保持原摘要。

已经实际查看本次目录中的 `candidate-restart-2.png` 与 `rollback-old-main-restored.png`：新版同时展示旧回复与新增回复，回滚后只显示准确旧历史；附件、项目和底部输入区保持正常，没有遮挡或溢出。该截图检查只覆盖本次恢复状态，不扩大为全部界面验收。

## 保留的前次证据

修正 Whisper 运行目录发布前，`logs/phase5-integration/c3-profile-1791805105233/` 已完成一次升级回滚，完整配置为 53 个文件，原始运行日志为 `c3-upgrade-rollback-run.log`。当时安装器摘要为 `a1993404a2153c5acf6b74a1e3b7d56df80eb6154246a24f433323173c1c4f42`，31 文件清单摘要为 `d657287a00fe6955fbeed05b5af98cd9bfd3258cfc42ae8fe5c8562a03a86d3b`，主进程摘要为 `a303b7b5c3930f86188c5f438978d588a078e81dcf96f67c5a9bfbe1e635faec`。该目录和日志保留，只代表此前安装身份；最终结论使用上面的新隔离目录、55 文件备份和 `19b8e32f…` 安装包。

## 证据与限制

最终完整证据集中在 `logs/phase5-integration/c3-profile-1791810140790/`：`run.json`、`baseline-documents.json`、`profile-backup-inventory.json`、`candidate-artifact-inventory.json`、`upgraded-documents.json`、`upgrade-requests.json`、`result.json` 和四张旧版、重启、回滚截图。

本项证明准确旧原始应用到候选真实安装版的配置恢复、正常新任务、两次重启与完整匹配回滚。旧端使用摘要匹配的原始应用及 Electron 44，不能声称存在准确旧安装器。模型为本机确定性协议服务；本项没有执行音视频处理、真实云视觉或系统安全存储首次保存后强杀，后者由 C2 专项证据单独维护。后续候选安装文件变化须按新身份重新判断本项证据是否仍适用；本报告不授权合并 `main` 或发布。
