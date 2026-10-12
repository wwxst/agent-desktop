# 第五阶段 C2 Windows 命令生命周期验证

原集成 CI 的首次 PowerShell 成功用例超过 5 秒，随后临时目录删除报 `EBUSY`。本机真实命令专项 14 项通过，首次成功执行约 164 毫秒，未复现初始延迟，因此不将系统资源或 CI 差异写成已证明根因。

已复现的清理缺陷是测试超时后执行 Promise 尚未完成，夹具立即删除进程仍占用的目录。修复只改 `packages/local-tools/tests/run-command.test.ts`：合并 Vitest 测试取消信号及清理信号，登记执行的完成状态，清理时先取消、等待生产执行器完成进程树终止与关闭，然后删除目录。原 Promise 仍供断言读取。保持 5 秒测试期限，不跳过真实成功、失败、取消及进程树测试，不修改生产命令实现。

隔离反证保留真实 5 秒超时失败，随后确认测试信号中止、进程关闭后的 Promise 完成、目录成功删除、无额外清理错误。证据为 `logs/phase5-integration/command-deadline-evidence.json`，脚本为同目录 `command-deadline-verification.mjs`。聚焦日志为 `c2-command-focused.log`，测试类型检查日志为 `c2-command-test-types.log`，均通过。

准确候选的 Windows 与 Ubuntu CI 结果由最终报告记录；本地通过不代替两系统 CI。

## 首次候选的双系统结果及 Ubuntu 加载失败

`cb0d8345884b2ef653a3f9b81ad811c31b679bfe` 的实际运行 `38246107982` 中，Windows 完整工程检查和构建通过，原 5 秒命令专项未失败。Ubuntu 的八个测试文件在收集阶段通过传递导入读取 `electron.net`，Electron 44 的 Node 入口自动下载 Linux 二进制，GitHub 下载返回 HTTP 504，八套均未开始执行。日志为 `logs/phase5-integration/ci-log-114800262004.log`，不能把这次失败称为 Ubuntu 通过。

这些 Node 测试不消费 Electron 网络下载；真实数据库、文件、MCP 和 HTTP 服务仍直接运行。它们现在按已有运行资源测试方式局部替换 Electron 外部边界，若意外请求下载则明确抛错，避免测试收集触发二进制下载。没有生产兜底、全局测试框架或依赖变化；真实 Electron 和安装版测试仍使用实际二进制。八套共 93 项和测试类型检查通过，日志 `ci-electron-fixture-focused.log`、`ci-electron-fixture-types.log`。其中 `extension-platform.test.ts` 同时涉及凭据异步保存，相关替身随独立凭据修复提交，其余七套单独提交。后续准确候选 CI 必须重新核验。
