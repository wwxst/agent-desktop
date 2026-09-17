import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequest, ToolCallId } from '@agent-desktop/model';
import { DeepSeekModel } from '../src/index.js';

const baseRequest: ModelRequest = {
  systemPrompt: 'Base system prompt.',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
};

/** 把若干 SSE 事件编码成标准 LF 流；每个事件以空行结束。 */
function sseBody(events: readonly string[]): string {
  return events.map((event) => `data: ${event}\n\n`).join('');
}

/** 用已编码字节构造响应，便于验证跨 chunk 的多字节 UTF-8 解码。 */
function byteResponse(chunks: readonly Uint8Array[], init?: ResponseInit): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, ...init });
}

function streamResponse(chunks: readonly (string | Uint8Array)[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  return byteResponse(
    chunks.map((chunk) => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk)),
    init,
  );
}

/**
 * 故意不关闭的响应体：用于验证 [DONE] 到达后立即结束，而不是等待 HTTP body EOF。
 * 若实现等待 body 关闭，该测试会因超时而失败。
 */
function openResponse(body: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
    },
  });
  return new Response(stream, { status: 200 });
}

function stubResponse(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== 'string') throw new Error('Expected JSON request body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

/**
 * 单个 SSE choice 分片的负载。
 * 真实协议里 delta（增量）与 finish_reason（终止原因）是同级字段，
 * 终止分片只带 finish_reason；finish_reason 为 undefined 时 JSON 会省略该键。
 */
function choiceEvent(delta: unknown, finishReason?: string): string {
  return JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeepSeekModel', () => {
  it('passes the Turn AbortSignal to fetch', async () => {
    const fetchMock = stubResponse(streamResponse([sseBody([choiceEvent({ content: 'ok' }), choiceEvent({}, 'stop'), '[DONE]'])]));
    const controller = new AbortController();
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await model.complete({ systemPrompt: 'test', messages: [], tools: [], signal: controller.signal });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });

  it('requests an SSE stream and maps a Core request and plain text response', async () => {
    const fetchMock = stubResponse(streamResponse([
      sseBody([choiceEvent({ role: 'assistant', content: 'Hello from DeepSeek.' }), choiceEvent({}, 'stop'), '[DONE]']),
    ]));
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
      stream: true,
    });
  });

  it('accumulates text across deltas and reports each increment without changing the result', async () => {
    stubResponse(streamResponse([
      sseBody([
        choiceEvent({ content: '你' }),
        choiceEvent({ content: '好' }),
        choiceEvent({ content: '' }),
        // 终止分片只带 finish_reason，且与 delta 同级。
        choiceEvent({}, 'stop'),
        '[DONE]',
      ]),
    ]));
    const deltas: string[] = [];
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    const response = await model.complete({
      ...baseRequest,
      onTextDelta: (delta) => deltas.push(delta),
    });

    // 空增量没有展示价值，也不进入完整文本。
    expect(deltas).toEqual(['你', '好']);
    expect(response).toEqual({ text: '你好', toolCalls: [] });
  });

  it('omits text when the stream only carries empty content deltas', async () => {
    stubResponse(streamResponse([sseBody([choiceEvent({ content: '' }), choiceEvent({}, 'stop'), '[DONE]'])]));
    const deltas: string[] = [];
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    const response = await model.complete({ ...baseRequest, onTextDelta: (delta) => deltas.push(delta) });

    expect(deltas).toEqual([]);
    expect(response).toEqual({ toolCalls: [] });
  });

  it('parses SSE events terminated with CRLF line endings', async () => {
    stubResponse(streamResponse([
      `data: ${choiceEvent({ content: 'crlf' })}\r\n\r\ndata: ${choiceEvent({}, 'stop')}\r\n\r\ndata: [DONE]\r\n\r\n`,
    ]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).resolves.toEqual({ text: 'crlf', toolCalls: [] });
  });

  it('decodes a multi-byte UTF-8 character split across chunks', async () => {
    const encoder = new TextEncoder();
    const payload = sseBody([choiceEvent({ content: '中文内容' }), choiceEvent({}, 'stop'), '[DONE]']);
    const bytes = encoder.encode(payload);
    // 0xE4 是 '中' 的三字节序列首字节；在这里切开必然落在字符内部。
    const splitAt = bytes.indexOf(0xe4) + 1;

    stubResponse(byteResponse([bytes.slice(0, splitAt), bytes.slice(splitAt)]));
    const deltas: string[] = [];
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    const response = await model.complete({ ...baseRequest, onTextDelta: (delta) => deltas.push(delta) });

    expect(response).toEqual({ text: '中文内容', toolCalls: [] });
    expect(deltas).toEqual(['中文内容']);
  });

  it('finishes as soon as [DONE] arrives without waiting for the body to close', async () => {
    stubResponse(openResponse(sseBody([choiceEvent({ content: 'done early' }), choiceEvent({}, 'stop'), '[DONE]'])));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).resolves.toEqual({ text: 'done early', toolCalls: [] });
  });

  it('fails when the stream ends before [DONE]', async () => {
    stubResponse(streamResponse([sseBody([choiceEvent({ content: 'truncated' })])]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toThrow(
      'DeepSeek API stream ended before [DONE]',
    );
  });

  it('fails when the stream ends without any choices chunk', async () => {
    stubResponse(streamResponse([sseBody(['[DONE]'])]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toThrow(
      'DeepSeek API stream ended without a choices chunk',
    );
  });

  it('completes when the stream terminates with finish_reason stop', async () => {
    stubResponse(streamResponse([
      sseBody([choiceEvent({ content: '完整回复' }), choiceEvent({}, 'stop'), '[DONE]']),
    ]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).resolves.toEqual({ text: '完整回复', toolCalls: [] });
  });

  it('fails when the stream ends without a terminating finish_reason', async () => {
    stubResponse(streamResponse([
      sseBody([choiceEvent({ content: '没有终止原因' }), '[DONE]']),
    ]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toThrow(
      'DeepSeek API stream ended without a terminating finish_reason',
    );
  });

  it('does not accept a finish_reason nested inside delta as the choice terminator', async () => {
    stubResponse(streamResponse([
      // 旧实现把 finish_reason 当成 delta 的字段读取；协议要求它与 delta 同级。
      sseBody([choiceEvent({ content: '嵌套终止原因', finish_reason: 'stop' }), '[DONE]']),
    ]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toThrow(
      'DeepSeek API stream ended without a terminating finish_reason',
    );
  });

  it.each(['length', 'content_filter', 'insufficient_system_resource'])(
    'fails when the server terminates the stream with finish_reason %s',
    async (finishReason) => {
      stubResponse(streamResponse([
        sseBody([choiceEvent({ content: '部分文本' }), choiceEvent({}, finishReason), '[DONE]']),
      ]));
      const model = new DeepSeekModel({ apiKey: 'test-key' });
      const deltas: string[] = [];

      // 增量已经上报给展示层，但 Provider 必须拒绝，不能把部分文本当成完整 Model Response 返回。
      await expect(model.complete({ ...baseRequest, onTextDelta: (delta) => deltas.push(delta) }))
        .rejects.toThrow(`DeepSeek API stream terminated with finish_reason ${finishReason}`);
      expect(deltas).toEqual(['部分文本']);
    },
  );

  it('reports a server-side aborted termination as a plain Error instead of an AbortError', async () => {
    stubResponse(streamResponse([
      sseBody([choiceEvent({ content: '部分文本' }), choiceEvent({}, 'aborted'), '[DONE]']),
    ]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    // 服务端 finish_reason=aborted 属于协议级失败，不是客户端取消，必须用普通 Error 与 AbortError 区分。
    await expect(model.complete(baseRequest)).rejects.toMatchObject({
      name: 'Error',
      message: 'DeepSeek API stream terminated with finish_reason aborted',
    });
  });

  it.each(['length', 'aborted'])(
    'keeps the first non-successful finish_reason %s even when a later stop follows',
    async (finishReason) => {
      stubResponse(streamResponse([
        sseBody([
          choiceEvent({ content: '部分文本' }),
          choiceEvent({}, finishReason),
          choiceEvent({}, 'stop'),
          '[DONE]',
        ]),
      ]));
      const model = new DeepSeekModel({ apiKey: 'test-key' });

      // 先出现的失败终止原因不能被后面的 stop 覆盖，否则截断会被当成部分成功返回。
      await expect(model.complete(baseRequest)).rejects.toThrow(
        `DeepSeek API stream terminated with finish_reason ${finishReason}`,
      );
    },
  );

  it('parses streamed Tool Call fragments into Core Tool Calls', async () => {
    stubResponse(streamResponse([
      sseBody([
        choiceEvent({
          tool_calls: [{
            index: 0,
            id: 'call-1',
            type: 'function',
            function: { name: 'echo', arguments: '{"text":' },
          }],
        }),
        choiceEvent({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] }),
        choiceEvent({}, 'tool_calls'),
        '[DONE]',
      ]),
    ]));
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

  it('orders streamed Tool Calls by index and concatenates arguments in arrival order', async () => {
    stubResponse(streamResponse([
      sseBody([
        choiceEvent({
          tool_calls: [
            { index: 1, id: 'call-b', function: { name: 'second', arguments: '{"b":' } },
            { index: 0, id: 'call-a', function: { name: 'first', arguments: '{"a":' } },
          ],
        }),
        choiceEvent({
          tool_calls: [
            { index: 1, function: { arguments: '2}' } },
            { index: 0, function: { arguments: '1}' } },
          ],
        }),
        choiceEvent({}, 'tool_calls'),
        '[DONE]',
      ]),
    ]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    const response = await model.complete(baseRequest);

    expect(response.toolCalls).toEqual([
      { id: 'call-a' as ToolCallId, name: 'first', input: { a: 1 } },
      { id: 'call-b' as ToolCallId, name: 'second', input: { b: 2 } },
    ]);
  });

  it('keeps Tool Call identity when later fragments repeat it as empty', async () => {
    stubResponse(streamResponse([
      sseBody([
        choiceEvent({
          tool_calls: [{
            index: 0,
            id: 'call-keep',
            function: { name: 'echo', arguments: '{' },
          }],
        }),
        choiceEvent({ tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '}' } }] }),
        choiceEvent({}, 'tool_calls'),
        '[DONE]',
      ]),
    ]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    const response = await model.complete(baseRequest);

    expect(response.toolCalls).toEqual([{
      id: 'call-keep' as ToolCallId,
      name: 'echo',
      input: {},
    }]);
  });

  it('fails for a streamed Tool Call fragment without a valid index', async () => {
    stubResponse(streamResponse([
      sseBody([
        choiceEvent({ tool_calls: [{ id: 'call-1', function: { name: 'echo', arguments: '{}' } }] }),
        '[DONE]',
      ]),
    ]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toThrow(
      'DeepSeek API streamed Tool Call is missing a valid index',
    );
  });

  it('fails for a negative streamed Tool Call index', async () => {
    stubResponse(streamResponse([
      sseBody([
        choiceEvent({
          tool_calls: [{ index: -1, id: 'call-1', function: { name: 'echo', arguments: '{}' } }],
        }),
        '[DONE]',
      ]),
    ]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toThrow(
      'DeepSeek API streamed Tool Call is missing a valid index',
    );
  });

  it('fails when a streamed Tool Call is missing its id', async () => {
    stubResponse(streamResponse([
      sseBody([
        choiceEvent({ tool_calls: [{ index: 0, function: { name: 'echo', arguments: '{}' } }] }),
        // 终止原因合法，才能走到 Tool Call 身份校验这一步。
        choiceEvent({}, 'tool_calls'),
        '[DONE]',
      ]),
    ]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toThrow(
      'DeepSeek API streamed Tool Call is missing id',
    );
  });

  it('fails when a streamed Tool Call is missing its name', async () => {
    stubResponse(streamResponse([
      sseBody([
        choiceEvent({ tool_calls: [{ index: 0, id: 'call-1', function: { arguments: '{}' } }] }),
        choiceEvent({}, 'tool_calls'),
        '[DONE]',
      ]),
    ]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toThrow(
      'DeepSeek API streamed Tool Call is missing name',
    );
  });

  it('throws a clear error for invalid streamed Tool Call arguments JSON', async () => {
    stubResponse(streamResponse([
      sseBody([
        choiceEvent({
          tool_calls: [{
            index: 0,
            id: 'call-1',
            function: { name: 'echo', arguments: '{invalid' },
          }],
        }),
        choiceEvent({}, 'tool_calls'),
        '[DONE]',
      ]),
    ]));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toThrow(
      'DeepSeek API returned invalid tool arguments JSON for echo',
    );
  });

  it('does not swallow an AbortError raised by the stream reader', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    const stream = new ReadableStream<Uint8Array>({
      pull() { throw abortError; },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toBe(abortError);
  });

  it('still rejects after [DONE] when the Turn was cancelled', async () => {
    stubResponse(streamResponse([
      sseBody([choiceEvent({ content: 'partial' }), choiceEvent({}, 'stop'), '[DONE]']),
    ]));
    const controller = new AbortController();
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete({
      ...baseRequest,
      signal: controller.signal,
      // 取消发生在流结束标记到达之前，返回结果前必须再次检查取消状态。
      onTextDelta: () => controller.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('maps Core Tool Definitions and honors model and baseUrl overrides', async () => {
    const fetchMock = stubResponse(streamResponse([
      sseBody([choiceEvent({ content: 'done' }), choiceEvent({}, 'stop'), '[DONE]']),
    ]));
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
    const fetchMock = stubResponse(streamResponse([sseBody([choiceEvent({ content: 'done' }), choiceEvent({}, 'stop'), '[DONE]'])]));
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
    const fetchMock = stubResponse(streamResponse([sseBody([choiceEvent({ content: 'done' }), choiceEvent({}, 'stop'), '[DONE]'])]));
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

  it('throws a clear error for an invalid SSE data payload', async () => {
    stubResponse(streamResponse(['data: {not json\n\n', 'data: [DONE]\n\n']));
    const model = new DeepSeekModel({ apiKey: 'test-key' });

    await expect(model.complete(baseRequest)).rejects.toThrow(
      'DeepSeek API stream returned an invalid SSE data payload',
    );
  });
});
