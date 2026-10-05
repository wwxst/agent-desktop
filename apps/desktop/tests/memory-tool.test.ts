import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SaveMemoryTool } from '../src/main/memory-tool.js';
import { loadMemories } from '../src/main/memory.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('save_memory tool', () => {
  it('blocks tool-chat memory when the setting is disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-memory-tool-'));
    directories.push(directory);
    const database = join(directory, 'desktop.sqlite');
    const tool = new SaveMemoryTool(database, () => 'tool', false);
    await expect(tool.execute({ content: '不要写入' }, { toolCallId: 'memory-call' as never, reportProgress: () => undefined })).resolves.toMatchObject({ status: 'error' });
    expect(loadMemories(database)).toEqual([]);
  });
});
