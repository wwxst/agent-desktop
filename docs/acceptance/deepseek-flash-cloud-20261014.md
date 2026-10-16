# DeepSeek Flash 真实云验收报告

日期：2026-10-14。真实云 Vision 与 Responses 两项补充验收均为 `PASS`，范围包括官方模型观察、生产插件调用、真实工具往返、流式最终回复及当前版本保存与重启恢复。人工小窗口压缩未能在两次摘要内收敛、原生图片选择入口及实际账单的限制单独保留，不能据此宣称所有场景通过。

## 验收对象与结果口径

- 仓库：<https://github.com/wwxst/agent-desktop>。
- 独立分支：`codex/phase6-deepseek-acceptance`。
- 实际运行的业务源码 HEAD：`b4dd427c169c9a68a6a41eaa87f02819c39804f5`，与起始 `codex/phase6-main-integration` 相同。本轮没有生产源码、依赖、锁文件或测试变更。
- 工作目录：`C:/Users/ww/.codex/worktrees/phase6-deepseek-acceptance/agent-desktop`。
- 原始证据目录：上述工作目录下 `logs/deepseek-flash-acceptance/`。该目录由 Git 忽略，保留本机原始证据；本报告列出请求身份、用量和可复核结果，不提交隔离配置目录或密钥材料。
- 本地工程检查使用 Node.js `24.20.0`、pnpm `11.22.0`；真实桌面运行时为 Electron `44.0.0`、其内置 Node.js `24.18.1`。持续集成使用 Node.js `24.19.0`，不将三者视为同一运行时。

```text
PASS            实测通过          对相应范围有实际成功证据；云项目必须包含真实官方请求。
FAIL            实测失败          实际执行没有达到该场景目标，保留原始失败记录。
SKIP            未执行            未执行、缺少条件或本轮预算不足，不能计入通过。
NOT SUPPORTED   供应商不支持      官方明确不提供且不是项目必需的服务端能力。
Vision          视觉分析          插件把获授权图片发送给视觉模型并解析结构化观察。
Responses       响应协议          使用 /responses 的输入、工具调用、流式事件与终态。
SSE             服务器推送流      文本增量与完成事件分别解析，不能依赖聊天协议结束标记。
Agent Core      智能体核心        处理模型、工具和会话事件，不耦合视觉插件协议。
Session         会话记录          保存完整回复、工具调用身份和任务终态，增量仅用于展示。
Desktop         桌面客户端        用 Electron 宿主、预加载桥和界面消费智能体与插件能力。
MCP             模型上下文协议    以独立子进程提供工具列表与调用，不等同于模型请求协议。
IPC             进程间通信        通过正常预加载桥传递设置、附件登记、审批与会话状态。
Token           模型计量单位      使用供应商真实返回用量计算估算，不据此伪造实际账单。
SQLite          本地数据库        事务保存当前会话，真实重启后读取同一隔离目录恢复结果。
```

## 官方调用、凭据与预算

使用 DeepSeek 官方 `https://api.deepseek.com`，请求和返回模型 ID 均为 `deepseek-flash`。正常运行时配置选择 `responses`，关闭备用视觉模型；单图与多图专项另外显式选择生产 Vision 插件已有的 `chat-completions` 路由。两种协议分别验收，聊天协议成功没有作为 Responses 证据。

首先检查 Desktop 已有配置，未发现保存的 DeepSeek 密文；随后通过正常 `loadRuntimeSettings()` 和运行时配置加载链确认环境凭据可用，状态仅记录 `{ configured: true, source: "environment" }`。使用正常 `DEEPSEEK_API_KEY` 环境来源，没有要求用户发送密钥、手写数据库、输出解密值或使用其他供应商账户。模型与能力配置通过现有 IPC 保存，未新增配置入口。证据为 `configuration.json`。

验收观测器把主进程与 Vision 子进程的真实 `fetch` 委托给原实现，只允许官方域名和 `/responses`、`/chat/completions`、`/user/balance`，记录图片字节摘要、响应 ID、用量和终态，不替换云响应。运行环境未设置 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NODE_USE_ENV_PROXY` 或代理预加载，生产供应商与 Vision 使用原生 `fetch`，没有代理分发器；没有额外 CA 或关闭 TLS 证书校验。Git/GitHub 工具单独设置的代理没有传给云请求。账本目标和返回模型均为官方地址/模型，未使用模型中转 Base URL，也未把本机 HTTP 夹具计为云请求，据此判为官方直接请求；没有声称完成独立网络抓包、DNS 或证书审计。

严格累计 **15 次官方请求**：14 次模型请求、1 次余额查询；达到请求上限后停止，没有第 16 次余额查询。请求输出上限为 4096，人工摘要为 1024，截断反证为 16；观测器同时按输入与输出预留费用限制人民币 10 元。上传内容全部是本轮人工生成的方块、文字和合成视频，没有私人图片或生产文件。

## 请求账本与身份

完整账本为 `cloud-ledger.json`，下列编号与其 `requests[].id` 一致。模型请求均返回 HTTP 200；请求 12 的业务终态是 `incomplete`，不能因 HTTP 200 记为完整输出。官方未提供 `x-request-id` 时保留空值，以下身份来自真实响应的 `id`。

1. `/user/balance`：账户可用，CNY 余额 `4.28`，无模型 Token 用量。
2. `/responses`，基础流式响应，`daef8a44-7272-47d4-8008-c2f4276939b7`；输入/输出 `51/35`，`response.completed`。
3. `/chat/completions`，单图，`169ef648-bec8-4c4c-8354-041fa688865d`；输入/输出 `432/127`。
4. `/chat/completions`，双图，`8eceb12d-53ba-47b6-b518-be94adb06c6b`；输入/输出 `644/210`。
5. `/responses`，视频六帧，`c1a11dad-9c73-42ee-9ea4-2a2027425b15`；输入/输出 `1586/1291`，`completed`。
6. `/responses`，Desktop 首轮真实工具调用，`791c3cc7-ba99-40ee-b1bc-fe0431a8df29`；输入/输出 `5939/121`，`response.completed`。
7. `/responses`，未授权文件拒绝后的续答，`12c69782-aa9b-4bc6-9faa-46cddc07b450`；输入/输出 `6086/229`，`response.completed`。
8. `/responses`，Desktop 自动会话标题，`fda9f5ff-27ce-4b23-a723-9a47b489f9ed`；输入/输出 `207/656`，`response.completed`，计入预算。
9. `/responses`，附件正式授权后的工具调用，`208fc856-9b96-4311-8db7-c6b6669922ae`；输入/输出 `6235/116`，`response.completed`。
10. `/responses`，Desktop Vision 插件真实分析，`747341c6-776e-4f30-92e9-eca7a1771957`；输入/输出 `486/246`，`completed`。
11. `/responses`，成功工具结果回传后的续答，`3ed17e12-beab-40a3-bd8d-1017ee60dd70`；输入/输出 `6651/22`，`response.completed`。
12. `/responses`，16 Token 截断反证，`4200bc5a-5316-4191-bc95-75dad9985212`；输入/输出 `49/16`，`response.incomplete`。
13. `/responses`，第一份真实压缩摘要，`e4208e23-cdf2-4517-9de9-02c69ee41494`；输入/输出 `503/729`，`response.completed`。
14. `/responses`，第二份真实压缩摘要，`c95a0f02-1d0f-49ce-ad85-59e2c317b39a`；输入/输出 `615/917`，`response.completed`。
15. `/responses`，包含既有真实摘要的压缩输入，`63d6e7c8-cb73-46dc-97c7-66ee833e7180`；输入/输出 `940/93`，`response.completed`。

## Vision 单图、多图与视频抽帧

三项均通过真实 Electron 主进程加载正常运行时配置，安装并启用内置 Vision/FFmpeg 插件，由 `prepareExtensions` 注册授权适配器，再经真实 stdio MCP 子进程调用官方模型。专项入口直接执行生产工具；完整界面与智能体链路在下一节单独验证，没有用独立 HTTP 成功代替插件成功。

单图为 `PASS`：请求 3 实际上传 `alpha.png`，6056 字节，SHA-256 为 `0e04709bdf9f4a303f1fc4d3968fcaa955f6d394de6be9be07e7fc6c14527e33`。真实观察为白底左侧红方块、右侧黑色 `ALPHA 731`，与已查看图片一致。插件返回 `status: success`，解析出 `summary` 和一条 `frames`，包含 `timestamp: 0`、`subjects`、`description`、`scene`、`visibleText: ["ALPHA 731"]`。证据为 `vision-single.json`。

多图为 `PASS`：请求 4 实际上传上述图片及 `beta.png`；后者 6110 字节，SHA-256 为 `c0c3e8352d39e69eb1fdd8d63b5d3f5dfe6b734480f29ab1259dfd76a746eacb`。插件输出两条对应帧，时间戳为 0 和 1，分别识别红方块/`ALPHA 731`、蓝方块/`BETA 246`，明确区分颜色和文字，没有遗漏第二张图片。证据为 `vision-multiple.json`。该输出沿用了生产工具的帧式描述，不能据其文字称输入为真实视频。

视频抽帧为 `PASS`：合成 `safe-shapes.mp4` 实际时长 4.2 秒。真实 FFmpeg 插件执行 `extract_video_frames` 后，Vision 插件向请求 5 发送六张实际 JPG 抽帧。来源文件、输出路径、图片摘要和时间戳均保留；时间戳依次为 `0.6`、`1.2`、`1.8000000000000003`、`2.4`、`3`、`3.6000000000000005` 秒。模型输出六条对应记录，前三帧红方块/`ALPHA 731`，后三帧蓝方块/`BETA 246`，与实际查看抽帧一致；没有声称识别未采样画面或复杂语义。真实顺序为 FFmpeg 抽帧 → 宿主授权 → Vision MCP → 官方 Responses → 结构化解析，证据为 `vision-video.json` 与 `materials/extracted/`。

上述每项均记录插件启动及图片外传审批，上传审批明确显示 `https://api.deepseek.com`，备用视觉关闭。观测结果来自真实云返回，验收脚本未提供预设视觉答案或替换响应。

## Desktop、工具往返与持久化

完整链路为 `PASS`：当前对话选择 DeepSeek Flash、协议为 Responses，模型具有图片输入与理解能力；`fallbackVisionEnabled: false`、`fallbackVisionModel: null`。Vision 跟随当前对话模型，经正常插件启用与工具注册执行，不依赖备用模型。

首轮请求 6 由真实模型生成 `analyze_images` 调用，但仅在提示中给出绝对路径，没有通过宿主附件或工作目录授权。生产工具拒绝，未发出图片请求；请求 7 接收到真实 `function_call_output` 后明确表示没有看到画面，不猜测颜色或文字。这是授权反证 `PASS`，不是云视觉识别通过，也不是业务缺陷。证据为 `desktop-responses-vision.json`。

随后通过真实附件按钮触发选择 IPC。自动化仅替换操作系统文件选择对话框返回值，选择本轮安全 `alpha.png`；附件登记、宿主文件授权、模型请求、插件启动、图片外传审批和结果回传均使用生产路径。请求 9 的真实 `function_call` 名称为 `analyze_images`，参数含实际路径及 `timestamp: 0`，`call_id` 为 `call_00_vtx1GRkara9cOWNiOlFv4945`。请求 10 从真实插件上传该图片并返回结构化观察；请求 11 接收同一调用身份的工具结果后返回：

> 方块是红色（纯红色实心方块），右侧可见黑色文字「ALPHA 731」。

公开事件包含 21 条 `text.delta`、完整 `model.text` 和任务 `completed`；界面显示当前模型及正确最终回复。证据为 `desktop-responses-vision-authorized.json`、`desktop-vision-completed.png`。审批由验收控制器通过正常 `decideApproval` IPC 答复，许可范围仅为本轮 Vision/FFmpeg 插件及安全素材，没有绕过审批执行器或替换核心、会话、注册表及工具。

原生选择对话框当前过滤音视频，PNG 附件在现有界面被标为 `video`。本轮通过上述受控选择返回值覆盖宿主和智能体链路，**原生界面直接选择图片入口为 `SKIP`**；不能把本次结果称为完整原生图片附件产品验收。该入口不属于本次两项外部供应商协议门禁，没有据此扩展界面功能或重构附件系统。

当前版本持久化及真实重启为 `PASS`：正常关闭后重启同一隔离配置目录 `profile-1791964444287`，由真实 Electron 恢复会话 `7741849a-9cd5-4fc4-ad68-f673c5900b85`。重启验证进程移除凭据并禁用主进程 `fetch`，没有发送新任务；账本前后仍为 15 次，字节摘要保持 `ff706b3ebee1a350ff25f01e346130a2603ec40f55c1b38ab339faadac3de168`。

重启后的客户端四条消息包含两条用户消息与两条最终助手回复。底层会话四条 `assistant.message` 对应两次工具调用步骤及两次最终回复，另有两组 `tool.called`/`tool.result`、两次 `turn.completed`。成功调用身份的 called/result 各一条，成功最终完整回复仅一份，持久化 `text.delta` 事件为零；没有把 21 条展示增量保存成重复回复。恢复后模型仍为 `deepseek-flash`，备用视觉仍关闭。证据为只读 SQLite 导出 `desktop-restart-sqlite.json`、正常 IPC 状态 `desktop-restored-client.json`、`restart-validation.json` 和 `desktop-restart-offline.png`，没有修改数据库内容。

## Responses 基础、流式、额度与上下文

基础响应和流式为 `PASS`：请求 2 真正调用 `/responses`，生产 `DeepSeekModel` 解析出“你好，验收暗号 ORANGE-731。”及 10 条文本增量。真实用量由只读 HTTP/SSE 观测账本读取，当前 `ModelResponse` 不返回用量；本次结果不代表界面或 Session 保存了 Token。真实流中包含 `response.created`、`response.in_progress`、`response.output_text.delta`、`response.output_text.done`、`response.completed`，没有 `[DONE]`。完整 Desktop 的请求 9–11 进一步证明流式工具参数、工具执行、续答、最终展示与保存链路。没有将 Chat Completions 结束约定强加给 Responses。

真实函数调用为 `PASS`：请求 9 的 `function_call` 经 Agent Core 解析，宿主在授权和外传审批后执行无破坏性的 `analyze_images`，请求 11 显式携带既有会话消息、函数调用及函数结果，模型继续生成正确最终回复。上述调用身份同时出现在官方响应、活动事件、Session 和 SQLite 恢复结果中。

输出额度及预期截断识别为 `PASS`：请求 12 实际发送 `max_output_tokens: 16`，官方返回 `response.incomplete`、`status: incomplete`、`incomplete_details.reason: max_output_tokens`，输出用量恰为 16，全部为思考用量，没有可展示正文。生产供应商拒绝将其包装成完整成功，抛出“Responses API 执行失败”。原始 `responses-incomplete.json` 因调用抛错保留 `status: FAIL`，没有改写；这里通过的是“必须识别截断并拒绝完整化”的反证目标，不是这次调用产生了完整答案。官方 `response.failed` 的真实故障注入为 `SKIP`，其分类仅由已有本地测试验证。

多轮上下文为 `PASS`：完整 Desktop 第二轮请求包含上一轮用户、助手、函数调用和失败工具结果；成功工具后的续答继续携带当前调用与工具输出，完成同一会话保存与重启。使用无状态请求携带上下文，没有依赖服务端会话。

本地压缩分为两项事实，证据为请求 13–15、`host.ts` 与 `responses-compacted-input.json`：

1. 人工构造四轮安全历史，以生产 `prepareModelContext`、6000 的人工上下文窗口和 1024 的输出预算触发两次真实官方摘要。两次摘要均 `completed`，来源引用合法，估算由 `9099 → 7671 → 5891`，但仍超过可用输入预算 `4676`。该人工小窗口“摘要后直接完成最终调用”结果为 `FAIL`，实际抛出 `ContextBudgetError` 并停止，预算边界正确生效；不称其已全程完成，也不把人为不足窗口判成生产模型缺陷。
2. 为遵守剩余一次请求限制，在相同历史上恢复请求 13、14 已经取得的真实摘要，经生产压缩逻辑重新校验来源并重建压缩事件，未新增摘要云请求、未伪造摘要。两份摘要对应的 `sourceDigest` 为 `6fa21799c9aef52b08f276b36a12626a50098f6f3b1ba907ac384ccb616324c6` 与 `d9fd70dadaf1d1622052e1e251acb0768ca754e1f4074c4215f4179bc87ba88c`。恢复实际配置的 1048576 上下文窗口后，生产消息投影保留用户原文、摘要和尾部，生产 `DeepSeekModel` 在请求 15 将该输入发到官方 `/responses`，返回 `completed` 和 `ORANGE-731`。因此“真实摘要形成的压缩输入可被官方接受”为 `PASS`；它不是第一次小窗口流程成功，也没有证明这份人工压缩会话经过 SQLite 重启。

`previous_response_id`、服务端会话管理及服务端 `context_management` 为 `NOT SUPPORTED`。依据 [DeepSeek 官方 Responses 指南](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)，该协议为无状态调用；本轮没有发送这些字段、增加兼容框架或将其列为项目失败。图片能力依据 [官方视觉指南](https://api-docs.deepseek.com/zh-cn/guides/vision/) 并由本轮真实图片验证。

## 安全、错误与证据边界

本轮真实链路证明已授权素材外传审批、未授权文件拒绝且零图片上传、失败工具结果正常回传、成功调用身份一致、最终回复保存和重启恢复。必要的执行安全、取消及错误传播要求继续有效。

缺密钥、401/403/429/500、禁止 HTTP 重定向、超时、取消、格式和数量限制、邻居路径/链接拒绝，以及持久化失败不提前发布成功，复用以下已有本地检查；完整 `pnpm check` 已通过，没有新增测试或额外故障云请求：

- `apps/desktop/tests/vision-tool.test.ts`：文件授权、审批、取消与持久化错误身份。
- `packages/vision-openai/tests/vision-openai.test.ts`：HTTP 失败、禁止重定向、超时取消及不泄漏错误正文。
- `packages/model-deepseek/tests/responses.test.ts`：流式与工具解析、完成/失败/不完整分类、额度、取消与 HTTP 错误。
- `packages/agent-loop/tests/run-turn.test.ts`：最终完整回复的会话语义。
- `apps/desktop/tests/context-persistence.test.ts`、`persistent-session.test.ts`：当前版本压缩持久化及事务失败不改内存。

上述为本地回归 `PASS`，对应官方真实故障注入为 `SKIP`，没有把夹具变成云通过。第六阶段已有安装版专项使用本机协议服务且 `remoteApiSpend: false`，继续只证明安装版资源、授权和三插件协同；本轮真实云入口是开发 Electron，**本轮安装包内直接连云为 `SKIP`**，不重新包装既有安装版结论。

初期 Vision 子进程连接关闭来自本轮临时观测脚本的 Windows 路径转义：`NODE_OPTIONS` 的预加载路径中反斜杠被 Node.js 解析移除。临时脚本改为正斜杠后完成真实调用；另用无效占位凭据在不发云请求的前提下验证 MCP 初始化与工具列表。属于验收环境修正，没有生产源码缺陷或修复。未基于猜测修改模型思考开关、Agent Core、插件架构、视频系统或界面。

## 用量与费用

14 次模型请求的真实返回用量合计：输入 **30424**、其中缓存命中 **18304**，输出 **4808**，总计 **35232 Token**。缓存命中属于输入子集，不再重复相加。官方余额查询计入 15 次请求，但无模型用量。

按本轮读取的 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) 高峰时段公开单价估算：未命中输入人民币 2 元/百万 Token、命中输入 0.04 元/百万 Token、输出 8 元/百万 Token，计算为 `((30424 - 18304) × 2 + 18304 × 0.04 + 4808 × 8) / 1000000 = 0.06343616` 元。该数字是**用量估算，不是实际账单或实际扣费**，没有推断优惠、具体计费时段或账户余额差。官方响应、视觉及价格页面本轮读取均为 HTTP 200，页面副本为 `docs-responses.html`、`docs-vision.html`、`docs-pricing.html`。

调用前余额为人民币 4.28 元；调用后余额及账单为 `SKIP`，原因是 15 次请求上限已经达到，未继续查询。临时观测守卫的保守费用预留合计为人民币 `0.63519` 元，也是预算估算，不能作为账单。已取得的用量与保守费用预留均低于人民币 10 元；达到请求上限后没有再进行付费调用。`ledger-validation.json` 重新核对次数、模型、官方地址、用量、费用估算和账本摘要，检查 17 份 JSON/日志工件没有包含环境密钥值，仅记录检测结果。

## 工程检查、审查与合并边界

- `pnpm install --frozen-lockfile`：`PASS`。
- `pnpm check`：`PASS`，86 个测试文件、1014 个测试、19 个工作区架构检查；包含生产和测试类型检查及当时的差异格式检查。证据为 `pnpm-check.log`。
- `pnpm check:architecture`：独立重跑 `PASS`，19 个工作区。
- `pnpm desktop:build`：`PASS`，构建三个插件、主进程、预加载和渲染产物。证据为 `desktop-build.log`。
- 业务源码基线 `b4dd427c169c9a68a6a41eaa87f02819c39804f5` 的 [Windows/Ubuntu 持续集成](https://github.com/wwxst/agent-desktop/actions/runs/38525368073) 已通过。本报告新增文档提交对应的准确 HEAD、双平台持续集成及最终 `git diff --check` 由本轮交付记录单独报告，不使用基线运行冒充新提交运行。

本报告没有覆盖修改历史验收结论：此前报告中的云 `SKIP` 仍是当时事实，当前补充证据由本报告承接。没有通过删除要求、弱化安全检查、伪造云响应或改旧 `SKIP` 为 `PASS` 关闭门禁。

本轮独立证据审查决议为 `PASS`：审查确认官方响应身份、图片对应、完整工具身份、重启保存和请求统计，要求保留截断原始失败及人工小窗口负例。报告据审查明确区分供应商文本解析与只读观测用量、原生图片入口限制、已有摘要恢复与新云摘要请求；没有新增生产修复。最终文档提交的工程审查和持续集成结果仍由交付记录报告。

真实云 Vision 门禁为 `PASS`：单图、双图、真实视频六帧及完整 Desktop 插件调用均取得官方观察，结构化输出和实际画面对应。真实 Responses 门禁为 `PASS`：基础、SSE、真实函数往返、多轮、额度反证、真实摘要输入接受及最终回复持久化均有证据。人工小窗口压缩失败、云故障注入未执行、原生图片选择入口、安装包直接连云及实际账单的范围限制如上，未计入全部功能通过。

当前证据没有发现新的 P0/P1（严重或高优先级问题），没有需要实施的生产代码修复。两项外部云缺项可以关闭；**进入最终 main 合并审查仍须以本轮最终提交的工程检查、独立审查和双平台持续集成实际通过为准，并等待用户正式合并授权**。本轮未合并 `main`、未发布版本、未删除用户数据或其他工作树。
