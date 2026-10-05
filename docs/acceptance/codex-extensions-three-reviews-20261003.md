# Codex 插件与技能三轮核对

日期：2026-10-03。当前分支：`feature/settings-navigation`。本轮保持已有工作树改动，未提交、合并或推送。

**总体验收：CHANGES_REQUIRED（需要继续修改）。完整 Codex 路线尚未完成。** 本地能力和对应界面已经补齐并验证；下面未实现的项目仍是需求缺口，不能用跳过测试或三轮报告替代实现。远程目录与 Apps 账号服务的来源已发出澄清请求，尚待答复。

## 核对依据

- 源码：`D:/Develop/Projects/codex-cli`，提交 `75ec81c8623c0ca50b129de5a82521a23d37b726`；本轮核对的相关源码文件没有未提交修改。
- 协议：`codex-rs/app-server-protocol/src/protocol/common.rs` 与 `protocol/v2/plugin.rs`。
- 清单与安装：`codex-rs/core-plugins/src/manifest.rs`、`store.rs`、`loader.rs`。
- 同步：`codex-rs/app-server/src/request_processors/plugins/reconcile.rs`。
- 技能：`codex-rs/skills/src/parser.rs`、`interface.rs`、`codex-rs/ext/skills/src/host_service.rs`、`render.rs`、`dynamic_skill_selector.rs`。
- 文件通知：`codex-rs/app-server/src/skills_watcher.rs`。
- Codex 界面：`logs/extensions-ui-20261001/codex-plugins.png`、`codex-skills.png`。使用已有真实截图，不声称本轮重新截取了 Codex 页面。
- 本项目最终截图：`logs/extensions-ui-20261003/desktop-plugins.png`、`desktop-skills.png`、`desktop-plugin-approval.png`、`desktop-extension-result.png`。

## 判定口径

```text
PASS                          通过                    对该行限定的实际能力已有源码和可观察证据。
FAIL                          未通过                  当前需求对应的实现仍缺失或不同，不能称为完整兼容。
SKIP                          未验证或实验项          写明未执行原因；不等于通过，也不清除需求缺口。
CHANGES_REQUIRED              需要继续修改            完整目标尚未达到，不满足整体交付和合并条件。
```

以下每行依次记录第 1、2、3 轮判定；某个子项通过不代表该项所属的整个平台完成。

```text
Independent Skill             独立技能                PASS / PASS / PASS：单独导入、启停、读取，不要求必须装插件。
Bundled Skills                插件附带技能            PASS / PASS / PASS：独立条目、插件停用联动、来源管理卸载。
Recursive Discovery           递归发现                PASS / PASS / PASS：嵌套目录、隐藏目录排除、目录及条目上限。
Lazy Skill Reading            正文按需读取            PASS / PASS / PASS：目录只读元数据，load_skill 和详情独立读取正文。
Skill Sidecar                 技能界面配置            FAIL / FAIL / PASS：最终接入显示名称、简述、建议指令与调用策略。
Explicit Invocation           显式技能调用            PASS / PASS / PASS：支持 $名称，最终覆盖大小写、中文与空格。
Implicit Policy               自动调用策略            FAIL / FAIL / PASS：allow_implicit_invocation=false 时仅显式匹配。
Local Invalidation            安装变更通知            PASS / PASS / PASS：安装、启停、卸载、同步后的 IPC 通知。
File Invalidation             文件变更通知            FAIL / FAIL / PASS：最终接入安装与项目文件监视、重绑与释放。
Local Lifecycle               本地安装生命周期        PASS / PASS / PASS：导入复制、状态保存、卸载及重启恢复。
Bundle Reconcile              内置版本同步            PASS / PASS / PASS：版本变化、缺目录修复、保留停用状态。
Failed Publication            失败恢复旧版            FAIL / PASS / PASS：暂存解析失败及发布失败保留或恢复旧目录。
Stdio MCP                     本地工具服务            PASS / PASS / PASS：真实 SDK 子进程的列举、调用与取消。
MCP Approval                  服务调用审批            PASS / PASS / PASS：启动与每次调用独立审批，拒绝不执行。
MCP Cleanup                   服务进程收尾            PASS / PASS / PASS：取消与 finally 等待同一关闭操作并验证 PID 退出。
Local Management UI           本地管理界面            FAIL / PASS / PASS：按参考图调整标题、搜索、筛选、按钮与条目密度。
Short Drama Skill             短剧技能接入            PASS / PASS / PASS：真实 Loop 加载内置正文，未证明成片内容质量。
Full Manifest Interface       完整清单界面            FAIL / FAIL / FAIL：图标、品牌、截图、作者及完整接口字段未全部消费。
Skill Dependencies            技能依赖解析执行        FAIL / FAIL / FAIL：展示声明，未自动安装、认证或补齐依赖服务。
Provider and Authority        多来源技能服务          FAIL / FAIL / FAIL：只有本机来源标记，没有云端和执行器技能服务。
Metadata Budget Cache         字符预算与缓存          FAIL / FAIL / FAIL：只有数量限制和词法排序，没有完整字符预算与缓存。
Versioned Install Store       版本缓存与回滚          FAIL / FAIL / FAIL：只有失败恢复，没有版本库及用户选择历史版本回滚。
Remote Marketplace            远程插件市场            FAIL / FAIL / FAIL：没有远程目录、下载、升级与账号服务。
Remote Reconcile              远程插件同步            FAIL / FAIL / FAIL：本机内置同步不同于 Codex 远程已安装插件同步。
Remote MCP and OAuth          远程服务与授权          FAIL / FAIL / FAIL：远程传输、授权与凭据生命周期未实现。
MCP Environment               插件环境配置            FAIL / FAIL / FAIL：清单自定义环境变量仍被拒绝。
Apps Execution                应用连接执行器          FAIL / FAIL / FAIL：只展示声明，未连接第三方应用与账户。
Hooks Execution               事件钩子执行器          FAIL / FAIL / FAIL：只展示声明，未执行钩子或提供信任授权。
App Server Protocol           完整应用服务协议        FAIL / FAIL / FAIL：Electron IPC 接口不是 Codex JSON-RPC 线协议。
Complete Service UI           完整服务管理界面        FAIL / FAIL / FAIL：没有远程市场、账号分类、连接授权与升级管理。
Shadow Selectors              影子选择算法实验        SKIP / SKIP / SKIP：源码中为实验选择器，不把实验列表当成已上线能力。
Semantic Drama Output         短剧成片内容验收        SKIP / SKIP / SKIP：没有执行真实短剧媒体任务，不据技能加载宣称成片通过。
```

## 第一轮：协议与生产调用链

重新沿 Desktop 主进程、预加载桥、Client、技能工具和真实 MCP SDK 读取生产实现，与上述 Codex 源码核对。补齐所有宿主实现和测试夹具的 `listSkills`、`readSkill`、`reconcile`、`onChanged`；初次聚焦的扩展、运行时和预加载测试共 24 项通过。

纠正前文协议归属：这份 Codex 源码有 `skills/list`、`skills/changed` 与 `plugin/reconcile`，没有 `skills/read` 请求。Codex 的技能服务内部有独立读取能力，但本项目的 `readSkill` 是自己的宿主接口。Codex 的 `plugin/reconcile` 同步远程安装并更新钩子信任等生命周期，本项目只同步内置资源，返回结构也不同。名称或意图近似不能作为线协议兼容证据。

BM25（词频排序算法）及 LRU（最近使用优先）等选择器在所读源码中用于影子实验，不能从“存在源码”直接推断为所有默认生产配置的必备运行方式。当前数量上限和词法排序也没有完整复刻 Codex 的元数据预算与缓存。

## 第二轮：截图与交互复核

实际查看 Codex 两张参考截图及本项目 Electron 截图，修正圆角搜索、主操作按钮、胶囊筛选、标题说明、分区分隔线、两列条目高度和单行说明。移除列表中的 `host` 实现字段，详情中的应用连接与事件钩子明确显示“声明，尚未接入”。保留当前有真实行为的导入和启停，不用公开/个人市场分区冒充远程服务。

浏览器检查桌面、800px 列表和 400px 详情；验证搜索、导入错误、技能正文、卸载确认与返回草稿。再回查全部矩阵项，界面对齐不使尚未实现的市场或账号能力变成通过。

## 第三轮：生命周期、失败与反证复核

重新逐项检查矩阵，并补齐可独立实现的本地缺口：文件变更监听、项目监视路径重新绑定、窗口关闭释放句柄、技能界面侧车信息、仅显式调用策略及名称匹配。内置视频插件版本更新为 `1.1.0`，已有安装通过内置同步获得两项技能的侧车信息。

组合真实目录、SQLite、Loop、Session、Registry 与 SDK 验证：导入复制、删除原来源后读取、迁移安装根目录、启停保存、重启恢复、内置版本变化、缺目录修复、无变化同步、坏包保留旧安装、发布重命名失败恢复旧目录、插件启动拒绝、工具调用拒绝、取消及进程退出。异常恢复不再吞掉恢复失败；主进程不再丢弃同步失败列表。

真实 Electron 用独立 `--user-data-dir`，保持主进程、预加载桥、Provider、Loop、SQLite 和 MCP SDK 的生产实现，仅替换模型 SSE 响应及原生目录选择返回。模型依次加载技能、调用真实插件 echo、完成回复；断言下一请求含技能正文和真实插件响应，结束后 PID 不再存活。外部直接写入安装后的 SKILL.md，独立计数器先断言确实收到新的 IPC 失效通知，再断言界面描述更新。

反证一：暂时关闭主进程的安装变更通知，桌面测试在“独立宿主启用技能后界面应更新”处失败；恢复代码后通过。

反证二：暂时关闭文件监视通知。第一版验收误通过，因为仍在完成的列表读取可能顺带读到新文件。已修正验收，增加新通知计数和刷新结束断言；再次关闭文件监视通知后，在“通知计数应大于零”处明确失败。随后恢复源码和主进程构建产物，并复测通过。所有故障注入都通过 finally 恢复，最终产品代码不保留故障开关。

## 最终验证

```text
Repository Gate               仓库门禁                corepack pnpm check：52 个文件、574 项测试通过，19 个包架构检查通过。
Desktop Build                 桌面构建                corepack pnpm desktop:build：主进程、预加载和渲染层构建通过。
Focused UI Verification       扩展界面验收            扩展浏览器及 Electron 用例 5 项通过、1 项重复尺寸跳过。
Full UI Regression            全量界面回归            corepack pnpm client:web:test：52 项通过、6 项重复/条件用例跳过。
Notification Counterproof      通知反证                禁用通知时相应断言失败；恢复后真实 Electron 验收通过。
Short Drama Loading           短剧指令加载            真实 Loop 加载内置短剧正文通过；未执行真实短剧成片验收。
```

最终完整回归在全部本地修改与故障注入恢复后执行；未用较早的结果代替最终源码的验证。跳过项来自真实桌面往返的重复尺寸与已有条件用例，不表示插件缺口已通过。

## Review（审查）

- Findings：本地同步失败反馈、恢复错误吞掉、技能身份通过字符串形态判断、刷新在任务中可用、扫描读取整个正文、外部文件变更未通知、侧车与调用策略未消费、外部文件验收存在假通过问题。以上当前局部问题已修正并复测。
- Required changes：完成矩阵全部未通过项；先确定远程市场与账号服务的真实接入来源。完整清单、版本库、依赖执行、远程 MCP、Apps、Hooks 和应用服务器协议仍待实现。
- Decision：本地变更 PASS；完整 Codex 对齐 CHANGES_REQUIRED。三轮检查不等于三轮全部通过，不合并主分支，不宣称完整任务完成。
