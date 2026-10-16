# Whisper 插件化基线

本记录保留第三阶段起点，并记录独立 Whisper 插件的实现、门禁、真实验收和三轮审查。

```text
Branch       分支       codex/whisper-plugin，基于上一阶段实际提交 42d6f6b
Tests        测试       62 个测试文件，669 个测试通过
Desktop      桌面       createVideoAgent 仍可直接注册 TranscribeAudioTool
Semantic     语义       CheckVideoSemanticsTool 仍可直接消费 TranscribeAudioTool
Contract     契约       transcribe_audio(audioPath) 返回 text 与秒级 segments 时间轴
Runtime      运行时     whisper-cli 与模型仍由 Desktop 设置和环境变量提供
```

当前迁移目标是保留 `transcribe_audio` 的工具名称、`audioPath` 输入、`text` 与 `segments` 输出、错误语义和取消语义，同时删除 Desktop 与语义验收中的内置创建路径。

已确认的外部来源：

- whisper.cpp Windows x64 运行包：官方 `ggml-org/whisper.cpp` `v1.7.6` 发布资产 `whisper-bin-x64.zip`，下载后按锁定 SHA-256 校验。
- 默认模型：官方 `ggerganov/whisper.cpp` 模型仓库的 `ggml-small.bin`，按 Hugging Face LFS SHA-256 和声明体积校验。
- whisper.cpp 源码和运行包许可证：MIT；模型来源和原始 Whisper 模型许可说明以官方模型文档为准。

本阶段开始前执行并通过：

```text
pnpm check
pnpm desktop:build
git diff --check
```

基线不代表 Whisper 已插件化；后续提交必须证明插件启停、授权、取消、模型状态和视频语义验收都消费同一条插件调用链。

## 第三阶段实施验收

当前实现把 `transcribe_audio` 随包为 `plugin:whisper`，通过已有 MCP Runtime 注册；Desktop 不再在 `createVideoAgent` 或语义验收中创建 Whisper 实现。CLI 仍显式注入原本机 Tool。插件缺失或禁用时普通任务继续，候选有音轨但没有转录工具时语义验收 `blocked`；没有音轨的既有判断不要求 Whisper。外部工具名称、`audioPath` WAV 输入、完整 `text`/秒级 `segments`、审批和取消契约保持不变。

Windows x64 安装时仅下载 whisper.cpp 官方 v1.7.6 CPU 资源，按归档及五个所需 EXE/DLL 的 SHA-256、体积和 `--help` 实际加载验证；不依赖系统 Node、Whisper PATH 或用户路径变量。Small 多语言模型单独保存在用户数据目录，锁定官方 revision、487601967 字节和 SHA-256；展示下载进度，下载后流式校验，可导入同一官方模型、主动删除。卸载插件保留模型。模型及运行文件不是安装包内置二进制。

真实桌面证据脚本：`apps/web/tests/browser/desktop-whisper.pw.ts`。它运行真实 Windows Electron、实际 MCP stdio、官方运行程序和 Small 模型；网络模型响应用确定性夹具，语音由 Windows System.Speech Huihui/Zira 合成，因此不等于真人录音识别质量评测。用例覆盖普通/无插件任务、下载、中文/英文/中英混合、静音、空与损坏 WAV、FFmpeg 提取 WAV 后 Whisper、语义时间轴消费、超过一分钟语音、取消回收、审批、停用、卸载/重装和重启。每次运行把转录、审批、进程采样及 UI 截图存入 `logs/whisper-plugin/<electron-or-installed-time>/`。

实际短样本结果：7.4 秒普通话识别一段中文时间轴；5.84 秒英文识别三个单调段；6.4 秒混合语音保留中文和 English/camera/recording；静音 PCM16 在进程启动前明确报告无可转录语音；空和损坏 WAV 为失败而非成功。FFmpeg 从带英文音轨视频提取 WAV 后，转录结果与原始音频一致。模型下载真实接收 487601967 字节，完整性校验后才显示安装成功。界面默认及 800×600 截图已检查；通知复用扩展页已有 Toast（提示）。

```text
Gate                   门禁          实际结果
Baseline               基线          62 文件 / 669 测试全通过；更早审计的两个失败不属于本阶段基线
Whisper final check    全量测试      66 文件 / 689 测试通过，类型、19 个包架构、差异格式检查通过
Desktop build          桌面构建      主进程、预加载、FFmpeg/Whisper MCP 资源及 Renderer 构建通过
Electron real          真实桌面      官方程序及模型、取消回收、审批、停用、卸载重装、协同及重启通过
NSIS                   Windows 包   安装器退出码 0；安装文件与构建摘要一致；真实安装版完整生命周期通过
CI                     远端门禁      02c79aa 的 Windows 与 Ubuntu Actions 均成功，最终文档提交另行复核
Reviews                三轮审查      三次按不同范围单独复核；最终结论在下文记录
```

来源和许可：运行包和默认模型的锁文件位于 Whisper 插件目录；`LICENSE.whisper.cpp`、`LICENSE.model` 和 `NOTICE.md` 随插件资源保留。只声明 Windows x64 CPU，不声明 GPU。当前开发机隔离配置不等于全新 Windows VM 验收。不得将合成语音结果表述为真人语音质量保证。

## 真实安装版与协同证据

首次完整安装版证据：`logs/whisper-plugin/installed-1791775737555/`；最终版本完整证据：`logs/whisper-plugin/installed-1791778380741/`。两轮均为独立中文用户数据目录，应用及插件 PATH（程序搜索路径）仅含 Windows 系统目录，删除 `WHISPER_CLI_PATH`、`WHISPER_MODEL_PATH`、`FFMPEG_PATH` 和 `FFPROBE_PATH`。通过界面安装 Whisper 和默认模型，不用开发机预装 Node 或 Whisper。最终版本再次从空配置实际安装并下载模型，专项结果一项通过（3.7 分钟）。

`chinese.json`、`english.json`、`mixed.json` 保留完整转录及秒级时间轴。参考普通话“请带上水和相机”识别为“請戴上水和相機”，说明仍有字词误差；英文三段对应 0–2.04、2.04–4.16、4.16–5.84 秒。段落起止有限、单调且不超素材时长。首次完整安装版短样本整轮耗时分别 6052、6007、5473 毫秒，工具耗时分别 5355、5457、5249 毫秒；整轮包含 MCP 启动、宿主校验与模型夹具，不等于纯推理速度。

首次 `long-performance.json` 验证 81.42 秒样本，采样窗口 16551 毫秒、工具 15399 毫秒，峰值工作集 1037316096 字节。最终版本扩展到 407.1 秒合成语音：采样窗口 68596 毫秒、整轮 68140 毫秒、工具 67447 毫秒，峰值工作集 1086513152 字节，最后采样累计 CPU（处理器）时间 269.81 秒。204 段时间轴最后止于 407.1 秒；真实调用超过 SDK 默认一分钟等待且成功完成，未靠增加固定总时长上限通过。

最终 `chinese-performance.json`、`english-performance.json`、`mixed-performance.json` 分别记录 7.96、6.79、7.04 秒输入，采样窗口 6352、6305、6309 毫秒，峰值工作集 929026048、931463168、930697216 字节，末次处理器累计时间 19.08、19.00、18.98 秒。采样窗口含宿主及进程查询开销，处理器时间是多核累加。各进程结束后回收；短长样本峰值约 0.93–1.09 GB，未观察到持续运行至结束以外的内存增长。不能据此声称一小时媒体或所有时长的内存稳定性。

`combined.json` 验证 FFmpeg 提取 WAV 后 Whisper 转录；`semantic.json` 与 `semantic-judge-input.json` 验证真实候选的 30 帧、完整对白、候选摘要、逐项验收和最终发布。`semantic-missing.json` 验证禁用 Whisper 后音轨验收和候选验证受阻。视觉观察与独立语义判定使用确定性网络协议夹具，真实媒体进程、SDK（软件开发工具包）、Agent、审批、文件与交付组件不替换；不宣称真实云模型评测。无音轨媒体沿原 FFmpeg 桌面验收脚本另行通过。

`cancel.json` 记录运行中 Whisper PID（进程标识）退出及活动取消终态；拒绝审批保留明确错误。语义临时目录正常清理。`version-lifecycle.json` 验证损坏来源更新失败时旧 1.0.0 保留、更新 1.0.1、回滚 1.0.0、487601967 字节模型不变，以及更新后和回滚后真实识别。版本升级由隔离安装副本的元数据构造，不冒充线上已发布 Whisper 新版本。

最终 `skills.json` 验证加载已安装 `semantic-editing` 后调用 Whisper，公开名唯一，随后执行完整视频验收与发布；`long-path.json` 验证 304 字符中文及空格路径。实际修改模型首字节后界面返回摘要错误且工具不注册，恢复字节后 `model-restored.json` 验证再次成功识别。

最终安装器：`apps/desktop/dist/installer/Agent-Desktop-Setup-0.0.2-x64.exe`，128358829 字节，SHA-256 `ba825fa869c65eb4ed6e3e5b57aa3bab797904e48b9d400d5813cebf077b701a`。安装退出码 0，安装主进程与构建摘要一致；仅生成本地产物，没有发布发行版。

界面回归执行 30 项：首次 19 通过、9 条安装版/平台条件跳过、2 条旧路径控件断言失败；同步为插件入口后这两条在默认和 800×600 尺寸重跑通过。跳过项不是本轮真实安装版专项的替代。默认、下载和窄窗口截图无模型区溢出或控件遮挡。

## 三轮审查

三轮由本轮执行者分别按独立范围复核，不声称外部人员或独立子代理审查。

第一轮：架构。追踪 Desktop → 扩展准备 → 通用工具注入 → 语义验收及 CLI 显式组装。发现取消修复曾扩展 Agent Loop（智能体循环）追踪公共事件，违反本轮核心契约限制；已撤去该改动，改由 Desktop 消费既有 `turn.cancelled` 与未完成 Session 调用，结束原活动行。`agent-loop`、Session（会话）和 Tool Registry（工具注册表）公共契约没有本轮差异。Whisper 与 FFmpeg 相互独立，语义组件没有旧创建路径。复核：`PASS`。

第二轮：功能与安全。复核媒体真实路径、附件、目录链接、衍生 WAV、模型路径固定、连接配置防远程替换、结果时间轴、审批和进程收尾。发现音频附件提示仍仅允许配音，会误导独立语音任务；已改为允许已安装 `transcribe_audio` 识别 WAV。实际取消活动曾永久运行，现已修复；错误和取消不伪造成功。模型状态中的磁盘读取兜底已删除，读取失败不能显示为零占用。长路径实测发现官方程序拒绝超过 260 字符的输入，已按工具生命周期暂存已授权音频并真实复测通过。SDK 原有 60 秒等待超时会截断较慢识别，已用真实已运行秒数通知与进度重置修复；专项及实际超过一分钟处理均通过。407.1 秒样本曾返回 408 秒尾段，现依据 WAV 采样时长限制结束时间，超出素材的起点仍失败；真实长样本、测试和语义证据复核通过。复核：`PASS`。

第三轮：工程与发布。复核官方 v1.7.6 归档、全部 CPU DLL（动态链接库）及模型锁、MIT 许可、安装包资源、失败更新/回滚与模型保留。实际 Windows 目录发布短暂句柄冲突以三次有界重试处理；专项用例仅在 Windows 执行。修复过时设置页浏览器断言和文档漂移；首次拆分提交漏带浏览器同步导致两平台类型失败，后续闭环提交修复；Windows 运行器短路径别名断言改为真实路径比较后通过。CPU 实际识别与全量测试同机同时运行曾导致生命周期用例超时，串行门禁恢复通过，未降低断言或放宽全局超时。最终核心契约未改，未新增 package（模块包）、第三方框架或通用资产平台。安装版与远端两平台复核：`PASS`。

## 提交与回退

功能分支：[codex/whisper-plugin](https://github.com/wwxst/agent-desktop/tree/codex/whisper-plugin)。提交范围如下，最后验收记录提交的自身标识由最终交付附上：

```text
77b9c99  迁移基线    test: establish whisper migration baseline
5061df2  独立服务    feat: add standalone whisper mcp plugin
384589f  管理与切换  feat: manage whisper resources and inject plugin capabilities
250e66d  长音频修复  fix: bound whisper timelines and synchronize acceptance tests
02c79aa  跨平台验收  test: compare canonical whisper paths on Windows
```

`384589f` 将宿主管理资源、模型界面与调用切换组成闭环，但单独提交缺少后续浏览器类型同步，不作为可单独合并版本；至少包含 `250e66d`，Windows 远端门禁需包含 `02c79aa`。重现门禁：`corepack pnpm install --frozen-lockfile`、`corepack pnpm check`、`corepack pnpm desktop:build`。专项：`corepack pnpm --filter @agent-desktop/web exec playwright test --config playwright.config.ts tests/browser/desktop-whisper.pw.ts --project=chromium-desktop`，从仓库根执行并以 `DESKTOP_ACCEPTANCE_EXECUTABLE` 指向安装版。

远端复核：[Actions 38202943627](https://github.com/wwxst/agent-desktop/actions/runs/38202943627)，完整 `02c79aab7087c3e0eeb76eae82f0fb3f02cd3240` 的 Windows 与 Ubuntu 工程门禁、构建和已提交差异检查均成功。最终文档提交也需确认对应两平台结果。

新实现按后续提交逆序 `git revert`（反向提交）回退；调用切换、模型接口与界面需整体回退。更新失败保留旧插件，用户可用既有版本回滚。代码回退和插件卸载都不删除用户模型、会话、设置、输入和成片；没有自动合并主分支或创建发行版。

## 已知限制

仅核验 Windows x64 CPU、官方 Small 多语言模型和开发机隔离安装版；未核验全新虚拟机、GPU（图形处理器）加速、真人录音质量、其它模型或一小时音频。网络下载失败从头重试，不实现断点续传。主应用及插件在线真实版本升级、签名发行和远程市场发布尚未实施，不将元数据更新夹具当作正式分发证明。

后续 Vision（视觉理解）插件化可沿用宿主通用工具注入、受控公开名、路径授权、审批、结果转换及缺能力受阻流程；先固定现有视觉结果及语义证据契约，再实施独立插件，不提前建设覆盖所有模型的资产框架。
