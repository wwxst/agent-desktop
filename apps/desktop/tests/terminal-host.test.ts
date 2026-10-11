import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspacePort } from '@agent-desktop/local-tools';
import type { ToolExecutionContext } from '@agent-desktop/tools';
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
  it('does not create a PTY before or after rejected start authorization', async () => {
    let answer!: (approved: boolean) => void;
    const workspace: WorkspacePort = { confirmedDirectory: () => process.cwd(), confirmDirectory: vi.fn(),
      requestApproval: () => new Promise((resolve) => { answer = resolve; }) };
    const touched = vi.fn();
    const port = terminalPortFor({}, workspace, vi.fn(), touched);
    const pending = port.open('echo hello', undefined, context);
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    expect(native.spawn).not.toHaveBeenCalled();
    answer(false);
    await expect(pending).rejects.toThrow('拒绝');
    expect(native.spawn).not.toHaveBeenCalled();
    expect(touched).not.toHaveBeenCalled();
  });
  it('approves each exact input separately and rejects cross-session identifiers', async () => {
    const write = vi.fn();
    const requestApproval = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const workspace: WorkspacePort = { confirmedDirectory: () => process.cwd(), confirmDirectory: vi.fn(), requestApproval };
    const terminal = { terminalId: 'owned', workingDirectory: process.cwd(), write, snapshot: () => ({ status: 'running' }) } as unknown as SessionTerminal;
    const port = terminalPortFor({ terminal }, workspace, vi.fn(), vi.fn());
    await expect(port.write('other-session', 'echo unsafe\n', context)).rejects.toThrow('不属于');
    expect(requestApproval).not.toHaveBeenCalled();
    await expect(port.write('owned', 'echo denied\n', context)).rejects.toThrow('拒绝');
    expect(write).not.toHaveBeenCalled();
    await port.write('owned', 'echo accepted\n', context);
    expect(requestApproval).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'terminal-input', command: 'echo accepted\n' }), undefined);
    expect(write).toHaveBeenCalledExactlyOnceWith('echo accepted\n');
  });
});
