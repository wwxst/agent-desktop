# 第五阶段：任务终态穿过 Electron 安全桥

本次真实 Whisper 取消验收发现，Main 的 Session 和执行诊断均为用户取消，返回包内也明确 `errorName: AbortError`，界面却显示“任务失败”。旧 Preload 在 IPC 后创建 Error，再经 `contextBridge` 进入渲染层；Electron 安全桥复制错误时丢失名称和自定义产物字段。

```text
IPC Result                 进程通信结果      主进程返回可结构化复制的普通任务终态对象。
Context Bridge             上下文安全桥      Preload 与渲染层之间的 Electron 隔离边界。
Task Projection            任务事实投影      根据 Session 事件表示执行与待确认事实。
Delivered Artifact         已交付产物        后续取消或失败仍保留的真实已发布文件。
```

最小修复在现有 Desktop 入口完成：`DesktopApi` 的任务和恢复方法返回 `AgentTaskIpcResult` 普通对象，Preload 透传；渲染层收到对象后才创建 Error、还原名称、已交付文件、逐项结果和任务事实投影。共享客户端及 Web 的任务 Promise 契约保持一致。Main、Agent Core 和事件持久化没有改变；跨进程不声明原 Error 实例身份。

不使用 `taskState.status === 'cancelled'` 判断错误身份：存在未知外部效果时，权威任务投影可以是 `blocked`，但真实用户取消仍应显示“已停止”。未使用的旧 Preload 错误产物重复解析一并删除。

三套相关单元测试 32 项通过，生产及测试类型检查通过。新增反证覆盖普通取消、后续失败保留产物、待确认投影与错误身份不同，以及主动恢复入口取消。

真实开发 Electron 证据：`logs/whisper-plugin/electron-1791807561854/summary.json` 与 `cancel.json`。实际运行 whisper.cpp 后取消，子进程已终止，界面“已停止”和活动取消状态均通过；没有降低未知效果或恢复门禁。长音频 407.1 秒的实际转录耗时 68658 毫秒，峰值约 1.085 GB。这是本地真实模型；任务编排的本机协议夹具不证明云模型理解。

FFmpeg 另新增真正发布文件后制造模型 HTTP 400 的反证，检查失败回复同时保留产物卡、逐项交付、真实文件及恢复入口。首次用例定位引用了夹具响应正文，而现有供应商公开错误为 `DeepSeek API request failed: 400`；仅修正测试定位，保留失败日志，未改变生产错误行为。最终通过及安装版证据在总验收记录中注明。

此修复的代码回滚使用候选分支上的反向提交，不重写历史；回滚会恢复已经复现的取消显示与产物丢失问题，故不能作为 main 合并前的兼容方案。配置目录回滚仍需匹配完整备份和旧程序。
