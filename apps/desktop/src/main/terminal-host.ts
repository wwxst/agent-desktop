import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, type IPty } from 'node-pty';
import { BoundedTextBuffer, resolveScopedPath, type WorkspacePort } from '@agent-desktop/local-tools';
import type { TerminalSnapshot } from '@agent-desktop/client';
import type { TerminalPort } from '@agent-desktop/video-agent';
import { createCommandPort } from './command-host.js';

/** 一个会话的真实终端资源；快照只是历史，不能用于创建或重连进程。 */
export class SessionTerminal {
  readonly terminalId = randomUUID();
  private readonly process: IPty;
  private readonly output = new BoundedTextBuffer(0, 64 * 1024);
  private status: 'running' | 'exited' = 'running';
  private exitCode: number | null = null;
  private readonly finished: Promise<void>;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private closing: Promise<void> | undefined;
  constructor(readonly workingDirectory: string, readonly command: string, private readonly publish: (snapshot: TerminalSnapshot) => void) {
    const port = createCommandPort();
    // 编码参数保留完整启动命令；NoExit 让同会话后续轮次仍能向 shell 输入。
    this.process = spawn(port.interpreterPath, ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      name: 'xterm-256color', cols: 80, rows: 14, cwd: workingDirectory, env: port.environment as Record<string, string>, useConpty: true,
    });
    this.finished = new Promise((resolve) => this.process.onExit(({ exitCode }) => {
      this.status = 'exited'; this.exitCode = exitCode;
      if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
      this.publish(this.snapshot()); resolve();
    }));
    this.process.onData((text) => {
      this.output.append(text);
      if (this.flushTimer === undefined) this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined; this.publish(this.snapshot());
      }, 50);
    });
    this.publish(this.snapshot());
  }
  snapshot(): TerminalSnapshot {
    return { terminalId: this.terminalId, workingDirectory: this.workingDirectory, command: this.command,
      output: this.output.text(), droppedBytes: this.output.droppedBytes(), status: this.status, exitCode: this.exitCode };
  }
  write(input: string): void {
    if (this.status !== 'running') throw new Error('终端连接已结束。');
    this.process.write(input.replace(/\r?\n/g, '\r'));
  }
  resize(cols: number, rows: number): void { if (this.status === 'running') this.process.resize(cols, rows); }
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    if (this.status !== 'running') return Promise.resolve();
    this.closing = (async () => {
      // 先结束 shell 及后代，再释放 ConPTY 句柄，避免留下终端启动的开发服务。
      await new Promise<void>((resolve, reject) => execFile('taskkill.exe', ['/PID', String(this.process.pid), '/T', '/F'], { windowsHide: true }, (error) => {
        if (error && this.status === 'running') reject(error); else resolve();
      }));
      this.process.kill(); await this.finished;
    })();
    return this.closing;
  }
}

interface TerminalOwner { terminal?: SessionTerminal; terminalHistory?: TerminalSnapshot; }
/** 同一会话跨轮复用，模型和 IPC 都校验宿主生成的终端标识。 */
export function terminalPortFor(owner: TerminalOwner, workspace: WorkspacePort,
  publish: (snapshot: TerminalSnapshot) => void, touched: () => void): TerminalPort {
  const current = (id: string): SessionTerminal => {
    if (owner.terminal?.terminalId !== id) throw new Error('终端不属于当前会话，或连接已结束。');
    return owner.terminal;
  };
  return {
    open: async (command, directory, context) => {
      if (owner.terminal?.snapshot().status === 'running') throw new Error('本会话已有运行中的终端，请先关闭。');
      const scoped = await resolveScopedPath(workspace.confirmedDirectory(), directory);
      if (!scoped.ok) throw new Error(scoped.message);
      if (!(await stat(scoped.path)).isDirectory()) throw new Error('终端执行起点不是目录。');
      const approved = await workspace.requestApproval({ kind: 'terminal-start', command, workingDirectory: scoped.path,
        interpreter: createCommandPort().interpreterPath }, context.signal);
      context.signal?.throwIfAborted();
      if (!approved) throw new Error('用户拒绝启动终端，没有创建进程。');
      touched();
      owner.terminal = new SessionTerminal(scoped.path, command, (snapshot) => { owner.terminalHistory = snapshot; publish(snapshot); });
      return owner.terminal.snapshot();
    },
    read: async (id, waitMs, context) => {
      const terminal = current(id); touched();
      if (waitMs > 0) await delay(waitMs, undefined, { signal: context.signal });
      return terminal.snapshot();
    },
    write: async (id, input, context) => {
      const terminal = current(id);
      const approved = await workspace.requestApproval({ kind: 'terminal-input', command: input,
        workingDirectory: terminal.workingDirectory, interpreter: createCommandPort().interpreterPath }, context.signal);
      context.signal?.throwIfAborted();
      if (!approved) throw new Error('用户拒绝终端输入，没有发送。');
      touched(); terminal.write(input); return terminal.snapshot();
    },
    close: async (id) => { const terminal = current(id); touched(); await terminal.close(); return terminal.snapshot(); },
  };
}
