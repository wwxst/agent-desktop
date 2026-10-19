import { describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolCallId } from '@agent-desktop/model';
import {
  InMemorySession,
  recoverSessionEvents,
  SessionPersistenceError,
  TurnCancellationError,
  type SessionEvent,
  type SessionEventInput,
  type StepId,
  type TurnId,
} from '@agent-desktop/session';

const turnId = 'turn-1' as TurnId;
const stepId = 'step-1' as StepId;
const toolCallId = 'call-1' as ToolCallId;

function fixture(inputs: readonly SessionEventInput[]): readonly SessionEvent[] {
  return new InMemorySession([], 'fixture-session').appendMany(inputs);
}

describe('InMemorySession', () => {
  it('appends one event batch without retaining the caller array', () => {
    const session = new InMemorySession();
    const inputs: SessionEventInput[] = [
      { type: 'turn.started', turnId, payload: {} },
      { type: 'user.message', turnId, payload: { content: 'hello' } },
    ];
    const batch = session.appendMany(inputs);
    inputs.pop();
    expect(session.events()).toHaveLength(2);
    expect(session.events()[0]).toBe(batch[0]);
    expect(session.events()[1]).toBe(batch[1]);
  });

  it('keeps the original persistence cause and structured AbortError reason', () => {
    const cause = new Error('disk full');
    const error = new SessionPersistenceError(cause);
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('SessionPersistenceError');
    const cancellation = new TurnCancellationError('window-closed');
    expect(cancellation.name).toBe('AbortError');
    expect(cancellation.reason).toBe('window-closed');
  });

  it('assigns the complete envelope once and keeps business fields only in payload', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T02:03:04.000Z'));
    try {
      const session = new InMemorySession([], 'session-1');
      const started = session.append({ type: 'turn.started', turnId, payload: {} });
      const message = session.append({ type: 'user.message', turnId, payload: { content: 'hello' } });
      expect(session.id).toBe('session-1');
      expect(started).toEqual({ sessionId: 'session-1', turnId, itemId: `turn:${turnId}`, sequence: 1,
        timestamp: '2026-10-19T02:03:04.000Z', type: 'turn.started', payload: {} });
      expect(message).toEqual({ sessionId: 'session-1', turnId, itemId: `user:${turnId}`, sequence: 2,
        timestamp: '2026-10-19T02:03:04.000Z', type: 'user.message', payload: { content: 'hello' } });
      expect(session.events()).toEqual([started, message]);
      expect(session.events()[0]).toBe(started);
      expect(session.events()[1]).toBe(message);
    } finally { vi.useRealTimers(); }
  });

  it('restores exact envelope objects, isolates the seed array, and continues their sequence', () => {
    const original = new InMemorySession([], 'original-session');
    const started = original.append({ type: 'turn.started', turnId, payload: {} });
    const message = original.append({ type: 'user.message', turnId, payload: { content: 'remember 731' } });
    const initialEvents: SessionEvent[] = [started, message];
    const restored = new InMemorySession(initialEvents);
    initialEvents.pop();
    const completed = restored.append({ type: 'turn.completed', turnId, payload: {} });
    expect(restored.id).toBe(original.id);
    expect(restored.events()).toEqual([started, message, completed]);
    expect(restored.events()[0]).toBe(started);
    expect(restored.events()[1]).toBe(message);
    expect(completed.sequence).toBe(3);
    expect(completed.sessionId).toBe(original.id);
    expect(completed.itemId).toBe(started.itemId);
  });

  it('commits a complete candidate batch before exposing the same objects in memory', () => {
    const session = new InMemorySession([], 'transaction-session');
    const previous = session.append({ type: 'turn.started', turnId, payload: {} });
    let saved: readonly SessionEvent[] = [];
    const batch = session.appendMany([
      { type: 'user.message', turnId, payload: { content: 'save atomically' } },
      { type: 'turn.configuration', turnId, payload: { data: { model: 'actual model' } } },
    ], candidate => {
      expect(session.events()).toEqual([previous]);
      expect(candidate.map(event => event.sequence)).toEqual([1, 2, 3]);
      expect(candidate.every(event => event.sessionId === session.id)).toBe(true);
      saved = candidate;
    });
    expect(session.events()).toEqual(saved);
    expect(batch[0]).toBe(saved[1]);
    expect(batch[1]).toBe(saved[2]);
    expect(session.events()[1]).toBe(batch[0]);
    expect(session.events()[2]).toBe(batch[1]);
  });

  it('does not expose a failed batch or consume its sequence before retrying', () => {
    const session = new InMemorySession([], 'transaction-session');
    const previous = session.append({ type: 'turn.started', turnId, payload: {} });
    const failure = new SessionPersistenceError(new Error('SQLite commit failed'));
    expect(() => session.appendMany([
      { type: 'user.message', turnId, payload: { content: 'not committed' } },
      { type: 'turn.configuration', turnId, payload: { data: {} } },
    ], () => { throw failure; })).toThrow(failure);
    expect(session.events()).toEqual([previous]);
    const retry = session.appendMany([
      { type: 'user.message', turnId, payload: { content: 'committed retry' } },
      { type: 'turn.configuration', turnId, payload: { data: {} } },
    ]);
    expect(retry.map(event => event.sequence)).toEqual([2, 3]);
    expect(session.events()[0]).toBe(previous);
    expect(session.events()[1]).toBe(retry[0]);
  });

  it('shares model and tool item identities across their lifecycle without merging reused provider IDs', () => {
    const session = new InMemorySession([], 'identity-session');
    const start = session.append({ type: 'step.started', turnId, payload: { stepId } });
    const assistant = session.append({ type: 'assistant.message', turnId, payload: { stepId, toolCalls: [] } });
    const called = session.append({ type: 'tool.called', turnId, payload: { stepId, toolCallId, name: 'write', input: {} } });
    const prepared = session.append({ type: 'tool.effect.prepared', turnId, payload: { sourceEventIndex: 2, data: {} } });
    const result = session.append({ type: 'tool.result', turnId, payload: { stepId, toolCallId, result: { status: 'success', output: 'actual result' } } });
    const closed = session.append({ type: 'tool.interaction.closed', turnId, payload: { stepId, toolCallId, requestId: 'question', reason: 'cancelled' } });
    const end = session.append({ type: 'step.completed', turnId, payload: { stepId } });
    const otherTurn = 'another-turn' as TurnId;
    const verified = session.append({ type: 'effect.outcome.verified', turnId: otherTurn, payload: { sourceEventIndex: 2,
      scope: 'entire-call', outcome: 'completed', evidence: { source: 'user', reference: 'file', description: 'actual verification' } } });
    const reusedTurn = session.append({ type: 'tool.called', turnId: otherTurn, payload: { stepId, toolCallId, name: 'write', input: {} } });
    const reusedStep = session.append({ type: 'tool.called', turnId, payload: { stepId: 'another-step' as StepId, toolCallId, name: 'write', input: {} } });
    expect([assistant.itemId, end.itemId]).toEqual([start.itemId, start.itemId]);
    expect([prepared.itemId, result.itemId, closed.itemId, verified.itemId]).toEqual(Array(4).fill(called.itemId));
    expect(verified.turnId).toBe(otherTurn);
    expect(new Set([called.itemId, reusedTurn.itemId, reusedStep.itemId]).size).toBe(3);
    expect(called.itemId).not.toBe(start.itemId);
  });

  it('keeps same-batch host results and recovery plan revisions on their semantic items', () => {
    const session = new InMemorySession([], 'host-session');
    const otherTurn = 'continued-turn' as TurnId;
    const batch = session.appendMany([
      { type: 'turn.started', turnId, payload: {} },
      { type: 'host.operation.started', turnId, payload: { operation: 'hook', description: 'actual host work' } },
      { type: 'host.operation.result', turnId, payload: { sourceEventIndex: 1, status: 'completed' } },
      { type: 'plan.updated', turnId, payload: { revision: 1, explanation: 'initial plan', steps: [] } },
      { type: 'turn.started', turnId: otherTurn, payload: {} },
      { type: 'turn.recovery.started', turnId: otherTurn, payload: { sourceTurnId: turnId, mode: 'continue' } },
      { type: 'plan.updated', turnId: otherTurn, payload: { revision: 2, explanation: 'continued plan', steps: [] } },
    ]);
    expect(batch[2]?.itemId).toBe(batch[1]?.itemId);
    expect(batch[6]?.itemId).toBe(batch[3]?.itemId);
    expect(batch.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('represents successful and failed tool results as distinct payload unions', () => {
    const session = new InMemorySession();
    const success = session.append({ type: 'tool.result', turnId, payload: { stepId, toolCallId, result: { status: 'success', output: 'hello' } } });
    const failure = session.append({ type: 'tool.result', turnId, payload: { stepId, toolCallId, result: { status: 'error', message: 'failed' } } });
    expect(success.payload.result.status).toBe('success');
    expect(failure.payload.result.status).toBe('error');
  });

  it('records the model ToolCall contract without redefining it', () => {
    const toolCall: ToolCall = { id: toolCallId, name: 'echo', input: 'hello' };
    const event = new InMemorySession().append({ type: 'assistant.message', turnId, payload: { stepId, toolCalls: [toolCall] } });
    expect(event.payload.toolCalls).toEqual([toolCall]);
  });
});

describe('recoverSessionEvents', () => {
  const cancelledTurnId = 'turn-cancelled' as TurnId;
  const cancelledStepId = 'step-cancelled' as StepId;

  it('does not complete a different Turn that reuses the same Step ID', () => {
    const events = fixture([
      { type: 'turn.started', turnId, payload: {} },
      { type: 'step.started', turnId, payload: { stepId } },
      { type: 'assistant.message', turnId, payload: { stepId, content: 'done', toolCalls: [] } },
      { type: 'step.completed', turnId, payload: { stepId } },
      { type: 'turn.completed', turnId, payload: {} },
      { type: 'turn.started', turnId: cancelledTurnId, payload: {} },
      { type: 'step.started', turnId: cancelledTurnId, payload: { stepId } },
      { type: 'assistant.message', turnId: cancelledTurnId, payload: { stepId, toolCalls: [{ id: toolCallId, name: 'echo', input: 'x' }] } },
      { type: 'tool.called', turnId: cancelledTurnId, payload: { stepId, toolCallId, name: 'echo', input: 'x' } },
      { type: 'tool.effect.prepared', turnId: cancelledTurnId, payload: { sourceEventIndex: 8, data: { intent: 'existing raw fact' } } },
      { type: 'turn.cancelled', turnId: cancelledTurnId, payload: { reason: 'user' } },
    ]);
    const recovered = recoverSessionEvents(events);
    expect(recovered).toEqual([events[0], events[1], events[2], events[3], events[4], events[5], events[9], events[10]]);
    expect(recovered.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 10, 11]);
    expect(recovered[6]).toBe(events[9]);
    expect(events).toHaveLength(11);
  });

  it('keeps a completed Step Tool Calling chain unchanged', () => {
    const toolCall: ToolCall = { id: toolCallId, name: 'trim_video', input: { start: 0 } };
    const events = fixture([
      { type: 'turn.started', turnId, payload: {} },
      { type: 'user.message', turnId, payload: { content: '裁掉前 3 秒' } },
      { type: 'step.started', turnId, payload: { stepId } },
      { type: 'assistant.message', turnId, payload: { stepId, content: '先裁剪。', toolCalls: [toolCall] } },
      { type: 'tool.called', turnId, payload: { stepId, toolCallId, name: 'trim_video', input: { start: 0 } } },
      { type: 'tool.result', turnId, payload: { stepId, toolCallId, result: { status: 'success', output: 'out.mp4' } } },
      { type: 'step.completed', turnId, payload: { stepId } },
      { type: 'turn.completed', turnId, payload: {} },
    ]);
    expect(recoverSessionEvents(events)).toEqual(events);
    expect(recoverSessionEvents(events)[5]).toBe(events[5]);
  });

  it('drops the residue of an incomplete Step but keeps Turn facts', () => {
    const toolCall: ToolCall = { id: toolCallId, name: 'trim_video', input: { start: 0 } };
    const events = fixture([
      { type: 'turn.started', turnId, payload: {} },
      { type: 'user.message', turnId, payload: { content: '裁掉前 3 秒' } },
      { type: 'step.started', turnId, payload: { stepId } },
      { type: 'assistant.message', turnId, payload: { stepId, content: '裁剪完成。', toolCalls: [] } },
      { type: 'step.completed', turnId, payload: { stepId } },
      { type: 'turn.completed', turnId, payload: {} },
      { type: 'turn.started', turnId: cancelledTurnId, payload: {} },
      { type: 'user.message', turnId: cancelledTurnId, payload: { content: '再裁一次' } },
      { type: 'step.started', turnId: cancelledTurnId, payload: { stepId: cancelledStepId } },
      { type: 'assistant.message', turnId: cancelledTurnId, payload: { stepId: cancelledStepId, content: '正在裁剪。', toolCalls: [toolCall] } },
      { type: 'tool.called', turnId: cancelledTurnId, payload: { stepId: cancelledStepId, toolCallId, name: 'trim_video', input: { start: 0 } } },
    ]);
    expect(recoverSessionEvents(events)).toEqual(events.slice(0, 8));
    expect(events).toHaveLength(11);
  });
});
