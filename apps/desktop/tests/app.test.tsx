// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App.js';
import type {
  AgentTaskResult,
  DesktopApi,
  ToolActivityEvent,
} from '../src/shared/ipc.js';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('App', () => {
  it('shows a useful video-task empty state before the first task', () => {
    window.agentDesktop = {
      selectVideoFile: async () => null,
      removeSelectedVideo: async () => undefined,
      runAgentTask: async () => ({ responseText: 'done', traceId: 'trace-empty' }),
      onAgentEvent: () => () => undefined,
      openOutputFile: async () => undefined,
    } satisfies DesktopApi;

    render(<App />);

    expect(screen.getByRole('complementary', { name: '工作区导航' })).toBeTruthy();
    expect(screen.getByText('视频剪辑')).toBeTruthy();
    expect(screen.getByText('当前任务')).toBeTruthy();
    expect(screen.getByText('Agent Desktop')).toBeTruthy();
    expect(screen.queryByText('视频智能剪辑')).toBeNull();
    expect(screen.queryByLabelText('品牌 Logo')).toBeNull();
    const emptyWorkspace = screen.getByRole('region', { name: '开始视频任务' });
    expect(screen.getByText('开始一个视频任务')).toBeTruthy();
    expect(screen.getByText('可选择多个视频，也可以直接告诉 Agent 你想做什么。')).toBeTruthy();
    expect(screen.getByText('删除无关内容，只保留核心部分')).toBeTruthy();
    expect(screen.getByText('找出讲 Japan 的片段')).toBeTruthy();
    expect(screen.getByText('把开头压缩得更紧凑')).toBeTruthy();
    expect(within(emptyWorkspace).getByLabelText('剪辑需求')).toBeTruthy();
    expect(screen.getAllByLabelText('剪辑需求')).toHaveLength(1);
    expect(screen.queryByText('就绪')).toBeNull();
  });

  it('removes one pending video from the Composer and Main selection', async () => {
    const removeSelectedVideo = vi.fn(async () => undefined);
    window.agentDesktop = {
      selectVideoFile: async () => ([
        { name: 'sintel-trailer.mp4' },
        { name: 'interview.mp4' },
      ]),
      removeSelectedVideo,
      runAgentTask: async () => ({ responseText: 'done', traceId: 'trace-remove' }),
      onAgentEvent: () => () => undefined,
      openOutputFile: async () => undefined,
    } satisfies DesktopApi;

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '选择视频' }));
    expect(await screen.findByLabelText('视频附件：sintel-trailer.mp4')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '移除视频 sintel-trailer.mp4' }));

    await waitFor(() => expect(removeSelectedVideo).toHaveBeenCalledWith(0));
    expect(screen.queryByLabelText('视频附件：sintel-trailer.mp4')).toBeNull();
    expect(screen.getByLabelText('视频附件：interview.mp4')).toBeTruthy();
  });

  it('keeps existing videos when another selection is added', async () => {
    const selectVideoFile = vi.fn()
      .mockResolvedValueOnce([{ name: 'sintel-trailer.mp4' }])
      .mockResolvedValueOnce([
        { name: 'sintel-trailer.mp4' },
        { name: 'interview.mp4' },
      ]);
    window.agentDesktop = {
      selectVideoFile,
      removeSelectedVideo: async () => undefined,
      runAgentTask: async () => ({ responseText: 'done', traceId: 'trace-add' }),
      onAgentEvent: () => () => undefined,
      openOutputFile: async () => undefined,
    } satisfies DesktopApi;

    render(<App />);
    const selectButton = screen.getByRole('button', { name: '选择视频' });
    fireEvent.click(selectButton);
    expect(await screen.findByLabelText('视频附件：sintel-trailer.mp4')).toBeTruthy();

    fireEvent.click(selectButton);

    expect(await screen.findByLabelText('视频附件：interview.mp4')).toBeTruthy();
    expect(screen.getByLabelText('视频附件：sintel-trailer.mp4')).toBeTruthy();
    expect(selectVideoFile).toHaveBeenCalledTimes(2);
  });

  it('selects multiple videos, sends the task, and displays the final result', async () => {
    const runAgentTask = vi.fn(async () => ({
      responseText: '剪辑已经完成。',
      outputFileName: 'sintel-trailer-edited.mp4',
      traceId: 'trace-1',
    }));
    const openOutputFile = vi.fn(async () => undefined);
    window.agentDesktop = {
      selectVideoFile: async () => ([
        { name: 'sintel-trailer.mp4' },
        { name: 'interview.mp4' },
      ]),
      removeSelectedVideo: async () => undefined,
      runAgentTask,
      onAgentEvent: () => () => undefined,
      openOutputFile,
    } satisfies DesktopApi;

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '选择视频' }));
    expect(await screen.findByText('sintel-trailer.mp4')).toBeTruthy();
    expect(screen.getByText('interview.mp4')).toBeTruthy();

    const composerInput = screen.getByLabelText('剪辑需求');
    fireEvent.change(composerInput, {
      target: { value: '删除无关内容，只保留核心部分' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(runAgentTask).toHaveBeenCalledWith('删除无关内容，只保留核心部分'));
    expect(await screen.findByText('剪辑已经完成。')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '开始视频任务' })).toBeNull();
    expect(within(screen.getByRole('region', { name: '任务输入' })).getByLabelText('剪辑需求')).toBeTruthy();
    expect(screen.getAllByLabelText('剪辑需求')).toHaveLength(1);
    expect(screen.getByLabelText('剪辑需求')).toBe(composerInput);
    expect(screen.getByText('删除无关内容，只保留核心部分')).toBeTruthy();
    expect((screen.getByLabelText('剪辑需求') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getAllByLabelText('视频附件：sintel-trailer.mp4')).toHaveLength(2);
    expect(screen.getAllByLabelText('视频附件：interview.mp4')).toHaveLength(2);
    expect(screen.getByText('sintel-trailer-edited.mp4')).toBeTruthy();
    expect(screen.getByText('视频 · 已完成')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '打开文件' }));
    expect(openOutputFile).toHaveBeenCalledOnce();
  });

  it('updates Tool activity from the shared trace event', async () => {
    let receiveEvent: ((event: ToolActivityEvent) => void) | undefined;
    window.agentDesktop = {
      selectVideoFile: async () => null,
      removeSelectedVideo: async () => undefined,
      runAgentTask: async () => ({ responseText: 'done', traceId: 'trace-2' }),
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
      openOutputFile: async () => undefined,
    } satisfies DesktopApi;

    render(<App />);
    act(() => receiveEvent?.({
      type: 'tool.started',
      turnId: 'turn-1' as never,
      stepId: 'step-1' as never,
      toolCallId: 'call-1' as never,
      toolName: 'probe_media',
    }));
    expect(screen.getByText('读取视频信息')).toBeTruthy();
    expect(screen.getByText('probe_media')).toBeTruthy();
    expect(screen.getByText('执行中')).toBeTruthy();

    act(() => receiveEvent?.({
      type: 'tool.completed',
      turnId: 'turn-1' as never,
      stepId: 'step-1' as never,
      toolCallId: 'call-1' as never,
      toolName: 'probe_media',
      durationMs: 24,
    }));
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('24 ms')).toBeTruthy();
  });

  it('collapses completed Tool activity and lets the user expand it', async () => {
    let receiveEvent: ((event: ToolActivityEvent) => void) | undefined;
    let resolveTask: ((result: AgentTaskResult) => void) | undefined;
    window.agentDesktop = {
      selectVideoFile: async () => ([{ name: 'sintel-trailer.mp4' }]),
      removeSelectedVideo: async () => undefined,
      runAgentTask: () => new Promise((resolve) => {
        resolveTask = resolve;
      }),
      onAgentEvent: (listener) => {
        receiveEvent = listener;
        return () => undefined;
      },
      openOutputFile: async () => undefined,
    } satisfies DesktopApi;

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '选择视频' }));
    expect(await screen.findByText('sintel-trailer.mp4')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('剪辑需求'), {
      target: { value: '保留核心内容' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    act(() => receiveEvent?.({
      type: 'tool.completed',
      turnId: 'turn-1' as never,
      stepId: 'step-1' as never,
      toolCallId: 'call-1' as never,
      toolName: 'probe_media',
      durationMs: 24,
    }));
    expect(screen.getByText('probe_media')).toBeTruthy();

    await act(async () => resolveTask?.({
      responseText: '完成。',
      traceId: 'trace-3',
    }));
    const summary = await screen.findByRole('button', { name: '已执行 1 个工具' });
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
      selectVideoFile: async () => null,
      removeSelectedVideo: async () => undefined,
      runAgentTask,
      onAgentEvent: () => () => undefined,
      openOutputFile: async () => undefined,
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

  it('keeps the prompt when the task fails', async () => {
    const prompt = '保留核心内容';
    window.agentDesktop = {
      selectVideoFile: async () => ([{ name: 'sintel-trailer.mp4' }]),
      removeSelectedVideo: async () => undefined,
      runAgentTask: async () => {
        throw new Error('处理失败。');
      },
      onAgentEvent: () => () => undefined,
      openOutputFile: async () => undefined,
    } satisfies DesktopApi;

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '选择视频' }));
    expect(await screen.findByText('sintel-trailer.mp4')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('剪辑需求'), {
      target: { value: prompt },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('处理失败。')).toBeTruthy();
    expect((screen.getByLabelText('剪辑需求') as HTMLTextAreaElement).value).toBe(prompt);
  });
});
