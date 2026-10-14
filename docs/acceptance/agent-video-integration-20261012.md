# Agent Core 与 FFmpeg 插件集成验收

日期：2026-10-12。集成分支：`feature/agent-video-integration`。

```text
Source                 来源             实际版本
D4 Agent Core          通用核心         e10dc1241fa67a9793ae28651ed5ca7f8ad514c2
FFmpeg plugin          FFmpeg 插件      42d6f6b934bbca090fd0cf495f01d7f4ff1aa15c
Common ancestor        共同祖先         49b8da974cc963f7068abb04423bed9628a8f6ae
Main                   主分支           49b8da974cc963f7068abb04423bed9628a8f6ae
Node / pnpm            本地工具链       v24.20.0 / 11.22.0
CI baseline            CI 基线          Node v24.19.0 / pnpm 11.22.0
```

## 集成结果

从 D4 分支创建独立集成分支后，以非快进合并保留 FFmpeg 最新分支历史。两条功能分支此前均未进入 `main`，共同祖先为当前 `main`，没有重复重放共享提交。冲突按文件和调用边界处理，未整文件覆盖。

保留了 D4 的 Context Manager、Task Plan、Failure Recovery、Session 持久化、主动恢复、取消和通用文件任务；保留 FFmpeg 插件清单、MCP 服务、运行资源、视频技能、Desktop 注入、CLI 本机工具和视频交付。集成修正了工具事实按 `turnId + stepId + toolCallId` 配对、只读媒体调用的检查点边界、恢复轮次固定工具集、MCP/媒体未知结果传播、旧终端断连观察和保存失败清理。

## 自动化验证

```text
PASS  pnpm install --frozen-lockfile
PASS  pnpm check: 77 files / 866 tests; typecheck, test typecheck, architecture and diff check
PASS  pnpm desktop:build
PASS  pnpm client:web:build
PASS  browser matrix: 69 passed / 15 skipped
PASS  focused safety, media, delivery and identity reviews
```

Browser matrix 使用 1280x720 和 800x600 Chromium 项目。15 个跳过项是窄视口不重复执行的真实 Electron 用例，或需要已安装发行版配置的覆盖安装与内置更新用例；本轮不发布安装包，因此没有将其写为通过。

## 真实边界

真实 Electron 媒体验收使用本地确定性模型/视觉 HTTP 夹具、仓库当前构建、Windows Electron、MCP、IPC、磁盘和本机 FFmpeg。证据目录为 `logs/ffmpeg-plugin/electron-1791777648087/`，覆盖插件安装、启动审批、工作目录和输入权限、取消、真实抽帧/音频/语义验收、候选写出、独占发布、禁用、卸载/重装及重启；`published.png` 显示真实已交付成片卡片。

独立 writer 取消证据为 `logs/integration/real-writer-cancel/evidence.json`：当前插件构建使用本机 WinGet FFmpeg/ffprobe 8.1.1，真实写出进程 PID 18844，取消后 54ms 退出，插件在关闭前仍可探测源媒体，输出文件停止增长。该证据不代表受控 8.1.2 安装包验收。

## 三轮 Review

```text
Architecture Review       架构审查        PASS
Findings                  发现            Core 边界、插件注入、完整工具身份、候选来源链均通过。
Safety Review             数据与错误安全  PASS
Findings                  发现            未知副作用、检查点、取消、旧终端、保存失败和审批边界均通过。
Regression Review         真实任务回归    PASS
Findings                  发现            MCP 媒体读写、真实取消、语义验收、交付发布和重启回归均通过。
```

未验证：在线 DeepSeek/Vision 服务质量、Whisper 真实模型质量、Windows 已安装发行版覆盖安装/线上更新、代码签名与发布分发。`main` 未修改；本轮没有发布安装包，也没有实施长视频架构重构。
