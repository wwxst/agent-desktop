import { createServer, type ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenAICompatibleModel } from '../src/index.js';

const modelOptions = { model: 'fixture-model', baseUrl: 'https://example.test/v1' };
import type { ModelRequest, ToolCallId } from '@agent-desktop/model';

const request: ModelRequest = { systemPrompt: '检查文件', messages: [{ role: 'user', content: '检查 notes.txt' }], tools: [{ name: 'read_file', description: '读取文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] };
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function host(handle: (body: Record<string, unknown>, response: ServerResponse, url: string) => void) {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    expect(req.headers.authorization).toBe('Bearer local-key');
    handle(JSON.parse(raw) as Record<string, unknown>, res, req.url!);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server port');
  return `http://127.0.0.1:${address.port}/v1`;
}
function event(response: ServerResponse, payload: unknown) { response.write(`data: ${JSON.stringify(payload)}\r\n\r\n`); }
it('streams text and round trips function calls through real Responses HTTP', async () => {
  const received: Record<string, unknown>[] = [];
  const baseUrl = await host((body, res, url) => {
    expect(url).toBe('/v1/responses'); received.push(body);
    res.setHeader('Content-Type', 'text/event-stream');
    if (received.length === 1) event(res, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"notes.txt"}' }] } });
    else {
      event(res, { type: 'response.output_text.delta', delta: '检查' });
      event(res, { type: 'response.output_text.delta', delta: '完成' });
      event(res, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '检查完成' }] }], usage: { input_tokens: 73, output_tokens: 12 } } });
    }
    res.end();
  });
  const model = new OpenAICompatibleModel({ ...modelOptions, apiKey: 'local-key', baseUrl, model: 'configured-model', protocol: 'responses', maxOutputTokens: 1024 });
  const first = await model.complete(request);
  expect(first.toolCalls).toEqual([{ id: 'call-1', name: 'read_file', input: { path: 'notes.txt' } }]);
  const chunks: string[] = [];
  expect(await model.complete({ ...request, messages: [...request.messages, { role: 'assistant', toolCalls: first.toolCalls }, { role: 'tool', toolCallId: 'call-1' as ToolCallId, content: '文件内容' }], onTextDelta: delta => chunks.push(delta) })).toEqual({ text: '检查完成', toolCalls: [], usage: { inputTokens: 73, outputTokens: 12 } });
  expect(chunks).toEqual(['检查', '完成']);
  expect(received[1]).toMatchObject({ model: 'configured-model', max_output_tokens: 1024, store: false, instructions: '检查文件', input: [{ role: 'user', content: '检查 notes.txt' }, { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"notes.txt"}' }, { type: 'function_call_output', call_id: 'call-1', output: '文件内容' }] });
});
it('authorizes Responses requests before opening the HTTP stream', async () => {
  const baseUrl = await host((_body, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    event(res, { type: 'response.completed', response: { status: 'completed', output: [] } }); res.end();
  });
  const authorizeNetwork = vi.fn(async (_request: { readonly url: string; readonly method?: string }, _signal?: AbortSignal) => {});
  await new OpenAICompatibleModel({ ...modelOptions, apiKey: 'local-key', baseUrl, protocol: 'responses', authorizeNetwork }).complete(request);
  expect(authorizeNetwork).toHaveBeenCalledWith({ url: `${baseUrl}/responses`, method: 'POST' }, undefined);
});
it('uses configured Chat model and output limit without DeepSeek-only fields for other suppliers', async () => {
  let body!: Record<string, unknown>;
  const baseUrl = await host((value, res, url) => {
    body = value; expect(url).toBe('/v1/chat/completions');
    res.setHeader('Content-Type', 'text/event-stream');
    event(res, { choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] });
    res.end('data: [DONE]\n\n');
  });
  expect(await new OpenAICompatibleModel({ ...modelOptions, apiKey: 'local-key', baseUrl, model: 'chat-model', maxOutputTokens: 512 }).complete(request)).toMatchObject({ text: '完成' });
  expect(body).toMatchObject({ model: 'chat-model', max_tokens: 512 });
  expect(body).not.toHaveProperty('thinking');
});
it.each(['chat-completions', 'responses'] as const)('uses separate summary and normal output caps without mutating the configured default: %s', async protocol => {
  const received: Record<string, unknown>[] = [];
  const baseUrl = await host((body, res, url) => {
    expect(url).toBe(protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions');
    received.push(body);
    res.setHeader('Content-Type', 'text/event-stream');
    if (protocol === 'responses') event(res, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }] } });
    else event(res, { choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] });
    res.end(protocol === 'responses' ? '' : 'data: [DONE]\n\n');
  });
  const model = new OpenAICompatibleModel({ ...modelOptions, apiKey: 'local-key', baseUrl, protocol, maxOutputTokens: 4096 });
  await model.complete({ ...request, tools: [], maxOutputTokens: 192 });
  await model.complete({ ...request, maxOutputTokens: 768 });
  await model.complete(request);
  const field = protocol === 'responses' ? 'max_output_tokens' : 'max_tokens';
  expect(received.map(body => body[field])).toEqual([192, 768, 4096]);
  expect(received[0]?.tools).toEqual([]);
  expect(received[1]?.tools).toHaveLength(1);
  for (const body of received) expect(body).not.toHaveProperty(protocol === 'responses' ? 'max_tokens' : 'max_output_tokens');
});
it.each(['chat-completions', 'responses'] as const)('uses request-only output caps and preserves absent limits: %s', async protocol => {
  const received: Record<string, unknown>[] = [];
  const baseUrl = await host((body, res) => {
    received.push(body);
    res.setHeader('Content-Type', 'text/event-stream');
    if (protocol === 'responses') event(res, { type: 'response.completed', response: { status: 'completed', output: [] } });
    else event(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
    res.end(protocol === 'responses' ? '' : 'data: [DONE]\n\n');
  });
  const model = new OpenAICompatibleModel({ ...modelOptions, apiKey: 'local-key', baseUrl, protocol });
  await model.complete({ ...request, maxOutputTokens: 128 });
  await model.complete(request);
  const field = protocol === 'responses' ? 'max_output_tokens' : 'max_tokens';
  expect(received[0]?.[field]).toBe(128);
  expect(received[1]).not.toHaveProperty(field);
});
it.each(['truncated', 'incomplete', 'failed'])('rejects an unfinished Responses stream: %s', async status => {
  const baseUrl = await host((_body, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    event(res, { type: 'response.output_text.delta', delta: '部分内容' });
    if (status !== 'truncated') event(res, { type: `response.${status}`, response: { status } });
    res.end();
  });
  await expect(new OpenAICompatibleModel({ ...modelOptions, apiKey: 'local-key', baseUrl, protocol: 'responses' }).complete(request)).rejects.toThrow(/完成事件|执行失败/);
});
it('cancels an active Responses request with the same turn signal', async () => {
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const baseUrl = await host((_body, res) => { res.setHeader('Content-Type', 'text/event-stream'); event(res, { type: 'response.created' }); started(); });
  const controller = new AbortController();
  const pending = new OpenAICompatibleModel({ ...modelOptions, apiKey: 'local-key', baseUrl, protocol: 'responses' }).complete({ ...request, signal: controller.signal });
  await active; controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it.each([429, 503, 401, 400])('keeps existing retry and authentication classification for Responses HTTP %s', async status => {
  const baseUrl = await host((_body, res) => { res.writeHead(status, { 'Retry-After': '2' }); res.end(); });
  await expect(new OpenAICompatibleModel({ ...modelOptions, apiKey: 'local-key', baseUrl, protocol: 'responses' }).complete(request)).rejects.toMatchObject({
    kind: [429, 503].includes(status) ? 'transient-service' : status === 401 ? 'authentication' : 'invalid-request', statusCode: status, retryAfterMs: 2000,
  });
});
