import { describe, expect, it, vi } from 'vitest';
import { SessionComputer } from '../src/main/computer-host.js';

describe('SessionComputer boundary', () => {
  it('declares serial computer tools with explicit approval, cancellation and execution boundaries', () => {
    const computer = new SessionComputer({ approve: async () => false });
    const tools = computer.tools();
    expect(tools.map(tool => tool.name)).toEqual(['computer_window_list', 'computer_snapshot', 'computer_click', 'computer_type',
      'computer_key', 'computer_scroll', 'computer_wait', 'computer_screenshot']);
    for (const tool of tools) {
      expect(tool.contract).toMatchObject({ capability: 'computer', parallelSafety: 'serial', cancellation: 'signal' });
      if (tool.executionBoundary === 'checkpointed') expect(tool.contract?.approvalRequirement).toBe('policy');
    }
  });

  it('rejects forged and stale references before requesting approval or launching UI input', async () => {
    const approve = vi.fn(async () => true);
    const computer = new SessionComputer({ approve });
    const click = computer.tools().find(tool => tool.name === 'computer_click')!;
    await expect(click.execute({ windowId: 'forged-window', snapshotId: 'forged-snapshot', ref: 'e1' },
      { toolCallId: 'fixture' as never, reportProgress: () => {} })).rejects.toMatchObject({ failureKind: 'permanent', message: expect.stringContaining('stale reference') });
    expect(approve).not.toHaveBeenCalled();
  });

  it('bounds wait duration, observes cancellation and closes the session', async () => {
    const computer = new SessionComputer({ approve: async () => false });
    const wait = computer.tools().find(tool => tool.name === 'computer_wait')!;
    const context = { toolCallId: 'fixture' as never, reportProgress: () => {} };
    await expect(wait.execute({ milliseconds: 5001 }, context)).rejects.toMatchObject({ failureKind: 'permanent' });
    const controller = new AbortController();
    const waiting = wait.execute({ milliseconds: 1000 }, { ...context, signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await computer.close();
    await expect(wait.execute({ milliseconds: 0 }, context)).rejects.toMatchObject({ message: expect.stringContaining('已关闭') });
  });
});
