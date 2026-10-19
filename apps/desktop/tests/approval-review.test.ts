import { InMemorySession } from '@agent-desktop/session';
import { describe, expect, it, vi } from 'vitest';
import { UNKNOWN_MODEL_CAPABILITIES } from '@agent-desktop/client/model-capabilities';

const model = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('@agent-desktop/model-deepseek', () => ({ OpenAICompatibleModel: class {
  complete(...args: Parameters<typeof model.complete>) { return model.complete(...args); }
} }));

import { reviewApproval } from '../src/main/approval-review.js';

describe('automatic approval review', () => {
  it('does not forward arbitrary tool output to the reviewer model', async () => {
    model.complete.mockResolvedValueOnce({
      text: JSON.stringify({ decision: 'approve', risk: 'low', authorization: 'explicit', reason: '用户明确要求。' }),
      toolCalls: [],
    });
    const secret = 'private-file-content-and-token';
    const result = await reviewApproval({ kind: 'command', interpreter: 'C:/Windows/System32/cmd.exe', command: 'echo ok', workingDirectory: 'D:/work', timeoutMs: 120_000 }, {
      modelApiKey: 'key', modelBaseUrl: 'https://example.test/v1', modelId: 'reviewer', modelProtocol: 'chat-completions',
      modelCapabilities: { ...UNKNOWN_MODEL_CAPABILITIES, streaming: 'supported', chatCompletions: 'supported' },
      conversationModel: { providerId: 'test', modelId: 'reviewer' },
    }, [...new InMemorySession([], 'session').appendMany([
      { type: 'user.message', turnId: 'turn' as never, payload: { content: '请执行这个命令。' } },
      { type: 'tool.result', turnId: 'turn' as never, payload: { stepId: 'step' as never, toolCallId: 'call' as never,
        result: { status: 'success', output: secret } } },
    ])]);

    expect(result.decision).toBe('approve');
    const request = model.complete.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(request.messages[0]!.content).toContain('请执行这个命令。');
    expect(request.messages[0]!.content).toContain('echo ok');
    expect(request.messages[0]!.content).not.toContain(secret);
  });
});
