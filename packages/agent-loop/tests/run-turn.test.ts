import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-desktop/agent';
import type { Model, ModelRequest, ModelResponse, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, recoverSessionEvents, type SessionEvent, type TurnId } from '@agent-desktop/session';
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
  it('excludes a cancelled incomplete Tool Calling step from the next Turn model context', async () => {
    const callId = 'cancel-pending-tool' as ToolCallId;
    const controller = new AbortController();
    const traceEvents: ExecutionTraceEvent[] = [];
    let toolStartedResolve!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      toolStartedResolve = resolve;
    });
    const model = new ScriptedModel([
      { toolCalls: [{ id: callId, name: 'pending', input: {} }] },
      { text: 'continued', toolCalls: [] },
    ]);
    const tools = new TestToolRegistry();
    tools.register({
      name: 'pending', description: 'Waits until cancelled.', inputSchema: {},
      execute: async (_input, signal) => new Promise((_resolve, reject) => {
        expect(signal).toBe(controller.signal);
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
        toolStartedResolve();
      }),
    });
    const session = new InMemorySession();
    const agent = createTestAgent(model, session, tools);

    const cancelledTurn = runTurn(agent, 'cancel during tool', createTestTrace(traceEvents), controller.signal);
    await toolStarted;
    controller.abort();

    await expect(cancelledTurn).rejects.toMatchObject({ name: 'AbortError' });
    expect(traceEvents.at(-1)?.type).toBe('turn.cancelled');
    expect(eventTypes(session)).toEqual([
      'turn.started',
      'user.message',
      'step.started',
      'assistant.message',
      'tool.called',
    ]);

    const result = await runTurn(agent, 'continue');

    expect(result.response).toEqual({ text: 'continued', toolCalls: [] });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.messages).toEqual([
      { role: 'user', content: 'cancel during tool' },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('cancels before the next model step and preserves completed tool results', async () => {
    const callId = 'cancel-tool' as ToolCallId;
    const controller = new AbortController();
    let toolCalls = 0;
    let modelCalls = 0;
    const model: Model = {
      complete: async () => {
        modelCalls += 1;
        return modelCalls === 1
          ? { toolCalls: [{ id: callId, name: 'clip', input: {} }] }
          : { text: 'must not run', toolCalls: [] };
      },
    };
    const tools = new TestToolRegistry();
    tools.register({
      name: 'clip', description: 'clip', inputSchema: {},
      execute: async (_input, signal) => {
        toolCalls += 1;
        controller.abort();
        expect(signal?.aborted).toBe(true);
        return { status: 'success', output: 'artifact.mp4' };
      },
    });
    const session = new InMemorySession();

    await expect(runTurn(createTestAgent(model, session, tools), 'cancel', undefined, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(toolCalls).toBe(1);
    expect(modelCalls).toBe(1);
    expect(session.events()).toContainEqual(expect.objectContaining({
      type: 'tool.result',
      result: { status: 'success', output: 'artifact.mp4' },
    }));
  });

  it('passes AbortSignal to the model and reports cancellation distinctly', async () => {
    const controller = new AbortController();
    const traceEvents: ExecutionTraceEvent[] = [];
    const model: Model = {
      complete: async (request) => {
        expect(request.signal).toBe(controller.signal);
        controller.abort();
        throw new DOMException('The operation was aborted', 'AbortError');
      },
    };

    await expect(runTurn(createTestAgent(model), 'cancel', createTestTrace(traceEvents), controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(traceEvents.map((event) => event.type)).toEqual([
      'turn.started', 'model.started', 'turn.cancelled',
    ]);
  });

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

  it('forwards text deltas while Session keeps only the complete assistant message', async () => {
    const model: Model = {
      complete: async (request) => {
        request.onTextDelta?.('你');
        request.onTextDelta?.('好');
        return { text: '你好', toolCalls: [] };
      },
    };
    const session = new InMemorySession();
    const deltas: string[] = [];

    const result = await runTurn(
      createTestAgent(model, session),
      'hello',
      undefined,
      undefined,
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(['你', '好']);
    expect(result.response).toEqual({ text: '你好', toolCalls: [] });
    // 增量只用于实时展示；Session 只保留一次完整 assistant 事实。
    expect(session.events().filter((event) => event.type === 'assistant.message')).toEqual([
      expect.objectContaining({ content: '你好', toolCalls: [] }),
    ]);
    expect(session.events().some((event) => (
      event.type === 'assistant.message' && event.content === '你'
    ))).toBe(false);
  });

  it('forwards the same text delta callback to every model request in a turn', async () => {
    const callId = 'delta-call' as ToolCallId;
    const requests: ModelRequest[] = [];
    const model: Model = {
      complete: async (request) => {
        requests.push(request);
        request.onTextDelta?.('step');
        return requests.length === 1
          ? { text: 'calling', toolCalls: [{ id: callId, name: 'echo', input: 'x' }] }
          : { text: 'final', toolCalls: [] };
      },
    };
    const tools = new TestToolRegistry();
    tools.register({
      name: 'echo',
      description: 'Returns its input.',
      inputSchema: {},
      execute: async () => ({ status: 'success', output: 'ok' }),
    });
    const deltas: string[] = [];
    const onTextDelta = (delta: string) => deltas.push(delta);

    await runTurn(
      createTestAgent(model, new InMemorySession(), tools),
      'use echo',
      undefined,
      undefined,
      onTextDelta,
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.onTextDelta).toBe(onTextDelta);
    expect(requests[1]?.onTextDelta).toBe(onTextDelta);
    expect(deltas).toEqual(['step', 'step']);
  });

  it('omits the text delta callback when the caller does not provide one', async () => {
    const model = new ScriptedModel([{ text: 'done', toolCalls: [] }]);

    await runTurn(createTestAgent(model), 'hello');

    expect(model.requests[0]).not.toHaveProperty('onTextDelta');
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

  it('continues a recovered Session without cancelled runtime residue in the model context', async () => {
    const completedCallId = 'recovered-call' as ToolCallId;
    const cancelledCallId = 'cancelled-call' as ToolCallId;
    const controller = new AbortController();
    const deltas: string[] = [];
    let cancelledToolStartedResolve!: () => void;
    const cancelledToolStarted = new Promise<void>((resolve) => {
      cancelledToolStartedResolve = resolve;
    });

    const requests: ModelRequest[] = [];
    const model: Model = {
      complete: async (request) => {
        requests.push(request);
        switch (requests.length) {
          case 1:
            return {
              text: '先裁剪。',
              toolCalls: [{ id: completedCallId, name: 'clip', input: { start: 0 } }],
            };
          case 2:
            return { text: '裁剪完成。', toolCalls: [] };
          case 3:
            // 取消发生在 Tool 执行期间，此前已经产生过流式文本增量。
            request.onTextDelta?.('正在');
            request.onTextDelta?.('裁剪');
            return {
              text: '正在裁剪。',
              toolCalls: [{ id: cancelledCallId, name: 'pending', input: {} }],
            };
          default:
            return { text: '继续完成。', toolCalls: [] };
        }
      },
    };
    const tools = new TestToolRegistry();
    tools.register({
      name: 'clip',
      description: 'Clips a video.',
      inputSchema: {},
      execute: async () => ({ status: 'success', output: 'clip.mp4' }),
    });
    tools.register({
      name: 'pending',
      description: 'Waits until cancelled.',
      inputSchema: {},
      execute: async (_input, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
        cancelledToolStartedResolve();
      }),
    });

    const session = new InMemorySession();
    const agent = createTestAgent(model, session, tools);
    await runTurn(agent, '把视频裁掉前 3 秒', undefined, undefined, (delta) => deltas.push(delta));

    const cancelledTurn = runTurn(agent, '再裁一次', undefined, controller.signal, (delta) => deltas.push(delta));
    await cancelledToolStarted;
    controller.abort();
    await expect(cancelledTurn).rejects.toMatchObject({ name: 'AbortError' });
    expect(deltas).toEqual(['正在', '裁剪']);

    // 真实外部边界：Session 历史经 JSON 序列化落盘后再读回。
    const persisted = JSON.parse(JSON.stringify(session.events())) as SessionEvent[];
    const recoveredEvents = recoverSessionEvents(persisted);

    expect(recoveredEvents.map((event) => event.type)).toEqual([
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
      'turn.started',
      'user.message',
    ]);
    // 流式增量、未完成 Step 与 dangling Tool Call 都不是可恢复事实。
    expect(JSON.stringify(recoveredEvents)).not.toContain('正在裁剪');
    expect(recoveredEvents.some((event) => (
      event.type === 'tool.called' && event.toolCallId === cancelledCallId
    ))).toBe(false);

    const continuationModel = new ScriptedModel([{ text: '继续完成。', toolCalls: [] }]);
    const recoveredSession = new InMemorySession(recoveredEvents);
    const result = await runTurn(createTestAgent(continuationModel, recoveredSession, tools), '继续');

    expect(result.response.text).toBe('继续完成。');
    // 恢复后仍能继续执行：旧完成事实保留，新事实只追加。
    expect(recoveredSession.events().slice(0, recoveredEvents.length)).toEqual(recoveredEvents);
    expect(recoveredSession.events().length).toBeGreaterThan(recoveredEvents.length);
    // 未完成 Step 的残留不会进入新的 Model Context。
    expect(continuationModel.requests[0]?.messages).toEqual([
      { role: 'user', content: '把视频裁掉前 3 秒' },
      { role: 'assistant', content: '先裁剪。', toolCalls: [{ id: completedCallId, name: 'clip', input: { start: 0 } }] },
      { role: 'tool', toolCallId: completedCallId, content: 'clip.mp4' },
      { role: 'assistant', content: '裁剪完成。', toolCalls: [] },
      { role: 'user', content: '再裁一次' },
      { role: 'user', content: '继续' },
    ]);
  });
});
