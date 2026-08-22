import { describe, expect, it } from 'vitest';
import { InMemorySession, type SessionEvent, type StepId, type ToolCallId, type TurnId } from '@agent-desktop/session';

const turnId = 'turn-1' as TurnId;
const stepId = 'step-1' as StepId;
const toolCallId = 'call-1' as ToolCallId;

describe('InMemorySession', () => {
  it('preserves append order and protects the returned history array', () => {
    const session = new InMemorySession();
    const started: SessionEvent = { type: 'turn.started', turnId, timestamp: '2026-01-01T00:00:00.000Z' };
    const message: SessionEvent = { type: 'user.message', turnId, content: 'hello' };

    session.append(started);
    session.append(message);
    const history = session.events();
    (history as SessionEvent[]).pop();

    expect(session.events()).toEqual([started, message]);
  });

  it('represents successful and failed tool results as distinct unions', () => {
    const success: SessionEvent = {
      type: 'tool.result',
      turnId,
      stepId,
      toolCallId,
      result: { status: 'success', output: 'hello' },
    };
    const failure: SessionEvent = {
      type: 'tool.result',
      turnId,
      stepId,
      toolCallId,
      result: { status: 'error', message: 'failed', code: 'E_TEST' },
    };

    expect(success.result.status).toBe('success');
    expect(failure.result.status).toBe('error');
  });
});
