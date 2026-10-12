# Whisper 插件来源与许可证

本插件安装时从 whisper.cpp 官方 GitHub `v1.7.6` Windows x64 发布资产下载运行包，并按 `runtime.lock.json` 校验压缩包和运行库文件。运行包不提交到仓库。

```text
Source         来源       https://github.com/ggml-org/whisper.cpp/releases/tag/v1.7.6
License        许可证     whisper.cpp 源码和发布运行包随上游 MIT 许可证提供
Integrity      完整性     压缩包、whisper-cli.exe 及所需 DLL 均锁定 SHA-256 与体积
Acceleration   加速       本阶段只声明 Windows x64 CPU 运行，不声明 CUDA 或其它 GPU 支持
```

模型不随插件安装。默认模型来自官方 `ggerganov/whisper.cpp` Hugging Face 模型仓库，安装时单独校验模型清单中的来源、revision、SHA-256 和体积。

```text
Runtime             运行资源        whisper.cpp v1.7.6 Windows x64 CPU，来源和摘要见 runtime.lock.json
Model               模型            ggml-small.bin，revision 和摘要见 models.lock.json
Runtime license     运行资源许可    LICENSE.whisper.cpp（MIT）
Model license       模型许可        LICENSE.model（OpenAI Whisper MIT）
Distribution        分发方式        运行资源和模型均在安装时从锁定的官方来源下载，不提交二进制
```

本阶段未启用 CUDA、其它 GPU 后端或远程语音识别。模型由用户单独安装，卸载插件不会删除模型；用户在插件详情中主动删除模型后才会移除该文件。
