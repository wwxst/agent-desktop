import type { ToolCall, ToolCallId, ToolResult } from '@agent-desktop/model';

export {
  projectTurnState, projectRecoveryAncestry, projectRecoveryFacts, projectTaskPlan, projectTaskState, TaskPlanUpdateError,
  isTaskPlanEvidenceEvent,
  type RecoveryAncestry, type RecoveryCallFact, type RecoveryEffectFact, type RecoveryFacts,
  type ProjectedTaskPlanStep, type TaskPlanProjection, type TaskState,
} from './projections.js';

// 两种品牌类型都基于 string，但在编译期分别约束 Turn 和 Step 的归属关系。
export type TurnId = string & { readonly __brand: 'TurnId' };
export type StepId = string & { readonly __brand: 'StepId' };

// 引用只追加数组的位置，不把模型提供的 ToolCallId 当作全局身份。
export type SourceEventIndex = number;
export type ExecutionBoundary = 'not-executed' | 'read-only' | 'checkpointed' | 'opaque';
export type TurnCancellationReason = 'user' | 'window-closed' | 'external';
export type RecoveryMode = 'continue' | 'verify';
export type TurnState = 'started' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type TaskPlanStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';
export interface TaskPlanStep {
  readonly id: string;
  readonly description: string;
  readonly requestedStatus: TaskPlanStatus;
  readonly completionKind: 'tool' | 'response';
  readonly evidenceEventIndexes: readonly SourceEventIndex[];
}

/** 同步检查点保存失败必须跨工具/Loop 直接传播，所有消费者共享同一个类。 */
export class SessionPersistenceError extends Error {
  constructor(cause: unknown) { super('会话执行事实保存失败。', { cause }); this.name = 'SessionPersistenceError'; }
}

/** 保留现有 AbortError 契约，同时用类型保存取消来源，不按错误文案猜测。 */
export class TurnCancellationError extends Error {
  constructor(readonly reason: TurnCancellationReason) { super('任务已取消。'); this.name = 'AbortError'; }
}

/** 记录一次 Turn 已经开始。 */
export interface TurnStartedEvent { readonly type: 'turn.started'; readonly turnId: TurnId; }
/** 记录进入 Session 的原始用户输入。 */
export interface UserMessageEvent { readonly type: 'user.message'; readonly turnId: TurnId; readonly content: string; }
/** 记录一次模型调用所对应 Step 的开始。 */
export interface StepStartedEvent { readonly type: 'step.started'; readonly turnId: TurnId; readonly stepId: StepId; }
/** 完整保存模型文本和工具调用，两者不是互斥关系。 */
export interface AssistantMessageEvent { readonly type: 'assistant.message'; readonly turnId: TurnId; readonly stepId: StepId; readonly content?: string; readonly toolCalls: readonly ToolCall[]; }
/** 在执行前记录工具调用，确保后续成功或失败结果都有可追踪的起点。 */
export interface ToolCalledEvent { readonly type: 'tool.called'; readonly turnId: TurnId; readonly stepId: StepId; readonly toolCallId: ToolCallId; readonly name: string; readonly input: unknown; readonly boundary?: ExecutionBoundary; }
/** 保存工具执行事实，并通过 ToolCallId 与调用事件建立关联。 */
export interface ToolResultEvent { readonly type: 'tool.result'; readonly turnId: TurnId; readonly stepId: StepId; readonly toolCallId: ToolCallId; readonly result: ToolResult; }
/** 记录当前 Step 的所有模型输出和工具结果已经处理完成。 */
export interface StepCompletedEvent { readonly type: 'step.completed'; readonly turnId: TurnId; readonly stepId: StepId; }
/** 记录 Turn 已经自然结束。 */
export interface TurnCompletedEvent { readonly type: 'turn.completed'; readonly turnId: TurnId; }
/** 待回答问题结束的历史事实，不是模型可见的工具结果。 */
export interface InteractionClosedEvent {
  readonly type: 'tool.interaction.closed'; readonly turnId: TurnId; readonly stepId: StepId;
  readonly toolCallId: ToolCallId; readonly requestId: string; readonly reason: 'cancelled' | 'window-closed';
}

/** Loop 的真实终态；宿主后置阶段失败不能改写已经完成的 Turn。 */
export interface TurnFailedEvent { readonly type: 'turn.failed'; readonly turnId: TurnId; readonly errorName: string; readonly errorMessage: string; }
export interface TurnCancelledEvent { readonly type: 'turn.cancelled'; readonly turnId: TurnId; readonly reason: TurnCancellationReason; }
export interface TurnInterruptedEvent { readonly type: 'turn.interrupted'; readonly turnId: TurnId; readonly reason: 'process-exit' | 'legacy-unknown'; }
export interface TurnRecoveryStartedEvent { readonly type: 'turn.recovery.started'; readonly turnId: TurnId; readonly sourceTurnId: TurnId; readonly mode: RecoveryMode; }
/** 有效配置由宿主解释并脱敏保存，Core 不解析供应商协议或操作系统策略。 */
export interface TurnConfigurationEvent { readonly type: 'turn.configuration'; readonly turnId: TurnId; readonly data: unknown; }

/** 摘要只覆盖明确完成的模型步骤；原始事件继续保留。 */
export interface ContextCompactedEvent {
  readonly type: 'context.compacted'; readonly turnId: TurnId;
  readonly coveredStepEndEventIndexes: readonly SourceEventIndex[];
  readonly previousSummaryEventIndex?: SourceEventIndex;
  readonly sourceDigest: string; readonly summary: string; readonly estimatorVersion: 1;
  readonly estimatedBefore: number; readonly estimatedAfter: number;
}
export interface PlanUpdatedEvent {
  readonly type: 'plan.updated'; readonly turnId: TurnId; readonly revision: number;
  readonly explanation: string; readonly steps: readonly TaskPlanStep[];
}
/** data 由具体工具/宿主拥有，Session 不解析文件、终端或插件协议。 */
export interface ToolEffectPreparedEvent { readonly type: 'tool.effect.prepared'; readonly turnId: TurnId; readonly sourceEventIndex: SourceEventIndex; readonly data: unknown; }
export interface HostOperationStartedEvent { readonly type: 'host.operation.started'; readonly turnId: TurnId; readonly operation: string; readonly description: string; }
export interface HostOperationResultEvent {
  readonly type: 'host.operation.result'; readonly turnId: TurnId; readonly sourceEventIndex: SourceEventIndex;
  readonly status: 'completed' | 'failed' | 'cancelled'; readonly errorName?: string; readonly errorMessage?: string;
}
export interface EffectOutcomeVerifiedEvent {
  readonly type: 'effect.outcome.verified'; readonly turnId: TurnId; readonly sourceEventIndex: SourceEventIndex;
  readonly scope: 'file-effect' | 'entire-call'; readonly outcome: 'completed' | 'not-applied' | 'unresolved';
  readonly evidence: { readonly source: 'tool' | 'user' | 'host'; readonly reference: string; readonly description: string };
}

// 只有宿主理解业务成功含义；Core 统一验证来源，不能硬编码工具名称。
export type PlanEvidenceSource = ToolResultEvent | EffectOutcomeVerifiedEvent;
export type QualifyToolEvidence = (source: PlanEvidenceSource, events: readonly SessionEvent[]) => { readonly eligible: boolean; readonly label: string };

// type 字段组成可辨识联合，消费方可以通过 switch 获得精确的事件类型收窄。
export type SessionEvent =
  | TurnStartedEvent
  | UserMessageEvent
  | StepStartedEvent
  | AssistantMessageEvent
  | ToolCalledEvent
  | ToolResultEvent
  | InteractionClosedEvent
  | StepCompletedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCancelledEvent
  | TurnInterruptedEvent
  | TurnRecoveryStartedEvent
  | TurnConfigurationEvent
  | ContextCompactedEvent
  | PlanUpdatedEvent
  | ToolEffectPreparedEvent
  | HostOperationStartedEvent
  | HostOperationResultEvent
  | EffectOutcomeVerifiedEvent;

/** Session 是 Agent 执行事实的只追加来源，不提供修改或删除历史的接口。 */
export interface Session {
  append(event: SessionEvent): void;
  appendMany(events: readonly SessionEvent[]): void;
  events(): readonly SessionEvent[];
}

/** MVP 使用的内存 Session；数组只在内部持有，保持 append-only 语义。 */
export class InMemorySession implements Session {
  private readonly history: SessionEvent[];

  /** 恢复时复制已有事件，调用方后续修改原数组不会改变 Session 历史。 */
  constructor(initialEvents: readonly SessionEvent[] = []) {
    this.history = [...initialEvents];
  }

  // 新事实只追加到末尾，不重写既有事件。
  append(event: SessionEvent): void { this.appendMany([event]); }

  // 宿主可用同一批次原子保存起点/消息绑定；内存实现不引入异步事务框架。
  appendMany(events: readonly SessionEvent[]): void { this.history.push(...events); }

  // readonly 约束调用方只能读取，Session 对外不提供修改或删除历史的方法。
  events(): readonly SessionEvent[] { return this.history; }
}

/**
 * 只挑选完整事实：Turn 级事件、用户输入，以及已完成 Step 的全部事件。
 * Step 是否完整只由是否存在 step.completed 决定，这里是该规则的唯一权威实现。
 * 未完成 Step 的 assistant.message、tool.called 与 tool.result 不能组成完整模型协议，
 * 此投影整体排除它们，避免 dangling Tool Call 进入模型请求；真实成功结果仍是执行事实。
 * Session 历史原样保留，恢复事实/上下文派生文本可以读取这些已发生事实，不虚造 Step 完成。
 */
export function recoverSessionEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const completedStepIds = new Set(
    events
      .filter((event): event is StepCompletedEvent => event.type === 'step.completed')
      .map((event) => JSON.stringify([event.turnId, event.stepId])),
  );

  return events.filter((event) => {
    if (event.type === 'tool.interaction.closed') return false;
    // Turn 级事件没有 stepId，保留它们不改变任何 Step 的完成状态。
    if (!('stepId' in event)) {
      return true;
    }
    // 其余事件都属于某个 Step；未完成 Step 的全部事件一起排除，Tool Calling 链不会残缺。
    return completedStepIds.has(JSON.stringify([event.turnId, event.stepId]));
  });
}
