// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/index.js';
import type { AgentClientApi, AgentRuntimeEvent, AgentTaskResult, ClientStateSnapshot } from '../src/index.js';

const api: AgentClientApi = {
  loadRuntimeSettings: async () => ({
    deepSeek: { apiKey: { configured: false }, baseUrl: '', model: '' },
    vision: { apiKey: { configured: false }, baseUrl: '' },
    whisper: { modelPath: '', cliPath: '' },
  }),
  saveRuntimeSettings: async () => ({
    deepSeek: { apiKey: { configured: false }, baseUrl: '', model: '' },
    vision: { apiKey: { configured: false }, baseUrl: '' },
    whisper: { modelPath: '', cliPath: '' },
  }),
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
  revealFile: async () => undefined,
};

// jsdom 不实现布局滚动与顶层浮层；命中区域和关闭行为由真实浏览器测试验证。
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.showPopover = function () { this.style.display = 'block'; };
});

afterEach(() => cleanup());

describe('shared App', () => {
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

  it('loads and saves runtime settings without receiving or echoing saved API keys', async () => {
    const saveRuntimeSettings = vi.fn(async (_update: Parameters<AgentClientApi['saveRuntimeSettings']>[0]) => ({
      deepSeek: {
        apiKey: { configured: true as const, source: 'saved' as const },
        baseUrl: 'https://deepseek.saved.test',
        model: 'runtime-model',
      },
      vision: {
        apiKey: { configured: true as const, source: 'environment' as const },
        baseUrl: 'https://vision.saved.test/v1',
      },
      whisper: { modelPath: 'D:\\models\\whisper.bin', cliPath: 'whisper-cli.exe' },
    }));
    render(<App api={{ ...api, saveRuntimeSettings }} />);

    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    const deepSeekKey = (await screen.findAllByLabelText('接口密钥', { selector: 'input' }))[0]!;
    expect((deepSeekKey as HTMLInputElement).value).toBe('');
    expect(screen.getAllByText('未配置')).toHaveLength(2);
    expect(screen.getByText('通过系统环境变量查找视频处理程序')).toBeTruthy();
    expect(screen.getByRole('button', { name: '对话模型' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '视觉模型' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '语音识别' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '视频处理' })).toBeTruthy();

    fireEvent.change(deepSeekKey, { target: { value: 'renderer-only-new-key' } });
    fireEvent.change(screen.getByLabelText('模型名称', { exact: true }), { target: { value: 'runtime-model' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(saveRuntimeSettings).toHaveBeenCalledWith(expect.objectContaining({
      deepSeekApiKey: 'renderer-only-new-key',
      deepSeekModel: 'runtime-model',
    })));
    await screen.findByText('设置已保存，将从下一次任务开始生效。');
    expect((deepSeekKey as HTMLInputElement).value).toBe('********');
    const visionKey = screen.getAllByLabelText('接口密钥', { selector: 'input' })[1]!;
    expect((visionKey as HTMLInputElement).value).toBe('********');
    expect(screen.queryByDisplayValue('renderer-only-new-key')).toBeNull();
    expect(screen.getAllByText('已配置')).toHaveLength(2);
    expect(screen.getByText('来源：本机设置')).toBeTruthy();
    expect(screen.getByText('来源：环境变量')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(saveRuntimeSettings).toHaveBeenCalledTimes(2));
    expect(saveRuntimeSettings.mock.calls[1]![0]).not.toHaveProperty('deepSeekApiKey');
    expect(saveRuntimeSettings.mock.calls[1]![0]).not.toHaveProperty('visionApiKey');
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

  it('renames a session, persists the manual title, and does not replace it after the next prompt', async () => {
    let savedState: ClientStateSnapshot | undefined;
    const runAgentTask = async () => ({ responseText: '完成', traceId: 'trace-rename' });
    const renameApi: AgentClientApi = {
      ...api,
      runAgentTask,
      saveClientState: async (state) => { savedState = state; },
    };

    render(<App api={renameApi} />);
    await screen.findByRole('button', { name: '会话 1' });
    fireEvent.click(screen.getByRole('button', { name: '会话操作：会话 1' }));
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
    };

    render(<App api={deleteApi} />);
    await screen.findByRole('button', { name: '会话 1' });
    fireEvent.click(screen.getByRole('button', { name: '新会话' }));
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

  it('creates exactly one Client conversation from the Host id when deleting the last session', async () => {
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
    expect(screen.getByRole('button', { name: '会话 2' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(persistedState).toMatchObject({
      activeSessionId: 'host-created-session',
      conversations: [{ id: 'host-created-session' }],
    }));
  });

  it('disables session rename and delete while an Agent turn is processing', async () => {
    let resolveTask: ((result: { responseText: string; traceId: string }) => void) | undefined;
    const processingApi: AgentClientApi = {
      ...api,
      runAgentTask: () => new Promise((resolve) => { resolveTask = resolve; }),
      deleteSession: vi.fn(async () => 'session-a'),
    };

    render(<App api={processingApi} />);
    await screen.findByRole('button', { name: '会话 1' });
    fireEvent.click(screen.getByRole('button', { name: '会话操作：会话 1' }));
    expect(screen.getByRole('button', { name: '重命名' })).toBeTruthy();
    const composer = screen.getByLabelText('剪辑需求');
    fireEvent.change(composer, { target: { value: '执行中任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    const menuButton = screen.getByRole('button', { name: '会话操作：执行中任务' });
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
    expect(saved[0]?.conversations[0]?.prompt).toBe('关闭前的草稿');
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
    expect(saved[1]?.conversations[0]?.prompt).toBe('关闭时的最终草稿');
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
      selectAttachmentFiles: async () => [
        { path: 'D:\\videos\\a.mp4', name: 'a.mp4', role: 'video' },
      ],
    };

    render(<App api={switchApi} />);
    const input = await screen.findByLabelText('剪辑需求');
    fireEvent.change(input, { target: { value: '会话一草稿' } });

    fireEvent.click(screen.getByRole('button', { name: '新会话' }));
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
});
