import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeEvent, AgentTaskStartRequest, RuntimeModelProviderUpdate } from '@agent-desktop/client';
import { createWebClientApi } from '../src/webClientApi.js';

afterEach(() => vi.unstubAllGlobals());

const visualProvider = (id = 'custom-web'): RuntimeModelProviderUpdate => ({
  id, displayName: 'Web', baseUrl: 'https://example.com/v1', protocol: 'chat-completions', apiKey: 'web-only-secret',
  models: [{ id: 'web-model', displayName: 'Web Model', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'supported', imageUnderstanding: 'supported' } }],
});
const taskRequest = (prompt: string): AgentTaskStartRequest => ({ sessionId: 'web-session-1', prompt,
  userMessageId: 1, assistantMessageId: 2, clientState: { activeSessionId: 'web-session-1', conversations: [], drafts: [] } });

describe('Web Dev API', () => {
  it('keeps sessions and emits a simulated activity timeline, live text, and artifact result', async () => {
    const api = createWebClientApi();
    const initial = await api.getActiveSessionId();
    const second = await api.newSession();
    await api.switchSession(initial);
    const events: AgentRuntimeEvent[] = [];
    api.onAgentEvent((event) => events.push(event));
    const result = await api.runAgentTask(taskRequest('测试任务'));

    expect(second).not.toBe(initial);
    expect(events.map((event) => event.type)).toEqual([
      'activity', 'activity', 'activity', 'text.delta', 'text.delta',
      'activity', 'activity', 'activity.detail', 'activity',
    ]);
    // 开发宿主的模拟活动必须使用与真实 Desktop 相同的契约和真实形状的文件路径，否则浏览器验收会验证到假数据。
    const activity = events.flatMap((event) => (event.type === 'activity' ? [event.item] : []));
    expect(activity.map((item) => item.id)).toEqual([
      'web-model-1', 'web-model-1', 'web-tool-1', 'web-tool-1', 'web-tool-2',
      'web-tool-3',
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
    expect(events).toContainEqual({
      type: 'activity.detail',
      activityId: 'web-tool-2',
      detail: expect.objectContaining({ kind: 'file-content', totalLines: 3 }),
    });
    expect(result.responseText).toContain('测试任务');
    expect(result.outputFiles).toEqual([
      { path: 'E:/videos/web-dev-artifact.mp4', fileName: 'web-dev-artifact.mp4' },
    ]);
  });

  it('cancels a simulated turn and allows the next turn to run', async () => {
    const api = createWebClientApi();
    const running = api.runAgentTask(taskRequest('长任务'));
    await api.cancelTask!();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await expect(api.runAgentTask(taskRequest('下一条'))).resolves.toMatchObject({
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
      modelProvider: { id: 'custom-web', displayName: 'Web', baseUrl: 'https://example.com/v1', protocol: 'chat-completions', apiKey: 'web-only-secret', models: [{ id: 'web-model', displayName: 'Web Model', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'unsupported', imageUnderstanding: 'unsupported' } }] },
    });

    expect(saved.modelProviders.find(provider => provider.id === 'custom-web')).toMatchObject({
      apiKey: { configured: true, source: 'saved' },
      models: [{ id: 'web-model' }],
    });
    expect(JSON.stringify(await api.loadRuntimeSettings())).not.toContain('web-only-secret');
  });
  it('restores desensitized model selection in a new Web host and keeps the prior state after storage failure', async () => {
    let persisted: string | null = null;
    const documents = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => { documents.set(key, value); if (key === 'agent-desktop:web-runtime-settings') persisted = value; });
    vi.stubGlobal('localStorage', { getItem: (key: string) => documents.get(key) ?? null, setItem });
    const api = createWebClientApi();
    await api.saveRuntimeSettings({ modelProvider: { id: 'custom-web', displayName: 'Web', baseUrl: 'https://example.com/v1', protocol: 'chat-completions', apiKey: 'web-only-secret', models: [{ id: 'web-model', displayName: 'Web Model', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'unknown', imageUnderstanding: 'unknown' } }] },
      conversationModel: { providerId: 'custom-web', modelId: 'web-model' } });
    expect(persisted).not.toContain('web-only-secret');
    await api.saveClientState({ activeSessionId: 'web-session-1', conversations: [], drafts: [{ id: 'web-session-1', title: '新聊天', titleManuallyRenamed: false, messages: [], prompt: '保留权限草稿', attachments: [] }] });
    await expect(api.setPermissionMode('auto-review')).resolves.toBe('auto-review');
    const before = await api.loadRuntimeSettings();
    const restored = createWebClientApi();
    expect((await restored.loadClientState())?.drafts?.[0]).toMatchObject({ permissionMode: 'auto-review', prompt: '保留权限草稿' });
    const loaded = await restored.loadRuntimeSettings();
    expect(loaded).toEqual(before);
    for (const item of loaded.modelProviders) expect(item).not.toHaveProperty('builtin');
    expect(loaded).toMatchObject({ conversationModel: { providerId: 'custom-web', modelId: 'web-model' }, fallbackVisionEnabled: false });
    setItem.mockImplementationOnce(() => { throw new Error('浏览器存储失败'); });
    await expect(restored.saveRuntimeSettings({ conversationModel: { providerId: 'deepseek', modelId: 'deepseek-flash' } })).rejects.toThrow('浏览器存储失败');
    expect((await restored.loadRuntimeSettings()).conversationModel).toEqual({ providerId: 'custom-web', modelId: 'web-model' });
    expect((await createWebClientApi().loadRuntimeSettings()).conversationModel).toEqual({ providerId: 'custom-web', modelId: 'web-model' });
    await restored.saveRuntimeSettings({ theme: 'dark' });
    expect(persisted).not.toContain('builtin');
    expect((await createWebClientApi().loadRuntimeSettings()).modelProviders).toEqual(before.modelProviders);
  });
  it('deletes supplied providers through the last model without restoring them in a new Web host', async () => {
    let persisted: string | null = null;
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'agent-desktop:web-runtime-settings' ? persisted : null, setItem: (_key: string, value: string) => { persisted = value; } });
    const api = createWebClientApi();
    await api.saveRuntimeSettings({ deleteModelProviderId: 'openai' });
    expect((await createWebClientApi().loadRuntimeSettings()).modelProviders.map(item => item.id)).toEqual(['deepseek']);
    const conversationModel = { providerId: 'custom-web', modelId: 'web-model' };
    await api.saveRuntimeSettings({ modelProvider: visualProvider(), conversationModel });
    await api.saveRuntimeSettings({ deleteModelProviderId: 'deepseek' });
    const restored = await createWebClientApi().loadRuntimeSettings();
    expect(restored.modelProviders.map(item => item.id)).toEqual(['custom-web']);
    expect(restored.conversationModel).toEqual(conversationModel);
    await api.saveRuntimeSettings({ deleteModelProviderId: 'custom-web' });
    expect(await createWebClientApi().loadRuntimeSettings()).toMatchObject({ modelProviders: [], conversationModel: null });
    await api.saveRuntimeSettings({ theme: 'dark' });
    expect(await createWebClientApi().loadRuntimeSettings()).toMatchObject({ modelProviders: [], conversationModel: null, theme: 'dark' });
    await api.saveRuntimeSettings({ modelProvider: visualProvider() });
    expect(await createWebClientApi().loadRuntimeSettings()).toMatchObject({ modelProviders: [{ id: 'custom-web' }], conversationModel });
  });
  it('preserves a disabled visual candidate until its supplier is explicitly deleted and persists the cleared choice', async () => {
    let persisted: string | null = null;
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'agent-desktop:web-runtime-settings' ? persisted : null, setItem: (_key: string, value: string) => { persisted = value; } });
    const api = createWebClientApi();
    const fallbackVisionModel = { providerId: 'custom-web', modelId: 'web-model' };
    await api.saveRuntimeSettings({ modelProvider: visualProvider(), fallbackVisionModel, fallbackVisionEnabled: true });
    expect(await api.saveRuntimeSettings({ fallbackVisionEnabled: false })).toMatchObject({ fallbackVisionEnabled: false, fallbackVisionModel });
    await api.saveRuntimeSettings({ deleteModelProviderId: 'custom-web' });
    const restored = await createWebClientApi().loadRuntimeSettings();
    expect(restored).toMatchObject({ fallbackVisionEnabled: false, fallbackVisionModel: null });
    expect(restored.modelProviders.some(item => item.id === 'custom-web')).toBe(false);
  });
  it('clears an enabled visual supplier on deletion and preserves an explicit replacement', async () => {
    const api = createWebClientApi();
    const fallbackVisionModel = { providerId: 'custom-web', modelId: 'web-model' };
    await api.saveRuntimeSettings({ modelProvider: visualProvider(), fallbackVisionModel, fallbackVisionEnabled: true });
    expect(await api.saveRuntimeSettings({ deleteModelProviderId: 'custom-web' })).toMatchObject({ fallbackVisionEnabled: false, fallbackVisionModel: null });
    await api.saveRuntimeSettings({ modelProvider: visualProvider(), fallbackVisionModel, fallbackVisionEnabled: true });
    const replacement = { providerId: 'replacement', modelId: 'web-model' };
    const saved = await api.saveRuntimeSettings({ modelProvider: visualProvider('replacement'), deleteModelProviderId: 'custom-web', fallbackVisionModel: replacement });
    expect(saved).toMatchObject({ fallbackVisionEnabled: true, fallbackVisionModel: replacement });
    expect(saved.modelProviders.some(item => item.id === 'custom-web')).toBe(false);
  });
  it('selects the first remaining conversation model and preserves an explicit replacement on supplier deletion', async () => {
    const api = createWebClientApi();
    const conversationModel = { providerId: 'custom-web', modelId: 'web-model' };
    await api.saveRuntimeSettings({ modelProvider: visualProvider(), conversationModel });
    expect(await api.saveRuntimeSettings({ deleteModelProviderId: 'custom-web' })).toMatchObject({
      conversationModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
    });
    await api.saveRuntimeSettings({ modelProvider: visualProvider(), conversationModel });
    const replacement = { providerId: 'deepseek', modelId: 'deepseek-flash' };
    expect(await api.saveRuntimeSettings({ deleteModelProviderId: 'custom-web', conversationModel: replacement })).toMatchObject({ conversationModel: replacement });
  });
});
