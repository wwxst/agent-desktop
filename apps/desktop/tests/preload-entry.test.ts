import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

describe('desktop preload entry', () => {
  beforeEach(() => {
    electron.exposeInMainWorld.mockClear();
  });

  it('publishes the narrow API under agentDesktop', async () => {
    await import('../src/preload/index.js');

    expect(electron.exposeInMainWorld).toHaveBeenCalledOnce();
    expect(electron.exposeInMainWorld).toHaveBeenCalledWith(
      'agentDesktop',
      expect.objectContaining({
        selectVideoFile: expect.any(Function),
        runAgentTask: expect.any(Function),
        onAgentEvent: expect.any(Function),
        openOutputFile: expect.any(Function),
      }),
    );
  });
});
