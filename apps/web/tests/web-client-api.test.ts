import { describe, expect, it } from 'vitest';
import type { AgentRuntimeEvent } from '@agent-desktop/client';
import { createWebClientApi } from '../src/webClientApi.js';

describe('Web Dev API', () => {
  it('keeps sessions and emits a simulated activity timeline, live text, and artifact result', async () => {
    const api = createWebClientApi();
    const initial = await api.getActiveSessionId();
    const second = await api.newSession();
    await api.switchSession(initial);
    const events: AgentRuntimeEvent[] = [];
    api.onAgentEvent((event) => events.push(event));
    const result = await api.runAgentTask('测试任务');

    expect(second).not.toBe(initial);
    expect(events.map((event) => event.type)).toEqual([
      'activity', 'activity', 'activity', 'text.delta', 'text.delta', 'activity', 'activity',
    ]);
    // 开发宿主的模拟活动必须使用与真实 Desktop 相同的契约和真实形状的文件路径，否则浏览器验收会验证到假数据。
    const activity = events.flatMap((event) => (event.type === 'activity' ? [event.item] : []));
    expect(activity.map((item) => item.id)).toEqual([
      'web-model-1', 'web-model-1', 'web-tool-1', 'web-tool-1', 'web-tool-2',
    ]);
    expect(activity.at(-1)).toMatchObject({
      kind: 'tool',
      toolName: 'trim_video',
      status: 'completed',
      files: [
        { path: 'E:/videos/web-test-video.mp4', role: 'input' },
        { path: 'E:/videos/web-dev-artifact.mp4', role: 'output' },
      ],
    });
    expect(result.responseText).toContain('测试任务');
    expect(result.outputFiles).toEqual([
      { path: 'E:/videos/web-dev-artifact.mp4', fileName: 'web-dev-artifact.mp4' },
    ]);
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
