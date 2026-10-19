import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@agent-desktop/agent';
import { InMemorySession, SessionPersistenceError, TurnCancellationError, type SessionEvent, type SessionEventInput } from '@agent-desktop/session';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import { prepareTurnStart, runStartedTurn, runTurn } from '../src/index.js';

function createAgent(session = new InMemorySession()): Agent {
  return { session, tools: new InMemoryToolRegistry(), systemPrompt: { build: () => 'rules' },
    model: { complete: vi.fn(async () => ({ text: 'done', toolCalls: [] })) } };
}

describe('persisted turn start and terminal ownership', () => {
  it('prepares a pure recoverable start and executes it once without duplicate user history', async () => {
    const agent = createAgent();
    const source = prepareTurnStart('original');
    agent.session.appendMany(source.events);
    agent.session.append({ type: 'turn.failed', turnId: source.turnId, payload: { errorName: 'Error', errorMessage: 'offline' } });
    const start = prepareTurnStart('continue', { sourceTurnId: source.turnId, mode: 'continue' });
    expect(agent.session.events()).toHaveLength(3);
    agent.session.appendMany(start.events);
    await runStartedTurn(agent, start.turnId);
    expect(agent.session.events().filter(event => event.type === 'turn.started')).toHaveLength(2);
    expect(agent.session.events().filter(event => event.type === 'user.message')).toHaveLength(2);
    await expect(runStartedTurn(agent, start.turnId)).rejects.toThrow('尚未执行');
    expect(agent.model.complete).toHaveBeenCalledTimes(1);
  });

  it('does not call the model when the atomic start fails', async () => {
    const failure = new SessionPersistenceError(new Error('disk full'));
    class FailingSession extends InMemorySession {
      override appendMany(_events: readonly SessionEventInput[]): readonly SessionEvent[] { throw failure; }
    }
    const agent = createAgent(new FailingSession());
    await expect(runTurn(agent, 'draft')).rejects.toBe(failure);
    expect(agent.session.events()).toEqual([]);
    expect(agent.model.complete).not.toHaveBeenCalled();
  });

  it('persists cancellation with its actual reason and preserves the original input', async () => {
    const agent = createAgent();
    const controller = new AbortController();
    controller.abort(new TurnCancellationError('window-closed'));
    await expect(runTurn(agent, 'cancel', { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(agent.session.events().at(-1)).toMatchObject({ type: 'turn.cancelled', payload: { reason: 'window-closed' } });
    expect(agent.model.complete).not.toHaveBeenCalled();
  });

  it('keeps Core completion when the completed trace listener fails', async () => {
    const agent = createAgent();
    await expect(runTurn(agent, 'done', { trace: event => {
      if (event.type === 'turn.completed') throw new Error('trace failure');
    } })).rejects.toThrow('trace failure');
    expect(agent.session.events().at(-1)?.type).toBe('turn.completed');
    expect(agent.session.events().some(event => event.type === 'turn.failed')).toBe(false);
  });

  it('records a failed terminal when start diagnostics fail after committing the start', async () => {
    const agent = createAgent();
    await expect(runTurn(agent, 'start', { trace: event => {
      if (event.type === 'turn.started') throw new Error('trace unavailable');
    } })).rejects.toThrow('trace unavailable');
    expect(agent.session.events().at(-1)).toMatchObject({ type: 'turn.failed', payload: { errorMessage: 'trace unavailable' } });
    expect(agent.model.complete).not.toHaveBeenCalled();
  });

  it('keeps typed user cancellation when a provider throws an ordinary AbortError', async () => {
    const base = createAgent();
    const controller = new AbortController();
    const agent: Agent = { ...base, model: { complete: async () => {
      controller.abort(new TurnCancellationError('user'));
      throw new DOMException('aborted', 'AbortError');
    } } };
    await expect(runTurn(agent, 'request', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(agent.session.events().at(-1)).toMatchObject({ type: 'turn.cancelled', payload: { reason: 'user' } });
  });

  it('does not emit model failure diagnostics for a persistence exception', async () => {
    const base = createAgent();
    const failure = new SessionPersistenceError(new Error('listener save'));
    const agent: Agent = { ...base, model: { complete: async () => { throw failure; } } };
    const trace = vi.fn();
    await expect(runTurn(agent, 'request', { trace })).rejects.toBe(failure);
    expect(trace.mock.calls.some(([event]) => event.type === 'model.failed')).toBe(false);
    expect(agent.session.events().at(-1)?.type).toBe('step.started');
  });

  it('propagates a fatal persistence signal without appending a cancellation or failed terminal', async () => {
    const agent = createAgent();
    const controller = new AbortController();
    const failure = new SessionPersistenceError(new Error('checkpoint commit'));
    const failingAgent: Agent = { ...agent, model: { complete: async () => {
      controller.abort(failure); throw new DOMException('aborted', 'AbortError');
    } } };
    await expect(runTurn(failingAgent, 'fatal', { signal: controller.signal })).rejects.toBe(failure);
    expect(agent.session.events().at(-1)?.type).toBe('step.started');
  });
});
