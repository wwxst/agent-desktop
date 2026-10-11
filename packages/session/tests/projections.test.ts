import { describe, expect, it, vi } from 'vitest';
import type { ToolCallId, ToolResult } from '@agent-desktop/model';
import {
  projectRecoveryAncestry, projectRecoveryFacts, projectTaskPlan, projectTaskState, projectTurnState,
  type ExecutionBoundary, type PlanUpdatedEvent, type SessionEvent, type StepId,
  type TaskPlanStep, type ToolCalledEvent, type TurnId,
} from '@agent-desktop/session';

const root = 'root' as TurnId;
const second = 'second' as TurnId;
const verify = 'verify' as TurnId;
const other = 'other' as TurnId;
const stepId = 'same-step' as StepId;
const toolCallId = 'same-call' as ToolCallId;
const success: ToolResult = { status: 'success', output: { value: 'actual result' } };

function called(turnId: TurnId, boundary?: ExecutionBoundary): ToolCalledEvent {
  return { type: 'tool.called', turnId, stepId, toolCallId, name: 'actual-tool', input: { value: turnId }, ...(boundary === undefined ? {} : { boundary }) };
}
function result(turnId: TurnId, value: ToolResult = success): SessionEvent {
  return { type: 'tool.result', turnId, stepId, toolCallId, result: value };
}
function verification(sourceEventIndex: number, outcome: 'completed' | 'not-applied' | 'unresolved', scope: 'entire-call' | 'file-effect' = 'entire-call'): SessionEvent {
  return { type: 'effect.outcome.verified', turnId: root, sourceEventIndex, scope, outcome,
    evidence: { source: outcome === 'unresolved' ? 'host' : 'user', reference: 'actual evidence', description: 'verified outside the model' } };
}
function plan(turnId: TurnId, steps: readonly TaskPlanStep[], revision = 1): PlanUpdatedEvent {
  return { type: 'plan.updated', turnId, revision, explanation: 'current declaration', steps };
}
function planStep(status: TaskPlanStep['requestedStatus'], evidenceEventIndexes: readonly number[] = [], completionKind: 'tool' | 'response' = 'tool'): TaskPlanStep {
  return { id: 'stable-step', description: 'do the work', requestedStatus: status, evidenceEventIndexes, completionKind };
}
const qualify = () => ({ eligible: true, label: '工具真实完成' });

describe('turn and recovery ancestry', () => {
  it('reads distinct terminal states without inferring a crash from missing terminal facts', () => {
    expect(projectTurnState([], root)).toBeUndefined();
    expect(projectTurnState([{ type: 'turn.started', turnId: root }], root)).toBe('started');
    expect(projectTurnState([{ type: 'turn.cancelled', turnId: root, reason: 'user' }], root)).toBe('cancelled');
    expect(projectTurnState([{ type: 'turn.failed', turnId: root, errorName: 'Error', errorMessage: 'failure' }], root)).toBe('failed');
    expect(projectTurnState([{ type: 'turn.interrupted', turnId: root, reason: 'process-exit' }], root)).toBe('interrupted');
  });

  it('keeps verification in the chain but excludes it from the actual execution terminal', () => {
    const events: SessionEvent[] = [
      { type: 'turn.started', turnId: root },
      { type: 'turn.failed', turnId: root, errorName: 'Error', errorMessage: 'original failed' },
      { type: 'turn.started', turnId: verify },
      { type: 'turn.recovery.started', turnId: verify, sourceTurnId: root, mode: 'verify' },
      { type: 'turn.completed', turnId: verify },
      { type: 'turn.started', turnId: other },
    ];
    expect(projectRecoveryAncestry(events, verify)).toEqual({ rootTurnId: root, turnIds: [root, verify], latestTurnId: verify, latestExecutionTurnId: root });
    expect(projectTaskState(events, root, undefined)).toBe('failed');
    events.push({ type: 'turn.started', turnId: second }, { type: 'turn.recovery.started', turnId: second, sourceTurnId: verify, mode: 'continue' }, { type: 'turn.completed', turnId: second });
    expect(projectRecoveryAncestry(events, root).latestExecutionTurnId).toBe(second);
    expect(projectTaskState(events, root, undefined)).toBe('completed');
  });
});

describe('projectRecoveryFacts', () => {
  it('does not turn nonexecuted requests or unprepared checkpointed calls into unknown effects', () => {
    const events: SessionEvent[] = [called(root, 'not-executed'), called(second, 'read-only'), called(other, 'checkpointed')];
    expect(projectRecoveryFacts(events).unknownEffects).toEqual([]);
    events.push({ type: 'tool.effect.prepared', turnId: other, sourceEventIndex: 2, data: { intent: 'external operation' } });
    expect(projectRecoveryFacts(events).unknownEffects.map(fact => fact.sourceEventIndex)).toEqual([2]);
  });

  it('preserves a successful result in an incomplete Step and pairs repeated IDs by Turn and Step', () => {
    const events: SessionEvent[] = [called(root, 'checkpointed'), result(root), called(second, 'opaque'), result(second, { status: 'error', message: 'failed after external request' })];
    const facts = projectRecoveryFacts(events);
    expect(facts.successfulCalls.map(fact => [fact.sourceEventIndex, fact.resultEventIndex])).toEqual([[0, 1]]);
    expect(facts.unknownEffects.map(fact => [fact.sourceEventIndex, fact.resultEventIndex])).toEqual([[2, 3]]);
    // 残留成功事实不靠虚造 step.completed 才可读取。
    expect(events.some(event => event.type === 'step.completed')).toBe(false);
  });

  it('keeps opaque denial unknown while a bare denied call has no executed effect', () => {
    const events: SessionEvent[] = [
      called(root, 'checkpointed'), result(root, { status: 'error', message: 'declined', failureKind: 'denied' }),
      called(second, 'opaque'), result(second, { status: 'error', message: 'declined inside wrapper', failureKind: 'denied' }),
    ];
    expect(projectRecoveryFacts(events).deniedCalls.map(fact => fact.sourceEventIndex)).toEqual([0, 2]);
    expect(projectRecoveryFacts(events).unknownEffects.map(fact => fact.sourceEventIndex)).toEqual([2]);
  });

  it('treats unspecified legacy boundaries conservatively without inventing process-exit', () => {
    const events: SessionEvent[] = [called(root)];
    expect(projectRecoveryFacts(events).unknownEffects).toHaveLength(1);
    expect(projectTurnState(events, root)).toBeUndefined();
    expect(events).toEqual([called(root)]);
  });

  it('does not allow file-only matching to clear hook effects and does not fabricate a successful result', () => {
    const events: SessionEvent[] = [called(root, 'opaque'), result(root, { status: 'error', message: 'post hook failed' }), verification(0, 'completed', 'file-effect')];
    expect(projectRecoveryFacts(events).unknownEffects).toHaveLength(1);
    events.push(verification(0, 'completed'));
    const facts = projectRecoveryFacts(events);
    expect(facts.unknownEffects).toEqual([]);
    expect(facts.successfulCalls[0]?.result?.result.status).toBe('error');
    expect(events[1]).toEqual(result(root, { status: 'error', message: 'post hook failed' }));
  });

  it('adds unresolved host observation to an already successful terminal send without rewriting success', () => {
    const events: SessionEvent[] = [called(root, 'checkpointed'), result(root), verification(0, 'unresolved')];
    expect(projectRecoveryFacts(events).unknownEffects).toHaveLength(1);
    expect(projectRecoveryFacts(events).successfulCalls).toHaveLength(1);
    events.push(verification(0, 'not-applied'));
    expect(projectRecoveryFacts(events).unknownEffects).toEqual([]);
    expect(events[1]).toEqual(result(root));
  });

  it('keeps failed or missing host phases unknown independently of Core completed', () => {
    const events: SessionEvent[] = [
      { type: 'turn.completed', turnId: root },
      { type: 'host.operation.started', turnId: root, operation: 'stop', description: 'actual host operation' },
      { type: 'host.operation.result', turnId: root, sourceEventIndex: 1, status: 'failed', errorName: 'Error', errorMessage: 'hook failed' },
    ];
    expect(projectTurnState(events, root)).toBe('completed');
    expect(projectTaskState(events, root, undefined)).toBe('blocked');
    events.push(verification(1, 'completed'));
    expect(projectTaskState(events, root, undefined)).toBe('completed');
  });

  it('does not interpret a checkpointed syscall failure as proof that no write happened', () => {
    const events: SessionEvent[] = [called(root, 'checkpointed'), { type: 'tool.effect.prepared', turnId: root, sourceEventIndex: 0, data: {} }, result(root, { status: 'error', message: 'write failed', failureKind: 'unknown-outcome' })];
    expect(projectRecoveryFacts(events).unknownEffects[0]?.preparedEventIndexes).toEqual([1]);
  });
});

describe('projectTaskPlan', () => {
  it('does not accept unsupported completed or failed model declarations', () => {
    const events: SessionEvent[] = [{ type: 'turn.started', turnId: root }, plan(root, [planStep('completed')])];
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('pending');
    events.push(plan(root, [planStep('failed')], 2));
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('pending');
  });

  it('does not qualify legacy unpaired results or results from a gate-rejected call', () => {
    const qualifySpy = vi.fn(qualify);
    const unpaired: SessionEvent[] = [{ type: 'turn.started', turnId: root }, result(root), plan(root, [planStep('completed', [1])])];
    expect(projectTaskPlan(unpaired, root, qualifySpy)?.steps[0]?.status).toBe('pending');
    const blocked: SessionEvent[] = [{ type: 'turn.started', turnId: root }, called(root, 'not-executed'), result(root), plan(root, [planStep('completed', [2])])];
    expect(projectTaskPlan(blocked, root, qualifySpy)?.steps[0]?.status).toBe('pending');
    expect(qualifySpy).not.toHaveBeenCalled();
    expect(unpaired[1]).toEqual(result(root));
  });

  it('completes only from real qualified success and reconstructs failed state from the actual error', () => {
    const events: SessionEvent[] = [{ type: 'turn.started', turnId: root }, called(root, 'read-only'), result(root), plan(root, [planStep('completed', [2])])];
    const callback = vi.fn(qualify);
    expect(projectTaskPlan(events, root, callback)?.steps[0]?.status).toBe('completed');
    expect(callback).toHaveBeenCalledWith(events[2], events);
    expect(projectTaskPlan(events, root, () => ({ eligible: false, label: '工具已返回，业务未确认' }))?.steps[0]).toMatchObject({ status: 'pending', evidenceLabels: ['工具已返回，业务未确认'] });
    const failed: SessionEvent[] = [{ type: 'turn.started', turnId: root }, called(root, 'read-only'), result(root, { status: 'error', message: 'actual error' }), plan(root, [planStep('failed', [2])])];
    expect(projectTaskPlan(failed, root, qualify)?.steps[0]?.status).toBe('failed');
  });

  it('ignores unrelated or future sources and accepts original facts from the same recovery chain', () => {
    const events: SessionEvent[] = [{ type: 'turn.started', turnId: other }, called(other, 'read-only'), result(other), { type: 'turn.started', turnId: root }, plan(root, [planStep('completed', [2, 6])])];
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('pending');
    events.push(called(root, 'read-only'), result(root), { type: 'turn.started', turnId: second }, { type: 'turn.recovery.started', turnId: second, sourceTurnId: root, mode: 'continue' }, plan(second, [planStep('completed', [6])], 2));
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('completed');
  });

  it('does not use file-only verification as entire-call plan completion', () => {
    const events: SessionEvent[] = [{ type: 'turn.started', turnId: root }, called(root, 'opaque'), result(root, { status: 'error', message: 'hook' }), verification(1, 'completed', 'file-effect'), plan(root, [planStep('completed', [3])])];
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('blocked');
    events.push(verification(1, 'completed'), plan(root, [planStep('completed', [5])], 2));
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('completed');
  });

  it('requires actual final response and Core completion, and excludes verify-only replies', () => {
    const events: SessionEvent[] = [{ type: 'turn.started', turnId: root }, plan(root, [planStep('in_progress', [], 'response')])];
    events.push({ type: 'assistant.message', turnId: root, stepId, content: 'actual final answer', toolCalls: [] });
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('in_progress');
    events.push({ type: 'turn.failed', turnId: root, errorName: 'Error', errorMessage: 'failed before completed' }, { type: 'turn.started', turnId: verify }, { type: 'turn.recovery.started', turnId: verify, sourceTurnId: root, mode: 'verify' }, { type: 'assistant.message', turnId: verify, stepId, content: 'verification only', toolCalls: [] }, { type: 'turn.completed', turnId: verify });
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('in_progress');
    events.push({ type: 'turn.started', turnId: second }, { type: 'turn.recovery.started', turnId: second, sourceTurnId: verify, mode: 'continue' }, { type: 'assistant.message', turnId: second, stepId, content: 'delivered work', toolCalls: [] }, { type: 'turn.completed', turnId: second });
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('completed');
  });

  it('rejects deletion or revocation of a completed stable step', () => {
    const events: SessionEvent[] = [{ type: 'turn.started', turnId: root }, called(root, 'read-only'), result(root), plan(root, [planStep('completed', [2])]), plan(root, [], 2)];
    expect(() => projectTaskPlan(events, root, qualify)).toThrow('已完成计划步骤不得删除或撤销');
  });

  it('preserves a truly completed response step across later plan revisions in a recovery Turn', () => {
    const events: SessionEvent[] = [
      { type: 'turn.started', turnId: root }, plan(root, [planStep('in_progress', [], 'response')]),
      { type: 'assistant.message', turnId: root, stepId, content: 'original delivered text', toolCalls: [] },
      { type: 'step.completed', turnId: root, stepId }, { type: 'turn.completed', turnId: root },
      { type: 'turn.started', turnId: second },
      { type: 'turn.recovery.started', turnId: second, sourceTurnId: root, mode: 'continue' },
      plan(second, [planStep('completed', [], 'response'), { ...planStep('pending'), id: 'new-work' }], 2),
    ];
    expect(projectTaskPlan(events, root, qualify)?.steps.map(step => step.status)).toEqual(['completed', 'pending']);
    const changed: SessionEvent[] = [...events.slice(0, -1), plan(second, [{ ...planStep('completed', [], 'response'), description: 'different work' }], 2)];
    expect(() => projectTaskPlan(changed, root, qualify)).toThrow('已完成计划步骤不得删除或撤销');
    const revoked: SessionEvent[] = [...events.slice(0, -1), plan(second, [planStep('pending', [], 'response')], 2)];
    expect(() => projectTaskPlan(revoked, root, qualify)).toThrow('已完成计划步骤不得删除或撤销');
  });

  it('shows true unknown effect as blocked and leaves incomplete plans blocked after a final response', () => {
    const events: SessionEvent[] = [{ type: 'turn.started', turnId: root }, called(root, 'opaque'), plan(root, [planStep('blocked', [1])]), { type: 'turn.completed', turnId: root }];
    const projected = projectTaskPlan(events, root, qualify);
    expect(projected?.steps[0]?.status).toBe('blocked');
    expect(projectTaskState(events, root, projected)).toBe('blocked');
    events.push(verification(1, 'not-applied'));
    expect(projectTaskState(events, root, projectTaskPlan(events, root, qualify))).toBe('blocked');
  });

  it('blocks a qualified success while host observation is unresolved and restores the real completion after verification', () => {
    const events: SessionEvent[] = [
      { type: 'turn.started', turnId: root }, called(root, 'checkpointed'), result(root),
      plan(root, [planStep('completed', [2])]), verification(1, 'unresolved'),
      plan(root, [planStep('completed')], 2),
    ];
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('blocked');
    expect(projectRecoveryFacts(events).successfulCalls).toHaveLength(1);
    // blocked 不能让模型删除已取得完成证据的原步骤。
    expect(() => projectTaskPlan([...events, plan(root, [], 3)], root, qualify)).toThrow('已完成计划步骤不得删除或撤销');
    events.push(verification(1, 'completed'));
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('completed');
    expect(events[2]).toEqual(result(root));
  });

  it('propagates a newer unresolved observation through the old completed verification plan source', () => {
    const events: SessionEvent[] = [
      { type: 'turn.started', turnId: root }, called(root, 'opaque'),
      result(root, { status: 'error', message: 'actual outcome was unknown' }), verification(1, 'completed'),
      plan(root, [planStep('completed', [3])]), verification(1, 'unresolved'), plan(root, [planStep('completed')], 2),
    ];
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('blocked');
    expect(() => projectTaskPlan([...events, plan(root, [], 3)], root, qualify)).toThrow('已完成计划步骤不得删除或撤销');
    events.push(verification(1, 'completed'));
    expect(projectTaskPlan(events, root, qualify)?.steps[0]?.status).toBe('completed');
  });
});
