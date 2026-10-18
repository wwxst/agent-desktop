import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@agent-desktop/agent';
import { ModelRequestError, type Model } from '@agent-desktop/model';
import { InMemorySession } from '@agent-desktop/session';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import { runTurn, StepBudgetError, ToolBudgetError } from '../src/index.js';

function agent(model: Model): Agent {
  return { model, session: new InMemorySession(), tools: new InMemoryToolRegistry(), systemPrompt: { build: () => 'test' } };
}

describe('current model request and commentary contracts', () => {
  it('retries the failed request once without replaying an already completed tool', async () => {
    let calls = 0;
    const complete = vi.fn<Model['complete']>(async () => {
      calls += 1;
      if (calls === 1) return { text: '先检查文件', toolCalls: [{ id: 'read' as never, name: 'read', input: {} }] };
      if (calls === 2) throw new ModelRequestError('503', 'transient-service', 503, 0);
      return { text: '检查完成', toolCalls: [] };
    });
    const current = agent({ complete });
    const execute = vi.fn(async () => ({ status: 'success' as const, output: 'file' }));
    current.tools.register({ name: 'read', description: 'read', inputSchema: {}, contract: { approvalRequirement: 'none' }, execute });
    const text = vi.fn();
    const trace = vi.fn();
    const result = await runTurn(current, 'test', { trace, onModelText: text });
    expect(result.stepCount).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(current.session.events().filter((event) => event.type === 'assistant.message')).toHaveLength(2);
    expect(text.mock.calls.map((args) => args.slice(1))).toEqual([['先检查文件', 'commentary'], ['检查完成', 'final']]);
    expect(trace.mock.calls.filter(([event]) => event.type === 'model.retrying')).toHaveLength(1);
  });
  it('caps the turn budget at two additional requests', async () => {
    let request = 0;
    const current = agent({ complete: async () => {
      request += 1;
      if (request % 2 === 1) throw new ModelRequestError('429', 'transient-service', 429, 0);
      return { toolCalls: [{ id: String(request) as never, name: 'unknown', input: {} }] };
    } });
    await expect(runTurn(current, 'test')).rejects.toThrow('429');
    expect(request).toBe(5);
  });
  it('does not retry authentication or a second failing attempt', async () => {
    for (const kind of ['authentication', 'transient-service'] as const) {
      const complete = vi.fn<Model['complete']>().mockRejectedValue(new ModelRequestError('failure', kind, 401, 0));
      await expect(runTurn(agent({ complete }), 'test')).rejects.toThrow('failure');
      expect(complete).toHaveBeenCalledTimes(kind === 'authentication' ? 1 : 2);
    }
  });
  it('cancels retry waiting without sending another request', async () => {
    const controller = new AbortController();
    const complete = vi.fn<Model['complete']>().mockRejectedValue(new ModelRequestError('503', 'transient-service', 503, 1000));
    await expect(runTurn(agent({ complete }), 'test', { signal: controller.signal,
      trace: (event) => { if (event.type === 'model.retrying') controller.abort(); },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('enforces the explicit child step budget before a new request', async () => {
    const complete = vi.fn<Model['complete']>(async () => ({ toolCalls: [{ id: 'x' as never, name: 'unknown', input: {} }] }));
    await expect(runTurn(agent({ complete }), 'test', { maxSteps: 1 })).rejects.toBeInstanceOf(StepBudgetError);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('stops an ordinary Turn at the default 64 model steps with an explicit reason', async () => {
    const complete = vi.fn<Model['complete']>(async () => ({ toolCalls: [{ id: 'x' as never, name: 'unknown', input: {} }] }));
    const current = agent({ complete });
    await expect(runTurn(current, '持续工作')).rejects.toMatchObject({ name: 'StepBudgetError', message: '任务已达到模型步骤上限，尚未完成。' });
    expect(complete).toHaveBeenCalledTimes(64);
    expect(current.session.events().at(-1)).toMatchObject({ type: 'turn.failed', errorName: 'StepBudgetError' });
    expect(current.session.events().filter(event => event.type === 'step.completed')).toHaveLength(64);
  });
  it('counts unknown tool attempts toward the default 128 calls without replaying successes', async () => {
    const complete = vi.fn<Model['complete']>(async () => ({ toolCalls: Array.from({ length: 129 }, (_, index) => ({
      id: String(index) as never, name: 'unknown', input: {},
    })) }));
    const current = agent({ complete });
    await expect(runTurn(current, '多个工具')).rejects.toBeInstanceOf(ToolBudgetError);
    expect(complete).toHaveBeenCalledOnce();
    expect(current.session.events().filter(event => event.type === 'tool.called')).toHaveLength(128);
    expect(current.session.events().filter(event => event.type === 'tool.result')).toHaveLength(128);
    expect(current.session.events().at(-1)).toMatchObject({ type: 'turn.failed', errorName: 'ToolBudgetError' });
  });
});
