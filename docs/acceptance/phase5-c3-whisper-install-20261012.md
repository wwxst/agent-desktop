# 第五阶段：Whisper 运行目录发布修正

完整浏览器回归的 `logs/phase5-integration/c3-browser-repaired-full.log` 与真实安装版 Vision 的 `logs/phase5-plugin-acceptance-20261012/installed-vision-console.log` 两次在同一生产边界失败：官方 ZIP 解压完成后，`Release` 目录重命名为 `runtime` 抛出 Windows `EPERM`，界面明确显示安装失败。失败日志及隔离目录保留，不能用其他安装成功覆盖该证据。

```text
Runtime                   运行资源          Whisper 可执行程序与必需的 CPU 动态库。
Directory Publication     目录发布          把已经解压的官方资源放到现有 runtime 目录。
EPERM                     操作拒绝          此次目录重命名收到的真实 Windows 文件系统错误。
Bounded Retry             有限重试          仅复用已有目录发布函数的固定次数与等待范围。
```

本机诊断使用相同锁定官方 ZIP，各运行十五次无监视原生重命名、递归监视原生重命名、递归监视既有目录函数，共四十五次均成功，记录 2844 次监视事件。该结果没有复现最初句柄占用来源，因此不把文件监视或扫描器写成已证明根因；诊断记录为 `logs/phase5-plugin-acceptance-20261012/whisper-rename-diagnostic.json`。

生产遗漏明确：FFmpeg 解压目录与插件安装/更新发布已使用 `renameDirectory`，Whisper 的对应目录仍直接调用原生重命名。最小修复只在该目录边界复用已有函数；不修改官方 ZIP 布局、下载文件发布、完整性校验，也不增加新的重试框架。既有函数只对 Windows `EPERM`/`EBUSY` 做三次有限等待，永久失败仍向上传播，未核验资源不能发布成功。

新增反证在实际文件边界注入一次 `EPERM`，验证下一次目录发布成功后继续运行五项资源摘要与大小核验及程序加载检查。Whisper 与 FFmpeg 专项两套九项通过。后续准确源码的完整工程、重新构建 NSIS、真实安装和三插件链在总报告注明；旧 `a1993404…` 安装包只能代表修前代码。

代码回滚应在候选分支生成反向提交；恢复直接重命名会重新引入已观察的安装失败。原配置、旧工作树和失败日志均保留；没有改写已有共享历史。
