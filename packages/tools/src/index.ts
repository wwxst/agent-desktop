import type { ModelToolDefinition, ToolResult } from '@agent-desktop/model';

// 复用 Model 定义，避免 Tools package 再声明一份可能漂移的模型可见契约。
export type { ModelToolDefinition };

/**
 * Tool 在模型可见描述上增加 execute 运行能力。
 * Tool 只能返回执行结果，不能反向控制 Agent Loop 的生命周期。
 */
export interface Tool extends ModelToolDefinition {
  execute(input: unknown): Promise<ToolResult>;
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

  // 返回新数组，避免调用方改变注册表内部集合。
  list(): readonly Tool[] { return [...this.tools.values()]; }
}
