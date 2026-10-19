import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@agent-desktop/agent';
import type { Model, ModelResponse, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, projectRecoveryFacts, SessionPersistenceError, type SessionEvent, type SessionEventInput } from '@agent-desktop/session';
import { InMemoryToolRegistry, type Tool } from '@agent-desktop/tools';
import { runTurn, ToolBudgetError, type RunTurnOptions } from '../src/index.js';

const call = (id: string, name = 'write') => ({ id: id as ToolCallId, name, input: { path: id } });
const final: ModelResponse = { text: '已处理当前事实。', toolCalls: [] };

function agentFor(responses: readonly ModelResponse[], session = new InMemorySession()): Agent {
  let request = 0;
  const complete = vi.fn<Model['complete']>(async () => responses[request++]!);
  return { model: { complete }, session, tools: new InMemoryToolRegistry(), systemPrompt: { build: () => '只依据真实结果。' } };
}

/** 记录实际保存批次，反证门禁拒绝不能留下悬空调用或提前向外发布。 */
class RecordingSession extends InMemorySession {
  readonly batches: Array<readonly SessionEvent[]> = [];
  override appendMany(inputs: readonly SessionEventInput[]): readonly SessionEvent[] {
    const events = super.appendMany(inputs);
    this.batches.push(events);
    return events;
  }
}

describe('per-call host gate and bounded tool attempts', () => {
  it('checks the final registered instance before its call is saved and retains the checkpoint source', async () => {
    const agent = agentFor([{ toolCalls: [call('write')] }, final]);
    const execute = vi.fn<Tool['execute']>(async (_input, context) => {
      context.checkpoint?.({ kind: 'actual-effect' });
      return { status: 'success', output: 'written' };
    });
    const tool: Tool = { name: 'write', description: '', inputSchema: {}, contract: { approvalRequirement: 'none' }, execute };
    agent.tools.register(tool);
    const beforeToolCall = vi.fn<NonNullable<RunTurnOptions['beforeToolCall']>>(input => {
      expect(input.tool).toBe(tool);
      expect(input.sourceEventIndex).toBe(agent.session.events().length);
      expect(agent.session.events().some(event => event.type === 'tool.called')).toBe(false);
      return { boundary: 'checkpointed' };
    });

    await runTurn(agent, '执行', { beforeToolCall });

    expect(execute).toHaveBeenCalledOnce();
    const sourceEventIndex = beforeToolCall.mock.calls[0]![0].sourceEventIndex;
    expect(agent.session.events()[sourceEventIndex]).toMatchObject({ type: 'tool.called', payload: { boundary: 'checkpointed' } });
    expect(agent.session.events()[sourceEventIndex + 1]).toMatchObject({ type: 'tool.effect.prepared', payload: { sourceEventIndex } });
  });

  it('rechecks a result before the next call and atomically saves a blocked pair without execution traces', async () => {
    const session = new RecordingSession();
    const agent = agentFor([{ toolCalls: [call('first'), call('second')] }, final], session);
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'error', message: 'response lost', failureKind: 'unknown-outcome' }));
    agent.tools.register({ name: 'write', description: '', inputSchema: {}, contract: { approvalRequirement: 'none' }, execute });
    const beforeToolCall: NonNullable<RunTurnOptions['beforeToolCall']> = () => {
      const unknown = projectRecoveryFacts(session.events()).unknownEffects;
      return { boundary: 'opaque', ...(unknown.length === 0 ? {} : { blocked: {
        message: '须先核验已有外部效果。', sourceEventIndexes: unknown.map(fact => fact.sourceEventIndex),
      } }) };
    };
    const trace = vi.fn();
    const onToolResult = vi.fn();

    await runTurn(agent, '连续写入', { beforeToolCall, trace, onToolResult });

    expect(execute).toHaveBeenCalledOnce();
    const firstIndex = session.events().findIndex(event => event.type === 'tool.called');
    expect(session.batches.find(events => events.length === 2 && events[0]?.type === 'tool.called')).toEqual([
      expect.objectContaining({ type: 'tool.called', payload: expect.objectContaining({ toolCallId: 'second', boundary: 'not-executed' }) }),
      expect.objectContaining({ type: 'tool.result', payload: expect.objectContaining({ toolCallId: 'second', result: {
        status: 'error', failureKind: 'permanent', message: '须先核验已有外部效果。', output: { sourceEventIndexes: [firstIndex] },
      } }) }),
    ]);
    expect(projectRecoveryFacts(session.events()).unknownEffects.map(fact => fact.sourceEventIndex)).toEqual([firstIndex]);
    expect(trace.mock.calls.filter(([event]) => event.type.startsWith('tool.')).map(([event]) => event.toolCallId)).toEqual(['first', 'first']);
    expect(onToolResult.mock.calls).toHaveLength(2);
  });

  it('records an absent tool as a nonexecuted pair while retaining its existing failed trace contract', async () => {
    const session = new RecordingSession();
    const agent = agentFor([{ toolCalls: [call('missing', 'absent')] }, final], session);
    const beforeToolCall = vi.fn<NonNullable<RunTurnOptions['beforeToolCall']>>(() => ({ boundary: 'opaque' }));
    const trace = vi.fn();

    await runTurn(agent, '未知工具', { beforeToolCall, trace });

    expect(beforeToolCall.mock.calls[0]![0].tool).toBeUndefined();
    expect(session.batches.find(events => events[0]?.type === 'tool.called')).toEqual([
      expect.objectContaining({ type: 'tool.called', payload: expect.objectContaining({ boundary: 'not-executed' }) }),
      expect.objectContaining({ type: 'tool.result', payload: expect.objectContaining({ result: { status: 'error', failureKind: 'permanent', message: 'Tool not found: absent' } }) }),
    ]);
    expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);
    expect(trace.mock.calls.filter(([event]) => event.type.startsWith('tool.')).map(([event]) => event.type)).toEqual(['tool.started', 'tool.failed']);
  });

  it('does not execute or publish a blocked attempt when saving its paired facts fails', async () => {
    const failure = new SessionPersistenceError(new Error('paired commit failed'));
    class FailingSession extends RecordingSession {
      override appendMany(events: readonly SessionEventInput[]): readonly SessionEvent[] {
        if (events[0]?.type === 'tool.called') throw failure;
        return super.appendMany(events);
      }
    }
    const agent = agentFor([{ toolCalls: [call('blocked')] }], new FailingSession());
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', output: 'write' }));
    agent.tools.register({ name: 'write', description: '', inputSchema: {}, contract: { approvalRequirement: 'none' }, execute });
    const onToolResult = vi.fn();
    const trace = vi.fn();

    await expect(runTurn(agent, '阻断', { trace, onToolResult, beforeToolCall: () => ({ boundary: 'opaque',
      blocked: { message: '效果未知', sourceEventIndexes: [] } }) })).rejects.toBe(failure);

    expect(execute).not.toHaveBeenCalled();
    expect(onToolResult).not.toHaveBeenCalled();
    expect(trace.mock.calls.some(([event]) => event.type.startsWith('tool.'))).toBe(false);
    expect(agent.session.events().at(-1)?.type).toBe('assistant.message');
  });

  it('counts blocked attempts toward the cap without losing a prior successful write', async () => {
    const agent = agentFor([{ toolCalls: [call('success'), call('blocked'), call('excess')] }]);
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', output: 'real success' }));
    agent.tools.register({ name: 'write', description: '', inputSchema: {}, contract: { approvalRequirement: 'none' }, execute });
    const beforeToolCall = vi.fn<NonNullable<RunTurnOptions['beforeToolCall']>>(input => ({ boundary: 'checkpointed',
      ...(input.call.id === 'blocked' ? { blocked: { message: '不可执行', sourceEventIndexes: [] } } : {}) }));

    await expect(runTurn(agent, '预算', { maxToolCalls: 2, beforeToolCall })).rejects.toBeInstanceOf(ToolBudgetError);

    expect(execute).toHaveBeenCalledOnce();
    expect(beforeToolCall).toHaveBeenCalledTimes(2);
    expect(agent.session.events().filter(event => event.type === 'tool.called').map(event => event.payload.toolCallId)).toEqual(['success', 'blocked']);
    expect(agent.session.events().filter(event => event.type === 'tool.result').map(event => event.payload.result.status)).toEqual(['success', 'error']);
    expect(projectRecoveryFacts(agent.session.events()).successfulCalls).toHaveLength(1);
    expect(projectRecoveryFacts(agent.session.events()).unknownEffects).toEqual([]);
    expect(agent.session.events().at(-1)).toMatchObject({ type: 'turn.failed', payload: { errorName: 'ToolBudgetError' } });
    expect(agent.model.complete).toHaveBeenCalledOnce();
  });

  it('accumulates absent-tool attempts across Steps before exceeding the cap', async () => {
    const agent = agentFor([{ toolCalls: [call('one', 'absent')] }, { toolCalls: [call('two', 'absent')] },
      { toolCalls: [call('three', 'absent')] }]);

    await expect(runTurn(agent, '连续尝试', { maxToolCalls: 2 })).rejects.toBeInstanceOf(ToolBudgetError);

    expect(agent.session.events().filter(event => event.type === 'tool.called').map(event => event.payload.toolCallId)).toEqual(['one', 'two']);
    expect(agent.session.events().filter(event => event.type === 'tool.result')).toHaveLength(2);
    expect(projectRecoveryFacts(agent.session.events()).unknownEffects).toEqual([]);
    expect(agent.model.complete).toHaveBeenCalledTimes(3);
  });
});
