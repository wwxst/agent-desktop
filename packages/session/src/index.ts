import type { ToolCall, ToolCallId, ToolResult } from '@agent-desktop/model';
import { projectRecoveryAncestry } from './projections.js';

export {
  projectTurnState, projectRecoveryAncestry, projectRecoveryFacts, projectTaskPlan, projectTaskState, TaskPlanUpdateError,
  isTaskPlanEvidenceEvent,
  type RecoveryAncestry, type RecoveryCallFact, type RecoveryEffectFact, type RecoveryFacts,
  type ProjectedTaskPlanStep, type TaskPlanProjection, type TaskState,
} from './projections.js';

// 两种品牌类型都基于 string，但在编译期分别约束 Turn 和 Step 的归属关系。
export type TurnId = string & { readonly __brand: 'TurnId' };
export type StepId = string & { readonly __brand: 'StepId' };

// 引用只追加数组的零基位置；事件身份和确定顺序分别由 itemId、sequence 保存。
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

/** 每种事件只在 payload 保存业务字段；共同身份不会再平铺保存第二份。 */
interface SessionPayloadMap {
  'turn.started': Readonly<Record<string, never>>;
  'user.message': { readonly content: string };
  // 一个模型步骤包含模型输出及后续工具处理，完成事实仍由 step.completed 表达。
  'step.started': { readonly stepId: StepId };
  'assistant.message': { readonly stepId: StepId; readonly content?: string; readonly toolCalls: readonly ToolCall[] };
  'tool.called': {
    readonly stepId: StepId; readonly toolCallId: ToolCallId; readonly name: string;
    readonly input: unknown; readonly boundary?: ExecutionBoundary;
  };
  'tool.result': {
    readonly stepId: StepId; readonly toolCallId: ToolCallId; readonly result: ToolResult;
    /** 仅宿主可证明准备/审批失败未进入执行闭包，模型结果不能填写该字段。 */
    readonly executionBoundary?: 'not-executed';
  };
  // 交互关闭不是模型可见的工具结果。
  'tool.interaction.closed': {
    readonly stepId: StepId; readonly toolCallId: ToolCallId;
    readonly requestId: string; readonly reason: 'cancelled' | 'window-closed';
  };
  'step.completed': { readonly stepId: StepId };
  'turn.completed': Readonly<Record<string, never>>;
  // Loop 的终态不能被宿主后置阶段失败覆盖。
  'turn.failed': { readonly errorName: string; readonly errorMessage: string };
  'turn.cancelled': { readonly reason: TurnCancellationReason };
  'turn.interrupted': { readonly reason: 'process-exit' | 'legacy-unknown' };
  'turn.recovery.started': { readonly sourceTurnId: TurnId; readonly mode: RecoveryMode };
  // 具体配置和检查点由宿主解释，Core 不解析供应商或工具协议。
  'turn.configuration': { readonly data: unknown };
  'context.compacted': {
    readonly coveredStepEndEventIndexes: readonly SourceEventIndex[];
    readonly previousSummaryEventIndex?: SourceEventIndex;
    readonly sourceDigest: string; readonly summary: string; readonly estimatorVersion: 1;
    readonly estimatedBefore: number; readonly estimatedAfter: number;
  };
  'plan.updated': { readonly revision: number; readonly explanation: string; readonly steps: readonly TaskPlanStep[] };
  'tool.effect.prepared': { readonly sourceEventIndex: SourceEventIndex; readonly data: unknown };
  'host.operation.started': { readonly operation: string; readonly description: string };
  'host.operation.result': {
    readonly sourceEventIndex: SourceEventIndex; readonly status: 'completed' | 'failed' | 'cancelled';
    readonly errorName?: string; readonly errorMessage?: string;
  };
  'effect.outcome.verified': {
    readonly sourceEventIndex: SourceEventIndex;
    readonly scope: 'file-effect' | 'entire-call'; readonly outcome: 'completed' | 'not-applied' | 'unresolved';
    readonly evidence: { readonly source: 'tool' | 'user' | 'host'; readonly reference: string; readonly description: string };
  };
}

/** 追加输入只声明发生了什么；Session 负责分配身份、顺序和时间。 */
export type SessionEventInput = {
  [Type in keyof SessionPayloadMap]: {
    readonly type: Type;
    readonly turnId: TurnId;
    readonly payload: SessionPayloadMap[Type];
  };
}[keyof SessionPayloadMap];

/** 分布式映射保留 type 与 payload 的关联，switch 后仍能获得精确业务类型。 */
export type SessionEvent = {
  [Type in keyof SessionPayloadMap]: {
    readonly sessionId: string;
    readonly turnId: TurnId;
    readonly itemId: string;
    readonly sequence: number;
    readonly timestamp: string;
    readonly type: Type;
    readonly payload: SessionPayloadMap[Type];
  };
}[keyof SessionPayloadMap];

export type TurnStartedEvent = Extract<SessionEvent, { readonly type: 'turn.started' }>;
export type UserMessageEvent = Extract<SessionEvent, { readonly type: 'user.message' }>;
export type StepStartedEvent = Extract<SessionEvent, { readonly type: 'step.started' }>;
export type AssistantMessageEvent = Extract<SessionEvent, { readonly type: 'assistant.message' }>;
export type ToolCalledEvent = Extract<SessionEvent, { readonly type: 'tool.called' }>;
export type ToolResultEvent = Extract<SessionEvent, { readonly type: 'tool.result' }>;
export type InteractionClosedEvent = Extract<SessionEvent, { readonly type: 'tool.interaction.closed' }>;
export type StepCompletedEvent = Extract<SessionEvent, { readonly type: 'step.completed' }>;
export type TurnCompletedEvent = Extract<SessionEvent, { readonly type: 'turn.completed' }>;
export type TurnFailedEvent = Extract<SessionEvent, { readonly type: 'turn.failed' }>;
export type TurnCancelledEvent = Extract<SessionEvent, { readonly type: 'turn.cancelled' }>;
export type TurnInterruptedEvent = Extract<SessionEvent, { readonly type: 'turn.interrupted' }>;
export type TurnRecoveryStartedEvent = Extract<SessionEvent, { readonly type: 'turn.recovery.started' }>;
export type TurnConfigurationEvent = Extract<SessionEvent, { readonly type: 'turn.configuration' }>;
export type ContextCompactedEvent = Extract<SessionEvent, { readonly type: 'context.compacted' }>;
export type PlanUpdatedEvent = Extract<SessionEvent, { readonly type: 'plan.updated' }>;
export type ToolEffectPreparedEvent = Extract<SessionEvent, { readonly type: 'tool.effect.prepared' }>;
export type HostOperationStartedEvent = Extract<SessionEvent, { readonly type: 'host.operation.started' }>;
export type HostOperationResultEvent = Extract<SessionEvent, { readonly type: 'host.operation.result' }>;
export type EffectOutcomeVerifiedEvent = Extract<SessionEvent, { readonly type: 'effect.outcome.verified' }>;

// 只有宿主理解业务成功含义；Core 统一验证来源，不能硬编码工具名称。
export type PlanEvidenceSource = ToolResultEvent | EffectOutcomeVerifiedEvent;
export type QualifyToolEvidence = (source: PlanEvidenceSource, events: readonly SessionEvent[]) => { readonly eligible: boolean; readonly label: string };

/** Session 是执行事实的只追加来源；返回值就是本次已提交的完整事件。 */
export interface Session {
  readonly id: string;
  append<Event extends SessionEventInput>(event: Event): Extract<SessionEvent, { readonly type: Event['type'] }>;
  appendMany(events: readonly SessionEventInput[]): readonly SessionEvent[];
  events(): readonly SessionEvent[];
}

/** Item 表达语义对象；供应商调用 ID 只在自己的轮次和步骤内参与工具身份。 */
export function getSessionEventItemId(input: SessionEventInput, preceding: readonly SessionEvent[], sequence: number): string {
  switch (input.type) {
    case 'user.message': return `user:${input.turnId}`;
    case 'step.started': case 'assistant.message': case 'step.completed':
      return `model:${JSON.stringify([input.turnId, input.payload.stepId])}`;
    case 'tool.called': case 'tool.result': case 'tool.interaction.closed':
      return `tool:${JSON.stringify([input.turnId, input.payload.stepId, input.payload.toolCallId])}`;
    case 'tool.effect.prepared': case 'host.operation.result': case 'effect.outcome.verified':
      // 检查点与核验沿用原操作身份；跨轮次核验仍保留本次事件自己的 turnId。
      return preceding[input.payload.sourceEventIndex]!.itemId;
    case 'host.operation.started': return `host:${sequence}`;
    case 'context.compacted': return `context:${sequence}`;
    case 'plan.updated': return `plan:${projectRecoveryAncestry(preceding, input.turnId).rootTurnId}`;
    default: return `turn:${input.turnId}`;
  }
}

/** 内存和 Desktop 共用唯一追加算法，恢复时不重包装已保存的新格式事件。 */
export class InMemorySession implements Session {
  private readonly history: SessionEvent[];

  constructor(initialEvents: readonly SessionEvent[] = [], readonly id: string = initialEvents[0]?.sessionId ?? globalThis.crypto.randomUUID()) {
    this.history = [...initialEvents];
  }

  append<Event extends SessionEventInput>(event: Event): Extract<SessionEvent, { readonly type: Event['type'] }> {
    return this.appendMany([event])[0] as Extract<SessionEvent, { readonly type: Event['type'] }>;
  }

  /** 宿主先同步保存完整候选历史；失败时不推进内存、序号或任何额外提交状态。 */
  appendMany(events: readonly SessionEventInput[], beforeCommit?: (candidate: readonly SessionEvent[]) => void): readonly SessionEvent[] {
    const candidate = [...this.history];
    const batch: SessionEvent[] = [];
    for (const input of events) {
      const sequence = (candidate.at(-1)?.sequence ?? 0) + 1;
      // 显式选取输入字段，追加时不复制调用方的额外元数据或平铺业务副本。
      const event = { sessionId: this.id, turnId: input.turnId, itemId: getSessionEventItemId(input, candidate, sequence),
        sequence, timestamp: new Date().toISOString(), type: input.type, payload: input.payload } as SessionEvent;
      candidate.push(event);
      batch.push(event);
    }
    beforeCommit?.(candidate);
    this.history.push(...batch);
    return batch;
  }

  // readonly 约束调用方只能读取，不提供修改或删除历史的方法。
  events(): readonly SessionEvent[] { return this.history; }
}

/**
 * 只挑选 Turn 级事实、用户输入，以及已完成 Step 的全部事件。
 * 未完成 Step 的模型输出与工具结果不能组成完整模型协议，因此一起排除；
 * 原始执行事实仍保留，恢复投影不重新分配事件的身份、序号或时间。
 */
export function recoverSessionEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const completedStepIds = new Set(
    events
      .filter((event): event is StepCompletedEvent => event.type === 'step.completed')
      .map((event) => JSON.stringify([event.turnId, event.payload.stepId])),
  );

  return events.filter((event) => {
    if (event.type === 'tool.interaction.closed') return false;
    // Turn 级业务负载没有 stepId；检查点等事实也不伪造 Step 完成。
    if (!('stepId' in event.payload)) return true;
    return completedStepIds.has(JSON.stringify([event.turnId, event.payload.stepId]));
  });
}
