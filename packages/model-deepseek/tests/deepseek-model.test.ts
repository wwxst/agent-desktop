import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequest, ToolCallId } from '@agent-desktop/model';
import { DeepSeekModel } from '../src/index.js';

const baseRequest: ModelRequest = {
  systemPrompt: 'Base system prompt.',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
};

function mockJsonResponse(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== 'string') throw new Error('Expected JSON request body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeepSeekModel', () => {
  it('maps a Core request and plain text response', async () => {
    const fetchMock = mockJsonResponse({
      choices: [{ message: { role: 'assistant', content: 'Hello from DeepSeek.' } }],
    });
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    const response = await model.complete(baseRequest);

    expect(response).toEqual({ text: 'Hello from DeepSeek.', toolCalls: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        },
      }),
    );
    expect(requestBody(fetchMock)).toEqual({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'Base system prompt.' },
        { role: 'user', content: 'hello' },
      ],
      tools: [],
      thinking: { type: 'disabled' },
    });
  });

  it('parses DeepSeek Tool Calls into Core Tool Calls', async () => {
    mockJsonResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'echo', arguments: '{"text":"hello"}' },
          }],
        },
      }],
    });
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    const response = await model.complete(baseRequest);

    expect(response).toEqual({
      toolCalls: [{
        id: 'call-1' as ToolCallId,
        name: 'echo',
        input: { text: 'hello' },
      }],
    });
  });

  it('maps Core Tool Definitions and honors model and baseUrl overrides', async () => {
    const fetchMock = mockJsonResponse({
      choices: [{ message: { role: 'assistant', content: 'done' } }],
    });
    const model = new DeepSeekModel({
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://deepseek.example/v1/',
    });

    await model.complete({
      ...baseRequest,
      tools: [{
        name: 'echo',
        description: '返回输入文本',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      }],
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://deepseek.example/v1/chat/completions');
    expect(requestBody(fetchMock)).toMatchObject({
      model: 'deepseek-v4-flash',
      tools: [{
        type: 'function',
        function: {
          name: 'echo',
          description: '返回输入文本',
          parameters: { type: 'object', properties: { text: { type: 'string' } } },
        },
      }],
    });
  });

  it('maps assistant Tool Call history to DeepSeek messages', async () => {
    const fetchMock = mockJsonResponse({
      choices: [{ message: { role: 'assistant', content: 'done' } }],
    });
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await model.complete({
      ...baseRequest,
      messages: [{
        role: 'assistant',
        content: 'Calling echo.',
        toolCalls: [{
          id: 'call-1' as ToolCallId,
          name: 'echo',
          input: { text: 'hello' },
        }],
      }],
    });

    expect(requestBody(fetchMock).messages).toEqual([
      { role: 'system', content: 'Base system prompt.' },
      {
        role: 'assistant',
        content: 'Calling echo.',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        }],
      },
    ]);
  });

  it('maps Core Tool Result history to a DeepSeek tool message', async () => {
    const fetchMock = mockJsonResponse({
      choices: [{ message: { role: 'assistant', content: 'done' } }],
    });
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await model.complete({
      ...baseRequest,
      messages: [{
        role: 'tool',
        toolCallId: 'call-1' as ToolCallId,
        content: 'hello',
      }],
    });

    expect(requestBody(fetchMock).messages).toEqual([
      { role: 'system', content: 'Base system prompt.' },
      { role: 'tool', tool_call_id: 'call-1', content: 'hello' },
    ]);
  });

  it('throws a clear error for an HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toThrow(
      'DeepSeek API request failed: 401',
    );
  });

  it('throws a clear error for invalid Tool Call arguments JSON', async () => {
    mockJsonResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'echo', arguments: '{invalid' },
          }],
        },
      }],
    });
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toThrow(
      'DeepSeek API returned invalid tool arguments JSON for echo',
    );
  });

  it('throws a clear error when choices[0].message is missing', async () => {
    mockJsonResponse({ choices: [] });
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toThrow(
      'DeepSeek API response is missing choices[0].message',
    );
  });
});
