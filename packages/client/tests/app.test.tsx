// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  getActiveSessionId: async () => 'session-a',
  selectVideoFile: async () => null,
  removeSelectedVideo: async () => undefined,
  newSession: async () => 'session-b',
  switchSession: async () => undefined,
  deleteSession: async () => 'session-a',
  runAgentTask: async () => ({ responseText: 'done', traceId: 'trace-a' }),
  cancelTask: async () => undefined,
  onAgentEvent: () => () => undefined,
  openOutputFile: async () => undefined,
};

afterEach(() => cleanup());

describe('shared App', () => {
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
  });

  it('loads and saves runtime settings without receiving or echoing saved API keys', async () => {
    const saveRuntimeSettings = vi.fn(async () => ({
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
    const deepSeekKey = (await screen.findAllByLabelText('API Key', { selector: 'input' }))[0]!;
    expect((deepSeekKey as HTMLInputElement).value).toBe('');
    expect(screen.getAllByText('未配置')).toHaveLength(2);
    expect(screen.getByText('使用系统 PATH')).toBeTruthy();

    fireEvent.change(deepSeekKey, { target: { value: 'renderer-only-new-key' } });
    fireEvent.change(screen.getByLabelText('Model', { exact: true }), { target: { value: 'runtime-model' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(saveRuntimeSettings).toHaveBeenCalledWith(expect.objectContaining({
      deepSeekApiKey: 'renderer-only-new-key',
      deepSeekModel: 'runtime-model',
    })));
    await screen.findByText('设置已保存，将从下一次任务开始生效。');
    expect((deepSeekKey as HTMLInputElement).value).toBe('');
    expect(screen.queryByDisplayValue('renderer-only-new-key')).toBeNull();
    expect(screen.getAllByText('已配置')).toHaveLength(2);
    expect(screen.getByText('来源：本机设置')).toBeTruthy();
    expect(screen.getByText('来源：环境变量')).toBeTruthy();
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
          selectedVideos: [{ name: 'a.mp4' }],
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
          selectedVideos: [{ name: 'b.mp4' }],
          messages: [{
            id: 2,
            role: 'assistant',
            status: 'completed',
            toolsExpanded: false,
            tools: [{
              toolCallId: 'call-b',
              toolName: 'trim_video',
              status: 'completed',
              durationMs: 8,
            }],
            result: {
              responseText: 'Agent B 已完成',
              traceId: 'trace-b',
              outputFileName: 'b-edited.mp4',
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
    expect(screen.getByText('trace-b')).toBeTruthy();
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
        selectedVideos: [],
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
    expect(screen.getByText('正在处理视频')).toBeTruthy();

    act(() => receiveEvent?.({ type: 'text.delta', delta: '正在' }));
    expect(screen.getByText('正在')).toBeTruthy();
    expect(screen.queryByText('正在处理视频')).toBeNull();
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

  it('never persists temporary streamed text in the saved snapshot', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
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
});
