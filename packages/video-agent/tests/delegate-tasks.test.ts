import { describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext } from '@agent-desktop/tools';
import { DelegateTasksTool, type SubagentResult } from '../src/delegate-tasks.js';
import { InMemorySession } from '@agent-desktop/session';

const context: ToolExecutionContext = { toolCallId: 'parent' as never, reportProgress: () => {} };
const tasks = [{ title: 'A', instruction: '检查 A' }, { title: 'B', instruction: '检查 B' }];
const session = () => {
  const history = new InMemorySession();
  history.append({ type: 'turn.started', turnId: 'turn-1' as never, payload: {} });
  return history;
};

describe('read-only delegation', () => {
  it('starts two tasks together, retains an independent failure, and enforces the turn total', async () => {
    const releases: Array<(value: SubagentResult) => void> = [];
    const run = vi.fn(() => new Promise<SubagentResult>((resolve) => releases.push(resolve)));
    const tool = new DelegateTasksTool(run, session());
    const pending = tool.execute({ tasks }, context);
    expect(run).toHaveBeenCalledTimes(2);
    releases[1]!({ taskId: 'b', title: 'B', status: 'failed', summary: 'request failed', evidence: [] });
    releases[0]!({ taskId: 'a', title: 'A', status: 'completed', summary: 'A checked', evidence: ['a.txt'] });
    expect(await pending).toMatchObject({ status: 'success', output: { tasks: [{ taskId: 'a', status: 'completed' }, { taskId: 'b', status: 'failed' }] } });
    expect(await tool.execute({ tasks: tasks.slice(0, 1) }, context)).toMatchObject({ status: 'error' });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('waits for every child to finish cleanup before propagating parent cancellation', async () => {
    const controller = new AbortController();
    const releases: Array<(value: SubagentResult) => void> = [];
    const tool = new DelegateTasksTool(() => new Promise((resolve) => releases.push(resolve)), session());
    const pending = tool.execute({ tasks }, { ...context, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    releases[0]!({ taskId: 'a', title: 'A', status: 'cancelled', summary: '', evidence: [] });
    await Promise.resolve();
    expect(settled).toBe(false);
    releases[1]!({ taskId: 'b', title: 'B', status: 'cancelled', summary: '', evidence: [] });
    await rejection;
  });
  it('renews the budget in the next turn when the same Agent is reused', async () => {
    const history = session();
    const run = vi.fn(async () => ({ taskId: 'a', title: 'A', status: 'completed' as const, summary: 'read', evidence: ['a.txt'] }));
    const tool = new DelegateTasksTool(run, history);
    expect(await tool.execute({ tasks }, context)).toMatchObject({ status: 'success' });
    expect(await tool.execute({ tasks }, context)).toMatchObject({ status: 'error' });
    history.append({ type: 'turn.started', turnId: 'turn-2' as never, payload: {} });
    expect(await tool.execute({ tasks }, context)).toMatchObject({ status: 'success' });
    expect(run).toHaveBeenCalledTimes(4);
  });
});
