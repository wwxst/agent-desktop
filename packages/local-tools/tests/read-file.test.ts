import { mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '@agent-desktop/model';
import { ReadFileTool, type WorkspacePort } from '../src/index.js';

/** 真实文件内容：行号、CRLF 和二进制判定都必须来自真实字节，不能靠 mock 假设。 */
let base: string;
let root: string;
let outside: string;

const real = (path: string) => realpath(path);

interface ReadOutput {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly lines: readonly string[];
  readonly truncated?: boolean;
  readonly nextStartLine?: number;
  readonly note?: string;
}

function toolFor(directory: string | undefined, defaultLineCount?: number): ReadFileTool {
  const workspace: WorkspacePort = {
    confirmedDirectory: () => directory,
    requestApproval: async () => true,
    confirmDirectory: () => undefined,
  };
  return defaultLineCount === undefined
    ? new ReadFileTool(workspace)
    : new ReadFileTool(workspace, defaultLineCount);
}

/** 只接受成功结果：形状不对时直接让测试失败，而不是读到 undefined 后静默通过。 */
function reading(result: ToolResult): ReadOutput {
  if (result.status !== 'success') throw new Error(`期望成功结果，实际是失败：${result.message}`);
  return result.output as ReadOutput;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'agent-desktop-read-'));
  root = join(base, '素材 目录');
  outside = join(base, 'outside');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'notes.txt'), 'alpha\nbeta\ngamma\n');
  await writeFile(join(root, '字幕.srt'), [
    '1',
    '00:00:01,000 --> 00:00:03,000',
    '第一句台词',
    '',
    '2',
    '00:00:04,000 --> 00:00:06,000',
    '第二句台词',
    '',
  ].join('\r\n'));
  await writeFile(join(root, 'binary.mp4'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xFF]));
  await writeFile(join(outside, 'secret.txt'), 'secret');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('read_file', () => {
  it('reads a real UTF-8 file line by line with核对得出的行号', async () => {
    const result = await toolFor(await real(root)).execute({ filePath: 'notes.txt' });

    expect(reading(result)).toEqual({
      filePath: await real(join(root, 'notes.txt')),
      startLine: 1,
      endLine: 3,
      totalLines: 3,
      lines: ['alpha', 'beta', 'gamma'],
    });
  });

  it('reads an SRT file and normalizes CRLF without shifting line numbers', async () => {
    const result = await toolFor(await real(root)).execute({ filePath: '字幕.srt' });

    const output = reading(result);
    expect(output.totalLines).toBe(7);
    expect(output.lines[0]).toBe('1');
    expect(output.lines[1]).toBe('00:00:01,000 --> 00:00:03,000');
    expect(output.lines[2]).toBe('第一句台词');
    // 行尾的 \r 不能留在内容里。
    expect(output.lines.some((line) => line.includes('\r'))).toBe(false);
  });

  it('returns the requested line window with the exact line numbers', async () => {
    const result = await toolFor(await real(root)).execute({
      filePath: '字幕.srt',
      startLine: 5,
      lineCount: 2,
    });

    expect(reading(result)).toMatchObject({
      startLine: 5,
      endLine: 6,
      totalLines: 7,
      lines: ['2', '00:00:04,000 --> 00:00:06,000'],
    });
  });

  it('reports where to continue when the file is longer than the window', async () => {
    const result = await toolFor(await real(root), 2).execute({ filePath: '字幕.srt' });

    expect(reading(result)).toMatchObject({
      startLine: 1,
      endLine: 2,
      totalLines: 7,
      truncated: true,
      nextStartLine: 3,
      lines: ['1', '00:00:01,000 --> 00:00:03,000'],
    });
    expect(reading(result).note).toContain('startLine=3');
  });

  it('does not mark a file that fits exactly as truncated', async () => {
    const result = await toolFor(await real(root), 3).execute({ filePath: 'notes.txt' });

    expect(reading(result).truncated).toBeUndefined();
    expect(reading(result).nextStartLine).toBeUndefined();
  });

  it('continues from the reported position and reaches the end of the file', async () => {
    const tool = toolFor(await real(root), 2);
    const first = reading(await tool.execute({ filePath: '字幕.srt' }));
    const second = reading(await tool.execute({
      filePath: '字幕.srt',
      startLine: first.nextStartLine,
    }));
    const third = reading(await tool.execute({
      filePath: '字幕.srt',
      startLine: second.nextStartLine,
    }));

    // 每次窗口都是 2 行：连续读取不重不漏，行号可以直接对回文件。
    expect(first.lines).toEqual(['1', '00:00:01,000 --> 00:00:03,000']);
    expect(second).toMatchObject({ startLine: 3, endLine: 4, lines: ['第一句台词', ''] });
    expect(third).toMatchObject({
      startLine: 5,
      endLine: 6,
      lines: ['2', '00:00:04,000 --> 00:00:06,000'],
      nextStartLine: 7,
    });
  });

  it('refuses a binary file instead of returning mojibake', async () => {
    const result = await toolFor(await real(root)).execute({ filePath: 'binary.mp4' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('二进制文件');
  });

  it('refuses a file outside the confirmed directory', async () => {
    const result = await toolFor(await real(root)).execute({ filePath: join(outside, 'secret.txt') });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('不在当前会话的工作目录内');
  });

  it('reads a file in a subdirectory of the confirmed directory', async () => {
    await writeFile(join(root, 'sub', 'inner.txt'), 'inner');
    const result = await toolFor(await real(root)).execute({ filePath: 'sub/inner.txt' });

    expect(reading(result).lines).toEqual(['inner']);
  });

  it('tells the model how to get a working directory when the session has none', async () => {
    const result = await toolFor(undefined).execute({ filePath: 'notes.txt' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('set_working_directory');
  });

  it('reports a missing file instead of returning an empty read', async () => {
    const result = await toolFor(await real(root)).execute({ filePath: 'missing.txt' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('ENOENT');
  });

  it('refuses a start line beyond the end of the file', async () => {
    const result = await toolFor(await real(root)).execute({ filePath: 'notes.txt', startLine: 9 });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('超出文件范围');
  });

  it('flags content that cannot be decoded as UTF-8 instead of pretending it read it', async () => {
    // 0x80 起头的 GBK 字节序列不是合法 UTF-8，解码会出现替换字符。
    await writeFile(join(root, 'gbk.srt'), Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0x0A]));

    const result = await toolFor(await real(root)).execute({ filePath: 'gbk.srt' });

    expect(reading(result).note).toContain('UTF-8');
  });

  it('rejects malformed input without touching the file system', async () => {
    const tool = toolFor(await real(root));

    for (const input of [null, 'notes.txt', { filePath: '' }, { filePath: 7 }, { filePath: 'notes.txt', startLine: 0 }]) {
      const result = await tool.execute(input);
      expect(result.status).toBe('error');
    }
  });

  it('reads an empty file as a successful empty result', async () => {
    // 空文件是合法文本文件：0 行不是「起始行超出范围」。
    await writeFile(join(root, '空.txt'), '', 'utf8');

    const output = reading(await toolFor(await real(root)).execute({ filePath: '空.txt' }));

    expect(output).toEqual({
      filePath: join(await real(root), '空.txt'),
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      lines: [],
    });
  });

  it('reads a file that is only a newline as one empty line', async () => {
    await writeFile(join(root, '只有换行.txt'), '\n', 'utf8');

    const output = reading(await toolFor(await real(root)).execute({ filePath: '只有换行.txt' }));

    expect(output.totalLines).toBe(1);
    expect(output.lines).toEqual(['']);
  });

  it('shortens an over-long line and says the rest is not available', async () => {
    // 压缩过的 JSON、超长日志行不能让一行撑爆上下文。
    await writeFile(join(root, 'long.txt'), `${'x'.repeat(5000)}\n短行\n`, 'utf8');

    const output = reading(await toolFor(await real(root)).execute({ filePath: 'long.txt' }));

    expect(output.lines[0]).toHaveLength(2001);
    expect(output.lines[0]?.endsWith('…')).toBe(true);
    expect(output.lines[1]).toBe('短行');
    expect(output.note).toContain('已截断');
  });

  it('bounds the total output even when the caller asks for a huge line count', async () => {
    // 调用方可以把 lineCount 传得很大，输出总量必须由预算兜住。
    const many = Array.from({ length: 4000 }, (_value, index) => `第 ${index} 行内容`).join('\n');
    await writeFile(join(root, 'many.txt'), `${many}\n`, 'utf8');

    const output = reading(await toolFor(await real(root)).execute({
      filePath: 'many.txt',
      lineCount: 100_000,
    }));

    const totalChars = output.lines.reduce((sum, line) => sum + line.length, 0);
    expect(output.totalLines).toBe(4000);
    expect(totalChars).toBeLessThanOrEqual(20_000);
    expect(output.lines.length).toBeLessThan(4000);
    expect(output.truncated).toBe(true);
    // 截断必须给出真实的继续读取位置。
    expect(output.nextStartLine).toBe(output.endLine + 1);
    expect(output.note).toContain(`startLine=${output.nextStartLine}`);
  });

  it('refuses a file that is too large to read as a whole', async () => {
    const big = join(root, 'big.txt');
    const handle = await open(big, 'w');
    try {
      // 9 MiB：超过整份读入的上限。
      await handle.write(Buffer.alloc(9 * 1024 * 1024, 0x61));
    } finally {
      await handle.close();
    }

    const result = await toolFor(await real(root)).execute({ filePath: 'big.txt' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('文件过大');
    expect(result.status === 'error' && result.message).toContain('read_file');
  });

  it('exposes a model-visible schema for the file and line arguments', () => {
    const tool = toolFor(undefined);

    expect(tool.name).toBe('read_file');
    expect(tool.inputSchema).toEqual(expect.objectContaining({
      required: ['filePath'],
      additionalProperties: false,
    }));
    expect(tool.description).toContain('二进制');
  });
});
