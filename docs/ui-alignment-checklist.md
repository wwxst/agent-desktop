# 界面对齐清单

本轮对照 `E:\JavaProjects\web-project\deepseek-harness` 的实际源码与运行界面。视觉规则唯一来源为 [desktop-ui.md](desktop-ui.md)，本文只维护差异、任务、依赖和验收记录。

## 范围与推进顺序

2026-09-17，沿用 `feature/client-layout-review`。开始时已有 `App.tsx`、样式、桌面/共享客户端测试、视觉文档和浏览器布局测试的本地修改，保留并继续使用。参考项目只读，运行数据隔离在系统临时目录。

```text
Goal          目标      对齐视频剪辑客户端对应区域的视觉与交互，并分开记录界面和功能状态。
Problem       问题      现有缩小版布局与参考的字号、宽度轴、附件、输入区和设置呈现有差异。
Impact scope  影响范围  共享客户端组件、样式、相关测试和视觉文档；桌面与网页共用。
Non-goals     排除范围  不迁移参考插件、状态管理、权限系统、工作区运行时，不修改智能体核心。
```

- [x] 检查分支、本地差异、两项目源码和可运行入口。
- [x] 建立逐项清单；记录参考、当前组件和状态。
- [x] 完成本轮已有组件调整并连接原业务；搜索、预览以禁用状态明确标识。
- [x] 执行测试、构建、同尺寸网页真实渲染与截图对照；原生桌面截图受阻，见验收限制。
- [x] 更新验收结果、功能补齐依赖和唯一视觉规范。

界面状态使用“待处理 / 进行中 / 已对齐”。功能状态使用“已实现 / 部分实现 / 待实现 / 不适用”。“已对齐”只用于覆盖范围有实际渲染证据的项目；界面代码完成但缺少真实状态证据时保持“进行中”。不适用项的界面状态保留“待处理（不纳入）”，不冒充完成。

下表参考路径均相对参考仓库的 `packages/client/`；本项目路径相对 `packages/client/src/`。

## 对照项目

| 编号 / 界面项 | 参考位置 | 当前组件与具体差异 | 界面状态 | 功能状态 | 后续任务 / 依赖 | 验收结果 |
| --- | --- | --- | --- | --- | --- | --- |
| 01 主题、字体、边界、阴影 | `ui-theme/src/styles/` | `styles.css`；已调整字体栈、次级灰、轻描边和阴影，采用参考浅色层级 | 已对齐 | 已实现 | 深色与字号偏好另列 24 | 空态、设置和内容截图已核对；E1/E2/E3 |
| 02 侧栏骨架 | `ui-sidebar/src/client/SidebarRoot.module.css`、`ui-layout` | `App.tsx`、`styles.css`；侧栏由 240 调为参考桌面宽度；导航字号与新会话顺序已调整；移除无操作价值的“本地运行”状态行 | 已对齐 | 已实现 | 保留纯文字品牌、视频工作区与独立会话标签；“设置”是侧栏最底部的唯一操作；窄侧栏宽度差异见下文 | 桌面/窄窗口与 40 会话均可达，设置底边位置有浏览器断言；E1/E7 |
| 03 新会话、会话列表与菜单 | `ui-workspace/src/client/rows/` | `App.tsx`；保留已有会话菜单、重命名、删除及滚动修复；字号已调整 | 已对齐 | 已实现 | 沿用真实会话接口，不引入参考树状工作区 | 40 会话、长标题、菜单边缘、Enter/Escape/失焦通过；E7 |
| 04 会话搜索 | `ui-workspace/src/client/rows/WorkspaceBrowser.tsx` | `App.tsx`；新增禁用搜索入口与可见“搜索待接入” | 已对齐（仅入口） | 待实现 | 界面已完成，功能待实现；后续本地标题/消息过滤 | 截图与禁用断言通过，不产生虚假搜索结果；E1 |
| 05 空会话 | `ui-conversation/src/client/skeleton/HeroShell.module.css` | `App.tsx`；视频图标改为标题同行，标题和输入组合已调整 | 已对齐 | 已实现 | 保留视频任务文案；不复制工作区/模式选择 | 1100×750 空态同尺寸对照通过；560×320 可滚动；E1/E7 |
| 06 对话与输入宽度轴 | `ui-conversation/src/client/skeleton/ConversationRoot.module.css` | `styles.css`；统一阅读轴，输入区比正文宽，沿用历史独立滚动 | 已对齐 | 已实现 | 参考滚动槽仍造成约 5px 中心偏差，未声称像素完全一致 | 桌面/窄窗口无水平溢出，输入不覆盖历史；E3/E7 |
| 07 用户文本与长文本 | `ui-chat/src/client/chat/MessageItem.module.css` | `App.tsx`；用户气泡已调整为参考浅蓝、圆角和留白，保留长文本换行 | 已对齐 | 已实现 | 消息时间/复制另列 27；参考样本文字与视频任务不同 | 长文本、已提交附件和失败正文可读；E3/E4/E7 |
| 08 智能体正文与流式输出 | `ui-chat/src/client/chat/AssistantMarkdown.tsx` | `App.tsx`；纯文本行距已对齐；参考列表、代码、链接等富文本仍缺失 | 进行中 | 部分实现 | 富文本需确定解析器与链接/本地资源边界 | 纯文本与流式展示通过；富文本尚未实现；E4 |
| 09 输入框与自动增高 | `ui-conversation/src/client/skeleton/InputBar.module.css` | `Composer.tsx`；空态/活跃态高度、工具栏间距、阴影已调整 | 已对齐 | 已实现 | 沿用同一个输入节点与草稿，高度超过上限内滚动 | 多行草稿、状态切换、短窗口通过；E1/E4/E7 |
| 10 发送、停止和键盘 | 同上及输入键位实现 | `Composer.tsx`；Enter 已连接原发送操作，Shift+Enter/输入法组合保持原生输入 | 已对齐 | 已实现 | 不接入参考排队发送；停止使用已有取消接口 | 单元测试与浏览器 Enter、停止及禁用检查通过；E4 |
| 11 附件文件卡 | `ui-attachment/src/FileCard.module.css` | `AttachmentChip.tsx`、`styles.css`；文件卡尺寸、字号、图形容器和圆角已调整 | 已对齐 | 已实现 | 视频图形与参考通用文件图形按类型不同 | 卡片与长文件名真实渲染已核对；E3/E7 |
| 12 附件轨道及移除 | `ui-attachment/src/AttachmentRail.module.css` | `Composer.tsx`、`App.tsx`；保留横向轨道，提交附件右对齐，移除预留名称空间 | 已对齐 | 已实现 | 系统文件选择、追加、移除沿用现有宿主接口 | 8 个长名称、悬停不位移、移除及处理中禁用通过；E3/E7 |
| 13 附件拖入、粘贴、上传进度 | `ui-attachment/src/DropOverlay.tsx`、`FileCard.tsx` | 当前仅接通系统文件选择器，没有拖入/粘贴覆盖层；本地选择无网络上传 | 待处理 | 部分实现 | 拖入依赖桌面路径解析和视频选择契约；网络上传进度不适用 | 本轮只验既有选择/移除，不伪造上传或拖入状态 |
| 14 工具摘要与展开 | `ui-chat/src/client/chat/TurnProcessNodeView.module.css` | `ToolActivity.tsx`；摘要细分隔、字号、矢量箭头和紧凑行已调整 | 已对齐 | 已实现 | 保持运行展开、终态折叠；参考嵌套过程另列 16 | 参考展开/折叠与当前 8 工具对照；E3/E7 |
| 15 工具运行/成功/失败/停止 | `ui-tool/src/client/tool/components/ToolRow.module.css` | `ToolActivity.tsx`；已替换状态字符为矢量图形，保留真实状态/耗时来源 | 进行中 | 已实现 | 当前各状态已验；参考实时处理中/取消态尚未取得同状态截图 | 成功/失败参考可见；当前四种状态可见；不把缺少参考证据算通过；E3/E4 |
| 16 工具参数、输出详情 | `ui-tool/src/client/tool/` | 当前只展示名称、状态、耗时，没有参考的参数、输出或嵌套详情 | 待处理 | 待实现 | 依赖工具事件可展示输入/输出字段与敏感数据边界 | 仅记录依赖，不虚构工具内容；参考详情见 E3 |
| 17 产物卡与打开文件 | `ui-deliverables/src/client/Deliverables.module.css`、`PresentedFileCard.tsx` | `ArtifactCard.tsx`；由顶部线条结果行改为参考浅底文件卡，图形和动作组已调整 | 已对齐 | 已实现 | 打开文件沿用当前轮产物回调，参考通用文件更多操作不纳入 | 产物与长名称截图通过；单元测试确认对应文件回调；E3/E7 |
| 18 视频内嵌预览 | `ui-deliverables/src/client/PresentedFileCard.tsx` 的预览入口 | `ArtifactCard.tsx`；完成禁用预览入口和“预览待接入”状态，没有播放器 | 已对齐（仅入口） | 待实现 | 界面已完成，功能待实现；播放器依赖桌面媒体访问协议与格式支持 | 禁用预览、可用打开文件断言通过；未声称可播放；E3/E4 |
| 19 设置容器与字段 | `ui-settings-general/src/client/SettingsRoot.module.css` | `RuntimeSettingsPanel.tsx`；整页单列改为模态面板、左导航、右侧独立滚动，导航、分区和字段说明统一使用中文 | 已对齐 | 已实现 | 只接对话模型、视觉模型、语音识别和视频处理现有字段；窄屏有意缩小导航 | 同尺寸容器对照、中文标签、分区定位、关闭与草稿保留通过；E2/E5 |
| 20 设置加载、保存、失败、禁用 | `ui-settings-models`、`ui-settings-general` | `RuntimeSettingsPanel.tsx`；修复加载错误被加载文案遮挡；保存/清除错误使用警告语义 | 已对齐 | 已实现 | 沿用真实保存接口；不复制参考配置文件/权限设置 | 加载、加载失败、保存及 Key 不回显、处理中禁用通过；保存失败截图未单独覆盖；E5/E6 |
| 21 对话失败与取消 | `ui-chat/src/client/chat/ChatView.module.css` | `App.tsx`；错误与取消图形、正文轴已调整，草稿与已完成产物保留 | 进行中 | 已实现 | 当前失败/取消已验；参考任务取消、顶层任务失败未取得相同状态证据 | 当前失败、取消截图及行为通过；参考只覆盖工具失败；E4 |
| 22 滚动与窄窗口 | `ui-layout`、`ui-conversation` | `styles.css`；保留已有历史/输入独立滚动和窄侧栏，修正当前组件溢出 | 已对齐 | 已实现 | 窄侧栏为保留会话操作采用 72px，参考为 56px；不是逐像素复制 | 7 种尺寸、长会话、长内容与短空态通过；E7 |
| 23 悬停、聚焦、禁用、过渡 | 各组件样式及 `ui-theme` | `styles.css`；补齐轻量颜色过渡、按下态、矢量图标、减少动画规则 | 进行中 | 已实现 | 焦点/禁用/悬停已验；尚未逐帧比较参考过渡时序 | 菜单键盘、模态焦点、附件悬停通过；动画仅源码审查，不作全状态对齐结论 |
| 24 外观、字号偏好 | `ui-theme/src/client/AppearanceRow.tsx`、`FontSizeRow.tsx` | 当前仅浅色和固定字号，没有参考外观/字号设置面板 | 待处理 | 待实现 | 后续依赖偏好持久化、深色全状态验收 | 本轮只记录缺失，未制作或接入这部分设置 |
| 25 模型/权限/模式选择、队列与计划 | `ui-model-selection`、`ui-permission-presets`、`ui-plan`、`ui-conversation/src/client/queue` | 本项目设置已有模型字段，执行中支持停止 | 待处理（不纳入） | 不适用 | 当前视频剪辑阶段不采用参考权限、计划、队列和多供应商运行时 | 按项目边界排除 |
| 26 插件、工作区切换、轨迹页、统计、通用文件侧栏 | `ui-settings-plugins`、`ui-workspace`、`ui-trajectory`、`ui-sidebar-files` | 当前单视频工作区与本地诊断日志 | 待处理（不纳入） | 不适用 | 不迁移参考平台能力；视频预览单独列 18 | 按项目边界排除 |

| 27 消息复制与时间 | `ui-chat/src/client/chat/MessageItem.tsx` 及消息操作区 | 当前没有复制入口/消息时间；产物已提供文件名提示 | 待处理 | 待实现 | 复制依赖宿主剪贴板权限，时间依赖消息持久化字段 | 已记录；不虚构历史时间 |
| 28 反馈、对话分支、用量统计 | `ui-chat` 的消息底部操作 | 当前没有相应产品接口 | 待处理（不纳入） | 不适用 | 当前视频剪辑阶段不采用评分、分支会话、计费统计 | 按项目边界排除 |
| 29 指令、文件提及、多语言设置 | `ui-conversation`、`ui-settings-general` | 当前自然语言视频任务与中文设置 | 待处理（不纳入） | 不适用 | 当前没有通用命令、资源提及或多语言产品需求 | 不增加通用平台入口 |

## 验收证据

本轮日期：2026-09-17。以下图片是实际页面渲染截图；拼图仅在原图外添加左右标签，未重绘界面。当前项目通过共享客户端网页入口验证，任务、附件与产物来自开发宿主或显式测试数据，不证明本轮真实模型/FFmpeg 执行成功。对应真实接口的业务连接由已有应用代码及行为测试确认。

| 证据 | 内容与实际结果 | 文件 |
| --- | --- | --- |
| E1 空会话 | 两侧均 1100×750；欢迎组合、输入宽度、侧栏、新会话；参考尚未选择工作区，因此输入呈禁用虚线，当前可直接纯文本发送 | [同尺寸对照](ui-alignment/compare-empty.png)、[当前窄窗口](ui-alignment/current-empty-560.png) |
| E2 设置 | 两侧均 1100×750，比较模态容器和左右布局；字段按各自产品不同；窄屏当前滚至保存操作以验证可达性 | [同尺寸对照](ui-alignment/compare-settings.png)、[560×600 对照](ui-alignment/compare-narrow-settings.png) |
| E3 正文、附件、工具、产物 | 参考来自历史测试记录，当前为视频任务测试数据；附件类型/文案不同，比较对应组件状态 | [参考附件](ui-alignment/reference-attachment-1100.png)、[当前附件](ui-alignment/current-attachment-1100.png)、[参考工具展开](ui-alignment/reference-content-expanded-1100.png)、[参考工具失败](ui-alignment/reference-tools-failure-1100.png)、[产物对照](ui-alignment/compare-artifacts.png) |
| E4 当前执行状态 | 1100×750 和 560×600 检查流式处理、停止、完成、失败；输入节点保持、草稿保留、产物操作状态正确 | [处理中](ui-alignment/current-processing-1100.png)、[停止](ui-alignment/current-cancelled-1100.png)、[成功](ui-alignment/current-success-1100.png)、[失败](ui-alignment/current-failure-1100.png)、[窄屏成功](ui-alignment/current-success-560.png)、[窄屏失败](ui-alignment/current-failure-560.png) |
| E5 设置状态 | 加载态、加载失败均真实渲染；Escape/关闭恢复焦点；处理中禁止修改 | [加载](ui-alignment/current-settings-loading.png)、[加载失败](ui-alignment/current-settings-error.png)、[最窄设置](ui-alignment/current-settings-400x500.png) |
| E6 自动检查 | `corepack pnpm check`：28 个测试文件、217 项测试通过，类型检查和 18 个包的架构检查通过；`desktop:build`、`client:web:build` 均通过；`client:web:test`：14 项通过 | [共享组件测试](../packages/client/tests/app.test.tsx)、[状态浏览器测试](../apps/web/tests/browser/ui-alignment.pw.ts)、[布局浏览器测试](../apps/web/tests/browser/client-layout.pw.ts) |
| E7 长内容与响应式 | 1100×750、1120×760、1280×720、800×600、760×600、560×600、400×500 检查内容/设置；另验 560×320 空态、40 会话、8 工具与长附件 | [8 工具/长草稿](ui-alignment/current-content-1100x750.png)、[窄屏内容](ui-alignment/current-content-560x600.png)、[长列表](ui-alignment/current-many-sessions.png)、[删除确认](ui-alignment/current-delete-confirmation.png)、[短窗口](ui-alignment/current-short-empty.png)、[历史独立滚动](ui-alignment/current-history-and-composer.png) |

其余尺寸的原始截图位于 [ui-alignment/](ui-alignment/)；文件名直接标注宽高或状态。浏览器截图关闭动画以取得稳定终态，不能据此证明动画时序与参考一致。

### 参考运行方式与限制

参考使用已有 `apps/cli/lib/bin.js web --host 127.0.0.1 --port 4180 --no-open`，`DSH_HOME` 指向系统临时目录 `agent-desktop-ui-reference-20260917`。构建标识为 `0.1.5-rc.2-c291e79-dirty`，参考已有 SDK 本地修改保持原状；未构建或改写参考源码。

参考网页目录选择入口不可用。为观察内容状态，使用参考自身持久化模块，将仓库已有 `snapshots/web/seeded-history`、`present`、`file-upload-round` 的历史记录写入隔离运行目录，再由真实页面读取。没有执行记录中的命令、重新调用模型或伪造本次执行成功。附件样本的图片文件未复制，因此参考显示真实“图片加载失败”；其普通文件卡仍可对照。产物样本只用于展示，不验证文件打开或预览。

原生 Electron（桌面运行时）开发应用已经运行并确认标题为 Agent Desktop，但截图接口报 `SetIsBorderRequired failed: 不支持此接口 (0x80004002)`，原生桌面截图验收未通过。本文的“已对齐”限定于已核对的共享渲染界面，不代表整个原生桌面验收完成。桌面系统文件选择、系统播放器打开和真实模型/视频剪辑，本轮未重新执行端到端验证。

参考实时处理/取消、顶层任务失败，以及完整悬停/焦点/动画组合尚缺同状态实拍证据，相关项保持进行中。当前这些执行状态已有测试宿主的真实组件截图。

### 保留的产品差异与审查

- 当前保留纯文字品牌、视频工作区、会话标签、轻量 Agent 标记及诊断编号；不复制参考顶部栏、轨迹、权限/模型快捷选择、用量页脚。参考新会话必须选工作区，当前支持直接发送纯文本。
- 窄窗口当前保留会话按钮及操作列，侧栏宽于参考；设置导航收窄以保证字段可编辑。导航采用现有四个设置分区，未迁移参考分类或插件。
- 搜索与预览只完成禁用入口；富文本、拖入、工具详情、外观偏好、复制/时间仍有缺口，不能视为整项完成。
- 代码审查发现并修复设置加载失败不可见、关闭后焦点丢失、产物图标被旧样式覆盖的问题。保留用户原有菜单与滚动改动，无新增依赖、包、核心接口或状态管理框架。

```text
Review            代码审查    检查本轮组件、样式、测试及文档是否符合当前需求。
Findings          发现        上述三处问题已经修复，原有本地修改得到保留。
Required changes  必须修改    无遗留代码阻断项，视觉验收仍受上文明确限制。
Decision          审查结论    PASS；仅表示代码审查通过，不代表所有视觉状态完成。
```

修改保留在 `feature/client-layout-review`，未提交、推送或合并。

## 后续功能顺序

1. 会话搜索：依赖现有会话数组，优先本地筛选；完成后验证筛选、清空、切换和草稿。
2. 智能体富文本：依赖明确的文本解析与链接策略；验证列表、代码、长链接和流式不完整内容。
3. 视频预览：依赖桌面可访问媒体协议；验证实际播放、不可播放格式和文件不存在。
4. 拖入视频：依赖真实文件路径接入；验证多文件、追加与移除。
5. 工具详情：依赖运行事件可展示字段，再接入参数/结果。
6. 消息复制与时间：复制先接剪贴板；时间在现有消息模型确认持久化来源后接入，旧消息不编造时间。
7. 外观与字号：依赖客户端偏好存储；覆盖两主题和尺寸矩阵。
