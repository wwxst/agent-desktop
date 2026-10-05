# 侧栏运行圆环与简短消息标题修复

日期：2026-10-02。分支：`feature/settings-navigation`。

用户截图中的运行标记呈斜长椭圆。真实生产原因是 `.sidebar-session span` 的弹性规则比 `.sidebar-running` 优先级高，圆环被按标题拉宽后旋转；窄窗口的同类规则还会隐藏圆环。标题改用独立 `.sidebar-session-title`，运行状态继续由现有 `isProcessing` 与活动会话身份决定。

视觉行为以 `docs/desktop-ui.md` 为准：圆环固定为 10px，窄窗口保留；折叠项目在窄窗口用圆环替代文件夹，折叠分区用圆环替代展开箭头。窄侧栏取消滚动条占位但保留滚动，避免标记挤压菜单。吸收项为已有运行状态的形状、尺寸和可见性；不新增进度百分比、状态类型或导航功能。

上一轮已只读核对用户本机数据库：截图上下两项属于同一个会话，首条消息为“1”，非手动标题保存了模型整句“未提供任务内容，无法生成标题。”。现在数字首条消息直接保留原文；模型边界拒绝整句命名失败说明，正常任务标题可以包含相关词语。未修改用户数据库或批量替换已有标题。

验证环境：Windows、Node.js 24.20.0、pnpm 11.22.0。

- `corepack pnpm check`：50 个测试文件、545 项测试、19 个工作区包架构检查通过，输出 `logs/sidebar-running-gate.txt`。
- `corepack pnpm desktop:build`：通过，输出 `logs/sidebar-running-build.txt`。
- `corepack pnpm --filter @agent-desktop/web exec playwright test sidebar.pw.ts client-layout.pw.ts`：15 项通过，1 项重复窄窗口桌面重启验收跳过，输出 `logs/sidebar-running-check.txt`。覆盖运行中会话、项目及分区折叠、取消后圆环消失、长列表菜单命中和宽窄窗口布局；桌面重启验收沿用真实 IPC 与 SQLite。
- 简短消息命名通过实际函数与当前配置模型服务验证：“1”直接返回“1”，“你好”的真实模型请求返回“你好”。输出 `logs/sidebar-running-20261002/real-title-result.txt`。未把本地响应夹具描述成外部模型验证。
- 实际查看 1280×720 与 800×600 的会话行、折叠项目、折叠分区六张截图：圆环保持正圆，菜单未被挤压，无横向溢出。证据 `logs/sidebar-running-20261002/desktop.png`、`narrow.png`、`narrow-collapsed.png`、`narrow-section.png`。

验证中发现窄侧栏原有固定滚动条槽位导致分区圆环与菜单挤压，已修复并复查长列表；原长列表断言要求按钮严格小于滚动条起点，窄窗口隐藏滚动条后允许贴齐内容边界，保留实际按钮命中与无水平滚动断言。

```text
Review:
- Findings: 标题规则误拉伸和隐藏圆环；窄侧栏槽位挤压分区；数字消息生成命名失败说明。均已修复。
- Required changes: 无。
- Decision: PASS
```

范围审查仅覆盖运行标记、直接受影响的侧栏样式与测试、标题模型边界。没有新依赖、核心运行逻辑或数据库结构；没有批量改动用户历史。变更未提交、推送或合并；主进程命名修复需重启桌面应用后加载。
