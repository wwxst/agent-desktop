# Whisper 运行资源来源

本插件安装时从 whisper.cpp 官方 GitHub `v1.7.6` Windows x64 发布资产下载运行包，并按 `runtime.lock.json` 校验压缩包和运行库文件。运行包不提交到仓库。

```text
Source         来源       https://github.com/ggml-org/whisper.cpp/releases/tag/v1.7.6
License        许可证     whisper.cpp 源码和发布运行包随上游 MIT 许可证提供
Integrity      完整性     压缩包、whisper-cli.exe 及所需 DLL 均锁定 SHA-256 与体积
Acceleration   加速       本阶段只声明 Windows x64 CPU 运行，不声明 CUDA 或其它 GPU 支持
```

模型不随插件安装。默认模型来自官方 `ggerganov/whisper.cpp` Hugging Face 模型仓库，安装时单独校验模型清单中的来源、SHA-256 和体积。
