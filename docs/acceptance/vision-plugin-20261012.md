# Vision 插件验证记录

本阶段在 `codex/vision-plugin` 上从 Whisper 阶段的 `241123f` 开始，将 Desktop 的 `analyze_images` 转为独立插件；当前事实和接口边界以 [架构文档](../architecture.md#desktop-vision-插件) 为准。本记录只保存已执行证据和未执行范围，不把协议夹具成功写成真实云视觉模型成功。

```text
Tool Contract         工具契约          images[{path,timestamp}] 一至六张 JPG/PNG，返回完整 summary 与 frames。
Explicit Injection    显式工具注入      Desktop 和语义验收消费已启用插件，CLI 在自身入口选择本机实现。
Upload Approval       图片外传审批      路径先授权，调用审批显示所选服务地址，密钥不出现在审批内容。
Protocol Fixture      协议测试夹具      本机 HTTP 返回确定性观察，真实执行 MCP、文件读取和请求映射。
Cloud Verification    云端视觉验证      真实供应商对真实图片的观察质量，不能由本机夹具代替。
```

## 当前自动化证据

开发机运行时为 Node.js `24.20.0`、pnpm `11.22.0`；CI（持续集成）的声明基线仍为 Node.js `24.19.0`，本机结果不称为远端 CI 结果。

已执行 `corepack pnpm typecheck:tests`，通过全部测试 TypeScript 类型检查。已执行 `corepack pnpm exec vitest run apps/desktop/tests/vision-tool.test.ts --exclude logs/**`，一个测试文件、十一项用例通过：

- 真实 bundled service（随包服务）通过 stdio MCP 向本机 HTTP 发送 Responses（响应）和 Chat Completions（对话补全）两种协议；实际图片读取、PNG 数据地址、所选模型、输出上限和授权头一致。
- 调用审批包含所选服务的地址，不含密钥；拒绝启动或调用不发送图片；在途 HTTP 调用经 MCP 取消并断开。
- 第三方 `analyze_images` 保持限定名称，无法获得已选择供应商的 `VISION_API_KEY` 或 `VISION_BASE_URL`。
- Vision 连接握手失败只移除本插件，另一个真实 MCP 服务仍能完成调用；没有回退到 Desktop 内置视觉工具。
- JPG/PNG 真实路径归一化；中文、空格且超过 260 字符的图片路径在两种协议下实际经过 MCP 和 HTTP 请求。精确选择的图片可以读取，邻居文件、目录链接、网络路径、缺少授权、错误图片数量、非有限时间戳和非图片扩展名在上传前失败。
- MCP 的结构化结果及文本 JSON 转为相同完整观察；服务失败保留消息，缺少字段、遗漏帧、错位时间戳和坏 JSON 不能成为成功观察。
- 同一宿主适配器消费来源已授权输出项内的语义临时帧；七帧以六加一分批，完整观察、候选摘要和判定证据保留，临时图片结束后清理。内部观察不伪造独立公开 Session（会话）事件；缺少 Vision 时结果明确受阻且不请求判定模型。

这组测试的语义用例在模型和媒体工具外部边界使用确定性夹具，不证明 FFmpeg、Whisper 或云模型在本阶段的真实效果；已验证的媒体阶段记录仍可从 [FFmpeg 验收](ffmpeg-plugin-20261011.md) 和 [Whisper 验收](whisper-plugin-baseline-20261012.md) 追溯。

## 全量门禁与真实 Windows 安装版

2026-10-12 实际执行 `corepack pnpm install --frozen-lockfile`、`corepack pnpm check`、`corepack pnpm desktop:build`、`corepack pnpm desktop:package:win` 和 `git diff --check`。全量结果为 67 个测试文件、709 项测试全部通过，生产及测试类型、十九个工作区包架构和补丁格式检查通过。Node.js 为 `24.20.0`；远端使用声明基线 `24.19.0`。新增图片编码头部/尺寸、单张和整批预算、HTTP 错误、显式未完成响应、超时和取消用例；既有 CLI 视觉测试改用实际 JPEG 和完整六帧观察，没有删除成功断言。

已确认基线 `241123f` 的两平台 CI 成功：[Actions 38203237608](https://github.com/wwxst/agent-desktop/actions/runs/38203237608)。恢复 checkout 时只有原工作树登记及分支，上一轮未提交修改不在磁盘，故从该基线重建。本轮不修改主分支，也不覆盖其它工作树的修改。

真实桌面入口为 `apps/web/tests/browser/desktop-vision.pw.ts`。开发 Electron 一项完整场景通过（46.3 秒），证据 `logs/vision-plugin/electron-1791789028721/`。NSIS 安装器在中文、空格隔离目录 `logs/vision-plugin/安装 验收/` 实际安装，退出码为 0；安装版同一专项一项通过（20.1 秒），证据 `logs/vision-plugin/installed-1791789286120/`。安装版记录 22 个场景、14 次实际本机 HTTP 图片请求。应用和插件进程 PATH 仅含 Windows 系统目录，删除了媒体与模型路径环境变量；运行 Vision 使用安装版 Electron，不需要用户额外安装 Node。

本轮安装器 `apps/desktop/dist/installer/Agent-Desktop-Setup-0.0.2-x64.exe` 为 127484453 字节，SHA-256 `78558a69ea5d76195344d2164dab314ae757db93e18de4d2491fb6f2e91d9739`。仅创建本地产物，没有签名发布或上传 Release（公开发行版）。安装源和已安装主进程、Vision 资源摘要另作本地比对。

实际覆盖：

- 独立 Vision 在没有 FFmpeg/Whisper 工具时处理已确认目录中的中文 PNG；所选模型、协议、输出预算和鉴权头实际到达本机服务。Chat Completions 和 Responses 都返回完整结构化观察。
- 无插件、未选模型、缺密钥、禁用、卸载或拒绝启动时，工具目录不含 `analyze_images`；重启保留禁用状态，重新启用和重装后恢复。没有内置绕过。未授权图片及拒绝调用不会上传。
- 图片外传审批实际显示“Vision 图片上传”、所选服务地址与 JSON 转义的精确本地路径；默认窗口截图已检查，允许/拒绝按钮可达，密钥不在界面。路径在独立可滚动的参数区展示。没有修改共享客户端布局。
- 不完整观察明确失败。在途上传取消后，Vision MCP 进程 PID 从 `18552` 变为不存在，HTTP 连接关闭；没有记录成功的取消观察。
- 安装版升级来源损坏时，直接核对已安装清单仍为 `1.0.0`；恢复可用来源后旧版仍能运行。实际更新到隔离元数据版本 `1.0.1` 并分析，再回滚 `1.0.0` 并再次分析。`version-lifecycle.json` 保存结果；版本仅为验收夹具，不冒充线上已发布新版。
- 安装版数据库及开发/安装版追踪日志中搜索测试密钥与 `data:image/`，未发现明文视觉密钥或图片 Base64。受控子进程创建工具后删除环境密钥；它仍在实例内持有凭据直到本轮进程关闭，不宣称抵御同用户进程读取内存。

## 三插件协同与独立媒体复核

安装版真实安装并使用 FFmpeg/Whisper 受控运行资源；Whisper 模型从本机已锁定 Small 模型复制进隔离用户模型目录，再由宿主按现有体积及 SHA-256 规则校验。语音输入由 Windows `System.Speech` 的 Zira 合成，不代表真人识别质量；没有使用外部 Whisper PATH。用于生成和独立复核素材的开发机 FFmpeg 不作为产品插件运行程序。

`semantic.json` 记录 FFmpeg + Vision：真实红色无音轨素材剪为 0.6 秒、160×120 的候选，实际抽取三帧、完整观察、语义验收、候选验证及正式交付全部通过。发布文件 1689 字节，独立像素检查为红色，完整解码退出码 0；没有 Whisper 也不要求无关语音证据。

`full-chain.json` 记录技能 + FFmpeg + Whisper + Vision：加载 `semantic-editing`，裁剪实际带合成对白的红色视频，真实解码、按原始帧率逐帧提取、WAV 提取和 Small 模型转录，十五帧观察与完整对白进入独立判定，再经候选验证正式发布。发布文件 25140 字节，独立探测为 3.0 秒、160×120，含视频和音频流；完整解码退出码 0。Whisper 返回“please bring a camera we are walking in the”，时间段为 0–2 秒与 2–3 秒，末尾随三秒素材截断，未声称完整保留原合成句子。

`semantic-vision-disabled.json` 验证禁用 Vision 后需要视觉的候选验收 `blocked`、验证受阻、发布拒绝；不降低原验收规则。语义临时帧清理，证据保留候选摘要及完整观察。`independent-media-checks.json` 保存两份正式视频的独立探测和完整解码结果。通用工具、FFmpeg、Whisper、交付与语义自动化回归均包含在全量 709 项中。

上述桌面专项中的主对话、工具编排、Vision 观察和独立语义判定均由本机确定性 HTTP 夹具提供。实际验证了技能加载、工具组合、真实媒体处理、语音识别、审批和交付；没有验证真实 DeepSeek 根据技能自主规划剪辑，也没有证明云视觉观察和语义判断的质量。

本阶段另外重跑原 Whisper 安装版专项，结果为一项通过（3.3 分钟），证据 `logs/whisper-plugin/installed-1791789830196/`。二十种场景包括插件缺失、普通任务、中英文与混合语音、长音频、长路径、模型校验、拒绝、取消、语义交付、失败更新、更新回滚和重启；缺少 Whisper 的场景没有暴露 `transcribe_audio`，需要对白的语义验收明确受阻。成功语义场景具有三十帧和真实转录，发布视频 46771 字节。脚本只增加独立 Vision 的启用前提及唯一工具断言，保留已有断言。

旧 Probe/FFmpeg 安装版专项一项通过（1.3 分钟），证据 `logs/ffmpeg-plugin/installed-1791790592279/`，命令日志 `logs/vision-plugin/probe-regression-20261012-153630.log`。十七种场景覆盖真实媒体探测、目录及附件权限、链接拒绝、审批拒绝、取消回收、三帧语义验收、正式发布、停用受阻、重启、卸载重装。第一次因没有提供覆盖安装配置而跳过的两项已补齐：实际用同一安装器覆盖隔离安装目录，退出码 0，前后会话数据库 SHA-256 一致；随后历史恢复和 FFmpeg 详情页更新回滚两项均通过（10.5 秒，无跳过）。安装记录为 `logs/vision-plugin/probe-upgrade-install-20261012.json`，补跑日志为 `logs/vision-plugin/probe-upgrade-regression-20261012-154134.log`，截图保存在同一 Probe 证据目录。

复现 Vision 安装版专项时，在仓库根目录执行以下命令。`installed-profile` 是本轮隔离配置，已通过现有插件模型管理导入并校验 Small 模型；换用全新目录时须先在同一隔离配置内准备该模型，否则完整三插件场景会明确记录 `SKIP`。开发机 FFmpeg 只生成及复核素材；安装版进程的程序搜索路径仍只含系统目录。`english.wav` 是本轮 Windows 合成对白素材。

```powershell
$visionRoot = (Get-Location).Path
$env:DESKTOP_ACCEPTANCE_EXECUTABLE = Join-Path $visionRoot 'logs/vision-plugin/安装 验收/Agent Desktop.exe'
$env:DESKTOP_ACCEPTANCE_PROFILE = Join-Path $visionRoot 'logs/vision-plugin/installed-profile'
$env:DESKTOP_ACCEPTANCE_FFMPEG = (Get-Command ffmpeg).Source
$env:DESKTOP_ACCEPTANCE_AUDIO = Join-Path $visionRoot 'logs/vision-plugin/english.wav'
Push-Location apps/web
try {
  corepack pnpm exec playwright test tests/browser/desktop-vision.pw.ts --project=chromium-desktop --workers=1
} finally {
  Pop-Location
}
```

Whisper 复现入口使用同一安装版，选择单独的 `DESKTOP_ACCEPTANCE_PROFILE`，在 `apps/web` 执行 `corepack pnpm exec playwright test tests/browser/desktop-whisper.pw.ts --project=chromium-desktop --workers=1`；该脚本自行生成合成语音并经现有入口下载、验证模型，需要锁定运行资源和模型下载地址可达。本轮使用 `logs/vision-plugin/whisper-regression-profile`，没有复用 Vision 的安装版配置。

Probe 复现入口在同一目录执行 `corepack pnpm exec playwright test tests/browser/desktop-probe.pw.ts --project=chromium-desktop --workers=1`，同样设置安装版执行器。两项覆盖安装用例要求先实际覆盖同一隔离安装目录，再将 `DESKTOP_UPGRADE_PROFILE` 指向主专项保留的 `用户 数据` 目录，并使用 `--grep "installed application|installed FFmpeg"` 单独执行；本轮指向 `logs/ffmpeg-plugin/installed-1791790592279/用户 数据`。没有只设置变量却跳过实际覆盖安装。

## 三轮审查与提交

三名子代理分别按架构、功能安全和工程发布范围检查本阶段实际差异，发现后实际修复，再执行相关检查。报告见 [三轮审查](vision-plugin-reviews-20261012.md)。这属于本轮代理独立分工，不声称外部人工审查。

第一份功能提交：`bb8c1a334d2347493ebecb626e0acc83cc146980`，包含独立服务、宿主配置/授权、应用层注入、边界测试、构建和架构文档；后续验收脚本与报告单独提交。最终分支：[codex/vision-plugin](https://github.com/wwxst/agent-desktop/tree/codex/vision-plugin)。

验收脚本提交：`8ce6e94bebca1bf1d81d5798b319047047530f80`，包含超过 260 字符的图片路径、Vision 桌面专项和旧 Probe/Whisper 脚本的显式视觉依赖。报告本身作为后续文档提交；本阶段完整提交可执行 `git log 241123f..codex/vision-plugin --format="%H %s"` 核对。

功能提交的 [Actions 38216855183](https://github.com/wwxst/agent-desktop/actions/runs/38216855183) 最终为 `Success`，Ubuntu 与 Windows 两项任务全部成功。本轮通过 GitHub 运行页面核对提交、总状态和两项任务，原始页面保存为 `logs/vision-plugin/ci-bb8c1a3.html`。补充长路径测试和旧桌面脚本后，再次执行 `corepack pnpm check`，仍为 67 个文件、709 项测试和十九个工作区包架构检查通过；日志为 `logs/vision-plugin/final-check.log`。

验收脚本提交的 [Actions 38219019860](https://github.com/wwxst/agent-desktop/actions/runs/38219019860) 最终同样为 `Success`，Ubuntu 与 Windows 门禁和构建成功。运行页面包含完整提交 `8ce6e94bebca1bf1d81d5798b319047047530f80`，原始页面为 `logs/vision-plugin/ci-8ce6e94.html`。远端门禁验证代码、测试和构建；Windows 安装版专项由本机实际运行，不把远端构建称为安装版验收。

## 未执行范围与合并依赖

环境没有已授权的视觉 API 密钥；未消耗真实视觉额度，真实供应商单图、多图、视频帧、中文/英文提示词和理解准确性均标记为 `SKIP`（未执行）。本机确定性视觉响应、HTTP 状态测试和结构化判定不代表云模型已经通过真实线上验收。现有“获取可用模型”只检验连接、鉴权和目录；`images` 能力标记约束模型选择，实际图片推理支持仍须用真实 `analyze_images` 检验。

图片校验覆盖格式头部、分段完整性和尺寸，不替代完整解码或证明所有损坏编码可被本地识别；供应商解码拒绝保持工具失败。网络图片 URL 不作为输入；用户主动配置的本机或私网 OpenAI 兼容服务仍需逐次明确审批，不将模型输入变成任意网络请求目标。MCP 审批不是操作系统沙箱；插件以当前用户权限运行，同用户恶意进程或被篡改插件不在该宿主路径适配器可完全约束的范围内。

Windows 验收来自现有开发机上的独立安装目录和隔离配置，未测试全新虚拟机、全部图片编码、真实线上插件市场或线上插件版本发布。没有自动合并 `main`。合并时须包含 FFmpeg → Whisper `241123f` → 本轮 Vision 的完整依赖链；不能只挑选工具切换而遗漏宿主适配器、构建资源、配置和测试。先核对主分支当时实际差异与其它并行功能，再整体验证；真实在线视觉验收补齐前，不能宣称完整业务验收或满足真实外部能力的合并门禁。
