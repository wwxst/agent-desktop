import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-desktop/agent';
import type { Model, ModelRequest, ModelResponse, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, type SessionEvent, type TurnId } from '@agent-desktop/session';
import {
  runTurn,
  type ExecutionTrace,
  type ExecutionTraceEvent,
} from '../src/index.js';

type Tool = Parameters<Agent['tools']['register']>[0];
type ToolRegistry = Agent['tools'];

class TestToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): readonly Tool[] {
    return [...this.tools.values()];
  }
}

class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];

  public constructor(private readonly responses: readonly ModelResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (!response) throw new Error('Scripted model ran out of responses');
    return response;
  }
}

function createTestAgent(model: Model, session = new InMemorySession(), tools = new TestToolRegistry()): Agent {
  return {
    model,
    session,
    tools,
    systemPrompt: { build: () => 'Base instructions.' },
  };
}

function eventTypes(session: InMemorySession): string[] {
  return session.events().map((event) => event.type);
}

function createTestTrace(events: ExecutionTraceEvent[]): ExecutionTrace {
  return async (event: ExecutionTraceEvent) => {
    events.push(event);
  };
}

describe('runTurn', () => {
  it('completes a text-only turn in one step', async () => {
    const model = new ScriptedModel([{ text: 'hello back', toolCalls: [] }]);
    const session = new InMemorySession();

    const result = await runTurn(createTestAgent(model, session), 'hello');

    expect(result.stepCount).toBe(1);
    expect(result.response).toEqual({ text: 'hello back', toolCalls: [] });
    expect(model.requests).toHaveLength(1);
    expect(eventTypes(session)).toEqual([
      'turn.started',
      'user.message',
      'step.started',
      'assistant.message',
      'step.completed',
      'turn.completed',
    ]);
  });

  it('executes one tool call and rebuilds the next request from Session events', async () => {
    const callId = 'call-1' as ToolCallId;
    const model = new ScriptedModel([
      { text: 'calling echo', toolCalls: [{ id: callId, name: 'echo', input: 'hello' }] },
      { text: 'echo complete', toolCalls: [] },
    ]);
    const tools = new TestToolRegistry();
    let executions = 0;
    tools.register({
      name: 'echo',
      description: 'Returns its input.',
      inputSchema: { type: 'string' },
      execute: async (input) => {
        executions += 1;
        return { status: 'success', output: input };
      },
    });
    const session = new InMemorySession();

    const result = await runTurn(createTestAgent(model, session, tools), 'use echo');

    expect(result.stepCount).toBe(2);
    expect(result.response.text).toBe('echo complete');
    expect(executions).toBe(1);
    expect(model.requests[1]?.messages).toEqual([
      { role: 'user', content: 'use echo' },
      { role: 'assistant', content: 'calling echo', toolCalls: [{ id: callId, name: 'echo', input: 'hello' }] },
      { role: 'tool', toolCallId: callId, content: 'hello' },
    ]);
    expect(eventTypes(session)).toEqual([
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

  it('executes multiple tool calls in order within one step', async () => {
    const firstId = 'call-a' as ToolCallId;
    const secondId = 'call-b' as ToolCallId;
    const model = new ScriptedModel([
      {
        toolCalls: [
          { id: firstId, name: 'first', input: 1 },
          { id: secondId, name: 'second', input: 2 },
        ],
      },
      { text: 'done', toolCalls: [] },
    ]);
    const executionOrder: string[] = [];
    const tools = new TestToolRegistry();
    for (const name of ['first', 'second']) {
      tools.register({
        name,
        description: name,
        inputSchema: {},
        execute: async (input) => {
          executionOrder.push(name);
          return { status: 'success', output: input };
        },
      });
    }
    const session = new InMemorySession();

    await runTurn(createTestAgent(model, session, tools), 'run both');

    expect(executionOrder).toEqual(['first', 'second']);
    const events = session.events();
    const calls = events.filter((event): event is Extract<SessionEvent, { type: 'tool.called' }> => event.type === 'tool.called');
    const results = events.filter((event): event is Extract<SessionEvent, { type: 'tool.result' }> => event.type === 'tool.result');
    expect(calls.map((event) => event.toolCallId)).toEqual([firstId, secondId]);
    expect(results.map((event) => event.toolCallId)).toEqual([firstId, secondId]);
    expect(calls[0]?.stepId).toBe(calls[1]?.stepId);
    expect(eventTypes(session).filter((type) => type === 'step.completed')).toHaveLength(2);
    expect(model.requests[1]?.messages.slice(-2)).toEqual([
      { role: 'tool', toolCallId: firstId, content: '1' },
      { role: 'tool', toolCallId: secondId, content: '2' },
    ]);
  });

  it('records an unknown tool as an error and continues to the next step', async () => {
    const callId = 'missing-call' as ToolCallId;
    const model = new ScriptedModel([
      { toolCalls: [{ id: callId, name: 'missing', input: null }] },
      { text: 'recovered', toolCalls: [] },
    ]);
    const session = new InMemorySession();

    await runTurn(createTestAgent(model, session), 'use missing');

    const result = session.events().find((event): event is Extract<SessionEvent, { type: 'tool.result' }> => event.type === 'tool.result');
    expect(result?.result).toEqual({ status: 'error', message: 'Tool not found: missing' });
    expect(model.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: callId,
      content: 'Tool not found: missing',
    });
  });

  it('traces an unknown tool as a failed Tool boundary', async () => {
    const callId = 'trace-missing-call' as ToolCallId;
    const model = new ScriptedModel([
      { toolCalls: [{ id: callId, name: 'missing', input: null }] },
      { text: 'handled missing tool', toolCalls: [] },
    ]);
    const traceEvents: ExecutionTraceEvent[] = [];

    await runTurn(
      createTestAgent(model),
      'use missing',
      createTestTrace(traceEvents),
    );

    expect(traceEvents.map((event) => event.type)).toEqual([
      'turn.started',
      'model.started',
      'model.completed',
      'tool.started',
      'tool.failed',
      'model.started',
      'model.completed',
      'turn.completed',
    ]);
    const failedEvent = traceEvents.find((event) => event.type === 'tool.failed');
    expect(failedEvent).toMatchObject({
      toolCallId: callId,
      toolName: 'missing',
    });
    expect(failedEvent).not.toHaveProperty('errorMessage');
  });

  it('converts a thrown tool error to an error result and continues', async () => {
    const callId = 'throw-call' as ToolCallId;
    const model = new ScriptedModel([
      { toolCalls: [{ id: callId, name: 'boom', input: {} }] },
      { text: 'continued', toolCalls: [] },
    ]);
    const tools = new TestToolRegistry();
    const throwingTool: Tool = {
      name: 'boom',
      description: 'Throws.',
      inputSchema: {},
      execute: async () => { throw new Error('boom'); },
    };
    tools.register(throwingTool);
    const session = new InMemorySession();

    await runTurn(createTestAgent(model, session, tools), 'run boom');

    const result = session.events().find((event): event is Extract<SessionEvent, { type: 'tool.result' }> => event.type === 'tool.result');
    expect(result?.result).toEqual({ status: 'error', message: 'boom' });
    expect(model.requests[1]?.messages.at(-1)).toEqual({ role: 'tool', toolCallId: callId, content: 'boom' });
  });

  it('does not convert a non-Error thrown value into a tool result', async () => {
    const callId = 'non-error-call' as ToolCallId;
    const thrown = Object.create(null) as object;
    const model = new ScriptedModel([
      { toolCalls: [{ id: callId, name: 'throw-value', input: null }] },
      { text: 'continued', toolCalls: [] },
    ]);
    const tools = new TestToolRegistry();
    tools.register({
      name: 'throw-value',
      description: 'Throws a value.',
      inputSchema: {},
      execute: async () => { throw thrown; },
    });
    const session = new InMemorySession();

    await expect(runTurn(createTestAgent(model, session, tools), 'run tool'))
      .rejects.toBe(thrown);
    expect(session.events().some((event) => event.type === 'tool.result')).toBe(false);
  });

  it('does not hide a circular tool result', async () => {
    const callId = 'circular-call' as ToolCallId;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const model = new ScriptedModel([
      { toolCalls: [{ id: callId, name: 'circular', input: null }] },
      { text: 'continued', toolCalls: [] },
    ]);
    const tools = new TestToolRegistry();
    tools.register({
      name: 'circular',
      description: 'Returns a circular value.',
      inputSchema: {},
      execute: async () => ({ status: 'success', output: circular }),
    });

    await expect(runTurn(createTestAgent(model, new InMemorySession(), tools), 'run tool'))
      .rejects.toThrow(TypeError);
  });

  it('rejects an undefined tool result output', async () => {
    const callId = 'undefined-call' as ToolCallId;
    const model = new ScriptedModel([
      { toolCalls: [{ id: callId, name: 'undefined-result', input: null }] },
      { text: 'continued', toolCalls: [] },
    ]);
    const tools = new TestToolRegistry();
    tools.register({
      name: 'undefined-result',
      description: 'Returns undefined.',
      inputSchema: {},
      execute: async () => ({ status: 'success', output: undefined }),
    });

    await expect(runTurn(createTestAgent(model, new InMemorySession(), tools), 'run tool'))
      .rejects.toThrow('Tool result output must be JSON-serializable');
  });

  it('rebuilds prior user and assistant messages from Session', async () => {
    const session = new InMemorySession();
    const priorTurnId = 'prior-turn' as TurnId;
    const priorStepId = 'prior-step' as import('@agent-desktop/session').StepId;
    session.append({ type: 'turn.started', turnId: priorTurnId });
    session.append({ type: 'user.message', turnId: priorTurnId, content: 'previous' });
    session.append({ type: 'step.started', turnId: priorTurnId, stepId: priorStepId });
    session.append({ type: 'assistant.message', turnId: priorTurnId, stepId: priorStepId, content: 'previous answer', toolCalls: [] });
    session.append({ type: 'step.completed', turnId: priorTurnId, stepId: priorStepId });
    session.append({ type: 'turn.completed', turnId: priorTurnId });
    const model = new ScriptedModel([{ text: 'current answer', toolCalls: [] }]);

    await runTurn(createTestAgent(model, session), 'current');

    expect(model.requests[0]?.messages).toEqual([
      { role: 'user', content: 'previous' },
      { role: 'assistant', content: 'previous answer', toolCalls: [] },
      { role: 'user', content: 'current' },
    ]);
  });

  it('uses the System Prompt boundary without adding a system message', async () => {
    const model = new ScriptedModel([{ text: 'done', toolCalls: [] }]);

    await runTurn(createTestAgent(model), 'hello');

    expect(model.requests[0]?.systemPrompt).toBe('Base instructions.');
    expect(model.requests[0]?.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('projects tools to model definitions without exposing execute', async () => {
    const model = new ScriptedModel([{ text: 'done', toolCalls: [] }]);
    const tools = new TestToolRegistry();
    tools.register({
      name: 'echo',
      description: 'Returns its input.',
      inputSchema: { type: 'string' },
      execute: async (input) => ({ status: 'success', output: input }),
    });

    await runTurn(createTestAgent(model, new InMemorySession(), tools), 'hello');

    expect(model.requests[0]?.tools).toEqual([
      { name: 'echo', description: 'Returns its input.', inputSchema: { type: 'string' } },
    ]);
    expect(model.requests[0]?.tools[0]).not.toHaveProperty('execute');
  });

  it('propagates model failure while retaining started Session events', async () => {
    const model: Model = { complete: async () => { throw new Error('model down'); } };
    const session = new InMemorySession();

    await expect(runTurn(createTestAgent(model, session), 'hello')).rejects.toThrow('model down');
    expect(eventTypes(session)).toEqual(['turn.started', 'user.message', 'step.started']);
  });

  it('traces successful Model and Tool boundaries in execution order', async () => {
    const callId = 'trace-call' as ToolCallId;
    const model = new ScriptedModel([
      { text: 'calling echo', toolCalls: [{ id: callId, name: 'echo', input: 'private input' }] },
      { text: 'private final response', toolCalls: [] },
    ]);
    const tools = new TestToolRegistry();
    tools.register({
      name: 'echo',
      description: 'Returns its input.',
      inputSchema: { type: 'string' },
      execute: async () => ({ status: 'success', output: 'private output' }),
    });
    const traceEvents: ExecutionTraceEvent[] = [];

    const result = await runTurn(
      createTestAgent(model, new InMemorySession(), tools),
      'private user input',
      createTestTrace(traceEvents),
    );

    expect(traceEvents.map((event) => event.type)).toEqual([
      'turn.started',
      'model.started',
      'model.completed',
      'tool.started',
      'tool.completed',
      'model.started',
      'model.completed',
      'turn.completed',
    ]);
    expect(traceEvents.every((event) => event.turnId === result.turnId)).toBe(true);

    const modelStarted = traceEvents.filter(
      (event): event is Extract<ExecutionTraceEvent, { type: 'model.started' }> => event.type === 'model.started',
    );
    expect(modelStarted).toMatchObject([
      { messageCount: 1, toolDefinitionCount: 1 },
      { messageCount: 3, toolDefinitionCount: 1 },
    ]);

    const modelCompleted = traceEvents.filter(
      (event): event is Extract<ExecutionTraceEvent, { type: 'model.completed' }> => event.type === 'model.completed',
    );
    expect(modelCompleted).toMatchObject([
      { toolCallCount: 1, hasText: true },
      { toolCallCount: 0, hasText: true },
    ]);

    const toolStarted = traceEvents.find(
      (event): event is Extract<ExecutionTraceEvent, { type: 'tool.started' }> => event.type === 'tool.started',
    );
    expect(toolStarted).toMatchObject({
      stepId: modelStarted[0]?.stepId,
      toolCallId: callId,
      toolName: 'echo',
    });
    expect(traceEvents.filter((event) => 'durationMs' in event)
      .every((event) => event.durationMs >= 0)).toBe(true);
    expect(traceEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ input: expect.anything() }),
      expect.objectContaining({ output: expect.anything() }),
      expect.objectContaining({ content: expect.anything() }),
    ]));
  });

  it('traces a Tool error result without changing Agent Loop behavior', async () => {
    const callId = 'failed-call' as ToolCallId;
    const model = new ScriptedModel([
      { toolCalls: [{ id: callId, name: 'failing', input: null }] },
      { text: 'handled failure', toolCalls: [] },
    ]);
    const tools = new TestToolRegistry();
    tools.register({
      name: 'failing',
      description: 'Returns an error.',
      inputSchema: {},
      execute: async () => ({ status: 'error', message: 'Failed to open E:\\private\\clip.mp4' }),
    });
    const session = new InMemorySession();
    const traceEvents: ExecutionTraceEvent[] = [];

    const result = await runTurn(
      createTestAgent(model, session, tools),
      'run failing tool',
      createTestTrace(traceEvents),
    );

    expect(result.response.text).toBe('handled failure');
    const failedEvent = traceEvents.find((event) => event.type === 'tool.failed');
    expect(failedEvent).toMatchObject({
      type: 'tool.failed',
      toolCallId: callId,
      toolName: 'failing',
    });
    expect(failedEvent).not.toHaveProperty('errorMessage');
    expect(session.events().find((event) => event.type === 'tool.result')).toMatchObject({
      result: { status: 'error', message: 'Failed to open E:\\private\\clip.mp4' },
    });
    expect(traceEvents.at(-1)?.type).toBe('turn.completed');
  });

  it('traces Model and Turn failures while preserving the original Error', async () => {
    const failure = new TypeError('model unavailable');
    const model: Model = { complete: async () => { throw failure; } };
    const traceEvents: ExecutionTraceEvent[] = [];

    await expect(runTurn(
      createTestAgent(model),
      'private user input',
      createTestTrace(traceEvents),
    )).rejects.toBe(failure);

    expect(traceEvents.map((event) => event.type)).toEqual([
      'turn.started',
      'model.started',
      'model.failed',
      'turn.failed',
    ]);
    expect(traceEvents.find((event) => event.type === 'model.failed')).toMatchObject({
      errorName: 'TypeError',
      errorMessage: 'model unavailable',
    });
    expect(traceEvents.at(-1)).toMatchObject({
      type: 'turn.failed',
      errorName: 'TypeError',
      errorMessage: 'model unavailable',
    });
  });
});
