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
      onPrepareClose: () => () => undefined,
      getActiveSessionId: async () => 'session-a',
      selectAttachmentFiles: async () => null,
      removeAttachment: async () => undefined,
      newSession: async () => 'session-b',
      switchSession: async () => undefined,
      deleteSession: async () => 'session-a',
      runAgentTask: async () => ({ responseText: 'ok', traceId: 'trace-a' }),
      cancelTask: async () => undefined,
      decideApproval: async () => undefined,
      onAgentEvent: () => () => undefined,
      revealFile: async () => undefined,
    };

    expect(Object.keys(api).sort()).toEqual([
      'cancelTask',
      'decideApproval',
      'deleteSession',
      'getActiveSessionId',
      'loadClientState',
      'loadRuntimeSettings',
      'newSession',
      'onAgentEvent',
      'onPrepareClose',
      'removeAttachment',
      'revealFile',
      'runAgentTask',
      'saveClientState',
      'saveRuntimeSettings',
      'selectAttachmentFiles',
      'switchSession',
    ]);
  });
});
