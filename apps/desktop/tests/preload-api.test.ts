import { describe, expect, it } from 'vitest';
import { createDesktopApi } from '../src/preload/api.js';

describe('createDesktopApi', () => {
  it('exposes only the five desktop IPC operations', async () => {
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
      'removeSelectedVideo',
      'runAgentTask',
      'selectVideoFile',
    ]);

    await api.selectVideoFile();
    await api.removeSelectedVideo(1);
    await api.runAgentTask('保留核心内容');
    await api.openOutputFile('step1.mp4');
    expect(invocations).toEqual([
      { channel: 'desktop:select-video', args: [] },
      { channel: 'desktop:remove-video', args: [1] },
      { channel: 'desktop:run-agent-task', args: ['保留核心内容'] },
      { channel: 'desktop:open-output-file', args: ['step1.mp4'] },
    ]);

    const events: unknown[] = [];
    const unsubscribe = api.onAgentEvent((event) => events.push(event));
    listeners.get('desktop:agent-event')?.({}, { type: 'tool.started', toolName: 'probe_media' });
    expect(events).toEqual([{ type: 'tool.started', toolName: 'probe_media' }]);

    unsubscribe();
    expect(listeners.has('desktop:agent-event')).toBe(false);
  });
});
