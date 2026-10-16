# FFmpeg 运行资源来源

本插件安装时直接从 Gyan 下载锁定的 Windows x64 静态构建，不在本仓库重新托管二进制。下载及程序摘要见 `runtime.lock.json`；安装保留供应商 `LICENSE`、`README.txt`、文档和预设。

```text
Version        版本        FFmpeg 8.1.2，源码提交 38b88335f9。
Source         来源        FFmpeg 官方下载页指向 Gyan，使用其固定版本发行包。
License        许可证      GPLv3；启用 GPL、version3、libx264 和 libass 等构建选项。
Redistribution 再分发      再托管此构建须履行 GPLv3 对应源码、许可和版权通知义务。
Integrity      完整性      供应商校验和及 GitHub 发行资产摘要与本次下载一致；不是数字签名。
```

来源：<https://ffmpeg.org/download.html>、<https://github.com/GyanD/codexffmpeg/releases/tag/8.1.2>。
对应源码：<https://github.com/FFmpeg/FFmpeg/commit/38b88335f9>；第三方库和构建选项见包内供应商 README 及其发行构建说明。

本次未发布或重新分发二进制安装包，也未声明已完成代码签名。将来重新托管运行资源或发布包含资源的发行包前，须随实际分发物提供完整对应源码及构建依赖、许可和版权通知，不能仅以源码链接代替 GPL 要求。
