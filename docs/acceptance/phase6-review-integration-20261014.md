# 第六阶段第一轮：集成完整性独立审查

审查对象为 `codex/phase6-main-integration` 工作树的冲突解决结果，来源为主分支 `9c1a002015925070ba8274b4c20a986acf06fcea` 和第五阶段候选 `5bc555062e51ee61d303d0c7092d6e75ea1396d7`，共同祖先为 `49b8da974cc963f7068abb04423bed9628a8f6ae`。本轮负责处理视频应用层及视觉协议冲突的代理，在完成这三处冲突后只读核对其他合并结果，没有另行改写业务代码。

结论：集成完整性审查 `PASS`（通过），没有发现未关闭的 P0/P1（严重或高优先级问题）。此结论不替代准确最终提交的工程、安装版及外部云模型验收。

## 核对证据

- 主分支新增的 `Composer`、`ModelSelector`、`ModelProvidersSettings`、`model-capabilities`、`model-defaults` 和 `ExtensionFeedback` 相对候选没有差异；输入区模型选择、模型能力路由、供应商配置及统一扩展操作反馈保持。
- 第五阶段的 `agent-loop`、`session`、`tools`、`local-tools`、`model`、`model-deepseek`，以及 Desktop 的 `agent-task`、`session-persistence`、`verify-tool` 相对候选没有差异；通用核心、任务恢复、持久化和执行门禁保持。
- Desktop 主入口经授权适配器注入十四个 FFmpeg 专业工具、Whisper 转录工具与唯一 Vision 工具；没有导入具体内置媒体工具构造器。具体工具仅在独立插件服务和命令行入口组装。公共 `analyze_images` 与 `check_video_semantics` 复用同一注入实例，没有重复注册。
- 本轮启动快照保留对话模型上下文与输出预算、视觉不可用原因，并向 Vision 服务传递所选模型、协议、输出预算和受控密钥环境。能力未知时不调用备用模型，调用失败不会触发换模型。
- 图片访问和上传审批在 MCP（模型上下文协议）调用之前执行；取消、持久化错误及未知执行结果继续按第五阶段契约传播。视觉完整结果及逐帧时间戳使用同一校验函数。
- Shared Client（共享客户端）、Preload（预加载安全桥）和 IPC（进程间通信）一致传递 `AgentTaskStartRequest`；任务终态先跨桥传普通对象，再由渲染入口恢复取消身份、产物及任务状态。Web 开发宿主同步采用当前请求与模型配置契约。

## 已有回归检查

```text
Check                      中文检查                  结果
Video and Vision           视频与视觉聚焦回归        3 个文件、67 个已有测试通过。
Entry and model routing    入口与模型路由聚焦回归    4 个文件、77 个已有测试通过。
Cached diff formatting     暂存差异格式检查          git diff --cached --check 通过。
Unresolved conflict paths  未解决冲突路径            无。
```

第一组包括 `vision-openai`、`video-agent` 与 `semantic-check`；第二组包括 `main-entry`、`runtime-settings`、`web-client-api` 与 `model-routing`。没有新增测试文件或用例。

## 保持范围与未验证项

JSON 到 SQLite 的启动导入和终端历史恢复匹配仍有实际启动或安全恢复消费者，是第五阶段规范报告已记录的 C 类范围；本轮没有新增这些兼容路径，也没有扩大清理。允许破坏性重构不要求为集成删除这些稳定实现。

真实云 Vision（视觉模型）及 Responses（响应协议）仍须取得获授权凭据并完成验收，协议夹具通过不能替代它们。最终候选是否满足 `main` 合并条件，以第六阶段总验收报告、准确提交的 Windows/Ubuntu 持续集成结果及实际外部门禁状态为准。
