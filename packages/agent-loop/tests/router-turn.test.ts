import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@agent-desktop/agent';
import type { Model, ModelRequest, ToolCallId } from '@agent-desktop/model';
import { InMemorySession, projectRecoveryFacts } from '@agent-desktop/session';
import { InMemoryToolRegistry, type Tool, type ToolExecutionContext } from '@agent-desktop/tools';
import { runTurn } from '../src/index.js';

const call = (name: string) => ({ id: name as ToolCallId, name, input: {} });
const artifact = (path: string) => ({ id: `test-${path}`, path, mimeType: 'text/plain', size: 1, sha256: 'a'.repeat(64), createdAt: '2026-10-18T00:00:00.000Z', sourceTool: 'write' });
function fixture(names: string[]) {
  const session = new InMemorySession(); const tools = new InMemoryToolRegistry();
  const requests: ModelRequest[] = [];
  const model: Model = { complete: async request => {
    requests.push(request);
    return requests.length === 1 ? { toolCalls: names.map(call) } : { text: '已根据结果完成', toolCalls: [] };
  } };
  const agent: Agent = { session, tools, model, systemPrompt: { build: () => 'test' } };
  return { agent, session, requests };
}
function reading(name: string, execute: Tool['execute']): Tool {
  return { name, description: name, inputSchema: {}, executionBoundary: 'read-only',
    contract: { capability: 'code', parallelSafety: 'safe', riskLevel: 'read' }, execute };
}

describe('routed tool execution in a real Turn', () => {
  it('runs only adjacent safe reads in parallel and commits results in model order around write barriers', async () => {
    const { agent, session } = fixture(['readA', 'readB', 'write', 'readC']);
    const order: string[] = []; let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    agent.tools.register(reading('readA', async (_input, context) => {
      order.push('readA-start'); await first; context.checkpoint?.({ id: 'readA' });
      order.push('readA-end'); return { status: 'success', output: 'A' };
    }));
    agent.tools.register(reading('readB', async (_input, context) => {
      order.push('readB-start'); context.checkpoint?.({ id: 'readB' });
      order.push('readB-end'); return { status: 'success', output: 'B' };
    }));
    agent.tools.register({ name: 'write', description: '', inputSchema: {}, executionBoundary: 'checkpointed',
      contract: { capability: 'code', parallelSafety: 'serial', riskLevel: 'write' }, execute: async () => {
        expect(order).toContain('readA-end'); expect(order).toContain('readB-end');
        order.push('write'); return { status: 'success', output: 'written' };
      } });
    agent.tools.register(reading('readC', async () => {
      expect(order).toContain('write'); order.push('readC'); return { status: 'success', output: 'C' };
    }));
    const task = runTurn(agent, '读取后修改再读取');
    await vi.waitFor(() => expect(order).toEqual(['readA-start', 'readB-start', 'readB-end']));
    expect(session.events().filter(event => event.type === 'tool.result')).toEqual([]);
    releaseFirst(); await task;
    expect(session.events().filter(event => event.type === 'tool.called').map(event => event.toolCallId)).toEqual(['readA', 'readB', 'write', 'readC']);
    expect(session.events().filter(event => event.type === 'tool.result').map(event => event.toolCallId)).toEqual(['readA', 'readB', 'write', 'readC']);
    for (const event of session.events()) if (event.type === 'tool.effect.prepared') {
      expect(session.events()[event.sourceEventIndex]).toMatchObject({ type: 'tool.called', toolCallId: (event.data as { id: string }).id });
    }
  });

  it('preserves ordered denied results and checkpoint identities inside a parallel read group', async () => {
    const { agent, session } = fixture(['readA', 'readB', 'readC']);
    let releaseFirst!: () => void; const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const denied = vi.fn<Tool['execute']>();
    agent.tools.register(reading('readA', async () => { await first; return { status: 'success', output: 'A' }; }));
    agent.tools.register(reading('readB', denied));
    agent.tools.register(reading('readC', async (_input, context) => {
      context.checkpoint?.({ id: 'readC' }); return { status: 'success', output: 'C' };
    }));
    const task = runTurn(agent, '策略拒绝中间调用', { beforeToolCall: input => ({ boundary: 'read-only',
      ...(input.call.name === 'readB' ? { blocked: { message: 'workspace violation', sourceEventIndexes: [] } } : {}) }) });
    await vi.waitFor(() => expect(session.events().filter(event => event.type === 'tool.called')).toHaveLength(3));
    releaseFirst(); await task;
    expect(denied).not.toHaveBeenCalled();
    expect(session.events().filter(event => event.type === 'tool.result').map(event => event.toolCallId)).toEqual(['readA', 'readB', 'readC']);
    expect(projectRecoveryFacts(session.events()).unknownEffects).toEqual([]);
    const prepared = session.events().find(event => event.type === 'tool.effect.prepared')!;
    if (prepared.type !== 'tool.effect.prepared') throw new Error('fixture checkpoint missing');
    expect(session.events()[prepared.sourceEventIndex]).toMatchObject({ type: 'tool.called', toolCallId: 'readC' });
  });

  it('waits for every parallel tool to settle on cancellation and preserves actual completed read facts', async () => {
    const { agent, session } = fixture(['readA', 'readB']);
    const controller = new AbortController(); const starts: string[] = []; let releaseSecond!: () => void;
    const secondFinished = new Promise<void>(resolve => { releaseSecond = resolve; });
    const waitForAbort = async (name: string, context: ToolExecutionContext) => new Promise<never>((_resolve, reject) => {
      starts.push(name); context.signal!.addEventListener('abort', () => reject(context.signal!.reason), { once: true });
    });
    agent.tools.register(reading('readA', async (_input, context) => waitForAbort('A', context)));
    agent.tools.register(reading('readB', async () => {
      starts.push('B'); await secondFinished; return { status: 'success', output: 'already read' };
    }));
    const task = runTurn(agent, '取消并行读取', { signal: controller.signal });
    await vi.waitFor(() => expect(starts).toEqual(['A', 'B']));
    controller.abort(); const ended = vi.fn(); void task.catch(ended);
    await Promise.resolve(); expect(ended).not.toHaveBeenCalled();
    releaseSecond();
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.events().filter(event => event.type === 'tool.result')).toEqual([
      expect.objectContaining({ toolCallId: 'readB', result: { status: 'success', output: 'already read' } }),
    ]);
    expect(session.events().at(-1)?.type).toBe('turn.cancelled');
  });

  it('keeps complete Tool Result and artifact facts while sending a bounded explicit preview to the next model', async () => {
    const { agent, session, requests } = fixture(['large']);
    const output = `BEGIN ${'x'.repeat(40_000)} END`;
    agent.tools.register(reading('large', async () => ({ status: 'success', output, artifacts: [artifact('real.txt')] })));
    await runTurn(agent, '读取大结果');
    expect(session.events().find(event => event.type === 'tool.result')).toMatchObject({ result: { status: 'success', output, artifacts: [artifact('real.txt')] } });
    const projected = requests[1]!.messages.find(message => message.role === 'tool')!;
    expect(new TextEncoder().encode(projected.content).length).toBeLessThanOrEqual(8192);
    expect(JSON.parse(projected.content)).toMatchObject({ status: 'success', artifacts: [artifact('real.txt')], truncation: { truncated: true } });
  });
});
