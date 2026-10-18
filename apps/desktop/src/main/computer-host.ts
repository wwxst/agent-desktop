import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ToolExecutionError, type Tool, type ToolExecutionContext } from '@agent-desktop/tools';
import { createFileArtifact } from '@agent-desktop/local-tools';

const MAX_HELPER_BYTES = 512 * 1024;
const HELPER_TIMEOUT_MS = 15_000;
type Input = Record<string, unknown>;
interface ElementIdentity {
  readonly runtimeId: readonly number[];
  readonly processId: number;
  readonly handle: string;
  readonly name: string;
  readonly automationId: string;
  readonly className: string;
  readonly controlType: string;
  readonly enabled: boolean;
  readonly offscreen: boolean;
  readonly password: boolean;
  readonly focusable: boolean;
}
interface WindowIdentity extends ElementIdentity { readonly processName: string; }
interface Snapshot { readonly id: string; readonly elements: ReadonlyMap<string, ElementIdentity>; }
interface WindowState { readonly identity: WindowIdentity; snapshot?: Snapshot; }
export interface ComputerApproval {
  readonly action: string;
  readonly windowId: string;
  readonly windowTitle: string;
  readonly processId: number;
  readonly processName: string;
  readonly snapshotId?: string;
  readonly ref?: string;
  readonly text?: string;
  readonly key?: string;
  readonly direction?: string;
  readonly path?: string;
}
export interface SessionComputerOptions {
  readonly approve: (action: ComputerApproval, signal?: AbortSignal) => Promise<boolean>;
  /** 由宿主确认的现有输出目录，模型不接触目标文件路径。 */
  readonly outputDirectory?: () => string | undefined;
  /** 打包入口提供随应用分发的 helper；不是模型输入。 */
  readonly helperPath?: string;
}
const string = { type: 'string' };
const windowProperties = { windowId: string };
const refProperties = { ...windowProperties, snapshotId: string, ref: string };
function schema(properties: Input, required: readonly string[]) { return { type: 'object', properties, required, additionalProperties: false }; }
function record(value: unknown): value is Input { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(input: Input, field: string, maximum = 1024): string {
  const value = input[field];
  if (typeof value !== 'string' || !value.length || value.length > maximum) throw new ToolExecutionError(`${field} 必须是 1 至 ${maximum} 字的字符串。`, 'permanent');
  return value;
}
function identity(value: unknown): ElementIdentity {
  if (!record(value) || !Array.isArray(value.runtimeId) || value.runtimeId.length === 0 || !value.runtimeId.every(item => Number.isInteger(item))
    || !Number.isInteger(value.processId) || typeof value.handle !== 'string'
    || !['name', 'automationId', 'className', 'controlType'].every(key => typeof value[key] === 'string')
    || !['enabled', 'offscreen', 'password', 'focusable'].every(key => typeof value[key] === 'boolean')) {
    throw new Error('Windows UI Automation 返回了无效元素身份。');
  }
  return value as unknown as ElementIdentity;
}

/** 会话只保存真实观察得到的窗口和元素引用，不恢复活 UI 引用，也不猜坐标。 */
export class SessionComputer {
  private readonly windows = new Map<string, WindowState>();
  private readonly pending = new Map<AbortController, Promise<unknown>>();
  private closed = false;

  constructor(private readonly options: SessionComputerOptions) {}

  tools(): readonly Tool[] {
    const references = ['windowId', 'snapshotId', 'ref'];
    return [
      this.tool('computer_window_list', '枚举当前 Windows 桌面的真实顶层窗口，后续只能使用返回的 windowId。', schema({}, []), false,
        async (_input, context) => this.listWindows(context.signal)),
      this.tool('computer_snapshot', '读取指定窗口的有界 UI Automation 控件树与文字，返回 snapshotId 和元素 ref；操作后必须重新读取。', schema(windowProperties, ['windowId']), false,
        async (input, context) => this.snapshot(text(input, 'windowId'), context.signal)),
      ...(['click', 'type', 'key', 'scroll'] as const).map(action => this.tool(`computer_${action}`,
        action === 'click' ? '通过当前 UI Automation 元素的可操作 Pattern 点击；拒绝坐标猜测。'
          : action === 'type' ? '向确切的可编辑元素填写完整文本；文档输入会先全选替换。'
            : action === 'key' ? '向确切的当前元素发送受限键或组合键；不支持 Windows 键。' : '通过确切元素的 ScrollPattern 向上或向下滚动。',
        schema({ ...refProperties, ...(action === 'type' ? { text: string } : action === 'key' ? { key: string }
          : action === 'scroll' ? { direction: { enum: ['up', 'down'] } } : {}) },
        [...references, ...(action === 'click' ? [] : [action === 'type' ? 'text' : action === 'key' ? 'key' : 'direction'])]), true,
        async (input, context) => this.act(action, input, context))),
      this.tool('computer_wait', '有界等待界面响应；等待完成后重新 snapshot 验证，不能据此宣布操作成功。',
        schema({ milliseconds: { type: 'integer', minimum: 0, maximum: 5000 } }, ['milliseconds']), false, async (input, context) => {
          if (typeof input.milliseconds !== 'number' || !Number.isInteger(input.milliseconds) || input.milliseconds < 0 || input.milliseconds > 5000) {
            throw new ToolExecutionError('milliseconds 必须是 0 至 5000 的整数。', 'permanent');
          }
          await delay(input.milliseconds, undefined, { signal: context.signal });
          return { waitedMilliseconds: input.milliseconds, requiresSnapshot: true };
        }),
      this.tool('computer_screenshot', '捕获指定窗口并保存到宿主授权目录中的独占 PNG 文件；不会抓取整个桌面。', schema(windowProperties, ['windowId']), true,
        async (input, context) => this.screenshot(text(input, 'windowId'), context)),
    ];
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.pending.keys()) controller.abort();
    await Promise.allSettled(this.pending.values());
    this.windows.clear();
  }

  private tool(name: string, description: string, inputSchema: unknown, effect: boolean,
    execute: (input: Input, context: ToolExecutionContext) => Promise<unknown>): Tool {
    return { name, description, inputSchema, executionBoundary: effect ? 'checkpointed' : 'read-only',
      contract: { capability: 'computer', riskLevel: effect ? 'external' : 'read', parallelSafety: 'serial', timeoutMs: 20_000,
        cancellation: 'signal', workspaceScope: effect ? 'application' : 'none', approvalRequirement: effect ? 'policy' : 'none', outputSchema: { type: 'object' } },
      execute: async (input, context) => {
        if (!record(input)) throw new ToolExecutionError('Windows 工具输入必须是对象。', 'permanent');
        if (this.closed) throw new ToolExecutionError('本会话的 Windows 自动化已关闭。', 'permanent');
        const output = await execute(input, context);
        return { status: 'success', output,
          ...(name === 'computer_screenshot' && record(output) && typeof output.path === 'string'
            ? { artifacts: [await createFileArtifact(output.path, name, context.signal)] } : {}) };
      } };
  }

  private async listWindows(signal?: AbortSignal) {
    const response = await this.helper({ action: 'windows' }, signal, false);
    if (!Array.isArray(response.windows) || typeof response.truncated !== 'boolean') throw new Error('Windows 窗口列表返回结构无效。');
    const observed = new Map<string, WindowState>();
    const windows = response.windows.map(value => {
      const base = identity(value);
      if (!record(value) || typeof value.processName !== 'string') throw new Error('Windows 窗口缺少进程名称。');
      const window: WindowIdentity = { ...base, processName: value.processName };
      const previous = [...this.windows].find(([, state]) => state.identity.processId === window.processId && state.identity.handle === window.handle
        && state.identity.className === window.className);
      const windowId = previous?.[0] ?? randomUUID(); observed.set(windowId, { identity: window });
      return { windowId, title: window.name, processId: window.processId, processName: window.processName, offscreen: window.offscreen };
    });
    this.windows.clear(); for (const [id, value] of observed) this.windows.set(id, value);
    return { windows, truncated: response.truncated };
  }

  private window(windowId: string): WindowState {
    const state = this.windows.get(windowId);
    if (state === undefined) throw new ToolExecutionError('stale reference：窗口不属于当前会话的观察，请先 computer_window_list。', 'permanent');
    return state;
  }

  private async snapshot(windowId: string, signal?: AbortSignal) {
    const state = this.window(windowId);
    const response = await this.helper({ action: 'snapshot', window: state.identity }, signal, false);
    if (!Array.isArray(response.elements) || typeof response.text !== 'string' || typeof response.truncated !== 'boolean') throw new Error('Windows 快照返回结构无效。');
    const elements = new Map<string, ElementIdentity>();
    const entries = response.elements.map((value, index) => {
      const element = identity(value); const ref = `e${index + 1}`; elements.set(ref, element);
      return { ref, role: element.controlType, name: element.name, automationId: element.automationId,
        enabled: element.enabled, offscreen: element.offscreen, password: element.password, focusable: element.focusable };
    });
    const snapshotId = randomUUID(); state.snapshot = { id: snapshotId, elements };
    return { windowId, snapshotId, title: identity(response.window).name, elements: entries, text: response.text, truncated: response.truncated };
  }

  private target(input: Input) {
    const windowId = text(input, 'windowId'); const state = this.window(windowId);
    const snapshotId = text(input, 'snapshotId'); const ref = text(input, 'ref', 32);
    const element = state.snapshot?.id === snapshotId ? state.snapshot.elements.get(ref) : undefined;
    if (element === undefined) throw new ToolExecutionError('stale reference：快照或元素引用已经失效，请重新 computer_snapshot。', 'permanent');
    return { windowId, state, snapshotId, ref, element };
  }

  private approval(action: string, windowId: string, state: WindowState): ComputerApproval {
    return { action, windowId, windowTitle: state.identity.name, processId: state.identity.processId, processName: state.identity.processName };
  }

  private async approve(action: ComputerApproval, context: ToolExecutionContext): Promise<void> {
    if (!await this.options.approve(action, context.signal)) throw new ToolExecutionError('Windows 操作未获批准。', 'denied');
    context.signal?.throwIfAborted();
  }

  private async act(action: string, input: Input, context: ToolExecutionContext) {
    const target = this.target(input);
    const fields: { text?: string; key?: string; direction?: string } = {};
    if (action === 'type') {
      if (typeof input.text !== 'string' || input.text.length > 16000) throw new ToolExecutionError('text 必须是不超过 16000 字的字符串。', 'permanent');
      fields.text = input.text;
    } else if (action === 'key') fields.key = text(input, 'key', 80);
    else if (action === 'scroll') fields.direction = text(input, 'direction', 8);
    if (action === 'scroll' && fields.direction !== 'up' && fields.direction !== 'down') throw new ToolExecutionError('direction 只能是 up 或 down。', 'permanent');
    const approval = { ...this.approval(action, target.windowId, target.state), snapshotId: target.snapshotId, ref: target.ref, ...fields };
    await this.approve(approval, context);
    // 审批后再在同一次 helper 中重查 RuntimeId/属性/焦点，不能复用审批前的坐标或活引用。
    context.checkpoint?.({ kind: 'computer', ...approval });
    try { return await this.helper({ action, window: target.state.identity, element: target.element, ...fields }, context.signal, true); }
    finally { delete target.state.snapshot; }
  }

  private async screenshot(windowId: string, context: ToolExecutionContext) {
    const state = this.window(windowId); const directory = this.options.outputDirectory?.();
    if (directory === undefined) throw new ToolExecutionError('尚未配置 Windows 截图的授权输出目录。', 'denied');
    const root = await realpath(directory);
    if (!(await stat(root)).isDirectory()) throw new ToolExecutionError('Windows 截图输出路径不是目录。', 'permanent');
    const path = join(root, `computer-${randomUUID()}.png`);
    const approval = { ...this.approval('screenshot', windowId, state), path };
    await this.approve(approval, context);
    const reserved = await open(path, 'wx'); await reserved.close();
    try {
      context.checkpoint?.({ kind: 'computer', ...approval });
      await this.helper({ action: 'screenshot', window: state.identity, path }, context.signal, true);
      const bytes = await readFile(path);
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new ToolExecutionError('Windows 截图未产生有效 PNG。', 'unknown-outcome');
      return { path, mimeType: 'image/png', size: bytes.length };
    } catch (error) {
      await unlink(path); throw error;
    }
  }

  private helper(request: Input, signal: AbortSignal | undefined, effect: boolean): Promise<Input> {
    if (this.closed) return Promise.reject(new ToolExecutionError('本会话的 Windows 自动化已关闭。', 'permanent'));
    if (process.platform !== 'win32') return Promise.reject(new ToolExecutionError('Windows UI Automation 仅在 Windows 可用。', 'permanent'));
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    const executable = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = this.options.helperPath ?? (typeof __dirname === 'string'
      ? join(__dirname, 'windows-uia.ps1') : fileURLToPath(new URL('./windows-uia.ps1', import.meta.url)));
    const controller = new AbortController(); const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const environment: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)']) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    // 路径固定、shell:false、输入只走 JSON；模型文本从不变成命令行或环境变量。
    const pending = new Promise<Input>((resolve, reject) => {
      let output = ''; let errorText = ''; let started = false; let failure: Error | undefined;
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper],
        { shell: false, windowsHide: true, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
      const stop = (message: string) => {
        failure ??= new ToolExecutionError(message, effect && started ? 'unknown-outcome' : 'transient');
        if (child.pid !== undefined) {
          const kill = spawn(join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
            { shell: false, windowsHide: true, env: environment, stdio: 'ignore' });
          kill.on('error', error => { failure = error; child.kill(); });
        }
      };
      const onAbort = () => { stop('Windows 自动化执行中断，结果需要重新观察核验。'); };
      const timer = setTimeout(() => { stop('Windows 自动化 helper 超时，结果需要重新观察核验。'); }, HELPER_TIMEOUT_MS);
      child.on('spawn', () => { started = true; if (combined.aborted) onAbort(); });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > MAX_HELPER_BYTES) stop('Windows 自动化输出超过预算。');
        else output += chunk;
      });
      child.stderr.on('data', (chunk: string) => { errorText = (errorText + chunk).slice(-8192); });
      child.on('error', error => { failure = error; });
      child.stdin.on('error', error => { failure ??= error; });
      child.once('close', code => {
        clearTimeout(timer); combined.removeEventListener('abort', onAbort);
        if (failure !== undefined) {
          if (!effect && combined.aborted) reject(combined.reason);
          else reject(failure);
          return;
        }
        try {
          const response: unknown = JSON.parse(output.replace(/^\uFEFF/, '').trim());
          if (!record(response) || typeof response.ok !== 'boolean') throw new Error('Windows helper 未返回有效结果。');
          if (!response.ok) {
            if (typeof response.message !== 'string' || !['permanent', 'unknown-outcome'].includes(String(response.failureKind))) throw new Error('Windows helper 返回无效失败。');
            throw new ToolExecutionError(response.message, response.failureKind as 'permanent' | 'unknown-outcome');
          }
          if (code !== 0 || !record(response.data)) throw new Error(`Windows helper 退出失败：${code} ${errorText}`);
          resolve(response.data);
        } catch (error) {
          reject(error instanceof ToolExecutionError ? error : new ToolExecutionError(error instanceof Error ? error.message : String(error), effect && started ? 'unknown-outcome' : 'permanent', { cause: error }));
        }
      });
      combined.addEventListener('abort', onAbort, { once: true });
      child.stdin.end(JSON.stringify(request));
    });
    this.pending.set(controller, pending);
    void pending.finally(() => this.pending.delete(controller)).catch(() => {});
    return pending;
  }
}
