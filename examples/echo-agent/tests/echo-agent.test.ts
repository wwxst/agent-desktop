import { describe, expect, it } from 'vitest';
import { runTurn } from '@agent-desktop/agent-loop';
import type { SessionEvent } from '@agent-desktop/session';
import { createEchoAgent } from '../src/echo.js';

function eventsOfType<Type extends SessionEvent['type']>(
  events: readonly SessionEvent[],
  type: Type,
): Extract<SessionEvent, { type: Type }>[] {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: Type }> => event.type === type,
  );
}

describe('Runnable Echo Agent', () => {
  it('completes an Echo Tool round trip in two steps', async () => {
    const agent = createEchoAgent();

    const result = await runTurn(agent, 'hello');

    const events = agent.session.events();
    expect(result.stepCount).toBe(2);
    expect(result.response).toEqual({ text: 'Echo result: hello', toolCalls: [] });
    expect(eventsOfType(events, 'tool.called')).toMatchObject([
      { name: 'echo', input: { text: 'hello' } },
    ]);
    expect(eventsOfType(events, 'tool.result')).toMatchObject([
      { result: { status: 'success', output: 'hello' } },
    ]);
  });

  it('records the complete Agent Loop event sequence', async () => {
    const agent = createEchoAgent();

    await runTurn(agent, 'hello');

    expect(agent.session.events().map((event) => event.type)).toEqual([
      'turn.started',
      'user.message',
      'step.started',
      'assistant.message',
      'tool.called',
      'tool.result',
      'step.completed',
      'step.started',
      'assistant.message',
      'step.completed',
      'turn.completed',
    ]);
  });

  it('keeps two completed turns in the same Session', async () => {
    const agent = createEchoAgent();

    await runTurn(agent, 'hello');
    await runTurn(agent, 'world');

    const events = agent.session.events();
    const startedTurns = eventsOfType(events, 'turn.started');
    const completedTurns = eventsOfType(events, 'turn.completed');
    expect(startedTurns).toHaveLength(2);
    expect(completedTurns.map((event) => event.turnId)).toEqual(
      startedTurns.map((event) => event.turnId),
    );
    expect(eventsOfType(events, 'user.message').map((event) => event.content)).toEqual([
      'hello',
      'world',
    ]);
  });
});
