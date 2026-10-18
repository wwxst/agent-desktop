import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '@agent-desktop/model';
import type { ToolExecutionContext } from '@agent-desktop/tools';
import { ApplyPatchTool, GitReadTool, ReadFileTool, RunCommandTool, type WorkspacePort } from '../src/index.js';

const execute = promisify(execFile);
let root: string;
const context: ToolExecutionContext = { toolCallId: 'git-test' as ToolExecutionContext['toolCallId'], reportProgress: () => {} };
function workspace(directory = root): WorkspacePort {
  return { confirmedDirectory: () => directory, confirmDirectory: () => {}, requestApproval: async () => true };
}
function output(result: ToolResult): { stdout: string; stderr: string; truncated: boolean; droppedBytes: number } {
  if (result.status !== 'success') throw new Error(result.message);
  return result.output as ReturnType<typeof output>;
}
async function git(...args: string[]): Promise<string> {
  return (await execute('git', ['-C', root, ...args], { windowsHide: true })).stdout;
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agent-desktop-git-')));
  await git('init', '--quiet');
  await git('config', 'user.email', 'local-acceptance@example.invalid');
  await git('config', 'user.name', 'Local Acceptance');
  await writeFile(join(root, 'calculator.mjs'), 'export function add(a, b) { return a - b; }\n');
  await git('add', '--', 'calculator.mjs');
  await git('commit', '--quiet', '-m', 'initial calculator');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('read-only Git tools', () => {
  it('runs the real read → patch → diff → test workflow in an isolated repository', async () => {
    const port = workspace();
    const read = await new ReadFileTool(port).execute({ filePath: 'calculator.mjs' });
    expect(read.status).toBe('success');
    expect((await new ApplyPatchTool(port).execute({ filePath: 'calculator.mjs', expectedSha256: (read.output as { sha256: string }).sha256,
      hunks: [{ oldText: 'return a - b;', newText: 'return a + b;' }] }, context)).status).toBe('success');
    const diff = output(await new GitReadTool('git_diff', port).execute({}, context));
    expect(diff.stdout).toContain('-export function add(a, b) { return a - b; }');
    expect(diff.stdout).toContain('+export function add(a, b) { return a + b; }');
    expect(output(await new GitReadTool('git_status', port).execute({}, context)).stdout).toContain('calculator.mjs');
    expect(output(await new GitReadTool('git_log', port).execute({ maxCount: 1 }, context)).stdout).toContain('initial calculator');

    await writeFile(join(root, 'calculator.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calculator.mjs';\ntest('adds actual numbers', () => assert.equal(add(2, 3), 5));\n");
    // Windows 使用正式命令工具；其它平台只替换真实解释器入口，不把未运行写为通过。
    const systemRoot = process.env.SystemRoot;
    if (process.platform === 'win32' && systemRoot !== undefined) {
      const result = await new RunCommandTool(port, { interpreterPath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        environment: { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, SystemRoot: systemRoot } }).execute({ command: 'node --test calculator.test.mjs' }, context);
      expect(result.status, JSON.stringify(result)).toBe('success');
      expect((result.output as { stdout: string }).stdout).toContain('pass 1');
    } else {
      expect((await execute(process.execPath, ['--test', 'calculator.test.mjs'], { cwd: root })).stdout).toContain('pass 1');
    }
    await expect(readFile(join(root, 'calculator.mjs'), 'utf8')).resolves.toContain('return a + b;');
  });

  it('separates staged and unstaged changes without changing the index', async () => {
    await writeFile(join(root, 'calculator.mjs'), 'staged\n');
    await git('add', '--', 'calculator.mjs');
    await writeFile(join(root, 'calculator.mjs'), 'unstaged\n');
    const indexBefore = await readFile(join(root, '.git', 'index'));
    expect(output(await new GitReadTool('git_diff', workspace()).execute({ staged: true }, context)).stdout).toContain('+staged');
    expect(output(await new GitReadTool('git_diff', workspace()).execute({}, context)).stdout).toContain('+unstaged');
    expect((await readFile(join(root, '.git', 'index'))).equals(indexBefore)).toBe(true);
  });

  it('keeps Git reads inside an authorized subdirectory and rejects escaping directories', async () => {
    const child = join(root, 'public'); await mkdir(child);
    await writeFile(join(child, 'visible.mjs'), 'visible\n');
    await git('add', '--', 'public'); await git('commit', '--quiet', '-m', 'add visible');
    await writeFile(join(root, 'calculator.mjs'), 'private change\n');
    await writeFile(join(child, 'visible.mjs'), 'visible change\n');
    const tool = new GitReadTool('git_diff', workspace(child));
    const diff = output(await tool.execute({}, context)).stdout;
    expect(diff).toContain('visible change'); expect(diff).not.toContain('private change');
    expect((await tool.execute({ directory: '..' }, context)).status).toBe('error');
  });

  it('disables configured external diff and fsmonitor programs', async () => {
    await git('config', 'diff.external', 'does-not-exist-external-diff');
    await git('config', 'core.fsmonitor', 'does-not-exist-fsmonitor');
    await writeFile(join(root, 'calculator.mjs'), 'updated\n');
    const diff = output(await new GitReadTool('git_diff', workspace()).execute({}, context));
    expect(diff.stdout).toContain('+updated');
    const status = output(await new GitReadTool('git_status', workspace()).execute({}, context));
    expect(status.stderr).not.toContain('does-not-exist-fsmonitor');
  });

  it('does not execute configured clean filters while inspecting workspace changes', async () => {
    await writeFile(join(root, '.gitattributes'), '*.mjs filter=unsafe\n');
    await git('config', 'filter.unsafe.clean', `"${process.execPath.replaceAll('\\', '/')}" -e "require('node:fs').writeFileSync('filter-ran','unexpected');process.stdin.pipe(process.stdout)"`);
    await git('config', 'filter.unsafe.required', 'true');
    await writeFile(join(root, 'calculator.mjs'), 'changed without executing a filter\n');
    expect((await new GitReadTool('git_status', workspace()).execute({}, context)).status).toBe('success');
    expect(output(await new GitReadTool('git_diff', workspace()).execute({}, context)).stdout).toContain('changed without executing');
    expect(await readdir(root)).not.toContain('filter-ran');
  });

  it('bounds large diff output and rejects option or command injection', async () => {
    await writeFile(join(root, 'calculator.mjs'), 'line with a long value\n'.repeat(10_000));
    const result = output(await new GitReadTool('git_diff', workspace()).execute({}, context));
    expect(result.truncated).toBe(true); expect(result.droppedBytes).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(33_000);
    for (const input of [{ args: ['--output=escape'] }, { command: 'git push' }, { staged: '--output=escape' }]) {
      expect((await new GitReadTool('git_diff', workspace()).execute(input, context)).status).toBe('error');
    }
    expect((await new GitReadTool('git_log', workspace()).execute({ maxCount: 101 }, context)).status).toBe('error');
  });

  it('retains Git failure and abort semantics', async () => {
    // 明确指定一个仓库外的独立目录，不能由 Git 向上发现本测试仓库。
    const separate = await realpath(await mkdtemp(join(tmpdir(), 'agent-desktop-not-git-')));
    try { expect((await new GitReadTool('git_status', workspace(separate)).execute({}, context)).status).toBe('error'); }
    finally { await rm(separate, { recursive: true, force: true }); }
    const controller = new AbortController(); controller.abort();
    await expect(new GitReadTool('git_status', workspace()).execute({}, { ...context, signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
  });
});
