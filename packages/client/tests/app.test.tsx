// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/index.js';
import type { AgentClientApi, ClientStateSnapshot } from '../src/index.js';

const api: AgentClientApi = {
  loadClientState: async () => null,
  saveClientState: async () => undefined,
  getActiveSessionId: async () => 'session-a',
  selectVideoFile: async () => null,
  removeSelectedVideo: async () => undefined,
  newSession: async () => 'session-b',
  switchSession: async () => undefined,
  deleteSession: async () => 'session-a',
  runAgentTask: async () => ({ responseText: 'done', traceId: 'trace-a' }),
  onAgentEvent: () => () => undefined,
  openOutputFile: async () => undefined,
};

afterEach(() => cleanup());

describe('shared App', () => {
  it('renders with explicitly supplied host capabilities', async () => {
    render(<App api={api} />);
    expect(await screen.findByText('Agent Desktop')).toBeTruthy();
    expect(screen.getByRole('button', { name: '新会话' })).toBeTruthy();
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
});
