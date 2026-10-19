import type { ModelToolDefinition, ToolCall, ToolResult } from '@agent-desktop/model';
import { SessionPersistenceError } from '@agent-desktop/session';
import { executePreparedAction, ToolExecutionError, ToolNotExecutedCancellationError, ToolNotExecutedError, type Tool, type ToolContract, type ToolExecutionContext, type ToolRegistry } from './contract.js';

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

/** 子调用在进入工具前被路由拒绝；组合工具可报告能力缺失，不冒充已执行后的错误。 */
export class ToolRoutingError extends ToolExecutionError {
  override readonly name = 'ToolRoutingError';
  constructor(message: string) { super(message, 'permanent'); }
}

/**
 * 所有正式工具执行汇入同一路由；注册表只保留名称与工具事实。
 * 调用身份、Session 保存和执行前策略仍由 Loop 提供，不把宿主协议塞进工具包。
 */
export class ToolRouter {
  constructor(private readonly registry: ToolRegistry, private readonly capabilities?: readonly string[]) {}

  get(name: string): Tool | undefined {
    const tool = this.registry.get(name);
    if (tool === undefined) return;
    const contract = resolveToolContract(tool);
    // 策略工具缺少准备入口时不能进入目录或执行，Loop 会保存明确的 not-executed 事实。
    if (contract.approvalRequirement === 'policy' && tool.prepare === undefined) return;
    return this.capabilities === undefined || this.capabilities.includes(contract.capability) ? tool : undefined;
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
    let executionStarted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new ToolExecutionError(`工具 ${call.name} 执行超时。`,
        !executionStarted || tool.executionBoundary === 'read-only' ? 'transient' : 'unknown-outcome'));
    }, contract.timeoutMs);
    try {
      signal.throwIfAborted();
      // 工具必须通过自己的真实进程/网络边界响应取消；不提前返回并遗留后台副作用。
      const { invokeNestedTool: _parentInvokeNestedTool, ...parentContext } = context;
      const nestedToolNames = tool.nestedToolNames;
      const executionContext: ToolExecutionContext = {
        ...parentContext,
        signal,
        ...(nestedToolNames === undefined ? {} : {
          invokeNestedTool: async (name: string, input: unknown): Promise<ToolResult> => {
            if (!nestedToolNames.includes(name)) {
              throw new ToolRoutingError(`Tool is not allowed as a nested call: ${name}`);
            }
            // 路由拒绝尚未进入子工具；不能让组合工具按 opaque 子工具失败误判未知副作用。
            if (this.get(name) === undefined) throw new ToolRoutingError(`Tool not found: ${name}`);
            // 子工具保留父调用身份与检查点，但重新经过注册表、能力集合和自身执行时限。
            return this.execute({ id: context.toolCallId, name, input }, executionContext);
          },
        }),
      };
      let result: ToolResult;
      if (tool.prepare === undefined) {
        executionStarted = true;
        result = await tool.execute(call.input, executionContext);
      } else {
        const prepared = await tool.prepare(call.input, executionContext);
        result = await executePreparedAction('status' in prepared ? prepared : {
          requestApproval: () => prepared.requestApproval(),
          execute: () => {
            executionStarted = true;
            return prepared.execute();
          },
        }, executionContext);
      }
      if (!executionStarted && result.status === 'error') throw new ToolNotExecutedError(result);
      return result;
    } catch (error) {
      // 保存失败必须原样终止；不能把无法保存的检查点伪装成普通未执行结果。
      if (error instanceof SessionPersistenceError || !(error instanceof Error)) throw error;
      const failure = timedOut && context.signal?.aborted !== true && error.name === 'AbortError'
        ? controller.signal.reason as ToolExecutionError : error;
      // 轮次取消仍由 Loop 直接收尾；不能把取消等待中的审批保存成普通工具结果。
      if (context.signal?.aborted === true) {
        // 取消仍向上抛 AbortError；Loop 另存未执行事实，不制造一个普通工具结果。
        if (!executionStarted && failure.name === 'AbortError') {
          throw failure instanceof ToolNotExecutedCancellationError ? failure : new ToolNotExecutedCancellationError(failure);
        }
        // 已开始的父工具不能继承子工具的未执行证明。
        throw failure instanceof ToolNotExecutedCancellationError ? failure.cancellation : failure;
      }
      if (!executionStarted) {
        if (failure instanceof ToolNotExecutedError) throw failure;
        throw new ToolNotExecutedError({ status: 'error', message: failure.message,
          failureKind: failure instanceof ToolExecutionError ? failure.failureKind : 'permanent' }, { cause: failure });
      }
      // 子工具未执行不能证明已进入执行闭包的父工具没有产生效果。
      if (failure instanceof ToolNotExecutedError) throw new ToolExecutionError(failure.message, failure.failureKind, { cause: failure });
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }
}
