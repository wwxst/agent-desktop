// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App.js';
import type {
  AgentRuntimeEvent,
  AgentTaskResult,
  DesktopApi,
} from '../src/shared/ipc.js';

// jsdom 不计算滚动布局，实际可见性由共享客户端浏览器验收覆盖。
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const persistenceMethods = {
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
  deleteSession: async () => 'session-a',
  cancelTask: async () => undefined,
  revealFile: async () => undefined,
};

describe('App', () => {
  it('shows a useful video-task empty state before the first task', () => {
    window.agentDesktop = {
      ...persistenceMethods,
      selectAttachmentFiles: async () => null,
      removeAttachment: async () => undefined,
      getActiveSessionId: async () => 'session-a',
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask: async () => ({ responseText: 'done', traceId: 'trace-empty' }),
      onAgentEvent: () => () => undefined,
    } satisfies DesktopApi;

    render(<App />);

    expect(screen.getByRole('complementary', { name: '工作区导航' })).toBeTruthy();
    expect(screen.queryByText('视频剪辑')).toBeNull();
    expect(screen.getByRole('button', { name: '会话 1' })).toBeTruthy();
    expect(screen.getByText('Agent Desktop')).toBeTruthy();
    expect(screen.queryByText('视频智能剪辑')).toBeNull();
    expect(screen.queryByLabelText('品牌 Logo')).toBeNull();
    expect(document.querySelector('.sidebar-brand svg')).toBeNull();
    expect(screen.queryByText('新任务')).toBeNull();
    const emptyWorkspace = screen.getByRole('region', { name: '开始视频任务' });
    expect(screen.getByText('开始一个视频任务')).toBeTruthy();
    expect(screen.getByText('选择视频，或者直接告诉 Agent 你想做什么。')).toBeTruthy();
    expect(screen.queryByLabelText('任务示例')).toBeNull();
    expect(within(emptyWorkspace).getByLabelText('剪辑需求')).toBeTruthy();
    expect(screen.getAllByLabelText('剪辑需求')).toHaveLength(1);
    expect(screen.queryByText('就绪')).toBeNull();
  });

  it('waits for the initial Main session before allowing a new session', async () => {
    let resolveInitialSession: ((sessionId: string) => void) | undefined;
    const newSession = vi.fn(async () => 'session-b');
    window.agentDesktop = {
      ...persistenceMethods,
      getActiveSessionId: () => new Promise((resolve) => {
        resolveInitialSession = resolve;
      }),
      selectAttachmentFiles: async () => null,
      removeAttachment: async () => undefined,
      newSession,
      switchSession: async () => undefined,
      runAgentTask: async () => ({ responseText: 'done', traceId: 'trace-initializing' }),
      onAgentEvent: () => () => undefined,
    } satisfies DesktopApi;

    render(<App />);
    const newSessionButton = screen.getByRole('button', { name: '新会话' });
    expect(newSessionButton).toHaveProperty('disabled', true);
    fireEvent.click(newSessionButton);
    expect(newSession).not.toHaveBeenCalled();

    await act(async () => resolveInitialSession?.('session-a'));
    expect(newSessionButton).toHaveProperty('disabled', false);
    fireEvent.click(newSessionButton);
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
  });

  it('removes one pending video from the Composer and Main selection', async () => {
    const removeAttachment = vi.fn(async () => undefined);
    window.agentDesktop = {
      ...persistenceMethods,
      selectAttachmentFiles: async () => ([
        { path: 'D:\\videos\\sintel-trailer.mp4', name: 'sintel-trailer.mp4', role: 'video' },
        { path: 'D:\\videos\\interview.mp4', name: 'interview.mp4', role: 'video' },
      ]),
      removeAttachment,
      getActiveSessionId: async () => 'session-a',
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask: async () => ({ responseText: 'done', traceId: 'trace-remove' }),
      onAgentEvent: () => () => undefined,
    } satisfies DesktopApi;

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '选择输入文件' }));
    expect(await screen.findByLabelText('视频附件：sintel-trailer.mp4')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '移除视频 sintel-trailer.mp4' }));

    await waitFor(() => expect(removeAttachment).toHaveBeenCalledWith(0));
    expect(screen.queryByLabelText('视频附件：sintel-trailer.mp4')).toBeNull();
    expect(screen.getByLabelText('视频附件：interview.mp4')).toBeTruthy();
  });

  it('keeps existing videos when another selection is added', async () => {
    const selectAttachmentFiles = vi.fn()
      .mockResolvedValueOnce([
        { path: 'D:\\videos\\sintel-trailer.mp4', name: 'sintel-trailer.mp4', role: 'video' },
      ])
      .mockResolvedValueOnce([
        { path: 'D:\\videos\\sintel-trailer.mp4', name: 'sintel-trailer.mp4', role: 'video' },
        { path: 'D:\\videos\\interview.mp4', name: 'interview.mp4', role: 'video' },
      ]);
    window.agentDesktop = {
      ...persistenceMethods,
      selectAttachmentFiles,
      removeAttachment: async () => undefined,
      getActiveSessionId: async () => 'session-a',
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask: async () => ({ responseText: 'done', traceId: 'trace-add' }),
      onAgentEvent: () => () => undefined,
    } satisfies DesktopApi;

    render(<App />);
    const selectButton = screen.getByRole('button', { name: '选择输入文件' });
    fireEvent.click(selectButton);
    expect(await screen.findByLabelText('视频附件：sintel-trailer.mp4')).toBeTruthy();

    fireEvent.click(selectButton);

    expect(await screen.findByLabelText('视频附件：interview.mp4')).toBeTruthy();
    expect(screen.getByLabelText('视频附件：sintel-trailer.mp4')).toBeTruthy();
    expect(selectAttachmentFiles).toHaveBeenCalledTimes(2);
  });

  it('selects multiple videos, sends the task, and displays the final result', async () => {
    const runAgentTask = vi.fn(async () => ({
      responseText: '剪辑已经完成。',
      outputFiles: [{ path: 'D:/videos/sintel-trailer-edited.mp4', fileName: 'sintel-trailer-edited.mp4' }],
      traceId: 'trace-1',
    }));
    const revealFile = vi.fn(async () => undefined);
    window.agentDesktop = {
      ...persistenceMethods,
      selectAttachmentFiles: async () => ([
        { path: 'D:\\videos\\sintel-trailer.mp4', name: 'sintel-trailer.mp4', role: 'video' },
        { path: 'D:\\videos\\interview.mp4', name: 'interview.mp4', role: 'video' },
      ]),
      removeAttachment: async () => undefined,
      getActiveSessionId: async () => 'session-a',
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask,
      onAgentEvent: () => () => undefined,
      revealFile,
    } satisfies DesktopApi;

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '选择输入文件' }));
    expect(await screen.findByText('sintel-trailer.mp4')).toBeTruthy();
    expect(screen.getByText('interview.mp4')).toBeTruthy();

    const composerInput = screen.getByLabelText('剪辑需求');
    fireEvent.change(composerInput, {
      target: { value: '删除无关内容，只保留核心部分' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(screen.getByText('进行中')).toBeTruthy();

    await waitFor(() => expect(runAgentTask).toHaveBeenCalledWith('删除无关内容，只保留核心部分'));
    expect(await screen.findByText('剪辑已经完成。')).toBeTruthy();
    expect(screen.queryByText('进行中')).toBeNull();
    expect(screen.queryByRole('region', { name: '开始视频任务' })).toBeNull();
    expect(within(screen.getByRole('region', { name: '任务输入' })).getByLabelText('剪辑需求')).toBeTruthy();
    expect(screen.getAllByLabelText('剪辑需求')).toHaveLength(1);
    expect(screen.getByLabelText('剪辑需求')).toBe(composerInput);
    expect(within(screen.getByLabelText('你的任务')).getByText('删除无关内容，只保留核心部分')).toBeTruthy();
    expect((screen.getByLabelText('剪辑需求') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getAllByLabelText('视频附件：sintel-trailer.mp4')).toHaveLength(2);
    expect(screen.getAllByLabelText('视频附件：interview.mp4')).toHaveLength(2);
    expect(screen.getByText('sintel-trailer-edited.mp4')).toBeTruthy();
    expect(screen.getByText('视频 · 已完成')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '预览' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '打开文件' }));
    expect(revealFile).toHaveBeenCalledWith('D:/videos/sintel-trailer-edited.mp4');
  });

  it('updates the activity timeline from the shared activity event', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    window.agentDesktop = {
      ...persistenceMethods,
      selectAttachmentFiles: async () => null,
      removeAttachment: async () => undefined,
      getActiveSessionId: async () => 'session-a',
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask: () => new Promise((resolve) => {
        resolveTask = resolve;
      }),
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    } satisfies DesktopApi;

    render(<App />);
    fireEvent.change(screen.getByLabelText('剪辑需求'), {
      target: { value: '检查视频' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({
      type: 'activity',
      item: { id: 'call-1', kind: 'tool', status: 'running', toolName: 'probe_media' },
    }));
    expect(screen.getByText('读取视频信息')).toBeTruthy();
    expect(screen.getByText('probe_media')).toBeTruthy();
    expect(screen.getByText('执行中')).toBeTruthy();

    act(() => receiveEvent?.({
      type: 'activity',
      item: { id: 'call-1', kind: 'tool', status: 'completed', toolName: 'probe_media', durationMs: 24 },
    }));
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('24 ms')).toBeTruthy();

    await act(async () => resolveTask?.({ responseText: 'done', traceId: 'trace-2' }));
  });

  it('collapses completed activity and lets the user expand it', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    window.agentDesktop = {
      ...persistenceMethods,
      selectAttachmentFiles: async () => ([
        { path: 'D:\\videos\\sintel-trailer.mp4', name: 'sintel-trailer.mp4', role: 'video' },
      ]),
      removeAttachment: async () => undefined,
      getActiveSessionId: async () => 'session-a',
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask: () => new Promise((resolve) => {
        resolveTask = resolve;
      }),
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    } satisfies DesktopApi;

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '选择输入文件' }));
    expect(await screen.findByText('sintel-trailer.mp4')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('剪辑需求'), {
      target: { value: '保留核心内容' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    act(() => receiveEvent?.({
      type: 'activity',
      item: { id: 'call-1', kind: 'tool', status: 'completed', toolName: 'probe_media', durationMs: 24 },
    }));
    expect(screen.getByText('probe_media')).toBeTruthy();

    await act(async () => resolveTask?.({
      responseText: '完成。',
      traceId: 'trace-3',
    }));
    const summary = await screen.findByRole('button', { name: '展开执行过程，共 1 项' });
    expect(screen.queryByText('probe_media')).toBeNull();

    fireEvent.click(summary);
    expect(screen.getByText('probe_media')).toBeTruthy();
  });

  it('sends a text-only task without requiring a video attachment', async () => {
    const runAgentTask = vi.fn(async () => ({
      responseText: '这是一个文本回复。',
      traceId: 'trace-text-only',
    }));
    window.agentDesktop = {
      ...persistenceMethods,
      selectAttachmentFiles: async () => null,
      removeAttachment: async () => undefined,
      getActiveSessionId: async () => 'session-a',
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask,
      onAgentEvent: () => () => undefined,
    } satisfies DesktopApi;

    render(<App />);
    const composerInput = screen.getByLabelText('剪辑需求');
    const sendButton = screen.getByRole('button', { name: '发送' });
    expect(sendButton).toHaveProperty('disabled', true);

    fireEvent.change(composerInput, { target: { value: '介绍一下这个客户端的能力。' } });
    expect(sendButton).toHaveProperty('disabled', false);
    fireEvent.click(sendButton);

    await waitFor(() => expect(runAgentTask).toHaveBeenCalledWith('介绍一下这个客户端的能力。'));
    expect(await screen.findByText('这是一个文本回复。')).toBeTruthy();
    expect(screen.queryByLabelText(/视频附件：/)).toBeNull();
  });

  it('keeps two complete text turns in the visible conversation', async () => {
    const runAgentTask = vi.fn()
      .mockResolvedValueOnce({ responseText: '已经记住。', traceId: 'trace-turn-1' })
      .mockResolvedValueOnce({ responseText: '你刚才让我记住的数字是 731。', traceId: 'trace-turn-2' });
    window.agentDesktop = {
      ...persistenceMethods,
      selectAttachmentFiles: async () => null,
      removeAttachment: async () => undefined,
      getActiveSessionId: async () => 'session-a',
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask,
      onAgentEvent: () => () => undefined,
    } satisfies DesktopApi;

    render(<App />);
    const composerInput = screen.getByLabelText('剪辑需求');
    fireEvent.change(composerInput, { target: { value: '请记住数字 731。' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('已经记住。')).toBeTruthy();

    fireEvent.change(composerInput, { target: { value: '我刚才让你记住的数字是多少？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('你刚才让我记住的数字是 731。')).toBeTruthy();

    expect(screen.getAllByLabelText('你的任务')).toHaveLength(2);
    expect(screen.getAllByLabelText('Agent 回复')).toHaveLength(2);
    expect(within(screen.getAllByLabelText('你的任务')[0]!).getByText('请记住数字 731。')).toBeTruthy();
    expect(screen.getByText('我刚才让你记住的数字是多少？')).toBeTruthy();
  });

  it('keeps activity with the Agent reply from its own turn', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    const runAgentTask = vi.fn(() => new Promise<AgentTaskResult>((resolve) => {
      resolveTask = resolve;
    }));
    window.agentDesktop = {
      ...persistenceMethods,
      selectAttachmentFiles: async () => null,
      removeAttachment: async () => undefined,
      getActiveSessionId: async () => 'session-a',
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask,
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    } satisfies DesktopApi;

    render(<App />);
    const composerInput = screen.getByLabelText('剪辑需求');
    fireEvent.change(composerInput, { target: { value: '第一轮' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({
      type: 'activity',
      item: { id: 'call-a', kind: 'tool', status: 'completed', toolName: 'tool_a', durationMs: 10 },
    }));
    await act(async () => resolveTask?.({ responseText: '第一轮完成', traceId: 'trace-a' }));

    fireEvent.change(composerInput, { target: { value: '第二轮' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({
      type: 'activity',
      item: { id: 'call-b', kind: 'tool', status: 'completed', toolName: 'tool_b', durationMs: 20 },
    }));
    await act(async () => resolveTask?.({ responseText: '第二轮完成', traceId: 'trace-b' }));

    const agentReplies = screen.getAllByLabelText('Agent 回复');
    const toolSummaries = screen.getAllByRole('button', { name: '展开执行过程，共 1 项' });
    fireEvent.click(toolSummaries[0]!);
    fireEvent.click(toolSummaries[1]!);
    expect(within(agentReplies[0]!).getByText('tool_a')).toBeTruthy();
    expect(within(agentReplies[0]!).queryByText('tool_b')).toBeNull();
    expect(within(agentReplies[1]!).getByText('tool_b')).toBeTruthy();
    expect(within(agentReplies[1]!).queryByText('tool_a')).toBeNull();
  });

  it('keeps each Artifact in history and opens the matching output', async () => {
    const runAgentTask = vi.fn()
      .mockResolvedValueOnce({
        responseText: '第一轮完成。',
        outputFiles: [{ path: 'D:/videos/step1.mp4', fileName: 'step1.mp4' }],
        traceId: 'trace-artifact-1',
      })
      .mockResolvedValueOnce({
        responseText: '第二轮完成。',
        outputFiles: [{ path: 'D:/videos/step2.mp4', fileName: 'step2.mp4' }],
        traceId: 'trace-artifact-2',
      });
    const revealFile = vi.fn(async () => undefined);
    window.agentDesktop = {
      ...persistenceMethods,
      selectAttachmentFiles: async () => [
        { path: 'D:\\videos\\input.mp4', name: 'input.mp4', role: 'video' },
      ],
      removeAttachment: async () => undefined,
      getActiveSessionId: async () => 'session-a',
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask,
      onAgentEvent: () => () => undefined,
      revealFile,
    } satisfies DesktopApi;

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '选择输入文件' }));
    expect(await screen.findByText('input.mp4')).toBeTruthy();
    const composerInput = screen.getByLabelText('剪辑需求');
    fireEvent.change(composerInput, { target: { value: '第一次处理' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('step1.mp4')).toBeTruthy();
    fireEvent.change(composerInput, { target: { value: '基于刚才结果继续处理' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('step2.mp4')).toBeTruthy();

    const openButtons = screen.getAllByRole('button', { name: '打开文件' });
    fireEvent.click(openButtons[0]!);
    fireEvent.click(openButtons[1]!);
    expect(revealFile).toHaveBeenNthCalledWith(1, 'D:/videos/step1.mp4');
    expect(revealFile).toHaveBeenNthCalledWith(2, 'D:/videos/step2.mp4');
  });

  it('does not start another task while the current turn is running', async () => {
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    const runAgentTask = vi.fn(() => new Promise<AgentTaskResult>((resolve) => {
      resolveTask = resolve;
    }));
    window.agentDesktop = {
      ...persistenceMethods,
      selectAttachmentFiles: async () => null,
      removeAttachment: async () => undefined,
      getActiveSessionId: async () => 'session-a',
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask,
      onAgentEvent: () => () => undefined,
    } satisfies DesktopApi;

    render(<App />);
    const composerInput = screen.getByLabelText('剪辑需求');
    fireEvent.change(composerInput, { target: { value: '第一轮' } });
    const sendButton = screen.getByRole('button', { name: '发送' });
    fireEvent.click(sendButton);

    expect(screen.getByRole('button', { name: '停止' })).toHaveProperty('disabled', false);
    fireEvent.click(sendButton);
    expect(runAgentTask).toHaveBeenCalledOnce();

    await act(async () => resolveTask?.({ responseText: '完成。', traceId: 'trace-running' }));
  });

  it('starts a new empty session while keeping the previous conversation in the list', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveFirstTask: ((result: AgentTaskResult) => void) | undefined;
    const newSession = vi.fn(async () => 'session-b');
    const runAgentTask = vi.fn()
      .mockImplementationOnce(() => new Promise<AgentTaskResult>((resolve) => {
        resolveFirstTask = resolve;
      }))
      .mockResolvedValueOnce({ responseText: '第二轮完成。', traceId: 'trace-new-2' });
    window.agentDesktop = {
      ...persistenceMethods,
      getActiveSessionId: async () => 'session-a',
      selectAttachmentFiles: async () => [
        { path: 'D:\\videos\\input.mp4', name: 'input.mp4', role: 'video' },
      ],
      removeAttachment: async () => undefined,
      newSession,
      switchSession: async () => undefined,
      runAgentTask,
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    } satisfies DesktopApi;

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '选择输入文件' }));
    expect(await screen.findByLabelText('视频附件：input.mp4')).toBeTruthy();
    const composerInput = screen.getByLabelText('剪辑需求');

    fireEvent.change(composerInput, { target: { value: '第一轮任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({
      type: 'activity',
      item: { id: 'call-new-1', kind: 'tool', status: 'completed', toolName: 'trim_video', durationMs: 18 },
    }));
    await act(async () => resolveFirstTask?.({
      responseText: '第一轮完成。',
      outputFiles: [{ path: 'D:/videos/first-output.mp4', fileName: 'first-output.mp4' }],
      traceId: 'trace-new-1',
    }));
    expect(await screen.findByText('first-output.mp4')).toBeTruthy();
    expect(screen.getByRole('button', { name: '展开执行过程，共 1 项' })).toBeTruthy();

    fireEvent.change(composerInput, { target: { value: '第二轮任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('第二轮完成。')).toBeTruthy();
    fireEvent.change(composerInput, { target: { value: '未发送草稿' } });

    fireEvent.click(screen.getByRole('button', { name: '新会话' }));

    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    const conversationWorkspace = screen.getByRole('main', { name: '对话工作区' });
    expect(screen.getByRole('button', { name: '第一轮任务' })).toBeTruthy();
    expect(within(conversationWorkspace).queryByText('第一轮任务')).toBeNull();
    expect(within(conversationWorkspace).queryByText('第二轮任务')).toBeNull();
    expect(within(conversationWorkspace).queryByText('第一轮完成。')).toBeNull();
    expect(within(conversationWorkspace).queryByText('第二轮完成。')).toBeNull();
    expect(within(conversationWorkspace).queryByRole('button', { name: '展开执行过程，共 1 项' })).toBeNull();
    expect(within(conversationWorkspace).queryByText('first-output.mp4')).toBeNull();
    expect(within(conversationWorkspace).queryByLabelText('视频附件：input.mp4')).toBeNull();
    expect((composerInput as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByRole('region', { name: '开始视频任务' })).toBeTruthy();
  });

  it('switches isolated UI history, draft, attachments, activity, traces, and artifacts', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveSessionA: ((result: AgentTaskResult) => void) | undefined;
    let resolveSessionB: ((result: AgentTaskResult) => void) | undefined;
    const switchSession = vi.fn(async () => undefined);
    const revealFile = vi.fn(async () => undefined);
    const selectAttachmentFiles = vi.fn()
      .mockResolvedValueOnce([
        { path: 'D:\\videos\\video-a.mp4', name: 'video-a.mp4', role: 'video' },
      ])
      .mockResolvedValueOnce([
        { path: 'D:\\videos\\video-b.mp4', name: 'video-b.mp4', role: 'video' },
      ]);
    const runAgentTask = vi.fn()
      .mockImplementationOnce(() => new Promise<AgentTaskResult>((resolve) => {
        resolveSessionA = resolve;
      }))
      .mockImplementationOnce(() => new Promise<AgentTaskResult>((resolve) => {
        resolveSessionB = resolve;
      }));
    window.agentDesktop = {
      ...persistenceMethods,
      getActiveSessionId: async () => 'session-a',
      selectAttachmentFiles,
      removeAttachment: async () => undefined,
      newSession: async () => 'session-b',
      switchSession,
      runAgentTask,
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
      revealFile,
    } satisfies DesktopApi;

    render(<App />);
    expect((await screen.findByRole('button', { name: '会话 1' })).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: '选择输入文件' }));
    expect(await screen.findByLabelText('视频附件：video-a.mp4')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('剪辑需求'), { target: { value: '用户 A' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({
      type: 'activity',
      item: { id: 'call-a', kind: 'tool', status: 'completed', toolName: 'tool_a', durationMs: 10 },
    }));
    await act(async () => resolveSessionA?.({
      responseText: 'assistant A',
      outputFiles: [{ path: 'D:/videos/a.mp4', fileName: 'a.mp4' }],
      traceId: 'trace-a',
    }));
    fireEvent.change(screen.getByLabelText('剪辑需求'), { target: { value: 'draft A' } });

    fireEvent.click(screen.getByRole('button', { name: '新会话' }));
    expect((await screen.findByRole('button', { name: '会话 2' })).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: '用户 A' })).toBeTruthy();
    expect(screen.queryByText('assistant A')).toBeNull();
    expect(screen.queryByLabelText('视频附件：video-a.mp4')).toBeNull();
    expect((screen.getByLabelText('剪辑需求') as HTMLTextAreaElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: '选择输入文件' }));
    expect(await screen.findByLabelText('视频附件：video-b.mp4')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('剪辑需求'), { target: { value: '用户 B' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    act(() => receiveEvent?.({
      type: 'activity',
      item: { id: 'call-b', kind: 'tool', status: 'completed', toolName: 'tool_b', durationMs: 20 },
    }));
    await act(async () => resolveSessionB?.({
      responseText: 'assistant B',
      outputFiles: [{ path: 'D:/videos/b.mp4', fileName: 'b.mp4' }],
      traceId: 'trace-b',
    }));

    fireEvent.click(screen.getByRole('button', { name: '用户 A' }));
    await waitFor(() => expect(switchSession).toHaveBeenLastCalledWith('session-a'));
    expect(screen.getByText('assistant A')).toBeTruthy();
    expect(screen.queryByText('assistant B')).toBeNull();
    expect(screen.getAllByLabelText('视频附件：video-a.mp4')).toHaveLength(2);
    expect(screen.queryByLabelText('视频附件：video-b.mp4')).toBeNull();
    expect((screen.getByLabelText('剪辑需求') as HTMLTextAreaElement).value).toBe('draft A');
    fireEvent.click(screen.getByRole('button', { name: '展开执行过程，共 1 项' }));
    expect(screen.getByText('tool_a')).toBeTruthy();
    expect(screen.queryByText('tool_b')).toBeNull();
    expect(screen.getByText('a.mp4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开文件' }));
    expect(revealFile).toHaveBeenLastCalledWith('D:/videos/a.mp4');

    fireEvent.click(screen.getByRole('button', { name: '用户 B' }));
    await waitFor(() => expect(switchSession).toHaveBeenLastCalledWith('session-b'));
    expect(screen.getByText('assistant B')).toBeTruthy();
    expect(screen.queryByText('assistant A')).toBeNull();
    expect(screen.getAllByLabelText('视频附件：video-b.mp4')).toHaveLength(2);
    expect(screen.queryByLabelText('视频附件：video-a.mp4')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开执行过程，共 1 项' }));
    expect(screen.getByText('tool_b')).toBeTruthy();
    expect(screen.queryByText('tool_a')).toBeNull();
    expect(screen.getByText('b.mp4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开文件' }));
    expect(revealFile).toHaveBeenLastCalledWith('D:/videos/b.mp4');
  });

  it('disables new session while the Agent is processing', async () => {
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    const newSession = vi.fn(async () => 'session-b');
    const switchSession = vi.fn(async () => undefined);
    window.agentDesktop = {
      ...persistenceMethods,
      getActiveSessionId: async () => 'session-a',
      selectAttachmentFiles: async () => null,
      removeAttachment: async () => undefined,
      newSession,
      switchSession,
      runAgentTask: () => new Promise((resolve) => {
        resolveTask = resolve;
      }),
      onAgentEvent: () => () => undefined,
    } satisfies DesktopApi;

    render(<App />);
    const newSessionButton = screen.getByRole('button', { name: '新会话' });
    await waitFor(() => expect(newSessionButton).toHaveProperty('disabled', false));
    fireEvent.click(newSessionButton);
    expect((await screen.findByRole('button', { name: '会话 2' })).getAttribute('aria-current')).toBe('page');
    const previousSessionButton = await screen.findByRole('button', { name: '会话 1' });
    fireEvent.change(screen.getByLabelText('剪辑需求'), { target: { value: '处理中任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(newSessionButton).toHaveProperty('disabled', true);
    expect(previousSessionButton).toHaveProperty('disabled', true);
    fireEvent.click(newSessionButton);
    fireEvent.click(previousSessionButton);
    expect(newSession).toHaveBeenCalledOnce();
    expect(switchSession).not.toHaveBeenCalled();

    await act(async () => resolveTask?.({ responseText: '完成。', traceId: 'trace-finished' }));
    expect(newSessionButton).toHaveProperty('disabled', false);
  });

  it('keeps the prompt when the task fails', async () => {
    const prompt = '保留核心内容';
    window.agentDesktop = {
      ...persistenceMethods,
      selectAttachmentFiles: async () => ([
        { path: 'D:\\videos\\sintel-trailer.mp4', name: 'sintel-trailer.mp4', role: 'video' },
      ]),
      removeAttachment: async () => undefined,
      getActiveSessionId: async () => 'session-a',
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask: async () => {
        throw new Error('处理失败。');
      },
      onAgentEvent: () => () => undefined,
    } satisfies DesktopApi;

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '选择输入文件' }));
    expect(await screen.findByText('sintel-trailer.mp4')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('剪辑需求'), {
      target: { value: prompt },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('处理失败。')).toBeTruthy();
    expect((screen.getByLabelText('剪辑需求') as HTMLTextAreaElement).value).toBe(prompt);
  });

  it('shows live assistant text pushed over the desktop agent event channel', async () => {
    let receiveEvent: ((event: AgentRuntimeEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    window.agentDesktop = {
      ...persistenceMethods,
      selectAttachmentFiles: async () => null,
      removeAttachment: async () => undefined,
      getActiveSessionId: async () => 'session-a',
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask: () => new Promise((resolve) => {
        resolveTask = resolve;
      }),
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
    } satisfies DesktopApi;

    render(<App />);
    fireEvent.change(screen.getByLabelText('剪辑需求'), {
      target: { value: '流式任务' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(screen.getByText('正在处理任务')).toBeTruthy();

    act(() => receiveEvent?.({ type: 'text.delta', delta: '实时文本' }));
    expect(screen.getByText('实时文本')).toBeTruthy();

    await act(async () => resolveTask?.({ responseText: '最终回复', traceId: 'trace-live' }));
    expect(await screen.findByText('最终回复')).toBeTruthy();
    expect(screen.queryByText('实时文本')).toBeNull();
  });
});
