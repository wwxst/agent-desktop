import type { ModelToolDefinition, ToolCall, ToolResult } from '@agent-desktop/model';
import { ToolExecutionError, type Tool, type ToolContract, type ToolExecutionContext, type ToolRegistry } from './contract.js';

/** 未声明的能力不伪装成本地工具；并行与免审批都必须有显式合约。 */
export function resolveToolContract(tool: Tool): ToolContract {
  return {
    capability: 'unknown', riskLevel: 'unknown', parallelSafety: 'serial', outputSchema: {}, timeoutMs: 120_000,
    cancellation: 'signal', workspaceScope: 'session', approvalRequirement: 'policy',
    ...tool.contract,
  };
}

export interface CapabilityCatalogEntry extends ModelToolDefinition {
  readonly contract: ToolContract;
  readonly executionBoundary: NonNullable<Tool['executionBoundary']>;
}

/**
 * 所有正式工具执行汇入同一路由；注册表只保留名称与工具事实。
 * 调用身份、Session 保存和执行前策略仍由 Loop 提供，不把宿主协议塞进工具包。
 */
export class ToolRouter {
  constructor(private readonly registry: ToolRegistry, private readonly capabilities?: readonly string[]) {}

  get(name: string): Tool | undefined {
    const tool = this.registry.get(name);
    return tool !== undefined && (this.capabilities === undefined || this.capabilities.includes(resolveToolContract(tool).capability))
      ? tool : undefined;
  }

  catalog(): readonly CapabilityCatalogEntry[] {
    return this.registry.list().filter(tool => this.get(tool.name) !== undefined).map(tool => ({
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
      contract: resolveToolContract(tool), executionBoundary: tool.executionBoundary ?? 'opaque',
    }));
  }

  definitions(): ModelToolDefinition[] {
    return this.catalog().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  canParallel(call: ToolCall): boolean {
    const tool = this.get(call.name);
    return tool?.executionBoundary === 'read-only' && resolveToolContract(tool).parallelSafety === 'safe';
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.get(call.name);
    if (tool === undefined) return { status: 'error', failureKind: 'permanent', message: `Tool not found: ${call.name}` };
    const contract = resolveToolContract(tool);
    const controller = new AbortController();
    const signal = context.signal === undefined ? controller.signal : AbortSignal.any([context.signal, controller.signal]);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new ToolExecutionError(`工具 ${call.name} 执行超时。`,
        tool.executionBoundary === 'read-only' ? 'transient' : 'unknown-outcome'));
    }, contract.timeoutMs);
    try {
      signal.throwIfAborted();
      // 工具必须通过自己的真实进程/网络边界响应取消；不提前返回并遗留后台副作用。
      return await tool.execute(call.input, { ...context, signal });
    } catch (error) {
      if (timedOut && context.signal?.aborted !== true && error instanceof Error && error.name === 'AbortError') {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
