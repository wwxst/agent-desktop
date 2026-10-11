import { describe, expect, it, vi } from 'vitest';
import { createDesktopApi } from '../src/preload/api.js';

describe('createDesktopApi', () => {
  it('forwards update state, direct installation, retry and subscription cleanup', async () => {
    const invoke = vi.fn(async () => ({ status: 'ready' }));
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const removeListener = vi.fn();
    const api = createDesktopApi({ invoke, send: () => {}, on: (channel, listener) => listeners.set(channel, listener), removeListener });
    expect(await api.appUpdates!.getState()).toEqual({ status: 'ready' });
    const changed = vi.fn();
    const cleanup = api.appUpdates!.onStateChanged(changed);
    listeners.get('desktop:update-state')!({}, { status: 'downloading', percent: 25 });
    expect(changed).toHaveBeenCalledWith({ status: 'downloading', percent: 25 });
    await api.appUpdates!.install();
    await api.appUpdates!.retry();
    expect(invoke.mock.calls).toEqual([['desktop:get-update-state'], ['desktop:install-update'], ['desktop:retry-update']]);
    cleanup();
    expect(removeListener).toHaveBeenCalledWith('desktop:update-state', listeners.get('desktop:update-state'));
  });
  it('forwards extension operations and displays the host error without the IPC prefix', async () => {
    const invoke = vi.fn(async () => ({ plugins: [], skills: [] }));
    const api = createDesktopApi({ invoke, send: () => {}, on: () => {}, removeListener: () => {} });
    await api.extensions.list();
    await api.extensions.importLocal('plugin');
    await api.extensions.install('plugin:test');
    await api.extensions.setEnabled('plugin:test', false);
    await api.extensions.uninstall('plugin:test');
    await api.extensions.readDetail('skill:test');
    await api.extensions.listSkills(true);
    await api.extensions.readSkill('skill:test');
    await api.extensions.reconcile();
    expect(invoke.mock.calls).toEqual([
      ['desktop:list-extensions'], ['desktop:import-extension', 'plugin'], ['desktop:install-extension', 'plugin:test'],
      ['desktop:enable-extension', 'plugin:test', false], ['desktop:uninstall-extension', 'plugin:test'], ['desktop:read-extension', 'skill:test'],
      ['desktop:list-skills', true], ['desktop:read-skill', 'skill:test'], ['desktop:reconcile-extensions'],
    ]);
    invoke.mockRejectedValueOnce(new Error("Error invoking remote method 'desktop:install-extension': Error: 扩展操作正在进行。"));
    await expect(api.extensions.install('plugin:test')).rejects.toThrow(/^扩展操作正在进行。$/);
    invoke.mockRejectedValueOnce(new Error("Error invoking remote method 'desktop:install-extension': Error: 下载失败\nfatal: 无法连接仓库"));
    await expect(api.extensions.install('plugin:test')).rejects.toThrow(/^下载失败\nfatal: 无法连接仓库$/);
  });
  it('delivers extension invalidation notifications and removes its IPC listener', () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const removeListener = vi.fn();
    const api = createDesktopApi({ invoke: async () => undefined, send: () => {}, on: (channel, listener) => listeners.set(channel, listener), removeListener });
    const changed = vi.fn();
    const cleanup = api.extensions.onChanged(changed);
    listeners.get('desktop:extensions-changed')!({}, undefined);
    expect(changed).toHaveBeenCalledOnce();
    cleanup();
    expect(removeListener).toHaveBeenCalledWith('desktop:extensions-changed', listeners.get('desktop:extensions-changed'));
  });
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
      'answerQuestion',
      'appUpdates',
      'cancelTask',
      'closeTerminal',
      'decideApproval',
      'deleteMemories',
      'deleteSession',
      'extensions',
      'getActiveSessionId',
      'listProviderModels',
      'loadClientState',
      'loadCustomInstructions',
      'loadMemories',
      'loadRuntimeSettings',
      'newSession',
      'onAgentEvent',
      'onPrepareClose',
      'openModelConfig',
      'openProjectDirectory',
      'recoverTask',
      'removeAttachment',
      'resizeTerminal',
      'revealFile',
      'runAgentTask',
      'saveClientState',
      'saveCustomInstructions',
      'saveRuntimeSettings',
      'selectAttachmentFiles',
      'selectProjectDirectory',
      'switchSession',
      'verifyTaskEffect',
    ]);

    await api.getActiveSessionId();
    await api.loadRuntimeSettings();
    await api.listProviderModels({ id: 'deepseek', baseUrl: 'https://api.deepseek.com', protocol: 'chat-completions' });
    await api.openModelConfig();
    await api.saveRuntimeSettings({ conversationModel: { providerId: 'deepseek', modelId: 'test-model' } });
    await api.loadClientState();
    await api.saveClientState({ activeSessionId: 'session-a', conversations: [] });
    await api.selectAttachmentFiles();
    await api.removeAttachment(1);
    await api.newSession();
    await api.switchSession('session-2');
    await api.deleteSession('session-2');
    await api.runAgentTask('保留核心内容');
    await api.cancelTask();
    // 审批只传请求标识和决定：待执行的操作参数不经过渲染层。
    await api.decideApproval('request-1', true);
    await api.revealFile('D:\\videos\\step1.mp4');
    expect(invocations).toEqual([
      { channel: 'desktop:get-active-session-id', args: [] },
      { channel: 'desktop:load-runtime-settings', args: [] },
      { channel: 'desktop:list-provider-models', args: [{ id: 'deepseek', baseUrl: 'https://api.deepseek.com', protocol: 'chat-completions' }] },
      { channel: 'desktop:open-model-config', args: [] },
      { channel: 'desktop:save-runtime-settings', args: [{ conversationModel: { providerId: 'deepseek', modelId: 'test-model' } }] },
      { channel: 'desktop:load-client-state', args: [] },
      { channel: 'desktop:save-client-state', args: [{ activeSessionId: 'session-a', conversations: [] }] },
      { channel: 'desktop:select-attachment-files', args: [] },
      { channel: 'desktop:remove-attachment', args: [1] },
      { channel: 'desktop:new-session', args: [] },
      { channel: 'desktop:switch-session', args: ['session-2'] },
      { channel: 'desktop:delete-session', args: ['session-2'] },
      { channel: 'desktop:run-agent-task', args: ['保留核心内容'] },
      { channel: 'desktop:cancel-task', args: [] },
      { channel: 'desktop:decide-approval', args: ['request-1', true] },
      { channel: 'desktop:reveal-file', args: ['D:\\videos\\step1.mp4'] },
    ]);

    const events: unknown[] = [];
    const unsubscribe = api.onAgentEvent((event) => events.push(event));
    const item = { id: 'call-1', kind: 'tool' as const, status: 'running' as const, toolName: 'probe_media' };
    listeners.get('desktop:agent-event')?.({}, { type: 'activity', item });
    listeners.get('desktop:agent-event')?.({}, { type: 'text.delta', delta: '实时增量' });
    listeners.get('desktop:agent-event')?.({}, {
      type: 'task.state', sessionId: 'session-a',
      taskState: { rootTurnId: 'turn-1', latestTurnId: 'turn-1', status: 'started' },
    });
    expect(events).toEqual([
      { type: 'activity', item },
      { type: 'text.delta', delta: '实时增量' },
      { type: 'task.state', sessionId: 'session-a', taskState: { rootTurnId: 'turn-1', latestTurnId: 'turn-1', status: 'started' } },
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

  it('removes the Electron IPC prefix from reveal failures and keeps successful calls unchanged', async () => {
    const missingPath = 'D:\\work\\notes-moved.txt';
    const failingIpc = {
      invoke: async (channel: string) => {
        if (channel === 'desktop:reveal-file') {
          throw new Error(
            `Error invoking remote method 'desktop:reveal-file': Error: 文件不存在或已被移动：${missingPath}`,
          );
        }
        return undefined;
      },
      send: () => undefined,
      on: () => undefined,
      removeListener: () => undefined,
    };

    // 活动行和产物卡都只展示宿主真实消息，不展示 Electron 为 invoke 添加的技术包装。
    await expect(createDesktopApi(failingIpc).revealFile(missingPath)).rejects.toEqual(
      new Error(`文件不存在或已被移动：${missingPath}`),
    );

    // 成功定位保持原样：不改写参数，也不产生错误。
    const invocations: Array<{ channel: string; args: readonly unknown[] }> = [];
    const resolvingIpc = {
      ...failingIpc,
      invoke: async (channel: string, ...args: unknown[]) => { invocations.push({ channel, args }); },
    };
    await expect(createDesktopApi(resolvingIpc).revealFile('D:\\videos\\done.mp4')).resolves.toBeUndefined();
    expect(invocations).toEqual([{ channel: 'desktop:reveal-file', args: ['D:\\videos\\done.mp4'] }]);
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
