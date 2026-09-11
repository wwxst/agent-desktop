// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/index.js';
import type { AgentClientApi } from '../src/index.js';

const api: AgentClientApi = {
  getActiveSessionId: async () => 'session-a',
  selectVideoFile: async () => null,
  removeSelectedVideo: async () => undefined,
  newSession: async () => 'session-b',
  switchSession: async () => undefined,
  runAgentTask: async () => ({ responseText: 'done', traceId: 'trace-a' }),
  onAgentEvent: () => () => undefined,
  openOutputFile: async () => undefined,
};

describe('shared App', () => {
  it('renders with explicitly supplied host capabilities', async () => {
    render(<App api={api} />);
    expect(await screen.findByText('Agent Desktop')).toBeTruthy();
    expect(screen.getByRole('button', { name: '新会话' })).toBeTruthy();
  });
});
