import { describe, expect, it, vi } from 'vitest';
import type { ToolCallId, ToolResult } from '@agent-desktop/model';
import {
  InMemorySession, projectTaskPlan, SessionPersistenceError, TaskPlanUpdateError, TurnCancellationError,
  type ExecutionBoundary, type QualifyToolEvidence, type SessionEvent, type StepId, type TaskPlanStep, type TurnId,
} from '@agent-desktop/session';
import { UpdatePlanTool, type ToolExecutionContext } from '@agent-desktop/tools';

const root = 'root' as TurnId;
const child = 'child' as TurnId;
const unrelated = 'unrelated' as TurnId;
const stepId = 'step' as StepId;
const id = 'call' as ToolCallId;
const context: ToolExecutionContext = { toolCallId: id, reportProgress: () => {} };
const qualify: QualifyToolEvidence = () => ({ eligible: true, label: '真实结果完成' });
const success: ToolResult = { status: 'success', output: 'actual file result' };

function step(requestedStatus: TaskPlanStep['requestedStatus'] = 'pending', evidenceEventIndexes: number[] = [], completionKind: 'tool' | 'response' = 'tool'): TaskPlanStep {
  return { id: 'work', description: '完成当前工作', requestedStatus, completionKind, evidenceEventIndexes };
}
function input(steps: readonly TaskPlanStep[] = [step()], explanation = '创建或更新当前工作计划') { return { explanation, steps }; }
function started(events: readonly SessionEvent[] = []) { return new InMemorySession([{ type: 'turn.started', turnId: root }, ...events]); }
function call(boundary: ExecutionBoundary = 'read-only', name = 'read_file', turnId = root): SessionEvent {
  return { type: 'tool.called', turnId, stepId, toolCallId: id, name, input: {}, boundary };
}
function result(value: ToolResult = success, turnId = root): SessionEvent { return { type: 'tool.result', turnId, stepId, toolCallId: id, result: value }; }
function verified(sourceEventIndex: number, outcome: 'completed' | 'not-applied' | 'unresolved', scope: 'entire-call' | 'file-effect' = 'entire-call'): SessionEvent {
  return { type: 'effect.outcome.verified', turnId: root, sourceEventIndex, scope, outcome,
    evidence: { source: outcome === 'unresolved' ? 'host' : 'user', reference: 'original source', description: '真实来源核验' } };
}

describe('UpdatePlanTool', () => {
  it('creates a complete append-only plan and derives revisions and ownership from the active Turn', async () => {
    const session = started(); const tool = new UpdatePlanTool(session, qualify);
    expect(await tool.execute({ ...input(), revision: 99, turnId: unrelated }, context)).toMatchObject({ status: 'success', output: { rootTurnId: root, revision: 1, steps: [{ id: 'work', status: 'pending' }] } });
    expect(await tool.execute(input([step('in_progress')], '开始执行第一项'), context)).toMatchObject({ status: 'success', output: { revision: 2 } });
    expect(session.events().slice(1)).toEqual([
      { type: 'plan.updated', turnId: root, revision: 1, ...input() },
      { type: 'plan.updated', turnId: root, revision: 2, ...input([step('in_progress')], '开始执行第一项') },
    ]);
  });

  it('keeps simple sessions unchanged until the model actually uses the tool', () => {
    const session = started(); new UpdatePlanTool(session, qualify);
    expect(projectTaskPlan(session.events(), root, qualify)).toBeUndefined(); expect(session.events()).toHaveLength(1);
  });

  it('rejects malformed model fields, duplicate IDs and explicit text/step budgets without writing', async () => {
    const invalid: unknown[] = [null, {}, input([], 'empty'), input([step()], ' '), input([step()], 'x'.repeat(1025)),
      input(Array.from({ length: 33 }, (_, index) => ({ ...step(), id: String(index) }))), input([step(), step()]),
      input([{ ...step(), id: 'x'.repeat(65) }]), input([{ ...step(), description: 'x'.repeat(513) }]),
      input([{ ...step(), requestedStatus: 'invented' as TaskPlanStep['requestedStatus'] }]),
      input([{ ...step(), completionKind: 'invented' as TaskPlanStep['completionKind'] }]),
      input([{ ...step(), evidenceEventIndexes: [0, 0] }]), input([{ ...step(), evidenceEventIndexes: [-1] }]),
      input([{ ...step(), evidenceEventIndexes: [0.5] }]), input([{ ...step(), evidenceEventIndexes: [999] }]),
    ];
    for (const value of invalid) {
      const session = started();
      expect(await new UpdatePlanTool(session, qualify).execute(value, context)).toMatchObject({ status: 'error', failureKind: 'permanent' });
      expect(session.events()).toHaveLength(1);
    }
  });

  it('rejects unsupported tool completion and failure declarations', async () => {
    for (const status of ['completed', 'failed', 'blocked'] as const) {
      const session = started(); expect(await new UpdatePlanTool(session, qualify).execute(input([step(status)]), context)).toMatchObject({ status: 'error' });
      expect(session.events()).toHaveLength(1);
    }
    const ineligible = started([call(), result()]);
    expect(await new UpdatePlanTool(ineligible, () => ({ eligible: false, label: '仅工具返回' })).execute(input([step('completed', [2])]), context)).toMatchObject({ status: 'error' });
  });

  it('confirms completion only from qualified real tool results in the current task chain', async () => {
    const session = started([call(), result()]); const tool = new UpdatePlanTool(session, qualify);
    expect(await tool.execute(input([step('completed', [2])]), context)).toMatchObject({ status: 'success', output: { steps: [{ id: 'work', status: 'completed' }] } });
    const restored = new InMemorySession(JSON.parse(JSON.stringify(session.events())) as SessionEvent[]);
    expect(projectTaskPlan(restored.events(), root, qualify)?.steps[0]).toMatchObject({ status: 'completed', completionConfirmed: true, failureConfirmed: false });
  });

  it('uses existing completion evidence in recovery updates but never unrelated or future sources', async () => {
    const session = new InMemorySession([{ type: 'turn.started', turnId: unrelated }, call('read-only', 'read_file', unrelated), result(success, unrelated),
      { type: 'turn.started', turnId: root }, call(), result(), { type: 'turn.failed', turnId: root, errorName: 'Error', errorMessage: 'later failure' },
      { type: 'turn.started', turnId: child }, { type: 'turn.recovery.started', turnId: child, sourceTurnId: root, mode: 'continue' }]);
    const tool = new UpdatePlanTool(session, qualify);
    expect(await tool.execute(input([step('completed', [2])]), context)).toMatchObject({ status: 'error' });
    expect(await tool.execute(input([step('completed', [100])]), context)).toMatchObject({ status: 'error' });
    expect(await tool.execute(input([step('completed', [5])]), context)).toMatchObject({ status: 'success', output: { rootTurnId: root, revision: 1 } });
    expect(session.events().at(-1)).toMatchObject({ type: 'plan.updated', turnId: child });
  });

  it('never uses its own successful result, an unpaired legacy result or a gate-rejected result to confirm completion', async () => {
    for (const events of [[call('read-only', 'update_plan'), result()], [result()], [call('not-executed'), result()]] as const) {
      const session = started(events);
      expect(await new UpdatePlanTool(session, qualify).execute(input([step('completed', [events.length])]), context)).toMatchObject({ status: 'error' });
      expect(session.events()).toHaveLength(events.length + 1);
    }
  });

  it('preserves qualified completed steps and rejects deletion, revocation or ID reuse for different work', async () => {
    const session = started([call(), result()]); const tool = new UpdatePlanTool(session, qualify);
    expect((await tool.execute(input([step('completed', [2])]), context)).status).toBe('success');
    const original = [...session.events()];
    for (const steps of [[{ ...step(), id: 'different' }], [step('pending')], [{ ...step('completed', [2]), description: 'different work' }],
      [{ ...step('completed', [2]), completionKind: 'response' as const }]]) {
      expect(await tool.execute(input(steps), context)).toMatchObject({ status: 'error' }); expect(session.events()).toEqual(original);
    }
    expect(await tool.execute(input([step('completed'), { ...step(), id: 'new-work' }]), context)).toMatchObject({ status: 'success', output: { revision: 2 } });
    expect(projectTaskPlan(session.events(), root, qualify)?.steps[0]?.evidenceEventIndexes).toEqual([2]);
  });

  it('requires a new ID for revised unfinished work while allowing failed work to be replanned', async () => {
    const session = started([call(), result({ status: 'error', message: 'actual read failure', failureKind: 'permanent' })]);
    const tool = new UpdatePlanTool(session, qualify);
    expect((await tool.execute(input([step('failed', [2])]), context)).status).toBe('success');
    expect(await tool.execute(input([{ ...step(), description: 'a different task' }]), context)).toMatchObject({ status: 'error' });
    expect((await tool.execute(input([step('in_progress')], '修复原因后重新执行相同工作'), context)).status).toBe('success');
    expect(projectTaskPlan(session.events(), root, qualify)?.steps[0]?.status).toBe('in_progress');
  });

  it('retains genuine failure evidence even when unknown external effects make its displayed status blocked', async () => {
    const session = started([call('opaque'), result({ status: 'error', message: 'response lost after write', failureKind: 'unknown-outcome' })]);
    expect(await new UpdatePlanTool(session, qualify).execute(input([step('failed', [2])]), context)).toMatchObject({ status: 'success', output: { steps: [{ status: 'blocked' }] } });
    expect(projectTaskPlan(session.events(), root, qualify)?.steps[0]).toMatchObject({ status: 'blocked', failureConfirmed: true, completionConfirmed: false });
  });

  it('does not call gate refusal an executed failure and reconstructs actual blocked sources', async () => {
    const blockedResult: ToolResult = { status: 'error', failureKind: 'permanent', message: 'host gate refused before execution', output: { sourceEventIndexes: [1] } };
    const gate = started([call('not-executed'), result(blockedResult)]);
    expect(await new UpdatePlanTool(gate, qualify).execute(input([step('failed', [2])]), context)).toMatchObject({ status: 'error' });
    for (const source of [call('opaque'), { type: 'turn.interrupted', turnId: root, reason: 'process-exit' } as const,
      { type: 'tool.interaction.closed', turnId: root, stepId, toolCallId: id, requestId: 'question', reason: 'cancelled' } as const]) {
      const session = started([source]); session.append({ type: 'turn.started', turnId: child });
      session.append({ type: 'turn.recovery.started', turnId: child, sourceTurnId: root, mode: 'continue' });
      expect(await new UpdatePlanTool(session, qualify).execute(input([step('blocked', [1])]), context)).toMatchObject({ status: 'success', output: { steps: [{ status: 'blocked' }] } });
    }
  });

  it('keeps completed fact sticky during unresolved observation and requires entire-call verification for new completion', async () => {
    const session = started([call('checkpointed'), result()]); const tool = new UpdatePlanTool(session, qualify);
    expect((await tool.execute(input([step('completed', [2])]), context)).status).toBe('success');
    session.append(verified(1, 'unresolved'));
    expect(await tool.execute(input([step('completed')]), context)).toMatchObject({ status: 'success', output: { steps: [{ status: 'blocked' }] } });
    expect(await tool.execute(input([{ ...step(), id: 'other-work' }]), context)).toMatchObject({ status: 'error' });
    expect(projectTaskPlan(session.events(), root, qualify)?.steps[0]?.completionConfirmed).toBe(true);
    const verifiedSession = started([call('opaque'), result({ status: 'error', message: 'unknown outcome' }), verified(1, 'completed', 'file-effect')]);
    const verifiedTool = new UpdatePlanTool(verifiedSession, qualify);
    expect(await verifiedTool.execute(input([step('completed', [3])]), context)).toMatchObject({ status: 'error' });
    verifiedSession.append(verified(1, 'completed'));
    expect((await verifiedTool.execute(input([step('completed', [4])]), context)).status).toBe('success');
  });

  it('allows response completion intent but confirms only subsequent real final text and Turn completion', async () => {
    const session = started(); const tool = new UpdatePlanTool(session, qualify);
    expect(await tool.execute(input([step('completed', [], 'response')]), context)).toMatchObject({ status: 'success', output: { steps: [{ status: 'pending' }] } });
    session.append({ type: 'assistant.message', turnId: root, stepId, content: 'actual text delivery', toolCalls: [] });
    expect(projectTaskPlan(session.events(), root, qualify)?.steps[0]?.status).toBe('pending');
    session.append({ type: 'step.completed', turnId: root, stepId }); session.append({ type: 'turn.completed', turnId: root });
    expect(projectTaskPlan(session.events(), root, qualify)?.steps[0]).toMatchObject({ status: 'completed', completionConfirmed: true });
  });

  it('propagates cancellation, qualification program errors, save failure and corrupt existing history', async () => {
    const cancellation = new TurnCancellationError('user'); const controller = new AbortController(); controller.abort(cancellation);
    const session = started();
    await expect(new UpdatePlanTool(session, qualify).execute(input(), { ...context, signal: controller.signal })).rejects.toBe(cancellation);
    expect(session.events()).toHaveLength(1);
    const programError = new Error('host qualification bug');
    await expect(new UpdatePlanTool(started([call(), result()]), () => { throw programError; }).execute(input([step('completed', [2])]), context)).rejects.toBe(programError);
    const saveError = new SessionPersistenceError(new Error('disk full'));
    class FailingSession extends InMemorySession { override append(event: SessionEvent): void { if (event.type === 'plan.updated') throw saveError; super.append(event); } }
    const persistent = new FailingSession(session.events());
    await expect(new UpdatePlanTool(persistent, qualify).execute(input(), context)).rejects.toBe(saveError); expect(persistent.events()).toHaveLength(1);
    const corrupt = started([call(), result(), { type: 'plan.updated', turnId: root, revision: 1, ...input([step('completed', [2])]) },
      { type: 'plan.updated', turnId: root, revision: 2, ...input([{ ...step(), id: 'deleted-completion' }]) }]);
    await expect(new UpdatePlanTool(corrupt, qualify).execute(input(), context)).rejects.toBeInstanceOf(TaskPlanUpdateError);
  });

  it('stops if the signal is cancelled while the pure qualification callback is running', async () => {
    const controller = new AbortController(); const error = new TurnCancellationError('user'); const session = started([call(), result()]);
    const callback = vi.fn<QualifyToolEvidence>(() => { controller.abort(error); return qualify(session.events()[2] as never, session.events()); });
    await expect(new UpdatePlanTool(session, callback).execute(input([step('completed', [2])]), { ...context, signal: controller.signal })).rejects.toBe(error);
    expect(session.events()).toHaveLength(3);
  });
});
