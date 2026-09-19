import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '@agent-desktop/model';
import {
  SearchTextTool,
  type RipgrepMatch,
  type RipgrepRunner,
  type WorkspacePort,
} from '../src/index.js';

/**
 * 解析、上限和取消语义用替身进程验证（确定性、不依赖机器上是否装了 ripgrep）；
 * 真实进程边界由 logs/verify-g41-search-text.cjs 用真实 ripgrep 覆盖。
 */
let base: string;
let root: string;
let outside: string;

const real = (path: string) => realpath(path);

interface SearchOutput {
  readonly directory: string;
  readonly pattern: string;
  readonly total: number;
  readonly matches: readonly RipgrepMatch[];
  readonly truncated?: boolean;
  readonly note?: string;
}

function workspaceFor(directory: string | undefined): WorkspacePort {
  return {
    confirmedDirectory: () => directory,
    requestApproval: async () => true,
    confirmDirectory: () => undefined,
  };
}

/** 只接受成功结果：形状不对时直接让测试失败。 */
function search(result: ToolResult): SearchOutput {
  if (result.status !== 'success') throw new Error(`期望成功结果，实际是失败：${result.message}`);
  return result.output as SearchOutput;
}

/** 记录调用参数的替身进程：返回预先给定的匹配，并可模拟退出码与启动失败。 */
function fakeRunner(options: {
  matches?: readonly RipgrepMatch[];
  exitCode?: number;
  stderr?: string;
  failWith?: NodeJS.ErrnoException;
} = {}): { runner: RipgrepRunner; calls: (readonly string[])[]; stoppedEarly: () => boolean } {
  const calls: (readonly string[])[] = [];
  let stoppedEarly = false;
  const runner: RipgrepRunner = async (args, _signal, onMatch) => {
    calls.push(args);
    if (options.failWith !== undefined) throw options.failWith;
    for (const match of options.matches ?? []) {
      if (!onMatch(match)) {
        stoppedEarly = true;
        break;
      }
    }
    return { exitCode: options.exitCode ?? 0, stderr: options.stderr ?? '' };
  };
  return { runner, calls, stoppedEarly: () => stoppedEarly };
}

function toolFor(
  directory: string | undefined,
  runner: RipgrepRunner,
  maxMatches?: number,
): SearchTextTool {
  return maxMatches === undefined
    ? new SearchTextTool(workspaceFor(directory), runner)
    : new SearchTextTool(workspaceFor(directory), runner, maxMatches);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'agent-desktop-search-'));
  root = join(base, '素材 目录');
  outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, '字幕.srt'), '第一句台词', 'utf8');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('search_text', () => {
  it('returns matched files, line numbers and snippets from the search process', async () => {
    const { runner } = fakeRunner({
      matches: [
        { filePath: join(root, '字幕.srt'), lineNumber: 3, line: '第一句台词' },
        { filePath: join(root, '字幕.srt'), lineNumber: 7, line: '第二句台词' },
      ],
    });

    const result = await toolFor(await real(root), runner).execute({ pattern: '句台词' });

    expect(search(result)).toEqual({
      directory: await real(root),
      pattern: '句台词',
      total: 2,
      matches: [
        { filePath: join(root, '字幕.srt'), lineNumber: 3, line: '第一句台词' },
        { filePath: join(root, '字幕.srt'), lineNumber: 7, line: '第二句台词' },
      ],
    });
  });

  it('treats no match as a normal empty result instead of a failure', async () => {
    // ripgrep 无匹配时退出码是 1，这不是错误。
    const { runner } = fakeRunner({ matches: [], exitCode: 1 });

    const result = await toolFor(await real(root), runner).execute({ pattern: '不存在的台词' });

    expect(search(result)).toMatchObject({ total: 0, matches: [] });
  });

  it('passes the pattern as a literal string and scopes the search to the confirmed directory', async () => {
    const { runner, calls } = fakeRunner();
    const resolved = await real(root);

    await toolFor(resolved, runner).execute({ pattern: 'a.b', extension: 'srt' });

    // 字面文本：`.` 不能变成正则；目录必须是范围解析后的真实路径。
    expect(calls[0]).toEqual([
      '--json',
      '--fixed-strings',
      '--glob',
      '*.srt',
      '--',
      'a.b',
      resolved,
    ]);
  });

  it('never returns more than the limit even if the process keeps reporting matches', async () => {
    // 进程被 kill 之后仍可能有已排队的分片到达：上限必须在调用方也守住。
    const { runner } = fakeRunner({
      matches: Array.from({ length: 10 }, (_value, index) => ({
        filePath: join(root, '字幕.srt'),
        lineNumber: index + 1,
        line: `第 ${index + 1} 行`,
      })),
    });
    // 替身故意忽略「够了」的信号，继续上报，模拟 kill 之后的迟到分片。
    const ignoringStop: RipgrepRunner = async (args, signal, onMatch) => {
      const inner = await runner(args, signal, () => true);
      for (const match of Array.from({ length: 10 }, (_value, index) => ({
        filePath: join(root, '字幕.srt'),
        lineNumber: index + 1,
        line: `第 ${index + 1} 行`,
      }))) {
        onMatch(match);
      }
      return inner;
    };

    const output = search(await toolFor(await real(root), ignoringStop, 3).execute({ pattern: '行' }));

    expect(output.matches).toHaveLength(3);
    expect(output.total).toBe(3);
  });

  it('stops the search process once the result limit is reached and reports truncation', async () => {
    const { runner, stoppedEarly } = fakeRunner({
      matches: Array.from({ length: 10 }, (_value, index) => ({
        filePath: join(root, '字幕.srt'),
        lineNumber: index + 1,
        line: `第 ${index + 1} 行`,
      })),
    });

    const result = await toolFor(await real(root), runner, 3).execute({ pattern: '行' });

    const output = search(result);
    expect(output.matches).toHaveLength(3);
    expect(output.truncated).toBe(true);
    expect(output.note).toContain('extension');
    // 到上限必须结束进程，不能把整个目录扫完。
    expect(stoppedEarly()).toBe(true);
  });

  it('shortens an over-long snippet instead of returning the whole line', async () => {
    const { runner } = fakeRunner({
      matches: [{ filePath: join(root, '字幕.srt'), lineNumber: 1, line: 'x'.repeat(500) }],
    });

    const output = search(await toolFor(await real(root), runner).execute({ pattern: 'x' }));

    expect(output.matches[0]?.line).toHaveLength(201);
    expect(output.matches[0]?.line.endsWith('…')).toBe(true);
  });

  it('reports a missing bundled ripgrep as a packaging problem instead of blaming the user', async () => {
    // ripgrep 由 @vscode/ripgrep 随包提供，所以「找不到」是打包/依赖问题，不是用户配置问题。
    const missing = new Error('spawn rg ENOENT') as NodeJS.ErrnoException;
    missing.code = 'ENOENT';
    const { runner } = fakeRunner({ failWith: missing });

    const result = await toolFor(await real(root), runner).execute({ pattern: '台词' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('随包提供');
    expect(result.status === 'error' && result.message).toContain('pnpm install');
    // 不能把「随包资源缺失」说成用户需要自己去装并配置 PATH。
    expect(result.status === 'error' && result.message).not.toContain('出现在 PATH');
  });

  it('surfaces a real search failure with the process exit code', async () => {
    const { runner } = fakeRunner({ exitCode: 2, stderr: 'regex parse error\nsecond line' });

    const result = await toolFor(await real(root), runner).execute({ pattern: '台词' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('退出码 2');
    expect(result.status === 'error' && result.message).toContain('regex parse error');
  });

  it('ends the search with AbortError instead of a tool failure when the turn is cancelled', async () => {
    const controller = new AbortController();
    const runner: RipgrepRunner = async (_args, signal) => {
      // 取消时进程被结束，这里模拟进程在取消后才返回。
      controller.abort();
      signal?.removeEventListener('abort', () => undefined);
      return { exitCode: 0, stderr: '' };
    };

    await expect(toolFor(await real(root), runner).execute({ pattern: '台词' }, controller.signal))
      .rejects.toHaveProperty('name', 'AbortError');
  });

  it('does not start a search when the turn was already cancelled', async () => {
    const controller = new AbortController();
    const { runner, calls } = fakeRunner();
    controller.abort();

    await expect(toolFor(await real(root), runner).execute({ pattern: '台词' }, controller.signal))
      .rejects.toHaveProperty('name', 'AbortError');
    expect(calls).toEqual([]);
  });

  it('refuses a directory outside the confirmed scope without searching', async () => {
    const { runner, calls } = fakeRunner();

    const result = await toolFor(await real(root), runner).execute({
      pattern: '台词',
      directory: outside,
    });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('不在当前会话的工作目录内');
    expect(calls).toEqual([]);
  });

  it('tells the model how to get a working directory when the session has none', async () => {
    const { runner } = fakeRunner();

    const result = await toolFor(undefined, runner).execute({ pattern: '台词' });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('set_working_directory');
  });

  it('rejects malformed input without starting a search', async () => {
    const { runner, calls } = fakeRunner();
    const tool = toolFor(await real(root), runner);

    for (const input of [null, '台词', { pattern: '' }, { pattern: 7 }, { pattern: 'x', directory: 7 }]) {
      const result = await tool.execute(input);
      expect(result.status).toBe('error');
    }
    expect(calls).toEqual([]);
  });

  it('exposes a model-visible schema for the pattern and filters', () => {
    const tool = toolFor(undefined, fakeRunner().runner);

    expect(tool.name).toBe('search_text');
    expect(tool.inputSchema).toEqual(expect.objectContaining({
      required: ['pattern'],
      additionalProperties: false,
    }));
    expect(tool.description).toContain('字面文本');
  });
});
