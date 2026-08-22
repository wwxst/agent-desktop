import type { ModelToolDefinition } from '@agent-desktop/model';

export type { ModelToolDefinition };

export type ToolExecutionResult =
  | { readonly status: 'success'; readonly output: unknown }
  | { readonly status: 'error'; readonly message: string; readonly code?: string };

/** A callable capability; execution does not control the Agent Loop. */
export interface Tool extends ModelToolDefinition {
  execute(input: unknown): Promise<ToolExecutionResult>;
}

/** Registry for discovery only; it does not execute tools. */
export interface ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  list(): readonly Tool[];
}

/** Small deterministic registry with explicit duplicate-name rejection. */
export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined { return this.tools.get(name); }

  list(): readonly Tool[] { return [...this.tools.values()]; }
}
