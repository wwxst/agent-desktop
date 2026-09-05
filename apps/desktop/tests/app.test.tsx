// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App.js';
import type { DesktopApi, ToolActivityEvent } from '../src/shared/ipc.js';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('App', () => {
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
});
