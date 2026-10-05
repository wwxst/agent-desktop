# 设置中的归档对话管理验收

日期：2026-10-02。分支：`feature/settings-navigation`。

用户要求移除侧栏底部“已归档”，在设置中管理归档对话。实际打开 Codex 设置，观察设置导航中的“已归档”分组及“已归档的聊天”分类；截图在工具结果中查看，未修改 Codex 会话数据。实现采用本项目“已归档的对话”分类，只吸收设置导航位置和已有归档操作，不增加其他 Codex 分类、搜索或批量操作。

侧栏底部及分区选项中的旧归档入口、替代最近列表状态和对应样式已删除。侧栏保留归档当前会话和项目会话的动作。设置列表直接读取现有会话集合，支持查看原历史、恢复和删除；空列表有明确说明。侧栏与设置共享 `App` 中唯一的删除弹窗，保留默认取消、Escape、失败不删除、等待期间禁用与焦点返回。没有新数据库字段、接口、依赖或模型请求。

交互事实以 `docs/desktop-ui.md` 为准，组件职责以 `docs/architecture.md` 为准。

验证环境：Windows、Node.js 24.20.0、pnpm 11.22.0。

- `corepack pnpm check`：50 个测试文件、546 项测试通过，19 个工作区包架构检查通过；`logs/archive-settings-check.txt`。
- `corepack pnpm desktop:build`：通过；`logs/archive-settings-build.txt`。
- `corepack pnpm --filter @agent-desktop/web exec playwright test sidebar.pw.ts client-layout.pw.ts settings.pw.ts`：18 项通过，2 项重复窄窗口桌面重启验收跳过；`logs/archive-settings-browser.txt`。覆盖设置分类、归档查看恢复、删除取消与确认、空列表、长列表菜单、运行标记和宽窄布局。
- `corepack pnpm --filter @agent-desktop/web exec playwright test new-chat.pw.ts web-client-smoke.pw.ts`：通过；`logs/archive-settings-draft-check.txt`，验证共用删除弹窗后草稿和最后一条历史删除流程。
- 真实构建 Electron 在隔离应用数据目录，通过原预加载桥与 SQLite 验证项目归档、重启后设置列表、原目录与草稿恢复、只读历史和恢复后继续原会话；未修改用户实际数据目录。
- 实际查看桌面设置归档列表、800×600 窄窗口列表和空列表截图：标题与恢复、删除按钮可见，无横向溢出。归档页独立于运行时配置加载，自动保存设置行为保持正常。

证据位于 `logs/archive-settings-20261002/`：`desktop-archive-settings.png`、`narrow-archive-settings.png`、`empty.png`、`desktop-sidebar.png`。真实桌面重启检查复用既有侧栏浏览器测试。

```text
Review:
- Findings: 删除确认提升到 App，由两个真实入口共用；移除旧归档列表状态与无消费者样式。
- Required changes: 无。
- Decision: PASS
```

审查范围为共享客户端入口迁移、直接调用链、删除弹窗焦点与错误处理、相关测试和文档。不改智能体核心、宿主存储或归档事实。变更未提交、推送或合并。
