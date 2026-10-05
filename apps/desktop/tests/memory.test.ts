import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteMemories, loadMemories, saveMemory } from '../src/main/memory.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('desktop memories', () => {
  it('persists entries and clears all entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-desktop-memory-'));
    directories.push(directory);
    const database = join(directory, 'desktop.sqlite');
    const entry = saveMemory(database, '用户偏好简洁的中文回答。', 'conversation');
    expect(loadMemories(database)).toEqual([entry]);
    expect(() => saveMemory(database, '  ', 'tool')).toThrow('不能为空');
    deleteMemories(database);
    expect(loadMemories(database)).toEqual([]);
  });
});
