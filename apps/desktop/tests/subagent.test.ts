import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequest } from '@agent-desktop/model';
import { runReadOnlySubagent, type SubagentRecord } from '../src/main/subagent.js';

const fake = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('@agent-desktop/model-deepseek', () => ({ DeepSeekModel: class { complete = fake.complete; } }));
afterEach(() => { vi.useRealTimers(); fake.complete.mockReset(); });
const context = { toolCallId: 'parent' as never, reportProgress: () => {} };

describe('desktop read-only child execution', () => {
  it('uses an isolated session and the exact read-only registry and preserves file evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'child-acceptance-'));
    try {
      await writeFile(join(directory, 'notes.txt'), 'checked content');
      fake.complete.mockResolvedValueOnce({ toolCalls: [{ id: 'read' as never, name: 'read_file', input: { filePath: 'notes.txt' } }] })
        .mockResolvedValueOnce({ text: 'notes.txt 内容为 checked content', toolCalls: [] });
      const records: SubagentRecord[] = [];
      expect(await runReadOnlySubagent({ title: '检查', instruction: '只检查 notes.txt' }, context, directory,
        { deepSeekApiKey: 'fixture' }, vi.fn(), (record) => records.push(record))).toMatchObject({ status: 'completed', evidence: [await realpath(join(directory, 'notes.txt'))] });
      const request = fake.complete.mock.calls[0]![0] as ModelRequest;
      expect(request.tools.map((tool) => tool.name)).toEqual(['list_directory', 'read_file', 'search_text']);
      expect(request.messages).toEqual([{ role: 'user', content: '只检查 notes.txt' }]);
      expect(records[0]!.parentToolCallId).toBe('parent');
      expect(records[0]!.events.some((event) => event.type === 'tool.result')).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('does not mark an unsupported write attempt or an ungrounded reply completed', async () => {
    fake.complete.mockResolvedValueOnce({ toolCalls: [{ id: 'write' as never, name: 'write_text_file', input: {} }] })
      .mockResolvedValueOnce({ text: '已完成', toolCalls: [] });
    const save = vi.fn();
    expect(await runReadOnlySubagent({ title: '检查', instruction: '检查文件' }, context, process.cwd(),
      { deepSeekApiKey: 'fixture' }, vi.fn(), save)).toMatchObject({ status: 'failed', evidence: [] });
    expect(save.mock.calls[0]![0].events).toContainEqual(expect.objectContaining({ type: 'tool.result', result: { status: 'error', message: 'Tool not found: write_text_file' } }));
  });
  it('enforces the eight-step and time budgets and saves an unfinished result', async () => {
    fake.complete.mockResolvedValue({ toolCalls: [{ id: 'x' as never, name: 'unknown', input: {} }] });
    const first = await runReadOnlySubagent({ title: '检查', instruction: '检查文件' }, context, process.cwd(), { deepSeekApiKey: 'fixture' }, vi.fn(), vi.fn());
    expect(first.status).toBe('budget-exhausted'); expect(fake.complete).toHaveBeenCalledTimes(8);
    fake.complete.mockReset(); vi.useFakeTimers();
    fake.complete.mockImplementation((request: ModelRequest) => new Promise((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const waiting = runReadOnlySubagent({ title: '检查', instruction: '检查文件' }, context, process.cwd(), { deepSeekApiKey: 'fixture' }, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await waiting).toMatchObject({ status: 'budget-exhausted', summary: expect.stringContaining('120 秒') });
  });
});
