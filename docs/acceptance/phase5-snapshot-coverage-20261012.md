# 第五阶段归档快照安全反证覆盖

日期：2026-10-12。候选分支：`codex/phase5-integration`。本记录对应从 `7654b25f1ae3a843ceffd0d140aec4b33a55f804` 开始的安全测试迁移；最终候选的全量门禁、真实插件和安装版验收另行记录。

```text
Snapshot                  归档快照        工作树归档保存的提交，不能仅凭未被分支包含就整块重放。
Patch equivalence         补丁等价        补丁内容相同与提交祖先包含是不同事实。
Safety counterexample     安全反证        用真实调用或保存失败证明危险操作没有执行或重放。
Execution trace           执行诊断        记录调用边界；未知工具诊断与门禁拒绝的实际执行不同。
Recovery gate             恢复门禁        每次调用重新读取会话事实，阻止未知效果和已完成操作重放。
Agent Loop                智能体循环      按模型响应顺序执行调用，保存真实结果并处理执行预算。
Desktop                   桌面宿主        组装具体工具与逐调用门禁，维护应用侧执行边界。
Integration               集成分支        保留通用核心和 FFmpeg 双方历史的现有集成起点。
Vision                    视觉分析插件    最终视觉功能分支，包含 FFmpeg 与 Whisper 的正式历史。
```

## 快照保留事实

`9716468954ddc5dac6a01f3594f48889b40631e3` 的父提交为 `e10dc1241fa67a9793ae28651ed5ca7f8ad514c2`。它不是正式 Integration 分支的祖先；80 个改动路径中，58 个跟踪条目在 `7654b25` 原样保留，19 个后续演进，3 个测试或夹具条目恢复父版本。两个独有测试文件的有效断言按下表迁移，不恢复已被修正的生产实现。

`9a1402d37d224ade323a5766c9adf07f2f5b7db2` 的父提交为 `241123fe60bdcf02a8ee9599c56827a6b90ebed9`。它不是最终 Vision 分支的祖先；8 个改动路径中，1 个原样保留，6 个后续演进，`ffmpeg-tool.ts` 的参数重命名与注释变更未保留但逻辑相同。这个快照没有独有测试文件，最终 Vision 的授权、取消、图片预算和完整响应验证按其正式测试验收，不能把旧原型整块重放。

两个快照的完整补丁都没有与相关正式提交相同的稳定补丁标识。本轮不清理归档快照、分支或工作树。

## `9716468` 逐用例对照

表中的文件均为仓库相对路径，测试编号对应各文件内的实际用例顺序或精确测试名称。

| 原快照安全反证 | 原有覆盖及差异 | 候选保留方式 |
| --- | --- | --- |
| Desktop：首次调用结果未知后，同一响应的第二个写入被拒绝 | `extension-runtime.test.ts` 的 `keeps a disconnected MCP request unknown and blocks later external calls` 已通过真实服务写入标记、断连与门禁覆盖业务行为 | 保留原有测试；循环层原子保存和诊断断言由新增 `tool-gate.test.ts` 第 2 项补齐 |
| Desktop：相同嵌套输入键次序不同仍不重复审批；新显式轮次可重新申请 | 原有 MCP、FFmpeg 测试覆盖同轮相同输入；未覆盖键次序和新轮次 | `apps/desktop/tests/agent-task-state.test.ts` 的 `matches a denied nested input independent of key order and permits a new explicit turn` |
| Desktop：恢复链中的成功写入不能重放；未知效果允许读；确认未发生后解除阻断 | `safe-recovery-tools.test.ts` 已覆盖真实目录、文件、搜索、终端历史和计划读取；未覆盖成功写入重放和人工确认后解除阻断 | `agent-task-state.test.ts` 新增中断成功写入禁止重放、`not-applied` 核验解除阻断两项 |
| Loop：在保存调用前检查最终注册实例，检查点保持调用来源 | 原 `run-turn.test.ts` 只覆盖检查点实际追加 | `packages/agent-loop/tests/tool-gate.test.ts` 第 1 项 |
| Loop：同响应下一项重新读事实；门禁拒绝成对保存、不产生执行诊断 | 原有真实 MCP 测试覆盖重新读事实；未完整断言保存批次、原事实索引与诊断 | `tool-gate.test.ts` 第 2 项 |
| Loop：不存在工具保存未执行事实，不形成未知效果 | 原快照要求空索引输出及不记录诊断；当前 `run-turn.test.ts` 明确记录未知工具失败诊断 | `tool-gate.test.ts` 第 3 项保留当前 `tool.started`、`tool.failed`，验证成对保存和无未知效果；不恢复旧诊断断言 |
| Loop：门禁拒绝事实保存失败，不执行、不向外发布结果 | 原有起点和工具检查点失败测试没有覆盖门禁成对保存失败 | `tool-gate.test.ts` 第 4 项，传播同一 `SessionPersistenceError`，不新增错误终态 |
| Loop：被门禁拒绝的尝试消耗预算，超限保留此前成功事实 | 未覆盖 `maxToolCalls` 的这一行为 | `tool-gate.test.ts` 第 5 项 |
| Loop：跨步骤累积工具尝试，未知工具也消耗预算 | 原有 `maxSteps`、模型请求重试测试验证其他预算 | `tool-gate.test.ts` 第 6 项 |
| 真实服务：写入后断连，不能当作外部操作未发生 | 原快照新增 `write_then_disconnect`；现有 `wait` 也先同步写入 `waiting` 文件，再被实际关闭服务断开 | 保留现有 `extension-runtime.test.ts` 真实 SDK 测试；不新增重复服务工具 |

## 本次验证

```text
pnpm exec vitest run apps/desktop/tests/agent-task-state.test.ts packages/agent-loop/tests/tool-gate.test.ts apps/desktop/tests/extension-runtime.test.ts apps/desktop/tests/safe-recovery-tools.test.ts --reporter=verbose
PASS  4 files / 30 tests
pnpm typecheck:tests
PASS
git diff --check -- apps/desktop/tests/agent-task-state.test.ts packages/agent-loop/tests/tool-gate.test.ts docs/acceptance/phase5-snapshot-coverage-20261012.md
PASS
```

其中新增有效反证为 9 项：Desktop 门禁 3 项、Agent Loop 门禁 6 项。生产代码、MCP 服务夹具和命令测试未因本次迁移而改变。原始输出：`logs/phase5-integration/snapshot-gate-focused.log`。

本次聚焦通过不代表第五阶段全量工程门禁、最终 Vision 集成、SQLite 实际数据库失败或 Windows CI 已完成。
