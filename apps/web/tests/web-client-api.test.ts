import { describe, expect, it } from 'vitest';
import { createWebClientApi } from '../src/webClientApi.js';

describe('Web Dev API', () => {
  it('keeps sessions and emits a simulated tool and artifact result', async () => {
    const api = createWebClientApi();
    const initial = await api.getActiveSessionId();
    const second = await api.newSession();
    await api.switchSession(initial);
    const events: string[] = [];
    api.onAgentEvent((event) => events.push(event.type));
    const result = await api.runAgentTask('测试任务');

    expect(second).not.toBe(initial);
    expect(events).toEqual(['tool.started', 'tool.completed']);
    expect(result.responseText).toContain('测试任务');
    expect(result.outputFileName).toBe('web-dev-artifact.mp4');
  });

  it('cancels a simulated turn and allows the next turn to run', async () => {
    const api = createWebClientApi();
    const running = api.runAgentTask('长任务');
    await api.cancelTask!();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await expect(api.runAgentTask('下一条')).resolves.toMatchObject({
      responseText: expect.stringContaining('下一条'),
    });
    await expect(api.cancelTask!()).rejects.toThrow('当前没有正在执行的任务');
  });

  it('deletes the last session and returns the exact replacement session id', async () => {
    const api = createWebClientApi();
    const initial = await api.getActiveSessionId();

    const replacement = await api.deleteSession(initial);

    expect(replacement).not.toBe(initial);
    expect(await api.getActiveSessionId()).toBe(replacement);
  });

  it('keeps runtime settings in memory and returns only secret status', async () => {
    const api = createWebClientApi();
    const saved = await api.saveRuntimeSettings({
      deepSeekApiKey: 'web-only-secret',
      deepSeekModel: 'web-model',
    });

    expect(saved.deepSeek).toMatchObject({
      apiKey: { configured: true, source: 'saved' },
      model: 'web-model',
    });
    expect(JSON.stringify(await api.loadRuntimeSettings())).not.toContain('web-only-secret');
  });
});
