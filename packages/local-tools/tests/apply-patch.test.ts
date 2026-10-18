import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolExecutionContext } from '@agent-desktop/tools';
import { ApplyPatchTool, ReadFileTool, type ApprovalTarget, type WorkspacePort } from '../src/index.js';

let root: string;
const before = '第一行\nconst first = 1;\n中间\nconst second = 2;\n';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const context: ToolExecutionContext = { toolCallId: 'patch-test' as ToolExecutionContext['toolCallId'], reportProgress: () => {} };
const request = () => ({ filePath: '源码.ts', expectedSha256: sha256(before), hunks: [
  { oldText: 'const first = 1;', newText: 'const first = 10;\n// 新行' },
  { oldText: 'const second = 2;', newText: 'const second = 20;' },
] });

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agent-desktop-patch-')));
  await writeFile(join(root, '源码.ts'), before, 'utf8');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function port(onRequest?: (target: ApprovalTarget) => boolean | Promise<boolean>): WorkspacePort {
  return { confirmedDirectory: () => root, confirmDirectory: () => {}, requestApproval: async target => onRequest?.(target) ?? true };
}

describe('apply_patch', () => {
  it('reads the real SHA, approves the complete multi-hunk change and returns line-aware diff', async () => {
    const requested: ApprovalTarget[] = [];
    const workspace = port(target => { requested.push(target); return true; });
    const source = await new ReadFileTool(workspace).execute({ filePath: '源码.ts' });
    expect(source.status).toBe('success');
    const checkpoints: unknown[] = [];
    const result = await new ApplyPatchTool(workspace).execute({ ...request(), expectedSha256: (source.output as { sha256: string }).sha256 },
      { ...context, checkpoint: data => checkpoints.push(data) });
    const after = before.replace('const first = 1;', 'const first = 10;\n// 新行').replace('const second = 2;', 'const second = 20;');
    expect(result).toEqual({ status: 'success', output: { filePath: join(root, '源码.ts'), bytes: Buffer.byteLength(after), diff: {
      beforeSha256: sha256(before), afterSha256: sha256(after), changes: [
        { oldStartLine: 2, newStartLine: 2, oldText: 'const first = 1;', newText: 'const first = 10;\n// 新行' },
        { oldStartLine: 4, newStartLine: 5, oldText: 'const second = 2;', newText: 'const second = 20;' },
      ],
    } } });
    expect(requested).toEqual([{ kind: 'edit-file', path: join(root, '源码.ts'), before, after }]);
    expect(checkpoints).toEqual([{ kind: 'text-file', path: join(root, '源码.ts'), beforeSha256: sha256(before), expectedAfterSha256: sha256(after), expectedBytes: Buffer.byteLength(after) }]);
    await expect(readFile(join(root, '源码.ts'), 'utf8')).resolves.toBe(after);
    expect(await readdir(root)).toEqual(['源码.ts']);
  });

  it('does not apply any hunk if a later hunk does not match or overlaps', async () => {
    const requested: ApprovalTarget[] = [];
    const tool = new ApplyPatchTool(port(target => { requested.push(target); return true; }));
    for (const hunks of [
      [...request().hunks, { oldText: '不存在', newText: '不能写入' }],
      [{ oldText: 'const first = 1;', newText: 'x' }, { oldText: 'first = 1', newText: 'y' }],
    ]) {
      expect((await tool.execute({ ...request(), hunks }, context)).status).toBe('error');
      await expect(readFile(join(root, '源码.ts'), 'utf8')).resolves.toBe(before);
    }
    expect(requested).toEqual([]);
  });

  it('rejects a stale SHA, a workspace escape and ambiguous matching before approval', async () => {
    const requested: ApprovalTarget[] = [];
    const tool = new ApplyPatchTool(port(target => { requested.push(target); return true; }));
    const bad = [ { ...request(), expectedSha256: 'stale' }, { ...request(), filePath: '../outside.ts' },
      { ...request(), hunks: [{ oldText: 'const', newText: 'let' }] } ];
    for (const input of bad) expect((await tool.execute(input, context)).status).toBe('error');
    expect(requested).toEqual([]);
    await expect(readFile(join(root, '源码.ts'), 'utf8')).resolves.toBe(before);
  });

  it('keeps outside edits made during approval and removes the staged file', async () => {
    const tool = new ApplyPatchTool(port(async () => { await writeFile(join(root, '源码.ts'), '外部改动'); return true; }));
    const result = await tool.execute(request(), context);
    expect(result.status).toBe('error');
    await expect(readFile(join(root, '源码.ts'), 'utf8')).resolves.toBe('外部改动');
    expect(await readdir(root)).toEqual(['源码.ts']);
  });

  it('propagates checkpoint persistence failure before creating any staging files', async () => {
    const failure = new Error('persistent storage failed');
    await expect(new ApplyPatchTool(port()).execute(request(), { ...context, checkpoint: () => { throw failure; } })).rejects.toBe(failure);
    await expect(readFile(join(root, '源码.ts'), 'utf8')).resolves.toBe(before);
    expect(await readdir(root)).toEqual(['源码.ts']);
  });

  it('writes nothing when denied or cancelled after approval', async () => {
    const denied = await new ApplyPatchTool(port(() => false)).execute(request(), context);
    expect(denied).toEqual(expect.objectContaining({ status: 'error', failureKind: 'denied' }));
    const controller = new AbortController();
    const tool = new ApplyPatchTool(port(() => { controller.abort(); return true; }));
    await expect(tool.execute(request(), { ...context, signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
    await expect(readFile(join(root, '源码.ts'), 'utf8')).resolves.toBe(before);
  });
});
