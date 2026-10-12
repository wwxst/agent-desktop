import { describe, expect, it, vi } from 'vitest';
import { prepareTurnStart, runStartedTurn, runTurn } from '@agent-desktop/agent-loop';
import type { Model, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, projectRecoveryFacts, type SessionEvent, type StepId, type TurnId } from '@agent-desktop/session';
import { InMemoryToolRegistry, type Tool } from '@agent-desktop/tools';
import { projectAgentTaskState, qualifyTaskToolEvidence, taskToolGate } from '../src/main/agent-task-state.js';

const turn = 'turn-1' as TurnId;
const step = 'step-1' as StepId;
const call = 'call-1' as ToolCallId;

function eventsFor(name: string, output: unknown): SessionEvent[] {
  return [
    { type: 'turn.started', turnId: turn },
    { type: 'tool.called', turnId: turn, stepId: step, toolCallId: call, name, input: {}, boundary: 'read-only' },
    { type: 'tool.result', turnId: turn, stepId: step, toolCallId: call, result: { status: 'success', output } },
  ];
}

describe('Desktop task state projection', () => {
  it('qualifies local completed operations and rejects terminal acknowledgement as business completion', () => {
    const command = eventsFor('run_command', { exitCode: 0, termination: 'exited' });
    expect(qualifyTaskToolEvidence(command[2] as Extract<SessionEvent, { type: 'tool.result' }>, command)).toEqual({
      eligible: true, label: '命令已退出（退出码 0）',
    });
    const terminal = eventsFor('write_terminal', { status: 'running' });
    expect(qualifyTaskToolEvidence(terminal[2] as Extract<SessionEvent, { type: 'tool.result' }>, terminal).eligible).toBe(false);
  });

  it('requires every delegated child to complete', () => {
    const incomplete = eventsFor('delegate_tasks', { tasks: [{ status: 'completed' }, { status: 'failed' }] });
    expect(qualifyTaskToolEvidence(incomplete[2] as Extract<SessionEvent, { type: 'tool.result' }>, incomplete).eligible).toBe(false);
    const complete = eventsFor('delegate_tasks', { tasks: [{ status: 'completed' }, { status: 'completed' }] });
    expect(qualifyTaskToolEvidence(complete[2] as Extract<SessionEvent, { type: 'tool.result' }>, complete).eligible).toBe(true);
  });

  it('projects a plan from real tool facts and preserves task ancestry', () => {
    const events = eventsFor('read_file', { path: 'notes.txt' });
    events.push(
      { type: 'plan.updated', turnId: turn, revision: 1, explanation: '读取并回复', steps: [{
        id: 'read', description: '读取文件', requestedStatus: 'completed', completionKind: 'tool', evidenceEventIndexes: [2],
      }] },
      { type: 'turn.completed', turnId: turn },
    );
    expect(projectAgentTaskState(events, turn)).toEqual({
      rootTurnId: turn,
      latestTurnId: turn,
      status: 'completed',
      plan: {
        revision: 1,
        explanation: '读取并回复',
        steps: [{ id: 'read', description: '读取文件', status: 'completed', completionKind: 'tool', evidenceLabels: ['文件已读取'] }],
      },
    });
  });

  it('does not claim unknown tools completed', () => {
    const events = eventsFor('mcp_unknown', { ok: true });
    expect(qualifyTaskToolEvidence(events[2] as Extract<SessionEvent, { type: 'tool.result' }>, events)).toEqual({
      eligible: false, label: '工具已返回，业务结果未确认',
    });
  });
});

describe('Desktop per-call recovery gate', () => {
  it('matches a denied nested input independent of key order and permits a new explicit turn', async () => {
    const session = new InMemorySession();
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'error', failureKind: 'denied', message: '用户拒绝。' }));
    const tools = new InMemoryToolRegistry();
    tools.register({ name: 'writer', description: '', inputSchema: {}, executionBoundary: 'checkpointed', execute });
    let requests = 0;
    const model: Model = { complete: async () => ++requests === 1 ? { toolCalls: [
      { id: 'first' as ToolCallId, name: 'writer', input: { nested: { a: 1, b: 2 } } },
      { id: 'reordered' as ToolCallId, name: 'writer', input: { nested: { b: 2, a: 1 } } },
    ] } : { text: '已拒绝。', toolCalls: [] } };
    const agent = { session, tools, model, systemPrompt: { build: () => '逐调用审批。' } };
    const options = { beforeToolCall: (input: Parameters<typeof taskToolGate>[1]) => taskToolGate(session.events(), input) };

    await runTurn(agent, '写入', options);

    expect(execute).toHaveBeenCalledOnce();
    expect(session.events().find(event => event.type === 'tool.called' && event.toolCallId === 'reordered'))
      .toMatchObject({ boundary: 'not-executed' });
    expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);
    requests = 0;
    await runTurn(agent, '重新申请', options);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('uses a successful result from an interrupted recovery chain instead of replaying its writer', async () => {
    const original = prepareTurnStart('写入原文件');
    const sourceEventIndex = original.events.length;
    const session = new InMemorySession([...original.events,
      { type: 'tool.called', turnId: original.turnId, stepId: step, toolCallId: call,
        name: 'writer', input: { path: 'done' }, boundary: 'checkpointed' },
      { type: 'tool.result', turnId: original.turnId, stepId: step, toolCallId: call,
        result: { status: 'success', output: 'already written' } },
      { type: 'turn.interrupted', turnId: original.turnId, reason: 'process-exit' },
    ]);
    const recovery = prepareTurnStart('继续', { sourceTurnId: original.turnId, mode: 'continue' });
    session.appendMany(recovery.events);
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', output: 'duplicate' }));
    const tools = new InMemoryToolRegistry();
    tools.register({ name: 'writer', description: '', inputSchema: {}, executionBoundary: 'checkpointed', execute });
    let requests = 0;
    const model: Model = { complete: async () => ++requests === 1
      ? { toolCalls: [{ id: 'duplicate' as ToolCallId, name: 'writer', input: { path: 'done' } }] }
      : { text: '使用已完成结果。', toolCalls: [] } };

    await runStartedTurn({ session, tools, model, systemPrompt: { build: () => '恢复不重放。' } }, recovery.turnId,
      { beforeToolCall: input => taskToolGate(session.events(), input) });

    expect(execute).not.toHaveBeenCalled();
    expect(session.events().find(event => event.type === 'tool.result' && event.toolCallId === 'duplicate'))
      .toMatchObject({ result: { status: 'error', failureKind: 'permanent', output: { sourceEventIndexes: [sourceEventIndex] } } });
    expect(projectRecoveryFacts(session.events()).successfulCalls).toHaveLength(1);
    expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);
  });

  it('permits observation while an effect is unknown and releases a writer only after not-applied verification', () => {
    const original = prepareTurnStart('原外部操作');
    const sourceEventIndex = original.events.length;
    const session = new InMemorySession([...original.events,
      { type: 'tool.called', turnId: original.turnId, stepId: step, toolCallId: call,
        name: 'external', input: {}, boundary: 'opaque' },
      { type: 'turn.interrupted', turnId: original.turnId, reason: 'process-exit' },
    ]);
    const recovery = prepareTurnStart('继续核验', { sourceTurnId: original.turnId, mode: 'verify' });
    session.appendMany(recovery.events);
    const writer: Tool = { name: 'writer', description: '', inputSchema: {}, executionBoundary: 'checkpointed',
      execute: async () => ({ status: 'success', output: 'write' }) };
    const input = { turnId: recovery.turnId, stepId: step, call: { id: 'next' as ToolCallId, name: writer.name, input: {} },
      tool: writer, sourceEventIndex: session.events().length };
    expect(taskToolGate(session.events(), input).blocked?.sourceEventIndexes).toEqual([sourceEventIndex]);
    expect(taskToolGate(session.events(), { ...input, tool: { ...writer, executionBoundary: 'read-only' } }).blocked).toBeUndefined();

    session.append({ type: 'effect.outcome.verified', turnId: recovery.turnId, sourceEventIndex,
      scope: 'entire-call', outcome: 'not-applied', evidence: { source: 'user', reference: '人工核验', description: '确认未发生外部操作。' } });

    expect(taskToolGate(session.events(), { ...input, sourceEventIndex: session.events().length }).blocked).toBeUndefined();
    expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);
    expect(session.events()[sourceEventIndex]).toMatchObject({ type: 'tool.called', boundary: 'opaque' });
  });
});
