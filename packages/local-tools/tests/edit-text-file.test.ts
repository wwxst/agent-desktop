import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '@agent-desktop/model';
import { EditTextFileTool, ReadFileTool, type ApprovalTarget, type WorkspacePort } from '../src/index.js';

let base: string;
let root: string;
let outside: string;

interface EditOutput {
  readonly filePath: string;
  readonly replacements: number;
  readonly bytes: number;
}

interface ReadOutput {
  readonly sha256: string;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function read(result: ToolResult): ReadOutput {
  if (result.status !== 'success') throw new Error(`期望成功结果，实际是失败：${result.message}`);
  return result.output as ReadOutput;
}

function edit(result: ToolResult): EditOutput {
  if (result.status !== 'success') throw new Error(`期望成功结果，实际是失败：${result.message}`);
  return result.output as EditOutput;
}

/** 审批替身保留宿主实际收到的文件变更，测试据此确认批准内容和最终写入一致。 */
function portFor(options: {
  directory?: string;
  approve?: boolean;
  onRequest?: (target: ApprovalTarget) => void | Promise<void>;
} = {}): { port: WorkspacePort; requested: ApprovalTarget[] } {
  const requested: ApprovalTarget[] = [];
  return {
    requested,
    port: {
      confirmedDirectory: () => options.directory,
      requestApproval: async (target) => {
        requested.push(target);
        await options.onRequest?.(target);
        return options.approve ?? true;
      },
      confirmDirectory: () => undefined,
    },
  };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'agent-desktop-edit-'));
  root = join(base, '字幕 目录');
  outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('edit_text_file', () => {
  it('replaces one exact match after approval and does not report a new artifact', async () => {
    const directory = await realpath(root);
    const target = join(directory, '中文 字幕.srt');
    const before = '第一句\n需要修改的台词\n最后一句\n';
    const after = '第一句\n已经修改的台词\n最后一句\n';
    await writeFile(target, before, 'utf8');
    const { port, requested } = portFor({ directory });

    const result = await new EditTextFileTool(port).execute({
      filePath: '中文 字幕.srt',
      expectedSha256: sha256(before),
      oldText: '需要修改的台词',
      newText: '已经修改的台词',
    });

    expect(edit(result)).toEqual({
      filePath: target,
      replacements: 1,
      bytes: Buffer.byteLength(after, 'utf8'),
    });
    expect(result.status === 'success' && result.artifacts).toBeUndefined();
    expect(requested).toEqual([{
      kind: 'edit-file',
      path: target,
      before: '需要修改的台词',
      after: '已经修改的台词',
    }]);
    await expect(readFile(target, 'utf8')).resolves.toBe(after);
  });

  it('fails without approval when the old text does not occur', async () => {
    const directory = await realpath(root);
    const target = join(directory, 'script.txt');
    await writeFile(target, '现有内容', 'utf8');
    const { port, requested } = portFor({ directory });

    const result = await new EditTextFileTool(port).execute({
      filePath: target,
      expectedSha256: sha256('现有内容'),
      oldText: '不存在',
      newText: '新内容',
    });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('没有找到');
    expect(requested).toEqual([]);
    await expect(readFile(target, 'utf8')).resolves.toBe('现有内容');
  });

  it('fails without approval when the old text occurs more than once', async () => {
    const directory = await realpath(root);
    const target = join(directory, 'script.txt');
    await writeFile(target, '重复内容、重复内容', 'utf8');
    const { port, requested } = portFor({ directory });

    const result = await new EditTextFileTool(port).execute({
      filePath: target,
      expectedSha256: sha256('重复内容、重复内容'),
      oldText: '重复内容',
      newText: '替换内容',
    });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('多处匹配');
    expect(requested).toEqual([]);
    await expect(readFile(target, 'utf8')).resolves.toBe('重复内容、重复内容');
  });

  it('writes nothing when the user refuses', async () => {
    const directory = await realpath(root);
    const target = join(directory, 'script.txt');
    await writeFile(target, '原有内容', 'utf8');
    const { port } = portFor({ directory, approve: false });

    const result = await new EditTextFileTool(port).execute({
      filePath: target,
      expectedSha256: sha256('原有内容'),
      oldText: '原有内容',
      newText: '新内容',
    });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('用户拒绝');
    await expect(readFile(target, 'utf8')).resolves.toBe('原有内容');
  });

  it('stops when the file changes while approval is pending', async () => {
    const directory = await realpath(root);
    const target = join(directory, 'script.txt');
    await writeFile(target, '审批前内容', 'utf8');
    const { port } = portFor({
      directory,
      onRequest: async () => writeFile(target, '外部修改后的内容', 'utf8'),
    });

    const result = await new EditTextFileTool(port).execute({
      filePath: target,
      expectedSha256: sha256('审批前内容'),
      oldText: '审批前内容',
      newText: 'Agent 修改内容',
    });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('审批期间发生变化');
    await expect(readFile(target, 'utf8')).resolves.toBe('外部修改后的内容');
  });

  it('stops before approval when the file changed after read_file', async () => {
    const directory = await realpath(root);
    const target = join(directory, 'script.txt');
    await writeFile(target, '读取时内容', 'utf8');
    const { port, requested } = portFor({ directory });
    const readOutput = read(await new ReadFileTool(port).execute({ filePath: target }));
    await writeFile(target, '读取后被外部修改', 'utf8');

    const result = await new EditTextFileTool(port).execute({
      filePath: target,
      expectedSha256: readOutput.sha256,
      oldText: '读取时内容',
      newText: 'Agent 修改内容',
    });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('读取后发生变化');
    expect(requested).toEqual([]);
    await expect(readFile(target, 'utf8')).resolves.toBe('读取后被外部修改');
  });

  it('ends a pending approval with AbortError and leaves the file unchanged', async () => {
    const directory = await realpath(root);
    const target = join(directory, 'script.txt');
    await writeFile(target, '原有内容', 'utf8');
    const controller = new AbortController();
    let markWaiting: () => void = () => {};
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    const { port } = portFor({ directory });
    const cancelling: WorkspacePort = {
      ...port,
      requestApproval: (_target, signal) => new Promise((_resolve, reject) => {
        markWaiting();
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      }),
    };

    const pending = new EditTextFileTool(cancelling).execute({
      filePath: target,
      expectedSha256: sha256('原有内容'),
      oldText: '原有内容',
      newText: '新内容',
    }, controller.signal);
    await waiting;
    controller.abort();

    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    await expect(readFile(target, 'utf8')).resolves.toBe('原有内容');
  });

  it('does not revive an approval that became stale as it was answered', async () => {
    const directory = await realpath(root);
    const target = join(directory, 'script.txt');
    await writeFile(target, '原有内容', 'utf8');
    const controller = new AbortController();
    const { port } = portFor({
      directory,
      onRequest: () => controller.abort(),
    });

    const result = new EditTextFileTool(port).execute({
      filePath: target,
      expectedSha256: sha256('原有内容'),
      oldText: '原有内容',
      newText: '新内容',
    }, controller.signal);

    await expect(result).rejects.toHaveProperty('name', 'AbortError');
    await expect(readFile(target, 'utf8')).resolves.toBe('原有内容');
  });

  it('refuses to edit a file outside the confirmed directory', async () => {
    const directory = await realpath(root);
    const target = join(outside, 'outside.txt');
    await writeFile(target, '原有内容', 'utf8');
    const { port, requested } = portFor({ directory });

    const result = await new EditTextFileTool(port).execute({
      filePath: target,
      expectedSha256: sha256('原有内容'),
      oldText: '原有内容',
      newText: '新内容',
    });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('不在当前会话的工作目录内');
    expect(requested).toEqual([]);
    await expect(readFile(target, 'utf8')).resolves.toBe('原有内容');
  });

  it('rejects malformed input without asking for approval', async () => {
    const directory = await realpath(root);
    const { port, requested } = portFor({ directory });
    const tool = new EditTextFileTool(port);

    for (const input of [
      null,
      'script.txt',
      { filePath: '' },
      { filePath: 'a.txt', expectedSha256: '', oldText: 'a', newText: 'b' },
      { filePath: 'a.txt', oldText: '', newText: 'b' },
      { filePath: 'a.txt', oldText: 'a' },
      { filePath: 7, oldText: 'a', newText: 'b' },
    ]) {
      const result = await tool.execute(input);
      expect(result.status).toBe('error');
    }
    expect(requested).toEqual([]);
  });

  it('exposes the exact replacement contract and requires reading first', () => {
    const tool = new EditTextFileTool(portFor().port);

    expect(tool.name).toBe('edit_text_file');
    expect(tool.inputSchema).toEqual(expect.objectContaining({
      required: ['filePath', 'expectedSha256', 'oldText', 'newText'],
      additionalProperties: false,
    }));
    expect(tool.description).toContain('read_file');
  });
});
