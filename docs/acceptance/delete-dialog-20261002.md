# 会话删除弹窗验收

日期：2026-10-02。功能分支：`feature/settings-navigation`。

本次按用户“删除是弹窗”的要求，将侧栏内的会话删除确认迁移到独立原生模态弹窗。视觉行为以 `docs/desktop-ui.md` 为唯一来源；实现范围为共享客户端、样式及直接相关测试，不修改会话删除宿主接口、文件删除行为或其他项目确认面板。

吸收项：居中弹窗、背景遮罩、取消与红色确认按钮。禁止项：新增批量删除、文件删除、其他弹窗改造及第三方组件依赖。

验证环境：Windows、Node.js 24.20.0、pnpm 11.22.0。

- `corepack pnpm install --frozen-lockfile`：通过。
- `corepack pnpm check`：49 个测试文件、537 项测试通过，19 个工作区包架构检查通过。
- `corepack pnpm desktop:build`：通过。
- `corepack pnpm --filter @agent-desktop/web exec playwright test client-layout.pw.ts sidebar.pw.ts`：13 项通过；窄窗口项目中的重复 Electron 重启验收跳过 1 项，桌面项目真实重启验收通过。
- 实际查看 1280×720 与 800×600 截图：确认弹窗居中、长标题可滚动、按钮与保留文件说明可见。浏览器验证取消、Escape、返回焦点、确认目标、删除后焦点与长列表菜单；单元测试验证宿主失败时保留弹窗和会话并显示真实错误。

证据：`logs/delete-dialog-20261002/desktop.png`、`narrow.png`、`long-title.png`。

初次浏览器检查发现长名称的滚动区域获得初始焦点，已改为打开后明确聚焦取消；最终检查通过。

```text
Review:
- Findings: 已修复长名称初始焦点；确认成功后先解除等待状态再返回可用会话按钮。
- Required changes: 无。
- Decision: PASS
```

审查范围仅覆盖本次弹窗与直接调用链，沿用现有删除接口和菜单操作错误处理，无新依赖或核心逻辑。变更保留在功能分支，未提交、推送或合并。
