# 第五阶段正式集成验收报告

候选为 `codex/phase5-integration`，工作树为 `C:/Users/ww/.codex/worktrees/phase5-integration/agent-desktop`。结论：**候选工程实施完成，外部验证仍阻塞 main 合并。** 真实云 Vision 和 Responses 缺少获授权测试凭据，均为 `SKIP`，不能宣称全部集成门禁通过。

2026-10-14 规范收口说明：本文记录 2026-10-12 已执行的历史验收事实，十五项交付及第七节后续方案不重新定义当前要求。最新开发与验收标准以根 [`AGENTS.md`](../../AGENTS.md) 和 [工程规范](../engineering.md) 为准；旧 SQLite 升级、旧配置读取、匹配旧程序的数据回滚不再作为默认门禁。原 C3 证据保留，真实云 Vision 与 Responses 的 `SKIP` 阻塞继续有效；后续合并还须审查已经前进的 `main` 增量。

本轮没有修改、合并或推送 `main`，没有创建合并请求、发布或标签。原分支、工作树、快照和用户未跟踪内容保留。

```text
Integration Candidate       集成候选          保留通用核心与三插件双方历史的独立分支。
PASS                        已通过            有准确源码和实际运行证据。
FAIL                        已失败            原始失败保留，修复后另记复测。
SKIP                        未执行            当前条件不足，不能计为通过。
Main Merge Gate             主分支合并门禁    外部供应商验收完成后才能进行最终合并审查。
Profile Rollback            配置匹配回滚      恢复旧程序及完整旧配置，包含数据库与系统密钥。
Protocol Fixture            协议夹具          代替网络响应，不证明真实云模型理解质量。
Execution Checkpoint        执行检查点        外部副作用开始前必须保存的准确调用事实。
Unknown Outcome             未知执行结果      已开始但效果未确认的操作必须先核验。
```

用户要求的十五项交付按以下索引复核：

1. 候选分支与准确 HEAD：第一节，以及最终交付消息。
2. 全部本轮提交与合并摘要：第一节第一父链及完整查询命令。
3. 原始六文件冲突及新增冲突：第二节、M1 集成记录。
4. 两项 SQLite 缺陷复现与修复：第二节、C1 持久化报告。
5. D4 契约兼容：第二节、第二轮安全审查与安装版 Core 报告。
6. Windows CI 根因与修复结果：第三节、命令与 CI 报告。
7. 三插件完整性：第五节、最终三插件报告。
8. 全量测试数量与结果：第四节、最终日志。
9. 旧 SQLite 数据升级及匹配回滚：第五节、C3 升级与回滚报告。
10. Windows 安装器 SHA-256：第五节。
11. 三轮审查：第六节及三份独立范围报告。
12. 真实云 Vision 与 Responses 状态：第六节。
13. P0/P1 未解决问题：第六节。
14. main 合并门禁最终结论：开头与第六节。
15. 后续 main 合并及回滚方案：第七节。

## 一、固定身份、祖先与提交清单

最终再次获取远端后，`main` 仍为 `49b8da974cc963f7068abb04423bed9628a8f6ae`，集成起点仍为 `7654b25f1ae3a843ceffd0d140aec4b33a55f804`，Vision 来源仍为 `f2533a9cfea2407a1f5a1e066fcb59b2c737d65a`。三项均为候选祖先。M1 的两个父提交分别为 `8513b9e30959b07daf023d313e2264093781593b` 和完整 Vision 来源；只合入该来源一次，没有整文件覆盖或重写已推送历史。

最后生产行为提交为 `8a4d35f393f500733cfc34c8839861ace50314ae`，最后持续集成配置提交为 `f32568788b6da470d20429588579ce1ff1e69f78`，最后验收测试提交为 `1edd57cf4d66170c203952c3621a28ab519ae8e8`。后续报告提交不改变生产或测试行为。报告所在的最终完整 HEAD 使用 `git rev-parse HEAD` 获取，交付消息及 `logs/phase5-integration/final-delivery.json` 给出准确身份与对应远端结果，避免伪造文档自身提交摘要。

本轮第一父链上的提交如下；来源分支全部原历史由双父合并保留：

```text
b9833cb91e0d9a3f52bf2c074c80ae032abb4aa8  C1 原子持久化与版本化任务起点。
8513b9e30959b07daf023d313e2264093781593b  迁入两份快照的九项有效安全反证。
82f8b8dca7f87eb7d1f91633a36a4a6831e69dc4  M1 双父合并 Vision 与执行安全契约。
04720e2e8ced26747e731a62951f4db4433fc802  命令测试等待进程终止后再清理目录。
cb0d8345884b2ef653a3f9b81ad811c31b679bfe  活动取消按完整调用身份匹配。
df94e7a087a98a9b5a0bd75292b08abc6b169377  Node 测试隔离未消费的 Electron 下载入口。
c18cb37a733c53ff075f3fc6ff9aa3af1e5bb431  Windows 主密钥实际落盘与等待期设置覆盖修复。
cb488e9bf485c9f64e58ad054a25b05da115d092  更新已过时的界面和插件列表测试预期。
3648715667a74b033883c86fb91b057e4a6fa7e8  安全桥准确传递任务失败、取消与产物。
2afd0e668c8a888d079d31621a617808151a0c49  真实冷配置及完整媒体链等待，保持安全断言。
219ba246fb609dcd05b441d15cd9d09fa22e1461  Windows 短路径目录监视前解析真实路径。
8a4d35f393f500733cfc34c8839861ace50314ae  Whisper 目录发布复用已验证的 Windows 改名函数。
f32568788b6da470d20429588579ce1ff1e69f78  Windows CI 按正式资源锁下载并核验媒体程序。
1edd57cf4d66170c203952c3621a28ab519ae8e8  安装版普通工具、审批、计划与人工核验恢复专项。
```

报告提交及其父提交可通过 `git log --first-parent --reverse --format='%H %P %s' 7654b25f1ae3a843ceffd0d140aec4b33a55f804..HEAD` 完整复核。保留的快照对象为 `9716468954ddc5dac6a01f3594f48889b40631e3`、`9a1402d37d224ade323a5766c9adf07f2f5b7db2`，有效用例覆盖记录见 [快照覆盖报告](phase5-snapshot-coverage-20261012.md)。

## 二、冲突、SQLite 与 D4 执行契约

C1 后重新计算仍为六文件十段文本冲突，没有新增文本冲突：`extension-runtime.ts` 两段、`ffmpeg-tool.ts` 一段、`index.ts` 两段、`runtime-settings.test.ts` 一段、`semantic-check.ts` 两段、`semantic-check.test.ts` 两段。逐段保留双方有效行为，非文本契约另按实际调用链修正，详见 [M1 集成记录](phase5-m1-integration-20261012.md)。

P1-A 的合法计划证据来源由一个生产规则同时约束模型输入与磁盘解析；真实 SQLite 写入和读取一致。P1-B 同次事务保存任务起点事件、正式展示快照及 `executionVersion:1` 消息绑定，成功后才推进内存和准备外部执行。明确消息标识替代文字或顺序猜测，保存失败保留原错误并阻止副作用。旧无绑定历史不补造新任务，连续重启不重复中断。复现、事务触发器反证及生产解析器证据见 [C1 持久化报告](phase5-c1-persistence-20261012.md)。

保留逐工具门禁、完整 `turnId + stepId + toolCallId`、检查点、失败分类、未知效果、主动恢复、执行预算、最新候选生产来源与 SHA-256、独占正式发布。带命令钩子的工具不被无条件认定只读；Vision/Whisper 适配器及语义嵌套调用保留原持久化错误与未知效果。输出目录创建和正式发布前都先保存检查点，恢复不自动重放旧工具。

安装版 Core 两项通过，证据为 `logs/general-agent-core-20261012/installed-recovery-1791811079634/` 和 `installed-tools-1791811088597/`。覆盖首次带附件草稿强杀、连续两次恢复、主动继续、普通创建/读取/摘要编辑、拒绝后同轮不重复审批、实际 PowerShell 写入后退出 7、未知效果阻止后续写入、非空用户说明核验整个调用、主动继续一次完成剩余写入、计划与重启不重放。模型为本机确定性 SSE；目录和附件选择替换现有系统对话框返回值，不宣称已人工验收原生选择器。详细范围见 [安装版 Core 报告](phase5-c3-core-installed-20261012.md)。

## 三、Windows 故障、修复及远端检查

原命令首次五秒超时的初始延迟未在本机复现，不将系统资源波动写成证明。已实际复现超时夹具先删仍被进程占用的目录，修复只在清理前取消并等待生产进程树收尾，保留原五秒期限和真实成功、失败、取消测试。

首次候选 Ubuntu 收集阶段传递导入 Electron，触发未消费的二进制下载并遭 HTTP 504；八套 Node 测试局部隔离该外部入口，真实文件、SQLite、HTTP、MCP 继续执行。Windows 后续准确检查又触发 NTFS 短路径原生监视断言；实际子进程旧行为退出 `3221226505`，目录 `realpath` 后生产函数正常完成，永久反证已加入。

`8a4d35f` 的 Windows 作业 `114824871096` 因 Chocolatey 元数据 HTTP 504 未安装任何程序，准备步骤却成功，六项媒体测试实际 `ENOENT`。没有跳过媒体测试；现在直接消费 FFmpeg 正式资源锁，核验归档与两个程序摘要、实际版本调用，再设置后续路径，失败立即暴露。原始失败与修复分别见 [命令与 CI 报告](phase5-c2-command-20261012.md) 和 [加密保存报告](phase5-c2-safe-storage-20261012.md)。

`f325687` 的 [运行 38254165293](https://github.com/wwxst/agent-desktop/actions/runs/38254165293) 为 Windows、Ubuntu 工程检查、Desktop 构建和已提交差异检查均通过。测试提交 `1edd57c` 的 [运行 38255496651](https://github.com/wwxst/agent-desktop/actions/runs/38255496651) 也已通过；报告提交后的准确 HEAD 另以最终远端作业证据和交付消息核对。不能用此前提交的通过替代最终提交检查。

真实冷配置发现 Windows 主密钥在加密返回约十秒后才落盘；四类凭据保存统一等待实际字段，禁止提前声明成功。等待期间设置覆盖也已独立复现和关闭。最终源码六修复场景通过、两个旧缺陷副本预期失败，证据 `safe-storage-acceptance-1791810878878/evidence.json`。它是实际构建 Electron 与生产 SQLite 入口，非 NSIS 冷保存专项，且不能恢复已经丢失主密钥的孤立旧密文。

真实安全桥丢失取消名称与失败产物，现用普通任务终态经过 IPC/contextBridge，再由 Renderer 还原错误。真实取消及发布后失败产物均通过，详见 [任务终态报告](phase5-c3-task-bridge-20261012.md)。两次真实 Whisper `Release → runtime` 的 `EPERM` 保留失败；复用既有有限目录发布函数后，新安装两项插件链实际通过，未编造原句柄来源，详见 [Whisper 安装修复](phase5-c3-whisper-install-20261012.md)。

## 四、准确候选的本机工程结果

本机 Windows、Node.js `24.20.0`、pnpm `11.22.0`；远端 Node.js `24.19.0`，不混称相同运行时。

```text
PASS  corepack pnpm install --frozen-lockfile   c3-install.log，无额外锁文件漂移。
PASS  corepack pnpm check                      c3-frozen-final-check.log，85文件、976测试。
PASS  corepack pnpm check:architecture         c3-architecture.log，19个工作区包。
PASS  corepack pnpm desktop:build              最终打包与完整浏览器入口实际执行。
PASS  corepack pnpm client:web:build           c3-final-web-build.log。
PASS  corepack pnpm client:web:test --workers=1 c3-complete-browser.log，73通过、17跳过、0失败。
PASS  corepack pnpm desktop:package:win         c3-package-win-final.log，最终NSIS生成成功。
PASS  git diff --check                         最终提交前和远端检查均核对。
```

原始日志均位于候选的 `logs/phase5-integration/`。浏览器共收集 90 项，跳过主要是窄窗项目不执行真实桌面专项、缺少覆盖安装参数等条件；不把跳过计入通过。两个安装覆盖用例由准确安装程序另行执行。旧完整回归的 9 项失败与其后 2 项失败、安装 Core 的夹具失败和超时均保留原日志；最终通过不覆盖失败历史，不累加重复专项作为唯一测试数量。

## 五、最终安装、三插件与数据回滚

最终安装器为 `apps/desktop/dist/installer/Agent-Desktop-Setup-0.0.2-x64.exe`，127824953 字节，SHA-256：

```text
19b8e32fe7c3dccd6e3a5830994a2b79738c296a0f4635b37d0c252e8fe949f2
```

真实安装入口为 `logs/phase5-integration/最终 安装 验收/Agent Desktop.exe`。通用 Electron 执行器摘要不能区分生产源码；31 项应用、渲染层及插件资源清单内容摘要为 `aaeb28718389b0e1eb5908076547efceaa736674843b11f38ea14a6a0f974587`，逐项与当前构建核对一致。摘要按脚本序列化内容计算，非带缩进清单文件自身摘要。

最终 Whisper、Vision、FFmpeg 各专项通过，证据分别为 `logs/whisper-plugin/installed-1791810635560/`、`logs/vision-plugin/installed-1791810964834/`、`logs/ffmpeg-plugin/installed-1791811182006/`。FFmpeg 14 工具无重复；Whisper 使用真实程序与锁定本地模型，含中文、英文、混合、长音频、时间轴、损坏输入、取消和生命周期。Vision 的两种图片协议、上传授权和结果结构使用本机协议服务。抽帧/音频、真实转录、技能组合、剪辑、视频验证、语义验收和正式交付真实执行，但云端理解质量仍未验证。

本轮最终新配置预置已真实下载且校验过的语音模型，所以该次模型下载明确 `SKIP`；旧包冷配置曾实际下载 487601967 字节模型的证据单独保留。最终运行程序归档仍实际下载和校验。合成或拼接语音长音频不冒充自然采集录音。独立安装、启停、卸载重装、损坏更新保护、升级、回滚、重启、取消进程、拒绝及无插件内置绕过均按专项边界验证，详见 [最终三插件报告](phase5-c3-plugin-acceptance-20261012.md)。

最终同目录真实覆盖安装退出零，保护记录为 `logs/phase5-integration/installer-protection-1791811592829/result.json`。原 Vision 安装的 8120 个文件、两项应用注册键和快捷方式核对不变；最终目录的 8141 个文件比首次安装多一份实际运行产生的 `logs/agent-trace.jsonl`。覆盖后继续使用带三插件、技能、会话及真实产物的 Probe 隔离配置，两个安装条件用例实际通过，耗时 9.6 秒：插件和会话保持、真实 FFmpeg 详情更新与回滚可操作。日志为 `logs/phase5-plugin-acceptance-20261012/installed-only-final-console.log`；五项最终插件验收及资源身份集中在 `final-acceptance-manifest.json`。结束后三个随包清单都恢复原文 `1.0.0`，全部 31 项资源的大小与摘要一致，专项进程已关闭。完整浏览器中这两项的条件跳过记录保留，不改写原运行计数。

准确旧 `main 49b8da9` 原始应用构建摘要匹配，不冒充不存在的旧安装器。最终 C3 证据为 `logs/phase5-integration/c3-profile-1791810140790/result.json`：完整旧配置升级到最终新安装版、两次重启、一条版本一绑定、一次模型请求，随后匹配旧程序及完整 55 文件备份回滚通过。包括旧历史、草稿、中文及空格目录、附件、侧栏、模型及插件加密配置；真实 SQLite 和系统密钥一致，详见 [C3 升级与回滚](phase5-c3-upgrade-rollback-20261012.md)。

## 六、三轮审查、未解决问题与门禁

第一轮见 [架构及集成审查](phase5-review-architecture-20261012.md)，第二轮见 [持久化、失败与安全独立审查](phase5-review-security-20261012.md)，第三轮见 [工程与发布前审查](phase5-review-engineering-20261012.md)。各报告明确作者自查与独立范围，保存实际发现、最小修复和复测；安全存储设置覆盖 P2、主密钥冷保存 P1、短路径原生崩溃 P1 等已关闭。源码和跨作者审查不以旧分支测试替代候选；三轮结论限定当前真实证据范围。

当前工程范围没有未关闭 P0/P1。真实云 Vision API、真实 Responses 供应商协议两项 `SKIP` 是明确的外部门禁阻塞，不降级为通过，也不因凭据缺失放弃其余工程工作。未使用未经授权的生产密钥，未将凭据写入源码、提交或日志。

安装器签名状态为 `NotSigned`。代码签名、全新 Windows 虚拟机、线上插件市场及正式发布升级属于另设公开发布门禁；本轮工程完成不表示可公开发布，也不授权合并 `main`。

## 七、后续 main 合并与回滚的可执行方案

以下命令是后续方案，**本轮未执行**。先取得两项获授权的真实云验收、关闭新 P0/P1、复核准确候选双平台 CI，再由用户授权合并。若远端 main 或来源变化，先审查增量，不机械沿用本报告。

在新独立工作树合并并先推送验收分支；以下路径和分支必须尚未存在：

```powershell
git fetch origin
git worktree add -b codex/phase5-main-merge 'C:/Users/ww/.codex/worktrees/phase5-main-merge/agent-desktop' origin/main
Set-Location 'C:/Users/ww/.codex/worktrees/phase5-main-merge/agent-desktop'
if ((git rev-parse HEAD) -ne '49b8da974cc963f7068abb04423bed9628a8f6ae') { throw 'main已变化，须先完成增量审计。' }
git merge --no-ff origin/codex/phase5-integration
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm desktop:build
git rev-parse HEAD
git push origin codex/phase5-main-merge
```

记录实际合并摘要，按该准确提交检查 Windows/Ubuntu 并复核必要真实验收。只有全部通过且仍有用户合并授权后，才执行 `git push origin HEAD:main`；若远端已前进，普通推送会拒绝，重新增量审查。不得强推。公开发布须另行授权和完成发布门禁。

共享历史回滚在另一独立分支基于实际 main 执行 `git revert -m 1 <实际main合并摘要>`，保留新反向提交，再执行冻结依赖、完整检查、构建、两系统 CI 和必要真实验收，经授权后推送 main。不得重写历史或删除原候选/快照。

数据回滚先退出匹配程序，把升级后整个隔离配置目录移动到新的保留目录，再复制升级前完整备份到原配置路径，并以准确旧应用启动。移动前逐一验证绝对路径位于该专项目录、目标不存在；复制后逐文件核对大小与摘要。`Local State`、SQLite、插件和全部配置必须来自同一备份，不能单独还原数据库、混用主密钥或让旧程序直接消费升级后配置。实际已执行的匹配回滚命令、清单和结果由 C3 报告维护。
