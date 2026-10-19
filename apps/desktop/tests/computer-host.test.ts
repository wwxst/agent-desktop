import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPersistenceError } from '@agent-desktop/session';
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

  it('persists the screenshot checkpoint before creating any output file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'computer-checkpoint-'));
    const approve = vi.fn(async () => true);
    const computer = new SessionComputer({ approve, outputDirectory: () => directory });
    // 固定已观察窗口身份，聚焦截图写入顺序，不启动 Windows helper。
    const state = { identity: { runtimeId: [1], processId: 1, handle: '1', name: 'fixture', automationId: '',
      className: '', controlType: 'window', enabled: true, offscreen: false, password: false, focusable: true, processName: 'fixture' } };
    (computer as unknown as { windows: Map<string, typeof state> }).windows.set('window', state);
    const failure = new SessionPersistenceError(new Error('checkpoint failed'));
    const checkpoint = vi.fn(() => { expect(readdirSync(directory)).toEqual([]); throw failure; });
    try {
      await expect(computer.tools().find(tool => tool.name === 'computer_screenshot')!.execute({ windowId: 'window' },
        { toolCallId: 'screenshot' as never, reportProgress: () => {}, checkpoint })).rejects.toBe(failure);
      expect(approve).toHaveBeenCalledOnce(); expect(checkpoint).toHaveBeenCalledOnce();
      expect(await readdir(directory)).toEqual([]);
    } finally { await computer.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
