import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '@agent-desktop/model';
import { WriteTextFileTool, type ApprovalTarget, type WorkspacePort } from '../src/index.js';

/** 真实目录与真实写入：审批后的副作用必须能在磁盘上核对。 */
let base: string;
let root: string;
let outside: string;

const real = (path: string) => realpath(path);

interface WriteOutput {
  readonly filePath: string;
  readonly bytes: number;
}

function write(result: ToolResult): WriteOutput {
  if (result.status !== 'success') throw new Error(`期望成功结果，实际是失败：${result.message}`);
  return result.output as WriteOutput;
}

/** 可观察的审批替身：记录被批准的确切操作，并按用例决定是否批准。 */
function portFor(options: {
  directory?: string;
  approve?: boolean;
  onRequest?: (target: ApprovalTarget) => void;
} = {}): { port: WorkspacePort; requested: ApprovalTarget[] } {
  const requested: ApprovalTarget[] = [];
  return {
    requested,
    port: {
      confirmedDirectory: () => options.directory,
      requestApproval: async (target) => {
        requested.push(target);
        options.onRequest?.(target);
        return options.approve ?? true;
      },
      confirmDirectory: () => undefined,
    },
  };
}

function toolFor(port: WorkspacePort): WriteTextFileTool {
  return new WriteTextFileTool(port);
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'agent-desktop-write-'));
  root = join(base, '素材 目录');
  outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('write_text_file', () => {
  it('creates the file after one approval and reports it as the artifact', async () => {
    const resolved = await real(root);
    const { port, requested } = portFor({ directory: resolved });
    const target = join(resolved, '剪辑清单.txt');

    const result = await toolFor(port).execute({ filePath: '剪辑清单.txt', content: '第一段\n第二段\n' });

    expect(write(result)).toEqual({
      filePath: target,
      bytes: Buffer.byteLength('第一段\n第二段\n', 'utf8'),
    });
    // 产物事实来自成功结果，路径是真实路径。
    expect(result.status === 'success' && result.artifacts).toEqual([target]);
    // 审批的是「创建这个文件」这一确切操作。
    expect(requested).toEqual([{ kind: 'create-file', path: target }]);
    await expect(readFile(target, 'utf8')).resolves.toBe('第一段\n第二段\n');
  });

  it('writes nothing when the user refuses', async () => {
    const resolved = await real(root);
    const { port } = portFor({ directory: resolved, approve: false });
    const target = join(resolved, '不要创建.txt');

    const result = await toolFor(port).execute({ filePath: '不要创建.txt', content: '内容' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('用户拒绝');
    await expect(readIfExists(target)).resolves.toBeUndefined();
  });

  it('refuses to overwrite an existing file and leaves its content unchanged', async () => {
    const resolved = await real(root);
    const target = join(resolved, '已有.txt');
    await writeFile(target, '原有内容', 'utf8');
    const { port, requested } = portFor({ directory: resolved });

    const result = await toolFor(port).execute({ filePath: '已有.txt', content: '新内容' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('不会覆盖');
    await expect(readFile(target, 'utf8')).resolves.toBe('原有内容');
    // 目标已存在时不必让用户为一个注定失败的操作点批准。
    expect(requested).toEqual([]);
  });

  it('refuses a target whose parent is outside the confirmed directory', async () => {
    const resolved = await real(root);
    const { port, requested } = portFor({ directory: resolved });

    const result = await toolFor(port).execute({
      filePath: join(outside, '越界.txt'),
      content: '内容',
    });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('不在当前会话的工作目录内');
    expect(requested).toEqual([]);
    await expect(readIfExists(join(outside, '越界.txt'))).resolves.toBeUndefined();
  });

  it('refuses a parent directory that does not exist instead of creating it', async () => {
    const resolved = await real(root);
    const { port } = portFor({ directory: resolved });

    const result = await toolFor(port).execute({ filePath: '还没有的目录/文件.txt', content: '内容' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('ENOENT');
  });

  it('refuses to write through a link that points outside the confirmed directory', async () => {
    const resolved = await real(root);
    const link = join(resolved, '联接目录');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const { port } = portFor({ directory: resolved });

    const result = await toolFor(port).execute({ filePath: '联接目录/越界.txt', content: '内容' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('不在当前会话的工作目录内');
    await expect(readIfExists(join(outside, '越界.txt'))).resolves.toBeUndefined();
  });

  it('tells the model how to get a working directory when the session has none', async () => {
    const { port, requested } = portFor();

    const result = await toolFor(port).execute({ filePath: '文件.txt', content: '内容' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('set_working_directory');
    expect(requested).toEqual([]);
  });

  it('ends the wait with AbortError when the turn is cancelled during approval', async () => {
    const resolved = await real(root);
    const controller = new AbortController();
    let markWaiting: () => void = () => {};
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    const { port } = portFor({ directory: resolved });
    const cancelling: WorkspacePort = {
      ...port,
      requestApproval: (_target, signal) => new Promise((_resolve, reject) => {
        markWaiting();
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      }),
    };

    const pending = toolFor(cancelling).execute({ filePath: '半途.txt', content: '内容' }, controller.signal);
    await waiting;
    controller.abort();

    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    // 取消审批不产生任何副作用。
    await expect(readIfExists(join(resolved, '半途.txt'))).resolves.toBeUndefined();
  });

  it('does not ask for approval when the turn was already cancelled', async () => {
    const resolved = await real(root);
    const controller = new AbortController();
    const { port, requested } = portFor({ directory: resolved });
    controller.abort();

    await expect(toolFor(port).execute({ filePath: '取消.txt', content: '内容' }, controller.signal))
      .rejects.toHaveProperty('name', 'AbortError');
    expect(requested).toEqual([]);
  });

  it('writes an empty file when the content is empty', async () => {
    const resolved = await real(root);
    const { port } = portFor({ directory: resolved });

    const result = await toolFor(port).execute({ filePath: '空.txt', content: '' });

    expect(write(result)).toMatchObject({ bytes: 0 });
    await expect(readFile(join(resolved, '空.txt'), 'utf8')).resolves.toBe('');
  });

  it('rejects malformed input without asking for approval', async () => {
    const resolved = await real(root);
    const { port, requested } = portFor({ directory: resolved });
    const tool = toolFor(port);

    for (const input of [null, '文件名', { filePath: '' }, { filePath: 'a.txt' }, { filePath: 7, content: 'x' }]) {
      const result = await tool.execute(input);
      expect(result.status).toBe('error');
    }
    expect(requested).toEqual([]);
  });

  it('exposes a model-visible schema for the path and content', () => {
    const tool = toolFor(portFor().port);

    expect(tool.name).toBe('write_text_file');
    expect(tool.inputSchema).toEqual(expect.objectContaining({
      required: ['filePath', 'content'],
      additionalProperties: false,
    }));
    expect(tool.description).toContain('不会被覆盖');
  });
});
