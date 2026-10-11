import type { ModelToolDefinition, ToolCallId, ToolFailureKind, ToolResult } from '@agent-desktop/model';
import type { ExecutionBoundary } from '@agent-desktop/session';

export { UpdatePlanTool } from './plan.js';

// 复用 Model 定义，避免 Tools package 再声明一份可能漂移的模型可见契约。
export type { ModelToolDefinition };

/**
 * 工具执行期间向上报告的实时进度事件。
 *
 * 首期只定义一种有真实消费者的进度：`command.output`。它承载来源、顺序和有界文本片段，
 * 因此不把任意 `unknown` 负载或视频语义塞进通用契约。
 */
export type ToolProgressEvent = {
  readonly kind: 'command.output';
  readonly stream: 'stdout' | 'stderr';
  /** 宿主收到的顺序序号，只表示接收顺序，不声称两条流之间有操作系统保证的精确顺序。 */
  readonly sequence: number;
  readonly text: string;
  /** 队列超限被丢弃的字节数；它只说明这段文本不连续，不代表命令成功或失败。 */
  readonly droppedBytes?: number;
};

/**
 * 一次工具调用可用的运行上下文。
 *
 * 它把取消信号、调用身份和进度上报收在一个值里，避免位置参数继续增长；
 * 工具仍然只返回最终结果，不能通过上下文反向控制 Agent Loop。
 */
export interface ToolExecutionContext {
  readonly signal?: AbortSignal;
  readonly toolCallId: ToolCallId;
  /** 同步入队：工具不等待界面消费，也不把 IPC Promise 带进工具契约。 */
  readonly reportProgress: (event: ToolProgressEvent) => void;
  /**
   * 在真实副作用前同步保存准备事实；保存失败直接抛出，工具不能继续写入。
   * Loop 的生产上下文始终提供它；直接调用工具的入口可以不启用持久检查点。
   */
  readonly checkpoint?: (data: unknown) => void;
}

/** 工具边界可抛出有分类的真实失败；保留 cause，不把原始异常换成默认文本。 */
export class ToolExecutionError extends Error {
  override readonly name = 'ToolExecutionError';
  constructor(message: string, readonly failureKind: ToolFailureKind, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Tool 在模型可见描述上增加 execute 运行能力。
 * Tool 只能返回执行结果，不能反向控制 Agent Loop 的生命周期。
 */
export interface Tool extends ModelToolDefinition {
  /** 可证明执行边界的工具才声明 checkpointed；其他工具按 opaque 处理。 */
  readonly executionBoundary?: ExecutionBoundary;
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}

/** 工具注册表只负责注册、查找和枚举，不承担工具执行或循环调度。 */
export interface ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  list(): readonly Tool[];
}

/** 使用 Map 保持按注册顺序枚举，并对重复名称给出确定错误。 */
export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    // 同名覆盖会静默改变 Agent 能力，因此在边界处直接拒绝。
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined { return this.tools.get(name); }

  // 按 Map 的注册顺序将工具转换为只读数组供调用方枚举。
  list(): readonly Tool[] { return [...this.tools.values()]; }
}
