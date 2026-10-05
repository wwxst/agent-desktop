# 插件与技能自有后端对接文档

日期：2026-10-04。用途：交给后续客户端和后端开发人员实施接入。

用户已明确：客户端界面和插件、技能机制参考 Codex，服务端对接自己的系统；本阶段只交付对接文档，实际接入以后实施。本文中“现有”指已核对源码的能力，“建议契约”指尚未实现的接口设计。本文不代表已完成服务部署、账号联调或云同步验收。

当前架构以 [架构文档](architecture.md) 为准，视觉行为以 [桌面界面基线](desktop-ui.md) 为准，历史实现证据见 [三轮核对记录](acceptance/codex-extensions-three-reviews-20261004.md)。

## 1. 对接范围与职责

```text
English term                中文名称          说明
Plugin                      插件包            承载技能、工具服务、应用连接或命令钩子。
Skill                       任务技能          SKILL.md 元数据与按需读取的操作指令。
Marketplace                 插件市场          提供可浏览、搜索和安装的插件目录。
Account Sync                账号同步          保存账户选择的安装版本与启停状态。
Reconcile                   状态同步          将账户记录应用到当前设备并返回逐项结果。
Share                       插件分享          上传插件并管理访问范围和读写权限。
MCP                         工具通信协议      连接实际工具服务，沿用 SDK 与审批路径。
OAuth                       账户授权协议      授权工具服务访问外部账户，独立于客户端登录。
IPC                         本机进程通信      在渲染层与桌面主进程之间传递请求和结果。
JSON-RPC                    结构化调用协议    Codex 应用服务器的请求与通知格式。
```

职责分配：

- 自有后端负责用户身份、可访问的远程目录、版本及包下载、账户安装记录、插件分享与权限。云技能来源和账户工具网关在需要提供时纳入同一接入范围。
- 桌面主进程负责网络请求、令牌保管、包下载与本地校验、暂存安装、版本替换、回滚、工具连接与审批，以及本机真实安装结果。
- 渲染层展示主进程返回的账户、目录和操作状态；点击安装不直接产生“已安装”事实，云端有安装记录也不等于本机已安装。
- 智能体核心保持通用；账号、市场和分享协议不进入核心或智能体循环。

第三方 MCP 授权、模型供应商密钥、客户端自身账户登录分别管理，不能互相替代。插件内已有技能随插件安装；项目 `.agents/skills` 和用户单独导入技能仍由本地来源管理。

## 2. 已有客户端及实际接入位置

已实现本地与 Git 市场、插件和独立技能导入、安装、启停、更新、回滚、卸载、递归技能发现、正文按需加载、stdio/HTTP/SSE 工具连接、浏览器授权和命令钩子。未实现自身账户登录、私有 HTTP 市场、云安装同步和分享发布。

后续接入沿现有生产链路推进：

```text
ExtensionsPage              管理界面          展示目录、详情与操作状态。
ExtensionClientApi          客户端接口        以已有 list、install、manage 等请求宿主。
Preload                     预加载桥接        显式暴露允许的本机通信调用。
Desktop Main                桌面主进程        请求自有后端并控制本机安装与运行。
DesktopExtensions           本地扩展存储      维护安装文件、版本、启停与技能发现。
ExtensionMarketplaces       市场来源          维护来源并获取实际插件文件。
ExtensionConnections        工具授权          保存加密连接配置与工具授权令牌。
```

对应源码：

- `packages/client/src/components/ExtensionsPage.tsx`：插件与技能界面。
- `packages/client/src/api.ts`：`ExtensionItem`、`ExtensionSnapshot`、`ExtensionClientApi` 和管理请求类型。
- `apps/desktop/src/preload/api.ts`、`apps/desktop/src/shared/ipc.ts`：预加载桥接和通信通道。
- `apps/desktop/src/main/index.ts`：宿主请求处理、任务期修改限制、扩展变化通知。
- `apps/desktop/src/main/extensions.ts`：本机安装与版本管理。
- `apps/desktop/src/main/extension-marketplaces.ts`：目录来源和插件包物化。
- `apps/desktop/src/main/extension-connections.ts`：现有工具连接秘密的加密存储与授权。
- `apps/desktop/src/main/runtime-settings.ts`：当前设置入口；尚无自有后端地址或自身账户配置。
- `apps/desktop/src/main/desktop-database.ts`：主进程 SQLite 存储。

现有 `desktop:reconcile-extensions` 同步本机内置资源并刷新来源，不能直接命名为“云同步已完成”。后续应明确区分目录刷新、本机内置资源同步和账户安装状态同步。

目前市场安装器支持本地目录、Git 来源和 npm 包；`source: "url"` 表示 Git 仓库地址，**不能用于任意 ZIP 下载地址**。后端直接返回私有压缩包时，必须新增实际下载、校验、解包和安装路径，接入现有暂存安装逻辑。

## 3. 候选账号服务：Atlas 的现有契约

已核对 `D:/Develop/Projects/atlas/backend` 的源码。它是可复用的候选账号服务，但尚未被指定为最终部署后端；本文不给它写入新接口，也不预设生产地址。

普通用户接口已有：

- `POST /api/user/auth/login`：密码或验证码登录。
- `POST /api/user/auth/refresh`：刷新访问令牌。
- `POST /api/user/auth/logout`：携带访问令牌退出当前会话。
- `GET /api/user/me`：携带访问令牌读取个人资料。

密码登录请求示例：

```json
{
  "target": "user@example.com",
  "targetType": "EMAIL",
  "password": "<用户输入的密码>"
}
```

`targetType` 为 `EMAIL` 或 `PHONE`；密码登录提供 `password`，验证码登录提供 `code`，两者只能选一个。验证码登录还需要已有发送验证码接口，其具体场景字段以 Atlas API 文档和源码为准。

登录响应：

```json
{
  "code": 200,
  "msg": null,
  "data": {
    "accessToken": "<访问令牌>",
    "refreshToken": "<刷新令牌>"
  }
}
```

刷新请求为 `{"refreshToken":"<刷新令牌>"}`，成功 `data` 只有新的 `accessToken`；现有 Atlas 刷新令牌在同一会话生命周期内不轮换。业务请求使用 `Authorization: Bearer <accessToken>`。资料响应包含 `id`、`userNo`、`nickname`、`avatar`、联系方式与状态等；客户端只展示实际需要的字段。

统一响应为 `{code,msg,data}`，`code === 200` 才表示业务成功，还须核对 HTTP 状态。退出等成功操作允许 `data: null`；目录、详情等查询成功时必须有对应数据。不能把 HTTP 200 中的业务失败或查询数据缺失当成成功。

待实施的客户端约定：账户令牌由主进程用 Electron `safeStorage` 加密后保存。渲染层只接收资料和登录状态，日志不记录密码、访问令牌或刷新令牌。认证过期后的读取请求可在成功刷新后重发一次；上传、发布等写操作结果不明时先查询实际结果，不盲目重放。

实施前核对 Atlas 的 `UserAuthController.java`、`UserLoginDTO.java`、`TokenPairVO.java`、`AccessTokenVO.java`、`UserProfileController.java` 和 `common/result/Result.java`。若选用其他后端，只替换账户接入契约，下面的插件业务职责仍适用。

## 4. 远程市场与插件版本：建议契约，尚未实现

以下路径建议挂在 `/api/user/plugin-platform` 下，复用普通用户身份；公开目录可按部署策略允许匿名读取。路径与字段应由双方在实施前确认，并以最终接口文档为准。

- `GET /marketplaces`：返回账户可访问的市场 `items`，每项含 `id`、`name`；权限由后端根据当前账户判定。
- `GET /plugins?marketplaceId=...&query=...&cursor=...&limit=...`：返回 `{items,nextCursor}`。首请求省略游标，末页 `nextCursor: null`。每项含稳定的 `remotePluginId`、`marketplaceId`、技术名称 `name`、`version`、`description` 和展示 `interface`。搜索为空返回当前可见目录。
- `GET /plugins/{remotePluginId}`：返回同一身份的完整描述、作者、技能摘要、工具和钩子声明、版本及实际可执行权限。详情本身不需要返回全部技能正文。
- `GET /plugins/{remotePluginId}/versions`：返回可访问的版本列表；版本身份一经发布，其对应包内容不可原地改变。
- `GET /plugins/{remotePluginId}/versions/{version}/package`：鉴权后返回下载描述 `{url,sha256,sizeBytes,expiresAt,format,rootPath}`。`format` 首版约定 `zip`，`rootPath` 为包内插件根目录；空串表示压缩包根目录。链接短期有效，摘要对应完整下载字节。
- `GET /plugins/{remotePluginId}/skills/{skillName}?version=...`：按版本返回 `{name,contents}`，只在详情或明确读取时请求正文。不存在或无权访问必须返回错误。

目录项示例，所有域名均为占位示例：

```json
{
  "remotePluginId": "p_001",
  "marketplaceId": "own-market",
  "name": "short-drama-editing",
  "version": "1.0.0",
  "description": "按任务要求剪辑短剧",
  "interface": {
    "displayName": "短剧剪辑",
    "developerName": "作者名称",
    "category": "Creativity",
    "logoUrl": "https://assets.example.invalid/p_001/logo.png",
    "screenshotUrls": [],
    "defaultPrompt": ["剪辑一段突出冲突的短剧片段"]
  }
}
```

`interface` 的建议字段沿用 Codex 展示语义，包括 `displayName`、`shortDescription`、`longDescription`、`developerName`、`category`、`capabilities`、`websiteUrl`、`privacyPolicyUrl`、`termsOfServiceUrl`、`defaultPrompt`、`brandColor`、远程图标和截图 URL。宿主映射到现有 `ExtensionItem`，例如 `defaultPrompt` 数组对应本项目 `defaultPrompts`。

当前渲染层不直接连接外部服务。远程图片应由宿主获取并转为已有支持的图片数据，或在实施时明确调整资源策略；不能仅返回 URL 就假定现有界面能加载。

`remotePluginId` 是服务端身份，现有本地安装标识如 `plugin:名字@市场` 是本机身份，二者分别保留明确映射，不通过显示名称猜身份。目录项的最新版本与本机实际版本分别展示，云端不得返回客户端本地绝对路径。

包内保留现有 `.codex-plugin/plugin.json` 或标准根 `plugin.json`、`skills/**/SKILL.md`、实际工具配置、脚本及图片。私有包下载逐次鉴权，临时下载地址不作为永久安装来源保存。

## 5. 账户安装同步：建议契约，尚未实现

账户记录表示用户选择的插件、版本和启停状态，本机数据库表示当前设备的实际文件和状态，两者不能混为同一个字段。

- `GET /installs`：返回当前账户的安装选择列表，每项含 `remotePluginId`、`version`、`enabled`、`updatedAt`。
- `PUT /installs/{remotePluginId}`：请求 `{version,enabled}`，新增或替换该账户的选择，返回保存后的记录。重复保存相同选择应得到相同业务状态。
- `DELETE /installs/{remotePluginId}`：删除该账户选择；不删除市场插件包、不代替分享删除。

建议首版以显式“同步”操作落地，不提前实现后台推送或设备协调系统。登录后获取账户记录并展示差异，用户执行同步时下载、安装、替换和启停，逐项报告结果。任务期间继续禁止修改扩展。

本机操作完成后再写账户记录；若云端保存失败，保留本机实际成功结果，展示“账户同步失败”并提供再次同步动作。不得回报完整同步成功，也不得把本机已经安装的插件伪装成未安装。

从账户记录应用到设备时，只有具有本账户远程身份映射的云管理插件参与删除比较。未关联的本地导入、内置插件、项目技能和独立技能不因账户列表缺少记录而卸载。切换账户不把旧账户记录上传给新账户；任何本机删除先展示范围并经用户确认。

同步的宿主结果应返回逐项成功与失败，例如 `{changed:[本机标识],failed:[{remotePluginId,message}]}`，成功项不因其他项失败被隐藏。云记录更新不直接触发插件命令；工具和钩子执行继续遵守现有审批。

独立技能的云发布、启停同步尚无本项目契约。如果需要完整覆盖，应单独确定技能包身份与安装记录，不用插件附带技能名冒充独立云技能身份；正文下载仍保持按需读取。

## 6. 插件分享与发布：建议契约，尚未实现

对齐 Codex 的保存、更新分享目标、列举、检出和删除行为，但数据保存在自有服务。

- `POST /shares`：以 `multipart/form-data` 上传 `package` ZIP 文件和 `metadata` JSON 文本。元数据含 `name`、`version`、`discoverability`、`shareTargets`。创建成功返回 `{remotePluginId,version,shareUrl}`。
- `PUT /shares/{remotePluginId}`：上传新版本，格式同上；只允许作者或被授权编辑者更新，已有版本内容不能覆盖。
- `PATCH /shares/{remotePluginId}/targets`：请求 `{discoverability,shareTargets}`，替换访问范围与授权目标，返回最终实际权限。
- `GET /shares?cursor=...&limit=...`：返回当前账户有权管理的 `{items,nextCursor}`，每项含插件摘要、分享地址及当前账户权限。
- `GET /shares/{remotePluginId}/checkout?version=...`：返回可访问的下载描述和插件身份；宿主下载安装到本机后才返回本机检出路径。
- `DELETE /shares/{remotePluginId}`：由所有者删除共享发布记录，使后续读取与下载失败。其他设备已安装的本地副本不由该 HTTP 请求直接删除。

访问范围及角色采用 Codex 的实际名称：

```text
LISTED                      目录可发现        有权访问者可在目录中发现；不是自动向公网开放。
UNLISTED                    链接可发现        从目录隐藏，但链接读取仍按权限检查。
PRIVATE                     私有分享          只允许所有者和明确授权的对象访问。
reader                      读取角色          可查看和下载，无发布或权限修改能力。
editor                      编辑角色          可更新包，不能自动获得所有者的管理权限。
owner                       所有者角色        负责删除和授权管理，由服务器确定。
```

授权目标格式为 `{principalType,principalId,role}`，用户目标使用 `principalType: "user"`，`role` 只能是 `reader` 或 `editor`。`owner` 不允许客户端自行授予。Codex 还支持 `group` 和 `workspace`；如果自有后端没有真实组织模型，先明确返回不支持，不创建虚构组织或默认授予权限。

分享 URL 的页面或桌面打开方式由自有部署提供；本文不预设域名。共享包从用户明确选择的插件根目录创建，只打包声明资源，不上传账户令牌、连接配置或整个项目。后端检查实际包与清单，不信任客户端声称的作者和权限，也不在接收上传时执行插件脚本。

## 7. 工具账户网关与云技能

已有 `.app.json` 应用 ID 可映射真实网关 MCP 地址。若后续提供自有网关，建议增加 `GET /apps` 返回当前账户可使用的 `{id,name,mcpUrl,transport,connected}`；`transport` 为 `http` 或 `sse`。可用状态应来自真实授权，不能只因安装插件而标为已连接。

网关须实际提供 MCP 工具列表与调用，并根据账户检查应用访问权。若使用 OAuth，需提供 SDK 可发现的受保护资源/授权服务器元数据与真实授权、令牌接口，满足 PKCE 授权码流程；动态注册是否支持由双方确认。Atlas 的密码登录接口本身不是 MCP OAuth 授权服务器，不应直接代换。

需要云技能时，先确认交付的是远程指令还是远程执行能力。指令可走市场元数据和按需正文；远程执行应由实际 MCP 工具服务提供输入、结果和权限，复用现有连接及审批链路。没有真实执行服务时，不展示“云技能执行器已接入”。

## 8. Codex 协议映射与客户端改动

Codex 应用服务器协议与自有后端 HTTP 接口是两层契约。后端无需部署 OpenAI 服务器；若要完整兼容 Codex 的本机协议，须在宿主提供真实适配，并由客户端消费。

- `skills/list`、`skills/config/write`、`skills/extraRoots/set`、`skills/changed`：本机技能目录、配置与失效通知。公开源码没有独立 `skills/read` 方法；本项目 `readSkill` 不应误标为其线协议。
- `marketplace/add`、`marketplace/remove`、`marketplace/upgrade`：映射本机来源管理；远程可见市场由自有目录接口提供。
- `plugin/list`、`plugin/search`、`plugin/read`、`plugin/skill/read`：由宿主合并本机事实和远程目录/正文。`plugin/search` 在参考源码标为实验功能。
- `plugin/installed`、`plugin/install`、`plugin/uninstall`：查询或操作当前设备实际安装，成功后按约定更新账户记录。
- `plugin/reconcile`：账户状态与当前设备同步，不能用刷新 Git 目录冒充。
- `plugin/share/save`、`plugin/share/updateTargets`、`plugin/share/list`、`plugin/share/checkout`、`plugin/share/delete`：映射上一节的自有分享接口；上传与下载由宿主处理。

参考源码为 `D:/Develop/Projects/codex-cli/codex-rs/app-server-protocol/src/protocol/common.rs` 与 `protocol/v2/plugin.rs`，本次参考提交 `75ec81c8623c0ca50b129de5a82521a23d37b726`。后续复用时重新核对版本，不把本文的 HTTP 建议字段当作 Codex 原始线协议。

实施顺序：先接账户和地址配置，再接目录、详情与下载，随后接安装同步、分享权限，最后按实际服务接应用网关和云技能。每步新增字段与接口同时提供真实管理页消费者；账户界面、分享入口和同步状态接通后再展示。

## 9. 错误语义和后端部署交接

新接口建议复用 `{code,msg,data}`。必须保留 HTTP 和业务失败信息，至少区分未登录、无权限、资源不存在、版本冲突与服务异常。权限由服务端读取当前令牌身份，不接受客户端提交的 `ownerId` 或 `userId` 作为授权依据。

目录不可达不抹掉本机已安装列表；下载中断、摘要不符、包结构无效和版本不存在均不得激活新版本。临时下载链接过期需重新获取链接，不将其作为永久 URL。取消、拒绝授权和工具连接失败展示真实终态，秘密不进入详情正文或日志。

后续开发开始前，负责方提供：

1. 最终后端仓库和联调/生产基础地址；若采用 Atlas，说明复用的用户身份及测试账号获取方式。
2. 最终接口文档：请求、响应、业务错误码、分页、版本规则和授权范围。
3. 插件包存储、下载地址有效期、包体上限、允许格式与摘要规则。
4. 分享链接部署方式，公开/私有目录边界，是否真的有群组和工作区。
5. 应用网关的真实 MCP 地址与授权方式；是否提供独立云技能或远程执行。

正式环境使用 HTTPS，本地联调地址另行约定。桌面主进程直接请求服务，不能把浏览器跨域配置作为桌面接入已完成的证据；如同时支持网页宿主，再独立明确网页认证与跨域策略。

## 10. 接入验收与三轮核对

按原要求在真实接入后做三轮核对，保存实际请求、脱敏结果、本机状态及截图；仅单元测试通过不代表接入完成。

第一轮核对契约和源码：登录/刷新响应、本机与远程身份映射、不可变版本、包字段、分享权限、调用链及核心边界。

第二轮核对真实成功链路：使用自己的测试后端完成登录、市场浏览与搜索、详情和技能正文、下载安装及重启恢复、更新与回滚、跨设备显式同步、上传分享、授权对象检出以及删除分享。

第三轮核对失败及回归：未登录、过期令牌、刷新失败、无权限、下载中断、摘要错误、无效包、取消、部分同步失败、账户切换和旧版本保留；同时回归现有视频插件与普通任务行为。

界面按 [桌面界面基线](desktop-ui.md) 的真实状态检查。Codex 菜单、详情等没有基准截图的状态仍需补齐参考并实际对照，服务端对接文档不替代 1:1 视觉验收。

代码修改后的基础验证使用 `corepack pnpm check`、`corepack pnpm desktop:build`，涉及渲染层时补充 `corepack pnpm client:web:test` 和真实 Electron 界面检查。若修改 Atlas，另遵守其 `AGENTS.md` 的后端检查与审查要求。

交付时分别说明接口已实现、客户端已接通、真实联调已通过和视觉验收已通过的范围；所有待接入项保留明确状态。
