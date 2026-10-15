# 最终 main 合并候选与正式收口审查

执行日期：2026-10-14；收口日期：2026-10-15。候选为 `codex/final-main-merge`，独立工作树为 `C:/Users/ww/.codex/worktrees/final-main-merge/agent-desktop`。本轮只形成、验证和推送独立候选，不更新 `main`，不发布版本，不删除原分支、工作树或用户数据。

**最终合并结论为 `BLOCKED`：两次现有完整浏览器套件均有未关闭失败；第二次为 73 通过、18 跳过、3 失败。** 合并提交的双平台持续集成成功、后续本机检查通过和已有真实云证据均不能替代当前浏览器门禁。第三轮完成证据审查后同样判定受阻。

```text
PASS                      实际通过          有对应源码及实际执行或审查证据。
FAIL                      实际失败          保留实际失败，不以后续成功覆盖原始记录。
SKIP                      尚未执行          缺少条件或不适用，不能计入通过。
NOT SUPPORTED             官方不支持        供应商明确不提供且当前项目不依赖的能力。
BLOCKED                   合并受阻          当前必需门禁未完成或未通过。
READY FOR MAIN MERGE      可以合并          全部最终门禁通过后，仍等待正式合并授权。
```

## 一、准确版本、历史与保护范围

本轮实际 `fetch` 后再次以远端引用核对，来源没有前进：

- `origin/main`：`9c1a002015925070ba8274b4c20a986acf06fcea`。
- `origin/codex/phase6-main-integration`：`b4dd427c169c9a68a6a41eaa87f02819c39804f5`。
- `origin/codex/phase6-deepseek-acceptance`：`ca692fc5e651ec9590d27f1f132a06391f5a1b0b`。
- 本轮明确合并提交：`f924f27ae4f0f761a8b4e0b4d3e4c4a7fbbcc99d`。
- 合并第一父：`9c1a002015925070ba8274b4c20a986acf06fcea`；第二父：`ca692fc5e651ec9590d27f1f132a06391f5a1b0b`。

独立候选从准确 `origin/main` 创建，以普通双父合并引入完整云验收来源。没有冲突、未解决索引项、快照覆盖或重复合入历史功能分支。合并提交与 `ca692fc5` 的完整树对象均为 `4cf9504dc1d4046d18079469d8f0c9a3cb2d4749`，实际文件差异为空。

`9326525` 第五阶段候选、`5bc5550` 规范整合、`b4dd427` 第六阶段以及准确 `main` 均为云验收来源和本轮候选的祖先。`b4dd427 → ca692fc5` 仅新增云验收报告并更新工程规范，两份文档之外没有源码、依赖、锁文件或测试变化。本轮合并也没有生产代码、测试、配置协议及依赖变化；本报告是合并后的必要新增文档，保留合并提交历史，不重写已推送提交。

本轮合并提交与报告新增后的最终交付提交分开记录：前者身份已固定为 `f924f27`；最终交付准确 HEAD、远端同步及其持续集成记录在文档提交后生成的 `logs/final-main-merge/final-delivery.json` 和 `ci-final.json`，并在交付回复提供准确 SHA 与链接。本文不伪造自身提交摘要，也不以旧提交结果推断新提交持续集成。

合并后追加 `8b8f5be368286866b6bf240cf0264e7293efe193`，只修改现有 `desktop-vision.pw.ts` 的场景身份断言，父提交为 `f924f27`。没有新增测试场景，没有修改生产代码、配置、依赖或超时；该必要修正与后续文档提交使用普通追加历史。

原 `main` 工作树仍为 `D:/Develop/Projects/agent-desktop`，未跟踪的 `.workbuddy-ai/`、`docs/superpowers/plans/2026-10-11-probe-media-plugin-migration-plan.md`、`html.zip`、`html/` 全部保留。其余已有工作树保持原位，未进行清理。审查时其他工作树干净；候选最初也干净，本报告新增后的状态与最后提交后干净状态须分别核对。

## 二、分支成果与 main 增量

通用核心、Agent 与视频整合、Probe、FFmpeg、Whisper、Vision、项目删除确认、语义参数边界等现有功能来源均已成为候选祖先，没有新的独立功能需要额外合入。准确 `main` 本身已包含在 `ca692fc5` 中，本轮无需再解决第五阶段与 main 的旧冲突。

两个本地分支头不是候选祖先，实际成果仍已完整包含：

- `codex/development-policy` 的唯一未成为祖先提交为 `bfaa62a`、`195219f`。它们分别以 `d08b243`、`b1fbc12` 引入规范整合分支，完整提交消息保留 `cherry picked from` 来源。实际 `range-diff` 仅有来源说明和候选上下文差异；根开发原则、最小实现规范、必要安全与现有门禁均保留。没有合入该分支的无关历史。
- `feature/extension-toast-top` 的唯一未成为祖先提交为 `cebd0da`。main 已包含 `7c39f97`，候选实际 CSS 保留页面 `top: 24px` 居中反馈以及模态底部例外，当前界面文档同样规定顶部居中提示。没有依据提交祖先缺失就重复合入相同界面成果。

`Composer`、`ModelSelector`、`ModelProvidersSettings`、`model-capabilities`、`model-defaults`、`ExtensionFeedback` 六个关键文件与准确 main 的 Blob 完全一致。输入区模型选择、品牌与菜单布局、供应商配置、四项能力、统一反馈以及显式备用视觉功能未被旧候选覆盖。项目侧栏、多会话、插件管理、任务计划、恢复界面及暗色支持随完整集成来源保持。

开发规范继续以根 [AGENTS.md](../../AGENTS.md) 和 [工程规范](../engineering.md) 为准。旧 API、Session、SQLite、配置、插件协议及跨版本数据回滚不再是验收门禁；当前事务完整、授权、错误传播、取消、恢复及正式交付仍是必需要求。本轮没有恢复旧 Session 推断或新增兼容层，也没有借最终审查扩大历史代码清理。

## 三、通用核心、执行宿主与三插件完整性

源码与注册检查结论为 `PASS`：

- Agent Loop、模型流式请求、Session 事件、计划、任务恢复和 SQLite 使用同一当前事实契约。任务起点事件、消息身份与展示快照同次提交，成功写盘后才推进内存；保存失败保留首个错误。
- 宿主审批通过后、实际外部调用之前保存检查点。未知效果阻止新的外部操作，主动恢复不重放已完成调用；取消及保存错误按当前身份传播。任务终态经预加载桥传递，最终回复与产物按真实事实保存。
- Desktop 主入口通过 `prepareExtensions` 获取工具，再显式注入 `mediaTools/visionTool`。FFmpeg 14 个专业工具、Whisper 的 `transcribe_audio`、Vision 的 `analyze_images` 独立提供，注册拒绝同名冲突，没有隐藏内置回退。
- 公开工具名称只授予受控 builtin 插件及准确服务身份；第三方工具继续使用限定名。禁用或卸载插件后不能通过内置构造器补回能力。
- Vision 文件真实路径授权先于外传审批；密钥只通过受控视觉进程环境传递。正常供应商配置决定本轮模型、Chat Completions 或 Responses 协议与输出预算；默认视觉跟随具备能力的当前对话模型，备用仍需用户明确启用。
- 语义视频剪辑插件只提供技能目录，专业工具服务独立。公开视觉与语义验收复用同一已授权视觉实例；抽帧、转录、语义检查、候选验收及正式交付连接既有工具结果。发布要求最新候选、最新全项通过验收和一致摘要，并独占创建目标文件。
- 插件协议、具体供应商及媒体实现留在宿主和具体包；Core 没有新增这些依赖。

上述静态完整性与本轮已有回归不等于所有真实场景已重新运行。完整浏览器及桌面运行结论单独记录，不能用源码相同掩盖当前必要门禁失败。

## 四、本轮工程、完整浏览器与持续集成

在准确合并提交 `f924f27` 上实际执行：

```text
corepack pnpm install --frozen-lockfile  PASS  install.log，锁文件没有漂移。
corepack pnpm check                      PASS  check.log，86 文件、1014 测试及类型检查。
corepack pnpm check:architecture         PASS  architecture.log，19 个工作区。
corepack pnpm desktop:build              PASS  desktop-build.log，含三插件构建。
corepack pnpm client:web:build           PASS  web-build.log。
corepack pnpm desktop:package:win        PASS  package-win.log，生成当前 Windows 安装器。
corepack pnpm client:web:test            FAIL  初次完整运行 74 通过、18 跳过、2 失败。
git diff --check                         PASS  合并差异及本轮最小测试修正均通过，文档提交前再次检查。
```

本轮原始日志位于 `logs/final-main-merge/`。完整浏览器使用现有全部套件、独立专项配置目录和 `--workers=1 --reporter=line,json`。第一次实际收集 94 项，结果为 `74 passed / 18 skipped / 2 failed`，命令退出 1；日志和报告单独保存在 `browser-first.log`、`browser-first-results.json`，完整 `test-results` 已保存在 `browser-first-artifacts/`。这是本轮实际失败，不能用此前第六阶段同样数量的结果或后来专项通过替代。

首次 18 项 `SKIP` 按实际 JSON 分为：14 项是 `chromium-800x600` 下不重复执行的原生专项；另 4 项是安装器覆盖与 FFmpeg 更新/回滚控件两个场景在两个项目下因缺少 `DESKTOP_UPGRADE_PROFILE` 跳过。不能将 18 项全部称为已取消的旧版本兼容要求，FFmpeg 更新/回滚控件仍是当前功能。本轮没有重新执行 NSIS 覆盖安装，对这部分引用第六阶段相同生产链路的隔离安装与控件证据，并保留本次 `SKIP`；不计入当前浏览器通过数。

Vision 失败的已证实原因是本次实际提交了 `CASE:restart-disableda`，SQLite 用户消息、Session 输入、模型调用和最终回复都带尾部 `a`；旧完成断言按子串接受了 `完成 restart-disableda`，随后精确寻找 `restart-disabled` 记录失败，158 行将 `JSON.stringify(undefined)` 交给 `writeFile`，抛出 `TypeError`。停用后的视觉能力仍正确消失，错误工具调用未新增图片上传。额外字符来源未确认，没有把它归因为生产自动追加、快捷键或已确定环境问题。

`8b8f5be` 只收紧已有场景：发送前校验输入框值，发送后校验正式用户气泡，完成时校验准确回复和对应模型记录。没有默认结果、额外重试、放宽超时或删除断言；此修正阻止误认另一场景，不声称已查明或消除额外字符根因。修正后现有 `pnpm check` 再次通过 86 文件、1014 测试、类型与 19 工作区架构检查，用时 59.67 秒，日志为 `check-final-test.log`。

Whisper 失败发生在 `desktop-whisper.pw.ts:200`：`setSize(800,600)` 后的 `page.screenshot` 超过原 30 秒，调用记录已完成字体加载。`initial.png` 和 `model-download.png` 均为 1104×721，下载完成的 `model-ready.png` 为 2560×1369，证明下载等待期间窗口几何发生变化；当时未记录最大化、最小化、焦点及可见性，具体截图超时根因仍未确认。后续中文、英文、混合、长音频等转录循环尚未开始，因此不能把它记为识别失败，也不能把未执行的识别记为通过。没有猜测性生产或截图代码修改，原时限保持。

第二次完整 94 项套件在准确 `8b8f5be368286866b6bf240cf0264e7293efe193` 上执行完毕，用时 451.52 秒，结果为 `73 passed / 18 skipped / 3 failed`，命令退出 1，重试数为零。原始日志为 `browser-final.log`、`browser-final-results.json`，失败上下文另存 `browser-second-artifacts/`。18 项跳过仍为上述 14+4 原有条件，没有新增跳过或修改时限。

第二次三项失败分别为：

- Vision：第 174 行首次 `saveRuntimeSettings` 的 `page.evaluate` 返回 `Target page, context or browser has been closed`。本轮 `records/uploads/fixtureErrors/chainStatus` 全为空，SQLite 尚无 `runtime-settings/runtime-secrets`，场景和图片上传均未发生。已检查的设置保存路径没有关闭应用调用；现有日志不足以区分外部窗口关闭、渲染进程或调试连接终止，不能宣称生产崩溃或已确定环境问题。
- Whisper：模型再次真实下载完成后，在第 200 行相同窄窗口截图处超过原 30 秒，字体已加载；仍未进入后续转录循环。重复截图失败未关闭，本轮没有把历史识别证据当作本次完整专项通过，也未修改截图超时、生产代码或加入自动重试。
- Settings：第 259 行等待新增供应商编辑器关闭时，页面提前关闭，编辑器仍有一份。实际用例持续 8.83 秒，尚未达到 25 秒断言期限和生产 20 秒安全存储期限。事后检查隔离配置有系统加密主密钥，文件创建与修改时刻均在失败结束时，不能证明等待期间已持久化；新增供应商与密钥尚未提交。不能据此认定安全存储超时或密钥丢失。首次同场景实际通过，第二次失败仍保留，关闭来源未确认。

本轮没有找到足够证据支持生产修正。完整套件已按要求重新运行，但必要门禁没有通过；后续须定位这些窗口生命周期与截图问题，完成必要最小修正或可证实的环境处理后再完整复跑，不能靠扩大时限、跳过、记录默认值或旧专项结果关闭失败。

准确合并提交的 [Windows/Ubuntu 持续集成 38561585068](https://github.com/wwxst/agent-desktop/actions/runs/38561585068) 已完成，两平台均 `success`，返回 `head_sha` 精确等于 `f924f27ae4f0f761a8b4e0b4d3e4c4a7fbbcc99d`，证据为 `ci-merge.json`。报告新增后的准确最终 HEAD 仍须单独推送并检查两平台；本次合并 CI 不能冒充该后续提交 CI。

准确测试修正提交的 [持续集成 38563086869](https://github.com/wwxst/agent-desktop/actions/runs/38563086869) 首次运行是 Ubuntu `success`、Windows `failure`。Windows 现有 `extensions.test.ts:211` 的 bundle reconcile 用例超过原 5000ms，并在清理时报告 `ENOTEMPTY`；其余 85 文件、1013 测试通过，日志为 `ci-testfix-windows-job.log`。日志未确定具体耗时阶段，不能把清理错误猜定为生产缺陷或已解释的环境抖动。收口时本机使用原测试和原时限复核该文件 17/17 通过，reconcile 单项 153ms；这仅是本机证据，不能将远端首次失败改写为通过。最终文档提交的准确双平台结果由上述独立交付记录给出。

## 五、Windows 构建、运行资源及已有安装证据

本轮安装器为 `apps/desktop/dist/installer/Agent-Desktop-Setup-0.0.2-x64.exe`，`127582327` 字节，SHA-256：

```text
2e42cabea641234fbb7dfa710009a5ad5e57fd95213c414305d83cb064ba7517
```

`resource-hashes.json` 对本轮构建、准确 `b4dd427` 基线与本轮 `win-unpacked` 的主进程、预加载桥、三个插件入口及 MCP 清单、渲染 JS/CSS 共 11 项逐一核对，全部 `allMatch: true`。第二轮同时独立核对既有安装目录 16 项资源与其准确基线记录一致。安装器压缩包摘要变化不构成业务源码变化；构建与资源匹配也不冒充新安装器已完成全部运行专项。

此前第六阶段安装版的 Core、FFmpeg、Whisper、Vision、技能协同和当前版本恢复证据继续适用于相同生产链路，详见 [第六阶段报告](phase6-main-integration-20261014.md)。FFmpeg 14 工具和媒体正式交付、Whisper 中文/英文/混合语音、时间轴、407.1 秒长音频、取消、模型恢复及生命周期均有既有真实进程证据；Vision 安装版本机协议夹具只证明插件、授权与结构，不证明官方云理解。

此前 Whisper 曾出现 `transcript.json` 缺失并在独立复验通过，但根因未确认，继续作为稳定性观察项。本轮首次失败止于截图，尚未执行转录，不与该历史观察混为同一问题。若后续运行再现输出缺失，必须保留失败并定位，不能以空转录、额外重试或跳过消除。

本轮首次隔离配置实际执行 Whisper 模型网络下载，安装确认与 `diskBytes` 断言均已通过，模型文件为 487601967 字节，独立 SHA-256 为 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`，与资源锁一致。证据位于 `logs/whisper-plugin/installed-1791979954883/`，含下载中和模型就绪截图，下载项为 `PASS`；第二次隔离下载也得到同样大小的模型，证据为 `installed-1791980589521/`。两次截图失败后的识别与完整生命周期均未执行，不能按下载成功推导全专项通过。历史预置模型对应的下载 `SKIP` 保留，不改写旧结果。

## 六、真实云证据及范围限制

真实 Vision 与 Responses 外部门禁继续为 `PASS`。准确业务源码为 `b4dd427`，云验收来源为 `ca692fc5`，本轮合并提交完整树与来源一致，后续 `8b8f5be` 只修改现有验收身份断言，因此生产云调用链、配置与协议没有失效。完整证明见 [DeepSeek Flash 真实云验收报告](deepseek-flash-cloud-20261014.md)，没有修改历史报告的 `SKIP` 或失败结论。

既有官方 `https://api.deepseek.com`、`deepseek-flash` 验收覆盖单图、多图、FFmpeg 六帧、Responses 基础与 SSE、真实函数调用和结果回传、多轮输入、输出额度反证、真实摘要输入接受、最终完整回复 SQLite 保存与重启。第二轮独立复算为 15 次官方请求，输入 30424、缓存 18304、输出 4808、总计 35232 Token；此前公开价格估算约人民币 0.0634 元，不是实际扣费账单。

**本轮新增官方云请求为 0 次**，没有重复消费此前 15 次授权额度，没有查询余额或上传新内容。生产源码与受验链路一致，引用原有真实证据符合本轮授权范围。

限制保持明确：原生 PNG 文件选择入口、安装包直接连接官方云、官方真实失败故障注入及实际扣费账单仍为 `SKIP`；人工 6000 上下文窗口的两次摘要后最终请求流程为 `FAIL`，正确触发预算错误，恢复已取得真实摘要后正式请求接受为另一项 `PASS`。不能将这两项合并成小窗口全程通过。`previous_response_id`、服务端会话与 `context_management` 属于官方 `NOT SUPPORTED`，当前项目不依赖它们。

## 七、三轮最终审查与合并门禁

第一轮 Git 与架构完整性为 `PASS`：独立核验远端准确来源、双父顺序、完整树、阶段与功能祖先、两个非祖先分支的实际成果、main 模型和反馈文件、唯一专业工具注入及技能独立性；没有必要生产修正，没有发现本轮 P0/P1。

第二轮已有安全边界及证据适用性复核为 `PASS`，当前完整运行门禁为 `BLOCKED`：独立核验 SQLite 事务、检查点、未知效果、审批、取消、发布、视觉文件及密钥边界；确认安装资源适用性，并复算云账本与重启事实。既有成功 `analyze_images` 调用及结果各一条，Turn/Step 身份一致，最终回复一份、两个完成轮次、零持久化增量。后续新失败发生在启动、截图或设置等待过程，尚不足以确认生产根因，不能用静态安全复核覆盖当前失败。

第三轮工程与交付已完成证据审查，结论为 `BLOCKED`：构建、打包、安装资源及官方云证据适用，但两次完整浏览器仍失败，测试修正提交的准确 Windows 持续集成首次失败。没有已证实的新 P0/P1；未关闭运行问题仍可能包含实际回归，不能据此宣称零风险或可合入。最终文档提交的准确持续集成与干净、同步状态另在交付记录核验，不替代浏览器阻塞。

最终判定为 `BLOCKED`。必须关闭的事项是 Vision 启动窗口提前关闭、Whisper 连续两次窄窗截图超时、Settings 保存等待中页面关闭的原因及影响，并取得必要场景与现有完整浏览器无失败结果；远端测试超时需保留并结合准确最终提交结果处理。在这些门禁关闭前，即使最终文档提交双平台成功也不能合入。正式更新 main 仍需用户另行授权。

## 八、后续正式合并与回退边界

以下是取得明确正式合并授权后才执行的方案，本轮没有执行 main 推送。

从独立候选工作树再次 `git fetch origin`，确认 `origin/main` 仍为 `9c1a002015925070ba8274b4c20a986acf06fcea`；核对 `origin/codex/final-main-merge` 等于交付记录的完整最终 SHA、该 SHA 包含最新 main、工作区干净及准确 SHA 双平台 CI 通过。任一条件不符，停止并审查实际增量，更新候选与对应门禁。

全部条件满足后使用普通、非强制、准确对象推送；`<最终完整SHA>` 必须替换成实际已验证的交付提交，不使用会随本地状态变化的猜测值：

```powershell
git push origin <最终完整SHA>:refs/heads/main
```

这是从独立候选更新远端引用，不切换、清理或修改原 main 工作树。普通推送会拒绝无法快进的远端变化；推送后再核对远端 main 准确 SHA 及其 CI，继续保留所有原分支、工作树和用户文件，不自动发布版本。

如未来确认严重回归，从当时最新 main 创建独立回退分支。当前已知的后续测试提交修改了合并带入的文件，先普通撤销该测试修正，再撤销准确双父合并，避免直接移除合并留下与后续补丁交错的状态：

```powershell
git revert 8b8f5be368286866b6bf240cf0264e7293efe193
git revert -m 1 f924f27ae4f0f761a8b4e0b4d3e4c4a7fbbcc99d
```

合并第一父是此次原 main，撤销保留审计历史。本轮最终报告提交仅涉及文档，可保留作为审计，也可在上述两步前按交付记录准确 SHA 单独撤销；此后若新增业务提交，先审查其实际差异，不能假定上述步骤恢复所有后续状态。回退或正向修复均重新验证和审查后提交，不重写已推送历史、不强制推送。无需承诺旧程序读取当前数据库或跨版本数据回滚，也不得删除真实用户数据。
