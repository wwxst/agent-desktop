# Vision 插件审查记录

本文只记录本阶段三轮审查的范围、发现和结论；当前实现边界以 [架构文档](../architecture.md#desktop-vision-插件) 为准，执行证据和未完成的真实验收以 [阶段验证记录](vision-plugin-20261012.md) 为准。

```text
Architecture Review    架构审查          核对真实调用链、依赖方向、插件身份和授权边界。
Functional Review      功能审查          核对实际成功、失败、取消和语义证据行为。
Release Review         发布审查          核对工程门禁、资源构建、分发和验收范围。
```

## 第一轮：架构与调用边界

审查范围覆盖 Desktop 主进程的设置读取、扩展发现、进程启动、工具映射、文件授权与钩子，独立 Vision 服务及现有视觉提供商实现，`createVideoAgent`、`CheckVideoSemanticsTool`、CLI 组装入口，以及依赖清单、项目引用、资源构建和安装包配置。审查基于 `241123f` 后本阶段的实际差异与直接调用链，不扩展清理其它模块。

发现并修正：

- 内置 Vision 服务握手失败原先沿通用扩展路径中断整轮任务。现已只移除尚未握手成功的 Vision 服务，返回明确不可用说明；其它插件及普通任务继续。握手后的损坏清单、工具冲突或程序错误仍明确失败，没有回退实现。
- Vision 连接配置入口最初只按插件 ID 拒绝操作，会误伤用户安装的同名本地插件。现已同时核对 `builtin` 来源；历史内置连接记录不能把受控服务改接远程地址或替换设置凭据，第三方插件仍保持自己的连接配置。
- Responses（响应）接口原先可能接受声明为 `incomplete`、但碰巧包含完整 JSON 的返回。视觉提供商现已拒绝显式非完成状态；兼容服务没有该状态字段时仍必须满足完整观察字段和逐图片时间戳对应要求。该修正由提供商实现负责人完成，并增加回归用例。

核对结果：

- 六个 Agent Core（智能体核心）包没有变更，也没有接入插件协议、Electron、视觉供应商或媒体实现。视频应用层只消费显式注入的通用 `Tool`，已删除视觉具体实现依赖；CLI 在自身入口保留显式本机实现选择。
- Desktop 仅给内置 `plugin:vision` 的 `vision` 服务映射 `analyze_images`。第三方同名服务保持限定名称，不能获得宿主选择的视觉密钥、地址或公开工具身份。
- 密钥由现有系统安全存储加密保存，只在启动审批后注入该轮受控进程；不进入清单、命令参数、调用审批或会话事实。调用审批先展示图片路径和上传目标，宿主先按真实路径检查确认目录、精确附件或授权候选来源。
- 公开 `analyze_images` 与内部逐帧语义验收复用同一个已授权并已包装钩子的实例。缺少、停用、卸载、拒绝启动或配置不完整时没有内置回退；语义验收保持受阻行为，临时帧收尾继续由原应用层负责。
- Vision 资源接入现有 `build` 链及 `resources/**/*` 安装包分发规则，使用 Electron 自带运行时；不增加包、下载资源管理器或新核心抽象。原子安装、更新及回滚继续复用现有扩展存储。

本轮验证在 Node.js `24.20.0`、pnpm `11.22.0` 执行。`corepack pnpm typecheck`、`corepack pnpm typecheck:tests` 和 `corepack pnpm check:architecture` 均通过；架构检查覆盖十九个工作区包。以下聚焦命令通过九个文件、一百二十八项用例，覆盖主进程组装、设置、插件配置、真实 MCP 与本机 HTTP、提供商、应用层及语义验收：

```powershell
corepack pnpm exec vitest run apps/desktop/tests/runtime-settings.test.ts apps/desktop/tests/extension-runtime.test.ts apps/desktop/tests/extension-platform.test.ts apps/desktop/tests/extensions.test.ts apps/desktop/tests/main-entry.test.ts apps/desktop/tests/vision-tool.test.ts packages/vision-openai/tests/vision-openai.test.ts packages/video-agent/tests/video-agent.test.ts packages/video-agent/tests/semantic-check.test.ts
```

现有“获取可用模型”使用已鉴权的 `/models` 请求，只证明服务可连接、密钥可用于模型目录查询；图片能力声明由设置边界强制检查，真实图片推理支持仍由实际视觉调用验证。该动作不宣称已经验证云模型的图片理解质量。本轮协议夹具和代码审查也不能代替真实云端请求、完整桌面安装生命周期或远端两平台门禁。

```text
Review:
- Findings: 上述三项发现均已修正，无剩余架构阻断项。
- Required changes: 无；完整工程与真实验收结论见阶段验证记录。
- Decision: PASS
```

## 第二轮：功能、上传授权与证据完整性

本轮独立复核真实路径授权、逐次上传审批、凭据隔离、协议及模型配置、请求预算、取消收尾、响应映射，以及候选语义验收与发布的直接调用链。复核依据为当前源码、相关测试和本轮实际执行结果；不以第一轮结论代替复核。

核对结果：

- 宿主逐图片解析真实路径后才进入 MCP（工具协议）调用审批；已确认目录、精确附件和来源已授权输出项内临时帧使用同一规则。邻居文件、目录链接、网络路径和无目录基准的相对路径不能扩大读取范围。输入中的额外配置字段在适配器边界剔除，不能替换图片上传服务或凭据。
- 启动审批批准后，仅受控 Vision 子进程获得当前视觉供应商的地址、密钥、协议、模型和输出上限；子进程创建工具后删除环境中的密钥。其它 MCP 服务与命令钩子不继承这些视觉设置。调用审批显示目标服务来源地址及实际解析路径，不包含密钥；拒绝启动或调用不会发送图片。
- 每批必须为一至六张 JPG/PNG，时间戳必须有限。图片扩展名、编码头部、尺寸、单张和整批字节数，以及序列化请求预算在实际网络上传前检查；这些检查不宣称完整解码图片。网络请求禁止重定向，具有五十秒预算，HTTP（网络请求协议）失败和超时保持失败语义，不重放上传。
- 两种模型协议均验证完整观察字段、帧数量、输入顺序和逐图片时间戳。第一轮修正后的 Responses（响应接口）明确拒绝非完成状态；Chat Completions（对话补全接口）要求正常完成。遗漏帧、错位时间戳、损坏 JSON（结构化文本）和服务失败不能成为成功观察。
- 取消在宿主适配器、MCP 调用和实际 HTTP 请求间传播，保持 `AbortError`，不变成可继续执行的普通错误。真实在途请求的取消测试确认连接断开；正常、失败和取消均复用现有进程关闭链路。
- 公开观察和语义验收使用同一个已授权工具实例。逐帧验收按六张加余数分批；完整观察保存在语义结果中，并绑定输出项、候选路径和候选内容摘要。验收后的内容改变、覆盖不完整、缺少视觉能力或拒绝观察均不能通过发布门禁；临时帧在收尾删除，内部观察不伪造独立会话事实。

未发现需要新增产品修正的功能或安全阻断项。真实桌面脚本首次执行暴露了测试断言使用未转义 Windows 路径与审批 JSON 文本比较的问题；已修正为匹配实际 JSON 转义路径，产品授权行为未因此改变。实际桌面脚本的完整执行结果由阶段验证记录继续维护。

本轮在 Node.js `24.20.0` 下实际执行下列聚焦验证，四个文件、六十三项用例通过，包含真实随包服务构建、MCP 子进程及本机 HTTP 网络边界：

```powershell
node node_modules/vitest/vitest.mjs run packages/vision-openai/tests/vision-openai.test.ts apps/desktop/tests/vision-tool.test.ts packages/video-agent/tests/semantic-check.test.ts packages/video-agent/tests/delivery.test.ts --exclude logs/**
```

本轮没有花费真实云模型请求，也没有以本机协议夹具证明云视觉识别质量。桌面安装、更新、回滚和完整插件协同链路的最终结论，以及远端 Windows/Linux 门禁，仍以阶段验证记录中的实际结果为准。

```text
Review:
- Findings: 无剩余功能或安全阻断项；已复核第一轮响应完成状态修正。
- Required changes: 无；真实桌面与外部验证结果由阶段验证记录维护。
- Decision: PASS
```

## 第三轮：工程、安装分发与发布边界

本轮由不同审查子智能体独立核对当前功能差异、工程门禁、构建链、资源分发、Windows（视窗系统）生命周期脚本及文档口径。审查覆盖实际清单和源码，不把前两轮结论当作发布证据；完整执行记录仍由阶段验证记录维护。

核对结果：

- `build:vision` 已进入 Desktop 的 `build`、`start`、`dev` 和 Windows 打包调用链；服务构建为自包含 CJS（通用模块格式）资源，使用 Electron 自带运行时。现有 `resources/**/*` 分发规则包括插件清单及构建产物，`asar: false` 保证子进程使用真实磁盘路径；生成的 `resources/plugins/vision/dist/vision.cjs` 已确认受 Git 忽略规则管理。
- 依赖与 TypeScript 项目引用对应真实消费方：视频应用层删除具体视觉实现依赖，Desktop 的插件入口和宿主结果转换显式依赖现有视觉工具包，CLI 继续在自身入口选择本机实现。没有新增模块包、第三方依赖、通用资源管理器或核心接口；六个核心包及根工作区配置没有本阶段差异。
- 现有 Ubuntu（Linux 发行版）和 Windows CI（持续集成）均执行 `pnpm check` 与 `pnpm desktop:build`，测试发现范围与资源构建入口已包含 Vision。未为本阶段增加另一套测试框架或重复门禁；远端结果必须核对实际提交，不能由本机成功替代。
- 真实桌面专项使用隔离中文用户数据目录及仅含 Windows 系统目录的程序搜索路径，清除已有模型和媒体路径环境变量。普通任务、配置缺失、上传审批与拒绝、取消回收、启停、重启、卸载重装和语义验收均保留明确断言；可选协同链路将未满足条件记录为 `SKIP`，不会冒充通过。
- 安装版的更新夹具先损坏可用来源以验证旧安装清单不变，再恢复来源后检查旧版仍可调用，随后完成 `1.0.1` 更新和 `1.0.0` 回滚。修改过的来源清单由 `finally` 恢复；该夹具只证明本机原子替换与版本恢复，不代表线上已有新版本、自动更新服务或正式发布。
- 文档已区分目录连接、图片能力声明与真实图片调用。`/models` 只能证明连接及鉴权，不能证明云端模型支持图片；本机 HTTP（网络请求协议）夹具的观察与判定不能替代真实云模型质量验证。未执行范围保持明确状态。

本轮独立实际执行 `corepack pnpm typecheck:tests`、十一项 Vision 宿主测试、十九个工作区包的架构检查及 `git diff --check`，全部通过。生成资源的忽略状态及核心差异已独立核对。最终执行者提供并由本轮复核其证据范围的结果如下：

```text
Engineering Gate       工程门禁          pnpm check 通过，67 个测试文件、709 项测试通过。
Desktop Build          桌面构建          pnpm desktop:build 通过，包含三个专业插件服务。
Windows Package        安装包构建        NSIS 构建通过，隔离安装器退出码为 0。
Electron Acceptance    开发版验收        一项专项通过，46.3 秒。
Installed Acceptance   安装版验收        一项专项通过，20.1 秒，覆盖 22 个任务场景。
Plugin Cooperation     插件协同          FFmpeg、Whisper Small、Vision 和技能完成实际候选验收及发布。
Cloud Vision           云端视觉请求      SKIP，当前环境没有真实视觉服务密钥。
Clean Windows VM       全新系统验收      未执行，不声明全新虚拟机结果。
Remote CI              远端持续集成      bb8c1a3 的运行 38216855183 已成功，Ubuntu 与 Windows 均通过。
```

实际安装位置为 `logs/vision-plugin/安装 验收/Agent Desktop.exe`，本轮安装版证据为 `logs/vision-plugin/installed-1791789286120/`。已读取该目录的 `summary.json`、`version-lifecycle.json`、`cancel.json` 和 `independent-media-checks.json`：二十二个场景包含配置缺失、两种协议、授权拒绝、错误响应、取消、重启、更新与回滚；取消前的进程标识在结束后消失，上传连接已断开。两个协同场景均为 `PASS`；完整协同使用真实 FFmpeg、Whisper Small 模型及十五帧、三秒音视频，主对话编排、Vision 观察与独立判定使用本机协议夹具，没有验证真实模型根据技能自主规划。独立媒体检查确认无音轨成片为 0.6 秒、有对白成片为 3 秒，二者完整解码退出码均为 0。

```text
Review:
- Findings: 无剩余工程实现阻断项；本机测试、构建、安装及生命周期证据范围明确。
- Required changes: 功能与验收脚本提交的两平台远端门禁已由执行者核对成功，详见阶段验证记录；真实云视觉调用及全新系统验收尚未完成，不得宣称通过。
- Decision: PASS，限定于当前工程实现；完整外部验收仍以真实视觉请求为条件。
```
