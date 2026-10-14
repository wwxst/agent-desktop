# 第五阶段 C3：最终安装版媒体插件验收

2026-10-12 使用真实隔离安装程序与各自全新配置，顺序验证三个独立媒体插件。生产快照为 `8a4d35f`，最终 NSIS 安装器 SHA-256 为 `19b8e32fe7c3dccd6e3a5830994a2b79738c296a0f4635b37d0c252e8fe949f2`。实际启动 `logs/phase5-integration/最终 安装 验收/Agent Desktop.exe`，不启动开发构建冒充安装版。

```text
FFmpeg                    媒体处理资源      提供真实视频、音频及帧处理进程。
Whisper                   本地语音引擎      使用锁定 whisper.cpp 程序和本地模型转录。
Vision                    图片理解插件      经配置的图片协议发送受批准的图像。
Probe                     媒体探测工具      从实际媒体文件读取编码、时长和尺寸。
NSIS Installer            安装程序          安装随包程序与插件资源到隔离目录。
SHA-256                   文件摘要          确认下载资产和准确安装资源的字节身份。
Local Protocol Fixture    本机协议夹具      只替换模型网络响应，提供确定性编排验证。
Installer Overwrite       覆盖安装          在已有程序目录再次实际安装同一候选。
Chat Completions          对话补全协议      以消息列表传递模型请求与图片内容。
Responses                 模型响应协议      以输入项传递图片请求并读取响应结果。
SQLite                    本地数据库        保存会话、设置和插件安装事实。
```

安装器、程序、主进程、预加载及三个插件程序清单见 `logs/phase5-plugin-acceptance-20261012/final-acceptance-preparation.json`。通用 Electron 运行器的摘要与旧包相同，不能用它独自识别版本；最终主进程摘要为 `15cc03f679511c9e1697646fcdd8dcc81c9949a2d3aa6007d3c8416c302d3279`。专测使用独立端口 `4174`，与根完整浏览器回归的 `4173` 分开；没有调大下载时限或改变生产源码。

## 最终安装版结果

Whisper 专测一项通过，耗时 4.4 分钟。证据为 `logs/whisper-plugin/installed-1791810635560/`，命令输出为 `logs/phase5-plugin-acceptance-20261012/installed-whisper-final-console.log`。真实官方运行归档下载、解包、五项锁定资源验证和程序加载均执行；此前 `Release` 到 `runtime` 发布失败的生产边界在本轮真实通过。中文、英文、中英混合合成语音及时间戳、空文件、损坏文件、静音、FFmpeg 音轨提取、技能加载、超过 260 字符路径、模型字节损坏检测和恢复、语义视频发布均通过。407.1 秒合成音频耗时 86050 毫秒，峰值工作集 1090723840 字节；不扩大为一小时音频或真人语音质量结论。

Whisper 取消时子进程 `3356` 退出，最后活动为 `cancelled`，界面恢复发送；执行中的模型删除与插件更新受到维护门禁约束。停用后语音工具不注册，语义候选因缺少语音证据阻断；卸载保留模型，重装恢复。损坏升级明确失败并保留 `1.0.0`，正常升级为 `1.0.1` 后实际识别成功，回滚 `1.0.0` 后再次识别及重启均通过。详细结果为 `cancel.json`、`version-lifecycle.json` 和 `summary.json`。

Vision 专测一项通过，耗时 2.5 分钟。证据为 `logs/vision-plugin/installed-1791810964834/`，命令输出为 `logs/phase5-plugin-acceptance-20261012/installed-vision-final-console.log`。Chat Completions 与 Responses 两种本机协议均真实经过插件、审批和上传；未授权路径、拒绝上传、缺少模型或密钥、畸形响应均按实际边界拒绝。取消子进程 `28832` 退出，上传请求取消。停用、停用后重启、启用、启用后重启、卸载重装和重启均执行；坏升级保留旧版，`1.0.1` 更新、`1.0.0` 回滚及重启后实际图片调用通过。`requests.json` 中夹具错误为空，`FFmpeg + Vision` 和 `Skill + FFmpeg + Vision + Whisper` 两条完整组合链均为 `PASS`；第二条使用新配置真实安装 Whisper 运行资源。

Probe 主专测一项通过，耗时 3.8 分钟；当时另外两项需要覆盖安装条件，如实跳过，随后真实覆盖后两项均通过。证据为 `logs/ffmpeg-plugin/installed-1791811182006/`，命令输出为 `logs/phase5-plugin-acceptance-20261012/installed-probe-final-console.log`。未授权路径、目录联接和网络 URL 在插件工具审批前拒绝，用户拒绝、取消和执行中维护禁止通过；取消子进程 `24764` 退出。停用后语义候选不能发布，停用后重启、启用、卸载、重装、`1.0.1` 更新、`1.0.0` 回滚和重启后真实探测均通过。官方 FFmpeg 归档网络下载曾短暂停滞，但在原有 300 秒下载时限内恢复，完整锁定归档为 109728040 字节，没有预置该归档。

Probe 还执行两个真实语义发布链，上传共六帧。第二个产物已经落盘后，让模型请求返回 HTTP 400；实际界面显示失败，但真实文件、已交付卡片、逐项交付、恢复的失败任务事实以及“打开文件”和“继续”入口全部保留。原始证据为 `failure-after-publish.json` 与截图 `failure-after-publish.png`，第二个真实输出为 `attachments/中文 video-edited-2.mp4`。

已实际查看最终 Whisper 的 `model-ready-narrow.png`、Vision 的 `restart.png` 和 Probe 的 `failure-after-publish.png`。窄页模型状态与删除按钮清楚可见，内容使用正常垂直滚动；重启历史正常展示；发布后失败页同时显示失败原因、已交付结果、产物卡和打开按钮，没有关键内容遮挡。截图检查仅证明这些实际状态，不扩大为全部界面验收。

## 模型与外部服务限制

最终 Whisper 与 Vision 配置只预置此前实际下载并核验的单个模型资产，不复制旧配置、SQLite、安装目录或会话。模型为 487601967 字节，SHA-256 为 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`，Whisper 专测结束后再次核对相同摘要。最终 Whisper `summary.json` 明确标记本轮模型下载 `SKIP`，缺少模型与恢复后注册两项为 `PASS`。实际网络模型下载证据在旧安装器 `a1993404…` 的 `logs/whisper-plugin/installed-1791809147151/`；最终安装版没有重复执行该下载，不将旧包下载通过改写为最终包下载通过。

最终与旧包的 Whisper 插件程序摘要均为 `6d09178b93584c487aa97064ddf46e0999dd050936b160079b851a575fb1b6e0`。此前实际下载可证明锁定模型资产来源，本轮结论仍只声称最终包使用该已核验模型执行真实识别。系统合成语音为本机 Huihui/Zira 参考素材。模型编排和云视觉请求均使用本机协议夹具；未验证真实云服务、账号或云模型理解质量。

## 覆盖安装与保留的失败证据

三个主专测完成后，实际为 Probe 专项配置安装 Whisper 与视频编辑技能，并仅复制锁定模型。冻结配置为 `logs/ffmpeg-plugin/installed-1791811182006/用户 数据`，已包含三个独立插件、视频编辑技能、多轮会话、真实产物、`restart-enabled` 历史和中文视频附件。准备记录为 `logs/phase5-plugin-acceptance-20261012/final-overwrite-profile-preparation.json`。配置冻结后由根保护脚本执行同目录真实安装覆盖，退出码为 0。`logs/phase5-integration/installer-protection-1791811592829/result.json` 明确 `pass: true`、`overwrite: true` 及相同最终安装器摘要；原安装的 8120 个文件不变，注册项与快捷方式已恢复。

实际覆盖后，指定这份已有配置执行两个安装专属用例，两项通过、耗时 9.6 秒，输出为 `logs/phase5-plugin-acceptance-20261012/installed-only-final-console.log`。第一项启动真实安装版，确认启用的 FFmpeg `1.0.0`、`restart-enabled` 回复及中文视频附件保留。第二项临时提供随包 `1.0.1` 清单，在真实插件详情操作检查更新、确认更新版本、查看历史版本并点击 `1.0.0` 回滚，窄窗再确认更新按钮可见；该项没有点击执行 `1.0.1` 更新。实际升级与升级后的真实探测由上面的 Probe 主专项覆盖；随包清单在 `finally` 中恢复原文。三个插件主专测和两个覆盖安装专测合计五项实际通过，没有把前一轮条件跳过计为通过。

所有专测结束后再次核对五个主要程序文件与三个插件清单，清单均恢复 `1.0.0` 且与仓库资源逐字节相同；还按最新准确旧版本升级专项的清单核对全部 31 个应用资源，体积和 SHA-256 全部匹配。清单按 `JSON.stringify` 序列化内容的摘要为 `aaeb28718389b0e1eb5908076547efceaa736674843b11f38ea14a6a0f974587`。完整结果及逐文件摘要保存在 `logs/phase5-plugin-acceptance-20261012/final-acceptance-manifest.json`。覆盖后安装目录的额外文件仅为真实执行产生的 `logs/agent-trace.jsonl`，未参与应用资源身份判断。

旧安装版 Whisper 通过只能归属于 `a1993404…`；旧安装版 Vision 总体失败，不能用它已完成的单条组合链掩盖 Whisper 安装 `EPERM`。旧全回归和旧安装版两次同边界失败、45 次隔离诊断无法确定句柄来源，以及复用既有有限目录发布函数的最小修正，见 [Whisper 目录发布修正](phase5-c3-whisper-install-20261012.md)。安全桥取消错误身份与发布后失败保留产物的修正见 [任务安全桥记录](phase5-c3-task-bridge-20261012.md)。本次完整候选历史见 `logs/phase5-plugin-acceptance-20261012/acceptance-before-repackage.json`；失败日志保留，不混用为最终通过证据。

开发版已有三个主专测通过，其安装版专属分支均如实跳过，模型下载采用预置锁定资产。开发证据分别为 `logs/vision-plugin/electron-1791805928096/`、`logs/whisper-plugin/electron-1791807561854/` 与 `logs/ffmpeg-plugin/electron-1791808581991/`；最终安装版的三套结果按上述新身份单独记录。此报告不授权合并主分支或发布。
