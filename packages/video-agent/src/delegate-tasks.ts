import type { ToolResult } from '@agent-desktop/model';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';
import type { Session } from '@agent-desktop/session';

export interface ReadOnlyTask { readonly title: string; readonly instruction: string; }
export interface SubagentResult {
  readonly taskId: string; readonly title: string;
  readonly status: 'completed' | 'failed' | 'cancelled' | 'budget-exhausted';
  readonly summary: string; readonly evidence: readonly string[];
}
export type DelegateTasksPort = (task: ReadOnlyTask, context: ToolExecutionContext) => Promise<SubagentResult>;

/** 一轮最多两项明确委派，数量在生产工具边界执行，子 Agent 不注册本工具。 */
export class DelegateTasksTool implements Tool {
  readonly contract = { approvalRequirement: 'none' } as const;
  readonly name = 'delegate_tasks';
  readonly description = '委派一层只读文件检查任务；每轮合计最多两个，可并行，不能写文件或执行命令。';
  readonly inputSchema = { type: 'object', properties: { tasks: { type: 'array', minItems: 1, maxItems: 2,
    items: { type: 'object', properties: { title: { type: 'string' }, instruction: { type: 'string' } },
      required: ['title', 'instruction'], additionalProperties: false } } }, required: ['tasks'], additionalProperties: false };
  private spent = 0;
  private turnId: string | undefined;
  constructor(private readonly run: DelegateTasksPort, private readonly session: Session) {}
  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    const turn = this.session.events().findLast((event) => event.type === 'turn.started');
    if (turn?.type !== 'turn.started') return { status: 'error', message: '委派缺少当前轮次。' };
    // 同一 Agent 可以跨轮复用；预算属于轮次，不能累积到整个会话。
    if (this.turnId !== turn.turnId) { this.turnId = turn.turnId; this.spent = 0; }
    const tasks = (input as { tasks?: unknown } | null)?.tasks;
    if (!Array.isArray(tasks) || tasks.length < 1 || this.spent + tasks.length > 2
      || !tasks.every((task: unknown) => typeof task === 'object' && task !== null
        && typeof (task as ReadOnlyTask).title === 'string' && (task as ReadOnlyTask).title.trim()
        && (task as ReadOnlyTask).title.length <= 200
        && typeof (task as ReadOnlyTask).instruction === 'string' && (task as ReadOnlyTask).instruction.trim()
        && (task as ReadOnlyTask).instruction.length <= 8000)) {
      return { status: 'error', message: '每轮最多委派两个子任务；每项须有标题和明确的只读指令。' };
    }
    this.spent += tasks.length;
    // 等全部子任务收尾后再传播父取消；一个普通失败不取消其他独立任务。
    const settled = await Promise.allSettled(tasks.map((task) => this.run(task as ReadOnlyTask, context)));
    if (context.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    const results = settled.map((item) => { if (item.status === 'rejected') throw item.reason; return item.value; });
    return { status: 'success', output: { tasks: results } };
  }
}
