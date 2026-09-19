import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '@agent-desktop/model';
import { ListDirectoryTool, type WorkspacePort } from '../src/index.js';

/** 真实目录里的真实条目：列目录的价值就在于名字、路径和类型都来自文件系统。 */
let base: string;
let root: string;
let outside: string;

const real = (path: string) => realpath(path);

interface ListingOutput {
  readonly directory: string;
  readonly total: number;
  readonly truncated?: boolean;
  readonly note?: string;
  readonly entries: readonly {
    readonly name: string;
    readonly path: string;
    readonly type: 'file' | 'directory';
  }[];
}

function toolFor(directory: string | undefined, limit?: number): ListDirectoryTool {
  const workspace: WorkspacePort = {
    confirmedDirectory: () => directory,
    requestApproval: async () => true,
    confirmDirectory: () => undefined,
  };
  return limit === undefined ? new ListDirectoryTool(workspace) : new ListDirectoryTool(workspace, limit);
}

/** 只接受成功结果：形状不对时直接让测试失败，而不是读到 undefined 后静默通过。 */
function listing(result: ToolResult): ListingOutput {
  if (result.status !== 'success') throw new Error(`期望成功结果，实际是失败：${result.message}`);
  return result.output as ListingOutput;
}

function names(result: ToolResult): readonly string[] {
  return listing(result).entries.map((entry) => entry.name);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'agent-desktop-list-'));
  root = join(base, '素材 目录');
  outside = join(base, 'outside');
  await mkdir(join(root, '子 目录'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, '第一段.mp4'), 'video');
  await writeFile(join(root, 'second.mp4'), 'video');
  await writeFile(join(root, 'notes.txt'), 'text');
  await writeFile(join(outside, 'secret.mp4'), 'video');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('list_directory', () => {
  it('lists real entries of the confirmed directory with names, paths and types', async () => {
    const resolved = await real(root);
    const result = await toolFor(resolved).execute({});

    expect(result.status).toBe('success');
    // 顺序是按名称做与区域设置无关的稳定排序（码位顺序），保证同一目录每次返回同样的结果。
    expect(result).toMatchObject({
      output: {
        directory: resolved,
        total: 4,
        entries: [
          { name: 'notes.txt', path: join(resolved, 'notes.txt'), type: 'file' },
          { name: 'second.mp4', path: join(resolved, 'second.mp4'), type: 'file' },
          { name: '子 目录', path: join(resolved, '子 目录'), type: 'directory' },
          { name: '第一段.mp4', path: join(resolved, '第一段.mp4'), type: 'file' },
        ],
      },
    });
  });

  it('filters files by extension while keeping directories reachable', async () => {
    const result = await toolFor(await real(root)).execute({ extension: 'mp4' });

    // 目录不参与过滤，否则模型无法继续往下找。
    expect(names(result)).toEqual(['second.mp4', '子 目录', '第一段.mp4']);
  });

  it('accepts an extension written with a leading dot', async () => {
    const result = await toolFor(await real(root)).execute({ extension: '.MP4' });

    expect(names(result)).toEqual(['second.mp4', '子 目录', '第一段.mp4']);
  });

  it('lists a subdirectory given as a relative path', async () => {
    const resolved = await real(root);
    const result = await toolFor(resolved).execute({ directory: '子 目录' });

    expect(result).toMatchObject({ output: { directory: await real(join(root, '子 目录')), total: 0 } });
  });

  it('truncates a large directory and reports how to narrow it', async () => {
    const many = join(base, 'many');
    await mkdir(many);
    for (let index = 0; index < 12; index += 1) {
      await writeFile(join(many, `clip-${String(index).padStart(2, '0')}.mp4`), 'video');
    }

    const result = await toolFor(await real(many), 5).execute({});

    expect(result.status).toBe('success');
    const output = listing(result);
    expect(output.total).toBe(12);
    expect(output.truncated).toBe(true);
    expect(output.note).toContain('extension');
    expect(names(result)).toHaveLength(5);
  });

  it('does not mark a directory that fits exactly as truncated', async () => {
    const result = await toolFor(await real(root), 4).execute({});

    expect(listing(result).truncated).toBeUndefined();
    expect(names(result)).toHaveLength(4);
  });

  it('reports a link to a directory as a directory instead of hiding it as a file', async () => {
    // 指向目录的联接在 dirent 上不是目录；只按 dirent 判断会把它报成文件，
    // 扩展名过滤再顺手丢掉它——模型既看不到、也不知道它其实可以进入。
    const link = join(root, '联接目录');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await toolFor(await real(root)).execute({ extension: 'mp4' });

    expect(listing(result).entries).toContainEqual({
      name: '联接目录',
      path: join(await real(root), '联接目录'),
      type: 'directory',
    });
  });

  it('refuses a path outside the confirmed directory without listing anything', async () => {
    const result = await toolFor(await real(root)).execute({ directory: join(outside, 'secret.mp4') });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('不在当前会话的工作目录内');
  });

  it('refuses a link that points outside the confirmed directory', async () => {
    const link = join(root, 'link-out');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await toolFor(await real(root)).execute({ directory: 'link-out' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('不在当前会话的工作目录内');
  });

  it('tells the model how to get a working directory when the session has none', async () => {
    const result = await toolFor(undefined).execute({});

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('set_working_directory');
  });

  it('reports a directory that does not exist instead of returning an empty list', async () => {
    const result = await toolFor(await real(root)).execute({ directory: 'missing' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('ENOENT');
  });

  it('reports a file that is not a directory instead of returning an empty list', async () => {
    const result = await toolFor(await real(root)).execute({ directory: 'notes.txt' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('无法读取该目录');
  });

  it('rejects malformed input without touching the file system', async () => {
    const tool = toolFor(await real(root));

    for (const input of [null, 'clips', { directory: 7 }, { extension: 7 }]) {
      const result = await tool.execute(input);
      expect(result.status).toBe('error');
    }
  });

  it('exposes a model-visible schema for the directory and extension arguments', () => {
    const tool = toolFor(undefined);

    expect(tool.name).toBe('list_directory');
    expect(tool.inputSchema).toEqual(expect.objectContaining({ additionalProperties: false }));
    expect(tool.description).toContain('扩展名');
  });
});
