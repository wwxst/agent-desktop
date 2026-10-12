import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';
import { adaptWhisperTool, type WhisperFileAccess } from '../src/main/whisper-tool.js';

const context: ToolExecutionContext = { toolCallId: 'whisper-test' as never, reportProgress: () => {} };
const roots: string[] = [];
const rawTool = (result: Awaited<ReturnType<Tool['execute']>>): Tool => ({
  name: 'p_whisper_whisper_transcribe_audio', description: 'Whisper', inputSchema: {},
  execute: vi.fn(async () => result),
});

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('Whisper host adapter', () => {
  it('preserves the public transcript contract and canonicalizes an authorized path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whisper-adapter-')); roots.push(root);
    const audio = join(root, '中文 audio.wav'); await writeFile(audio, 'RIFF fixture');
    const raw = rawTool({ status: 'success', output: { structuredContent: {
      text: '你好 world', segments: [{ start: 0, end: 1.2, text: '你好' }, { start: 1.2, end: 2.4, text: 'world' }],
    } } });
    const access: WhisperFileAccess = { workspace: { confirmedDirectory: () => root }, attachments: () => [], events: () => [] };

    await expect(adaptWhisperTool(raw, access).execute({ audioPath: audio }, context)).resolves.toEqual({
      status: 'success', output: { text: '你好 world', segments: [{ start: 0, end: 1.2, text: '你好' }, { start: 1.2, end: 2.4, text: 'world' }] },
    });
    expect(raw.execute).toHaveBeenCalledWith({ audioPath: await import('node:fs/promises').then(({ realpath }) => realpath(audio)) }, context);
  });

  it('rejects URLs, directory escapes and malformed MCP timelines before exposing success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whisper-boundary-')); roots.push(root);
    const raw = rawTool({ status: 'success', output: { structuredContent: { text: 'ok', segments: [] } } });
    const access: WhisperFileAccess = { workspace: { confirmedDirectory: () => root }, attachments: () => [], events: () => [] };
    const adapted = adaptWhisperTool(raw, access);

    await expect(adapted.execute({ audioPath: 'https://example.com/a.wav' }, context)).resolves.toMatchObject({ status: 'error' });
    await expect(adapted.execute({ audioPath: join(tmpdir(), 'outside.wav') }, context)).resolves.toMatchObject({ status: 'error' });
    const audio = join(root, 'audio.wav'); await writeFile(audio, 'RIFF fixture');
    const malformed = rawTool({ status: 'success', output: { structuredContent: {
      text: 'ok', segments: [{ start: 2, end: 1, text: 'bad' }],
    } } });
    await expect(adaptWhisperTool(malformed, access).execute({ audioPath: audio }, context)).resolves.toMatchObject({ status: 'error' });
    expect(raw.execute).not.toHaveBeenCalled();
  });

  it('keeps cancellation as cancellation and does not turn it into a tool error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whisper-cancel-')); roots.push(root);
    const audio = join(root, 'audio.wav'); await writeFile(audio, 'RIFF fixture');
    const controller = new AbortController(); controller.abort();
    const raw = rawTool({ status: 'success', output: { structuredContent: { text: 'ok', segments: [] } } });
    const access: WhisperFileAccess = { workspace: { confirmedDirectory: () => root }, attachments: () => [], events: () => [] };
    await expect(adaptWhisperTool(raw, access).execute({ audioPath: audio }, { ...context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(raw.execute).not.toHaveBeenCalled();
  });
});
