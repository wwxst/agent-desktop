import type {
  EffectOutcomeVerifiedEvent, HostOperationResultEvent, HostOperationStartedEvent,
  PlanUpdatedEvent, QualifyToolEvidence, RecoveryMode, SessionEvent, SourceEventIndex,
  TaskPlanStatus, TaskPlanStep, ToolCalledEvent, ToolResultEvent, TurnId, TurnState,
} from './index.js';

export interface RecoveryAncestry {
  readonly rootTurnId: TurnId;
  readonly turnIds: readonly TurnId[];
  readonly latestTurnId: TurnId;
  /** 核验说明不是原任务交付，任务终态只取根轮次或 continue 后继。 */
  readonly latestExecutionTurnId: TurnId;
}

export interface RecoveryCallFact {
  readonly sourceEventIndex: SourceEventIndex;
  readonly call: ToolCalledEvent;
  readonly resultEventIndex?: SourceEventIndex;
  readonly result?: ToolResultEvent;
  readonly verification?: EffectOutcomeVerifiedEvent;
}
export interface RecoveryEffectFact {
  readonly sourceEventIndex: SourceEventIndex;
  readonly source: ToolCalledEvent | HostOperationStartedEvent;
  readonly preparedEventIndexes: readonly SourceEventIndex[];
  readonly resultEventIndex?: SourceEventIndex;
  readonly verification?: EffectOutcomeVerifiedEvent;
}
export interface RecoveryFacts {
  readonly unknownEffects: readonly RecoveryEffectFact[];
  readonly successfulCalls: readonly RecoveryCallFact[];
  readonly deniedCalls: readonly RecoveryCallFact[];
}
export interface ProjectedTaskPlanStep extends TaskPlanStep {
  readonly status: TaskPlanStatus;
  readonly evidenceLabels: readonly string[];
}
export interface TaskPlanProjection {
  readonly rootTurnId: TurnId;
  readonly revision: number;
  readonly sourceEventIndex: SourceEventIndex;
  readonly explanation: string;
  readonly steps: readonly ProjectedTaskPlanStep[];
}
export type TaskState = TurnState | 'blocked';

/** 已持久化的终态优先于 started，宿主阶段不会修改 Core 的完成事实。 */
export function projectTurnState(events: readonly SessionEvent[], turnId: TurnId): TurnState | undefined {
  let state: TurnState | undefined;
  for (const event of events) {
    if (event.turnId !== turnId) continue;
    switch (event.type) {
      case 'turn.started': if (state === undefined) state = 'started'; break;
      case 'turn.completed': state = 'completed'; break;
      case 'turn.failed': state = 'failed'; break;
      case 'turn.cancelled': state = 'cancelled'; break;
      case 'turn.interrupted': state = 'interrupted'; break;
    }
  }
  return state;
}

/** 恢复关联只来自事件，不能从用户文字或相同工具 ID 猜测任务归属。 */
export function projectRecoveryAncestry(events: readonly SessionEvent[], turnId: TurnId): RecoveryAncestry {
  const parents = new Map<TurnId, { sourceTurnId: TurnId; mode: RecoveryMode }>();
  for (const event of events) {
    if (event.type === 'turn.recovery.started') parents.set(event.turnId, event);
  }
  const rootFor = (id: TurnId): TurnId => {
    // 真实文件/IPC 边界保证 source 指向此前轮次；同进程投影不重复外部字段校验。
    let root = id;
    while (parents.has(root)) root = parents.get(root)!.sourceTurnId;
    return root;
  };
  const rootTurnId = rootFor(turnId);
  const turnIds: TurnId[] = [rootTurnId];
  for (const event of events) {
    if (event.type === 'turn.started' && rootFor(event.turnId) === rootTurnId && !turnIds.includes(event.turnId)) turnIds.push(event.turnId);
  }
  const executionTurns = turnIds.filter(id => parents.get(id)?.mode !== 'verify');
  return { rootTurnId, turnIds, latestTurnId: turnIds[turnIds.length - 1]!, latestExecutionTurnId: executionTurns[executionTurns.length - 1]! };
}

type CallRecord = {
  sourceEventIndex: number; call: ToolCalledEvent; preparedEventIndexes: number[];
  resultEventIndex?: number; result?: ToolResultEvent; verification?: EffectOutcomeVerifiedEvent;
};
type HostRecord = {
  sourceEventIndex: number; source: HostOperationStartedEvent;
  resultEventIndex?: number; result?: HostOperationResultEvent; verification?: EffectOutcomeVerifiedEvent;
};

// 供应商可以跨步骤/轮次复用调用 ID；三个身份合起来才对应同一次结果。
const callKey = (event: ToolCalledEvent | ToolResultEvent): string => JSON.stringify([event.turnId, event.stepId, event.toolCallId]);

/** 会话级未知事实只有这一处计算，门禁、上下文和恢复界面消费同一结果。 */
export function projectRecoveryFacts(events: readonly SessionEvent[]): RecoveryFacts {
  const calls = new Map<number, CallRecord>();
  const callIndexes = new Map<string, number>();
  const hosts = new Map<number, HostRecord>();
  events.forEach((event, index) => {
    switch (event.type) {
      case 'tool.called':
        calls.set(index, { sourceEventIndex: index, call: event, preparedEventIndexes: [] });
        callIndexes.set(callKey(event), index);
        break;
      case 'tool.result': {
        const sourceIndex = callIndexes.get(callKey(event));
        const record = sourceIndex === undefined ? undefined : calls.get(sourceIndex);
        if (record !== undefined) { record.result = event; record.resultEventIndex = index; }
        break;
      }
      case 'tool.effect.prepared': calls.get(event.sourceEventIndex)?.preparedEventIndexes.push(index); break;
      case 'host.operation.started': hosts.set(index, { sourceEventIndex: index, source: event }); break;
      case 'host.operation.result': {
        const record = hosts.get(event.sourceEventIndex);
        if (record !== undefined) { record.result = event; record.resultEventIndex = index; }
        break;
      }
      case 'effect.outcome.verified': {
        // 文件部分的匹配不能覆盖整调用未明；只取最新 entire-call 结论。
        if (event.scope !== 'entire-call') break;
        const record = calls.get(event.sourceEventIndex) ?? hosts.get(event.sourceEventIndex);
        if (record !== undefined) record.verification = event;
        break;
      }
    }
  });
  const unknownEffects: RecoveryEffectFact[] = [];
  const successfulCalls: RecoveryCallFact[] = [];
  const deniedCalls: RecoveryCallFact[] = [];
  for (const record of calls.values()) {
    const { sourceEventIndex, call, preparedEventIndexes, result, resultEventIndex, verification } = record;
    const fact: RecoveryCallFact = { sourceEventIndex, call,
      ...(resultEventIndex === undefined ? {} : { resultEventIndex }),
      ...(result === undefined ? {} : { result }), ...(verification === undefined ? {} : { verification }) };
    if (result?.result.status === 'success' || verification?.outcome === 'completed') successfulCalls.push(fact);
    if (result?.result.status === 'error' && result.result.failureKind === 'denied') deniedCalls.push(fact);
    const boundary = call.boundary ?? 'opaque';
    // 未执行/裸读取不制造副作用；未知旧边界保守按 opaque，不能据此猜退出原因。
    if (boundary === 'not-executed' || boundary === 'read-only') continue;
    let unknown = boundary === 'opaque'
      ? result?.result.status !== 'success'
      : result?.result.status === 'error' && result.result.failureKind === 'unknown-outcome';
    if (boundary === 'checkpointed' && preparedEventIndexes.length > 0 && result?.result.status !== 'success') {
      const kind = result?.result.status === 'error' ? result.result.failureKind : undefined;
      unknown = kind !== 'denied' && kind !== 'permanent';
    }
    // NoExit 终端在启动/发送成功后仍可能执行；宿主未明观察保留原 success。
    if (verification !== undefined) unknown = verification.outcome === 'unresolved';
    if (unknown) unknownEffects.push({ sourceEventIndex, source: call, preparedEventIndexes,
      ...(resultEventIndex === undefined ? {} : { resultEventIndex }),
      ...(verification === undefined ? {} : { verification }) });
  }
  for (const record of hosts.values()) {
    const unknown = record.verification === undefined ? record.result?.status !== 'completed' : record.verification.outcome === 'unresolved';
    if (unknown) unknownEffects.push({ sourceEventIndex: record.sourceEventIndex, source: record.source, preparedEventIndexes: [],
      ...(record.resultEventIndex === undefined ? {} : { resultEventIndex: record.resultEventIndex }),
      ...(record.verification === undefined ? {} : { verification: record.verification }) });
  }
  unknownEffects.sort((left, right) => left.sourceEventIndex - right.sourceEventIndex);
  return { unknownEffects, successfulCalls, deniedCalls };
}

/** 计划完成必须取得真实来源资格；模型声明本身不是执行成功的证据。 */
export function projectTaskPlan(events: readonly SessionEvent[], rootTurnId: TurnId, qualifyToolEvidence: QualifyToolEvidence): TaskPlanProjection | undefined {
  const ancestry = projectRecoveryAncestry(events, rootTurnId);
  const turns = new Set(ancestry.turnIds);
  const verifyTurns = new Set(events.filter(event => event.type === 'turn.recovery.started' && event.mode === 'verify').map(event => event.turnId));
  const declarations: { event: PlanUpdatedEvent; index: number }[] = [];
  events.forEach((event, index) => { if (event.type === 'plan.updated' && turns.has(event.turnId)) declarations.push({ event, index }); });
  const recovery = projectRecoveryFacts(events);
  const unknownIndexes = new Set(recovery.unknownEffects.flatMap(fact => [fact.sourceEventIndex, ...(fact.resultEventIndex === undefined ? [] : [fact.resultEventIndex])]));
  const isUnknownEvidence = (index: number): boolean => {
    const event = events[index];
    // 旧 completed 核验也指向同一次外部操作；新 unresolved 观察会使该来源待确认。
    return unknownIndexes.has(index) || (event?.type === 'effect.outcome.verified' && unknownIndexes.has(event.sourceEventIndex));
  };
  let projection: TaskPlanProjection | undefined;
  // 完成证据与暂时 blocked 展示分开派生，不能趁新的未知观察删掉已完成的原步骤。
  const completedSteps = new Map<string, ProjectedTaskPlanStep>();
  for (let version = 0; version < declarations.length; version += 1) {
    const { event: declaration, index } = declarations[version]!;
    const end = declarations[version + 1]?.index ?? events.length;
    const steps = declaration.steps.map((step): ProjectedTaskPlanStep => {
      const previous = completedSteps.get(step.id);
      // 实际完成的是稳定的原步骤。后续版本可保留该事实，但不能换描述/类型或退回未完成。
      if (previous !== undefined && (step.description !== previous.description || step.completionKind !== previous.completionKind || step.requestedStatus !== 'completed')) throw new Error('已完成计划步骤不得删除或撤销。');
      let completed = false;
      let failed = false;
      let blocked = false;
      const evidenceLabels: string[] = [];
      for (const evidenceIndex of step.evidenceEventIndexes) {
        const evidence = events[evidenceIndex];
        // 模型/文件引用必须已存在且来自原任务链，不能引用未来或无关任务。
        if (!Number.isSafeInteger(evidenceIndex) || evidenceIndex < 0 || evidenceIndex >= index || evidence === undefined || !turns.has(evidence.turnId)) continue;
        if (isUnknownEvidence(evidenceIndex)) blocked = true;
        if (evidence.type === 'tool.result' || evidence.type === 'effect.outcome.verified') {
          const source = evidence.type === 'effect.outcome.verified' ? events[evidence.sourceEventIndex]
            : events.slice(0, evidenceIndex).findLast((event): event is ToolCalledEvent => event.type === 'tool.called' && callKey(event) === callKey(evidence));
          // 旧历史可以保留未配对结果，但新计划不能拿没有真实调用/被门禁拒绝的结果确认完成。
          if (source === undefined || !turns.has(source.turnId) || (source.type !== 'tool.called' && source.type !== 'host.operation.started')
            || (source.type === 'tool.called' && source.boundary === 'not-executed')) continue;
          const eligibleResult = evidence.type === 'tool.result' ? evidence.result.status === 'success'
            : evidence.scope === 'entire-call' && evidence.outcome === 'completed';
          if (eligibleResult) {
            const qualification = qualifyToolEvidence(evidence, events);
            evidenceLabels.push(qualification.label);
            if (step.completionKind === 'tool' && qualification.eligible) completed = true;
          }
          if (evidence.type === 'tool.result' && evidence.result.status === 'error') failed = true;
        }
        if (evidence.type === 'turn.failed' || (evidence.type === 'host.operation.result' && evidence.status === 'failed')) failed = true;
        if (evidence.type === 'turn.cancelled' || evidence.type === 'turn.interrupted' || evidence.type === 'tool.interaction.closed') blocked = true;
      }
      if (step.completionKind === 'response') {
        // 核验轮次的解释不是原目标交付；旧声明只观察下一版本之前的回复。
        const finalTurns = new Set<TurnId>();
        for (let eventIndex = index + 1; eventIndex < end; eventIndex += 1) {
          const event = events[eventIndex]!;
          if (!turns.has(event.turnId) || verifyTurns.has(event.turnId)) continue;
          if (event.type === 'assistant.message' && event.toolCalls.length === 0 && event.content !== undefined) finalTurns.add(event.turnId);
          if (event.type === 'turn.completed' && finalTurns.has(event.turnId)) completed = true;
        }
      }
      if (previous !== undefined) {
        completed = true;
        if (evidenceLabels.length === 0) evidenceLabels.push(...previous.evidenceLabels);
        if (previous.evidenceEventIndexes.some(isUnknownEvidence)) blocked = true;
      }
      const status: TaskPlanStatus = blocked ? 'blocked' : completed ? 'completed'
        : failed ? 'failed'
        : step.requestedStatus === 'in_progress' ? 'in_progress' : 'pending';
      const projected = { ...step, status, evidenceLabels,
        evidenceEventIndexes: previous === undefined ? step.evidenceEventIndexes : [...new Set([...previous.evidenceEventIndexes, ...step.evidenceEventIndexes])] };
      if (completed) completedSteps.set(step.id, projected);
      return projected;
    });
    // 更新必须保留已完成的稳定步骤；不能靠后续声明撤销实际完成事实。
    for (const id of completedSteps.keys()) if (!steps.some(step => step.id === id)) throw new Error('已完成计划步骤不得删除或撤销。');
    projection = { rootTurnId: ancestry.rootTurnId, revision: declaration.revision, sourceEventIndex: index, explanation: declaration.explanation, steps };
  }
  return projection;
}

/** 核验终态不取代原执行终态；未知效果对同会话所有写入任务仍有约束。 */
export function projectTaskState(events: readonly SessionEvent[], rootTurnId: TurnId, planProjection: TaskPlanProjection | undefined): TaskState | undefined {
  const ancestry = projectRecoveryAncestry(events, rootTurnId);
  if (projectRecoveryFacts(events).unknownEffects.length > 0) return 'blocked';
  const state = projectTurnState(events, ancestry.latestExecutionTurnId);
  if (state !== undefined && state !== 'started' && planProjection?.steps.some(step => step.status !== 'completed')) return 'blocked';
  return state;
}
