import { describe, expect, it } from 'vitest';
import { createDesktopApi } from '../src/preload/api.js';

describe('createDesktopApi', () => {
  it('exposes only the four desktop IPC operations', async () => {
    const invocations: Array<{ channel: string; args: readonly unknown[] }> = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const ipc = {
      invoke: async (channel: string, ...args: unknown[]) => {
        invocations.push({ channel, args });
        return channel;
      },
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener);
      },
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      },
    };

    const api = createDesktopApi(ipc);
    expect(Object.keys(api).sort()).toEqual([
      'onAgentEvent',
      'openOutputFile',
      'runAgentTask',
      'selectVideoFile',
    ]);

    await api.selectVideoFile();
    await api.runAgentTask('保留核心内容');
    await api.openOutputFile();
    expect(invocations).toEqual([
      { channel: 'desktop:select-video', args: [] },
      { channel: 'desktop:run-agent-task', args: ['保留核心内容'] },
      { channel: 'desktop:open-output-file', args: [] },
    ]);

    const events: unknown[] = [];
    const unsubscribe = api.onAgentEvent((event) => events.push(event));
    listeners.get('desktop:agent-event')?.({}, { type: 'tool.started', toolName: 'probe_media' });
    expect(events).toEqual([{ type: 'tool.started', toolName: 'probe_media' }]);

    unsubscribe();
    expect(listeners.has('desktop:agent-event')).toBe(false);
  });
});
