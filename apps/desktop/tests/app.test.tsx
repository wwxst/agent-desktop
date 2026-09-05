// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      runAgentTask: async () => ({ responseText: 'done', traceId: 'trace-empty' }),
      onAgentEvent: () => () => undefined,
      openOutputFile: async () => undefined,
    } satisfies DesktopApi;

    render(<App />);

    expect(screen.getByText('开始一个视频任务')).toBeTruthy();
    expect(screen.getByText('选择一个视频，然后告诉 Agent 你想怎么处理。')).toBeTruthy();
    expect(screen.getByText('删除无关内容，只保留核心部分')).toBeTruthy();
    expect(screen.getByText('找出讲 Japan 的片段')).toBeTruthy();
    expect(screen.getByText('把开头压缩得更紧凑')).toBeTruthy();
  });

  it('selects a video, sends the task, and displays the final result', async () => {
    const runAgentTask = vi.fn(async () => ({
      responseText: '剪辑已经完成。',
      outputFileName: 'sintel-trailer-edited.mp4',
      traceId: 'trace-1',
    }));
    const openOutputFile = vi.fn(async () => undefined);
    window.agentDesktop = {
      selectVideoFile: async () => ({ name: 'sintel-trailer.mp4' }),
      runAgentTask,
      onAgentEvent: () => () => undefined,
      openOutputFile,
    } satisfies DesktopApi;

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '选择视频' }));
    expect(await screen.findByText('sintel-trailer.mp4')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('剪辑需求'), {
      target: { value: '删除无关内容，只保留核心部分' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(runAgentTask).toHaveBeenCalledWith('删除无关内容，只保留核心部分'));
    expect(await screen.findByText('剪辑已经完成。')).toBeTruthy();
    expect(screen.getByText('sintel-trailer-edited.mp4')).toBeTruthy();
    expect(screen.getByText('视频 · 已完成')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '打开文件' }));
    expect(openOutputFile).toHaveBeenCalledOnce();
  });

  it('updates Tool activity from the shared trace event', async () => {
    let receiveEvent: ((event: ToolActivityEvent) => void) | undefined;
    window.agentDesktop = {
      selectVideoFile: async () => null,
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
      selectVideoFile: async () => ({ name: 'sintel-trailer.mp4' }),
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
});
