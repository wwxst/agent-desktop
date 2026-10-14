import { DEFAULT_MODEL_PROVIDERS } from '@agent-desktop/client';
// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/index.js';
import type { AgentClientApi, AgentRuntimeEvent, AgentTaskResult, AppUpdateState, ClientStateSnapshot } from '../src/index.js';

const api: AgentClientApi = {
  extensions: {
    manage: async () => ({ plugins: [], skills: [] }),
    list: async () => ({ plugins: [], skills: [] }), importLocal: async () => null,
    install: async () => ({ plugins: [], skills: [] }), setEnabled: async () => ({ plugins: [], skills: [] }),
    uninstall: async () => ({ plugins: [], skills: [] }), readDetail: async () => '',
    listSkills: async () => [], readSkill: async () => '', reconcile: async () => ({ plugins: [], skills: [] }), onChanged: () => () => undefined,
  },
  answerQuestion: async () => undefined,
  closeTerminal: async () => undefined,
  resizeTerminal: async () => undefined,
  selectProjectDirectory: async () => null,
  openProjectDirectory: async () => undefined,
  listProviderModels: async () => [],
  openModelConfig: async () => undefined,
  loadRuntimeSettings: async () => ({
    modelProviders: DEFAULT_MODEL_PROVIDERS,
    conversationModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
    fallbackVisionModel: { providerId: 'openai', modelId: 'gpt-5.6-luna' }, fallbackVisionEnabled: false,
    whisper: { modelPath: '', cliPath: '' },
    memoryEnabled: true,
    memoryFromToolChatsEnabled: true,
  }),
  saveRuntimeSettings: async () => ({
    modelProviders: DEFAULT_MODEL_PROVIDERS,
    conversationModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
    fallbackVisionModel: { providerId: 'openai', modelId: 'gpt-5.6-luna' }, fallbackVisionEnabled: false,
    whisper: { modelPath: '', cliPath: '' },
    memoryEnabled: true,
    memoryFromToolChatsEnabled: true,
  }),
  loadMemories: async () => [],
  deleteMemories: async () => undefined,
  loadCustomInstructions: async () => ({ path: 'AGENTS.md', content: '' }),
  saveCustomInstructions: async content => ({ path: 'AGENTS.md', content }),
  loadClientState: async () => null,
  saveClientState: async () => undefined,
  onPrepareClose: () => () => undefined,
  getActiveSessionId: async () => 'session-a',
  selectAttachmentFiles: async () => null,
  removeAttachment: async () => undefined,
  newSession: async () => 'session-b',
  switchSession: async () => undefined,
  deleteSession: async () => 'session-a',
  runAgentTask: async () => ({ responseText: 'done', traceId: 'trace-a' }),
  cancelTask: async () => undefined,
  onAgentEvent: () => () => undefined,
  decideApproval: async () => undefined,
  revealFile: async () => undefined,
};

function savedConversation(id: string, title: string): ClientStateSnapshot['conversations'][number] {
  return { id, title, titleManuallyRenamed: false, prompt: '', attachments: [],
    messages: [{ id: 1, role: 'user', text: title, attachments: [] }] };
}

// jsdom 不实现布局滚动与顶层浮层；命中区域和关闭行为由真实浏览器测试验证。
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.showPopover = function () { this.style.display = 'block'; };
  HTMLElement.prototype.hidePopover = function () { this.style.display = 'none'; };
});

afterEach(() => cleanup());

/** 产物卡的类型文案是文件名之外的那一行；按卡片定位，避免命中其他轮次的同名文件。 */
function artifactTypeText(fileName: string): string {
  const card = screen.getByText(fileName).closest('.artifact-card');
  return within(card as HTMLElement).getByText(/· 已完成$/).textContent ?? '';
}

describe('shared App', () => {
  it('keeps model selection in the composer when visiting settings without replacing the draft or attachments', async () => {
    let settings = { ...await api.loadRuntimeSettings(), modelProviders: DEFAULT_MODEL_PROVIDERS.map(provider => ({ ...provider, apiKey: { configured: true } })) };
    const save = vi.fn<AgentClientApi['saveRuntimeSettings']>(async update => { settings = { ...settings, conversationModel: update.conversationModel ?? settings.conversationModel }; return settings; });
    render(<App api={{ ...api, loadRuntimeSettings: async () => settings, saveRuntimeSettings: save, selectAttachmentFiles: async () => [{ path: 'D:/draft.mp4', name: 'draft.mp4', role: 'video' }] }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '保留草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '选择输入文件' }));
    await screen.findByLabelText('视频附件：draft.mp4');
    fireEvent.click(await screen.findByRole('button', { name: '选择对话模型：DeepSeek V4 Pro' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek V4.1 Flash/ }));
    await screen.findByRole('button', { name: '选择对话模型：DeepSeek V4.1 Flash' });
    expect(save).toHaveBeenCalledWith({ conversationModel: { providerId: 'deepseek', modelId: 'deepseek-flash' } });
    expect(input).toHaveProperty('value', '保留草稿');
    expect(screen.getByLabelText('视频附件：draft.mp4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '选择对话模型：DeepSeek V4.1 Flash' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '配置自定义模型' }));
    expect(await screen.findByRole('heading', { name: '模型' })).toBeTruthy();
    expect(screen.queryByLabelText('当前对话模型')).toBeNull();
    expect(save).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }));
    fireEvent.click(screen.getByRole('button', { name: '选择对话模型：DeepSeek V4.1 Flash' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /GPT-5.6 Luna/ }));
    await screen.findByRole('button', { name: '选择对话模型：GPT-5.6 Luna' });
    expect(screen.getByLabelText('剪辑需求')).toBe(input);
    expect(input).toHaveProperty('value', '保留草稿');
    expect(screen.getByLabelText('视频附件：draft.mp4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '选择对话模型：GPT-5.6 Luna' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '配置自定义模型' }));
    expect(screen.queryByLabelText('当前对话模型')).toBeNull();
    expect(save).toHaveBeenLastCalledWith({ conversationModel: { providerId: 'openai', modelId: 'gpt-5.6-luna' } });
  });
  it('holds the old model and send action until save completes, and reports a rejected selection', async () => {
    const settings = { ...await api.loadRuntimeSettings(), modelProviders: DEFAULT_MODEL_PROVIDERS.map(provider => ({ ...provider, apiKey: { configured: true } })) };
    let rejectSave!: (error: Error) => void;
    const save = vi.fn<AgentClientApi['saveRuntimeSettings']>(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    const run = vi.fn(api.runAgentTask);
    render(<App api={{ ...api, loadRuntimeSettings: async () => settings, saveRuntimeSettings: save, runAgentTask: run }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '下一条消息' } });
    fireEvent.click(await screen.findByRole('button', { name: '选择对话模型：DeepSeek V4 Pro' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek V4.1 Flash/ }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '发送' })).toHaveProperty('disabled', true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(run).not.toHaveBeenCalled();
    act(() => rejectSave(new Error('配置保存失败')));
    await screen.findByText('配置保存失败');
    expect(screen.getByRole('button', { name: '选择对话模型：DeepSeek V4 Pro' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toHaveProperty('disabled', false));
    expect(input).toHaveProperty('value', '下一条消息');
  });
  it('supports menu keyboard focus and keeps Stop available while saving the next model', async () => {
    const settings = { ...await api.loadRuntimeSettings(), modelProviders: DEFAULT_MODEL_PROVIDERS.map(provider => ({ ...provider, apiKey: { configured: true } })) };
    const cancel = vi.fn(async () => {});
    render(<App api={{ ...api, loadRuntimeSettings: async () => settings, runAgentTask: () => new Promise(() => {}), cancelTask: cancel, saveRuntimeSettings: () => new Promise(() => {}) }} />);
    fireEvent.change(await screen.findByLabelText('剪辑需求'), { target: { value: '当前任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: '停止' });
    const trigger = screen.getByRole('button', { name: '选择对话模型：DeepSeek V4 Pro' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /DeepSeek V4 Pro/ }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /DeepSeek V4.1 Flash/ }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
    expect(trigger).toHaveProperty('ariaExpanded', 'false');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek V4.1 Flash/ }));
    expect(screen.getByRole('button', { name: '停止' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
  it('installs directly from above Settings without a version dialog and displays save failures', async () => {
    const install = vi.fn(async () => { throw new Error('无法保存本地会话：磁盘不可写'); });
    render(<App api={{ ...api, appUpdates: { getState: async () => ({ status: 'ready' }), onStateChanged: () => () => {}, install, retry: async () => {} } }} />);
    const button = await screen.findByRole('button', { name: '安装更新' });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    expect(button.nextElementSibling).toBe(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(button);
    await screen.findByText('无法保存本地会话：磁盘不可写');
    expect(install).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('follows download and readiness events, hides absent updates and unsubscribes', async () => {
    let receive!: (state: AppUpdateState) => void;
    const unsubscribe = vi.fn();
    const view = render(<App api={{ ...api, appUpdates: { getState: async () => ({ status: 'idle' }), onStateChanged: listener => { receive = listener; return unsubscribe; }, install: async () => {}, retry: async () => {} } }} />);
    await screen.findByLabelText('剪辑需求');
    expect(screen.queryByRole('button', { name: '安装更新' })).toBeNull();
    act(() => receive({ status: 'downloading', percent: 45 }));
    expect(screen.getByRole('button', { name: '正在下载更新 45%' })).toHaveProperty('disabled', true);
    act(() => receive({ status: 'ready' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '安装更新' })).toHaveProperty('disabled', false));
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('retries a failed update rather than invoking the installer', async () => {
    const retry = vi.fn(async () => {});
    const install = vi.fn(async () => {});
    render(<App api={{ ...api, appUpdates: { getState: async () => ({ status: 'error', message: '下载失败：HTTP 503' }), onStateChanged: () => () => {}, install, retry } }} />);
    await screen.findByText('下载失败：HTTP 503');
    const button = screen.getByRole('button', { name: '重试更新' });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    fireEvent.click(button);
    await waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(install).not.toHaveBeenCalled();
  });
  it('reuses a pending new-chat draft without adding history or losing its input and attachment', async () => {
    const newSession = vi.fn(api.newSession);
    const saveClientState = vi.fn(api.saveClientState);
    render(<App api={{ ...api, newSession, saveClientState, selectAttachmentFiles: async () => [{ path: 'D:/draft.mp4', name: 'draft.mp4', role: 'video' }] }} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '新会话' })).toHaveProperty('disabled', false));
    const input = screen.getByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '尚未发送的任务' } });
    fireEvent.click(screen.getByRole('button', { name: '选择输入文件' }));
    await screen.findByLabelText('视频附件：draft.mp4');
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: '新会话' }));
    expect(newSession).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.sidebar-session')).toHaveLength(0);
    expect(input).toHaveProperty('value', '尚未发送的任务');
    await waitFor(() => expect(saveClientState.mock.calls.at(-1)?.[0]).toMatchObject({ conversations: [], drafts: [{ id: 'session-a', prompt: '尚未发送的任务', attachments: [{ path: 'D:/draft.mp4' }] }] }));
  });

  it('restores a draft with empty history and promotes it on the first send using the generated title', async () => {
    const state: ClientStateSnapshot = { activeSessionId: 'draft-session', conversations: [], drafts: [{ ...savedConversation('draft-session', '新聊天'), messages: [], prompt: '你好，请帮我删除视频前面的广告，只保留讲解。', attachments: [{ path: 'D:/draft.mp4', name: 'draft.mp4', role: 'video' }] }] };
    const saveClientState = vi.fn(api.saveClientState);
    render(<App api={{ ...api, loadClientState: async () => state, saveClientState,
      runAgentTask: async () => ({ responseText: '处理完成', traceId: 'trace-title', conversationTitle: '删除片头广告' }),
    }} />);
    await screen.findByLabelText('视频附件：draft.mp4');
    expect(document.querySelectorAll('.sidebar-session')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: '删除片头广告' });
    await waitFor(() => expect(saveClientState.mock.calls.at(-1)?.[0]).toMatchObject({ drafts: [], conversations: [{ id: 'draft-session', title: '删除片头广告' }] }));
  });

  it('keeps the successful reply when automatic naming fails and explains how to rename', async () => {
    render(<App api={{ ...api, runAgentTask: async () => ({ responseText: '任务已完成', traceId: 'trace-title-error', conversationTitleError: '服务不可用' }) }} />);
    fireEvent.change(await screen.findByLabelText('剪辑需求'), { target: { value: '检查项目配置' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('任务已完成');
    expect(screen.getByRole('button', { name: '检查项目配置' })).toBeTruthy();
    expect(screen.getByText('自动命名失败：服务不可用。可在会话菜单中重命名。')).toBeTruthy();
  });

  it('sends with Enter but leaves Shift+Enter and IME confirmation to the editor', async () => {
    const runAgentTask = vi.fn(api.runAgentTask);
    render(<App api={{ ...api, runAgentTask }} />);
    await waitFor(() => expect((screen.getByRole('button', { name: '新会话' }) as HTMLButtonElement).disabled).toBe(false));
    const input = screen.getByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '保留精彩片段' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(runAgentTask).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(runAgentTask).toHaveBeenCalledWith('保留精彩片段'));
  });

  it('shows a settings load failure instead of an endless loading label', async () => {
    render(<App api={{ ...api, loadRuntimeSettings: async () => { throw new Error('设置文件无法读取'); } }} />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '设置文件无法读取');
    expect(screen.queryByText('正在加载设置…')).toBeNull();
  });

  it('keeps the composer draft when settings opens and closes', async () => {
    render(<App api={api} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '尚未发送的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: '关闭设置' }));
    expect(screen.getByLabelText('剪辑需求')).toBe(input);
    expect(input).toHaveProperty('value', '尚未发送的草稿');
  });

  it('changes Send to Stop, shows cancelled, and can send again', async () => {
    let rejectRunning: ((reason: Error) => void) | undefined;
    const runAgentTask = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRunning = reject; }))
      .mockResolvedValueOnce({ responseText: '继续正常', traceId: 'trace-next' });
    const cancelTask = vi.fn(async () => {
      rejectRunning?.(new DOMException('The operation was aborted', 'AbortError'));
    });
    render(<App api={{ ...api, runAgentTask, cancelTask }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '长任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));

    await waitFor(() => expect(cancelTask).toHaveBeenCalledOnce());
    expect(await screen.findByText('已停止')).toBeTruthy();
    fireEvent.change(input, { target: { value: '下一条' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('继续正常')).toBeTruthy();
    expect(runAgentTask).toHaveBeenCalledTimes(2);
  });

  it('renders with explicitly supplied host capabilities', async () => {
    render(<App api={api} />);
    expect(await screen.findByText('Agent Desktop')).toBeTruthy();
    expect(screen.getByRole('button', { name: '新会话' })).toBeTruthy();
    expect(screen.queryByText('本地运行')).toBeNull();
  });

  it('saves the appearance preference through the host and restores it on startup', async () => {
    const base = await api.loadRuntimeSettings();
    const saveRuntimeSettings = vi.fn(async () => ({ ...base, theme: 'dark' as const }));
    render(<App api={{ ...api, saveRuntimeSettings }} />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '外观' }));
    fireEvent.click(await screen.findByRole('button', { name: '深色' }));
    expect(screen.queryByRole('button', { name: '保存设置' })).toBeNull();
    await waitFor(() => expect(saveRuntimeSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' })));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    cleanup();
    document.documentElement.dataset.theme = 'light';
    render(<App api={{ ...api, loadRuntimeSettings: async () => ({ ...base, theme: 'dark' }) }} />);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  });

  it('opens extension management from settings and keeps the conversation draft', async () => {
    render(<App api={api} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '跨页面草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '插件与技能' }));
    fireEvent.click(await screen.findByRole('button', { name: '浏览目录' }));
    expect(await screen.findByRole('main', { name: '插件管理' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '对话' }));
    expect(screen.getByLabelText('剪辑需求')).toBe(input);
    expect(input).toHaveProperty('value', '跨页面草稿');
  });

  it('restores the persisted UI snapshot without rebuilding model context in the Client', async () => {
    const restoredState: ClientStateSnapshot = {
      activeSessionId: 'session-b',
      conversations: [
        {
          id: 'session-a',
          title: '历史会话 A',
          titleManuallyRenamed: false,
          prompt: 'A 草稿',
          attachments: [{ path: 'D:\\videos\\a.mp4', name: 'a.mp4', role: 'video' }],
          messages: [{
            id: 1,
            role: 'user',
            text: '用户 A',
            attachments: ['a.mp4'],
          }],
        },
        {
          id: 'session-b',
          title: '历史会话 B',
          titleManuallyRenamed: false,
          prompt: 'B 草稿',
          attachments: [{ path: 'D:\\videos\\b.mp4', name: 'b.mp4', role: 'video' }],
          messages: [{
            id: 2,
            role: 'assistant',
            status: 'completed',
            activityExpanded: false,
            activity: [{
              id: 'call-b',
              kind: 'tool',
              toolName: 'trim_video',
              status: 'completed',
              durationMs: 8,
            }],
            result: {
              responseText: 'Agent B 已完成',
              traceId: 'trace-b',
              outputFiles: [{ path: 'D:/videos/b-edited.mp4', fileName: 'b-edited.mp4' }],
            },
          }],
        },
      ],
    };
    const loadClientState = async () => restoredState;

    render(<App api={{ ...api, loadClientState }} />);

    const activeButton = await screen.findByRole('button', { name: '历史会话 B' });
    expect(activeButton.getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('Agent B 已完成')).toBeTruthy();
    expect(screen.getByText('b-edited.mp4')).toBeTruthy();
    expect(screen.queryByText('trace-b')).toBeNull();
    expect(screen.getByLabelText('视频附件：b.mp4')).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText('剪辑需求') as HTMLTextAreaElement).value).toBe('B 草稿'));

    await screen.findByRole('button', { name: '历史会话 A' });
    expect(screen.getByRole('button', { name: '历史会话 A' })).toBeTruthy();
  });

  it('shows the latest real turn and step counts below the composer', async () => {
    const state: ClientStateSnapshot = {
      activeSessionId: 'session-a',
      conversations: [{
        id: 'session-a', title: '已有任务', titleManuallyRenamed: false, prompt: '', attachments: [],
        messages: [
          { id: 1, role: 'user', text: '处理视频', attachments: [] },
          {
            id: 2, role: 'assistant', activityExpanded: false,
            activity: [
              { id: 'model:step-1', kind: 'analysis', status: 'completed', plannedToolCallCount: 1 },
              { id: 'model:step-2', kind: 'analysis', status: 'completed', plannedToolCallCount: 0 },
            ],
            status: 'completed', result: { responseText: '完成', traceId: 'trace-status' },
          },
        ],
      }],
      drafts: [],
    };
    render(<App api={{ ...api, loadClientState: async () => state }} />);
    const status = await screen.findByLabelText('执行状态');
    expect(status.textContent).toContain('1 轮 2 步');
    expect(status.closest('form')).toBeNull();
  });

  it('renames a session, persists the manual title, and does not replace it after the next prompt', async () => {
    let savedState: ClientStateSnapshot | undefined;
    const runAgentTask = async () => ({ responseText: '完成', traceId: 'trace-rename', conversationTitle: '初始任务' });
    const renameApi: AgentClientApi = {
      ...api,
      runAgentTask,
      saveClientState: async (state) => { savedState = state; },
    };

    render(<App api={renameApi} />);
    fireEvent.change(await screen.findByLabelText('剪辑需求'), { target: { value: '初始任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('完成');
    fireEvent.click(screen.getByRole('button', { name: '会话操作：初始任务' }));
    fireEvent.click(screen.getByRole('button', { name: '重命名' }));
    const titleInput = screen.getByRole('textbox', { name: '会话标题' });
    fireEvent.change(titleInput, { target: { value: '  重要项目  ' } });
    fireEvent.keyDown(titleInput, { key: 'Enter' });

    expect(screen.getByRole('button', { name: '重要项目' })).toBeTruthy();
    await waitFor(() => expect(savedState?.conversations[0]).toMatchObject({
      title: '重要项目',
      titleManuallyRenamed: true,
    }));

    const composer = screen.getByLabelText('剪辑需求');
    fireEvent.change(composer, { target: { value: '下一条任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('完成');
    expect(screen.getByRole('button', { name: '重要项目' })).toBeTruthy();
  });

  it('deletes the active session and uses the Host returned session id for the new empty conversation', async () => {
    const deleteSession = vi.fn(async () => 'session-a');
    const deleteApi: AgentClientApi = {
      ...api,
      newSession: async () => 'session-b',
      deleteSession,
      loadClientState: async () => ({ activeSessionId: 'session-b', conversations: [savedConversation('session-a', '会话 1'), savedConversation('session-b', '会话 2')] }),
    };

    render(<App api={deleteApi} />);
    await screen.findByRole('button', { name: '会话 1' });
    await screen.findByRole('button', { name: '会话 2' });
    fireEvent.click(screen.getByRole('button', { name: '会话操作：会话 2' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '删除会话' }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith('session-b'));
    expect(screen.getByRole('button', { name: '会话 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '会话 1' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('button', { name: '会话 2' })).toBeNull();
    expect(screen.getByRole('main', { name: '对话工作区' })).toBeTruthy();
  });

  it('keeps a failed deletion in the dialog and lets the user cancel without losing the session', async () => {
    const deleteSession = vi.fn(async () => { throw new Error('会话删除失败'); });
    render(<App api={{ ...api, deleteSession, loadClientState: async () => ({ activeSessionId: 'session-a', conversations: [savedConversation('session-a', '会话 1')] }) }} />);
    await screen.findByRole('button', { name: '会话 1' });
    fireEvent.click(screen.getByRole('button', { name: '会话操作：会话 1' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('dialog', { name: '删除 会话 1?' });
    fireEvent.click(within(dialog).getByRole('button', { name: '删除会话' }));
    await within(dialog).findByRole('alert');
    expect(within(dialog).getByRole('alert').textContent).toBe('会话删除失败');
    expect(screen.getByRole('button', { name: '会话 1' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it('keeps history empty and saves the Host replacement as a draft when deleting the last session', async () => {
    const deleteSession = vi.fn(async () => 'host-created-session');
    const newSession = vi.fn(async () => 'unexpected-client-session');
    let persistedState: ClientStateSnapshot | undefined;
    const lastApi: AgentClientApi = {
      ...api,
      deleteSession,
      newSession,
      saveClientState: async (state) => { persistedState = state; },
    };
    const savedState: ClientStateSnapshot = {
      activeSessionId: 'session-a',
      conversations: [{
        id: 'session-a',
        title: '会话 1',
        titleManuallyRenamed: false,
        messages: [],
        prompt: '',
        attachments: [],
      }],
    };

    render(<App api={{ ...lastApi, loadClientState: async () => savedState }} />);
    await screen.findByRole('button', { name: '会话 1' });
    fireEvent.click(screen.getByRole('button', { name: '会话操作：会话 1' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '删除会话' }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith('session-a'));
    expect(newSession).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '会话 1' })).toBeNull();
    expect(screen.getByRole('region', { name: '开始视频任务' })).toBeTruthy();
    await waitFor(() => expect(persistedState).toMatchObject({
      activeSessionId: 'host-created-session',
      conversations: [],
      drafts: [{ id: 'host-created-session' }],
    }));
  });

  it('disables session rename and delete while an Agent turn is processing', async () => {
    let resolveTask: ((result: { responseText: string; traceId: string }) => void) | undefined;
    const processingApi: AgentClientApi = {
      ...api,
      runAgentTask: () => new Promise((resolve) => { resolveTask = resolve; }),
      deleteSession: vi.fn(async () => 'session-a'),
      loadClientState: async () => ({ activeSessionId: 'session-a', conversations: [savedConversation('session-a', '会话 1')] }),
    };

    render(<App api={processingApi} />);
    await screen.findByRole('button', { name: '会话 1' });
    fireEvent.click(screen.getByRole('button', { name: '会话操作：会话 1' }));
    expect(screen.getByRole('button', { name: '重命名' })).toBeTruthy();
    const composer = screen.getByLabelText('剪辑需求');
    fireEvent.change(composer, { target: { value: '执行中任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    const menuButton = screen.getByRole('button', { name: '会话操作：会话 1' });
    expect(menuButton).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: '重命名' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    expect(screen.getByRole('button', { name: '新会话' })).toHaveProperty('disabled', true);
    await act(async () => resolveTask?.({ responseText: '完成', traceId: 'trace-processing' }));
  });

  it('streams assistant text during a turn and replaces it with the final reply', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    const runAgentTask = vi.fn(() => new Promise<AgentTaskResult>((resolve) => {
      resolveTask = resolve;
    }));

    render(<App api={{
      ...api,
      runAgentTask,
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '流式任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(screen.getByText('正在处理任务')).toBeTruthy();

    act(() => receiveEvent?.({ type: 'text.delta', delta: '正在' }));
    expect(screen.getByText('正在')).toBeTruthy();
    expect(screen.queryByText('正在处理任务')).toBeNull();
    act(() => receiveEvent?.({ type: 'text.delta', delta: '生成结果' }));
    expect(screen.getByText('正在生成结果')).toBeTruthy();

    await act(async () => resolveTask?.({ responseText: '最终回复', traceId: 'trace-stream' }));
    expect(await screen.findByText('最终回复')).toBeTruthy();
    expect(screen.queryByText('正在生成结果')).toBeNull();
  });

  it('clears streamed text when the turn is cancelled', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let rejectRunning: ((reason: Error) => void) | undefined;
    const cancelTask = vi.fn(async () => {
      rejectRunning?.(new DOMException('The operation was aborted', 'AbortError'));
    });

    render(<App api={{
      ...api,
      runAgentTask: () => new Promise((_resolve, reject) => { rejectRunning = reject; }),
      cancelTask,
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '长任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({ type: 'text.delta', delta: '半截输出' }));
    expect(screen.getByText('半截输出')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '停止' }));

    expect(await screen.findByText('已停止')).toBeTruthy();
    expect(screen.queryByText('半截输出')).toBeNull();
  });

  it('clears streamed text when the turn fails', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let rejectRunning: ((reason: Error) => void) | undefined;

    render(<App api={{
      ...api,
      runAgentTask: () => new Promise((_resolve, reject) => { rejectRunning = reject; }),
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '会失败的任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({ type: 'text.delta', delta: '半截输出' }));
    expect(screen.getByText('半截输出')).toBeTruthy();

    await act(async () => rejectRunning?.(new Error('处理失败。')));

    expect(await screen.findByText('任务失败')).toBeTruthy();
    expect(screen.queryByText('半截输出')).toBeNull();
  });

  it('keeps already-succeeded artifacts visible when the turn is cancelled', async () => {
    let rejectRunning: ((reason: Error) => void) | undefined;
    const revealFile = vi.fn(async () => undefined);
    const cancelTask = vi.fn(async () => {
      // 宿主在取消时把此前已成功的产物挂在错误上。
      const abortError = new Error('The operation was aborted') as Error & {
        outputFiles?: readonly { readonly path: string; readonly fileName: string }[];
      };
      abortError.name = 'AbortError';
      abortError.outputFiles = [{ path: 'D:/videos/done.mp4', fileName: 'done.mp4' }];
      rejectRunning?.(abortError);
    });

    render(<App api={{
      ...api,
      revealFile,
      runAgentTask: () => new Promise((_resolve, reject) => { rejectRunning = reject; }),
      cancelTask,
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '长任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByRole('button', { name: '停止' }));

    expect(await screen.findByText('已停止')).toBeTruthy();
    // 取消不代表已完成的工作消失：产物卡仍在，且仍能定位到真实路径。
    // 产物卡的按钮文案固定是「打开文件」，文件名只出现在卡片标题里，所以按卡片定位再点按钮。
    const card = screen.getByText('done.mp4').closest('.artifact-card');
    expect(card).not.toBeNull();
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '打开文件' }));
    await vi.waitFor(() => expect(revealFile).toHaveBeenCalledWith('D:/videos/done.mp4'));
  });

  it('keeps already-succeeded artifacts visible when the turn fails', async () => {
    let rejectRunning: ((reason: Error) => void) | undefined;
    const revealFile = vi.fn(async () => undefined);

    render(<App api={{
      ...api,
      revealFile,
      runAgentTask: () => new Promise((_resolve, reject) => { rejectRunning = reject; }),
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '会失败的任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await act(async () => {
      const failure = new Error('第二个工具执行失败。') as Error & {
        outputFiles?: readonly { readonly path: string; readonly fileName: string }[];
      };
      failure.outputFiles = [{ path: 'D:/videos/part1.mp4', fileName: 'part1.mp4' }];
      rejectRunning?.(failure);
    });

    expect(await screen.findByText('任务失败')).toBeTruthy();
    expect(screen.getByText('第二个工具执行失败。')).toBeTruthy();
    // 整轮失败与「此前已有成功文件」同时成立。
    const card = screen.getByText('part1.mp4').closest('.artifact-card');
    expect(card).not.toBeNull();
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '打开文件' }));
    await vi.waitFor(() => expect(revealFile).toHaveBeenCalledWith('D:/videos/part1.mp4'));
  });

  it('shows the real artifact reveal failure inside the artifact card', async () => {
    const revealFile = vi.fn(async () => {
      throw new Error('文件不存在或已被移动：D:/videos/missing.mp4');
    });
    render(<App api={{
      ...api,
      revealFile,
      runAgentTask: async () => ({
        responseText: '已完成',
        traceId: 'trace-missing',
        outputFiles: [{ path: 'D:/videos/missing.mp4', fileName: 'missing.mp4' }],
      }),
    }} />);

    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '生成文件' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    const card = (await screen.findByText('missing.mp4')).closest('.artifact-card');
    expect(card).not.toBeNull();
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '打开文件' }));

    expect(await within(card as HTMLElement).findByText('文件不存在或已被移动：D:/videos/missing.mp4'))
      .toBeTruthy();
  });

  it('shows the host reveal message verbatim in the activity row', async () => {
    const missingPath = 'D:\\work\\notes-moved.txt';
    const revealFile = vi.fn(async () => {
      // 宿主边界（Desktop Preload）已经剥离 Electron 的 invoke 包装，界面只转发真实原因。
      throw new Error(`文件不存在或已被移动：${missingPath}`);
    });
    render(<App api={{
      ...api,
      revealFile,
      loadClientState: async () => ({
        activeSessionId: 'session-a',
        conversations: [{
          id: 'session-a',
          title: '会话 1',
          titleManuallyRenamed: false,
          prompt: '',
          attachments: [],
          messages: [{
            id: 1,
            role: 'assistant',
            status: 'completed',
            activityExpanded: true,
            activity: [{
              id: 'call-moved',
              kind: 'tool',
              toolName: 'write_text_file',
              status: 'completed',
              files: [{ path: missingPath, label: 'notes-moved.txt', role: 'output' }],
            }],
            result: { responseText: '已创建文件', traceId: 'trace-moved' },
          }],
        }],
      }),
    }} />);

    fireEvent.click(await screen.findByRole('button', { name: `定位文件：${missingPath}` }));

    // 活动行只显示宿主的可操作消息，不出现 Electron IPC 的技术包装。
    const inlineError = await screen.findByText(`文件不存在或已被移动：${missingPath}`);
    expect(inlineError.closest('.activity-file-error')).not.toBeNull();
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
  });

  it('shows the real artifact type for video, subtitle, text and unknown files', async () => {
    const revealFile = vi.fn(async () => undefined);
    render(<App api={{
      ...api,
      revealFile,
      runAgentTask: async () => ({
        responseText: '已完成',
        traceId: 'trace-artifact-kinds',
        outputFiles: [
          { path: 'D:/videos/edited.mp4', fileName: 'edited.mp4' },
          { path: 'D:/work/subtitle-test.srt', fileName: 'subtitle-test.srt' },
          { path: 'D:/work/notes.txt', fileName: 'notes.txt' },
          { path: 'D:/work/notes.md', fileName: 'notes.md' },
          { path: 'D:/work/NOTES.TXT', fileName: 'NOTES.TXT' },
          { path: 'D:/work/archive.zip', fileName: 'archive.zip' },
        ],
      }),
    }} />);

    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '生成文件和字幕' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    // 类型文案是用户可见事实：非视频产物不能显示成「视频」。
    expect(await screen.findByText('edited.mp4')).toBeTruthy();
    expect(artifactTypeText('edited.mp4')).toBe('视频 · 已完成');
    expect(artifactTypeText('subtitle-test.srt')).toBe('字幕 · 已完成');
    expect(artifactTypeText('notes.txt')).toBe('文本 · 已完成');
    expect(artifactTypeText('notes.md')).toBe('文本 · 已完成');
    expect(artifactTypeText('NOTES.TXT')).toBe('文本 · 已完成');
    expect(artifactTypeText('archive.zip')).toBe('文件 · 已完成');

    // 类型改变不影响打开动作：非视频产物仍定位到自己的真实路径。
    const textCard = screen.getByText('notes.txt').closest('.artifact-card');
    expect(textCard).not.toBeNull();
    fireEvent.click(within(textCard as HTMLElement).getByRole('button', { name: '打开文件' }));
    await vi.waitFor(() => expect(revealFile).toHaveBeenCalledWith('D:/work/notes.txt'));
  });

  it('applies streamed text only to the assistant reply that is processing', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveFirst: ((result: AgentTaskResult) => void) | undefined;
    let resolveSecond: ((result: AgentTaskResult) => void) | undefined;
    const runAgentTask = vi.fn()
      .mockImplementationOnce(() => new Promise<AgentTaskResult>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<AgentTaskResult>((resolve) => { resolveSecond = resolve; }));

    render(<App api={{
      ...api,
      runAgentTask,
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '第一轮' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({ type: 'text.delta', delta: '第一轮增量' }));
    await act(async () => resolveFirst?.({ responseText: '第一轮完成', traceId: 'trace-1' }));
    expect(await screen.findByText('第一轮完成')).toBeTruthy();

    fireEvent.change(input, { target: { value: '第二轮' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({ type: 'text.delta', delta: '第二轮增量' }));

    expect(screen.getByText('第二轮增量')).toBeTruthy();
    // 已完成的上一轮回复不能被新增量污染。
    expect(screen.getByText('第一轮完成')).toBeTruthy();
    expect(screen.queryByText('第一轮增量')).toBeNull();
    await act(async () => resolveSecond?.({ responseText: '第二轮完成', traceId: 'trace-2' }));
  });

  it('never persists temporary streamed text in the saved snapshot', async () => {    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    let savedState: ClientStateSnapshot | undefined;

    render(<App api={{
      ...api,
      runAgentTask: () => new Promise<AgentTaskResult>((resolve) => { resolveTask = resolve; }),
      saveClientState: async (state) => { savedState = state; },
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '流式快照任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({ type: 'text.delta', delta: '临时流式片段' }));
    expect(screen.getByText('临时流式片段')).toBeTruthy();

    await act(async () => resolveTask?.({ responseText: '最终回复', traceId: 'trace-snapshot' }));
    await screen.findByText('最终回复');

    await waitFor(() => expect(savedState?.conversations[0]?.messages.at(-1)).toMatchObject({
      status: 'completed',
      result: { responseText: '最终回复' },
    }));
    expect(JSON.stringify(savedState)).not.toContain('临时流式片段');
  });

  it('submits the pending draft immediately when the host prepares to close', async () => {
    let prepareClose: (() => Promise<void>) | undefined;
    const saved: ClientStateSnapshot[] = [];
    render(<App api={{
      ...api,
      saveClientState: async (state) => { saved.push(state); },
      onPrepareClose: (listener) => {
        prepareClose = listener;
        return () => undefined;
      },
    }} />);

    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '关闭前的草稿' } });

    // 防抖保存还没到期，宿主关闭时也要立即提交这一份草稿。
    const flush = prepareClose!();
    await act(async () => { await Promise.resolve(); });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.drafts?.[0]?.prompt).toBe('关闭前的草稿');
    await flush;
  });

  it('does not schedule a second save while the host is closing', async () => {
    let prepareClose: (() => Promise<void>) | undefined;
    const saved: ClientStateSnapshot[] = [];
    render(<App api={{
      ...api,
      saveClientState: async (state) => { saved.push(state); },
      onPrepareClose: (listener) => {
        prepareClose = listener;
        return () => undefined;
      },
    }} />);

    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '关闭中的草稿' } });

    const flush = prepareClose!();
    await act(async () => { await Promise.resolve(); });
    await flush;
    expect(saved).toHaveLength(1);

    // 关闭请求会取消尚未触发的防抖保存，避免关闭过程中重复写入同一份状态。
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 250); }); });
    expect(saved).toHaveLength(1);
  });

  it('waits for an in-flight save before writing the final closing snapshot', async () => {
    let prepareClose: (() => Promise<void>) | undefined;
    let resolveFirstSave: (() => void) | undefined;
    const saved: ClientStateSnapshot[] = [];
    render(<App api={{
      ...api,
      saveClientState: async (state) => {
        saved.push(state);
        if (saved.length === 1) {
          await new Promise<void>((resolve) => { resolveFirstSave = resolve; });
        }
      },
      onPrepareClose: (listener) => {
        prepareClose = listener;
        return () => undefined;
      },
    }} />);

    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '普通保存中的草稿' } });
    await waitFor(() => expect(saved).toHaveLength(1));

    fireEvent.change(input, { target: { value: '关闭时的最终草稿' } });
    let closeSettled = false;
    const flush = prepareClose!().then(() => { closeSettled = true; });
    await act(async () => { await Promise.resolve(); });

    // 前一份快照尚未写完时，关闭快照必须排队，不能并发占用同一个临时文件。
    expect(saved).toHaveLength(1);
    expect(closeSettled).toBe(false);

    await act(async () => { resolveFirstSave?.(); });
    await flush;
    expect(saved).toHaveLength(2);
    expect(saved[1]?.drafts?.[0]?.prompt).toBe('关闭时的最终草稿');
  });

  it('waits for the running turn to settle before submitting the closing state', async () => {
    let prepareClose: (() => Promise<void>) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    const saved: ClientStateSnapshot[] = [];
    render(<App api={{
      ...api,
      runAgentTask: () => new Promise<AgentTaskResult>((resolve) => { resolveTask = resolve; }),
      saveClientState: async (state) => { saved.push(state); },
      onPrepareClose: (listener) => {
        prepareClose = listener;
        return () => undefined;
      },
    }} />);

    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '关闭时的长任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    let settled = false;
    const flush = prepareClose!().then(() => { settled = true; });
    await act(async () => { await Promise.resolve(); });
    // 轮次仍在执行：既不提交临时流式状态，也不提前放行关闭。
    expect(saved.every((state) => !JSON.stringify(state).includes('"processing"'))).toBe(true);
    expect(settled).toBe(false);

    await act(async () => { resolveTask?.({ responseText: '完成', traceId: 'trace-close' }); });
    await act(async () => { await Promise.resolve(); });
    expect(settled).toBe(true);
    expect(saved.at(-1)?.conversations[0]?.messages.at(-1)).toMatchObject({ status: 'completed' });
    await flush;
  });

  it('renders the Agent reply as formatted text, code and links instead of raw Markdown', async () => {
    const reply = [
      '已完成 **两段剪辑**，输出到 `E:/videos/out.mp4`：',
      '',
      '- 第一段 00:12 → 00:48',
      '- 第二段 01:20 → 02:05',
      '',
      '```bash',
      'ffmpeg -i "E:/videos/长文件名-示例-第一版.mp4" -vf crop=1280:720:0:0 -c:v libx264 E:/videos/out.mp4',
      '```',
      '',
      '细节见 [剪辑报告](https://example.com/report)。',
    ].join('\n');
    const runAgentTask = async () => ({ responseText: reply, traceId: 'trace-markdown' });

    render(<App api={{ ...api, runAgentTask }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '剪两段' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    // 列表按真实条目拆分，代码块保留原始命令，行内代码和链接去掉标记后仍然是可读文本。
    const items = await screen.findAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      '第一段 00:12 → 00:48',
      '第二段 01:20 → 02:05',
    ]);
    expect(screen.getByText(/^ffmpeg -i/)).toBeTruthy();
    expect(screen.getByText('E:/videos/out.mp4')).toBeTruthy();
    expect(screen.getByRole('link', { name: '剪辑报告' }).getAttribute('href')).toBe('https://example.com/report');
    expect(screen.getByText('两段剪辑')).toBeTruthy();

    // 未支持的语法标记不得留在正文里。
    expect(screen.queryByText(/\*\*/)).toBeNull();
    expect(screen.queryByText(/`E:\/videos\/out\.mp4`/)).toBeNull();
    expect(screen.queryByText(/\[剪辑报告\]/)).toBeNull();
  });

  it('keeps a non-web link literal instead of handing it to the host', async () => {
    const runAgentTask = async () => ({
      responseText: '按 [打开设置](javascript:void) 处理。',
      traceId: 'trace-unsafe-link',
    });

    render(<App api={{ ...api, runAgentTask }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '危险链接' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await screen.findByText('按 [打开设置](javascript:void) 处理。');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('formats streamed increments with the same inline syntax as the final reply', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;

    render(<App api={{
      ...api,
      runAgentTask: () => new Promise<AgentTaskResult>((resolve) => { resolveTask = resolve; }),
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '流式格式' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    act(() => receiveEvent?.({ type: 'text.delta', delta: '正在读取 `E:/videos/a.mp4`' }));
    expect(screen.getByText('E:/videos/a.mp4')).toBeTruthy();
    expect(screen.queryByText(/`E:\/videos\/a\.mp4`/)).toBeNull();

    await act(async () => resolveTask?.({ responseText: '读取完成', traceId: 'trace-inline' }));
    expect(await screen.findByText('读取完成')).toBeTruthy();
  });

  it('keeps every session draft and attachment and reuses the same composer node when switching', async () => {
    const switchApi: AgentClientApi = {
      ...api,
      loadClientState: async () => ({ activeSessionId: 'session-a', conversations: [savedConversation('session-a', '会话 1'), savedConversation('session-b', '会话 2')] }),
      selectAttachmentFiles: async () => [
        { path: 'D:\\videos\\a.mp4', name: 'a.mp4', role: 'video' },
      ],
    };

    render(<App api={switchApi} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '会话一草稿' } });

    fireEvent.click(await screen.findByRole('button', { name: '会话 2' }));
    await screen.findByRole('button', { name: '会话 2' });
    expect((screen.getByLabelText('剪辑需求') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('剪辑需求'), { target: { value: '会话二草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '选择输入文件' }));
    await screen.findByLabelText('视频附件：a.mp4');

    // 切回第一个会话：草稿和附件各自恢复，且输入节点没有被重建。
    fireEvent.click(screen.getByRole('button', { name: '会话 1' }));
    await waitFor(() => expect((screen.getByLabelText('剪辑需求') as HTMLTextAreaElement).value).toBe('会话一草稿'));
    expect(screen.getByLabelText('剪辑需求')).toBe(input);
    expect(screen.queryByLabelText('视频附件：a.mp4')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '会话 2' }));
    await waitFor(() => expect((screen.getByLabelText('剪辑需求') as HTMLTextAreaElement).value).toBe('会话二草稿'));
    expect(screen.getByLabelText('视频附件：a.mp4')).toBeTruthy();
    expect(screen.getByLabelText('剪辑需求')).toBe(input);
  });

  it('asks for approval with the exact host directory and only then shows it as the working directory', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    const decideApproval = vi.fn(async () => undefined);

    render(<App api={{
      ...api,
      runAgentTask: () => new Promise<AgentTaskResult>((resolve) => { resolveTask = resolve; }),
      decideApproval,
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '列出这个目录的 MP4' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    act(() => receiveEvent?.({
      type: 'approval.requested',
      request: { requestId: 'request-1', kind: 'directory', target: 'D:/videos' },
    }));
    // 界面只展示宿主给出的确切目录，不提供修改入口。
    expect(screen.getByText('D:/videos')).toBeTruthy();
    expect(screen.getByRole('button', { name: '允许' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy();
    // 用户还没有答复时，目录不算已经可用。
    expect(screen.queryByText('工作目录')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith('request-1', true));
    // 提交决定本身还不算确认：宿主真的执行了 confirmDirectory 之后才发布目录事实。
    expect(screen.queryByText('工作目录')).toBeNull();
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull();

    act(() => receiveEvent?.({ type: 'workspace.confirmed', workingDirectory: 'D:/videos' }));
    expect(await screen.findByText('videos')).toBeTruthy();
    expect(screen.queryByText('D:/videos')).toBeNull();
    const directoryButton = screen.getByLabelText('项目目录：videos');
    expect(directoryButton.getAttribute('title')).toBe('D:/videos');
    expect(directoryButton.closest('form')).toBeNull();

    await act(async () => resolveTask?.({ responseText: '完成', traceId: 'trace-approval' }));
    expect(await screen.findByText('完成')).toBeTruthy();
  });

  it('does not treat a refused directory as usable', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    const decideApproval = vi.fn(async () => undefined);

    render(<App api={{
      ...api,
      runAgentTask: () => new Promise<AgentTaskResult>((resolve) => { resolveTask = resolve; }),
      decideApproval,
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '使用这个目录' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({
      type: 'approval.requested',
      request: { requestId: 'request-2', kind: 'directory', target: 'D:/private' },
    }));

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith('request-2', false));
    // 拒绝不产生目录事实，界面也不出现工作目录。
    expect(screen.queryByText('工作目录')).toBeNull();

    await act(async () => resolveTask?.({ responseText: '未执行', traceId: 'trace-refused' }));
    expect(await screen.findByText('未执行')).toBeTruthy();
  });

  it('drops a pending approval once the turn ends so a stale card cannot be answered', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;

    render(<App api={{
      ...api,
      runAgentTask: () => new Promise<AgentTaskResult>((resolve) => { resolveTask = resolve; }),
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '取消中的审批' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({
      type: 'approval.requested',
      request: { requestId: 'request-3', kind: 'directory', target: 'D:/videos' },
    }));
    expect(screen.getByRole('button', { name: '允许' })).toBeTruthy();

    await act(async () => resolveTask?.({ responseText: '完成', traceId: 'trace-dropped' }));

    expect(await screen.findByText('完成')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
    expect(screen.queryByText('D:/videos')).toBeNull();
  });

  it('asks a different question for a file creation and does not treat it as a working directory', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    const decideApproval = vi.fn(async () => undefined);

    render(<App api={{
      ...api,
      runAgentTask: () => new Promise<AgentTaskResult>((resolve) => { resolveTask = resolve; }),
      decideApproval,
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '写一份剪辑清单' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({
      type: 'approval.requested',
      request: { requestId: 'request-file', kind: 'create-file', target: 'D:/videos/清单.txt' },
    }));

    // 问话必须和真正要执行的操作一致：创建文件和访问目录不是同一件事。
    expect(screen.getByText('允许 Agent 创建这个文件吗？')).toBeTruthy();
    expect(screen.getByText('D:/videos/清单.txt')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith('request-file', true));
    // 批准一次文件创建不改变会话工作目录。
    expect(screen.queryByText('工作目录')).toBeNull();

    await act(async () => resolveTask?.({ responseText: '已创建', traceId: 'trace-file' }));
    expect(await screen.findByText('已创建')).toBeTruthy();
  });

  it('shows the exact text replacement before approving a file edit', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    const decideApproval = vi.fn(async () => undefined);

    render(<App api={{
      ...api,
      runAgentTask: () => new Promise<AgentTaskResult>((resolve) => { resolveTask = resolve; }),
      decideApproval,
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '修改字幕' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({
      type: 'approval.requested',
      request: {
        requestId: 'request-edit',
        kind: 'edit-file',
        target: 'D:/videos/字幕.srt',
        before: '旧台词',
        after: '新台词',
      },
    }));

    expect(screen.getByText('允许 Agent 修改这个文件吗？')).toBeTruthy();
    expect(screen.getByText('D:/videos/字幕.srt')).toBeTruthy();
    expect(screen.getByText('原内容')).toBeTruthy();
    expect(screen.getByText('旧台词')).toBeTruthy();
    expect(screen.getByText('新内容')).toBeTruthy();
    expect(screen.getByText('新台词')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith('request-edit', true));
    expect(screen.queryByText('工作目录')).toBeNull();

    await act(async () => resolveTask?.({ responseText: '已修改', traceId: 'trace-edit' }));
    expect(await screen.findByText('已修改')).toBeTruthy();
  });

  it('keeps history position stable while showing approval above the composer', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    const rendered = render(<App api={{
      ...api,
      runAgentTask: () => new Promise<AgentTaskResult>((resolve) => { resolveTask = resolve; }),
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const history = rendered.container.querySelector<HTMLDivElement>('.conversation-history')!;
    let scrollHeight = 400;
    let scrollTop = 0;
    Object.defineProperties(history, {
      clientHeight: { configurable: true, get: () => 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
    });

    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '创建文件' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(scrollTop).toBe(400));

    // 审批卡属于 Composer，不进入历史阅读轴；历史位置不因审批出现而变化。
    scrollHeight = 620;
    act(() => receiveEvent?.({
      type: 'approval.requested',
      request: { requestId: 'request-scroll', kind: 'create-file', target: 'D:/videos/清单.txt' },
    }));
    await waitFor(() => expect(scrollTop).toBe(400));
    expect(rendered.container.querySelector('.composer-stack .approval-request')).not.toBeNull();

    await act(async () => resolveTask?.({ responseText: '已停止', traceId: 'trace-scroll' }));
  });

  it('keeps the conversation usable when the host rejects a late approval decision', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    const decideApproval = vi.fn(async () => {
      throw new Error("Error invoking remote method 'desktop:decide-approval': Error: 该审批请求已失效。");
    });

    render(<App api={{
      ...api,
      runAgentTask: () => new Promise<AgentTaskResult>((resolve) => { resolveTask = resolve; }),
      decideApproval,
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '迟到的批准' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({
      type: 'approval.requested',
      request: { requestId: 'request-4', kind: 'directory', target: 'D:/videos' },
    }));

    // 轮次恰好先结束时宿主会拒绝这次决定；界面不应因此崩溃或卡住。
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledOnce());
    // 决定失效意味着宿主没有执行 confirmDirectory：界面不能留下一个并未确认的工作目录。
    expect(screen.queryByText('工作目录')).toBeNull();
    expect(screen.queryByText('D:/videos')).toBeNull();

    await act(async () => resolveTask?.({ responseText: '完成', traceId: 'trace-late' }));
    expect(await screen.findByText('完成')).toBeTruthy();
    // 轮次结束后仍然不能凭空出现工作目录。
    expect(screen.queryByText('工作目录')).toBeNull();
  });

  it('shows the working directory only after the host publishes the confirmed fact', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    const decideApproval = vi.fn(async () => undefined);

    render(<App api={{
      ...api,
      runAgentTask: () => new Promise<AgentTaskResult>((resolve) => { resolveTask = resolve; }),
      decideApproval,
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    }} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '把 D:/videos 设为工作目录' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({
      type: 'approval.requested',
      request: { requestId: 'request-ws', kind: 'directory', target: 'D:/videos' },
    }));

    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith('request-ws', true));
    // 提交决定本身不改变界面：目录事实由宿主在确认之后发布。
    expect(screen.queryByText('工作目录')).toBeNull();

    act(() => receiveEvent?.({ type: 'workspace.confirmed', workingDirectory: 'D:/videos' }));
    expect(await screen.findByText('videos')).toBeTruthy();
    expect(screen.queryByText('D:/videos')).toBeNull();

    await act(async () => resolveTask?.({ responseText: '完成', traceId: 'trace-ws' }));
  });
  it('creates a project session with its directory and moves existing chats without changing their working directory', async () => {
    const saved: ClientStateSnapshot = { activeSessionId: 'session-a', conversations: [{
      id: 'session-a', title: '已有聊天', titleManuallyRenamed: true, messages: [], prompt: '原草稿', attachments: [], workingDirectory: 'D:/old',
    }] };
    const saveClientState = vi.fn(api.saveClientState);
    const newSession = vi.fn(async () => 'session-b');
    render(<App api={{ ...api, loadClientState: async () => saved, selectProjectDirectory: async () => 'D:/projects/demo', newSession, saveClientState }} />);
    await screen.findByRole('button', { name: '已有聊天' });
    fireEvent.click(screen.getByRole('button', { name: '添加项目' }));
    fireEvent.click(await screen.findByRole('button', { name: '在 demo 中新建会话' }));
    await waitFor(() => expect(newSession).toHaveBeenCalledWith('D:/projects/demo'));
    await waitFor(() => expect(screen.getByLabelText('项目目录：demo').getAttribute('title')).toBe('D:/projects/demo'));
    fireEvent.click(screen.getByRole('button', { name: '会话操作：已有聊天' }));
    fireEvent.click(screen.getByRole('button', { name: /移到项目/ }));
    fireEvent.click(screen.getByRole('button', { name: 'demo' }));
    await waitFor(() => {
      const snapshot = saveClientState.mock.calls.at(-1)?.[0];
      expect(snapshot?.conversations.find(item => item.id === 'session-a')).toMatchObject({ projectId: snapshot?.sidebar?.projects[0]?.id, workingDirectory: 'D:/old', prompt: '原草稿' });
      expect(snapshot?.drafts?.find(item => item.id === 'session-b')).toMatchObject({ workingDirectory: 'D:/projects/demo' });
    });
    fireEvent.click(screen.getByRole('button', { name: '项目操作：demo' }));
    fireEvent.click(screen.getByRole('button', { name: '移除项目' }));
    fireEvent.click(screen.getByRole('button', { name: '移除项目' }));
    await waitFor(() => {
      const snapshot = saveClientState.mock.calls.at(-1)?.[0];
      expect(snapshot?.sidebar?.projects).toEqual([]);
      expect(snapshot?.conversations).toHaveLength(1);
      expect(snapshot?.drafts).toHaveLength(1);
      expect(snapshot?.conversations[0]?.workingDirectory).toBe('D:/old');
      expect(snapshot?.conversations.every(item => item.projectId === undefined)).toBe(true);
      expect(snapshot?.drafts?.every(item => item.projectId === undefined)).toBe(true);
    });
    fireEvent.change(screen.getByLabelText('剪辑需求'), { target: { value: '保留项目草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '添加项目' }));
    fireEvent.click(await screen.findByRole('button', { name: '在 demo 中新建会话' }));
    await waitFor(() => {
      const snapshot = saveClientState.mock.calls.at(-1)?.[0];
      expect(snapshot?.drafts?.[0]).toMatchObject({ id: 'session-b', prompt: '保留项目草稿', projectId: snapshot?.sidebar?.projects[0]?.id, workingDirectory: 'D:/projects/demo' });
    });
    expect(newSession).toHaveBeenCalledTimes(1);
  });

  it('renders the composer project menu from persisted projects and supports leaving the project', async () => {
    const state: ClientStateSnapshot = {
      activeSessionId: 'session-a',
      conversations: [{
        id: 'session-a', title: '项目聊天', titleManuallyRenamed: true, messages: [], prompt: '', attachments: [],
        projectId: 'project-frontend', workingDirectory: 'D:/projects/frontend',
      }],
      drafts: [],
      sidebar: {
        projects: [
          { id: 'project-frontend', name: 'frontend', directory: 'D:/projects/frontend', pinned: false, collapsed: false },
          { id: 'project-atlas', name: 'atlas', directory: 'D:/projects/atlas', pinned: false, collapsed: false },
        ],
        projectsCollapsed: false, recentCollapsed: false, grouped: true,
      },
    };
    const newSession = vi.fn(async (directory?: string) => directory === 'D:/projects/atlas' ? 'session-atlas' : 'session-plain');
    render(<App api={{ ...api, loadClientState: async () => state, newSession }} />);

    const directoryButton = await screen.findByRole('button', { name: '项目目录：frontend' });
    expect(directoryButton.getAttribute('title')).toBe('D:/projects/frontend');
    fireEvent.click(directoryButton);
    const menu = document.querySelector('.composer-project-menu') as HTMLElement;
    expect(within(menu).getByRole('button', { name: 'frontend' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(menu).getByRole('button', { name: 'atlas' }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(within(menu).getByRole('button', { name: 'atlas' }));
    await waitFor(() => expect(newSession).toHaveBeenCalledWith('D:/projects/atlas'));
    await waitFor(() => expect(screen.getByRole('button', { name: '项目目录：atlas' }).getAttribute('title')).toBe('D:/projects/atlas'));

    fireEvent.click(screen.getByRole('button', { name: '项目目录：atlas' }));
    const openMenu = document.querySelector('.composer-project-menu') as HTMLElement;
    fireEvent.click(within(openMenu).getByRole('button', { name: '不在项目中工作' }));
    await waitFor(() => expect(newSession).toHaveBeenCalledTimes(2));
    expect(newSession.mock.calls.at(-1)).toEqual([]);
    expect(screen.getByRole('button', { name: '选择项目目录' })).toBeTruthy();
  });

  it('archives the last visible chat, preserves its draft, and requires restoration before continuing', async () => {
    const saved: ClientStateSnapshot = { activeSessionId: 'session-a', conversations: [{
      id: 'session-a', title: '待归档', titleManuallyRenamed: true, messages: [], prompt: '保留草稿', attachments: [],
    }] };
    const saveClientState = vi.fn(api.saveClientState);
    render(<App api={{ ...api, loadClientState: async () => saved, saveClientState }} />);
    fireEvent.click(await screen.findByRole('button', { name: '归档：待归档' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '待归档' })).toBeNull());
    expect(screen.queryByRole('button', { name: '查看已归档' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: '已归档的对话' }));
    fireEvent.click(screen.getByRole('button', { name: '待归档' }));
    await waitFor(() => expect(screen.getByLabelText('剪辑需求')).toHaveProperty('disabled', true));
    expect(screen.getByLabelText('剪辑需求')).toHaveProperty('value', '保留草稿');
    fireEvent.click(screen.getByRole('button', { name: '恢复会话' }));
    await waitFor(() => expect(screen.getByLabelText('剪辑需求')).toHaveProperty('disabled', false));
    await waitFor(() => expect(saveClientState.mock.calls.at(-1)?.[0].conversations.find(item => item.id === 'session-a')).toMatchObject({ archived: false, prompt: '保留草稿' }));
  });

  it('deletes archived chats from settings through the shared confirmation and preserves them on host failure', async () => {
    const state: ClientStateSnapshot = { activeSessionId: 'session-a', conversations: [savedConversation('session-a', '当前任务'), { ...savedConversation('archived-session', '待删归档'), archived: true }] };
    const deleteSession = vi.fn().mockRejectedValueOnce(new Error('数据库写入失败')).mockResolvedValue('session-a');
    const saveClientState = vi.fn(api.saveClientState);
    render(<App api={{ ...api, loadClientState: async () => state, deleteSession, saveClientState }} />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '已归档的对话' }));
    fireEvent.click(screen.getByRole('button', { name: '删除对话：待删归档' }));
    expect(screen.getByRole('button', { name: '取消' })).toBe(document.activeElement);
    fireEvent.click(screen.getByRole('button', { name: '删除会话' }));
    expect(await screen.findByText('数据库写入失败')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByRole('button', { name: '待删归档' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除对话：待删归档' }));
    fireEvent.click(screen.getByRole('button', { name: '删除会话' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('没有已归档的对话。')).toBeTruthy();
    expect(deleteSession).toHaveBeenLastCalledWith('archived-session');
    await waitFor(() => expect(saveClientState.mock.calls.at(-1)?.[0].conversations.map(item => item.id)).toEqual(['session-a']));
  });

  it('orders recent chats by updates with pins first and persists grouping and collapse independently of chat visits', async () => {
    const saved: ClientStateSnapshot = { activeSessionId: 'session-a', conversations: [
      { id: 'session-a', title: '较旧', titleManuallyRenamed: true, messages: [], prompt: '', attachments: [], updatedAt: 100 },
      { id: 'session-b', title: '较新', titleManuallyRenamed: true, messages: [], prompt: '', attachments: [], updatedAt: 200 },
    ] };
    const saveClientState = vi.fn(api.saveClientState);
    render(<App api={{ ...api, loadClientState: async () => saved, saveClientState }} />);
    const titles = () => Array.from(document.querySelectorAll('.sidebar-session')).map(button => button.getAttribute('aria-label'));
    await waitFor(() => expect(titles()).toEqual(['较新', '较旧']));
    fireEvent.click(screen.getByRole('button', { name: '较新' }));
    fireEvent.click(screen.getByRole('button', { name: '较旧' }));
    await waitFor(() => expect(titles()).toEqual(['较新', '较旧']));
    fireEvent.click(screen.getByRole('button', { name: '置顶：较旧' }));
    expect(titles()).toEqual(['较旧', '较新']);
    fireEvent.click(screen.getByRole('button', { name: '折叠最近会话' }));
    fireEvent.click(screen.getByRole('button', { name: '项目侧栏选项' }));
    fireEvent.click(screen.getByRole('button', { name: '合并显示' }));
    await waitFor(() => {
      const snapshot = saveClientState.mock.calls.at(-1)?.[0];
      expect(snapshot?.sidebar).toMatchObject({ recentCollapsed: true, grouped: false });
      expect(snapshot?.conversations[0]).toMatchObject({ pinned: true, updatedAt: 100 });
    });
  });

});
