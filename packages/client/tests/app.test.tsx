// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
});
