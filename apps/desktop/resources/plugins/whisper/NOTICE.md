# Whisper 插件来源与许可证

完整包构建时从 whisper.cpp 官方 GitHub `v1.7.6` Windows x64 发布资产准备运行包，客户端从随包归档离线安装，并按 `runtime.lock.json` 校验压缩包和运行库文件。手动安装缺少归档时仍可从锁定来源下载，运行包不提交到仓库。

```text
Source         来源       https://github.com/ggml-org/whisper.cpp/releases/tag/v1.7.6
License        许可证     whisper.cpp 源码和发布运行包随上游 MIT 许可证提供
Integrity      完整性     压缩包、whisper-cli.exe 及所需 DLL 均锁定 SHA-256 与体积
Acceleration   加速       本阶段只声明 Windows x64 CPU 运行，不声明 CUDA 或其它 GPU 支持
```

默认模型随完整包提供，来自官方 `ggerganov/whisper.cpp` Hugging Face 模型仓库，构建准备和客户端安装分别校验模型清单中的来源、revision、SHA-256 和体积。

```text
Runtime             运行资源        whisper.cpp v1.7.6 Windows x64 CPU，来源和摘要见 runtime.lock.json
Model               模型            ggml-small.bin，revision 和摘要见 models.lock.json
Runtime license     运行资源许可    LICENSE.whisper.cpp（MIT）
Model license       模型许可        LICENSE.model（OpenAI Whisper MIT）
Distribution        分发方式        构建时准备锁定资源，完整包携带运行资源、模型及许可，不提交二进制
```

本阶段未启用 CUDA、其它 GPU 后端或远程语音识别。首次初始化离线安装默认模型，卸载插件不会删除模型；用户主动删除后不会在重启时自动恢复，可在插件详情从随包资源离线恢复或本地导入。
