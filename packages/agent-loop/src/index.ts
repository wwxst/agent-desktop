import { randomUUID } from 'node:crypto';
import type { Agent } from '@agent-desktop/agent';
import { ModelRequestError } from '@agent-desktop/model';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelMessage, ModelResponse, ModelToolDefinition, ToolCall, ToolResult } from '@agent-desktop/model';
import { recoverSessionEvents, type SessionEvent, type StepId, type TurnId } from '@agent-desktop/session';
import type { ToolExecutionContext, ToolProgressEvent } from '@agent-desktop/tools';

/** 一次 Turn 的最小公开结果；不返回可变 Session，调用方通过 Agent 自己读取历史。 */
export interface RunTurnResult {
  readonly turnId: TurnId;
  readonly stepCount: number;
  readonly response: ModelResponse;
}

/** Trace 只描述运行诊断元数据，不复制模型可见的 Session 事实。 */
export type ExecutionTraceEvent =
  | { readonly type: 'turn.started'; readonly turnId: TurnId }
  | { readonly type: 'model.started'; readonly turnId: TurnId; readonly stepId: StepId; readonly messageCount: number; readonly toolDefinitionCount: number }
  | { readonly type: 'model.retrying'; readonly turnId: TurnId; readonly stepId: StepId; readonly attempt: number; readonly waitMs: number; readonly reason: 'transient-service' }
  | { readonly type: 'model.completed'; readonly turnId: TurnId; readonly stepId: StepId; readonly durationMs: number; readonly toolCallCount: number; readonly hasText: boolean }
  | { readonly type: 'model.failed'; readonly turnId: TurnId; readonly stepId: StepId; readonly durationMs: number; readonly errorName: string; readonly errorMessage: string }
  | { readonly type: 'tool.started'; readonly turnId: TurnId; readonly stepId: StepId; readonly toolCallId: ToolCall['id']; readonly toolName: string }
  | { readonly type: 'tool.completed'; readonly turnId: TurnId; readonly stepId: StepId; readonly toolCallId: ToolCall['id']; readonly toolName: string; readonly durationMs: number }
  | { readonly type: 'tool.failed'; readonly turnId: TurnId; readonly stepId: StepId; readonly toolCallId: ToolCall['id']; readonly toolName: string; readonly durationMs: number; readonly errorName?: string }
  | { readonly type: 'turn.completed'; readonly turnId: TurnId; readonly durationMs: number; readonly stepCount: number }
  | { readonly type: 'turn.cancelled'; readonly turnId: TurnId; readonly durationMs: number; readonly stepCount: number }
  | { readonly type: 'turn.failed'; readonly turnId: TurnId; readonly durationMs: number; readonly errorName: string; readonly errorMessage: string };

/** Agent Loop 产生事件，具体持久化方式由当前生产入口提供。 */
export type ExecutionTrace = (event: ExecutionTraceEvent) => void | Promise<void>;

/** Tool Result 已写入 Session 后通知当前宿主；这条内容通道不进入只记录元数据的 Trace。 */
export type ToolResultListener = (
  toolCallId: ToolCall['id'],
  toolName: string,
  result: ToolResult,
) => void | Promise<void>;

/**
 * 工具执行期间的实时进度通知。
 *
 * 进度是同步入队的事实，不写入 Session、不写入诊断 Trace，也不参与模型上下文；
 * 循环只负责转发，批处理、限额和界面投影由宿主负责。
 */
export type ToolProgressListener = (
  toolCallId: ToolCall['id'],
  event: ToolProgressEvent,
) => void | Promise<void>;

function createTurnId(): TurnId {
  // Node.js 原生 UUID 已满足唯一性需求，类型断言只负责附加编译期品牌。
  return randomUUID() as TurnId;
}

function createStepId(): StepId {
  // Step 使用独立品牌，防止在需要 StepId 的位置误传 TurnId。
  return randomUUID() as StepId;
}

/** 把 Session 中的未知工具输出稳定投影为模型协议要求的字符串。 */
function formatToolResultForModel(result: ToolResult): string {
  if (result.status === 'error') {
    // 失败调用可能仍然带有结构化结果（当前是命令的退出码和有界输出），
    // 只交回一条错误文字会让模型拿不到失败原因，因此两者一起交给模型。
    if (result.output === undefined) return result.message;
    const formattedOutput = JSON.stringify(result.output);
    if (formattedOutput === undefined) throw new Error('Tool result output must be JSON-serializable');
    return `${result.message}\n${formattedOutput}`;
  }
  // 字符串保持原样，避免 JSON.stringify 额外添加引号。
  if (typeof result.output === 'string') return result.output;

  // 模型 Tool Message 必须是字符串；没有 JSON 表示时直接暴露程序错误，不用默认文本掩盖。
  const formatted = JSON.stringify(result.output);
  if (formatted === undefined) throw new Error('Tool result output must be JSON-serializable');
  return formatted;
}

/**
 * 每次模型调用前都从 Session 事件重建上下文。
 * 不维护隐藏 messages 数组，确保 Session 始终是唯一事实来源。
 */
function buildModelMessages(events: readonly SessionEvent[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  // Step 完整性只由 Session 的单一权威实现判定；取消或失败 Turn 的残留不会进入模型协议链。
  for (const event of recoverSessionEvents(events)) {
    // 只投影模型需要看到的三类事实，生命周期事件留在 Session 中供审计。
    switch (event.type) {
      case 'user.message':
        messages.push({ role: 'user', content: event.content });
        break;
      case 'assistant.message':
        // exactOptionalPropertyTypes 下，缺少 content 与显式 content: undefined 不等价。
        messages.push(event.content === undefined
          ? { role: 'assistant', toolCalls: event.toolCalls }
          : { role: 'assistant', content: event.content, toolCalls: event.toolCalls });
        break;
      case 'tool.result':
        // ToolCallId 保留调用与结果的关联，格式化只依赖已写入 Session 的结果。
        messages.push({
          role: 'tool',
          toolCallId: event.toolCallId,
          content: formatToolResultForModel(event.result),
        });
        break;
      default:
        // Turn、Step 和 tool.called 是运行事实，不直接进入模型消息。
        break;
    }
  }

  return messages;
}

/** 只向模型暴露工具描述，解构投影会主动排除 execute 运行时方法。 */
function buildToolDefinitions(agent: Agent): ModelToolDefinition[] {
  return agent.tools.list().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }
}

/** 执行单个 Tool Call，并保证调用事件与结果事件使用同一个 ToolCallId。 */
async function executeToolCall(
  agent: Agent,
  turnId: TurnId,
  stepId: StepId,
  toolCall: ToolCall,
  trace?: ExecutionTrace,
  signal?: AbortSignal,
  onToolResult?: ToolResultListener,
  onToolProgress?: ToolProgressListener,
): Promise<void> {
  throwIfAborted(signal);
  // 查找和执行前先记录调用，即使工具不存在或抛错也保留完整起点。
  agent.session.append({
    type: 'tool.called',
    turnId,
    stepId,
    toolCallId: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
  });

  await trace?.({
    type: 'tool.started',
    turnId,
    stepId,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });
  const startedAt = Date.now();

  const tool = agent.tools.get(toolCall.name);
  let result: ToolResult;
  let errorName: string | undefined;

  if (!tool) {
    // 未知工具转换为模型可见错误，而不是中断整个 Turn。
    result = { status: 'error', message: `Tool not found: ${toolCall.name}` };
  } else {
    try {
      // 执行上下文把取消信号、调用身份和进度上报收在一个值里；
      // 进度同步入队，循环不等待界面消费，也不让 Renderer 的消费速度决定命令生命周期。
      const context: ToolExecutionContext = {
        toolCallId: toolCall.id,
        reportProgress: (event) => {
          void onToolProgress?.(toolCall.id, event);
        },
        // exactOptionalPropertyTypes 下，没有取消信号时必须省略字段而不是写入 undefined。
        ...(signal === undefined ? {} : { signal }),
      };
      result = await tool.execute(toolCall.input, context);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // Tool 的 Error 失败按既有契约回写结果；其他抛出值不是合法 Tool 错误，直接暴露程序错误。
      if (!(error instanceof Error)) throw error;
      errorName = error.name;
      result = { status: 'error', message: error.message };
    }
  }

  // 先把真实结果写入 Session，再写完成诊断：
  // 诊断写入失败不能遮蔽已经发生的成功事实（例如一个已经真正发布的文件）。
  agent.session.append({
    type: 'tool.result',
    turnId,
    stepId,
    toolCallId: toolCall.id,
    result,
  });

  const durationMs = Date.now() - startedAt;
  if (result.status === 'success') {
    await trace?.({
      type: 'tool.completed',
      turnId,
      stepId,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      durationMs,
    });
  } else {
    await trace?.(errorName === undefined
      ? {
          type: 'tool.failed',
          turnId,
          stepId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          durationMs,
        }
      : {
          type: 'tool.failed',
          turnId,
          stepId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          durationMs,
          errorName,
        });
  }

  // 宿主只能在结果成为 Session 事实后收到内容，避免界面先于执行历史展示未落盘结果。
  await onToolResult?.(toolCall.id, toolCall.name, result);
  // Tool 已完成的结果先保留在 Session；取消只阻止后续 Model/Tool，不回滚已完成工作。
  throwIfAborted(signal);
}

/**
 * 一次 Turn 的可选运行端口。
 *
 * 位置参数会随能力增加持续变长，因此统一收在一个选项对象里；
 * 这里不引入事件总线，调用方仍然只提供当前真实存在的回调。
 */
export interface RunTurnOptions {
  readonly trace?: ExecutionTrace;
  readonly signal?: AbortSignal;
  readonly onTextDelta?: (delta: string) => void;
  readonly onToolResult?: ToolResultListener;
  readonly onToolProgress?: ToolProgressListener;
  readonly onModelText?: (stepId: StepId, text: string, purpose: 'delta' | 'commentary' | 'final') => void;
  /** 当前只读子任务的真实预算；父任务不默认设置上限。 */
  readonly maxSteps?: number;
}

export class StepBudgetError extends Error {
  override readonly name = 'StepBudgetError';
  constructor() { super('子任务已达到模型步骤上限，尚未完成。'); }
}

/** 从用户输入开始运行一个完整 Turn，直到模型返回零个 Tool Call。 */
export async function runTurn(
  agent: Agent,
  input: string,
  options: RunTurnOptions = {},
): Promise<RunTurnResult> {
  const { trace, signal, onTextDelta, onToolResult, onToolProgress, onModelText, maxSteps } = options;
  const turnId = createTurnId();
  let stepCount = 0;
  let extraRequests = 0;
  const turnStartedAt = Date.now();

  await trace?.({ type: 'turn.started', turnId });

  try {
    // Turn 生命周期先于用户消息写入，固定 Session 中的事实顺序。
    agent.session.append({ type: 'turn.started', turnId });
    agent.session.append({ type: 'user.message', turnId, content: input });

    while (true) {
      throwIfAborted(signal);
      if (maxSteps !== undefined && stepCount >= maxSteps) throw new StepBudgetError();
      // 一次 Model.complete 调用严格对应一个新 Step。
      const stepId = createStepId();
      stepCount += 1;
      agent.session.append({ type: 'step.started', turnId, stepId });

      // System Prompt、历史消息和工具描述都从 Agent 的当前依赖即时构建。
      const messages = buildModelMessages(agent.session.events());
      const tools = buildToolDefinitions(agent);
      await trace?.({
        type: 'model.started',
        turnId,
        stepId,
        messageCount: messages.length,
        toolDefinitionCount: tools.length,
      });

      const modelStartedAt = Date.now();
      let response: ModelResponse;
      try {
        const request = {
          systemPrompt: agent.systemPrompt.build(),
          messages,
          tools,
          ...(signal === undefined ? {} : { signal }),
          // 文本增量只向上转发给实时展示，不会写入 Session。
          ...(onModelText === undefined ? (onTextDelta === undefined ? {} : { onTextDelta }) : { onTextDelta: (delta: string) => {
            onTextDelta?.(delta);
            onModelText?.(stepId, delta, 'delta');
          } }),
        };
        try {
          response = await agent.model.complete(request);
        } catch (error) {
          // 只重试当前尚未产生有效响应的请求；工具与既有步骤不重放。
          if (!(error instanceof ModelRequestError) || error.kind !== 'transient-service'
            || extraRequests >= 2 || (error.retryAfterMs ?? 1000) > 10_000) throw error;
          const waitMs = error.retryAfterMs ?? 1000;
          extraRequests += 1;
          await trace?.({ type: 'model.retrying', turnId, stepId, attempt: 2, waitMs, reason: 'transient-service' });
          await delay(waitMs, undefined, { signal });
          throwIfAborted(signal);
          response = await agent.model.complete(request);
        }
      } catch (error) {
        // 非 Error 抛出值继续直接传播，不为 Trace 制造默认错误文本。
        if (!(error instanceof Error)) throw error;
        if (error.name === 'AbortError') throw error;
        await trace?.({
          type: 'model.failed',
          turnId,
          stepId,
          durationMs: Date.now() - modelStartedAt,
          errorName: error.name,
          errorMessage: error.message,
        });
        throw error;
      }

      await trace?.({
        type: 'model.completed',
        turnId,
        stepId,
        durationMs: Date.now() - modelStartedAt,
        toolCallCount: response.toolCalls.length,
        hasText: response.text !== undefined,
      });

      // 先完整记录模型响应；文本与 Tool Calls 可以同时存在。
      agent.session.append(response.text === undefined
        ? { type: 'assistant.message', turnId, stepId, toolCalls: response.toolCalls }
        : { type: 'assistant.message', turnId, stepId, content: response.text, toolCalls: response.toolCalls });

      // 完整响应才能确认文字用途；临时片段不成为历史事实。
      onModelText?.(stepId, response.text ?? '', response.toolCalls.length === 0 ? 'final' : 'commentary');

      // 多个工具调用按响应顺序串行执行，保证事件顺序确定且同属当前 Step。
      for (const toolCall of response.toolCalls) {
        await executeToolCall(agent, turnId, stepId, toolCall, trace, signal, onToolResult, onToolProgress);
      }

      // 所有工具结果写入后才完成 Step，下一次模型调用才能看到完整结果。
      agent.session.append({ type: 'step.completed', turnId, stepId });

      if (response.toolCalls.length === 0) {
        // 零 Tool Call 是 MVP 的自然终止条件，完成 Turn 后返回最后模型响应。
        agent.session.append({ type: 'turn.completed', turnId });
        await trace?.({
          type: 'turn.completed',
          turnId,
          durationMs: Date.now() - turnStartedAt,
          stepCount,
        });
        return { turnId, stepCount, response };
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      await trace?.({
        type: 'turn.cancelled',
        turnId,
        durationMs: Date.now() - turnStartedAt,
        stepCount,
      });
      throw error;
    }
    // runTurn 的 Error 异常记录后仍按原语义向上传播。
    if (!(error instanceof Error)) throw error;
    await trace?.({
      type: 'turn.failed',
      turnId,
      durationMs: Date.now() - turnStartedAt,
      errorName: error.name,
      errorMessage: error.message,
    });
    throw error;
  }
}
