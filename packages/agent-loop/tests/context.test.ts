import { describe, expect, it, vi } from 'vitest';
import { ModelRequestError, type Model, type ModelMessage, type ModelRequest, type ModelResponse, type ModelToolDefinition, type ToolCallId } from '@agent-desktop/model';
import { InMemorySession, SessionPersistenceError, TurnCancellationError, type QualifyToolEvidence, type SessionEvent, type SessionEventInput, type StepId, type TurnId } from '@agent-desktop/session';
import { ContextBudgetError, createContextSourceDigest, estimateContextTokens, prepareModelContext, validateContextCompactedEvent, type ContextBudget } from '../src/context.js';

function createSession(inputs: readonly SessionEventInput[] = []): InMemorySession {
  const session = new InMemorySession();
  session.appendMany(inputs);
  return session;
}

const root = 'original' as TurnId;
const current = 'current' as TurnId;
const systemPrompt = '保持用户约束，只依据实际工具事实继续任务。';
const artifact = (path: string) => ({ id: `test-${path}`, path, mimeType: 'text/plain', size: 1, sha256: 'a'.repeat(64), createdAt: '2026-10-18T00:00:00.000Z', sourceTool: 'write' });
const tools: readonly ModelToolDefinition[] = [{ name: 'read', description: 'read real data', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];

function history(count = 5, outputSize = 1400): { session: InMemorySession; ends: number[] } {
  const events: SessionEventInput[] = [{ type: 'turn.started', turnId: root, payload: {} }, { type: 'user.message', turnId: root, payload: { content: '保留约束：只读 data，报告证据，不覆盖任何文件。' } }];
  const ends: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const stepId = `step-${index}` as StepId;
    const toolCallId = `call-${index}` as ToolCallId;
    events.push(
      { type: 'step.started', turnId: root, payload: { stepId } },
      { type: 'assistant.message', turnId: root, payload: { stepId, content: 'checking', toolCalls: [{ id: toolCallId, name: 'read', input: { path: `data/${index}` } }] } },
      { type: 'tool.called', turnId: root, payload: { stepId, toolCallId, name: 'read', input: { path: `data/${index}` }, boundary: 'read-only' } },
      { type: 'tool.result', turnId: root, payload: { stepId, toolCallId, result: { status: 'success', output: `fact-${index}:${'x'.repeat(outputSize)}` } } },
      { type: 'step.completed', turnId: root, payload: { stepId } },
    );
    ends.push(events.length - 1);
  }
  events.push({ type: 'turn.completed', turnId: root, payload: {} }, { type: 'turn.started', turnId: current, payload: {} }, { type: 'user.message', turnId: current, payload: { content: '继续检查，保持此前约束。' } });
  return { session: createSession(events), ends };
}

function summarize(request: ModelRequest): ModelResponse {
  const first = request.messages[0];
  if (first?.role !== 'user') throw new Error('summary source request missing');
  const source = JSON.parse(first.content) as { previousSummaryText: string | null; newStepSources: { sourceEventIndex: number }[] };
  const previous = source.previousSummaryText === null ? [] : (JSON.parse(source.previousSummaryText) as { sourceEventIndexes: number[] }).sourceEventIndexes;
  return { text: JSON.stringify({ summary: '保留旧工具检查结果及其来源。', sourceEventIndexes: [...previous, ...source.newStepSources.map(item => item.sourceEventIndex)] }), toolCalls: [] };
}
function context(session: InMemorySession, model: Model, budget?: ContextBudget, signal?: AbortSignal) {
  return prepareModelContext({ model, session, turnId: current, systemPrompt, tools, ...(budget === undefined ? {} : { budget }), ...(signal === undefined ? {} : { signal }) });
}
function assertToolPairs(messages: readonly ModelMessage[]): void {
  const pending = new Set<ToolCallId>();
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls) pending.add(call.id);
    if (message.role === 'tool') { expect(pending.has(message.toolCallId)).toBe(true); pending.delete(message.toolCallId); }
  }
  expect(pending.size).toBe(0);
}
async function budgetAboveRaw(session: InMemorySession): Promise<ContextBudget> {
  const raw = await context(session, { complete: async () => { throw new Error('unexpected summary'); } });
  const required = estimateContextTokens({ systemPrompt, messages: raw, tools });
  return { contextWindow: Math.ceil((required + 800) / 0.95) + 64, maxOutputTokens: 800 };
}

describe('model context projection', () => {
  it('keeps ordinary conversations unchanged without a budget or execution facts', async () => {
    const stepId = 'answer' as StepId;
    const session = createSession([
      { type: 'turn.started', turnId: root, payload: {} }, { type: 'user.message', turnId: root, payload: { content: 'Remember 731.' } },
      { type: 'assistant.message', turnId: root, payload: { stepId, content: '731 saved in this conversation.', toolCalls: [] } },
      { type: 'step.completed', turnId: root, payload: { stepId } }, { type: 'turn.completed', turnId: root, payload: {} },
      { type: 'turn.started', turnId: current, payload: {} }, { type: 'user.message', turnId: current, payload: { content: 'What number?' } },
    ]);
    const complete = vi.fn<Model['complete']>();
    expect(await context(session, { complete })).toEqual([
      { role: 'user', content: 'Remember 731.' }, { role: 'assistant', content: '731 saved in this conversation.', toolCalls: [] }, { role: 'user', content: 'What number?' },
    ]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('preserves incomplete successful writes, current plan intent and unknown effects as plaintext', async () => {
    const stepId = 'incomplete' as StepId;
    const written = 'written' as ToolCallId;
    const missing = 'missing' as ToolCallId;
    const events = [...createSession([
      { type: 'turn.started', turnId: root, payload: {} }, { type: 'user.message', turnId: root, payload: { content: 'Do not replace my original file.' } },
      { type: 'step.started', turnId: root, payload: { stepId } },
      { type: 'assistant.message', turnId: root, payload: { stepId, toolCalls: [{ id: written, name: 'write', input: {} }, { id: missing, name: 'external', input: {} }] } },
      { type: 'tool.called', turnId: root, payload: { stepId, toolCallId: written, name: 'write', input: { path: 'actual.txt' }, boundary: 'checkpointed' } },
      { type: 'tool.result', turnId: root, payload: { stepId, toolCallId: written, result: { status: 'success', output: 'critical-written-fact', artifacts: [artifact('actual.txt')] } } },
      { type: 'tool.called', turnId: root, payload: { stepId, toolCallId: missing, name: 'external', input: { target: 'remote' }, boundary: 'checkpointed' } },
      { type: 'tool.effect.prepared', turnId: root, payload: { sourceEventIndex: 6, data: { intent: 'real prepared effect' } } },
      { type: 'plan.updated', turnId: root, payload: { revision: 1, explanation: 'model intent only', steps: [{ id: 'a', description: 'finish remaining work', requestedStatus: 'completed', completionKind: 'tool', evidenceEventIndexes: [5] }] } },
      { type: 'turn.cancelled', turnId: root, payload: { reason: 'user' } }, { type: 'turn.started', turnId: current, payload: {} },
      { type: 'user.message', turnId: current, payload: { content: 'Please verify before continuing.' } },
      { type: 'turn.recovery.started', turnId: current, payload: { sourceTurnId: root, mode: 'verify' } },
    ]).events()];
    const session = new InMemorySession(events);
    const messages = await context(session, { complete: vi.fn<Model['complete']>() });
    const text = messages.map(message => message.content ?? '').join('\n');
    expect(text).toContain('critical-written-fact'); expect(text).toContain('real prepared effect'); expect(text).toContain('actual.txt');
    expect(text).toContain('requestedStatus 不是执行完成证据'); expect(text).toContain('Do not replace my original file.');
    expect(messages.filter(message => message.role === 'tool')).toEqual([]);
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'Please verify before continuing.' });
    expect(session.events()).toEqual(events);
  });

  it('preserves the latest Session plan even when a normal new Turn is not its recovery child', async () => {
    const { session } = history(0);
    session.append({ type: 'plan.updated', turnId: root, payload: { revision: 1, explanation: 'existing plan intent', steps: [{ id: 'work', description: 'remaining original work', requestedStatus: 'pending', completionKind: 'tool', evidenceEventIndexes: [] }] } });
    const text = (await context(session, { complete: vi.fn<Model['complete']>() })).map(message => message.content ?? '').join('\n');
    expect(text).toContain('remaining original work'); expect(text).toContain('"rootTurnId":"original"');
    expect(text).toContain('requestedStatus 不是执行完成证据');
  });

  it('counts system text, UTF-8 user text and actual tool schemas in the mandatory input budget', async () => {
    for (const extra of ['user', 'system', 'schema'] as const) {
      const session = createSession([{ type: 'turn.started', turnId: current, payload: {} }, { type: 'user.message', turnId: current, payload: { content: extra === 'user' ? '约束'.repeat(2500) : 'short task' } }]);
      const complete = vi.fn<Model['complete']>();
      await expect(prepareModelContext({ model: { complete }, session, turnId: current,
        systemPrompt: extra === 'system' ? 's'.repeat(9000) : systemPrompt,
        tools: extra === 'schema' ? [{ name: 'dynamic', description: 'd', inputSchema: { description: 'x'.repeat(9000) } }] : tools,
        budget: { contextWindow: 6000, maxOutputTokens: 800 } })).rejects.toBeInstanceOf(ContextBudgetError);
      expect(complete).not.toHaveBeenCalled(); expect(session.events()).toHaveLength(2);
    }
  });

  it('compresses whole Step chunks at most twice, retaining user constraints and complete recent tool pairs', async () => {
    const { session, ends } = history();
    const raw = [...session.events()];
    const complete = vi.fn<Model['complete']>(async request => summarize(request));
    const budget = { contextWindow: 7000, maxOutputTokens: 800 };
    const messages = await context(session, { complete }, budget);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(messages.filter(message => message.role === 'tool')).toHaveLength(2);
    const limit = budget.contextWindow - budget.maxOutputTokens - Math.ceil(budget.contextWindow * 0.05);
    expect(estimateContextTokens({ systemPrompt, messages, tools })).toBeLessThanOrEqual(limit);
    for (const [request] of complete.mock.calls) {
      expect(request.tools).toEqual([]); expect(request.maxOutputTokens).toBe(800); expect(request.onTextDelta).toBeUndefined();
      expect(estimateContextTokens(request)).toBeLessThanOrEqual(limit);
    }
    expect(messages.some(message => message.role === 'user' && message.content === '保留约束：只读 data，报告证据，不覆盖任何文件。')).toBe(true);
    expect(messages.at(-1)).toEqual({ role: 'user', content: '继续检查，保持此前约束。' });
    assertToolPairs(messages);
    const summaries = session.events().flatMap((event, index) => event.type === 'context.compacted' ? [{ event, index }] : []);
    expect(summaries).toHaveLength(2); expect(summaries[1]?.event.payload.previousSummaryEventIndex).toBe(summaries[0]?.index);
    expect(validateContextCompactedEvent(session.events(), summaries[1]!.index).cumulativeCoveredStepEndEventIndexes).toEqual(ends.slice(0, 3));
    expect(session.events().slice(0, raw.length)).toEqual(raw);
  });

  it('does not split an oversized single Step or silently truncate a tool result', async () => {
    const { session } = history(1, 15000);
    const raw = [...session.events()]; const complete = vi.fn<Model['complete']>();
    await expect(context(session, { complete }, { contextWindow: 6000, maxOutputTokens: 800 })).rejects.toThrow('不能拆分工具调用和结果');
    expect(complete).not.toHaveBeenCalled(); expect(session.events()).toEqual(raw);
  });

  it('reduces an oversized two-Step recent tail to one instead of spending both summary requests only on older work', async () => {
    const { session } = history(3, 200);
    const events = [...session.events()];
    for (const index of [10, 15]) {
      const event = events[index]; if (event?.type !== 'tool.result') throw new Error('fixture tool result missing');
      events[index] = { ...event, payload: { ...event.payload, result: { status: 'success', output: 'large-recent-data'.repeat(240) } } };
    }
    const currentSession = new InMemorySession(events); const complete = vi.fn<Model['complete']>(async request => summarize(request));
    const messages = await context(currentSession, { complete }, { contextWindow: 7000, maxOutputTokens: 800 });
    expect(complete.mock.calls.length).toBeLessThanOrEqual(2); expect(messages.filter(message => message.role === 'tool')).toHaveLength(1);
    assertToolPairs(messages);
  });

  it('can compress both recent Steps when the raw tail leaves no room for mandatory user text', async () => {
    const { session } = history(2, 2900);
    const events = [...session.events()]; const user = events[1]; if (user?.type !== 'user.message') throw new Error('fixture user missing');
    const content = 'mandatory user constraint '.repeat(125);
    events[1] = { ...user, payload: { ...user.payload, content } };
    const currentSession = new InMemorySession(events); const complete = vi.fn<Model['complete']>(async request => summarize(request));
    const messages = await context(currentSession, { complete }, { contextWindow: 6500, maxOutputTokens: 800 });
    expect(complete).toHaveBeenCalledTimes(2); expect(messages.filter(message => message.role === 'tool')).toHaveLength(0);
    expect(messages.some(message => message.role === 'user' && message.content === content)).toBe(true);
  });

  it('uses an input digest for completed external-call identity instead of duplicating a large successful write payload', async () => {
    const stepId = 'done-write' as StepId; const id = 'written' as ToolCallId;
    const events = [...createSession([
      { type: 'turn.started', turnId: current, payload: {} }, { type: 'user.message', turnId: current, payload: { content: 'continue' } },
      { type: 'assistant.message', turnId: current, payload: { stepId, toolCalls: [{ id, name: 'write', input: { text: 'body'.repeat(900) } }] } },
      { type: 'tool.called', turnId: current, payload: { stepId, toolCallId: id, name: 'write', input: { text: 'body'.repeat(900) }, boundary: 'checkpointed' } },
      { type: 'tool.result', turnId: current, payload: { stepId, toolCallId: id, result: { status: 'success', output: 'actual write complete', artifacts: [artifact('file.txt')] } } },
      { type: 'step.completed', turnId: current, payload: { stepId } },
    ]).events()];
    const messages = await context(new InMemorySession(events), { complete: vi.fn<Model['complete']>() }, { contextWindow: 10000, maxOutputTokens: 800 });
    const factText = messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
    expect(factText).toContain('inputSourceDigest'); expect(factText).toContain('file.txt'); expect(factText).not.toContain('bodybody');
    assertToolPairs(messages);
  });

  it('falls back only for an explicit summary Model failure when the old projection fits the hard budget', async () => {
    const { session } = history(5, 300); const raw = [...session.events()];
    const budget = await budgetAboveRaw(session);
    const complete = vi.fn<Model['complete']>().mockRejectedValue(new ModelRequestError('503 fixture', 'transient-service', 503, 0));
    const projected = await context(session, { complete }, budget);
    expect(complete).toHaveBeenCalledTimes(1); expect(session.events()).toEqual(raw); assertToolPairs(projected);
  });

  it('rejects invalid or out-of-budget summary output without saving an invalid summary', async () => {
    const responses: ModelResponse[] = [
      { text: 'not JSON', toolCalls: [] }, { text: '', toolCalls: [] },
      { text: JSON.stringify({ summary: 'false future source', sourceEventIndexes: [99999] }), toolCalls: [] },
      { text: JSON.stringify({ summary: 'user is never a covered source', sourceEventIndexes: [1] }), toolCalls: [] },
      { text: JSON.stringify({ summary: 'x'.repeat(1000), sourceEventIndexes: [3] }), toolCalls: [] },
      { text: 'irrelevant', toolCalls: [{ id: 'evil' as ToolCallId, name: 'write', input: {} }] },
    ];
    for (const response of responses) {
      const { session } = history(5, 300); const raw = [...session.events()]; const budget = await budgetAboveRaw(session);
      const complete = vi.fn<Model['complete']>().mockResolvedValue(response);
      const messages = await context(session, { complete }, budget);
      expect(session.events()).toEqual(raw); expect(complete).toHaveBeenCalledTimes(1); assertToolPairs(messages);
    }
  });

  it('does not turn cancelled or program failures into a successful fallback', async () => {
    const errors = [new TurnCancellationError('user'), new ModelRequestError('cancelled', 'cancelled'), new Error('program failure')];
    for (const error of errors) {
      const { session } = history(5, 300); const raw = [...session.events()]; const budget = await budgetAboveRaw(session);
      await expect(context(session, { complete: async () => { throw error; } }, budget)).rejects.toBe(error);
      expect(session.events()).toEqual(raw);
    }
  });

  it('retains the original failure when compression is required for the hard budget', async () => {
    const { session } = history(); const raw = [...session.events()];
    const error = new ModelRequestError('real upstream failure', 'transient-service');
    const complete = vi.fn<Model['complete']>().mockRejectedValue(error);
    await expect(context(session, { complete }, { contextWindow: 7000, maxOutputTokens: 800 })).rejects.toMatchObject({ name: 'ContextBudgetError', cause: error });
    expect(complete).toHaveBeenCalledTimes(1); expect(session.events()).toEqual(raw);
  });

  it('propagates a failed summary checkpoint and preserves raw history', async () => {
    const error = new SessionPersistenceError(new Error('disk full'));
    class FailingSession extends InMemorySession {
      override append<Event extends SessionEventInput>(event: Event): Extract<SessionEvent, { type: Event['type'] }> { if (event.type === 'context.compacted') throw error; return super.append(event); }
    }
    const original = history().session.events(); const session = new FailingSession(original);
    await expect(context(session, { complete: async request => summarize(request) }, { contextWindow: 7000, maxOutputTokens: 800 })).rejects.toBe(error);
    expect(session.events()).toEqual(original);
  });

  it('cancels during a summary before recording it and gives persistence abort causes priority', async () => {
    for (const reason of [new TurnCancellationError('user'), new SessionPersistenceError(new Error('onExit checkpoint failed'))]) {
      const { session } = history(); const raw = [...session.events()]; const controller = new AbortController();
      const complete = vi.fn<Model['complete']>(async request => { controller.abort(reason); return summarize(request); });
      await expect(context(session, { complete }, { contextWindow: 7000, maxOutputTokens: 800 }, controller.signal)).rejects.toBe(reason);
      expect(session.events()).toEqual(raw); expect(complete).toHaveBeenCalledTimes(1);
    }
  });

  it('preserves a valid first rolling summary if a later block fails, while raw history stays intact', async () => {
    const { session } = history(); const raw = [...session.events()]; let calls = 0;
    const complete = vi.fn<Model['complete']>(async request => { calls += 1; if (calls === 2) throw new ModelRequestError('second block failed', 'transient-service'); return summarize(request); });
    await expect(context(session, { complete }, { contextWindow: 7000, maxOutputTokens: 800 })).rejects.toBeInstanceOf(ContextBudgetError);
    expect(complete).toHaveBeenCalledTimes(2); expect(session.events().slice(0, raw.length)).toEqual(raw);
    expect(session.events().filter(event => event.type === 'context.compacted')).toHaveLength(1);
    expect(validateContextCompactedEvent(session.events(), raw.length).cumulativeCoveredStepEndEventIndexes.length).toBeGreaterThan(0);
  });

  it('stops after two successful summary requests if more compression would still be required', async () => {
    const { session } = history(9); const raw = [...session.events()];
    const complete = vi.fn<Model['complete']>(async request => summarize(request));
    await expect(context(session, { complete }, { contextWindow: 7000, maxOutputTokens: 800 })).rejects.toThrow('两次摘要请求后');
    expect(complete).toHaveBeenCalledTimes(2); expect(session.events().slice(0, raw.length)).toEqual(raw);
    expect(session.events().filter(event => event.type === 'context.compacted')).toHaveLength(2);
  });

  it('reconstructs summary coverage and digest after serialization without another summary request', async () => {
    const { session } = history(); const budget = { contextWindow: 7000, maxOutputTokens: 800 };
    const before = await context(session, { complete: async request => summarize(request) }, budget);
    const restored = new InMemorySession(JSON.parse(JSON.stringify(session.events())) as SessionEvent[]);
    const complete = vi.fn<Model['complete']>();
    expect(await context(restored, { complete }, budget)).toEqual(before); expect(complete).not.toHaveBeenCalled();
    const index = restored.events().findLastIndex(event => event.type === 'context.compacted');
    expect(validateContextCompactedEvent(restored.events(), index).event.payload.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('summary provenance', () => {
  function withSummary(): { events: SessionEvent[]; summaryIndex: number; ends: number[] } {
    const { session, ends } = history(3, 100);
    const events = [...session.events()]; const summaryIndex = events.length;
    const event = session.append({ type: 'context.compacted', turnId: current, payload: { coveredStepEndEventIndexes: [ends[0]!], sourceDigest: createContextSourceDigest(events, [ends[0]!]), summary: JSON.stringify({ summary: 'actual old fact', sourceEventIndexes: [3, 5] }), estimatorVersion: 1, estimatedBefore: 1000, estimatedAfter: 500 } });
    events.push(event); return { events, summaryIndex, ends };
  }

  it('hashes canonical objects, preserving array order and all original source fields', () => {
    const { session, ends } = history(1, 10); const first = [...session.events()];
    const result = first[5]; if (result?.type !== 'tool.result') throw new Error('fixture result missing');
    first[5] = { ...result, payload: { ...result.payload, result: { status: 'success', output: { z: [1, 2], a: 'fact' } } } };
    const second = [...first]; second[5] = { ...result, payload: { ...result.payload, result: { status: 'success', output: { a: 'fact', z: [1, 2] } } } };
    expect(createContextSourceDigest(first, ends)).toBe(createContextSourceDigest(second, ends));
    second[5] = { ...result, payload: { ...result.payload, result: { status: 'success', output: { a: 'fact', z: [2, 1] } } } };
    expect(createContextSourceDigest(first, ends)).not.toBe(createContextSourceDigest(second, ends));
  });

  it('rejects changed original data, future coverage and duplicate cumulative coverage', () => {
    const { events, summaryIndex, ends } = withSummary();
    expect(validateContextCompactedEvent(events, summaryIndex).cumulativeCoveredStepEndEventIndexes).toEqual([ends[0]]);
    const tampered = [...events]; const result = tampered[5]; if (result?.type !== 'tool.result') throw new Error('fixture result missing');
    tampered[5] = { ...result, payload: { ...result.payload, result: { status: 'success', output: 'tampered raw result' } } };
    expect(() => validateContextCompactedEvent(tampered, summaryIndex)).toThrow('原始事实不一致');
    const event = events[summaryIndex]; if (event?.type !== 'context.compacted') throw new Error('fixture summary missing');
    expect(() => validateContextCompactedEvent([...events, { ...event, payload: { ...event.payload, previousSummaryEventIndex: summaryIndex } }], summaryIndex + 1)).toThrow('重复覆盖');
    expect(() => validateContextCompactedEvent([...events.slice(0, summaryIndex), { ...event, payload: { ...event.payload, coveredStepEndEventIndexes: [summaryIndex + 1] } }], summaryIndex)).toThrow('未来');
    expect(() => validateContextCompactedEvent([...events.slice(0, summaryIndex), { ...event, payload: { ...event.payload, previousSummaryEventIndex: summaryIndex } }], summaryIndex)).toThrow('自己或未来');
  });
});

describe('plan evidence available to the model', () => {
  const plan: SessionEventInput = { type: 'plan.updated', turnId: current, payload: { revision: 1, explanation: '检查资料并给出回复', steps: [{ id: 'check', description: '检查资料', requestedStatus: 'in_progress', completionKind: 'tool', evidenceEventIndexes: [] }] } };
  const qualify: QualifyToolEvidence = source => ({ eligible: source.type === 'effect.outcome.verified'
    ? source.payload.scope === 'entire-call' && source.payload.outcome === 'completed'
    : source.payload.result.status === 'success' && source.payload.result.output === 'qualified-read',
    label: source.type === 'effect.outcome.verified' ? '仅核验当前操作效果' : source.payload.result.status === 'error' ? '真实工具失败' : source.payload.result.output === 'qualified-read' ? '资料已读取' : '仅确认工具返回' });
  function directory(messages: readonly ModelMessage[]): Record<string, unknown>[] | undefined {
    const message = messages.find(message => message.role === 'user' && message.content.startsWith('计划证据目录'));
    return message?.role === 'user' ? JSON.parse(message.content.slice(message.content.indexOf('\n') + 1)) as Record<string, unknown>[] : undefined;
  }
  function prepare(session: InMemorySession, qualifier = qualify, budget?: ContextBudget) {
    return prepareModelContext({ session, model: { complete: async request => summarize(request) }, turnId: current,
      systemPrompt, tools, qualifyToolEvidence: qualifier, ...(budget === undefined ? {} : { budget }) });
  }

  it('exposes stable task-chain result and verification indexes with their real qualification and composite call identity', async () => {
    const stepId = 'same-step' as StepId; const toolCallId = 'same-call' as ToolCallId; const other = 'unrelated' as TurnId;
    const events = [...createSession([
      { type: 'turn.started', turnId: other, payload: {} },
      { type: 'tool.called', turnId: other, payload: { stepId, toolCallId, name: 'unrelated-tool', input: {}, boundary: 'read-only' } },
      { type: 'tool.result', turnId: other, payload: { stepId, toolCallId, result: { status: 'success', output: 'unrelated-fact' } } },
      { type: 'turn.started', turnId: root, payload: {} },
      { type: 'tool.called', turnId: root, payload: { stepId, toolCallId, name: 'read_file', input: {}, boundary: 'read-only' } },
      { type: 'tool.result', turnId: root, payload: { stepId, toolCallId, result: { status: 'success', output: 'qualified-read' } } },
      { type: 'turn.failed', turnId: root, payload: { errorName: 'Error', errorMessage: 'original failure' } },
      { type: 'turn.started', turnId: current, payload: {} }, { type: 'user.message', turnId: current, payload: { content: '继续检查' } },
      { type: 'turn.recovery.started', turnId: current, payload: { sourceTurnId: root, mode: 'continue' } }, plan,
      { type: 'tool.called', turnId: current, payload: { stepId, toolCallId, name: 'external-tool', input: {}, boundary: 'opaque' } },
      { type: 'tool.result', turnId: current, payload: { stepId, toolCallId, result: { status: 'success', output: 'opaque-return' } } },
      { type: 'effect.outcome.verified', turnId: current, payload: { sourceEventIndex: 11, scope: 'entire-call', outcome: 'unresolved', evidence: { source: 'host', reference: 'terminal:1', description: '命令效果未明' } } },
      { type: 'tool.called', turnId: current, payload: { stepId: 'failed' as StepId, toolCallId, name: 'read_file', input: {}, boundary: 'read-only' } },
      { type: 'tool.result', turnId: current, payload: { stepId: 'failed' as StepId, toolCallId, result: { status: 'error', message: 'real read error', failureKind: 'permanent' } } },
      { type: 'effect.outcome.verified', turnId: current, payload: { sourceEventIndex: 4, scope: 'entire-call', outcome: 'completed', evidence: { source: 'user', reference: '原轮次的资料', description: '人工确认原操作结果' } } },
    ]).events()];
    const callback = vi.fn(qualify); const session = new InMemorySession(events);
    const evidence = directory(await prepare(session, callback))!;
    expect(evidence.map(item => item.sourceEventIndex)).toEqual([5, 6, 12, 13, 15, 16]);
    expect(evidence[0]).toMatchObject({ turnId: root, callSourceEventIndex: 4, toolName: 'read_file', resultStatus: 'success', qualification: { eligible: true, label: '资料已读取' } });
    expect(evidence[2]).toMatchObject({ turnId: current, callSourceEventIndex: 11, toolName: 'external-tool', pendingEffectVerification: true, qualification: { eligible: false, label: '仅确认工具返回' } });
    expect(evidence[3]).toMatchObject({ operationSourceEventIndex: 11, outcome: 'unresolved', qualification: { eligible: false }, evidence: { source: 'host' } });
    expect(evidence[4]).toMatchObject({ callSourceEventIndex: 14, resultStatus: 'error', failureKind: 'permanent', qualification: { eligible: false, label: '真实工具失败' } });
    expect(evidence[5]).toMatchObject({ operationSourceEventIndex: 4, sourceTurnId: root, sourceType: 'tool.called', toolName: 'read_file', outcome: 'completed', qualification: { eligible: true }, evidence: { source: 'user' } });
    expect(callback).toHaveBeenCalledTimes(5); expect(session.events()).toEqual(events);
  });

  it('does not add an evidence directory or query qualification without a current task plan', async () => {
    const { session } = history(2, 100); const callback = vi.fn(qualify);
    expect(directory(await prepare(session, callback))).toBeUndefined(); expect(callback).not.toHaveBeenCalled();
    session.append({ ...plan, turnId: root });
    expect(directory(await prepare(session, callback))).toBeUndefined(); expect(callback).not.toHaveBeenCalled();
  });

  it('keeps exact result indexes after compression without copying large output into the directory', async () => {
    const { session } = history(5, 1400);
    session.append({ type: 'turn.recovery.started', turnId: current, payload: { sourceTurnId: root, mode: 'continue' } });
    session.append(plan);
    const messages = await prepare(session, qualify, { contextWindow: 9500, maxOutputTokens: 800 });
    const evidence = directory(messages)!;
    expect(evidence.map(item => item.sourceEventIndex)).toEqual([5, 10, 15, 20, 25]);
    expect(JSON.stringify(evidence)).not.toContain('fact-0:');
    expect(session.events().some(event => event.type === 'context.compacted')).toBe(true);
    assertToolPairs(messages);
    expect(estimateContextTokens({ systemPrompt, messages, tools })).toBeLessThanOrEqual(9500 - 800 - Math.ceil(9500 * 0.05));
  });

  it('counts the evidence directory in mandatory input rather than dropping it to fit a budget', async () => {
    const session = createSession([{ type: 'turn.started', turnId: current, payload: {} }, { type: 'user.message', turnId: current, payload: { content: '检查' } }, plan,
      { type: 'tool.called', turnId: current, payload: { stepId: 's' as StepId, toolCallId: 'c' as ToolCallId, name: 'read', input: {}, boundary: 'read-only' } },
      { type: 'tool.result', turnId: current, payload: { stepId: 's' as StepId, toolCallId: 'c' as ToolCallId, result: { status: 'success', output: 'small' } } },
      { type: 'step.completed', turnId: current, payload: { stepId: 's' as StepId } }]);
    const complete = vi.fn<Model['complete']>(); const original = [...session.events()];
    await expect(prepareModelContext({ session, model: { complete }, turnId: current, systemPrompt, tools,
      qualifyToolEvidence: () => ({ eligible: false, label: 'actual business qualification '.repeat(300) }),
      budget: { contextWindow: 6000, maxOutputTokens: 800 } })).rejects.toThrow('必须保留');
    expect(complete).not.toHaveBeenCalled(); expect(session.events()).toEqual(original);
  });
});
