import type { ToolResult } from '@agent-desktop/model';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';

export interface TerminalPort {
  open(command: string, directory: string | undefined, context: ToolExecutionContext): Promise<unknown>;
  read(id: string, waitMs: number, context: ToolExecutionContext): Promise<unknown>;
  write(id: string, input: string, context: ToolExecutionContext): Promise<unknown>;
  close(id: string, context: ToolExecutionContext): Promise<unknown>;
}
type TerminalToolName = 'open_terminal' | 'read_terminal' | 'write_terminal' | 'close_terminal';
/** 四个明确终端操作共用宿主端口；进程资源始终属于 Desktop 会话，跨轮保持。 */
export class TerminalTool implements Tool {
  readonly executionBoundary = 'checkpointed' as const;
  readonly description: string;
  readonly inputSchema: unknown;
  constructor(readonly name: TerminalToolName, private readonly port: TerminalPort) {
    this.description = name === 'open_terminal' ? '经逐次审批启动本会话的交互终端，跨轮可用。'
      : name === 'write_terminal' ? '经逐次审批向本会话终端发送确切输入；执行命令时在 input 末尾包含换行。'
        : name === 'read_terminal' ? '读取本会话终端的有界输出与存活状态；最多等待 2 秒，不推测命令退出码。' : '关闭本会话终端及其进程树。';
    this.inputSchema = { type: 'object', properties: name === 'open_terminal'
      ? { command: { type: 'string' }, workingDirectory: { type: 'string' } }
      : { terminalId: { type: 'string' }, ...(name === 'write_terminal' ? { input: { type: 'string' } } : name === 'read_terminal' ? { waitMs: { type: 'number', minimum: 0, maximum: 2000 } } : {}) },
      required: name === 'open_terminal' ? ['command'] : name === 'write_terminal' ? ['terminalId', 'input'] : ['terminalId'], additionalProperties: false };
  }
  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    if (typeof input !== 'object' || input === null) return { status: 'error', failureKind: 'permanent', message: '终端参数必须为对象。' };
    const value = input as Record<string, unknown>;
    if (this.name === 'open_terminal') {
      if (typeof value.command !== 'string' || !value.command.trim() || value.command.length > 8000
        || (value.workingDirectory !== undefined && typeof value.workingDirectory !== 'string')) return { status: 'error', failureKind: 'permanent', message: '终端启动需要有效命令与目录。' };
      return { status: 'success', output: await this.port.open(value.command, value.workingDirectory as string | undefined, context) };
    }
    if (typeof value.terminalId !== 'string' || !value.terminalId) return { status: 'error', failureKind: 'permanent', message: '缺少 terminalId。' };
    if (this.name === 'close_terminal') return { status: 'success', output: await this.port.close(value.terminalId, context) };
    if (this.name === 'read_terminal') {
      const waitMs = value.waitMs ?? 0;
      if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 2000) return { status: 'error', failureKind: 'permanent', message: '终端等待时间必须在 0–2000 毫秒内。' };
      return { status: 'success', output: await this.port.read(value.terminalId, waitMs, context) };
    }
    if (typeof value.input !== 'string' || !value.input || value.input.length > 8000) return { status: 'error', failureKind: 'permanent', message: '终端输入不能为空，最多 8000 字。' };
    return { status: 'success', output: await this.port.write(value.terminalId, value.input, context) };
  }
}
