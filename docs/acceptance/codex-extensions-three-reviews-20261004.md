# Codex 插件与技能三轮核对

日期：2026-10-04。分支：`feature/settings-navigation`。保留原有工作树改动，没有整体暂存、提交、合并或推送。2026-10-03 报告保留为历史记录，本报告描述继续实施后的结果。

最新范围调整：用户要求先撤下没有实际接通服务的推荐插件，已移除官方65条默认目录，详情见文末“撤下默认第三方推荐”。前面公开目录及其反证描述的是调整前的历史实现与验收，不代表当前仍默认展示这些条目。

本轮已落地公开市场、完整清单与图片、技能缓存及工具依赖、插件更新回滚、远程 MCP、OAuth 授权、命令钩子及对应桌面界面。桌面实现与下面限定的功能验证通过。**完整客户端对齐、完整应用服务器线协议和所有界面逐像素一致仍不能判定通过**：自有后端的账号、云安装同步和分享服务尚未接入，也没有菜单和详情的 Codex 参考截图。用户已明确服务端应对接自己的系统；OpenAI 私有服务不是本项目的交付条件。

## 核对依据

- Codex 公开源码：`D:/Develop/Projects/codex-cli`，提交 `75ec81c8623c0ca50b129de5a82521a23d37b726`。
- 清单与市场：`codex-rs/core-plugins/src/manifest.rs`、`agent_plugin_manifest.rs`、`marketplace.rs`、`executor_hooks.rs`。
- 技能与协议：`codex-rs/skills/src/interface.rs`、`codex-rs/app-server-protocol/src/protocol/v2/plugin.rs`、`protocol/common.rs`。
- 真实公开市场：`https://github.com/openai/plugins.git`，本次检出提交 `5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f`，市场名 `openai-curated`，65 条公开目录。随包目录记录了来源提交；列表内容不同于早期参考图，不以删改真实市场条目制造相同截图。
- Codex 参考图：`logs/extensions-ui-20261001/codex-plugins.png`、`codex-skills.png`。Computer Use（桌面操作工具）初始化报 `Computer Use native pipe is unavailable`，本轮使用已有真实参考图，未重新捕获 Codex 菜单与详情。
- 本项目使用真实生产构建 Electron、独立用户数据目录及真实 Git 下载。浏览器测试中的宿主夹具只证明界面交互，不替代桌面安装证据。

## 三轮逐项复核

下面的“1 / 2 / 3”表示三个审查回合的核对结论，不表示同一个测试必须重复执行三遍。第一轮核对生产调用链与源码，第二轮核对实际界面及宿主行为，第三轮检查失败语义、反证和最终回归。各行只对文字限定的能力负责。

```text
Capability                    中文能力          三轮核对及限定结果
Independent Skill             独立技能          PASS / PASS / PASS：独立导入、启停、正文读取。
Bundled Skills                插件技能          PASS / PASS / PASS：插件来源、启停联动与卸载边界。
Recursive Discovery           递归发现          PASS / PASS / PASS：项目目录、隐藏目录排除、扫描预算。
Lazy Skill Reading            正文懒加载        PASS / PASS / PASS：元数据与完整正文分离。
Skill Metadata Cache          元数据缓存        PASS / PASS / PASS：文件签名、强制刷新与通知失效。
Skill Interface               技能界面配置      PASS / PASS / PASS：图标、简述、品牌、指令与策略。
Shared Skill Assets           共享技能资源      PASS / PASS / PASS：插件内共享图标及详情正文读取。
Skill Selection Budget        技能选择预算      PASS / PASS / PASS：最多64项、8000字符、显式指定优先。
Skill Tool Dependencies       技能工具依赖      PASS / PASS / PASS：真实URL进入MCP路径、项目配置使用会话目录。
Legacy Plugin Manifest        旧格式插件清单    PASS / PASS / PASS：清单、技能、服务、完整展示字段。
Agent Plugins v1              标准插件清单      PASS / PASS / PASS：根清单、OpenAI扩展与旧格式补充。
Marketplace Catalog           真实市场目录      PASS / PASS / PASS：官方65条、本地/Git来源、分类与真实图片。
Marketplace Installation      市场插件安装      PASS / PASS / PASS：真实Git检出、解析、复制、SQLite与IPC。
Version Update                插件版本更新      PASS / PASS / PASS：自行刷新来源、注册来源优先于随包快照。
Version Rollback              历史版本回滚      PASS / PASS / PASS：真实旧包缓存、回滚、停用状态保留。
Failed Update                 更新失败保留      PASS / PASS / PASS：坏包不替换当前安装。
Stdio MCP                     本地工具服务      PASS / PASS / PASS：真实SDK子进程、独立审批与收尾。
HTTP and SSE MCP              远程工具服务      PASS / PASS / PASS：真实HTTP/SSE服务的列举和调用。
MCP Configuration             工具连接配置      PASS / PASS / PASS：加密变量/请求头、秘密不传渲染层。
OAuth PKCE                    浏览器账户授权    PASS / PASS / PASS：SDK发现、注册、校验、令牌恢复、断开。
OAuth Cancellation            账户授权取消      PASS / PASS / PASS：等待时可取消、回调端口关闭、控件恢复。
App Gateway                   应用账户网关      PASS / PASS / PASS：真实应用ID映射已配置MCP地址；不是私有Apps接入。
Command Hooks                 命令事件钩子      PASS / PASS / PASS：五类事件、命令审批、拒绝不执行。
Hook Process Cleanup          钩子进程收尾      PASS / PASS / PASS：真实shell及后代进程取消/超时后退出。
Catalog Invalidation          目录变更通知      PASS / PASS / PASS：宿主与文件变化通知、界面重新读取。
Desktop Persistence           桌面重启恢复      PASS / PASS / PASS：安装、启停、SQLite及重启往返。
Customization Layout          自定义页面布局    PASS / PASS / PASS：按现有参考图核对52/288侧栏和900px内容轴。
Plugin and Skill Pages        插件技能页面      PASS / PASS / PASS：分类双列、来源、加号/勾、搜索与已安装导航。
Real Management Controls      真实管理操作      PASS / PASS / PASS：添加菜单、市场设置、详情、卸载与草稿保留。
Theme and Narrow Window       主题与窄窗口      PASS / PASS / PASS：真实暗色、800px单列、400px详情无横向溢出。
Version Counterproof          版本缺陷反证      PASS / PASS / PASS：缺陷注入捕获失败，恢复后通过。
Codex App-server Protocol     Codex线协议       FAIL / FAIL / FAIL：使用自己的Electron接口，未实现完整JSON-RPC。
Self-hosted Account Service    自有账户服务      待接入：账号、应用连接与云安装同步接用户自有后端。
Cloud Providers and Sharing   云来源与分享      FAIL / FAIL / FAIL：没有云技能执行器、共享发布服务及其权限后端。
Pixel-perfect All States      全状态像素一致    FAIL / FAIL / FAIL：已有列表参考，缺菜单/详情/暗色的Codex基准图。
Shadow Selection Experiments  技能选择实验      SKIP / SKIP / SKIP：BM25与LRU影子实验不作为默认产品已实现项。
Semantic Drama Output         短剧成片验收      SKIP / SKIP / SKIP：验证了短剧技能加载，未执行真实短剧媒体任务。
```

## 第一轮：源码与生产调用链

沿 `ExtensionsPage → Preload → Main → DesktopExtensions → ExtensionMarketplaces / ExtensionConnections` 和 `Main → prepareExtensions → SDK / ToolRegistry / runTurn` 核对。所有新增模块有 Desktop 生产消费者，没有把插件协议引入 Agent Core（智能体核心）。

修正项目技能连接没有工作目录、旧随包目录覆盖已注册市场版本、检查更新不刷新来源、根无关清单覆盖旧格式、共享图标越过技能子目录被误拒的问题。元数据扫描仍在第二个分隔符后停止；正文只有详情或 `load_skill` 请求时读取。变量只从用户加密配置解析，不从任意模型环境密钥取值；特殊字符或过长的工具标识添加摘要。

第一轮完整门禁为53个文件、587项测试通过。随后补充账户授权取消的界面测试，最终为588项。市场真实检出曾遇到Windows长路径失败，启用Git `core.longpaths` 后实际安装通过。

## 第二轮：真实界面与官方插件安装

对照两张Codex参考图，调整自定义页面的侧栏宽度、内容轴、顶距、搜索宽度、按钮圆角及尺寸、分区、行高、导航图标、安装加号与勾选。保留真实市场内容，插件列表的公开/个人、技能的已安装与项目/系统来源各有实际数据。

用生产Electron点击安装官方Remotion，经过真实下载、清单读取、激活和SQLite记录。安装版本为 `1.0.7`，12项技能可展示、打开详情并读取正文，市场读取错误为空。详情中的建议指令重复展示已修正。

检查浅色列表、添加菜单、市场设置、插件详情、技能正文、暗色插件/技能、800px单列及搜索空结果。最初暗色截图拍在异步加载结束之前，修正脚本为等待真实条目出现后截图，不把加载画面当验收。菜单和详情没有对应Codex参考图，只验证本项目真实行为及视觉一致性，不报告逐像素一致。

截图与原始结果在 `logs/extensions-ui-20261004/`：

- `desktop-public-plugins.png`、`desktop-add-menu.png`、`desktop-marketplace-settings.png`。
- `desktop-remote-plugin-detail.png`、`desktop-public-plugin-skills.png`、`desktop-remote-skill-detail.png`。
- `desktop-public-dark.png`、`desktop-skills-dark.png`、`desktop-skills-narrow-dark.png`、`desktop-skills-empty.png`。
- `desktop-plugins.png`、`desktop-skills.png`、`desktop-plugin-approval.png`、`desktop-extension-result.png`。
- `live-marketplace-result.json`记录实际来源提交、安装版本、技能列表与错误。

## 第三轮：失败、生命周期与反证

真实进程测试确认钩子在拒绝时不执行，在取消或超时时结束shell及后代Node进程。SDK OAuth测试完成发现、注册、授权码校验、加密存储与恢复；取消后本机回调端口不能继续访问。界面测试确认等待授权时取消仍可用，原操作失败后按钮恢复。

临时把市场目录合并改回缺陷版本：旧随包版本覆盖实际来源。对应测试明确失败 `expected 'old' to be undefined`，随后在 `finally` 恢复源文件，再运行同一项通过。反证脚本为 `logs/extensions-ui-20261004/verify-version-authority-counterproof.mjs`，没有保留故障开关。

一次真实Git下载因GitHub直连失败而失败，错误保存在 `live-network-failure.log`；不是功能通过。确认本机代理端口后，一次性设置代理重跑真实安装通过，没有更改持久Git配置或加入自动重试。该失败同时暴露多行进程错误无法剥离IPC包装，已修正并覆盖多行错误测试。

全仓测试曾错误扫描证据目录中下载的第三方插件测试，得到31个非本项目失败套件；53个本项目套件全部通过。已将新下载验证配置移到临时目录，并使 `pnpm test` 排除 `logs/**`，随后完整门禁通过，没有把失败日志替换成通过。

## 最终验证与边界

```text
Command                       中文检查          最终结果
corepack pnpm check           仓库门禁          53个文件、588项测试，19个包架构检查及补丁检查通过。
corepack pnpm desktop:build    桌面构建          主进程、预加载、渲染层构建通过。
corepack pnpm client:web:test  界面全量回归      52项通过，6项重复尺寸或条件用例跳过。
Official Market Verification  官方市场实测      Remotion 1.0.7、12项技能、目录错误为空。
Version Fault Injection       版本缺陷反证      注入失败，恢复后同一测试通过。
```

日志分别为 `check-final.log`、`build-final.log`、`browser-final.log`、`live-round2.log`、`counterproof-version-authority.log` 与 `counterproof-version-restored.log`。跳过项没有作为未实现平台能力的通过证据。

远程MCP与OAuth使用真实本机HTTP服务和生产SDK验证，未用用户的真实第三方账号授权。npm包下载解析已实现，但本轮真实互联网安装验证使用Git来源；本轮未验证npm市场的实际外部下载、SSH凭据、安装包内Git/tar依赖或断电恢复。短剧技能加载与视频测试保护通过，不等于真实短剧成片语义通过。

本次可复查的桌面实现通过；完整客户端对齐仍为需要继续处理的目标。自有服务需要真实后端契约和账号接入，完整应用服务器协议需独立实现及生产消费者；不能由已存在的Electron接口名称近似或公开Git市场替代。

## 自有后端边界澄清后的继续修正

用户明确账号与云服务接自己的后端。只读检查 `D:/Develop/Projects/atlas/backend`，发现普通用户登录、刷新、退出和资料接口，未发现插件安装同步、市场或分享接口；Atlas 是否为本次目标后端仍待用户确认，未修改其源码或猜测部署地址。

源码继续核对发现 SessionStart 曾每轮执行，且其 matcher 错用工具名。已按 Codex `hook_runtime.rs` 的待消费启动来源与 `hooks/src/events/session_start.rs` 的来源匹配修正：新会话首次任务发送 startup，恢复会话首次任务发送 resume；后续轮次不重放启动命令。启动事件在执行前消费，失败或取消后的继续任务也不重放。新增宿主两轮与新会话用例；真实命令钩子用例核对 startup 匹配执行、resume 不匹配不执行及拒绝不执行。该修正不代表云服务或全状态界面验收已完成。

重新初始化 Computer Use（桌面操作工具）仍返回 `Computer Use native pipe is unavailable: failed to connect native pipe`，菜单和详情的 Codex 基准图仍未取得。原有三轮证据保留；没有把本次边界澄清和局部修复冒充完整平台的新三轮验收。

修正后重新执行 `corepack pnpm check`：53个文件、589项测试、19个包架构检查和补丁检查通过；`corepack pnpm desktop:build` 通过。日志为 `logs/extensions-ui-20261004/check-own-backend-followup.log` 与 `build-own-backend-followup.log`。本次没有修改渲染层，没有将前轮截图和浏览器回归描述成新视觉验收。

用户随后明确本阶段只需准备服务端对接文档，实际接入留待后续。已交付 [插件与技能自有后端对接文档](../plugin-backend-integration.md)，并在 README 与架构文档提供入口；现有接口、建议契约和部署待确认信息分别标明。本文原有服务端未实现记录保留为事实，不表示本阶段仍需执行后端开发。

## 撤下默认第三方推荐

用户要求没有实际接通的插件先取消展示。已删除随包官方目录及其生成脚本，移除默认目录加载与自动注册官方市场的安装路径。保留用户主动添加市场的真实目录、安装更新和已有安装；不卸载用户自己的插件。管理页默认进入个人分类，公开分类只显示主动添加市场的条目。内置视频插件、短剧技能和本地文件技能保留。

第一轮核对目录与安装调用链，移除失去生产消费者的随包加载代码；第二轮在真实 Electron 检查默认列表、安装、启停、本地导入及重启恢复，并查看实际截图；第三轮回归未添加市场时只有内置推荐、主动添加市场后可安装、移除来源仍保留安装及原有失败边界。原版本快照反证属于已撤下功能的历史证据，不能作为当前测试。

`corepack pnpm install --frozen-lockfile`、`corepack pnpm check` 和 `corepack pnpm desktop:build` 通过。门禁为53个文件、589项测试及19个包架构检查。相关浏览器与 Electron 用例5项通过、1项重复尺寸的 Electron 往返跳过；执行命令为 `corepack pnpm --filter @agent-desktop/web test:browser tests/browser/extensions.pw.ts tests/browser/desktop-extensions.pw.ts`，没有声称重跑全部浏览器用例。

日志和当前截图位于 `logs/extensions-local-only-20261004/`，包括 `check.log`、`build.log`、`browser.log`、`desktop-default-plugins.png`、`desktop-plugins.png` 和 `desktop-skills.png`。真实模型边界使用既有本机确定性服务；本次没有执行新的真实媒体成片验收。

## 技能详情对照复核（2026-10-04）

本轮按 Codex 技能截图完成三次范围核对：

```text
Review                      核对内容                                      结果
源码与契约                  单列技能行、SkillDialog、readSkill、文件操作和试用草稿  PASS
真实界面与行为              Electron 技能行、正文弹窗、三点菜单、400px 窄窗和 Escape    PASS
失败与回归                  文件出口错误、启停禁用、未自动发送、全量门禁和重启回归       PASS
```

真实截图保存在 `logs/skill-details-20261004/`：`desktop-plugin-skills.png`、`desktop-skill-dialog.png`、`desktop-skill-menu.png`。自动化证据为 `check-final.log`、`build.log`、`browser-shared-final.log` 和 `browser-desktop-final3.log`。独立技能卸载仍通过弹窗菜单确认，插件附带技能继续随插件管理。

## 插件详情上下部参考对照（2026-10-04）

用户提供顶部与底部两张 Codex 插件详情截图，明确删除钩子区块。已调整图标在上、标题和操作同行、简述、蓝紫建议指令区域、正文介绍、单列技能和逐行信息。卸载从三点菜单发起并保留确认；网站链接仅在清单确有地址时展示，不复制第三方品牌、链接或云分享功能。宿主钩子执行逻辑未删除。

第一轮核对源码与契约：界面读取真实清单字段和技能元数据，建议指令点击复用现有草稿处理，不自动提交任务；单位测试以 `hasHooks: true` 的插件确认详情无钩子提示。第二轮核对真实渲染：查看 Electron 顶部、菜单和底部截图，以及共享客户端暗色与 400px 窄窗截图，未见遮挡或横向溢出。第三轮核对交互与回归：验证完整建议指令和旧草稿同时保留、卸载确认与取消、菜单 Escape、技能弹窗、安装启停、重启、文件通知与本地 MCP 调用。三轮范围核对均通过，不表示整个 Codex 产品的所有状态达到像素一致。

`corepack pnpm check` 通过：53个测试文件、590项测试、19个包架构检查与补丁检查；`corepack pnpm desktop:build` 通过。相关浏览器与 Electron 回归9项通过，1项重复尺寸的 Electron 用例跳过。证据在 `logs/plugin-details-ui-20261004/` 的 `check-final.log`、`build-final.log`、`browser-final.log`、`desktop-plugin-detail-top.png`、`desktop-plugin-detail-menu.png`、`desktop-plugin-detail-info.png`、`plugin-detail-dark.png` 与 `plugin-detail-narrow-installed.png`。改动仍在功能分支的工作树中，未提交或合并。
