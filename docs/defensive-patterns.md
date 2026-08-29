# Defensive Patterns（防御性规则）

本文件只记录 Agent Desktop 真实发生过或接近发生过、值得防止再次出现的 bug class（缺陷类别），不是通用最佳实践清单。

```text
English rule                      中文规则              中文介绍
Malformed External Data           第三方异常数据        当前依赖结构缺失时直接失败，不用默认值伪装成功。
Trust Typed Same-process Data     同进程强类型数据      信任 TypeScript 已保证的数据，不制造理论异常。
Expose Program Errors             程序错误暴露          未被当前契约表示的程序错误直接向上暴露。
```

## 1. Malformed External Data Must Fail（第三方异常数据不能伪装成功）

真实证据：FFprobe 的 `format` 或 `streams` 缺失时，代码曾通过空对象或空数组默认值继续返回成功。

第三方 API、进程输出和文件解析等真实边界中，当前业务依赖的结构缺失时必须直接失败，不得用空对象、空数组或默认值把结构异常转换成成功结果。

合法的“无音频流”或“无视频流”不等于 FFprobe 响应结构本身损坏；前者是有效媒体状态，后者是无效外部数据。

## 2. Trust Typed Same-process Data（信任同进程强类型数据）

真实证据：Agent Loop 曾为循环引用、`undefined`、`Object.create(null)` 等同进程理论异常建立 fallback（兜底）和专门测试。

同进程强类型调用默认信任 TypeScript。不要为了静态类型已经排除的输入增加运行时校验、敌意对象测试或 `Unknown error` 兜底；用户输入、模型或 Tool JSON、配置、文件、第三方 API、进程和网络等真实边界除外。

## 3. Expose Program Errors（直接暴露程序错误）

真实证据：Agent Loop 和 Tool 错误处理曾把非 `Error` 抛出值或无法表示的结果转换为默认文本，掩盖实际程序错误。

程序错误必须直接暴露，不得转换成看似正常的默认结果、模糊错误或成功状态。真实外部边界产生的标准 `Error` 可以按 Tool 契约转换为失败结果；非 `Error` 抛出值和不可能状态继续向上暴露。
