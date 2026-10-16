import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '@agent-desktop/model';
import type { ToolExecutionContext, ToolProgressEvent } from '@agent-desktop/tools';
import {
  BoundedTextBuffer,
  RunCommandTool,
  type ApprovalTarget,
  type CommandOutcome,
  type CommandPort,
  type WorkspacePort,
} from '../src/index.js';

describe('BoundedTextBuffer', () => {
  it('keeps the real head and tail when one output chunk exceeds both budgets', () => {
    const buffer = new BoundedTextBuffer(6, 6);

    buffer.append('开头-middle-结尾');

    expect(buffer.text()).toContain('开头');
    expect(buffer.text()).toContain('结尾');
    expect(buffer.truncated()).toBe(true);
    expect(buffer.droppedBytes()).toBeGreaterThan(0);
    expect(buffer.text()).not.toContain('\uFFFD');
  });
});

/**
 * 正式解释器是 Windows 非交互 PowerShell。
 * 缺少它时真实进程用例明确 skip，而不是把未运行伪装成通过。
 */
const systemRoot = process.env.SystemRoot;
const interpreterPath = systemRoot === undefined
  ? undefined
  : join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const realInterpreterAvailable = interpreterPath !== undefined && existsSync(interpreterPath);

let base: string;
let root: string;
let cleanupController: AbortController;
let fixtureSignal: AbortSignal;
const commandSettlements: Promise<void>[] = [];

beforeEach(async ({ signal }) => {
  cleanupController = new AbortController();
  // 测试超时必须取消真实进程；断言提前失败时也由 afterEach 取消尚未结束的操作。
  fixtureSignal = AbortSignal.any([signal, cleanupController.signal]);
  base = await realpath(await mkdtemp(join(tmpdir(), 'agent-desktop-command-test-')));
  root = base;
});

afterEach(async () => {
  cleanupController.abort();
  // 工具在 child.close 后才结束；先等真实收尾，再删除仍可能被 PowerShell 占用的目录。
  await Promise.all(commandSettlements.splice(0));
  await rm(base, { recursive: true, force: true });
});

/** 可观察的审批替身：记录被批准的确切操作，并按用例决定是否批准。 */
function portFor(options: {
  directory?: string;
  approve?: boolean;
} = {}): { port: WorkspacePort; requested: ApprovalTarget[] } {
  const requested: ApprovalTarget[] = [];
  return {
    requested,
    port: {
      confirmedDirectory: () => options.directory,
      requestApproval: async (target) => {
        requested.push(target);
        return options.approve ?? true;
      },
      confirmDirectory: () => undefined,
    },
  };
}

/** 只提供当前用例真正使用的解释器路径和子进程环境。 */
function commandPort(): CommandPort {
  return {
    interpreterPath: interpreterPath ?? 'unused-interpreter',
    // 测试进程需要 PATH 才能启动工具链；这不是产品代码的环境构造规则。
    environment: process.env,
  };
}

function toolFor(port: WorkspacePort): RunCommandTool {
  const tool = new RunCommandTool(port, commandPort());
  const execute = tool.execute.bind(tool);
  tool.execute = (...parameters) => {
    const operation = execute(...parameters);
    // 清理只观察是否结束；调用方仍拿原 Promise 断言成功或原始失败，不改写测试结果。
    commandSettlements.push(operation.then(() => undefined, () => undefined));
    return operation;
  };
  return tool;
}

/** 执行上下文同时收集实时进度，便于断言来源和顺序。 */
function contextWithProgress(
  events: ToolProgressEvent[],
  signal?: AbortSignal,
): ToolExecutionContext {
  return {
    toolCallId: 'test-call' as ToolExecutionContext['toolCallId'],
    reportProgress: (event) => events.push(event),
    signal: signal === undefined ? fixtureSignal : AbortSignal.any([fixtureSignal, signal]),
  };
}

/** 成功与失败分支都携带命令终态，这里统一取出它。 */
function outcomeOf(result: ToolResult): CommandOutcome {
  if (result.output === undefined) throw new Error('命令结果缺少终态结构。');
  return result.output as CommandOutcome;
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(path, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Node 孙进程没有在期限内写入 PID。');
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

describe('RunCommandTool input and approval boundaries', () => {
  it('rejects input without a usable command', async () => {
    const { port } = portFor({ directory: root });

    await expect(toolFor(port).execute({}, contextWithProgress([]))).resolves.toEqual({
      status: 'error',
      failureKind: 'permanent',
      message: 'run_command requires command to be a non-empty string',
    });
    await expect(toolFor(port).execute({ command: '   ' }, contextWithProgress([]))).resolves.toEqual({
      status: 'error',
      failureKind: 'permanent',
      message: 'run_command requires command to be a non-empty string',
    });
  });

  it('rejects a timeout that is not a positive number within the cap', async () => {
    const { port } = portFor({ directory: root });

    const result = await toolFor(port).execute(
      { command: 'Write-Output 1', timeoutMs: -1 },
      contextWithProgress([]),
    );

    expect(result).toEqual({ status: 'error', failureKind: 'permanent', message: 'timeoutMs 必须是正数，且不超过 600000 毫秒。' });
  });

  it('requires a confirmed working directory before asking for approval', async () => {
    const { port, requested } = portFor({});

    const result = await toolFor(port).execute({ command: 'Write-Output 1' }, contextWithProgress([]));

    expect(result.status).toBe('error');
    expect(requested).toEqual([]);
  });

  it('does not start a process and asks for the exact operation when the user denies', async () => {
    const { port, requested } = portFor({ directory: root, approve: false });
    const events: ToolProgressEvent[] = [];

    const result = await toolFor(port).execute(
      { command: "Set-Content -LiteralPath 'denied.txt' -Value 'should-not-run'", timeoutMs: 5_000 },
      contextWithProgress(events),
    );

    // 审批卡拿到的是这次真正要执行的确切值：解释器、完整命令、起点目录和生效超时。
    expect(requested).toEqual([{
      kind: 'command',
      interpreter: interpreterPath ?? 'unused-interpreter',
      command: "Set-Content -LiteralPath 'denied.txt' -Value 'should-not-run'",
      workingDirectory: root,
      timeoutMs: 5_000,
    }]);
    expect(result).toEqual({
      status: 'error',
      failureKind: 'denied',
      message: "用户拒绝执行该命令，未启动任何进程：Set-Content -LiteralPath 'denied.txt' -Value 'should-not-run'",
    });
    // 拒绝不产生任何输出。
    expect(events).toEqual([]);
    expect(existsSync(join(root, 'denied.txt'))).toBe(false);
  });

  it('clamps a timeout above the first-phase cap to the cap shown in the approval', async () => {
    const { port, requested } = portFor({ directory: root, approve: false });

    await toolFor(port).execute(
      { command: 'Write-Output 1', timeoutMs: 900_000 },
      contextWithProgress([]),
    );

    expect(requested[0]).toMatchObject({ timeoutMs: 600_000 });
  });
});

describe.skipIf(!realInterpreterAvailable)('RunCommandTool real Windows PowerShell process', () => {
  it('runs the approved command once and reports its real output and exit code', async () => {
    const { port, requested } = portFor({ directory: root });
    const events: ToolProgressEvent[] = [];

    // 这里验证命令执行和输出，不依赖 Write-Output 额外触发的 PowerShell 模块首次发现与准备。
    // 直接写真实进程的标准输出，保留原超时和全部结果断言。
    const result = await toolFor(port).execute(
      { command: "[Console]::WriteLine('command-ran')" },
      contextWithProgress(events),
    );

    expect(requested).toHaveLength(1);
    const outcome = outcomeOf(result);
    expect(result.status).toBe('success');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.termination).toBe('exited');
    expect(outcome.workingDirectory).toBe(root);
    expect(outcome.stdout).toContain('command-ran');
    expect(outcome.truncated).toBe(false);
    expect(events.some((event) => event.text.includes('command-ran'))).toBe(true);
  });

  it('keeps the exit code and the bounded output when the command fails', async () => {
    const { port } = portFor({ directory: root });

    const result = await toolFor(port).execute(
      { command: "[Console]::WriteLine('before-failure'); [Console]::Error.WriteLine('boom'); exit 3" },
      contextWithProgress([]),
    );

    expect(result.status).toBe('error');
    const outcome = outcomeOf(result);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.termination).toBe('exited');
    expect(outcome.stdout).toContain('before-failure');
    expect(outcome.stderr).toContain('boom');
  });

  it('reports the two streams with their sources and reception order', async () => {
    const { port } = portFor({ directory: root });
    const events: ToolProgressEvent[] = [];

    await toolFor(port).execute(
      { command: "[Console]::WriteLine('标准输出中文'); [Console]::Error.WriteLine('错误输出中文')" },
      contextWithProgress(events),
    );

    const stdout = events.filter((event) => event.stream === 'stdout');
    const stderr = events.filter((event) => event.stream === 'stderr');
    expect(stdout.map((event) => event.text).join('')).toContain('标准输出中文');
    expect(stderr.map((event) => event.text).join('')).toContain('错误输出中文');
    // 序号只表示宿主收到的顺序：它从 0 开始并且不重复。
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index));
  });

  it('decodes UTF-8 written by a native Node child process', async () => {
    const { port } = portFor({ directory: root });
    const scriptPath = join(root, 'print-utf8.cjs');
    await writeFile(scriptPath, "process.stdout.write('子进程中文输出');\n", 'utf8');

    const result = await toolFor(port).execute(
      { command: `& '${process.execPath}' '${scriptPath}'` },
      contextWithProgress([]),
    );

    expect(result.status).toBe('success');
    expect(outcomeOf(result).stdout).toContain('子进程中文输出');
  });

  it('ends a command that exceeds its timeout as a timed-out failure', async () => {
    const { port } = portFor({ directory: root });

    const result = await toolFor(port).execute(
      { command: 'Start-Sleep -Seconds 30', timeoutMs: 500 },
      contextWithProgress([]),
    );

    expect(result.status).toBe('error');
    expect(outcomeOf(result).termination).toBe('timed-out');
  });

  it('ends a cancelled command with AbortError instead of a normal tool failure', async () => {
    const { port } = portFor({ directory: root });
    const controller = new AbortController();
    const pending = toolFor(port).execute(
      { command: 'Start-Sleep -Seconds 30', timeoutMs: 60_000 },
      contextWithProgress([], controller.signal),
    );

    controller.abort();

    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });

  it('bounds large real stdout and stderr while preserving both ends', async () => {
    const { port } = portFor({ directory: root });

    const result = await toolFor(port).execute({
      command: "[Console]::Out.Write(('HEAD-' + ('A' * 70000) + '-TAIL')); [Console]::Error.Write(('ERR-HEAD-' + ('B' * 70000) + '-ERR-TAIL'))",
    }, contextWithProgress([]));

    const outcome = outcomeOf(result);
    expect(result.status).toBe('success');
    expect(outcome.truncated).toBe(true);
    expect(outcome.droppedBytes).toBeGreaterThan(0);
    expect(outcome.stdout).toContain('HEAD-');
    expect(outcome.stdout).toContain('-TAIL');
    expect(outcome.stderr).toContain('ERR-HEAD-');
    expect(outcome.stderr).toContain('-ERR-TAIL');
    expect(Buffer.byteLength(outcome.stdout) + Buffer.byteLength(outcome.stderr)).toBeLessThan(66 * 1024);
  });

  it('cancels the PowerShell, cmd and Node process tree without leaving the grandchild alive', async () => {
    const { port } = portFor({ directory: root });
    const scriptPath = join(root, 'stay-alive.cjs');
    const commandPath = join(root, 'spawn-child.cmd');
    const pidPath = join(root, 'grandchild.pid');
    await writeFile(scriptPath, "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n", 'utf8');
    await writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" "${pidPath}"\r\n`, 'utf8');
    const controller = new AbortController();
    const pending = toolFor(port).execute(
      { command: `& '${commandPath.replaceAll("'", "''")}'`, timeoutMs: 60_000 },
      contextWithProgress([], controller.signal),
    );
    const grandchildPid = await waitForPid(pidPath);
    expect(processIsAlive(grandchildPid)).toBe(true);

    controller.abort();

    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    expect(processIsAlive(grandchildPid)).toBe(false);
  });
});
