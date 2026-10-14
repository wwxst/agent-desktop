import { randomUUID } from 'node:crypto';
import type { Agent } from '@agent-desktop/agent';
import { ModelRequestError } from '@agent-desktop/model';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelResponse, ModelToolDefinition, ToolCall, ToolResult } from '@agent-desktop/model';
import { SessionPersistenceError, TurnCancellationError, projectTurnState,
  type ExecutionBoundary, type QualifyToolEvidence, type RecoveryMode, type SessionEvent, type StepId, type ToolCalledEvent, type TurnId } from '@agent-desktop/session';
import { ToolExecutionError, type Tool, type ToolExecutionContext, type ToolProgressEvent } from '@agent-desktop/tools';
import { prepareModelContext, type ContextBudget } from './context.js';

export { ContextBudgetError, estimateContextTokens, createContextSourceDigest, validateContextCompactedEvent,
  type ContextBudget } from './context.js';

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

/** 只准备起点事实；Desktop 可在任何外部准备之前与消息绑定一起原子保存。 */
export function prepareTurnStart(
  input: string,
  recovery?: { readonly sourceTurnId: TurnId; readonly mode: RecoveryMode },
): { readonly turnId: TurnId; readonly events: readonly SessionEvent[] } {
  const turnId = createTurnId();
  const events: SessionEvent[] = [
    { type: 'turn.started', turnId },
    { type: 'user.message', turnId, content: input },
  ];
  if (recovery !== undefined) events.push({ type: 'turn.recovery.started', turnId, ...recovery });
  return { turnId, events };
}

function createStepId(): StepId {
  // Step 使用独立品牌，防止在需要 StepId 的位置误传 TurnId。
  return randomUUID() as StepId;
}

/** 只向模型暴露工具描述，解构投影会主动排除 execute 运行时方法。 */
function buildToolDefinitions(agent: Agent): ModelToolDefinition[] {
  return agent.tools.list().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    // 保存错误是致命事实，不能在取消检查中被普通 AbortError 覆盖。
    if (signal.reason instanceof SessionPersistenceError) throw signal.reason;
    if (signal.reason instanceof TurnCancellationError) throw signal.reason;
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
  beforeToolCall?: RunTurnOptions['beforeToolCall'],
): Promise<void> {
  throwIfAborted(signal);
  const tool = agent.tools.get(toolCall.name);
  const sourceEventIndex = agent.session.events().length;
  const decision = beforeToolCall?.({ turnId, stepId, call: toolCall, tool, sourceEventIndex });
  const boundary = decision?.boundary ?? tool?.executionBoundary;
  const called: ToolCalledEvent = {
    type: 'tool.called',
    turnId,
    stepId,
    toolCallId: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    ...(boundary === undefined ? {} : { boundary }),
  };
  if (tool === undefined || decision?.blocked !== undefined) {
    const result: ToolResult = { status: 'error', failureKind: 'permanent',
      message: decision?.blocked?.message ?? `Tool not found: ${toolCall.name}`,
      ...(decision?.blocked === undefined ? {} : { output: { sourceEventIndexes: decision.blocked.sourceEventIndexes } }) };
    if (tool === undefined && decision?.blocked === undefined) {
      const startedAt = Date.now();
      await trace?.({ type: 'tool.started', turnId, stepId, toolCallId: toolCall.id, toolName: toolCall.name });
      agent.session.appendMany([{ ...called, boundary: 'not-executed' },
        { type: 'tool.result', turnId, stepId, toolCallId: toolCall.id, result }]);
      await trace?.({ type: 'tool.failed', turnId, stepId, toolCallId: toolCall.id,
        toolName: toolCall.name, durationMs: Date.now() - startedAt });
      await onToolResult?.(toolCall.id, toolCall.name, result);
      throwIfAborted(signal);
      return;
    }
    agent.session.appendMany([{ ...called, boundary: 'not-executed' },
      { type: 'tool.result', turnId, stepId, toolCallId: toolCall.id, result }]);
    await onToolResult?.(toolCall.id, toolCall.name, result);
    throwIfAborted(signal);
    return;
  }
  agent.session.append(called);

  await trace?.({
    type: 'tool.started',
    turnId,
    stepId,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });
  const startedAt = Date.now();

  let result: ToolResult;
  let errorName: string | undefined;

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
        checkpoint: (data) => agent.session.append({ type: 'tool.effect.prepared', turnId, sourceEventIndex, data }),
      };
      result = await tool.execute(toolCall.input, context);
  } catch (error) {
    if (error instanceof SessionPersistenceError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (!(error instanceof Error)) throw error;
    errorName = error.name;
    result = { status: 'error', message: error.message,
      ...(error instanceof ToolExecutionError ? { failureKind: error.failureKind } : {}) };
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
  /** 包含门禁拦截的调用尝试；只在明确的恢复轮次设置。 */
  readonly maxToolCalls?: number;
  /** 宿主在每次工具调用前同步读取当前事实。 */
  readonly beforeToolCall?: (input: {
    readonly turnId: TurnId; readonly stepId: StepId; readonly call: ToolCall;
    readonly tool: Tool | undefined; readonly sourceEventIndex: number;
  }) => {
    readonly boundary: Exclude<ExecutionBoundary, 'not-executed'>;
    readonly blocked?: { readonly message: string; readonly sourceEventIndexes: readonly number[] };
  };
  /** 只有宿主明确窗口和供应商实际输出上限时启用，不猜测模型默认值。 */
  readonly contextBudget?: ContextBudget;
  /** 宿主同一个证据资格规则同时供计划投影和模型来源目录使用。 */
  readonly qualifyToolEvidence?: QualifyToolEvidence;
}

export class StepBudgetError extends Error {
  override readonly name = 'StepBudgetError';
  constructor() { super('子任务已达到模型步骤上限，尚未完成。'); }
}

export class ToolBudgetError extends Error {
  override readonly name = 'ToolBudgetError';
  constructor() { super('任务已达到工具调用上限，尚未完成。'); }
}

/** 从用户输入开始运行一个完整 Turn，直到模型返回零个 Tool Call。 */
export async function runTurn(
  agent: Agent,
  input: string,
  options: RunTurnOptions = {},
): Promise<RunTurnResult> {
  const start = prepareTurnStart(input);
  agent.session.appendMany(start.events);
  return runStartedTurn(agent, start.turnId, options);
}

/** 执行已经持久化的起点，不再次创建 Turn 或用户消息。 */
export async function runStartedTurn(
  agent: Agent,
  turnId: TurnId,
  options: RunTurnOptions = {},
): Promise<RunTurnResult> {
  const history = agent.session.events();
  const latestStart = history.findLast(event => event.type === 'turn.started');
  if (latestStart?.turnId !== turnId || projectTurnState(history, turnId) !== 'started'
    || history.some(event => event.turnId === turnId && event.type === 'step.started')) {
    throw new Error('Turn 必须是最新且尚未执行的已提交起点。');
  }
  const { trace, signal, onTextDelta, onToolResult, onToolProgress, onModelText, maxSteps, maxToolCalls, beforeToolCall } = options;
  let stepCount = 0;
  let toolCallCount = 0;
  let extraRequests = 0;
  const turnStartedAt = Date.now();

  try {
    await trace?.({ type: 'turn.started', turnId });
    while (true) {
      throwIfAborted(signal);
      if (maxSteps !== undefined && stepCount >= maxSteps) throw new StepBudgetError();
      // 一次 Model.complete 调用严格对应一个新 Step。
      const stepId = createStepId();
      stepCount += 1;
      agent.session.append({ type: 'step.started', turnId, stepId });

      // System Prompt、历史消息和工具描述都从 Agent 的当前依赖即时构建。
      const tools = buildToolDefinitions(agent);
      const systemPrompt = agent.systemPrompt.build();
      const messages = await prepareModelContext({ model: agent.model, session: agent.session,
        turnId, systemPrompt, tools,
        ...(signal === undefined ? {} : { signal }),
        ...(options.qualifyToolEvidence === undefined ? {} : { qualifyToolEvidence: options.qualifyToolEvidence }),
        ...(options.contextBudget === undefined ? {} : { budget: options.contextBudget }) });
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
          systemPrompt,
          messages,
          tools,
          ...(options.contextBudget === undefined ? {} : { maxOutputTokens: options.contextBudget.maxOutputTokens }),
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
        if (error instanceof SessionPersistenceError) throw error;
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
        if (maxToolCalls !== undefined && toolCallCount >= maxToolCalls) throw new ToolBudgetError();
        toolCallCount += 1;
        await executeToolCall(agent, turnId, stepId, toolCall, trace, signal, onToolResult, onToolProgress, beforeToolCall);
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
    // 第一次保存失败直接向宿主传播；不能用另一次终态写入覆盖它。
    if (signal?.reason instanceof SessionPersistenceError) throw signal.reason;
    if (error instanceof SessionPersistenceError) throw error;
    // 完成已经提交后的诊断/通知失败不改变 Core 的终态。
    if (projectTurnState(agent.session.events(), turnId) !== 'started') throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      agent.session.append({ type: 'turn.cancelled', turnId,
        reason: signal?.reason instanceof TurnCancellationError ? signal.reason.reason
          : error instanceof TurnCancellationError ? error.reason : 'external' });
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
    agent.session.append({ type: 'turn.failed', turnId, errorName: error.name, errorMessage: error.message });
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
