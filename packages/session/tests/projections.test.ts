import { describe, expect, it, vi } from 'vitest';
import type { ToolCallId, ToolResult } from '@agent-desktop/model';
import {
  InMemorySession, projectRecoveryAncestry, projectRecoveryFacts, projectTaskPlan, projectTaskState, projectTurnState,
  type ExecutionBoundary, type SessionEventInput, type SessionEvent, type StepId,
  type TaskPlanStep, type TurnId,
} from '@agent-desktop/session';

const root = 'root' as TurnId;
const second = 'second' as TurnId;
const verify = 'verify' as TurnId;
const other = 'other' as TurnId;
const stepId = 'same-step' as StepId;
const toolCallId = 'same-call' as ToolCallId;
const success: ToolResult = { status: 'success', output: { value: 'actual result' } };

function called(turnId: TurnId, boundary?: ExecutionBoundary): Extract<SessionEventInput, { type: 'tool.called' }> {
  return { type: 'tool.called', turnId, payload: { stepId, toolCallId, name: 'actual-tool', input: { value: turnId }, ...(boundary === undefined ? {} : { boundary }) } };
}
function result(turnId: TurnId, value: ToolResult = success): SessionEventInput {
  return { type: 'tool.result', turnId, payload: { stepId, toolCallId, result: value } };
}
function verification(sourceEventIndex: number, outcome: 'completed' | 'not-applied' | 'unresolved', scope: 'entire-call' | 'file-effect' = 'entire-call'): SessionEventInput {
  return { type: 'effect.outcome.verified', turnId: root, payload: { sourceEventIndex, scope, outcome, evidence: { source: outcome === 'unresolved' ? 'host' : 'user', reference: 'actual evidence', description: 'verified outside the model' } } };
}
function plan(turnId: TurnId, steps: readonly TaskPlanStep[], revision = 1): Extract<SessionEventInput, { type: 'plan.updated' }> {
  return { type: 'plan.updated', turnId, payload: { revision, explanation: 'current declaration', steps } };
}
function planStep(status: TaskPlanStep['requestedStatus'], evidenceEventIndexes: readonly number[] = [], completionKind: 'tool' | 'response' = 'tool'): TaskPlanStep {
  return { id: 'stable-step', description: 'do the work', requestedStatus: status, evidenceEventIndexes, completionKind };
}
function fixture(inputs: readonly SessionEventInput[]): SessionEvent[] {
  return [...new InMemorySession([], 'projection-session').appendMany(inputs)];
}
function append(events: SessionEvent[], ...inputs: readonly SessionEventInput[]): void {
  events.push(...new InMemorySession(events).appendMany(inputs));
}
const qualify = () => ({ eligible: true, label: '工具真实完成' });

describe('turn and recovery ancestry', () => {
  it('reads distinct terminal states without inferring a crash from missing terminal facts', () => {
    expect(projectTurnState([], root)).toBeUndefined();
    expect(projectTurnState(fixture([{ type: 'turn.started', turnId: root, payload: {} }]), root)).toBe('started');
    expect(projectTurnState(fixture([{ type: 'turn.cancelled', turnId: root, payload: { reason: 'user' } }]), root)).toBe('cancelled');
    expect(projectTurnState(fixture([{ type: 'turn.failed', turnId: root, payload: { errorName: 'Error', errorMessage: 'failure' } }]), root)).toBe('failed');
    expect(projectTurnState(fixture([{ type: 'turn.interrupted', turnId: root, payload: { reason: 'process-exit' } }]), root)).toBe('interrupted');
  });

  it('keeps verification in the chain but excludes it from the actual execution terminal', () => {
    const events = fixture([
      { type: 'turn.started', turnId: root, payload: {} },
      { type: 'turn.failed', turnId: root, payload: { errorName: 'Error', errorMessage: 'original failed' } },
      { type: 'turn.started', turnId: verify, payload: {} },
      { type: 'turn.recovery.started', turnId: verify, payload: { sourceTurnId: root, mode: 'verify' } },
      { type: 'turn.completed', turnId: verify, payload: {} },
      { type: 'turn.started', turnId: other, payload: {} },
    ]);
    expect(projectRecoveryAncestry(events, verify)).toEqual({ rootTurnId: root, turnIds: [root, verify], latestTurnId: verify, latestExecutionTurnId: root });
    expect(projectTaskState(events, root, undefined)).toBe('failed');
    append(events, { type: 'turn.started', turnId: second, payload: {} }, { type: 'turn.recovery.started', turnId: second, payload: { sourceTurnId: verify, mode: 'continue' } }, { type: 'turn.completed', turnId: second, payload: {} });
    expect(projectRecoveryAncestry(events, root).latestExecutionTurnId).toBe(second);
    expect(projectTaskState(events, root, undefined)).toBe('completed');
  });
});

describe('projectRecoveryFacts', () => {
  it('does not turn nonexecuted requests or unprepared checkpointed calls into unknown effects', () => {
    const events = fixture([called(root, 'not-executed'), called(second, 'read-only'), called(other, 'checkpointed')]);
    expect(projectRecoveryFacts(events).unknownEffects).toEqual([]);
    append(events, { type: 'tool.effect.prepared', turnId: other, payload: { sourceEventIndex: 2, data: { intent: 'external operation' } } });
    expect(projectRecoveryFacts(events).unknownEffects.map(fact => fact.sourceEventIndex)).toEqual([2]);
  });

  it('preserves a successful result in an incomplete Step and pairs repeated IDs by Turn and Step', () => {
    const events = fixture([called(root, 'checkpointed'), result(root), called(second, 'opaque'), result(second, { status: 'error', message: 'failed after external request' })]);
    const facts = projectRecoveryFacts(events);
    expect(facts.successfulCalls.map(fact => [fact.sourceEventIndex, fact.resultEventIndex])).toEqual([[0, 1]]);
    expect(facts.unknownEffects.map(fact => [fact.sourceEventIndex, fact.resultEventIndex])).toEqual([[2, 3]]);
    // 残留成功事实不靠虚造 step.completed 才可读取。
    expect(events.some(event => event.type === 'step.completed')).toBe(false);
  });

  it('keeps opaque denial unknown while a bare denied call has no executed effect', () => {
    const events = fixture([
      called(root, 'checkpointed'), result(root, { status: 'error', message: 'declined', failureKind: 'denied' }),
      called(second, 'opaque'), result(second, { status: 'error', message: 'declined inside wrapper', failureKind: 'denied' }),
    ]);
    expect(projectRecoveryFacts(events).deniedCalls.map(fact => fact.sourceEventIndex)).toEqual([0, 2]);
    expect(projectRecoveryFacts(events).unknownEffects.map(fact => fact.sourceEventIndex)).toEqual([2]);
  });

  it('treats unspecified boundaries conservatively without inventing process-exit', () => {
    const events = fixture([called(root)]);
    expect(projectRecoveryFacts(events).unknownEffects).toHaveLength(1);
    expect(projectTurnState(events, root)).toBeUndefined();
    expect(events).toMatchObject([called(root)]);
  });

  it('does not allow file-only matching to clear hook effects and does not fabricate a successful result', () => {
    const events = fixture([called(root, 'opaque'), result(root, { status: 'error', message: 'post hook failed' }), verification(0, 'completed', 'file-effect')]);
    expect(projectRecoveryFacts(events).unknownEffects).toHaveLength(1);
    append(events, verification(0, 'completed'));
    const facts = projectRecoveryFacts(events);
    expect(facts.unknownEffects).toEqual([]);
    expect(facts.successfulCalls[0]?.result?.payload.result.status).toBe('error');
    expect(events[1]).toMatchObject(result(root, { status: 'error', message: 'post hook failed' }));
  });

  it('adds unresolved host observation to an already successful terminal send without rewriting success', () => {
    const events = fixture([called(root, 'checkpointed'), result(root), verification(0, 'unresolved')]);
    expect(projectRecoveryFacts(events).unknownEffects).toHaveLength(1);
    expect(projectRecoveryFacts(events).successfulCalls).toHaveLength(1);
    append(events, verification(0, 'not-applied'));
    expect(projectRecoveryFacts(events).unknownEffects).toEqual([]);
    expect(events[1]).toMatchObject(result(root));
  });

  it('keeps failed or missing host phases unknown independently of Core completed', () => {
    const events = fixture([
      { type: 'turn.completed', turnId: root, payload: {} },
      { type: 'host.operation.started', turnId: root, payload: { operation: 'stop', description: 'actual host operation' } },
      { type: 'host.operation.result', turnId: root, payload: { sourceEventIndex: 1, status: 'failed', errorName: 'Error', errorMessage: 'hook failed' } },
    ]);
    expect(projectTurnState(events, root)).toBe('completed');
    expect(projectTaskState(events, root, undefined)).toBe('blocked');
    append(events, verification(1, 'completed'));
    expect(projectTaskState(events, root, undefined)).toBe('completed');
  });

  it('does not interpret a checkpointed syscall failure as proof that no write happened', () => {
    const events = fixture([called(root, 'checkpointed'), { type: 'tool.effect.prepared', turnId: root, payload: { sourceEventIndex: 0, data: {} } }, result(root, { status: 'error', message: 'write failed', failureKind: 'unknown-outcome' })]);
    expect(projectRecoveryFacts(events).unknownEffects[0]?.preparedEventIndexes).toEqual([1]);
  });
});

describe('projectTaskPlan', () => {
  it('does not accept unsupported completed or failed model declarations', () => {
    const events = fixture([{ type: 'turn.started', turnId: root, payload: {} }, plan(root, [planStep('completed')])]);
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('pending');
    const candidate = plan(root, [planStep('failed')], 2);
    const previous = [...events];
    expect(projectTaskPlan(events, root, qualify, candidate)?.revision).toBe(2);
    expect(events).toEqual(previous);
    append(events, candidate);
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('pending');
  });

  it('does not qualify unpaired results or results from a gate-rejected call', () => {
    const qualifySpy = vi.fn(qualify);
    const unpaired = fixture([{ type: 'turn.started', turnId: root, payload: {} }, result(root), plan(root, [planStep('completed', [1])])]);
    expect(projectTaskPlan(unpaired, root, qualifySpy)?.steps[0]?.status).toBe('pending');
    const blocked = fixture([{ type: 'turn.started', turnId: root, payload: {} }, called(root, 'not-executed'), result(root), plan(root, [planStep('completed', [2])])]);
    expect(projectTaskPlan(blocked, root, qualifySpy)?.steps[0]?.status).toBe('pending');
    expect(qualifySpy).not.toHaveBeenCalled();
    expect(unpaired[1]).toMatchObject(result(root));
  });

  it('completes only from real qualified success and reconstructs failed state from the actual error', () => {
    const events = fixture([{ type: 'turn.started', turnId: root, payload: {} }, called(root, 'read-only'), result(root), plan(root, [planStep('completed', [2])])]);
    const callback = vi.fn(qualify);
    expect(projectTaskPlan(events, root, callback)?.steps[0]?.status).toBe('completed');
    expect(callback).toHaveBeenCalledWith(events[2], events);
    expect(projectTaskPlan(events, root, () => ({ eligible: false, label: '工具已返回，业务未确认' }))?.steps[0]).toMatchObject({ status: 'pending', evidenceLabels: ['工具已返回，业务未确认'] });
    const failed = fixture([{ type: 'turn.started', turnId: root, payload: {} }, called(root, 'read-only'), result(root, { status: 'error', message: 'actual error' }), plan(root, [planStep('failed', [2])])]);
    expect(projectTaskPlan(failed, root, qualify)?.steps[0]?.status).toBe('failed');
  });

  it('ignores unrelated or future sources and accepts original facts from the same recovery chain', () => {
    const events = fixture([{ type: 'turn.started', turnId: other, payload: {} }, called(other, 'read-only'), result(other), { type: 'turn.started', turnId: root, payload: {} }, plan(root, [planStep('completed', [2, 6])])]);
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('pending');
    append(events, called(root, 'read-only'), result(root), { type: 'turn.started', turnId: second, payload: {} }, { type: 'turn.recovery.started', turnId: second, payload: { sourceTurnId: root, mode: 'continue' } }, plan(second, [planStep('completed', [6])], 2));
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('completed');
  });

  it('does not use file-only verification as entire-call plan completion', () => {
    const events = fixture([{ type: 'turn.started', turnId: root, payload: {} }, called(root, 'opaque'), result(root, { status: 'error', message: 'hook' }), verification(1, 'completed', 'file-effect'), plan(root, [planStep('completed', [3])])]);
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('blocked');
    append(events, verification(1, 'completed'), plan(root, [planStep('completed', [5])], 2));
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('completed');
  });

  it('requires actual final response and Core completion, and excludes verify-only replies', () => {
    const events = fixture([{ type: 'turn.started', turnId: root, payload: {} }, plan(root, [planStep('in_progress', [], 'response')])]);
    append(events, { type: 'assistant.message', turnId: root, payload: { stepId, content: 'actual final answer', toolCalls: [] } });
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('in_progress');
    append(events, { type: 'turn.failed', turnId: root, payload: { errorName: 'Error', errorMessage: 'failed before completed' } }, { type: 'turn.started', turnId: verify, payload: {} }, { type: 'turn.recovery.started', turnId: verify, payload: { sourceTurnId: root, mode: 'verify' } }, { type: 'assistant.message', turnId: verify, payload: { stepId, content: 'verification only', toolCalls: [] } }, { type: 'turn.completed', turnId: verify, payload: {} });
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('in_progress');
    append(events, { type: 'turn.started', turnId: second, payload: {} }, { type: 'turn.recovery.started', turnId: second, payload: { sourceTurnId: verify, mode: 'continue' } }, { type: 'assistant.message', turnId: second, payload: { stepId, content: 'delivered work', toolCalls: [] } }, { type: 'turn.completed', turnId: second, payload: {} });
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('completed');
  });

  it('rejects deletion or revocation of a completed stable step', () => {
    const events = fixture([{ type: 'turn.started', turnId: root, payload: {} }, called(root, 'read-only'), result(root), plan(root, [planStep('completed', [2])]), plan(root, [], 2)]);
    expect(() => projectTaskPlan(events, root, qualify)).toThrow('已完成计划步骤不得删除或撤销');
  });

  it('preserves a truly completed response step across later plan revisions in a recovery Turn', () => {
    const events = fixture([
      { type: 'turn.started', turnId: root, payload: {} }, plan(root, [planStep('in_progress', [], 'response')]),
      { type: 'assistant.message', turnId: root, payload: { stepId, content: 'original delivered text', toolCalls: [] } },
      { type: 'step.completed', turnId: root, payload: { stepId } }, { type: 'turn.completed', turnId: root, payload: {} },
      { type: 'turn.started', turnId: second, payload: {} },
      { type: 'turn.recovery.started', turnId: second, payload: { sourceTurnId: root, mode: 'continue' } },
      plan(second, [planStep('completed', [], 'response'), { ...planStep('pending'), id: 'new-work' }], 2),
    ]);
    expect(projectTaskPlan(events, root, qualify)?.steps.map(step => step.status)).toEqual(['completed', 'pending']);
    const changed = [...events.slice(0, -1)];
    append(changed, plan(second, [{ ...planStep('completed', [], 'response'), description: 'different work' }], 2));
    expect(() => projectTaskPlan(changed, root, qualify)).toThrow('已完成计划步骤不得删除或撤销');
    const revoked = [...events.slice(0, -1)];
    append(revoked, plan(second, [planStep('pending', [], 'response')], 2));
    expect(() => projectTaskPlan(revoked, root, qualify)).toThrow('已完成计划步骤不得删除或撤销');
  });

  it('shows true unknown effect as blocked and leaves incomplete plans blocked after a final response', () => {
    const events = fixture([{ type: 'turn.started', turnId: root, payload: {} }, called(root, 'opaque'), plan(root, [planStep('blocked', [1])]), { type: 'turn.completed', turnId: root, payload: {} }]);
    const projected = projectTaskPlan(events, root, qualify);
    expect(projected?.steps[0]?.status).toBe('blocked');
    expect(projectTaskState(events, root, projected)).toBe('blocked');
    append(events, verification(1, 'not-applied'));
    expect(projectTaskState(events, root, projectTaskPlan(events, root, qualify))).toBe('blocked');
  });

  it('blocks a qualified success while host observation is unresolved and restores the real completion after verification', () => {
    const events = fixture([
      { type: 'turn.started', turnId: root, payload: {} }, called(root, 'checkpointed'), result(root),
      plan(root, [planStep('completed', [2])]), verification(1, 'unresolved'),
      plan(root, [planStep('completed')], 2),
    ]);
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('blocked');
    expect(projectRecoveryFacts(events).successfulCalls).toHaveLength(1);
    // blocked 不能让模型删除已取得完成证据的原步骤。
    expect(() => projectTaskPlan(events, root, qualify, plan(root, [], 3))).toThrow('已完成计划步骤不得删除或撤销');
    append(events, verification(1, 'completed'));
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('completed');
    expect(events[2]).toMatchObject(result(root));
  });

  it('propagates a newer unresolved observation through the old completed verification plan source', () => {
    const events = fixture([
      { type: 'turn.started', turnId: root, payload: {} }, called(root, 'opaque'),
      result(root, { status: 'error', message: 'actual outcome was unknown' }), verification(1, 'completed'),
      plan(root, [planStep('completed', [3])]), verification(1, 'unresolved'), plan(root, [planStep('completed')], 2),
    ]);
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('blocked');
    expect(() => projectTaskPlan(events, root, qualify, plan(root, [], 3))).toThrow('已完成计划步骤不得删除或撤销');
    append(events, verification(1, 'completed'));
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('completed');
  });
});
