# Agent Desktop Architecture

本文档定义 Agent Runtime MVP（智能体运行时最小可行版本）及当前视频智能体应用层的核心边界。它描述职责、事实流和依赖方向，不预先设计当前范围之外的系统。

开发、审查和验收以根 [`AGENTS.md`](../AGENTS.md) 的项目开发总原则与最小实现规范为准。本文保留的历史兼容路径只描述尚存实现，不构成继续维持旧程序、接口或数据兼容的要求；删除仍须符合本轮范围和实际消费者证据。

## 通用任务执行事实

```text
Session Event          会话事件          原始执行事实只追加，引用使用同会话稳定事件索引。
Turn Terminal          轮次终态          循环保存完成、失败或取消；异常退出由宿主识别。
Context Projection     上下文投影        完整步骤进入模型协议，原始历史不因投影而删除。
Recovery Ancestry      恢复祖先链        新轮次关联源轮次，核验轮次不代替原任务完成。
Persistence Health     持久化健康        原始保存错误致命传播，不能转换成普通工具失败。
Plan Evidence          计划证据          模型输入、状态投影和磁盘读取共用合法事件来源规则。
Turn Message Binding   轮次消息绑定      以明确消息标识绑定已原子保存的新版本任务起点。
```

Session 提供同步 `appendMany`，供宿主一次提交执行起点与展示绑定。Loop 的 `prepareTurnStart` 只准备事实，`runTurn` 保存后调用 `runStartedTurn`；后者只接受最新、尚无模型步骤和终态的起点。Loop 独占自身终态，已提交完成后的宿主或诊断错误不改写该事实。工具结果仍按轮次、步骤、调用标识组合归属，模型调用 ID 不是全会话身份。

计划意图、压缩来源、工具执行边界、执行前检查点、宿主操作与核验事实统一保存在 Session。纯投影重建计划及任务状态，宿主提供工具业务证据资格；Core 不理解插件协议、SQLite 或视频验收。具体批准方案及六阶段取舍见 [通用智能体最小设计](design/general-agent-core.md)。后续能力以实际消费者接入与验证为准。

计划的 `evidenceEventIndexes` 由 `isTaskPlanEvidenceEvent` 统一约束，模型输入、计划投影和磁盘解析不各自维护允许列表。合法来源为当前任务链中已经存在的 `tool.called`、`tool.result`、`tool.interaction.closed`、`host.operation.started`、`host.operation.result`、`effect.outcome.verified`、`turn.failed`、`turn.cancelled`、`turn.interrupted`；用户消息、助手消息及其他生命周期事件不能作为计划证据。来源合法不等于完成：步骤完成、失败和受阻仍由同一事实投影及宿主资格回调确认。非法来源在计划工具的模型输入边界拒绝；合法历史沿用同一磁盘规则读取，不在每次追加时重复全量解析。

Desktop 在每次工具调用前用 `taskToolGate` 读取同一 Session 的恢复事实：已有未知外部效果时阻止新外部操作，同一轮的相同拒绝不重复审批，恢复任务链中已经成功的相同外部操作不重复执行。Loop 将拦截与未知工具保存为 `not-executed` 调用及真实失败结果，不制造未知副作用；恢复轮次限制为 24 个模型步骤和 48 次工具调用尝试。轮次起点已有未知效果时不连接插件或执行其钩子，只提供本地读取、计划更新和效果核验工具；该轮工具集固定到结束，不注册 `save_memory`。

通用 MCP 工具在审批后、实际请求前保存检查点，服务端失败或请求结果丢失按未知效果处理。已知纯媒体检查不会记录写入检查点；抽帧、音频提取和视频写出保留检查点。插件钩子包装后的工具仍按不透明边界处理，不能继承内层的只读声明。嵌套语义验收保留媒体调用的未知效果和原始保存错误，不能用内容检查受阻的成功结果掩盖它们。

## 本机记忆与自定义指令

```text
Memory                 记忆              保存用户明确偏好或长期事实，供后续任务使用。
Memory Store           记忆存储          Desktop 通过 SQLite memories 文档读写记忆条目。
Custom Instructions    自定义指令        用户主目录 AGENTS.md 的可编辑系统指令。
Save Memory Tool       保存记忆工具      Agent 在启用记忆时按模型判断写入一条长期记忆。
```

记忆属于 Desktop 宿主能力，不进入 Agent Core 或 Session 历史。每轮创建 Agent 前，宿主读取已保存记忆和用户主目录的 `AGENTS.md`，追加到系统指令；关闭记忆时不读取、不注册 `save_memory`。记忆通过 `save_memory` 工具生成，来源按本轮是否已经调用其他工具区分为普通对话或工具聊天；第二个设置关闭时，工具聊天的写入被拒绝。设置页的删除动作只清空本机 SQLite 记忆文档，不删除 `AGENTS.md`。

## 桌面插件平台与技能

```text
Plugin Platform           插件平台        管理本地与市场插件的安装、版本和运行。
Skill                     任务技能        通过 SKILL.md 提供描述与操作指令。
MCP                       工具协议        连接本地或远程服务并列举、调用工具。
Standalone MCP            独立工具服务    用户直接配置服务器，不依赖插件安装。
stdio                     标准输入输出    通过子进程文本通道传输协议消息。
OAuth                     账户授权        在系统浏览器授权后加密保存令牌。
Hook                      事件钩子        在任务生命周期中经审批执行插件命令。
Marketplace               插件市场        从实际清单发现、下载和安装插件。
```

Desktop 是当前消费者：`extensions.ts` 解析 Codex 风格清单、建立 catalog（目录）和 authority（来源权威）、发现技能并激活安装；`extension-marketplaces.ts` 管理市场清单与来源检出；`extension-connections.ts` 管理操作系统加密凭据及授权；`extension-runtime.ts` 每轮准备技能、工具及钩子；`index.ts` 注册到现有 Agent 并追加技能目录。Core、Loop 和 CLI 不引入插件协议。界面通过 `AgentClientApi.extensions` 消费宿主事实。

```text
Desktop → enabled skill metadata → system prompt
Model → load_skill → SKILL.md → Tool Result → Session → next Model
Desktop → bundled tool metadata → Tool Registry
Desktop → external MCP start approval → MCP Client → listTools → Tool Registry
Model → bundled plugin tool → first start approval → MCP Client
Model → plugin tool → call approval → callTool → Tool Result → Session
Turn finally / cancellation → shared close promise → MCP process exit
```

技能来自安装目录与已确认工作目录的 `.agents/skills/**/SKILL.md`；扫描阶段只读取 YAML frontmatter（元数据），模型先获得 catalog 条目，匹配任务或 `$技能名` 指定后才由 `load_skill` 懒加载正文。扫描跳过隐藏目录并受目录/条目预算限制。引用资源仍走已有目录与文件授权。停用插件同时停用附带技能；项目与附带技能不能独立卸载。技能指令不能覆盖系统边界和审批。

插件详情中的附带技能由 Desktop 渲染层显示为可点击的单列条目；技能对话框单独通过 `readSkill` 读取并排版正文，文件菜单只调用宿主解析后的真实路径。试用动作复用当前对话草稿，仅准备 `$技能名` 调用，不自动启动新的 Turn。

插件详情的建议指令来自附带技能的 `defaultPrompt`，点击时将完整指令放在现有草稿前；顶部试用选择第一个已启用的附带技能。详情中的信息直接展示清单声明的字段；缺少字段不生成虚构内容。按用户要求移除详情的钩子展示，宿主对命令钩子的解析、执行审批与取消语义保持现有实现。

支持 `.codex-plugin/plugin.json` 与 Agent Plugins v1（标准插件格式）的根 `plugin.json`、`com.openai` 扩展及旧格式补充清单。实际消费完整 `interface` 展示字段、图片、网站、技能目录、MCP 配置、应用 ID 与命令钩子；根目录无关的 `plugin.json` 不覆盖有效旧清单。资源真实路径不能超出插件目录，复制前校验链接。技能图标允许引用插件内共享资源，渲染层收到图片数据地址，不获得任意本机文件读取能力。

市场支持四种 Codex 清单布局、本地目录及 Git 来源，以及本地、Git 子目录与 npm 插件包。按用户要求已撤下官方公开仓库的默认推荐目录，不随包提供未接通服务的应用条目。只有用户主动添加的市场参与目录展示，安装不会自动注册官方来源；移除来源保留已有安装。Git 禁用仓库钩子并启用 Windows 长路径；npm 下载只解包，不执行安装脚本。显式更新重新检出已注册来源。Git 和 tar 使用本机程序，未随安装包分发。

安装先复制到 `userData/extensions/.staging`，解析清单并重新扫描通过后再原子移动到 `userData/extensions/{plugins,skills}`；失败只清理暂存目录，保留原有安装。SQLite 的 `extensions` 文档保存类型、名称、来源、版本、安装标识与停用标识，不存旧电脑绝对安装位置。`${PLUGIN_ROOT}` / `${CODEX_PLUGIN_ROOT}` 每轮解析到当前安装目录，`node` 使用 Electron 自带运行时，其它程序需插件自带或系统可用。插件自身硬编码路径仍需作者修正。

首次启动且 `extensions` 文档尚不存在时，Windows x64 默认安装并启用语义视频剪辑、FFmpeg、Whisper 和 Vision，其它平台仅语义视频剪辑和 Vision。程序归档及默认 Small 语音模型从同级 `bundled-media` 离线读取并校验，不因缺失而联网补齐；全部插件暂存、模型准备和目录发布完成后才一次保存安装状态。失败清理本次发布目录并显示真实错误，修复资源后可刷新重试；不登记半套初始化。已有安装文档（包括全部卸空的记录）不触发默认安装，后续启动与刷新保留用户禁用、卸载和模型删除选择。第三方插件及独立技能不自动安装。

`listSkills` 单独返回技能元数据，`readSkill` 单独读取正文；元数据以文件时间和大小缓存，`forceReload` 与文件通知清缓存，正文保持按需读取。模型目录最多 64 项、8000 字符，显式指定技能优先排序。扫描流读到第二个 `---` 分隔符后关闭，不构建正文字符串。`agents/openai.yaml` 提供图标、显示名称、简述、建议指令、结构化工具依赖和自动调用策略；禁止自动调用的技能只有被 `$名称` 显式指定时才进入模型目录。有 URL 或用户配置地址的 MCP 依赖走真实工具连接与审批，缺少服务的依赖明确写入指令，不自动假设已授权。

安装、启停、卸载与同步通过 `desktop:extensions-changed` 通知界面重新读取。宿主同时监视安装目录和当前项目技能目录；技能目录不存在时监视最近存在的父目录，界面重读时重新绑定。外部文件变化合并后发出失效通知，窗口关闭释放监视句柄。`reconcile` 同步内置资源、修复缺失目录并刷新已添加市场。市场插件更新由用户显式执行，保留旧安装及版本历史供回滚；失败不覆盖当前安装，停用标识保持。发布失败时恢复旧目录，恢复失败明确保留备份位置。

MCP 运行时支持 stdio、Streamable HTTP（可流式 HTTP 传输）和 SSE（服务器推送传输），以及经过加密配置的环境变量与请求头。OAuth 使用 SDK 进行资源发现、动态客户端注册、PKCE（授权码校验）、令牌刷新及发行者隔离；新授权只从详情页显式发起，执行中缺授权要求回到详情连接。等待授权可以取消，窗口关闭也取消并释放本机回调端口。凭据按插件、服务和地址隔离，渲染层只看到变量名称及连接状态。

独立 MCP 服务器由设置页通过现有扩展管理接口新增、编辑、启停与删除，支持本地命令、HTTP 和 SSE。名称必须唯一；默认启用，编辑保留当前启停状态。独立配置整体保存在 `extension-secret:standalone-mcp/configuration` 加密文档中，一次提交包含公开参数和秘密；列表只返回命令、参数、地址与变量名称，不回显环境变量或请求头的值。编辑提交空值保留同名已保存秘密，移除键则删除该变量。`extensions.ts` 向每轮宿主投影独立服务器，`extension-runtime.ts` 复用现有 SDK、启动与调用审批、账户授权、取消和关闭路径，不写入插件安装列表，也不改变 Core 或 Loop。启动目录使用当前已授权会话目录，没有目录时使用当前本机数据目录；服务不会在保存时启动。远程账户授权由独立服务器配置对话框显式发起，等待时可取消。

`.app.json` 的真实应用 ID 可配置账户网关的 MCP 地址，之后走相同授权与工具调用路径；这不是 OpenAI 私有 Apps 账户服务接入。命令钩子接入 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop，逐项展示确切命令并审批。宿主仅为当前已启用插件实际声明的生命周期钩子登记执行操作，没有命令的事件不写空操作。取消及超时结束整个进程树，输出错误保留失败语义。

这些是本项目 Electron 宿主接口，并非 Codex JSON-RPC（应用服务器通信协议）的完整线协议。账号安装同步、云技能来源、插件分享发布按用户明确要求对接自有后端，目前尚未接入；不以 OpenAI 私有服务作为交付前提。SessionStart 在宿主创建或恢复会话后首次执行任务时消费一次，分别携带 startup 或 resume 来源；普通后续轮次及会话切换不重放启动命令。公开源码核对和本次三轮验证见 `docs/acceptance/codex-extensions-three-reviews-20261004.md`。

用户已将实际服务端接入留待后续实施；对接交接见 [插件与技能自有后端对接文档](plugin-backend-integration.md)，其中待实现契约不表示当前已有接口或部署。

受控 FFmpeg、Whisper 和 Vision 的工具元数据直接来自其工具实现，每轮只注册当前可用能力；首次实际调用才审批并连接对应服务，普通问答不启动媒体进程。同一服务在一轮内复用连接结果，启动拒绝或握手失败不自动重连；握手失败作为该次工具失败返回，不影响其它能力。外部插件及独立 MCP 仍经启动审批连接并发现工具。服务启动与各次调用分别进入宿主审批策略，按当前聊天权限模式请求人工批准、独立模型审查或自动批准。SDK 和钩子只继承基础系统环境；只有受控 Vision 服务获得所选视觉供应商配置，其它服务不接收模型设置密钥。一般工具名以插件、服务及工具标识组成，特殊字符或超过 64 字符时附加摘要避免身份冲突；下述受控 FFmpeg、Whisper 和 Vision 服务映射既有公开工具名称。取消与收尾等待同一个关闭操作，进程不写入恢复数据。复制或卸载期间宿主拒绝新任务，防止使用正在修改的目录。

### Desktop FFmpeg 插件

```text
Media Adapter        媒体适配器        宿主将已授权本地路径及 MCP 结果转换为原工具契约。
Shared Injection     共享注入          公开工具与候选语义验收消费同一个通用 Tool 实例。
Producer Evidence    生产证据          成功视频写出及来源归属支持读取本会话真实候选。
Binary Distribution  二进制分发        构建准备锁定资源，客户端离线安装并验证摘要、版本及构建选项。
```

Desktop 每轮先准备扩展，再调用 `createVideoAgent`。受控服务映射十四项专业工具：`probe_media`、`decode_video`、`detect_black_segments`、`extract_video_frames`、`extract_video_range_frames`、`extract_audio`、`extract_full_video_frames`、`trim_video`、`concat_videos`、`add_audio`、`add_subtitles`、`resize_video`、`crop_video`、`set_speed`。冲突直接失败；第三方同名工具仍使用限定名称。宿主经 `mediaTools` 注入实际启用能力，应用层没有 FFmpeg 实现导入或自动回退；写出工具继续经过原有候选目录包装器。CLI 在自身入口显式注入本机实现。Core 和 Loop 不接触 MCP 协议。

`ffmpeg-tool.ts` 在 MCP 调用审批前拒绝 URL、URI、UNC 网络路径、备用数据流和无工作目录的相对路径；路径先解析到真实文件，再验证已确认工作目录范围或精确匹配当前选择附件的真实路径。目录链接不能扩大工作目录权限。附件旁的候选只在存在成功视频生产记录、来源归属匹配、全部原始来源已授权、真实候选仍在对应输出项目录中时允许；只声明目录、未选择附件的邻居文件或伪造候选路径均不授权。生产归属复用交付工具的权威规则，不另建来源算法。

适配器把实际归一化路径送入原 MCP 调用审批，严格转换成功结果的 `inputPath`、`duration`、`width`、`height`、`videoCodec`、`audioCodec` 六字段；错误内容保留原消息，畸形结果、路径不匹配和缺失字段返回工具失败，取消继续抛出 `AbortError`。公开调用沿 Agent Loop 保存 `tool.called` 和 `tool.result`；语义验收先使用同一适配器，再抽帧、观察和判断，因此内部调用仍有审批与钩子，但不伪造独立 Session 事件。最终语义证据由 `check_video_semantics` 保存，成功判定仍绑定候选内容摘要并由原交付验收消费。

独立 `plugin:ffmpeg` 的 `ffmpeg` 服务由 `apps/desktop/src/plugins/ffmpeg.ts` 构建为自包含 CJS 资源，使用 Electron 自带 Node 运行时及原有工具，不复制媒体算法。`plugin:video-editing` 仅包含技能，由侧车元数据声明 `ffmpeg` 依赖；已注册的受控服务满足元数据依赖，实际调用仍可因启动拒绝或连接失败受阻。旧版内含的 `ffmpeg-probe` 不再启动；已安装视频剪辑插件但独立 FFmpeg 插件未安装或未启用时，插件页提示安装并启用 FFmpeg，不将缺少依赖表述为需要升级。只有受控独立插件可映射既有公开工具名称，同名第三方服务仍使用限定名。服务限制本地文件协议及普通媒体容器，拒绝网络协议与播放列表间接资源。stdin 结束会关闭 SDK、取消在途请求并终止子进程。

抽帧及音频提取也经过同一真实路径授权：输出仅在已确认目录或来源已授权的输出项工作目录中。语义验收通过注入的全帧和音频工具调用插件，临时目录位于该输出项工作目录并在结束时清理。全帧算法及 600 帧预算仍由 `video-ffmpeg` 实现，不在宿主复制；完整覆盖不能以空帧列表表示。写出路径必须属于已声明输出项，宿主复核来源与最终目标授权；插件不能返回正式产物元数据。插件未安装、停用或卸载时，下一轮没有十四项专业工具；启动被拒绝时实际调用返回拒绝，依赖能力的验收明确受阻。通用任务继续运行；通用终端仍遵守自己的审批策略，不属于专业工具卸载边界。记录见 [第二阶段验收](acceptance/ffmpeg-plugin-20261011.md)。

该边界是宿主调用策略，不是操作系统沙箱；已批准的通用 MCP 服务或本机可执行程序仍以当前用户身份运行。FFmpeg 正式资源目前支持 Windows x64：构建时准备 `runtime.lock.json` 锁定的 Gyan 8.1.2 ZIP，客户端在已有暂存目录离线解包，校验归档及两个程序 SHA-256、版本和必要构建选项，再原子发布。构建下载使用 Electron 网络栈及 Windows 系统代理，手动安装优先使用随包归档，归档缺失时仍可下载锁定版本；失败保留旧安装。插件自身目录提供可执行文件，Electron 自带 Node 启动自包含服务，不搜索系统 PATH。插件专属归档缓存每次复核摘要，旧完整版本沿用既有缓存与回滚。保留供应商 GPLv3 许可证、README 和构建说明；当前完整候选包仅用于本地验收，未公开发布或宣称代码签名；公开发行所需完整对应源码、第三方依赖及构建材料仍未补齐，来源和要求见插件 `NOTICE.md`。验收见 [FFmpeg 插件验收](acceptance/ffmpeg-plugin-20261011.md)，原 Probe 阶段记录保留供追溯。

### Desktop Whisper 插件

```text
Whisper Plugin       语音识别插件      独立 plugin:whisper，只提供 transcribe_audio。
Managed Runtime      受控运行资源      安装时验证官方 Windows x64 CPU 程序和全部所需 DLL。
Managed Model        受控语音模型      完整包默认提供 Small 多语言模型，可离线恢复或本地导入。
Media Authorization  媒体访问授权      宿主解析真实音频路径，再执行 MCP 调用审批。
```

`apps/desktop/src/plugins/whisper.ts` 复用 `speech-whisper-cpp` 的进程执行和官方 JSON 解析，以自包含 CJS 资源运行于 Electron 自带 Node。输入仍为 `audioPath` 本地 WAV；成功返回完整 `text` 与秒级 `segments`，失败保留消息，取消传播 `AbortError`。标准 PCM 音频的实际采样长度限制上游补齐静音所造成的尾段结束时间，起始时间超出素材仍失败。服务每十秒上报实际已运行秒数，宿主复用 SDK 的进度重置等待超时，不以默认 60 秒限制任务总时长，也不伪造完成百分比。其他音频和视频先由 FFmpeg 转换，不在 Whisper 内打包 FFmpeg。第三方同名工具继续使用限定名。

Desktop 在每轮准备扩展前校验模型与运行程序，只向受控 Whisper 服务传递其绝对路径；用户连接配置和模型输入均不能替换路径或改成远程服务。`createVideoAgent`、`CheckVideoSemanticsTool` 只消费 `mediaTools` 中的通用 `Tool`，不导入或创建 Whisper；CLI 在自身入口显式注入原本机实现。插件缺失、禁用、卸载或模型损坏时不注册 `transcribe_audio`，按需连接失败由实际调用返回错误，普通任务和其他插件继续；带音轨的语义验收明确 `blocked`，没有音轨仍按原规则处理。通用终端不属于专业工具卸载边界。

Whisper 复用 FFmpeg 的宿主真实路径授权：已确认目录、精确选定附件及来源已授权的视频输出项内中间 WAV 可读；目录穿越、目录链接、未选定的邻居文件和网络路径不能扩大权限。内部语义调用经过同一适配器、审批和钩子，转录作为 `check_video_semantics` 的成功证据保存，不伪造独立 Session 事件。候选摘要、完整解码、语义检查和发布门禁保持原规则。

程序安装复用扩展暂存、原子发布、更新和回滚，归档及 CPU 程序/DLL 按锁文件摘要验证，并以 `--help` 实际检查可加载性。默认模型位于用户数据的 `extensions/models/whisper`，官方 revision、体积和摘要独立锁定；安装前检查磁盘空间，完整包默认从随包模型复制，删除后可离线恢复或本地导入；未提供随包模型的宿主仍支持锁定来源下载，流式下载显示真实字节进度，校验后才发布。失败残片删除，允许从头重试；已有合法文件复用。本地导入也必须匹配同一锁定模型。卸载插件保留模型，用户可主动删除；模型操作、插件更新和新任务复用宿主原有互斥边界，运行中的识别不更换资源。资源访问与用户媒体授权分开，不把模型目录授予普通媒体工具。

仅声明 Windows x64 CPU，运行资源、默认 Small 模型及 MIT 许可证均由完整安装包提供。官方 Windows 构建不能可靠加载中文绝对模型路径，执行时以模型目录作为工作目录并传相对模型名；音频和结果路径仍为绝对路径。超过 Windows 传统长度限制的已授权音频复制到本次工具临时目录再调用，成功、失败和取消都清理该副本。全零 PCM16 静音直接失败，避免识别幻觉；不宣称解决所有背景噪声。历史安装、协同和性能证据见 [Whisper 阶段验收](acceptance/whisper-plugin-baseline-20261012.md)。

### Desktop Vision 插件

```text
Vision Plugin        视觉理解插件      独立 plugin:vision，只提供 analyze_images。
Provider Selection   服务配置选择      宿主解析当前视觉供应商、模型、协议、输出上限及加密密钥。
Image Authorization  图片访问授权      上传前复用真实本地路径授权，调用审批展示所选服务地址。
Shared Observation   共享画面观察      公开调用和候选语义验收使用同一个适配后的通用 Tool。
```

`apps/desktop/src/plugins/vision.ts` 复用 `vision-openai` 的文件读取、图片请求与响应解析，构建为自包含 CJS 资源并使用 Electron 自带 Node；不下载运行程序或模型。输入保持 `images[{path,timestamp}]`，每批一至六张 JPG/PNG；成功返回 `summary` 与按输入顺序对应的 `frames`，每帧包含 `timestamp`、`description`、`subjects`、`actions`、`scene`、`visibleText`。视觉模型只观察，不决定剪辑或生成产物。

Desktop 每轮从 `loadRuntimeConfiguration` 获取视觉路由解析出的供应商及模型，仅向内置 `plugin:vision` 的 `vision` stdio 服务注入 `VISION_API_KEY`、`VISION_BASE_URL`、`VISION_MODEL`、`VISION_PROTOCOL` 和可选 `VISION_MAX_OUTPUT_TOKENS`。连接配置及工具输入不能替换密钥或服务端点；密钥不进入审批文案、Renderer（渲染层）、Session（会话）和 Trace（执行追踪），也不传给第三方 MCP 服务或命令钩子。批准视觉调用会将已授权图片上传到所选供应商，审批明确显示地址，保留启动及逐次调用审批。

宿主的 `vision-tool.ts` 先解析每张图片的真实路径，复用 FFmpeg/Whisper 的已确认目录、精确选定附件及来源已授权输出项规则；目录穿越、目录链接、网络路径及未选定邻居文件不能扩大权限。语义验收的临时帧位于同一输出项工作目录，结束后清理。MCP 结果在外部边界转换为完整观察契约，遗漏帧、时间戳不对应或字段畸形返回错误；HTTP、JSON 和服务错误不伪造成功，取消传播 `AbortError`。

上传前检查实际 JPG/PNG 编码头部和尺寸，不把改扩展名的其它文件当作图片，也不声称替代完整解码。单张不超过 10 MiB，整批原始图片不超过 20 MiB，序列化请求不超过 30 MiB；单边不超过 8192 像素且总量不超过 4000 万像素。API 地址只接受无内嵌凭证、查询参数或片段的 HTTP(S)，不跟随重定向；单次网络请求有 50 秒预算，超时明确失败，不自动重试或重放图片上传。

`createVideoAgent` 和 `CheckVideoSemanticsTool` 只消费显式注入的通用 `Tool`，不导入或创建 `AnalyzeImagesTool`。同一个 `analyze_images` 实例供公开调用及内部逐帧验收消费，内部调用仍经过审批和钩子，完整观察存入 `check_video_semantics` 证据而不伪造独立 Session 事件。CLI 在自身入口显式注入本机视觉实现。插件缺失、停用、卸载或视觉路由不可用时不注册视觉工具；启动拒绝或连接失败由首次实际调用返回失败；普通任务及其它插件继续，依赖视觉的语义验收返回 `blocked`。第三方同名服务继续使用限定名称。当前自动化与真实外部验证范围见 [Vision 阶段验收](acceptance/vision-plugin-20261012.md)。

## Core Relationship（核心关系）

```text
                    User
                    用户
                     │
                     ▼
                ┌─────────────┐
                │    Agent    │
                │    智能体    │
                ├─────────────┤
                │ Model       │
                │ Session     │
                │ Tool Registry ─────► Tools
                │ System Prompt │       工具集合
                └──────┬──────┘
                       ▲
                       │ operates on
                       │ 操作 Agent
                ┌──────┴──────┐
                │ Agent Loop  │
                │  智能体循环  │
                └─────────────┘
```

核心关系可以概括为：Agent 持有 Model、Session、Tool Registry 和 System Prompt；Agent Loop 通过 Agent 使用这些能力；Tool Registry 管理当前 Agent 可以调用的 Tools。

### Video Agent Application Layer（视频智能体应用层）

`@agent-desktop/video-agent` 负责组装当前正式 Agent 的 Model、InMemorySession、System Prompt 和已注册 Tool。它不读取环境变量、不创建终端或界面，也不拥有 Trace 持久化。系统指令集中在 `src/system-prompt.ts`，CLI 与 Desktop 都不重复维护。`examples/ffmpeg-agent` 与 `apps/desktop` 负责各自的配置和入口交互，并共同调用 `createVideoAgent(...)`。

`set_working_directory` 只有在调用方传入 `workspace` 端口时才注册：没有宿主的目录状态和目录确认能力，这个工具就没有合法的审批消费者。CLI 目前不传，因此 CLI 不提供本地目录工具。

### Video Delivery（视频交付）

视频成片不是「最后一个写出 Tool 成功」就算完成。应用层把交付拆成四个有真实事实支撑的阶段，并让桌面与命令行共用同一套判定。

```text
Concept                中文术语    当前事实
Output Item            输出项      用户预期得到的一项视频结果：来源、目标与必要要求。
Candidate              候选文件    某次成功生产调用真实写出、被选中送验的文件。
Candidate Validation   候选验收    逐条记录必要要求的检查结论与真实证据引用。
Published Output       已交付文件  必要检查全部通过并成功复制到最终路径的文件。
```

`declare_video_outputs` 接受本轮完整声明并返回应用层生成的输出项标识、目标与 `workingDirectory`；声明列表就是预期交付集合，不再从首个附件强制推导唯一最终路径，也不默认要求多视频合并。所有要求都是必要条件，`decodable-video` 由应用层自动加入。

候选只能写进所属输出项的工作目录。该约束由应用层组装时套在写出型视频工具外层（`ScopedVideoOutputTool`）落实，因此它作用在真实写出调用上而不是提示词里：没有声明就写出会被拒绝，直接写最终目标或跨输出项目录写出同样被拒绝。写出型视频工具因此只报告结构化生产事实 `{ outputPath }`，不再直接登记 `artifacts`。生产、验收和发布事实按轮次、步骤与工具调用标识组合配对；跨轮复用调用标识不改变候选归属，同路径重新生产也不继承此前验收。

`validate_video_candidate` 只接受输出项与候选路径：应用层按这条路径反查写出它的成功生产调用，并逐条计算检查结论——`decode_video` 提供全文件解码事实，`probe_media` 提供真实时长，`detect_black_segments` 提供该参数下的黑段区间，`check_video_semantics` 提供独立内容判定。证据必须对应实际候选；语义证据还必须匹配输出项与候选的 SHA-256 内容摘要。缺少证据记为 `blocked`，明确不满足记为 `failed`。检查不通过是验收工具成功执行后的业务结果，不是外层工具错误。

Probe 插件返回宿主归一化后的真实路径，因此时长证据既接受候选原引用路径（CLI），也接受该候选实际 `realpath`（Desktop）。两者都对应同一已核对来源及成功生产的候选；不能用源视频或其他文件的时长替代。这保证目录链接路径不会让新插件结果与已有交付证据契约脱节。

`check_video_semantics` 由应用层读取已声明的内容要求，父模型不能填写结论。FFprobe 提供全部解码帧时间戳，FFmpeg 按原始帧率抽取每帧；每批六帧通过已有 Vision 视觉服务观察。有音轨时提取完整音频并调用 whisper.cpp，再由独立的当前对话模型请求逐项判定。观察、转录和结论存入成功工具结果供核对；临时媒体在检查后删除。首期上限为 600 帧和 250 KB 视觉观察，超过预算不能降成采样。有明确反例时失败；服务缺失、观察遗漏、判据不清、非语言声音或音画同步等现有证据无法确认时受阻。模型观察与转录仍有识别误差，逐帧覆盖不等于证明任意自然语言要求。

新验收保存候选的 SHA-256 内容摘要。语义检查前后复核文件内容一致，发布前再次复核验收摘要；候选字节改变后必须重新验收。旧历史没有摘要时仍可阅读，但不能直接使用旧验收发布。

模型不提交工具调用标识：真实运行表明模型无法可靠引用不透明的调用标识，因此归属由应用层按路径核对。这比让模型提交标识更严格，也去掉了模型伪造归属的可能。

`publish_video_output` 只接受验收引用：应用层反查候选、输出项与目标，复核它是本项当前候选的最新一次全项通过验收，再以「独占创建目标后复制候选」的方式发布。默认名称在发布时按真实磁盘占用确定，不再从全局计数器取起点；明确目标已存在时拒绝覆盖也不改名。复制未完成（包括中途取消）时只清理本次调用创建的目标，不登记产物；发布已经完成的事实不因随后取消而回滚。发布成功的结果同时返回 `PublishedOutput` 与 `artifacts`，两处路径来自同一个发布结果值。

`@agent-desktop/video-agent` 的读取投影（`readVideoDeliveryFacts` / `projectOutputItemResults`）是「什么算交付」的唯一权威实现，桌面与命令行都只调用它。逐项结果按声明集合给出 `published` / `failed` / `blocked` / `incomplete`，总数来自声明列表而不是成功计数器；没有声明过输出项的普通问答与通用文本任务不产生视频交付结论。旧历史里由视频 Tool 直接报告的产物继续可见、可定位，但不补造验收记录。

### Chat Permission Modes（聊天权限模式）

权限选择在输入框附件加号右侧，每个聊天独立保存到桌面会话快照。未选择时采用 `ask`；宿主在任务起点固定模式，任务执行期间不允许变更。渲染层提交选择，只有宿主保存成功后才更新显示；恢复时以宿主会话字段为准，不能用旧的展示快照回写权限。

```text
Mode          中文模式      当前执行策略
ask           请求批准      已确认目录内常规文本编辑直接执行，其余受控操作请求人工批准。
auto-review   帮我批准      文件范围与请求批准相同，其余受控操作交给独立模型审查。
full-access   完全访问      放开本地文件范围，并自动批准目录、命令、终端和插件操作。
```

模式拆分参考 [Codex 权限说明](https://developers.openai.com/codex/permission-modes)与[自动审批审查说明](https://developers.openai.com/codex/sandboxing/auto-review)：改变审批者不等于改变文件范围。本项目继续使用已有宿主路径授权，没有实现 Codex 的操作系统沙箱；因此不能把命令前缀或工作目录当成磁盘与网络隔离，受限模式下所有本机命令、终端和插件操作都需要进入审批。访问范围外的文件时，受限模式仍需先通过 `set_working_directory` 授权包含它的目录。

`ToolApprovalGate` 是审批决策唯一入口。本地文本工具已通过路径和版本检查，所以工作目录内的创建与编辑可直接批准；完整访问跳过交互审批；自动审查调用 `approval-review.ts`，使用本轮所选供应商和模型发起独立、无工具的请求，输入是真实用户任务、有限公开历史与确切操作。主模型的声明、文件、技能和工具输出不能充当用户授权。审查结果只读取决策、风险、用户授权级别和公开原因；关键风险拒绝，高风险缺少明确授权时拒绝。请求最多 30 秒，取消沿同一取消信号传播，网络、超时或解析失败均不执行原操作。拒绝原因作为工具错误返回，要求选择实质更安全的方案或停止说明，不重放原工具。审查状态经既有审批事件实时展示，不生成伪造的人工答复。

完整访问仍保留真实路径、参数与文件版本校验、操作系统自身权限、子智能体只读、未知效果核验，以及视频候选生产、验收、内容摘要与发布不覆盖规则。账户新授权和扩展安装仍由用户在设置中显式发起，权限选择不替代这些动作。

### Local Tools（本地工具）

`@agent-desktop/local-tools` 的唯一职责是实现本地文件与进程工具。它不持有 Session、不选模型、不编排任务，也不承担宿主权限管理：需要宿主决定的操作（当前是目录访问、创建文件、修改文件与命令执行）一律通过调用方注入的 `WorkspacePort` 回调，因此该 package 不依赖 Electron、React 或 `client`。命令工具另外通过调用方注入的 `CommandPort` 取得解释器绝对路径和受限子进程环境——这两项属于宿主环境事实，不由工具自己搜索或复制。

`set_working_directory` 把会话工作目录设为一个真实存在的目录：先 `realpath` 再进入宿主审批策略。已经确认的同一目录不重复审批；换到新目录重新交给当前模式决定。相对路径以当前会话工作目录为基准，没有基准时返回明确错误。

读取范围只有一处权威实现（`src/path-scope.ts` 的 `resolveScopedPath`）：默认来自会话已确认的工作目录；宿主只在完全访问模式投影 `WorkspacePort.fileAccess: 'all'`，允许范围外的真实绝对路径。`..`、符号链接和 Windows 目录联接先由 `realpath` 消掉，受限时再判断是否跳出根目录。完全访问也不能在缺少工作目录时猜测相对路径基准；媒体适配器复用同一宿主范围事实，仍保留自身的本地路径和视频输出项约束。

`list_directory` 列出工作目录或其子目录中的真实条目（名称、真实路径、类型），可按扩展名过滤；扩展名过滤只作用于文件，目录始终保留。它不递归、不扫描全盘，超过上限时明确报告总数和缩小范围的方法。

`read_file` 按行范围返回文本，行号从 1 开始并与用户在编辑器里看到的一致；返回行数组和对应行号，便于模型准确引用内容。每次成功读取同时返回完整源文件字节的 `sha256`，后续编辑据此确认目标仍是模型读到的版本；分段读取同一版本时摘要保持相同。超过行数或字符预算时返回 `nextStartLine`，连续读取不重不漏。它先检查文件大小，再按 UTF-8 解码；出现替换字符时如实说明文件可能不是 UTF-8，二进制文件（含 NUL 字节）直接拒绝。

`search_text` 把搜索交给 ripgrep 真实进程（`--json` 行分隔输出、`--fixed-strings` 字面匹配），只负责参数、已确认目录范围、结果上限和取消。它不自行遍历目录、不做正则或语义索引。达到上限时结束进程并说明缩小范围的方法；ripgrep 退出码 1（无匹配）是正常空结果。

```text
Dependency       中文名称        当前状态
ripgrep          文本搜索工具    由 `@vscode/ripgrep` 随包提供，工具用它的 `rgPath` 启动进程，
                                不依赖运行环境 PATH 上是否安装 rg。
```

Desktop 主进程打包时把 `@vscode/ripgrep` 保持为 external（外部依赖），运行时从应用自己的 `node_modules` 解析平台二进制。开发入口已使用随包依赖；安装包内的资源落地留到 Commit 49 的分发验收验证。

`write_text_file` 经宿主策略批准后创建一个新的文本文件。目标路径的**父目录**必须在宿主授权范围内（目标还不存在，不能对它做 `realpath`，因此复用 `resolveCreatablePath`）；已有文件一律拒绝（`wx` 是真正的写入边界兜底）；拒绝和取消都不产生任何写入。

`edit_text_file` 只修改宿主授权范围内的已有 UTF-8 文本。调用必须携带 `read_file` 返回的文件路径和 `sha256`；摘要不一致时在审批前失败并要求重新读取。原内容必须精确出现一次，不存在或出现多次都不请求审批、不写入。工具把真实路径、原内容和新内容交给宿主策略；批准后再次读取并逐字节比较审批前快照，文件在等待期间变化就停止。成功结果报告实际路径、替换次数和最终字节数，不报告 `artifacts`，因为编辑已有文件不是新产物。

`run_command` 在宿主允许的真实目录中运行一条本机命令。首期正式支持 Windows 非交互 PowerShell：解释器绝对路径和子进程环境由宿主提供，工具不搜索 PATH，也不把包含模型密钥的宿主环境整体注入子进程。省略执行目录时使用会话工作目录，没有基准时先要求模型调用 `set_working_directory`；完全访问可以显式指定其他真实绝对目录。

每次调用都进入当前聊天的审批策略，不根据命令前缀推断只读。需要人工批准或自动审查时，审批卡展示解释器、完整命令、执行起点和生效超时；拒绝时不启动任何进程。这是一项以当前用户权限执行的本机命令授权：工作目录只是执行起点，无法限制脚本访问其他目录、网络或调用其他程序，当前不是操作系统沙箱。

输出用 `spawn` 分别读取两条流并增量解码，保留来源标记和宿主收到的顺序，不声称两条流之间有操作系统保证的精确顺序。两条流合计最多保留 64 KiB 的首尾摘要，中间被丢弃的部分以 `droppedBytes` 如实说明。默认超时 120 秒，模型可请求的上限 600 秒，超过上限按上限执行，审批卡展示的就是生效值。退出码为 0 只代表该命令正常退出；非零退出、启动失败和超时都保留失败语义，失败结果同时携带退出码和有界输出，不只留一条错误文字。命令不从输出猜测交付文件，因此不报告 `artifacts`。

取消沿同一个 `AbortSignal` 传入审批等待和进程执行：取消后不再请求确认，已经启动的命令用系统 `taskkill /PID <pid> /T /F` 结束它创建的进程树并等待退出，再按 `AbortError` 结束，不返回普通工具失败让模型继续执行。只调用 `child.kill()` 无法证明 PowerShell 启动的 `.cmd` 与 Node 孙进程已经退出，因此进程树回收必须用真实孙进程用例验收。

### Tool Result Artifacts（成功结果的产物事实）

产物的唯一权威来源是成功结果自己报告的 `artifacts`：写出型工具**真正写入成功后**才报告它。宿主因此不需要从回复文本、退出码或磁盘扫描推断产物，失败调用也不会产生产物。只有写出型工具报告它——读取、搜索和中间产物（抽帧目录、语音 WAV）都不报告。

视频交付的 `artifacts` 只由 `publish_video_output` 在真正发布成功后报告。写出型视频工具改为返回结构化生产事实 `{ outputPath }`，因此中间片段、待修成片和最终交付在宿主看来是可区分的；`extract_audio` 的 WAV 与抽帧目录继续只作为过程用途。通用文本创建（`write_text_file`）仍在真正创建成功后报告 `artifacts`，不被强制套入视频验收。

```text
Video Agent Application
视频智能体应用层
        │
        ├── examples/ffmpeg-agent
        │   CLI（命令行入口）
        │
        └── apps/desktop
            Desktop（桌面应用入口）
```

### Desktop Application Boundary（桌面应用边界）

本地项目与会话管理直接消费现有 `ClientStateSnapshot`：`sidebar.projects` 保存独立项目名称、单个目录、置顶与折叠；会话的 `projectId`、`pinned`、`archived`、`updatedAt` 只负责组织和排序，不进入模型事件。侧栏分组与折叠随 `session-state` 的同一 SQLite 快照保存，旧快照没有这些字段时保持原聊天历史。当前不增加关系表或独立项目运行时。

`ClientStateSnapshot.conversations` 保存已提交的历史，可选 `drafts` 保存未提交的输入会话。每个草稿仍有真实的宿主会话，承载输入、附件和已确认目录，但没有消息、归档、置顶或手动标题。持久化校验两组标识的合集与宿主 `sessions` 一一对应，活动标识属于其中任意一组；因此历史可以为空，而宿主保留至少一个可输入的会话。旧快照缺少 `drafts` 时沿用既有历史，不自动删除编号条目。

项目由用户通过系统目录选择器添加。`newSession(directory)` 只在显式项目内新建时调用，主进程验证目录存在并把它记录为新会话的已确认工作目录；普通新会话仍没有目录。添加项目、移动已有聊天、编辑项目名称和移除项目都不改变已有会话目录或授权。项目移除只清除归属，保留历史与产物；目录不可用时新建失败，不创建半成品运行态。系统文件管理器打开由宿主 `openProjectDirectory` 负责。

项目移除后的未提交草稿保留原目录；重新添加该目录并进入项目内新会话时，客户端复用同目录且无项目归属的草稿并重新关联项目，不调用宿主创建重复会话。

归档保留完整会话与运行历史，不调用删除；当前聊天归档后切换到其他未归档聊天，全部归档时进入或创建输入草稿。归档聊天可阅读，恢复后继续原上下文。创建与任务起止记录更新时间；切换、草稿、置顶和归档不改排序时间，最近列表先按置顶再按更新时间排列。界面布局与交互状态只以 `docs/desktop-ui.md` 为准。

归档管理入口位于共享客户端设置页，直接消费 `App` 持有的已归档会话集合，通过已有切换、归档恢复和删除调用操作；侧栏只呈现未归档项目与最近会话。`App` 持有唯一删除确认状态，供侧栏菜单与设置列表共用，确认成功后才更新历史。当前不增加归档数据库记录、宿主接口或另一份会话列表状态。

Desktop 使用 SQLite（本地嵌入式数据库）保存现有状态，驱动为 Node.js 自带的 `node:sqlite`。`apps/desktop/src/main/desktop-database.ts` 只负责 `desktop_documents` 表的读取与事务写入；三个记录键为 `session-state`、`runtime-settings`、`runtime-secrets`，值沿用各模块已有的 JSON 状态结构。会话仍以完整快照保存，字段解析分别由会话持久化与运行时设置模块负责；当前没有逐条消息查询需求，因此不增加关系表、索引或数据库配置界面。每次数据库调用结束即关闭连接，数据库句柄不进入 Agent Core（智能体核心）。

外观模式 `theme` 与当前运行时设置一起保存在 `runtime-settings` 记录；未设置时跟随系统。客户端启动时加载并设置根节点主题，点选后自动保存并即时应用；`loadRuntimeConfiguration` 不返回该字段，主题不进入智能体或模型上下文。模型供应商使用完整草稿显式保存；本地工具设置导航到插件管理，不维护 Whisper 手动路径。完整设置页的分类、尺寸、字段布局和视觉验收以 `docs/desktop-ui.md` 为准。

模型设置的唯一目录类型和首次预填项位于 `@agent-desktop/client`；DeepSeek、OpenAI 与用户后续添加项都是普通供应商配置，不保存或推断内置身份。`runtime-settings` 保存供应商地址、协议、模型目录、当前对话模型、备用视觉候选与启用开关，`runtime-secrets` 按供应商 ID 保存由 Electron `safeStorage`（系统安全存储）加密的密钥。目录与密钥一次 SQLite 事务提交；客户端只接收配置状态与来源。持久化只解析当前供应商目录、模型三态能力、视觉路由与 `providerApiKeys` 契约，不转换旧固定供应商、`images`、`visionModel` 或独立密钥字段；旧 Whisper 路径不再作为 Desktop 执行来源。

关闭备用视觉保留候选引用；用户明确删除其供应商时，未启用的候选在同一次保存中清空。当前对话模型或启用的备用引用仍须先改选有效模型，不能留下失效目录引用。所有供应商沿用同一删除入口，供应商和对应本机密钥同次移除；预填目录只用于首次初始化，已保存的完整目录在重启时不补回被删除的供应商。
模型密钥、插件配置和 OAuth 令牌共用 `safe-storage.ts` 的加密保存边界。Windows 首次启动时 Electron 内置浏览器将主密钥延迟约十秒写入现有 `userData/Local State`；宿主先监听规范化后的真实目录，避免 Windows 短路径别名触发原生监视器断言，再读取 `os_crypt.encrypted_key`，确认非空主密钥已持久化后才提交凭据到 SQLite。已有有效主密钥立即继续；文件事件只唤醒重读，不作为保存成功证据。等待最多二十秒，到期或文件损坏、其他读取错误均明确失败，保留原数据库记录。模型密钥等待完成后，宿主再读取最新记录并同步合并提交，保留等待期间已保存的外观和记忆设置。宿主仍使用 Electron 原加密接口，不生成明文凭据文件、复制主密钥或用固定延时冒充持久化。

```text
Model Provider           模型供应商        保存 API 地址、协议和模型目录，密钥由桌面宿主加密。
Model Catalog            模型目录          保存 ID、名称、上下文窗口、输出上限及具体输入输出能力。
Model Selection          模型选择          使用供应商 ID 与模型 ID 引用目录，当前对话模型全局统一。
Capability Status        能力状态          支持、不支持、未知三态，未知不能被视为支持或触发备用。
Vision Routing           视觉路由          默认跟随对话模型，仅明确不支持时允许显式启用的备用。
Chat Completions         对话补全协议      使用消息与工具调用的流式请求，输出上限进入 max_tokens。
Responses                响应协议          将通用消息转换为输入与函数结果，输出上限进入 max_output_tokens。
```

`loadRuntimeConfiguration` 解析所选供应商与模型，供主任务、语义验收和只读子智能体消费；视觉统一通过 `resolveVisionModel` 解析。当前模型的文本输入输出、图片输入与视觉理解均支持时跟随当前模型；必要能力未知时报告不可用；只有明确不支持、备用开关开启且候选能力和密钥有效时使用备用。关闭备用开关不禁止跟随当前对话模型。此入口只接受配置，不接收请求异常，超时、限流、鉴权及余额错误都保留原失败语义。返回的地址、密钥、模型 ID、协议和输出上限形成该轮快照。

协议转换只位于现有具体模型/视觉包，Agent Core（智能体核心）不持有供应商清单和协议字段。Chat 请求只向 DeepSeek 官方地址发送原有 thinking（思考开关）扩展。Responses（响应协议）以完成事件为完整结果，支持公开文本增量、函数往返和取消；截断、失败和不完整响应不能作为成功回复。视觉工具职责仍为画面观察，抽帧、剪辑规划与候选验收保持原工具链。DeepSeek 官方 Chat 视觉使用 main 模型路由验收已实测的 `json_object`，在提示中给出原观察结构；其他结构化协议沿用 `json_schema`。工具在 JSON 解析边界检查摘要与全部帧的时间戳、描述，缺少观察直接失败。

模型目录提供上下文窗口和输出上限时，Desktop 仅在两项同时存在时将它们交给 Loop；Loop 在动态系统指令和工具 schema（结构定义）组装后计算保守输入预算，必要时按完整 Step（模型步骤）压缩并保存来源摘要。摘要不是系统指令或长期记忆，原始 Session 仍保留；缺少任一限额时沿用原请求行为。最大输出上限进入实际请求。

能力按具体模型与协议配置，当前只保存 `textInput`、`textOutput`、`imageInput`、`imageUnderstanding` 四项三态字段。2026-10-13 main 模型路由验收中的 DeepSeek 官方目录及真实图片调用确认 `deepseek-flash` 支持图片理解；`deepseek-v4-pro` 目录声明仅文本，不根据品牌或服务临时重定向统一标记视觉。修改模型 ID、地址或协议后，设置草稿的能力需要再次确认。首次预填的官方能力只适用于已验证的地址和协议；用户可以按实际协议明确填写能力。该历史证据不代替当前集成候选的真实云 Vision 插件链路及 Responses 供应商验收。

后续图片生成、图片编辑、视频理解、视频生成及音频输入输出各自增加独立能力和有生产消费者的任务选择，继续复用供应商目录与模型引用。视觉理解默认跟随对话的规则只属于视觉任务，不要求生成任务使用对话模型。本期不添加未消费的能力字段、生成模型选择器或调度平台。

模型发现经宿主实际请求 `/models`，消费供应商返回的 ID、可选名称和明确声明的 `input_modalities`、`output_modalities`；未声明的能力保持未知，不从名称推断图片能力或 token 上限。打开配置仅生成脱敏查看快照，数据库保持唯一权威来源。`App` 持有聊天选择器与设置页共用的已保存配置，并按操作顺序提交；宿主保存成功后更新显示，失败保持原选择，保存期间阻止新发送，停止当前任务仍可用。模型选择不是会话字段，切换不改变草稿、附件、历史或会话身份。浏览器开发宿主只恢复脱敏配置，目录网络获取和本地配置文件仍明确要求桌面应用。

启动恢复前，`legacy-storage-migration.ts` 读取同一目录内尚未导入的 `session-state.json`、`runtime-settings.json` 与 `runtime-secrets.json`，先按当前解析规则读取，再由一个事务导入。旧文件保留且不再写入；已有数据库记录始终优先。任何旧文件解析失败都不提交部分迁移，数据库损坏也不会用空状态覆盖。Execution Trace（执行追踪）的诊断 JSONL（逐行日志格式）仍使用现有写入链路。

`@agent-desktop/client` 是 Web（网页）与 Desktop（桌面）共用的产品级 React Client（客户端），只依赖显式传入的 `AgentClientApi`（客户端宿主能力接口），并拥有唯一的 App、Session UI、Runtime Settings UI（运行时设置界面）、Agent Activity、Artifact Card 和样式实现。`cancelTask`（取消任务）与 `revealFile`（定位文件）由同一接口提供；`apps/desktop` 通过 preload API 提供真实 Electron 宿主，`apps/web` 提供可取消的内存模拟 Turn，不执行本地视频 Agent。网页开发宿主仅将脱敏运行时设置写入浏览器 `localStorage`，刷新后恢复模型选择；模拟密钥状态不代表真实密钥存储，会话仍仅在内存中。写入失败不提交新状态，目录网络获取和本地配置文件仍明确要求桌面应用。

`apps/desktop` 是 Electron（桌面运行时）44.0.0、React（界面库）19.2.8、Vite（构建工具）8.2.2 和 esbuild（打包工具）0.27.4 组成的桌面宿主。它只负责当前视频任务所需的入口和展示：选择或移除一个或多个待提交的输入附件、提交自然语言剪辑任务、按轮展示由共享 Execution Trace（执行追踪）与 Session 事实投影的 Agent Activity（活动轨迹）、执行期间的实时助手文本、最终回复与输出文件。任务文本可以在没有视频附件时独立提交；选择视频后仍沿用视频剪辑链路。

输入附件用统一的 `Attachment`（附件）表达，字段只有 `path`（身份，也是模型实际使用的路径）、`name`（界面展示名）和 `role`（用途）。`role` 当前只有 `video`（主视频）和 `audio`（外加音轨）两种取值，它决定提示词把该文件描述成什么，而不是决定工具调用顺序——顺序仍由模型根据提示词与已注册工具自行判断。角色按扩展名判定（`.mp3` 等归 `audio`，其余归 `video`），且必须对应一个已注册的工具消费者：`audio` 的消费者是 `add_audio`。共同的文件对话框按这两类扩展名过滤，因此「用户能选到」与「有工具能用」始终是同一份来源。宿主不再为视频任务预设最终输出路径：输出项由模型按用户要求声明，最终名称在发布时按真实磁盘占用确定，因此单独添加音轨与缺少主视频都不会改变任何命名事实。

每个 Desktop 窗口维护一个最小 `Map<sessionId, DesktopSessionState>`，并将必要状态保存到 Electron `app.getPath('userData')/agent-desktop.sqlite`。每个会话只长期持有 InMemorySession（内存会话）和待提交附件；`activeSessionId` 决定后续文件选择、任务执行和产物定位操作的目标。会话侧附件是权威事实，Client Snapshot 里的附件只是发给 Renderer 的展示副本；重启恢复时按会话附件重建一次界面副本，避免旧格式快照里「只有名称、没有路径」的副本被继续沿用。旧快照里的全局输出序号不再参与任何命名，读取时直接忽略：新命名只依赖发布时的真实磁盘占用。

产物由所属会话、轮次、工具调用和真实路径识别，文件名只是界面标签。识别规则只有一个权威实现（`apps/desktop/src/main/agent-task.ts` 的 `findTurnArtifacts`）：以成功结果自己报告的 `artifacts` 为准（见「成功结果的产物事实」），不因为磁盘上存在同名文件就登记产物，也不把 `outputDir` 当成视频文件。产物路径随轮次写入 Client Snapshot，因此同名文件位于不同目录、或同一轮次产生多个产物都能分别定位；宿主不再维护按文件名索引的产物表，`revealFile` 用会话事件与附件路径校验来路后才交给系统文件管理器。

整轮失败或用户取消不代表本轮此前已成功的工具没有产出。收尾路径只查询本次任务起点 `firstTaskEventIndex` 之后的 Session 事实，用 `findLatestTurnId` 反查本次 Turn（失败时 `runTurn` 直接抛错，拿不到返回值，但 `turn.started` 已落盘），再按同一个 turnId 统计已成功的产物；主进程将这些产物以 `outputFiles` 放入失败或取消结果对象，经 preload 转交，由 Renderer 还原错误后交给 Shared Client，最终并入同一轮的 `failed` / `cancelled` 终态。因此产物卡在成功、失败、取消三种终态下是同一张卡、同一套定位入口。字段缺失或为空数组都表示本轮没有产物，不允许凭空造卡。

历史快照的产物关联在读取时做一次最小换算：旧格式把路径存在会话侧的 `outputFilePaths`（按文件名索引的路径表），回复里只记 `outputFileName`，解析时据此还原成等价的 `outputFiles: [{ path, fileName }]`；查不到对应路径时按「本轮没有产物」读取，不编造路径。换算需要先把会话侧的旧产物表读出来再解析 Client Snapshot，所以状态解析顺序是先 sessions、后 clientState。换算只发生在读取边界，写回磁盘时一律是新格式。

历史快照的附件同样在读取边界换算一次：旧会话存 `selectedVideoPaths`、旧界面副本存 `selectedVideos`，那时唯一的附件语义就是视频，因此一律换算成 `role: 'video'`。界面副本无法从旧字段恢复真实路径（旧字段只有名称），所以换算后由会话事实重建，而不是沿用空路径。两种旧字段都不存在时按空附件读取。

每次用户 Turn（用户任务轮次）开始时，Electron Main 重新读取最新 Runtime Settings（运行时设置）并创建一个 Video Agent（视频智能体）；该 Agent 在完整 Turn 内保持不变，下一个 Turn 才重新创建。每次创建都注入会话原有的同一个 InMemorySession，因此 Agent Loop 仍只根据 Session 事件重建 Model Context（模型上下文）。Renderer 为每个会话保存消息、草稿和附件等 UI History（界面历史），但不把这些消息重新拼接进模型请求。每轮 Agent Activity（活动轨迹）、Artifact（产物）和 Trace ID 都归属发起该轮任务的会话与 Agent 回复。

运行中的任务允许单独保存 `conversationModel`，仅影响后续任务；供应商、密钥、能力和备用设置仍在任务期间禁止修改。原任务的主模型、视觉、语义验收、子智能体与标题概括继续使用启动快照。

Turn 执行期间，Model 的 assistant text 增量沿现有 `desktop:agent-event` 通道实时推送到 Renderer，只更新当前 `processing`（处理中）的 Agent 回复。该临时文本不写入 Session，也不进入持久化快照；完成、取消或失败时由完整回复替换或直接丢弃。

Agent 回复按最小 Markdown（轻量标记文本）子集渲染，链接只在明确的 web 协议上成为可点击锚点。链接的去向由桌面宿主决定：Main 用 `setWindowOpenHandler` 拒绝新窗口，用 `will-navigate` 只拦截外部地址，两者都把地址交给系统浏览器，因此 Renderer 既不导航当前窗口，也不创建新的 Electron 窗口。

Electron Main 同时只保存一个 `{ sessionId, controller, finished }` 活动任务。`AbortController` 产生的同一个 AbortSignal（取消信号）依次传入 `runTurn`、Model 请求和 Tool 执行；Agent Loop 在 Model 前、Tool 前和 Tool 后检查它，Provider 将它交给 `fetch`，FFmpeg 与 whisper.cpp 的进程执行边界在 abort 时终止 child process（子进程）。取消不清空 Session，不回滚已完成 Tool 结果，也不删除已生成 Artifact（产物）；旧 controller 只清理自身对应的活动任务。`finished` 只表示该轮已经结束，供关闭收尾等待终态。

用户点击“新会话”时，客户端复用相同项目及目录的输入草稿；没有匹配草稿才请求 Main 创建新的 InMemorySession，并保留旧会话。首次提交把草稿转入历史；删除全部历史后，宿主剩余或新建的输入会话仍保存在草稿中。点击侧栏历史会话时切换 `activeSessionId` 并恢复对应界面历史。执行中的 Turn 不允许新建、切换会话或保存设置，当前仍只有一个前台任务。应用重启时从 SQLite 数据库恢复会话、SessionEvent、附件路径和 Client Snapshot（其中包含各轮产物的真实路径）；Web Dev Host 返回空快照且不做持久化。

Desktop 任务起点通过 `DesktopPersistentSession.commitStart(start, clientState, turnMessageBinding)` 一次 SQLite 事务保存新事件批、从草稿迁入历史后的展示快照，以及 `{ executionVersion: 1, turnId, userMessageId, assistantMessageId }` 关联。Main 在 IPC 边界核对会话、两条新增消息的标识与角色、提示词和当前附件；重复提示词也按标识归属，不按文本或消息顺序猜测轮次。事务成功后才更新内存并准备插件、钩子和模型；保存失败不推进起点，也不启动这些外部操作。Renderer 的常规展示保存不能把已提交任务退回空消息草稿。

任务与恢复终态使用普通 `AgentTaskIpcResult` 对象穿过进程通信和 `contextBridge`（上下文安全桥）；Preload 不提前构造业务错误。Renderer 收到对象后在现有 Desktop 入口还原错误名称、已交付文件、逐项交付结果和任务事实投影，继续使用共享客户端和 Web 的 Promise 拒绝契约。这样实际取消身份和既有产物不会因 Electron 复制 Error 而丢失；任务投影可能因未知效果而受阻，不能代替错误名称判断取消。Main 内部保留原始持久化错误实例的契约不因跨进程展示而改变。

重启只为具有 `executionVersion: 1` 消息绑定、且原事件仍处于 `started` 的任务追加 `turn.interrupted`，按绑定的助手消息恢复真实终态、计划和已有产物。旧历史没有绑定时保留其合法展示和已有明确关联，不按相同文本或消息顺序补造绑定，也不以缺少终态直接推断进程异常退出。已完成结果即使尚未送达 Renderer，仍由绑定及 Session 事实补回；恢复始终由用户主动开始新轮次，不重放旧工具、审批或进程。

人工核验请求必须提供去除空白后非空、原字段不超过 512 字符的说明，说明作为 `effect.outcome.verified.evidence.description` 保存；按钮或宿主不自动填入“已完成”。核验只引用当前会话尚未解决的真实来源，不能改写原工具结果、增加产物或授予新的目录权限。终端效果的说明应包含旧进程的实际状态与执行结果；仅显示连接断开不能证明命令已经停止或成功。

桌面首轮成功且开始前没有会话事件时，Main 用本轮已有 `agent.model` 独立请求任务标题：只提供命名指令与用户任务，工具列表为空，沿用本轮取消信号，不追加 Session 事件。有效标题随 `AgentTaskResult.conversationTitle` 返回；命名错误通过 `conversationTitleError` 单独展示，已完成任务与产物保持成功。客户端只替换未经手动重命名的标题。失败或取消的首轮保留首条任务作为临时标题，不承诺后续轮次补做模型命名。

纯数字首条消息不发起独立命名请求，直接返回用户原文；模型边界拒绝实际出现的“未提供任务内容 / 无法生成标题”说明，避免把命名失败写成正常会话名称。

关闭窗口时 Main 先完成收尾再真正退出：运行中的 Turn 先收到取消信号并等待该轮结束，再由 Main 沿 `desktop:prepare-close` 请求 Renderer 提交当前展示状态，Renderer 保存完成后用 `desktop:close-prepared` 回告结果。Renderer 的常规保存仍是 150ms 防抖，只有关闭请求要求立即提交；轮次未结算前不提交，避免把临时流式文本写成历史。提交失败时 Main 显示失败并保留窗口，不用伪成功覆盖磁盘历史。

`close` 事件必须先 `preventDefault()` 再判断该窗口是否已在收尾：收尾期间用户再次点关闭时，前一次收尾尚未结束，若先判断再阻止，第二次关闭就会直接销毁窗口，跳过等待落盘并留下半份状态。重复关闭不重复进入收尾流程，真正的关闭只发生在收尾通过后的 `window.destroy()`，它不会再触发 `close` 事件。

非敏感设置与加密密钥写入 `app.getPath('userData')/agent-desktop.sqlite` 的独立记录；两者由同一事务提交。各供应商 API Key（接口密钥）继续由 Electron `safeStorage` 加密，只以密文保存；Renderer 只能读取“已配置 / 未配置”和来源，不能读取真实 Key。`safeStorage` 不可用时保存或读取本机密钥明确失败，不降级为明文。Desktop 的 FFmpeg、Whisper 和 Vision 均由独立插件提供；Whisper 运行资源和模型由宿主管理，只有模型完整性和运行资源检查通过时才注册 `transcribe_audio`。缺少插件、模型、运行资源或有效视觉路由时，其它 Agent 能力继续运行，依赖该能力的语义验收返回 `blocked`。CLI 显式选择本机实现并使用系统 PATH。

```text
Layer                 中文名称         职责
Renderer              渲染进程         保存运行期会话列表与各会话 UI 历史，收集任务和脱敏设置并切换展示
Preload contextBridge 预加载安全桥     通过 contextBridge 暴露受限桌面 API
Electron Main         Electron 主进程  按会话持有 Session 与附件，并从 Session 事实识别产物，负责设置与密钥持久化
createVideoAgent      组装视频智能体   每个 Turn 创建 Model、System Prompt 和当前可用视频 Tool
runTurn               执行任务轮次     驱动一次 Turn 的 Model 与 Tool 执行
```

Desktop 不把 Agent Core（智能体核心）逻辑放入 UI；取消沿 Model、Tool、Agent Loop 和 Trace 的信号契约传播。当前支持有限模型请求重试和父任务等待的只读子任务，不实现暂停恢复、任务队列、已完成工具回滚、云同步或供应商注册框架。

## 桌面应用更新

```text
Application Updater     应用更新器      桌面主进程检查、下载并启动 Windows 安装包更新。
Update State            更新状态        宿主将检查、下载、就绪、安装及错误事实投影给渲染层。
Update Installation     更新安装        用户点击入口后保存会话并退出，安装器覆盖应用并重新启动。
```

`apps/desktop/src/main/app-updater.ts` 使用 `electron-updater` 的 Windows 安装包更新器，发布源固定为当前公开仓库 `wwxst/agent-desktop` 的 GitHub 正式发布。只有 Windows 已打包应用创建更新器；源码模式返回空闲状态，浏览器宿主没有安装能力。启动时检查一次，发现新版本自动下载并由软件开发工具包校验摘要，完成后等待用户点击；普通退出不会自动安装，不提供版本详情页或供应商设置。

更新状态经独立 `desktop:update-state` 通道到达预加载桥接，共享客户端的可选 `appUpdates` 能力只展示状态与发送安装、重试请求。更新不进入模型上下文、执行追踪或 Agent Core（智能体核心）。宿主拒绝任务或扩展操作未完成时的安装；就绪更新进入安装状态后，复用窗口关闭的终端收尾和客户端快照提交，SQLite（本地嵌入式数据库）保存成功才调用安装器。保存失败保留已下载更新与窗口，安装器失败保留真实错误；保存过程中不允许重复关闭握手或开始新任务。

无正式发行版的软件开发工具包错误转为 `unavailable`，不表示更新检查成功或当前版本为最新版；仅明确的无版本错误及最新发行版端点的 404/406 使用此状态。其他检查、下载或安装失败保持 `error` 并可重试，界面只收到简短中文提示。完整异常写入 Electron 日志目录的 `app-updater.log`，不进入会话或智能体执行追踪。

打包与发布命令、资源路径及线上验收边界见 `docs/engineering.md` 的 Windows 安装包与更新章节。

## Core Concepts（核心概念）

每个核心概念都必须有清晰职责，并且能够在不阅读内部实现的情况下被其他模块使用。

### Model

```text
English field       中文字段    说明
Responsibilities    职责        接收 Model Request 并返回 Model Response 或 Model Events
Owns                拥有        模型请求与响应的核心抽象，不拥有具体供应商客户端
Does Not Own        不负责      不驱动 Agent Loop，不保存 Session，不执行 Tool
Dependencies        依赖        只依赖核心请求、响应和事件值类型
Consumers           使用者      Agent Loop 和测试替身 Model
```

Model（模型）只表达模型交互的通用能力。其输出至少能够表达 assistant text（助手文本）和 tool calls（工具调用），但 Core 不出现 OpenAI、DeepSeek 或 Anthropic SDK 类型。

Model Request（模型请求）可以携带可选的文本增量回调。Provider 在流式响应中把 assistant text 增量实时上报给该回调，但回调只服务实时展示：Model 仍然返回完整 Model Response，Session 仍然只追加完整 `assistant.message`，任何 token 或增量都不会成为 Session 事实。

Model Response（模型响应）的可选 `usage` 只承载供应商实际返回的输入、输出 token 计数。Chat Completions（聊天补全协议）请求包含用量的流式尾帧；Responses（响应协议）读取完成响应中的用量。Agent Loop（智能体循环）仅在主模型请求完整成功后通过 `onModelUsage` 上报，缺失用量也会上报未知；上下文摘要、标题、独立审批和子代理请求不混入主请求用量。Desktop（桌面宿主）附上本轮固定的模型身份，经现有运行期事件更新各聊天的 `contextUsage` 展示副本，并随客户端快照保存和恢复，不进入 Session（会话事实）、诊断 Trace（执行追踪）或推理上下文。它表示最近一次请求的输入与输出之和，不跨请求累计；容量取所选模型明确配置的 `contextWindow`，切换模型后不复用其他模型的计数，缺失容量或用量不以估算代替。

### Session

```text
English field       中文字段    说明
Responsibilities    职责        追加并读取一次 Agent 执行过程中发生的事实
Owns                拥有        append-only event log（只追加事件日志）
Does Not Own        不负责      不调用 Model，不执行 Tool，不决定 Loop 算法
Dependencies        依赖        核心事件类型和可重建历史的值类型
Consumers           使用者      Agent、Agent Loop 和测试
```

Session（会话）不是简单的聊天消息数组，而是 Agent 执行历史的事实来源。MVP 阶段 Session 可以只存在内存中，但数据模型从第一版开始必须支持 append-only（只追加）。

### System Prompt

```text
English field       中文字段    说明
Responsibilities    职责        组装基础 Agent 指令和当前运行所需的系统文本
Owns                拥有        基础系统提示词的来源和组装结果
Does Not Own        不负责      不执行 Model，不读取隐藏的 Session 状态，不实现 Skill 注入
Dependencies        依赖        Agent 配置和明确传入的基础工具描述
Consumers           使用者      Agent Loop 的 Model Request 构建阶段
```

System Prompt（系统提示词）必须有独立边界。Agent Loop 可以请求它构建系统指令，但不能在多个分支中到处拼接字符串。

### Tool

```text
English field       中文字段    说明
Responsibilities    职责        暴露一个可调用能力并执行一次合法输入
Owns                拥有        name、description、input schema 和 execute 行为
Does Not Own        不负责      不注册自己，不控制 Agent Loop，不直接修改 Session
Dependencies        依赖        核心工具调用输入、输出和错误结果类型
Consumers           使用者      Tool Registry 和 Agent Loop
```

Tool（工具）是一个可调用能力。MVP 不规定具体 schema library；工具只需要有稳定的名称、说明、输入约束和执行边界。

### Agent

```text
English field       中文字段    说明
Responsibilities    职责        表示一次运行所需的 Agent 依赖
Owns                拥有        Model、Session、Tool Registry 和 System Prompt
Does Not Own        不负责      不拥有驱动多 Step 的算法，不把所有行为塞进一个巨型类
Dependencies        依赖        Model、Session、Tool Registry 和 System Prompt 抽象
Consumers           使用者      当前示例入口和 Agent Loop
```

Agent（智能体）只持有 Loop 执行所需的依赖，不等于 Loop 算法本身。

### Agent Loop

```text
English field       中文字段    说明
Responsibilities    职责        驱动 Turn、Step、Model 调用和顺序 Tool 执行
Owns                拥有        执行算法、当前控制流和下一步决策
Does Not Own        不负责      不拥有 Model Provider 类型，不替代 Session 事实，不实现 Tool 细节
Dependencies        依赖        Agent 暴露的 Model、Session、Tool Registry 和 System Prompt
Consumers           使用者      Agent 的运行入口
```

Agent Loop（智能体循环）是当前驱动执行过程的算法。

## Agent and Agent Loop Separation（Agent 与循环分离）

两者必须保持不同职责：

```text
Agent
智能体
持有一次运行所需的依赖。

Agent Loop
智能体循环
驱动一次 Turn 内的 Step、Model 调用、Tool 调用和结束判断。
```

Loop 可以操作 Agent 提供的抽象，但不能把 Agent 设计成包含所有执行分支的巨大类。

## Turn and Step（轮次与步骤）

```text
English term    中文术语    定义
Turn            轮次        一次用户任务从开始到产生最终结果的完整生命周期
Step            步骤        Turn 内的一次模型调用以及由该调用触发的工具执行阶段
```

一个 Turn 可以包含 `1..N` 个 Step。不能把“一条 user message（用户消息）”写死为“一次 model request（模型请求）”。

示例：

```text
Turn 1

Step 1
Model → echo Tool Call
模型 → echo 工具调用

Step 2
Model ← echo Tool Result
模型 ← echo 工具结果
Model → Final Answer
模型 → 最终回答
```

## Session Event Log（会话事件日志）

Session 必须采用 append-only event log（只追加事件日志）思想：

```text
历史 Event 不原地修改。
新的事实通过追加 Event 表达。
失败通过新的事件或失败结果表达，不能修改旧事件来伪装成功。
```

MVP 只定义以下最小事件集合：

```text
Event name           中文含义    记录内容
turn.started         轮次开始    Turn 身份
user.message         用户消息    进入本次 Turn 的用户输入
step.started         步骤开始    Step 身份及所属 Turn
assistant.message    助手消息    Model 产生的文本输出或可关联的调用信息
tool.called          工具调用    Tool 名称、调用身份和经过约束的输入
tool.result          工具结果    Tool 返回值及 success 或 error 状态
step.completed       步骤完成    Step 的完成状态
turn.completed       轮次完成    Turn 已完成
```

`tool.result` 的 `error` 状态表达 Tool Error（工具错误），因此 MVP 不额外增加复杂的错误事件类型；语义上仍然必须区分 Tool Call、Tool Result 和 Tool Error。

必须满足：

> Model-visible information should be reconstructable from Session history.

模型真正看到过的历史信息，应当能够根据 Session 中保存的事实重新构建，而不是依赖只存在于内存中的隐藏状态。

Agent Loop 只把完整 Step 的 `assistant.message` 与 `tool.result` 成组投影为模型工具协议。取消或失败的未完成 Step 仍在只追加历史中；其中真实成功结果、拒绝和未知效果以带来源索引的普通事实文本保留，不补造悬空工具消息或 `step.completed`。预算启用时，旧完整 Step 可以由独立的 `context.compacted` 摘要代替，原用户约束、最新计划及未明效果确定性保留。摘要记录精确的完整 Step 覆盖集合、前摘要引用与 SHA-256 来源校验，磁盘恢复复算后重建同一投影。UTF-8 字节数加协议开销只是保守估算，不能证明摘要语义准确；压缩的格式或模型失败只有在旧投影仍满足硬预算时才能回退，保存异常和取消直接传播。磁盘事件始终原样保留，投影或保存不会删除原历史。

### Session Invariants（Session 不变量）

1. Session Event 只能追加。
2. 每个 Step 必须属于一个 Turn。
3. Tool Result 必须能够关联到对应 Tool Call。
4. Turn 正常完成后必须有明确完成状态。
5. 失败不能通过修改旧 Event 来伪装成成功。
6. Session 不应该保存无法解释来源的模型上下文。

## Model Abstraction（模型抽象）

Model 的通用边界是：

```text
Input                输入        Model Request
Output               输出        Model Response 或 Model Events
Minimum content      最小内容    assistant text 和 tool calls
Streaming text       流式文本   文本增量只用于实时展示，最终事实仍是完整 Model Response
Provider boundary    提供商边界  具体 SDK 类型只停留在 Provider package
```

Core 不得绑定以下具体接口或 SDK：

```text
OpenAI Responses API
DeepSeek API
Anthropic Messages API
```

Provider-specific types（提供商专属类型）必须停留在具体 Provider package（提供商包），不能泄漏到 Agent、Agent Loop 或 Session。

## Tool and Tool Registry（工具与工具注册表）

```text
English term     中文术语      职责
Tool             工具          一个可调用能力
Tool Registry    工具注册表    当前 Agent 可以发现和查找的 Tool 集合
```

Tool 至少包含以下概念字段：

```text
name             名称        稳定且可识别的调用名称
description      描述        供 Agent 和 Model 理解用途
input schema     输入约束    描述合法输入的形状和限制
execute          执行        接收合法输入并返回结果或错误
```

Tool Registry 负责注册、查找和返回 Tool，不负责执行 Loop 算法。MVP 不要求使用 Zod、JSON Schema library 或 Valibot，当前通过 Tool 的 inputSchema 描述输入约束。

`execute` 接收 `ToolExecutionContext`（工具执行上下文），而不是继续增加位置参数。上下文提供当前 `AbortSignal`、`toolCallId` 和同步的 `reportProgress`：进度只用于实时展示，同步入队，工具不等待界面消费，也不把 IPC Promise 带进工具契约；具体工具仍然只返回最终结果，不控制 Agent Loop。

首期只定义一种有真实消费者的进度 `command.output`，包含来源流、序号、文本片段和被丢弃字节数。Agent Loop 通过可选的 `onToolProgress` 把它转发给宿主；进度不写入诊断 Trace，也不写入 Session 或模型上下文。`runTurn` 的可选端口（`trace`、`signal`、`onTextDelta`、`onToolResult`、`onToolProgress`）统一收在一个选项对象里，不引入事件总线。

## Tool Execution Failure（工具执行失败）

Tool 执行失败不能直接让 Session 历史丢失。MVP 采用最小方案：使用 `tool.result` 事件表达结果，并通过状态区分成功和失败。

```text
Tool Call        工具调用    记录请求已经被 Agent Loop 发起
Tool Result      工具结果    记录工具执行返回，状态为 success 或 error
Tool Error       工具错误    表示 Tool Result 的 error 状态及可解释错误信息
```

Tool 不存在、输入不合法或 execute 失败，都必须产生可追溯的失败结果，并允许 Agent Loop 决定是否结束当前 Turn。MVP 不设计复杂 Retry Policy（重试策略）。

视频 Tool 写出用户可见文件时拒绝覆盖：目标已存在就直接返回 Tool error，由模型改用其他输出路径，不自动改名、不重试。判定发生在 Tool 边界（`packages/video-ffmpeg` 的 `executeOutputCommand`），FFmpeg 参数里的 `-n` 只作为写入边界兜底——本机 FFmpeg 9.0 在 `-n` 拒绝覆盖时退出码仍为 0，只看退出码会把冲突误报成成功。抽帧的 JPG 与 `extract_audio` 的 WAV 同样受该规则约束；工具私有临时目录（whisper 的转写目录）由各自工具创建和清理，不受该规则约束。

`concat_videos` 按输入顺序用 FFmpeg 拼接滤镜（concat filter）逐段解码后重新编码，因此各段音频采样率或 time_base（时间基准）不一致也能正确拼接；旧的拼接解复用器（concat demuxer）会沿用首段音频参数，静默丢弃后续片段却仍返回成功。拼接滤镜必须为每段显式提供音频输入，所以该 Tool 在启动 FFmpeg 之前用一次 ffprobe 逐段确认音轨：全部片段都没有音轨时只拼接视频流，与无音轨输入的既有结果一致；只有部分片段有音轨时明确返回 Tool error，不产出比视频短的音轨，也不静默丢音。音轨探测发生在真实进程边界，复用 Tool 自己的 `CommandExecutor`，并让探测与拼接使用同一个 AbortSignal（取消信号）。

`decode_video` 用一次完整的「解码到 null」证明整段媒体都能读出，并报告真实被检查的路径。它区分两种不同结论：解码进程无法启动是工具不可用，按 Tool error 暴露；进程正常运行后报错说明这段媒体自身不能完整解码，是真实检查结论，返回 `fullyDecoded: false` 而不是工具错误。`probe_media` 与 `detect_black_segments` 的结果同样保留真实输入路径，黑段检测另外报告实际生效的 `blackdetect` 参数，使历史结论只能被解释成「在这组参数下」的结果。

Agent Loop 先把 `tool.result` 追加到 Session，再写完成诊断：诊断写入失败不能遮蔽已经发生的成功事实（例如一个已经真正发布的文件）。成功结果的会话追加顺序只做这一处通用调整，不向核心引入视频或发布分支。

## Agent Loop State Machine（Agent 循环状态机）

MVP Loop 的最小状态机如下：

```text
START
  │
  ▼
Begin Turn
  │
  ▼
Append User Message
  │
  ▼
Begin Step
  │
  ▼
Build Model Input
  │
  ▼
Call Model
  │
  ▼
Model Response
  │
   ▼
Has Tool Calls?
   │
   ├── NO ───────────────► Complete Step
   │                         │
   │                         ▼
   │                     Complete Turn
   │                         │
   │                         ▼
   │                        END
   │
   └── YES
         │
         ▼
   Begin ordered Tool Calls
   同一 Step 内按顺序开始
         │
         ▼
    Execute next Tool
         │
         ▼
   Append Tool Result
         │
         ▼
   More Tool Calls?
         │
         ├── YES ─────────► Execute next Tool
         │
         └── NO ──────────► Complete Step
                              │
                              └────────────► Next Step
```

一次 Model Response 可以包含多个 Tool Call。MVP 中这些 Tool Calls 属于同一个 Step，并按顺序执行；只有所有 Tool Results 都记录完成后，才完成当前 Step 并进入下一 Step。不引入并行 Tool execution（工具并行执行）。

## Dependency Rules（依赖规则）

允许的主要关系：

```text
Agent
  │
  ├── uses Model
  ├── uses Session
  ├── uses Tool Registry
  └── uses System Prompt

Agent Loop
  │
  └── operates on Agent abstractions
```

必须禁止以下依赖：

```text
Model 不依赖 Agent Loop。
Tool 不依赖 Agent Loop。
Session 不依赖具体 Model Provider。
Core 不依赖 Electron。
Core 不依赖 React。
Core 不依赖具体 Tool implementation。
Agent Loop 不依赖 OpenAI 或 DeepSeek SDK。
Session 不依赖 UI。
```

## Architecture Invariants（架构不变量）

```text
ID        English invariant                                      中文说明
INV-001   Core is UI independent.                                核心与 UI 无关。
INV-002   Agent Core is model-provider independent.              Agent Core 不绑定具体模型供应商。
INV-003   Agent and Agent Loop are separate responsibilities.    Agent 与 Agent Loop 必须职责分离。
INV-004   Session history is append-only.                        Session 历史只追加，不原地修改。
INV-005   Every Step belongs to a Turn.                          每个 Step 必须属于一个 Turn。
INV-006   Every Tool Result is traceable to its Tool Call.       每个 Tool Result 必须能追溯到对应 Tool Call。
INV-007   Tool implementations do not control the Agent Loop.    Tool 实现不能反向控制 Agent Loop。
INV-008   Model-visible facts are reconstructable from Session.  模型看到过的历史事实能够从 Session 重建。
```

这些不变量是 MVP 的设计约束。新增不变量必须服务于当前核心边界，不超过实际需要。

## Failure Boundaries（失败边界）

MVP 至少需要能够解释以下失败：

```text
Failure boundary          失败边界            MVP 处理方式
Model failure             模型失败            异常向上抛出，保留失败前已写入的 Session 事件
Tool not found            工具不存在          产生可追溯的 Tool Result error
Tool execution failure    工具执行失败        产生带错误状态的 Tool Result
Malformed tool call       工具调用格式错误    不执行未知输入，记录可解释失败
```

当前不加入 Retry、Backoff 或 Circuit Breaker。失败边界的目标是让 Session 状态可解释，而不是一次性解决所有恢复策略。

## Agent Execution Trace（智能体执行追踪）

Agent Execution Trace（智能体执行追踪）用于定位一次 Agent Turn 在 Model、Tool 或 Turn 哪一层发生问题。Agent Loop 通过最小 `ExecutionTrace` callback（执行追踪回调）产生语义事件，`@agent-desktop/execution-trace` 只负责本地 JSONL 持久化，并由 `ffmpeg-agent` 与 Desktop 两个真实入口消费；每次用户输入创建独立 `traceId`。

Session（会话）与 Trace 必须保持不同职责：

```text
Concept            中文概念    职责
Session            会话        保存模型可见业务事实，用于重建 Model Context
Execution Trace    执行追踪    保存运行顺序、状态、耗时和错误定位信息
```

Trace 不参与 Agent 推理，不能用于重建 Model Context，也不复制完整 Session Event、用户输入、Model 内容或 Tool 内容。

```text
traceId
  │
  ▼
Turn
  │
  ▼
Model Call
  │
  ▼
Tool Call
  │
  ▼
Tool Result
  │
  ▼
Final Response
```

MVP 事件集合如下：

```text
Event              中文事件    记录内容
turn.started       轮次开始    turnId
model.started      模型开始    turnId、stepId、messageCount、toolDefinitionCount
model.completed    模型完成    durationMs、toolCallCount、hasText
model.failed       模型失败    durationMs、errorName、errorMessage
tool.started       工具开始    turnId、stepId、toolCallId、toolName
tool.completed     工具完成    durationMs
tool.failed        工具失败    durationMs、errorName（如有）
turn.completed     轮次完成    durationMs、stepCount
turn.failed        轮次失败    durationMs、errorName、errorMessage
```

JSONL Writer（JSONL 写入器）在每行增加同一个 `traceId` 和写入时的 ISO `timestamp`。Agent Loop 使用 `Date.now()` 计算毫秒耗时，并 `await` 每次 callback（回调）写入，使日志顺序与实际串行执行顺序一致。Tool 返回 `status: error` 时记录 `tool.failed`；其他 `runTurn` 异常记录 `turn.failed`。正常写入时 Trace 不改变既有错误传播和 Session 行为；Trace 写入本身失败时，callback 的异常按程序错误向上暴露。

Trace 当前固定写入仓库根目录下的 `logs/agent-trace.jsonl`。CLI 与 Desktop 都将入口工作目录解析到该路径。日志只包含关联 ID、事件类型、计数、状态和 Model/Turn 错误信息；Tool 失败不保存错误消息，避免间接写入 Tool input/output。日志不保存完整用户 Prompt、Model Request/Response、Tool input/output、Transcript、Vision analysis、图片、视频内容、API Key、环境变量值或错误 stack。

Desktop 会消费 Trace callback 并把模型步骤与工具调用投影成 Agent Activity（活动轨迹），但不提供独立的 Trace 日志 UI。当前不实现日志上传、搜索、过滤、rotation（轮转）、retention（保留策略）、版本探测、queue（队列）、buffer（缓冲）、retry（重试）、fallback logger（兜底日志器）、OpenTelemetry、ELK、Jaeger、Zipkin 或 Sentry integration；这些能力当前没有生产消费者。

## Agent Activity Projection（活动轨迹投影）

Agent Activity（活动轨迹）是 Desktop 唯一的活动展示契约：`@agent-desktop/client` 只渲染 `AgentActivityItem`（活动条目），不读取 Trace 事件，也不判断工具语义。

```text
Field                  中文名称      来源
id                     活动标识      模型步骤用 stepId，工具调用用 toolCallId
kind                   活动类型      analysis（模型步骤）、tool（工具调用）或 commentary（公开说明）
status                 执行状态      running、completed、failed 或 cancelled
toolName               技术工具名    来自 tool.started / tool.completed / tool.failed 或取消时未完成的 Session 调用
files                  文件引用      来自 Session 的 tool.called input 中当前工具契约声明的路径字段
durationMs             执行耗时      来自 Trace 的真实耗时
plannedToolCallCount   计划工具数    来自 model.completed 的 toolCallCount
```

Electron Main 在 `apps/desktop/src/main/agent-activity.ts` 中把两类真实事实投影成一条活动：状态、耗时和模型步骤来自 Execution Trace，文件引用来自 Session 的 `tool.called.input`。Trace 不复制工具内容，因此文件事实必须从 Session 读取；投影只读取当前工具契约声明的文件和目录字段，以及 `analyze_images` 的 `images[].path`，其他形状不产生文件引用。`edit_text_file` 成功后以同一 Tool Result（工具结果）中的真实 `filePath` 更新活动，避免把模型传入的相对路径保存成修改事实。Turn 生命周期事件不单独成行；`turn.cancelled` 只把同一轮最后一个没有结果的工具调用更新为 `cancelled`，不覆盖已完成工具，也不把轮次耗时当作工具耗时。

Agent Loop 在每个 `tool.result` 已经追加到 Session 之后调用可选的 Tool Result Listener（工具结果监听器）。Desktop Main 通过这条独立内容通道，把 `read_file` 的有界行内容、`list_directory` 的有界目录项、`search_text` 的有界匹配、`run_command` 的退出码与有界输出，以及所有工具的真实失败消息投影为 `activity.detail`；Shared Client（共享客户端）把详情合并到同一 `AgentActivityItem` 并随界面快照持久化。详情不进入 Execution Trace，Trace 继续只保存状态、顺序、耗时和错误定位元数据；其他成功工具结果没有当前界面消费者，不复制到活动或快照。

命令执行期间的实时输出复用同一条 `activity.detail` 通道：宿主按约 50 毫秒一批推送 `command-output` 详情，并把两条流累积量限制在与工具最终结果相同的保留预算内，因此界面缓存不随输出增长。命令结束后，来自 Tool Result 的 `command` 详情覆盖实时投影，成为该活动的权威终态；取消或失败时已经收到的有界输出仍然保留在展示快照里，但不会伪装成模型可见的成功结果。

同一个活动 `id` 只保留一条记录：`running` 会被后续的 `completed`、`failed` 或 `cancelled` 覆盖，因此界面顺序是真实的执行顺序，而不是事件到达顺序。取消只把仍在 `running` 的活动标记为 `cancelled`，已完成活动的真实状态和耗时保持不变。

文件引用可以点击，由 `AgentClientApi.revealFile(path)` 交给宿主。Desktop 的 Main 在定位前必须确认该路径属于当前会话真实使用过的文件（会话附件或 Session 中真实的工具输入），并确认文件仍然存在；任一条件不满足时抛出真实错误，由界面在该活动行内展示，不使用弹窗，也不静默失败。Renderer 传来的路径属于真实边界，因此该校验放在 Main，而不是 Client。

活动轨迹只显示 Execution Trace 与 Session 中真实存在的事实，不引入假进度或编造的说明。公开说明来自完整模型回复，诊断 JSONL 的职责不变，活动正文不写回 Trace。

## Execution Interactions（执行交互）

```text
Concept                  中文术语          职责
User Question            执行中提问        收集用户决定后继续同一轮，回答不等于操作授权。
Public Commentary        公开过程说明      完整模型回复含工具调用时，显示它的公开文字。
Bounded Model Retry      有限模型重试      只追加失败的模型请求，不重放工具或整个轮次。
Read-only Subagent       只读子智能体      父任务明确委派的一层独立文件检查。
Session Terminal         会话持久终端      应用运行期间跨轮保留终端，重启只恢复历史。
```

Desktop 注入 `askUser` 端口后注册 `ask_user`。宿主按问题请求、会话和轮次标识接收选项、自由文本或跳过，结果作为同一轮工具结果进入下一次模型请求。停止或关闭产生 `tool.interaction.closed` 事实，不能伪装成回答；恢复模型上下文时排除该事件和未完成步骤，恢复界面也没有可操作的旧问题。

模型增量携带 `stepId`，仅作临时展示。循环确认完整回复后发布 `onModelText`：伴随工具调用的公开文字成为工具前的说明，没有工具调用的文字成为最终回复。空文字不补造说明，失败或取消不保存未完成片段为确认说明；不读取供应商内部推理字段。

DeepSeek 将 HTTP 429、502、503、504 和已识别临时连接错误转换为供应商无关的 `ModelRequestError`。循环每步骤最多追加一次、每轮最多追加两次请求；等待可取消。默认等待一秒，服务端 `Retry-After` 超过十秒则不重试。认证、参数、协议、取消、截断响应以及已产生正文或工具分片的流不重试。`model.retrying` 只记录身份、原因、次数和等待时间，不记录正文或密钥。

Desktop 注入 `delegateTasks`，每轮合计最多两个子任务并行执行，父任务等待全部收尾。每个子任务有独立会话和模型实例，只注册 `list_directory`、`read_file`、`search_text`，继承父聊天的文件读取范围（已确认目录，或完全访问模式的本地文件范围）；没有写入、命令、终端、目录变更、审批或递归委派。每项最多八步骤和 120 秒，耗尽预算明确未完成。子活动嵌套在父工具内，完整子历史按父工具调用标识保存；父模型只接收摘要、状态与文件依据。父取消必须等待所有子请求终止，恢复不继续子任务。

Desktop Main 每会话持有一个 ConPTY 终端，由 `node-pty` 创建。`open_terminal` 的启动命令与 `write_terminal` 每次的准确输入都进入当前聊天的审批策略，`read_terminal` 最多等待两秒读取有界输出，`close_terminal` 结束进程树。归属按当前会话和宿主生成的终端标识校验。输出最多保留 64 KiB，约 50 毫秒合批推送，Shared Client 使用 xterm 展示控制序列；终端事件携带会话身份，完成当前轮次后仍可更新输出。取消本轮使用的终端、删除会话和正常关闭时等待进程树回收。快照不保存 PID 或句柄，重启统一显示连接已结束、不重连、不重跑；此前仍在运行的进程状态与结果未确认，需要人工核验，不承诺强杀宿主或崩溃后的回收。
