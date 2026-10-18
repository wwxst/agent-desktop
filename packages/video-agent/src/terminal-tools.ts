import type { ToolResult } from '@agent-desktop/model';
import { executePreparedAction, type PreparedToolAction, type Tool, type ToolExecutionContext, type ToolPreparation } from '@agent-desktop/tools';

export interface TerminalPort {
  open(command: string, directory: string | undefined, context: ToolExecutionContext): Promise<PreparedToolAction>;
  read(id: string, waitMs: number, context: ToolExecutionContext): Promise<unknown>;
  write(id: string, input: string, context: ToolExecutionContext): Promise<PreparedToolAction>;
  close(id: string, context: ToolExecutionContext): Promise<unknown>;
}
type TerminalToolName = 'open_terminal' | 'read_terminal' | 'write_terminal' | 'close_terminal';
/** 四个明确终端操作共用宿主端口；进程资源始终属于 Desktop 会话，跨轮保持。 */
export class TerminalTool implements Tool {
  // 读取终端只观察已有资源；启动、输入和关闭仍需保留检查点边界。
  get executionBoundary() { return this.name === 'read_terminal' ? 'read-only' as const : 'checkpointed' as const; }
  get contract() {
    // 关闭仅释放本会话已持有的进程资源，与宿主取消相同，不申请新的执行授权。
    return { capability: 'terminal', riskLevel: this.name === 'read_terminal' ? 'read' as const : 'execute' as const,
      parallelSafety: 'serial' as const, workspaceScope: 'session' as const,
      approvalRequirement: this.name === 'open_terminal' || this.name === 'write_terminal' ? 'policy' as const : 'none' as const };
  }
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
    return executePreparedAction(await this.prepare(input, context), context);
  }
  async prepare(input: unknown, context: ToolExecutionContext): Promise<ToolPreparation> {
    context.signal?.throwIfAborted();
    if (typeof input !== 'object' || input === null) return { status: 'error', failureKind: 'permanent', message: '终端参数必须为对象。' };
    const value = input as Record<string, unknown>;
    if (this.name === 'open_terminal') {
      if (typeof value.command !== 'string' || !value.command.trim() || value.command.length > 8000
        || (value.workingDirectory !== undefined && typeof value.workingDirectory !== 'string')) return { status: 'error', failureKind: 'permanent', message: '终端启动需要有效命令与目录。' };
      return this.port.open(value.command, value.workingDirectory as string | undefined, context);
    }
    if (typeof value.terminalId !== 'string' || !value.terminalId) return { status: 'error', failureKind: 'permanent', message: '缺少 terminalId。' };
    if (this.name === 'close_terminal') return {
      // 关闭虽然不再申请用户审批，但仍必须等待 Router 的执行阶段，保证 hooks 能包住真实释放动作。
      requestApproval: async () => true,
      execute: async () => ({ status: 'success', output: await this.port.close(value.terminalId as string, context) }),
    };
    if (this.name === 'read_terminal') {
      const waitMs = value.waitMs ?? 0;
      if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 2000) return { status: 'error', failureKind: 'permanent', message: '终端等待时间必须在 0–2000 毫秒内。' };
      return {
        // 读取终端历史也延迟到执行闭包，避免准备阶段绕过外层 hooks。
        requestApproval: async () => true,
        execute: async () => ({ status: 'success', output: await this.port.read(value.terminalId as string, waitMs, context) }),
      };
    }
    if (typeof value.input !== 'string' || !value.input || value.input.length > 8000) return { status: 'error', failureKind: 'permanent', message: '终端输入不能为空，最多 8000 字。' };
    return this.port.write(value.terminalId, value.input, context);
  }
}
