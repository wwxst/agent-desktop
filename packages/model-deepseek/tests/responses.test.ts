import { createServer, type ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { DeepSeekModel } from '../src/index.js';
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
      event(res, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '检查完成' }] }] } });
    }
    res.end();
  });
  const model = new DeepSeekModel({ apiKey: 'local-key', baseUrl, model: 'configured-model', protocol: 'responses', maxOutputTokens: 1024 });
  const first = await model.complete(request);
  expect(first.toolCalls).toEqual([{ id: 'call-1', name: 'read_file', input: { path: 'notes.txt' } }]);
  const chunks: string[] = [];
  expect(await model.complete({ ...request, messages: [...request.messages, { role: 'assistant', toolCalls: first.toolCalls }, { role: 'tool', toolCallId: 'call-1' as ToolCallId, content: '文件内容' }], onTextDelta: delta => chunks.push(delta) })).toEqual({ text: '检查完成', toolCalls: [] });
  expect(chunks).toEqual(['检查', '完成']);
  expect(received[1]).toMatchObject({ model: 'configured-model', max_output_tokens: 1024, store: false, instructions: '检查文件', input: [{ role: 'user', content: '检查 notes.txt' }, { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"notes.txt"}' }, { type: 'function_call_output', call_id: 'call-1', output: '文件内容' }] });
});
it('uses configured Chat model and output limit without DeepSeek-only fields for other suppliers', async () => {
  let body!: Record<string, unknown>;
  const baseUrl = await host((value, res, url) => {
    body = value; expect(url).toBe('/v1/chat/completions');
    res.setHeader('Content-Type', 'text/event-stream');
    event(res, { choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] });
    res.end('data: [DONE]\n\n');
  });
  expect(await new DeepSeekModel({ apiKey: 'local-key', baseUrl, model: 'chat-model', maxOutputTokens: 512, disableThinking: false }).complete(request)).toMatchObject({ text: '完成' });
  expect(body).toMatchObject({ model: 'chat-model', max_tokens: 512 });
  expect(body).not.toHaveProperty('thinking');
});
it.each(['truncated', 'incomplete', 'failed'])('rejects an unfinished Responses stream: %s', async status => {
  const baseUrl = await host((_body, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    event(res, { type: 'response.output_text.delta', delta: '部分内容' });
    if (status !== 'truncated') event(res, { type: `response.${status}`, response: { status } });
    res.end();
  });
  await expect(new DeepSeekModel({ apiKey: 'local-key', baseUrl, protocol: 'responses' }).complete(request)).rejects.toThrow(/完成事件|执行失败/);
});
it('cancels an active Responses request with the same turn signal', async () => {
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const baseUrl = await host((_body, res) => { res.setHeader('Content-Type', 'text/event-stream'); event(res, { type: 'response.created' }); started(); });
  const controller = new AbortController();
  const pending = new DeepSeekModel({ apiKey: 'local-key', baseUrl, protocol: 'responses' }).complete({ ...request, signal: controller.signal });
  await active; controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it.each([429, 503, 401, 400])('keeps existing retry and authentication classification for Responses HTTP %s', async status => {
  const baseUrl = await host((_body, res) => { res.writeHead(status, { 'Retry-After': '2' }); res.end(); });
  await expect(new DeepSeekModel({ apiKey: 'local-key', baseUrl, protocol: 'responses' }).complete(request)).rejects.toMatchObject({
    kind: [429, 503].includes(status) ? 'transient-service' : status === 401 ? 'authentication' : 'invalid-request', statusCode: status, retryAfterMs: 2000,
  });
});
