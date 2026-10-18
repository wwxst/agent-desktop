import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContextSourceDigest, runTurn, validateContextCompactedEvent } from '@agent-desktop/agent-loop';
import { OpenAICompatibleModel } from '@agent-desktop/model-deepseek';
import type { ToolCallId } from '@agent-desktop/model';
import { InMemorySession, type ContextCompactedEvent, type SessionEvent, type StepId, type TurnId } from '@agent-desktop/session';
import { InMemoryToolRegistry } from '@agent-desktop/tools';
import { writeDesktopDocuments } from '../src/main/desktop-database.js';
import { loadDesktopState, parseDesktopState, saveDesktopState } from '../src/main/session-persistence.js';

const directories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const root = 'original-turn' as TurnId;
const rule = '只读资料，不覆盖文件；输出必须保留证据。';
const systemPrompt = '遵守用户约束，只依据真实工具事实完成任务。';

function stateFor(events: readonly SessionEvent[]) {
  return parseDesktopState({
    activeSessionId: 'session', sessions: [{ id: 'session', attachments: [], events }],
    clientState: { activeSessionId: 'session', conversations: [{ id: 'session', title: '资料检查',
      titleManuallyRenamed: false, prompt: '', attachments: [], messages: [] }] },
  });
}
async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-context-'));
  directories.push(directory);
  return join(directory, 'agent-desktop.sqlite');
}
function history(): SessionEvent[] {
  const events: SessionEvent[] = [{ type: 'turn.started', turnId: root }, { type: 'user.message', turnId: root, content: rule }];
  for (let offset = 0; offset < 5; offset += 1) {
    const stepId = `read-step-${offset}` as StepId;
    const toolCallId = `read-call-${offset}` as ToolCallId;
    events.push(
      { type: 'step.started', turnId: root, stepId },
      { type: 'assistant.message', turnId: root, stepId, toolCalls: [{ id: toolCallId, name: 'read', input: { path: `data/${offset}` } }] },
      { type: 'tool.called', turnId: root, stepId, toolCallId, name: 'read', input: { path: `data/${offset}` }, boundary: 'read-only' },
      { type: 'tool.result', turnId: root, stepId, toolCallId, result: { status: 'success', output: `原始事实-${offset}:` + 'x'.repeat(1400) } },
      { type: 'step.completed', turnId: root, stepId },
    );
  }
  events.push({ type: 'turn.completed', turnId: root });
  return events;
}
function stream(response: ServerResponse, text: string, protocol: 'chat-completions' | 'responses') {
  response.setHeader('Content-Type', 'text/event-stream');
  const value = protocol === 'responses'
    ? { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } }
    : { choices: [{ delta: { content: text }, finish_reason: 'stop' }] };
  response.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
  response.end(protocol === 'responses' ? '' : 'data: [DONE]\n\n');
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('persisted model context', () => {
  it.each(['chat-completions', 'responses'] as const)('keeps summary provenance, complete tool pairs and request caps through SQLite restart: %s', async protocol => {
    const received: { body: Record<string, unknown>; summary: boolean }[] = [];
    const server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe('Bearer local-key');
      expect(request.url).toBe(protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions');
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text) as Record<string, unknown>;
      const summary = (body.tools as unknown[]).length === 0;
      received.push({ body, summary });
      if (summary) {
        const sourceMessages = (protocol === 'responses' ? body.input : body.messages) as { role: string; content: string }[];
        const source = JSON.parse(sourceMessages.find(item => item.role === 'user')!.content) as {
          previousSummaryText: string | null; newStepSources: { sourceEventIndex: number }[];
        };
        const prior = source.previousSummaryText === null ? []
          : (JSON.parse(source.previousSummaryText) as { sourceEventIndexes: number[] }).sourceEventIndexes;
        stream(response, JSON.stringify({ summary: '旧资料检查事实及来源已保留。',
          sourceEventIndexes: [...prior, ...source.newStepSources.map(item => item.sourceEventIndex)] }), protocol);
      } else stream(response, '检查完成，原文件未修改。', protocol);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('测试 HTTP 地址缺失。');
    const model = new OpenAICompatibleModel({ apiKey: 'local-key', model: 'fixture-model', protocol,
      baseUrl: `http://127.0.0.1:${address.port}/v1`, maxOutputTokens: 4096, disableThinking: false });
    const tools = new InMemoryToolRegistry();
    tools.register({ name: 'read', description: '读取资料', inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      contract: { approvalRequirement: 'none' },
      execute: async () => { throw new Error('本测试不会重放历史工具。'); } });
    const original = history();
    const session = new InMemorySession(original);
    const budget = { contextWindow: 7000, maxOutputTokens: 800 };
    await runTurn({ model, session, tools, systemPrompt: { build: () => systemPrompt } }, '继续检查。', { contextBudget: budget });
    expect(session.events().slice(0, original.length)).toEqual(original);
    const summaryIndex = session.events().findLastIndex(event => event.type === 'context.compacted');
    const validated = validateContextCompactedEvent(session.events(), summaryIndex);
    expect(validated.cumulativeCoveredStepEndEventIndexes).toEqual([6, 11, 16]);

    const path = await databasePath();
    await saveDesktopState(path, stateFor(session.events()));
    const restored = (await loadDesktopState(path))!.sessions[0]!.events;
    expect(restored).toEqual(session.events());
    expect(validateContextCompactedEvent(restored, summaryIndex)).toEqual(validated);
    const reloaded = new InMemorySession(restored);
    const countBeforeRestart = received.filter(item => item.summary).length;
    await runTurn({ model, session: reloaded, tools, systemPrompt: { build: () => systemPrompt } }, '确认此前结果。',
      { contextBudget: { contextWindow: 10000, maxOutputTokens: 800 } });
    expect(received.filter(item => item.summary)).toHaveLength(countBeforeRestart);
    const normal = received.filter(item => !item.summary);
    expect(normal).toHaveLength(2);
    for (const { body } of received) {
      expect(body[protocol === 'responses' ? 'max_output_tokens' : 'max_tokens']).toBe(800);
      expect(body).not.toHaveProperty(protocol === 'responses' ? 'max_tokens' : 'max_output_tokens');
    }
    for (const { body } of normal) {
      const encoded = JSON.stringify(body);
      expect(encoded).toContain(rule);
      expect(encoded).toContain(validated.event.sourceDigest);
      expect(encoded).toContain('旧资料检查事实及来源已保留。');
      expect(body.tools as unknown[]).toHaveLength(1);
      if (protocol === 'responses') {
        const input = body.input as { type?: string; call_id?: string }[];
        expect(input.filter(item => item.type === 'function_call').map(item => item.call_id)).toEqual(['read-call-3', 'read-call-4']);
        expect(input.filter(item => item.type === 'function_call_output').map(item => item.call_id)).toEqual(['read-call-3', 'read-call-4']);
      } else {
        const messages = body.messages as { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
        expect(messages.flatMap(item => item.tool_calls?.map(call => call.id) ?? [])).toEqual(['read-call-3', 'read-call-4']);
        expect(messages.filter(item => item.role === 'tool').map(item => item.tool_call_id)).toEqual(['read-call-3', 'read-call-4']);
      }
    }
  });

  it('rejects changed source facts and invalid summary references read from real SQLite', async () => {
    const original = history();
    const event: ContextCompactedEvent = { type: 'context.compacted', turnId: root,
      coveredStepEndEventIndexes: [6], sourceDigest: createContextSourceDigest(original, [6]),
      summary: JSON.stringify({ summary: '原始资料事实', sourceEventIndexes: [3, 5] }),
      estimatorVersion: 1, estimatedBefore: 9000, estimatedAfter: 6000 };
    const valid = stateFor([...original, event]);
    const path = await databasePath();
    await saveDesktopState(path, valid);
    expect((await loadDesktopState(path))!.sessions[0]!.events.at(-1)).toEqual(event);

    const changed = [...original];
    const result = changed[5];
    if (result?.type !== 'tool.result') throw new Error('测试工具结果缺失。');
    changed[5] = { ...result, result: { status: 'success', output: '摘要保存后被改写的事实' } };
    writeDesktopDocuments(path, [{ name: 'session-state', value: { ...valid, sessions: [{ ...valid.sessions[0], events: [...changed, event] }] } }]);
    await expect(loadDesktopState(path)).rejects.toThrow('原始事实不一致');
    writeDesktopDocuments(path, [{ name: 'session-state', value: { ...valid, sessions: [{ ...valid.sessions[0], events: [...original,
      { ...event, summary: JSON.stringify({ summary: '越界引用', sourceEventIndexes: [1] }) }] }] } }]);
    await expect(loadDesktopState(path)).rejects.toThrow('引用超出覆盖来源');
  });
});
