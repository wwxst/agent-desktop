import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspacePort } from '@agent-desktop/local-tools';
import { runTurn } from '@agent-desktop/agent-loop';
import type { Model } from '@agent-desktop/model';
import { InMemorySession, projectRecoveryFacts } from '@agent-desktop/session';
import { InMemoryToolRegistry, ToolExecutionError, type ToolExecutionContext } from '@agent-desktop/tools';
import { TerminalTool } from '../../../packages/video-agent/src/terminal-tools.js';
import { taskToolGate } from '../src/main/agent-task-state.js';
import { terminalPortFor, type SessionTerminal } from '../src/main/terminal-host.js';

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node-pty', () => native);
const context: ToolExecutionContext = { toolCallId: 'input' as never, reportProgress: () => {} };
beforeEach(() => {
  native.spawn.mockReset();
  // 本文件替换原生 PTY，只验证审批和归属；真实 PowerShell 由 Windows 进程测试覆盖。
  vi.stubEnv('SystemRoot', process.env.SystemRoot ?? 'C:/Windows');
});
afterEach(() => vi.unstubAllEnvs());

describe('terminal authorization and ownership', () => {
  it('rejects a terminal before asking for approval when its process cannot be network-isolated', async () => {
    const requestApproval = vi.fn(async () => true);
    const assertProcessLaunch = vi.fn((target: string) => {
      throw new ToolExecutionError(`受限网络策略不能启动${target}。`, 'denied');
    });
    const workspace: WorkspacePort = { confirmedDirectory: () => process.cwd(), confirmDirectory: vi.fn(), requestApproval };
    const touched = vi.fn();
    const port = terminalPortFor({}, workspace, vi.fn(), touched, assertProcessLaunch);

    await expect(port.open('echo hello', undefined, context)).rejects.toMatchObject({ failureKind: 'denied' });

    expect(assertProcessLaunch).toHaveBeenCalledExactlyOnceWith('会话终端');
    expect(requestApproval).not.toHaveBeenCalled();
    expect(native.spawn).not.toHaveBeenCalled();
    expect(touched).not.toHaveBeenCalled();
  });

  it('does not create a PTY before or after rejected start authorization', async () => {
    let answer!: (approved: boolean) => void;
    const workspace: WorkspacePort = { confirmedDirectory: () => process.cwd(), confirmDirectory: vi.fn(),
      requestApproval: () => new Promise((resolve) => { answer = resolve; }) };
    const touched = vi.fn();
    const port = terminalPortFor({}, workspace, vi.fn(), touched, vi.fn());
    const pending = port.open('echo hello', undefined, context);
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    expect(native.spawn).not.toHaveBeenCalled();
    answer(false);
    await expect(pending).rejects.toMatchObject({
      constructor: ToolExecutionError,
      failureKind: 'denied',
      message: expect.stringContaining('拒绝'),
    });
    expect(native.spawn).not.toHaveBeenCalled();
    expect(touched).not.toHaveBeenCalled();
  });
  it('approves each exact input separately and rejects cross-session identifiers', async () => {
    const write = vi.fn();
    const requestApproval = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const workspace: WorkspacePort = { confirmedDirectory: () => process.cwd(), confirmDirectory: vi.fn(), requestApproval };
    const terminal = { terminalId: 'owned', workingDirectory: process.cwd(), write, snapshot: () => ({ status: 'running' }) } as unknown as SessionTerminal;
    const port = terminalPortFor({ terminal }, workspace, vi.fn(), vi.fn(), vi.fn());
    await expect(port.write('other-session', 'echo unsafe\n', context)).rejects.toThrow('不属于');
    expect(requestApproval).not.toHaveBeenCalled();
    await expect(port.write('owned', 'echo denied\n', context)).rejects.toMatchObject({
      constructor: ToolExecutionError,
      failureKind: 'denied',
      message: expect.stringContaining('拒绝'),
    });
    expect(write).not.toHaveBeenCalled();
    await port.write('owned', 'echo accepted\n', context);
    expect(requestApproval).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'terminal-input', command: 'echo accepted\n' }), undefined);
    expect(write).toHaveBeenCalledExactlyOnceWith('echo accepted\n');
  });

  it('records terminal approval denial so the same turn cannot request it again', async () => {
    const requestApproval = vi.fn(async () => false);
    const workspace: WorkspacePort = { confirmedDirectory: () => process.cwd(), confirmDirectory: vi.fn(), requestApproval };
    const session = new InMemorySession();
    const tools = new InMemoryToolRegistry();
    tools.register(new TerminalTool('open_terminal', terminalPortFor({}, workspace, vi.fn(), vi.fn(), vi.fn())));
    let request = 0;
    const model: Model = { complete: async () => ++request === 1
      ? { toolCalls: [
          { id: 'first' as never, name: 'open_terminal', input: { command: 'echo denied' } },
          { id: 'repeat' as never, name: 'open_terminal', input: { command: 'echo denied' } },
        ] }
      : { text: '启动请求已拒绝。', toolCalls: [] } };

    await runTurn({ session, tools, model, systemPrompt: { build: () => '终端审批' } }, '启动终端', {
      beforeToolCall: input => taskToolGate(session.events(), input),
    });

    expect(requestApproval).toHaveBeenCalledOnce();
    expect(native.spawn).not.toHaveBeenCalled();
    expect(session.events().filter(event => event.type === 'tool.result').map(event => event.result)).toMatchObject([
      { status: 'error', failureKind: 'denied' }, { status: 'error', failureKind: 'permanent' },
    ]);
    expect(session.events().find(event => event.type === 'tool.called' && event.toolCallId === 'repeat'))
      .toMatchObject({ boundary: 'not-executed' });
    expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);
  });

  it('reads disconnected history after restart without reconnecting or marking a live terminal touched', async () => {
    const history = { terminalId: 'old-terminal', workingDirectory: process.cwd(), command: 'npm run dev',
      output: 'old output', droppedBytes: 0, status: 'running' as const, exitCode: null };
    const touched = vi.fn();
    const port = terminalPortFor({ terminalHistory: history },
      { confirmedDirectory: () => process.cwd(), confirmDirectory: vi.fn(), requestApproval: vi.fn() }, vi.fn(), touched, vi.fn());

    await expect(port.read(history.terminalId, 2_000, context)).resolves.toEqual({ ...history, status: 'disconnected' });
    expect(touched).not.toHaveBeenCalled();
    expect(native.spawn).not.toHaveBeenCalled();
  });
});
