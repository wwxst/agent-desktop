import { describe, expect, it } from 'vitest';
import type { AgentClientApi } from '../src/index.js';

describe('AgentClientApi', () => {
  it('defines the host boundary used by the shared client', () => {
    const api: AgentClientApi = {
      loadClientState: async () => null,
      saveClientState: async () => undefined,
      getActiveSessionId: async () => 'session-a',
      selectVideoFile: async () => null,
      removeSelectedVideo: async () => undefined,
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      runAgentTask: async () => ({ responseText: 'ok', traceId: 'trace-a' }),
      onAgentEvent: () => () => undefined,
      openOutputFile: async () => undefined,
    };

    expect(Object.keys(api).sort()).toEqual([
      'getActiveSessionId',
      'loadClientState',
      'newSession',
      'onAgentEvent',
      'openOutputFile',
      'removeSelectedVideo',
      'runAgentTask',
      'saveClientState',
      'selectVideoFile',
      'switchSession',
    ]);
  });
});
