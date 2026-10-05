# 本地插件与技能验收

日期：2026-10-01。分支：`feature/plugins-skills`。本次实现用户明确要求的插件与技能，参考真实 Codex 页面截图；没有合并主分支或生成安装包。

## 结果

- 通过：插件与技能独立页面，搜索、安装筛选、详情、导入、启停、卸载确认和真实错误反馈。
- 通过：内置语义视频剪辑插件与本地文件检查技能；当前项目 `.agents/skills` 自动发现；按需加载技能正文。
- 通过：安装复制到当前应用目录，来源和启停状态存 SQLite；删除原导入目录后仍可读取，迁移安装根目录后路径正确。
- 通过：真实 MCP SDK 子进程的列举、调用、启动拒绝、工具拒绝、取消与关闭；取消和收尾等待同一次关闭。
- 通过：生产构建 Electron 中实际安装、重启恢复、导入插件、两次审批、技能加载、插件调用、最终回复及进程退出。
- 通过：桌面、800px 和 400px 实际截图无横向溢出，管理页往返保留原输入节点和草稿。

## 验证证据

```text
Check                     验证项目        结果
Frozen install            冻结依赖安装    corepack pnpm install --frozen-lockfile 通过。
Repository gate           仓库门禁        corepack pnpm check；49 个文件、526 项测试通过。
Desktop build             桌面构建        corepack pnpm desktop:build 通过。
Browser and Desktop       界面与桌面      corepack pnpm client:web:test；33 通过，1 项重复桌面尺寸跳过。
Focused Desktop retest    桌面重点复测    修正来源后复测真实桌面用例；1 通过，1 项重复尺寸跳过。
```

真实桌面输入：`$local-file-review 检查项目，调用插件 echo 返回 extension-e2e`。模型服务使用本地确定性 SSE 夹具，三次请求依次加载技能、调用 `p_fixture_local_echo`、生成回复。Provider、Agent Loop、Session、工具注册、插件 SDK、主进程、预加载桥和渲染层保持生产实现；只替换模型响应与原生目录选择结果。断言第二次请求包含技能正文，第三次包含插件实际响应，轮次结束后插件 PID 已退出。

截图位于 `logs/extensions-ui-20261001/`：

- `codex-plugins.png`、`codex-skills.png`：实际参考页面。
- `desktop-plugins.png`、`desktop-skills.png`：真实安装与启停状态。
- `desktop-plugin-approval.png`、`desktop-extension-result.png`：工具审批和完成结果。
- 400px 详情证据由 `apps/web/test-results/extensions.pw.ts-keeps-ext-80a60--details-contained-at-400px-chromium-desktop/plugin-narrow.png` 提供。

## 审查与修复

导入清理曾可能删除本次操作前已有的目录：改为先独占创建目标，再只清理本次创建的目录；保留文件反证测试通过。取消与收尾曾并行关闭连接，第二次调用提前返回：共享关闭 Promise，真实进程退出测试通过。同名本地导入曾依据目录标识误报“内置”：持久化真实来源，针对同名导入的断言通过。

```text
Review:
- Findings: 三项上述发现已修正；当前范围没有未解决的阻断问题。
- Required changes: 无。
- Decision: PASS。
```

## 未验收范围

未调用真实 DeepSeek 网络服务，因此不声称验证其自动匹配技能的模型质量。当前不支持远程市场、远程 MCP 或插件自定义环境变量；支持范围见 `docs/architecture.md`。未生成或验收安装包，内置资源分发要求见 `docs/engineering.md`。插件自身的外部程序和硬编码路径不会由客户端自动修复。既有视频语义行为未在本次重新执行真实媒体链路，仓库回归测试通过。
