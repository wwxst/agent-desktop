import { describe, expect, it } from 'vitest';
import type { AgentClientApi } from '../src/index.js';

describe('AgentClientApi', () => {
  it('defines the host boundary used by the shared client', () => {
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
      runAgentTask: async () => ({ responseText: 'ok', traceId: 'trace-a' }),
      cancelTask: async () => undefined,
      onAgentEvent: () => () => undefined,
      openOutputFile: async () => undefined,
    };

    expect(Object.keys(api).sort()).toEqual([
      'cancelTask',
      'deleteSession',
      'getActiveSessionId',
      'loadClientState',
      'loadRuntimeSettings',
      'newSession',
      'onAgentEvent',
      'openOutputFile',
      'removeSelectedVideo',
      'runAgentTask',
      'saveClientState',
      'saveRuntimeSettings',
      'selectVideoFile',
      'switchSession',
    ]);
  });
});
