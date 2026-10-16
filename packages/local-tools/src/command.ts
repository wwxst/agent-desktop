import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { ToolResult } from '@agent-desktop/model';
import type { Tool, ToolExecutionContext, ToolProgressEvent } from '@agent-desktop/tools';
import { resolveScopedPath } from './path-scope.js';
import type { WorkspacePort } from './workspace.js';

/** 模型没有指定超时时的默认值。 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 首期允许模型请求的超时上限；超过上限按上限执行，审批卡展示的就是生效值。 */
const MAX_TIMEOUT_MS = 600_000;
/** 单条流保留的开头字节数。 */
const HEAD_BUDGET_BYTES = 16 * 1024;
/** 单条流保留的结尾字节数；与开头合计后，两条流最多保留 64 KiB。 */
const TAIL_BUDGET_BYTES = 16 * 1024;

/**
 * 宿主提供的本机命令执行边界。
 *
 * 解释器绝对路径和子进程环境都由宿主决定：工具不搜索 PATH，也不复制宿主全部环境变量，
 * 因此设置里保存的模型密钥不会被注入命令。
 */
export interface CommandPort {
  /** 宿主解析并固定的非交互命令解释器绝对路径。 */
  readonly interpreterPath: string;
  /** 只包含运行工具链所需基础变量的子进程环境。 */
  readonly environment: NodeJS.ProcessEnv;
}

/** 一次命令的真实终态；退出码为 0 只代表该命令正常退出。 */
export interface CommandOutcome {
  readonly command: string;
  readonly workingDirectory: string;
  readonly exitCode: number | null;
  readonly termination: 'exited' | 'timed-out';
  readonly stdout: string;
  readonly stderr: string;
  /** 输出超过保留预算时为 true；它只说明文本不完整，不代表命令成功或失败。 */
  readonly truncated: boolean;
  readonly droppedBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResult(message: string, failureKind: 'permanent' | 'denied' = 'permanent'): ToolResult {
  return { status: 'error', message, failureKind };
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

/**
 * 取消信号是活值：它在等待审批期间会被别的代码改变。
 * 单独包一层是为了让「这里必须重新读一次」在类型上也是真的读取，而不是被上一次判断收窄后的常量。
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** 读取模型请求的超时；非正数或非有限值直接失败，超过上限按上限执行。 */
function readTimeoutMs(value: unknown): number | undefined {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

/**
 * 有界文本累积器：保留开头和结尾，中间被丢弃的部分只计数。
 *
 * 命令输出是真实外部边界，可能无限增长，因此这里给出确定上限，
 * 而不是让内存和界面缓存随输出增长。工具最终结果与宿主实时投影共用这一份规则。
 */
export class BoundedTextBuffer {
  private head = '';
  private tail = '';
  private totalBytes = 0;

  public constructor(
    private readonly headBudget: number,
    private readonly tailBudget: number,
  ) {}

  public append(text: string): void {
    if (text.length === 0) return;
    this.totalBytes += Buffer.byteLength(text, 'utf8');

    // 按字符边界切分，单个大块也必须保留真实首尾，不能因为块尺寸超过预算就整块丢弃。
    const [headAddition, remaining] = takeUtf8Prefix(
      text,
      this.headBudget - Buffer.byteLength(this.head, 'utf8'),
    );
    this.head += headAddition;
    if (remaining.length > 0) {
      this.tail = takeUtf8Suffix(this.tail + remaining, this.tailBudget);
    }
  }

  /** 被丢弃的字节数只统计既不在开头也不在结尾窗口的部分。 */
  public droppedBytes(): number {
    return this.totalBytes
      - Buffer.byteLength(this.head, 'utf8')
      - Buffer.byteLength(this.tail, 'utf8');
  }

  public truncated(): boolean {
    return this.droppedBytes() > 0;
  }

  public text(): string {
    if (this.truncated()) return `${this.head}\n…[省略 ${this.droppedBytes()} 字节]…\n${this.tail}`;
    return this.head + this.tail;
  }
}

/** 在 UTF-8 字节预算内取开头，并返回没有进入开头窗口的剩余文本。 */
function takeUtf8Prefix(text: string, budget: number): readonly [string, string] {
  if (budget <= 0) return ['', text];
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const nextBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + nextBytes > budget) break;
    bytes += nextBytes;
    end += character.length;
  }
  return [text.slice(0, end), text.slice(end)];
}

/** 在 UTF-8 字节预算内取结尾，避免从多字节字符或代理对中间截断。 */
function takeUtf8Suffix(text: string, budget: number): string {
  if (budget <= 0) return '';
  let bytes = 0;
  let start = text.length;
  while (start > 0) {
    let characterStart = start - 1;
    const codeUnit = text.charCodeAt(characterStart);
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && characterStart > 0) {
      const previous = text.charCodeAt(characterStart - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) characterStart -= 1;
    }
    const nextBytes = Buffer.byteLength(text.slice(characterStart, start), 'utf8');
    if (bytes + nextBytes > budget) break;
    bytes += nextBytes;
    start = characterStart;
  }
  return text.slice(start);
}

/** 命令输出保留预算的唯一出处；工具最终结果和宿主实时投影都从这里取同一个上限。 */
export function createCommandOutputBuffer(): BoundedTextBuffer {
  return new BoundedTextBuffer(HEAD_BUDGET_BYTES, TAIL_BUDGET_BYTES);
}

/**
 * 结束命令创建的进程树。
 *
 * Windows 首期用系统 `taskkill` 的 `/T` 结束后代进程：只调用 `child.kill()` 无法证明
 * PowerShell 启动的 `.cmd` 与 Node 孙进程已经退出。收尾力度不改变取消语义——
 * 命令是否真的结束，由命令自己的 close 与超时如实反映。
 */
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  // taskkill 自身的失败不是命令结果，也不在这里改写成成功或失败；未结束的进程会让本次命令
  // 继续保持运行态，从而在界面上真实可见。
  killer.once('error', () => {});
}

interface RunCommandRequest {
  readonly interpreterPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly command: string;
  readonly workingDirectory: string;
  readonly timeoutMs: number;
  readonly reportProgress: (event: ToolProgressEvent) => void;
  readonly signal?: AbortSignal;
  readonly checkpoint?: (data: unknown) => void;
}

/**
 * Windows PowerShell 5.1 的重定向输出默认不是 UTF-8；工具统一按 UTF-8 增量解码，
 * 因此启动脚本先固定输出编码，再执行宿主批准的原命令。编码参数也避免再经过一层 shell 拼接。
 */
function encodePowerShellCommand(command: string): string {
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n${command}`;
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 启动命令并等待它结束；输出、退出码、超时和取消都在这里收尾。 */
async function runCommand(request: RunCommandRequest): Promise<ToolResult> {
  request.checkpoint?.({ kind: 'command', command: request.command, workingDirectory: request.workingDirectory });
  const child = spawn(
    request.interpreterPath,
    // 命令作为独立参数交给进程 API，不拼进第二层 `cmd /c`；
    // 解释器固定为宿主解析的绝对路径，不静默在多个解释器之间切换。
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(request.command)],
    {
      cwd: request.workingDirectory,
      env: request.environment,
      windowsHide: true,
    },
  );
  // 立即结束标准输入：命令不能等待交互式输入，只能正常退出或按超时结束。
  child.stdin.end();

  const stdout = createCommandOutputBuffer();
  const stderr = createCommandOutputBuffer();
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  // 序号只表示宿主收到的顺序；两条流之间没有操作系统保证的精确顺序。
  let sequence = 0;

  child.stdout.on('data', (chunk: Buffer) => {
    const text = stdoutDecoder.write(chunk);
    stdout.append(text);
    if (text.length > 0) {
      request.reportProgress({ kind: 'command.output', stream: 'stdout', sequence: sequence++, text });
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = stderrDecoder.write(chunk);
    stderr.append(text);
    if (text.length > 0) {
      request.reportProgress({ kind: 'command.output', stream: 'stderr', sequence: sequence++, text });
    }
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child.pid);
  }, request.timeoutMs);

  const onAbort = () => {
    killProcessTree(child.pid);
  };
  request.signal?.addEventListener('abort', onAbort, { once: true });

  let exitCode: number | null = null;
  let startupFailure: Error | undefined;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      // 启动失败（解释器不可用等）是真实外部边界，与正常退出分开处理。
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
  } catch (error) {
    // 非 Error 抛出值不是合法的进程边界失败，直接暴露程序错误。
    if (!(error instanceof Error)) throw error;
    startupFailure = error;
  }

  clearTimeout(timer);
  request.signal?.removeEventListener('abort', onAbort);
  stdout.append(stdoutDecoder.end());
  stderr.append(stderrDecoder.end());

  // 取消继续按 AbortError 结束：不返回普通工具失败，避免模型把一次取消当成失败调用继续推理。
  if (isAborted(request.signal)) throw abortError();

  const outcome: CommandOutcome = {
    command: request.command,
    workingDirectory: request.workingDirectory,
    exitCode,
    termination: timedOut ? 'timed-out' : 'exited',
    stdout: stdout.text(),
    stderr: stderr.text(),
    truncated: stdout.truncated() || stderr.truncated(),
    droppedBytes: stdout.droppedBytes() + stderr.droppedBytes(),
  };

  // 失败分支必须保留退出码与有界输出，不能只留一条错误文字。
  if (startupFailure !== undefined) {
    return {
      status: 'error',
      failureKind: 'permanent',
      message: `命令无法启动（${startupFailure.message}）：${request.command}`,
      output: outcome,
    };
  }
  if (timedOut) {
    return {
      status: 'error',
      failureKind: 'unknown-outcome',
      message: `命令超过 ${request.timeoutMs} 毫秒已被终止：${request.command}`,
      output: outcome,
    };
  }
  if (exitCode !== 0) {
    return {
      status: 'error',
      failureKind: 'unknown-outcome',
      message: `命令以退出码 ${exitCode ?? '未知'} 结束：${request.command}`,
      output: outcome,
    };
  }
  return { status: 'success', output: outcome };
}

/**
 * 在宿主授权范围内的真实目录中运行一条本机命令。
 *
 * 每次调用都交给宿主按当前权限模式审批，不根据命令前缀推断只读。
 * 宿主拒绝时不启动任何进程，要改命令就由模型重新提交一次新请求。
 *
 * 这是一项以当前用户权限执行的本机命令授权。工作目录只是执行起点，
 * 无法限制脚本访问其他目录、网络或调用其他程序；首期不是操作系统沙箱。
 */
export class RunCommandTool implements Tool {
  readonly executionBoundary = 'checkpointed' as const;
  readonly name = 'run_command';
  readonly description = '在宿主授权范围内的真实目录中运行一条本机命令（Windows 非交互 PowerShell），每次调用由宿主按当前权限模式审批；读取文件、列目录、搜索文本和精确编辑已有文件继续使用各自的专用 Tool，不要改写成命令。命令以当前用户权限运行，工作目录只是执行起点而不是沙箱。';
  readonly inputSchema = {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的完整命令' },
      workingDirectory: {
        type: 'string',
        description: '执行起点目录；相对路径以当前会话工作目录为基准，省略时使用会话工作目录',
      },
      timeoutMs: {
        type: 'number',
        description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}`,
      },
    },
    required: ['command'],
    additionalProperties: false,
  };

  public constructor(
    private readonly workspace: WorkspacePort,
    private readonly host: CommandPort,
  ) {}

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input)) {
      return errorResult('run_command requires an object input');
    }
    const { command, workingDirectory } = input;
    if (typeof command !== 'string' || command.trim().length === 0) {
      return errorResult('run_command requires command to be a non-empty string');
    }
    if (workingDirectory !== undefined && typeof workingDirectory !== 'string') {
      return errorResult('run_command requires workingDirectory to be a string when provided');
    }

    const timeoutMs = readTimeoutMs(input.timeoutMs);
    if (timeoutMs === undefined) {
      return errorResult(`timeoutMs 必须是正数，且不超过 ${MAX_TIMEOUT_MS} 毫秒。`);
    }

    // 执行起点始终解析为真实目录；是否允许工作目录外的路径由宿主文件范围决定。
    const scope = await resolveScopedPath(this.workspace.confirmedDirectory(), workingDirectory, this.workspace.fileAccess === 'all');
    if (!scope.ok) return errorResult(scope.message);
    if (!(await stat(scope.path)).isDirectory()) {
      return errorResult(`不是目录：${scope.path}`);
    }

    // 轮次已经取消时不再请求确认：宿主的取消信号在请求之前触发，等待就永远不会有结果。
    if (isAborted(context.signal)) throw abortError();

    const approved = await this.workspace.requestApproval({
      kind: 'command',
      interpreter: this.host.interpreterPath,
      command,
      workingDirectory: scope.path,
      timeoutMs,
    }, context.signal);
    // 等待期间用户可能已经取消：批准不能重新启动一个已经失效的操作。
    if (isAborted(context.signal)) throw abortError();
    // 拒绝不启动任何进程，也不产生任何输出。
    if (!approved) return errorResult(`用户拒绝执行该命令，未启动任何进程：${command}`, 'denied');

    return runCommand({
      interpreterPath: this.host.interpreterPath,
      environment: this.host.environment,
      command,
      workingDirectory: scope.path,
      timeoutMs,
      reportProgress: context.reportProgress,
      // exactOptionalPropertyTypes 下，没有取消信号时必须省略字段而不是写入 undefined。
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.checkpoint === undefined ? {} : { checkpoint: context.checkpoint }),
    });
  }
}
