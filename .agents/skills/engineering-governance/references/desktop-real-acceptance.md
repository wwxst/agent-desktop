# Desktop Real Acceptance（桌面真实验收）

本 reference 记录用真实 Electron 产物 + 真实用户数据边界做验收的稳定做法。它只在需要证明「持久化往返 / 关闭收尾 / 主进程 ↔ 渲染进程真实链路」时使用；能用单元测试或 `verify-*` 之外的既有入口回答的问题，不要因此新建验收脚本。

## 何时必须做真实验收

```text
Change                          必须真实验收的理由
关闭、保存、重启恢复              单元测试替换了 fs 与 IPC，证明不了真实往返
产物登记与文件定位                revealFile 走真实会话校验与磁盘存在性检查
旧快照兼容                       只有真实解析器 + 真实启动才能证明「能启动且恢复正确」
主进程 ↔ 渲染进程握手             preload 桥接与 IPC 形状在真实进程边界才暴露
```

只用「进程能启动」不算验收：必须断言可观察结果（卡片数量、卡片文案、真实错误文本、磁盘上的字段）。

## 启动真实产物

```js
const app = await electron.launch({
  executablePath: '<root>/node_modules/.pnpm/electron@44.0.0_supports-color@7.1.0/node_modules/electron/dist/electron.exe',
  args: ['.', `--user-data-dir=${userData}`],
  cwd: '<root>/apps/desktop',
  env, // 删除 DESKTOP_RENDERER_URL，确保用构建产物而不是 dev 服务器
});
```

必须先构建：`main`/`preload` 用仓库内 esbuild（`apps/desktop/node_modules/.bin/esbuild`），渲染层用 `apps/desktop/node_modules/.bin/vite build --config vite.config.ts`。**不要**用 `node node_modules/esbuild/bin/esbuild` 这类推测路径，会报 `MODULE_NOT_FOUND`。

⚠️ 从 Node 侧调用 esbuild 时必须用真实 JS 入口 `node_modules/.pnpm/esbuild@0.27.4/node_modules/esbuild/bin/esbuild`。`node_modules/.bin/esbuild` 是 **shell 脚本**，用 `node` 执行会报 `SyntaxError: missing ) after argument list`。

`--user-data-dir` 会改变 `app.getPath('userData')`，因此不会碰开发者真实数据。**每次运行都换带时间戳的新目录**：沙箱的批量删除保护会拦住清理上一次 Chromium profile（200+ 文件）。

`electron.launch` 在本机偶发 `Timeout 180000ms exceeded`，脚本里要重试 2–3 次。

## 夹具必须先过真实解析器

手写快照夹具写错会被解析器拒绝，表现为**启动弹窗 + 页面永远等不到控件**，很容易误判成产品缺陷。所以脚本必须提供 `--dry-run`：

```js
if (process.argv.includes('--dry-run')) { /* 只写夹具，不启动 Electron */ return; }
```

再配合一个临时脚本直接 import 解析器校验：

```bash
node --experimental-transform-types logs/diag-parse.ts <夹具路径>
```

`apps/desktop/src/main/session-persistence.ts` 的 `parseDesktopState` 可直接 import 源文件（`.ts` 后缀，靠 `--experimental-transform-types`）。

也可以用 esbuild 把解析器单独打包成 `.cjs` 再在验收脚本里 `execFileSync` 调用（main 产物是单个 `index.cjs`，无法直接 `require` 子模块）。这样 `--dry-run` 与真实运行共用同一份夹具构造函数。

### 快照解析的结构约束（写夹具前必读）

`parseDesktopState` 会拒绝「会话列表与 clientState 会话列表不一致」的快照，报 `本地会话结构无效：activeSessionId`：

- `sessions[].id` 与 `clientState.conversations[].id` 必须**一一对应且数量相同**；
- `activeSessionId` 必须同时出现在两侧。

只想改一个会话的夹具时，**必须把另一个会话原样保留**，否则整个快照被拒。另外 `clientState.activeSessionId` 也必须与顶层一致。

### 断言要等异步状态稳定

点击「移除附件」「切换会话」都会先经一次异步 IPC 再更新 React 状态，`click()` 返回时界面还是旧的。用 `page.waitForFunction` 等**精确数量**，不要用 `locator.nth(n).waitFor()`——当数量**多于**预期时 `nth(n)` 也已存在，会立刻返回而读到旧状态。

```js
await page.waitForFunction(
  (count) => document.querySelectorAll('.composer-attachments .attachment-chip').length === count,
  expected, { timeout },
);
```

### 持久化层接受的事件类型（写夹具前必读）

```text
Event type              约束
turn.started            只带 turnId
turn.completed          只带 turnId
user.message            turnId + content
step.started            turnId + stepId
step.completed          turnId + stepId
assistant.message       turnId + stepId + content + toolCalls
tool.called             turnId + stepId + toolCallId + name + input
tool.result             result 为 { status: 'success', output } 或 { status: 'error', message }
```

两个高频踩坑：

- `tool.result` 的 success **必须带 `output`**；error 分支字段是 **`message` 不是 `error`**。
- **`turn.failed` 不在持久化层接受范围内**（它只存在于内存态 agent-loop 契约，形状为 `{ type, turnId, durationMs, errorName, errorMessage }`）。失败在持久化事实里只体现为**缺少 `turn.completed`**。

## 反证：证明验收真的能捕获缺陷

验收脚本通过只说明它没报错，不说明它有能力报错。对每个新增验收项做一次反证：

1. 临时把生产代码改回缺陷版本；
2. 重新构建（只改主进程时重建 `main` 即可）；
3. 跑脚本，确认**对应的项 FAIL**；
4. 恢复代码并重建，确认全绿。

反证失败意味着验收项是装饰性的，必须改断言而不是保留。

## 报告口径

区分 `PASS` / `SKIP` / `FAIL`，并给出：运行目录、夹具来源、真实输入、可核对输出、未覆盖范围。缺少 API Key、媒体或模型导致无法执行的项标 `SKIP` 并写明风险，不要写成通过。

## 用真实媒体工具补足「工具侧」验收

当验收标准涉及「真实输出包含 X」时，纯参数断言（`expect(executeCommand).toHaveBeenCalledWith(...)`）证明不了产物真的含有 X。用真实 FFmpeg 造素材再验证产物：

```ts
import { AddAudioTool } from '../packages/video-ffmpeg/src/index.ts';
// 真实素材：lavfi 彩条视频 + 正弦音，覆盖中文与空格路径
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
  '-i', 'testsrc=duration=2:size=320x240:rate=25', '-pix_fmt', 'yuv420p', videoPath]);
// 产物验证：ffprobe 必须真的看到音频流，而不是只看 status === 'success'
execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
  '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', outPath]);
```

`node --experimental-transform-types logs/<script>.ts` 可直接跑（import 源文件用 `.ts` 后缀）。同一素材要有一条**对照成功项**（如真实裁剪成功），否则无法区分「素材本身非法」与「被测路径失败」。
