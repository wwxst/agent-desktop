# FFmpeg 独立插件实施与验收

日期：2026-10-11。起点：`feature/probe-media-plugin` 的 `6c29b2e`。
实施分支：`codex/ffmpeg-plugin`。独立工作区：`C:/Users/ww/.codex/worktrees/ffmpeg-plugin/agent-desktop`。

```text
Goal          目标        修复跨平台门禁，完成独立 FFmpeg 插件及 Windows 分发和真实验收。
Problem       问题        除 Probe 外专业工具仍固定内置，运行程序尚需用户配置。
Impact scope  影响范围    Desktop 插件宿主、视频应用层注入、既有 FFmpeg 外部适配及验证。
Non-goals     排除范围    不重写核心循环，不迁移 Whisper/Vision，不合并主线或发布发行版。
```

主工作区的未提交文件和并行 Agent 工作不进入本分支；本轮按最小可验证阶段提交并推送，最终核对远端门禁。

## 阶段与回退

1. 修复跨平台 CI：测试夹具、`.github/workflows/ci.yml`。保留全部核心断言，两个平台执行机械门禁及构建；Windows 执行真实进程测试。回退该提交恢复原夹具及单平台门禁。
2. 迁移只读工具：现有 MCP 服务、宿主授权适配器、视频应用层工具注入和测试。安装后工具可见、禁用后不可见，真实读取、抽帧与音频提取通过。回退该提交恢复阶段一的注册方式。
3. 迁移写出工具：相同适配边界及交付消费者测试。保留候选目录、生产调用、摘要、独占发布和取消约束；真实成片复核通过。回退该提交恢复阶段二的写出路径。
4. 拆分插件与技能：插件清单、安装升级及语义验收注入。独立安装、旧版升级、重启恢复和无绕过通过。回退该提交恢复阶段三的资源组织，保留用户数据。
5. 受控运行程序分发：仅 FFmpeg 需要的安装资源、来源与摘要、现有安装暂存/回滚及打包路径。Windows 无外部 Node/FFmpeg 配置的安装、更新、回滚通过。失败保留旧安装；回退代码不删除用户资源或成片。
6. 完整验收与三轮审查：自动化、真实媒体、Windows 安装版、远端 CI 和审查发现分别记录。未验证项目不得标为通过。各提交按逆序回退，不清除会话、设置或用户文件。

## 阶段一：跨平台 CI

真实失败来源：[Actions #64](https://github.com/wwxst/agent-desktop/actions/runs/38133151674)。完整日志保存于 `logs/ffmpeg-plugin/actions-64.log`。

完整日志包含 20 项测试失败、1 个未处理拒绝，分布于三份文件，并非只有十项错误：

- `main-entry.test.ts` 的 17 项生命周期测试在组装入口调用 `createCommandPort` 时因 Ubuntu 缺少 `SystemRoot` 提前失败，未到达各自验证目标；它们不执行系统进程，现显式提供解释器环境夹具，并使用 Windows 与 Linux 都能解析的正斜杠路径。
- `terminal-host.test.ts` 的 2 项审批与归属测试替换了原生 PTY，但仍依赖本机 `SystemRoot`；现提供相同边界夹具并在每项结束后还原，拒绝审批的断言保持。
- `agent-activity.test.ts` 的 1 项路径展示测试把 Windows 反斜杠路径送给 Linux 的本机 `basename`；改为本机临时目录路径，仍断言真实文件名与输入/输出角色。

这些问题在 Probe 之前的代码与测试中已存在；Probe 新增真实媒体测试在该次 Ubuntu 运行通过。未修改 Windows 专属生产解释器或进程清理逻辑，未新增跳过。原来的 Windows 专属进程用例继续保留，同时加入 Windows CI 矩阵和真实 FFmpeg 安装，以执行这些既有用例。

本机 Node `24.20.0`，pnpm `11.22.0`：冻结安装通过；聚焦 3 文件 46 项测试通过；`pnpm check` 59 文件 639 项测试全部通过，类型、架构与差异格式通过；`pnpm desktop:build` 通过。日志为 `stage-1-check.log`、`stage-1-build.log`。

阶段审查：仅修改测试夹具与现有 CI；全部原断言保留；无核心协议或生产行为修改。`Review Decision: PASS`。远端双平台结果待推送后验证，本文件不把本机绿色作为远端成功证据。

## 最终状态

实施中，尚未完成 FFmpeg 完整插件化正式验收。
