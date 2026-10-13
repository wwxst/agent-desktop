# 模型路由与输入框选择器验收（2026-10-13）

分支为 `feature/chat-model-routing`，基线为 `cc8eecd1c680341c593b1d467cc9dc5d205d7cc9`。本次只提交独立分支，不推送或合并 `main`；原有无关未跟踪文件保留。准确提交标识由该分支 `git log -1 --format=%H` 读取，避免文档自引用提交。

用户现在可以在发送按钮左侧选择当前对话模型。聊天与设置共用保存成功后的配置，视觉默认跟随；高级备用默认关闭，仅主模型明确不支持且备用已启用、能力和密钥有效时使用。未知能力阻止自动视觉路由，运行异常不改变模型。旧配置保留供应商、模型和密钥，旧视觉引用仅迁移为关闭的备用候选。实际行为与后续生成能力边界以 [架构文档](architecture.md) 为准，界面基线以 [桌面界面文档](desktop-ui.md) 为准。

```text
Result                  中文状态        中文介绍
PASS                    通过            已执行且符合所述验收范围。
SKIP                    跳过            未执行，不代表该能力已通过。
HTTP Fixture            本地接口夹具    验证真实宿主协议与状态，不能代替外部模型服务。
Real API                真实模型接口    请求真实供应商服务并核对结果。
```

## 自动化与界面

环境为 Windows、Node.js `24.20.0`、pnpm `11.22.0`。本机 Node 高于仓库声明的最低版本，未在 CI 的 `24.19.0` 上重复执行。

- `corepack pnpm install --frozen-lockfile`：PASS。
- `corepack pnpm check`：PASS；58 个测试文件、666 项测试，生产与测试类型检查通过，19 个工作区包架构检查及差异格式检查通过。
- `corepack pnpm client:web:test`：PASS；包含桌面构建，69 项浏览器及 Electron 验收通过，9 项按项目条件跳过重复桌面或不适用执行。
- `corepack pnpm desktop:dev`：PASS；正式开发入口实际加载 `http://127.0.0.1:5173/`，窗口标题为 Agent Desktop，约 1105×753；只读检查菜单位置、当前 Flash 选中及未配置密钥项禁用，随后正常关闭本次窗口。
- 新测试覆盖主模型与备用路由、未知能力、文本输入要求、运行错误不切模型、能力随端点重新确认、旧配置迁移、网页恢复及存储失败、保存失败不更新选择、保存中阻止新发送而保留停止动作、模型切换保持草稿和附件，以及真实 IPC（进程通信）中的运行快照与重启恢复。
- 反证验收：临时恢复旧“任务运行期间禁止全部设置保存”的主进程判断并重建，新增 Electron 模型切换测试在“第二模型应显示”处失败；恢复最终源码并重建后同一测试通过。`counterexample-result.json` 记录缺陷版本退出 1、修正版本退出 0，最终源码已还原。
- 菜单覆盖 1280×720、800×600、400×500、150% 页面缩放、浅色及深色主题、长名截断、内部滚动、上方优先展开、窗口边缘避让、Escape、方向键、Home、End、Tab 和外部关闭。截图经实际查看，发送按钮仍在命中范围内。
- 中文输入法组合事件与原发送快捷键由组件测试覆盖；未进行系统输入法的人工连续输入验收。150% 使用页面缩放，未单独覆盖 Windows 系统 DPI（显示缩放比例）。

截图位于本机忽略目录 `logs/model-routing-20261013/`：`model-menu-light-1280-1.png`、`model-menu-dark-400-1.png`、`model-menu-dark-800-1.5.png`、`desktop-model-menu.png`、`desktop-running-model-switch.png`、`desktop-model-restored.png`、`desktop-dev-model-menu.png`。完整自动化测试可从仓库命令复跑；本机原始截图和 API 日志未进入 Git。

## 真实模型与视频

2026-10-13 使用环境中的 DeepSeek 凭据请求官方 `/models`。实际元数据为 `deepseek-flash` 输入文本和图片、输出文本，`deepseek-v4-pro` 只输入输出文本；结论只覆盖具体模型与协议，不外推整个供应商。依据为 [官方模型目录](https://api-docs.deepseek.com/api/list-models)、[视觉指南](https://api-docs.deepseek.com/guides/vision) 及 `deepseek-models-authenticated.json`。

- `node logs/model-routing-20261013/real-vision.mjs`：PASS，正式 `AnalyzeImagesTool`（图片观察工具）分别以 Chat 和 Responses 两种协议识别真实红色 PNG。Chat 曾因 `json_schema` 不可用返回 HTTP 400，修正为官方 JSON 模式后通过；必要观察结构由工具解析边界检查。
- `node logs/model-routing-20261013/real-video-run.mjs`：PASS，正式 `loadRuntimeConfiguration → createVideoAgent → runTurn`，当前 Flash、备用关闭。23 次真实 DeepSeek 请求均成功，其中图片请求 6 次；完成抽帧、边界细化、剪辑、完整解码、逐帧独立语义验收和发布。
- 第一候选的红色首帧被语义验收拒绝；Agent 修正后交付 `blue-only-delivered.mp4`。独立 ffprobe 核验 H264、320×240、2fps、3 秒、6 帧、1803 字节；全文件解码通过，每帧 RGB 均为 `(0,0,255)`。
- `node logs/model-routing-20261013/real-fallback-run.mjs`：PASS，主 Pro + 显式启用备用 Flash；3 次真实对话请求使用 Pro、1 次真实图片请求使用 Flash，全部 HTTP 200，父对话模型没有被替换。
- OpenAI 真实外部 API：SKIP，环境缺少 `OPENAI_API_KEY`；两种协议的本地接口夹具已通过，但不代表 OpenAI 服务已验证。本次真实视频无音轨，未触发真实语音识别；已有语音与视频测试完整回归通过。

对应原始证据为 `real-vision-result.json`、`real-video-result.json`、`real-video-console.jsonl`、`real-fallback-result.json`，不含 API 密钥。纯色视频证明现有工具闭环与路由有效，不代表自然视频语义准确率。

## 品牌图标补充验收

按用户后续截图要求，模型菜单的 DeepSeek 与 OpenAI 字母占位改为对应品牌的本地单色图标；自定义供应商继续使用首字占位。只改选择器、样式和界面文档，未改变模型路由。`corepack pnpm check` 666 项 PASS、`corepack pnpm desktop:build` PASS，模型选择器浏览器专项 3 项 PASS、1 项跳过重复 Electron 项目。浅色实际开发窗口及深色 400px 截图经查看通过；窗口刷新后显示鲸鱼与结绳图标。证据为 `desktop-provider-brand-icons.jpg` 与浏览器测试输出的 `model-menu-dark-400-1.png`。独立审查无待修改项，结论 PASS；本次纯图标修改不涉及外部 API。

按后续“弹窗窄一点”要求，菜单由 300px 收窄为 240px。完整检查仍为 666 项 PASS，桌面构建 PASS，原模型选择器专项 3 项 PASS、1 项跳过重复执行；实际开发窗口、深色 400px 长名截图均通过，正常 Flash 名称完整可读，发送与配置入口可达。独立审查 PASS，无待改项；证据为 `desktop-model-menu-240px.jpg`。仅修改样式与对应文档，不涉及外部 API。

按后续“继续收窄”要求，菜单进一步由 240px 收窄为 210px。`corepack pnpm check` 58 个文件、666 项测试 PASS，19 个工作区包架构检查 PASS；`corepack pnpm desktop:build` PASS。现有模型选择器浏览器专项 3 项 PASS、1 项跳过重复 Electron 执行，覆盖主题、窄窗口、缩放、长名及键盘操作。实际开发窗口与深色 400px 长名截图经查看，品牌图标、选中标记、配置入口和发送按钮正常可达；开发窗口保持运行。独立审查 PASS，无待改项；实际窗口证据为 `desktop-model-menu-210px.jpg`。仅修改样式与对应文档，不涉及外部 API。

按后续取消设置页重复选择入口的要求，“当前对话模型”改为共享已保存配置的只读文本，切换统一在聊天输入框完成。供应商编辑、删除目录后的有效引用调整与高级备用视觉配置保留。`corepack pnpm check` 58 个文件、665 项测试 PASS，19 个工作区包架构检查 PASS；移除的一项是旧设置页选择器保存失败测试，聊天保存失败测试仍在。`corepack pnpm client:web:test` 含桌面构建 PASS，69 项通过、9 项按原项目条件跳过；全部浏览器修改完成后测试类型检查再次 PASS。真实桌面 IPC（进程通信）覆盖聊天选择、自定义供应商两种协议请求、持久化、重启及运行中任务快照；接口使用本地夹具，不代表外部模型验证。浅深主题与 400px 长名换行经截图查看，实际开发窗口刷新后确认只有只读名称并保持运行。证据为 `desktop-current-model-readonly.jpg`、`settings-current-model-dark-400.png` 与 `settings-current-model-light-1280.png`。独立审查 PASS，无待改项；本次不涉及运行时路由或外部 API，未重复真实视频调用。

按后续确认的简化要求，删除设置页整个当前对话模型块、独立备用启用开关和长说明；高级设置只保留“备用视觉模型”下拉与一句短说明。默认显示“关闭”，主动选择有效模型同次保存候选并启用，关闭保留旧候选；保存失败保持原状态。关闭候选所属供应商被用户删除时，同次清空候选，当前对话或启用的备用引用仍受到保护。`corepack pnpm check` 58 个文件、672 项测试 PASS，19 个工作区包架构检查 PASS，桌面构建 PASS。初次浏览器执行中两项网页测试误用桌面接口，修正为读取现有网页持久化配置后，`corepack pnpm --filter @agent-desktop/web exec playwright test --config playwright.config.ts --workers=4` 完整回归 69 项 PASS、9 项按原条件跳过。补充真实桌面单下拉启用、关闭及两次重启恢复后，模型专项 3 项 PASS、1 项跳过重复执行，测试类型检查 PASS；夹具请求不冒充真实外部模型验证。浅深主题、400px 窄窗口及正式开发入口重启后真实窗口经查看通过，窗口保持运行。证据为 `desktop-vision-backup-simplified.jpg`、`settings-vision-backup-dark-400.png`、`settings-vision-backup-light-1280.png`、`desktop-vision-backup-enabled-restored.png` 与 `desktop-vision-backup-disabled-restored.png`。独立审查 PASS；视觉路由及任务快照未修改，未重复真实视频调用。

## 审查

```text
Review:
- Findings: 已修复自定义端点继承官方能力、恢复默认能力、备用缺文本输入、JSON 空观察四项问题。
- Required changes: 无。
- Decision: PASS。
```

独立复审确认能力未知、凭据缺失和运行失败均不能触发备用；当前任务保持快照，客户端只显示保存成功状态。没有新增依赖、包、生成业务或任务调度抽象。自定义模型能力由用户按实际模型和协议明确确认，客户端不声称已进行自动连通或能力探测。

## 修改文件

- `packages/client/src/api.ts`、`model-defaults.ts`、`model-capabilities.ts`、`index.ts`、`packages/client/package.json`：能力与模型引用契约、默认目录、统一路由及真实宿主使用的导出。
- `packages/client/src/App.tsx`、`components/Composer.tsx`、`components/ModelSelector.tsx`、`components/RuntimeSettingsPanel.tsx`、`components/ModelProvidersSettings.tsx`、`styles.css`：共享配置状态、输入框菜单、高级备用与三态参数、主题和布局。
- `apps/desktop/src/main/runtime-settings.ts`、`index.ts`：旧配置解析、发现与持久化、供应商解析、启动快照和运行期间的后续模型切换。
- `apps/web/src/webClientApi.ts`、`runtime-settings-storage.ts`：网页开发宿主的脱敏配置恢复及保存失败一致性。
- `packages/video-agent/src/index.ts`、`packages/vision-openai/src/index.ts`：视觉不可用原因、已验证的 DeepSeek JSON 协议及必要观察校验。
- `packages/client/tests/app.test.tsx`、`client-api.test.ts`、`model-settings.test.tsx`、`model-routing.test.ts`：共享状态、快捷键、保存失败、能力和路由。
- `apps/desktop/tests/app.test.tsx`、`main-entry.test.ts`、`runtime-settings.test.ts`：迁移、供应商配置和运行快照。
- `apps/web/tests/web-client-api.test.ts`、`tests/browser/model-selector.pw.ts`、`settings.pw.ts`、`desktop-extensions.pw.ts`：网页持久化、真实桌面切换与重启、菜单视觉和既有契约回归。
- `packages/vision-openai/tests/vision-openai.test.ts`：协议请求、运行错误及不完整观察失败。
- `README.md`、`docs/architecture.md`、`docs/desktop-ui.md`、本文：当前行为、扩展边界与验收记录。
