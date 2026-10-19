import { describe, expect, it, vi } from 'vitest';
import type { ModelRequest, ModelUsage, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, SessionPersistenceError, type SessionEvent, type SessionEventInput, type StepId, type TurnId } from '@agent-desktop/session';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import { ContextBudgetError, runTurn } from '../src/index.js';

function oldHistory(): SessionEvent[] {
  const turnId = 'old' as TurnId;
  const events: SessionEventInput[] = [{ type: 'turn.started', turnId, payload: {} }, { type: 'user.message', turnId, payload: { content: '原始约束：只读，不覆盖文件。' } }];
  for (let index = 0; index < 5; index += 1) {
    const stepId = String(index) as StepId;
    const toolCallId = String(index) as ToolCallId;
    events.push({ type: 'step.started', turnId, payload: { stepId } },
      { type: 'assistant.message', turnId, payload: { stepId, toolCalls: [{ id: toolCallId, name: 'read', input: { index } }] } },
      { type: 'tool.called', turnId, payload: { stepId, toolCallId, name: 'read', input: { index }, boundary: 'read-only' } },
      { type: 'tool.result', turnId, payload: { stepId, toolCallId, result: { status: 'success', output: 'x'.repeat(1000) } } },
      { type: 'step.completed', turnId, payload: { stepId } });
  }
  events.push({ type: 'turn.completed', turnId, payload: {} });
  return [...new InMemorySession().appendMany(events)];
}

describe('context consumed by the real execution loop', () => {
  it('bounds summary and formal requests after real dynamic instructions and schemas are assembled', async () => {
    const session = new InMemorySession(oldHistory());
    const original = [...session.events()];
    const requests: ModelRequest[] = [];
    const tools = new InMemoryToolRegistry();
    tools.register({ name: 'read', description: 'actual dynamic read', inputSchema: { type: 'object' },
      contract: { approvalRequirement: 'none' },
      execute: async () => ({ status: 'success', output: 'read' }) });
    const model = { complete: vi.fn(async (request: ModelRequest) => {
      requests.push(request);
      if (request.tools.length > 0) return { text: 'final response', toolCalls: [], usage: { inputTokens: 1024, outputTokens: 32 } };
      const source = JSON.parse(request.messages[0]!.content!) as {
        previousSummaryText: string | null; newStepSources: { sourceEventIndex: number }[];
      };
      const prior = source.previousSummaryText === null ? [] : (JSON.parse(source.previousSummaryText) as { sourceEventIndexes: number[] }).sourceEventIndexes;
      return { text: JSON.stringify({ summary: '历史只读检查事实。', sourceEventIndexes: [...prior, ...source.newStepSources.map(item => item.sourceEventIndex)] }), toolCalls: [], usage: { inputTokens: 900, outputTokens: 80 } };
    }) };
    const usage: (ModelUsage | undefined)[] = [];
    await runTurn({ model, session, tools, systemPrompt: { build: () => '实际动态插件与用户指令。' } }, '继续',
      { contextBudget: { contextWindow: 7000, maxOutputTokens: 800 }, onModelUsage: value => usage.push(value) });
    expect(usage).toEqual([{ inputTokens: 1024, outputTokens: 32 }]);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.length).toBeLessThanOrEqual(3);
    expect(requests.every(request => request.maxOutputTokens === 800)).toBe(true);
    expect(requests.at(-1)?.systemPrompt).toBe('实际动态插件与用户指令。');
    expect(requests.at(-1)?.messages).toContainEqual({ role: 'user', content: '原始约束：只读，不覆盖文件。' });
    expect(session.events().slice(0, original.length)).toEqual(original);
    expect(session.events().at(-1)?.type).toBe('turn.completed');
  });

  it('does not send a formal request if mandatory input exceeds the configured budget', async () => {
    const complete = vi.fn(); const session = new InMemorySession();
    await expect(runTurn({ model: { complete }, session, tools: new InMemoryToolRegistry(), systemPrompt: { build: () => 'rules' } },
      '不可丢失的用户约束'.repeat(1000), { contextBudget: { contextWindow: 5000, maxOutputTokens: 800 } })).rejects.toBeInstanceOf(ContextBudgetError);
    expect(complete).not.toHaveBeenCalled();
    expect(session.events().at(-1)?.type).toBe('turn.failed');
  });

  it('stops before the formal request when summary persistence fails', async () => {
    const failure = new SessionPersistenceError(new Error('database full'));
    class FailingSession extends InMemorySession {
      override append<Event extends SessionEventInput>(event: Event): Extract<SessionEvent, { type: Event['type'] }> { if (event.type === 'context.compacted') throw failure; return super.append(event); }
    }
    const session = new FailingSession(oldHistory());
    const complete = vi.fn(async (request: ModelRequest) => {
      const source = JSON.parse(request.messages[0]!.content!) as { newStepSources: { sourceEventIndex: number }[] };
      return { text: JSON.stringify({ summary: '只读事实。', sourceEventIndexes: source.newStepSources.map(item => item.sourceEventIndex) }), toolCalls: [] };
    });
    await expect(runTurn({ model: { complete }, session, tools: new InMemoryToolRegistry(), systemPrompt: { build: () => 'rules' } },
      'continue', { contextBudget: { contextWindow: 7000, maxOutputTokens: 800 } })).rejects.toBe(failure);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(session.events().at(-1)?.type).toBe('step.started');
  });
});
