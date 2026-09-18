import { describe, expect, it, vi } from 'vitest';
import { createDesktopApi } from '../src/preload/api.js';

describe('createDesktopApi', () => {
  it('exposes the desktop IPC operations', async () => {
    const invocations: Array<{ channel: string; args: readonly unknown[] }> = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const ipc = {
      invoke: async (channel: string, ...args: unknown[]) => {
        invocations.push({ channel, args });
        if (channel === 'desktop:run-agent-task') {
          return { status: 'success', result: { responseText: 'done', traceId: 'trace-1' } };
        }
        return channel;
      },
      send: () => undefined,
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener);
      },
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      },
    };

    const api = createDesktopApi(ipc);
    expect(Object.keys(api).sort()).toEqual([
      'cancelTask',
      'deleteSession',
      'getActiveSessionId',
      'loadClientState',
      'loadRuntimeSettings',
      'newSession',
      'onAgentEvent',
      'onPrepareClose',
      'removeAttachment',
      'revealFile',
      'runAgentTask',
      'saveClientState',
      'saveRuntimeSettings',
      'selectAttachmentFiles',
      'switchSession',
    ]);

    await api.getActiveSessionId();
    await api.loadRuntimeSettings();
    await api.saveRuntimeSettings({ deepSeekModel: 'test-model' });
    await api.loadClientState();
    await api.saveClientState({ activeSessionId: 'session-a', conversations: [] });
    await api.selectAttachmentFiles();
    await api.removeAttachment(1);
    await api.newSession();
    await api.switchSession('session-2');
    await api.deleteSession('session-2');
    await api.runAgentTask('保留核心内容');
    await api.cancelTask();
    await api.revealFile('D:\\videos\\step1.mp4');
    expect(invocations).toEqual([
      { channel: 'desktop:get-active-session-id', args: [] },
      { channel: 'desktop:load-runtime-settings', args: [] },
      { channel: 'desktop:save-runtime-settings', args: [{ deepSeekModel: 'test-model' }] },
      { channel: 'desktop:load-client-state', args: [] },
      { channel: 'desktop:save-client-state', args: [{ activeSessionId: 'session-a', conversations: [] }] },
      { channel: 'desktop:select-attachment-files', args: [] },
      { channel: 'desktop:remove-attachment', args: [1] },
      { channel: 'desktop:new-session', args: [] },
      { channel: 'desktop:switch-session', args: ['session-2'] },
      { channel: 'desktop:delete-session', args: ['session-2'] },
      { channel: 'desktop:run-agent-task', args: ['保留核心内容'] },
      { channel: 'desktop:cancel-task', args: [] },
      { channel: 'desktop:reveal-file', args: ['D:\\videos\\step1.mp4'] },
    ]);

    const events: unknown[] = [];
    const unsubscribe = api.onAgentEvent((event) => events.push(event));
    const item = { id: 'call-1', kind: 'tool' as const, status: 'running' as const, toolName: 'probe_media' };
    listeners.get('desktop:agent-event')?.({}, { type: 'activity', item });
    listeners.get('desktop:agent-event')?.({}, { type: 'text.delta', delta: '实时增量' });
    expect(events).toEqual([
      { type: 'activity', item },
      { type: 'text.delta', delta: '实时增量' },
    ]);

    unsubscribe();
    expect(listeners.has('desktop:agent-event')).toBe(false);
  });

  it('removes the Electron IPC prefix from task errors shown by the Renderer', async () => {
    const ipc = {
      invoke: async () => {
        throw new Error(
          "Error invoking remote method 'desktop:run-agent-task': Error: 请先在设置中配置 DeepSeek API Key。",
        );
      },
      send: () => undefined,
      on: () => undefined,
      removeListener: () => undefined,
    };

    await expect(createDesktopApi(ipc).runAgentTask('测试')).rejects.toEqual(
      new Error('请先在设置中配置 DeepSeek API Key。'),
    );
  });

  it('preserves cancellation as AbortError across the IPC boundary', async () => {
    const ipc = {
      invoke: async () => {
        throw new Error("Error invoking remote method 'desktop:run-agent-task': AbortError: This operation was aborted");
      },
      send: () => undefined,
      on: () => undefined,
      removeListener: () => undefined,
    };

    await expect(createDesktopApi(ipc).runAgentTask('测试')).rejects.toMatchObject({
      name: 'AbortError', message: 'This operation was aborted',
    });
  });

  it('reconstructs failed task output files from a structured IPC result', async () => {
    const outputFiles = [{ path: 'D:/videos/done.mp4', fileName: 'done.mp4' }];
    const ipc = {
      invoke: async () => ({
        status: 'error',
        errorName: 'AbortError',
        errorMessage: 'This operation was aborted',
        outputFiles,
      }),
      send: () => undefined,
      on: () => undefined,
      removeListener: () => undefined,
    };

    await expect(createDesktopApi(ipc).runAgentTask('测试')).rejects.toMatchObject({
      name: 'AbortError',
      message: 'This operation was aborted',
      outputFiles,
    });
  });

  it('reports the close preparation result back to the Main process', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const invokes: string[] = [];
    const sends: Array<{ channel: string; payload: unknown }> = [];
    const ipc = {
      invoke: async (channel: string) => { invokes.push(channel); },
      send: (channel: string, payload: unknown) => { sends.push({ channel, payload }); },
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener);
      },
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      },
    };

    const api = createDesktopApi(ipc);
    const prepared = vi.fn(async () => undefined);
    const unsubscribe = api.onPrepareClose(prepared);
    expect([...listeners.keys()]).toEqual(['desktop:prepare-close']);
    await vi.waitFor(() => expect(invokes).toEqual(['desktop:close-ready']));

    listeners.get('desktop:prepare-close')?.({});
    await vi.waitFor(() => expect(sends).toEqual([
      { channel: 'desktop:close-prepared', payload: null },
    ]));
    expect(prepared).toHaveBeenCalledOnce();

    // 提交失败时把原因交给主进程展示，主进程据此保留窗口。
    unsubscribe();
    expect(listeners.has('desktop:prepare-close')).toBe(false);
    const failing = createDesktopApi(ipc);
    failing.onPrepareClose(async () => { throw new Error('磁盘不可写'); });
    listeners.get('desktop:prepare-close')?.({});
    await vi.waitFor(() => expect(sends.at(-1)).toEqual({
      channel: 'desktop:close-prepared',
      payload: '磁盘不可写',
    }));
  });
});
