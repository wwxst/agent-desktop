# Whisper 插件化基线

本记录只描述第三阶段开始前的真实源码和自动化门禁，不把计划当作实现事实。

```text
Branch       分支       codex/whisper-plugin，基于上一阶段实际提交 42d6f6b
Tests        测试       62 个测试文件，669 个测试通过
Desktop      桌面       createVideoAgent 仍可直接注册 TranscribeAudioTool
Semantic     语义       CheckVideoSemanticsTool 仍可直接消费 TranscribeAudioTool
Contract     契约       transcribe_audio(audioPath) 返回 text 与秒级 segments 时间轴
Runtime      运行时     whisper-cli 与模型仍由 Desktop 设置和环境变量提供
```

当前迁移目标是保留 `transcribe_audio` 的工具名称、`audioPath` 输入、`text` 与 `segments` 输出、错误语义和取消语义，同时删除 Desktop 与语义验收中的内置创建路径。

已确认的外部来源：

- whisper.cpp Windows x64 运行包：官方 `ggml-org/whisper.cpp` `v1.7.6` 发布资产 `whisper-bin-x64.zip`，下载后按锁定 SHA-256 校验。
- 默认模型：官方 `ggerganov/whisper.cpp` 模型仓库的 `ggml-small.bin`，按 Hugging Face LFS SHA-256 和声明体积校验。
- whisper.cpp 源码和运行包许可证：MIT；模型来源和原始 Whisper 模型许可说明以官方模型文档为准。

本阶段开始前执行并通过：

```text
pnpm check
pnpm desktop:build
git diff --check
```

基线不代表 Whisper 已插件化；后续提交必须证明插件启停、授权、取消、模型状态和视频语义验收都消费同一条插件调用链。
