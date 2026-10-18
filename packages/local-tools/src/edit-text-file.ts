import type { ToolResult } from '@agent-desktop/model';
import { executePreparedAction, type Tool, type ToolExecutionContext, type ToolPreparation } from '@agent-desktop/tools';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveScopedPath } from './path-scope.js';
import type { WorkspacePort } from './workspace.js';

export interface TextChange { readonly oldText: string; readonly newText: string }
export interface AppliedTextChange extends TextChange { readonly oldStartLine: number; readonly newStartLine: number }
type EditFailure = Extract<ToolResult, { status: 'error' }>;
interface TextEditResult {
  readonly filePath: string; readonly after: string;
  readonly beforeSha256: string; readonly afterSha256: string; readonly changes: readonly AppliedTextChange[];
}

export function textEditFailure(message: string, failureKind: 'permanent' | 'denied' | 'unknown-outcome' = 'permanent'): EditFailure {
  return { status: 'error', message, failureKind };
}

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const lineCount = (text: string) => text.split('\n').length - 1;

/** 两个真实编辑入口共用 SHA、精确匹配、审批及原子写入规则，避免补丁绕过原编辑边界。 */
export async function prepareTextChanges(
  workspace: WorkspacePort, filePath: string, expectedSha256: string,
  changes: readonly TextChange[], context: ToolExecutionContext,
  result: (edit: TextEditResult) => ToolResult,
): Promise<ToolPreparation> {
  context.signal?.throwIfAborted();
  const scoped = await resolveScopedPath(workspace.confirmedDirectory(), filePath, workspace.fileAccess === 'all');
  if (!scoped.ok) return textEditFailure(scoped.message);
  let original: Buffer;
  try { original = await readFile(scoped.path); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return textEditFailure(`无法读取该文件（${error.message}）：${scoped.path}`);
  }
  if (original.includes(0)) return textEditFailure(`这是二进制文件，不能用文本方式修改：${scoped.path}`);
  const before = original.toString('utf8');
  if (before.includes('\uFFFD')) return textEditFailure(`文件不能完整按 UTF-8 解码，不会改写：${scoped.path}`);
  const beforeSha256 = digest(original);
  if (beforeSha256 !== expectedSha256) return textEditFailure(`文件在读取后发生变化，请重新读取后再修改：${scoped.path}`);

  // 所有片段都匹配原始版本；先完整验证，再一次提交，失败不能留下半份补丁。
  const positions: Array<TextChange & { start: number }> = [];
  for (const change of changes) {
    const start = before.indexOf(change.oldText);
    if (start < 0) return textEditFailure(`文件中没有找到要替换的原内容，请重新读取后再修改：${scoped.path}`);
    if (before.indexOf(change.oldText, start + 1) !== -1) return textEditFailure(`文件中有多处匹配，无法确定唯一修改位置：${scoped.path}`);
    positions.push({ ...change, start });
  }
  positions.sort((left, right) => left.start - right.start);
  let end = 0; let after = '';
  const applied: AppliedTextChange[] = [];
  for (const change of positions) {
    if (change.start < end) return textEditFailure('补丁片段重叠，必须提供互不重叠的原始内容。');
    after += before.slice(end, change.start);
    applied.push({ oldText: change.oldText, newText: change.newText,
      oldStartLine: lineCount(before.slice(0, change.start)) + 1, newStartLine: lineCount(after) + 1 });
    after += change.newText;
    end = change.start + change.oldText.length;
  }
  after += before.slice(end);
  const afterSha256 = digest(after);
  context.signal?.throwIfAborted();
  // 宿主批准完整结果，提交闭包复用同一份内容，两个编辑入口只映射各自的输出格式。
  return {
    requestApproval: () => workspace.requestApproval({ kind: 'edit-file', path: scoped.path, before, after }, context.signal),
    execute: async () => {
      // 保存失败必须原样向上暴露，不能被文件系统错误分支吞成普通 Tool 失败。
      context.checkpoint?.({ kind: 'text-file', path: scoped.path, beforeSha256,
        expectedAfterSha256: afterSha256, expectedBytes: Buffer.byteLength(after, 'utf8') });
      let temporary: string | undefined; let committed = false;
      try {
        try {
          temporary = await mkdtemp(join(dirname(scoped.path), '.agent-patch-'));
          const staged = join(temporary, 'content');
          const mode = (await stat(scoped.path)).mode;
          await writeFile(staged, after, { encoding: 'utf8', flag: 'wx', mode });
          // 暂存完成后重读版本，审批期间发生的修改仍然不能覆盖。
          if (!(await readFile(scoped.path)).equals(original)) return textEditFailure(`文件在审批期间发生变化，请重新读取后再修改：${scoped.path}`);
          context.signal?.throwIfAborted();
          // 同目录文件系统中的 rename 是唯一提交动作；写入暂存失败时原文件保持完整。
          await rename(staged, scoped.path);
          committed = true;
        } finally {
          if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
        }
      } catch (error) {
        if (!(error instanceof Error) || error.name === 'AbortError') throw error;
        return textEditFailure(`无法完成文件修改（${error.message}）：${scoped.path}`, committed ? 'unknown-outcome' : 'permanent');
      }
      return result({ filePath: scoped.path, after, beforeSha256, afterSha256, changes: applied });
    },
  };
}

/** 已有精确替换入口继续消费同一份编辑实现，保持现有工具名称与结果契约。 */
export class EditTextFileTool implements Tool {
  readonly executionBoundary = 'checkpointed' as const;
  readonly contract = { capability: 'code', riskLevel: 'write', parallelSafety: 'serial', workspaceScope: 'session', approvalRequirement: 'policy' } as const;
  readonly name = 'edit_text_file';
  readonly description = '先用 read_file 读取已有文本，再在宿主授权范围内精确替换唯一匹配内容；完整变更经审批后原子写入';
  readonly inputSchema = { type: 'object', properties: {
    filePath: { type: 'string', description: 'read_file 返回的文件路径' },
    expectedSha256: { type: 'string', description: 'read_file 返回的 sha256' },
    oldText: { type: 'string', description: '文件中唯一存在的原内容，不能为空' },
    newText: { type: 'string', description: '替换后的新内容，可以为空' },
  }, required: ['filePath', 'expectedSha256', 'oldText', 'newText'], additionalProperties: false };
  constructor(private readonly workspace: WorkspacePort) {}
  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    return executePreparedAction(await this.prepare(input, context), context);
  }
  async prepare(input: unknown, context: ToolExecutionContext): Promise<ToolPreparation> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return textEditFailure('edit_text_file requires an object input');
    const value = input as Record<string, unknown>;
    if (typeof value.filePath !== 'string' || value.filePath.length === 0
      || typeof value.expectedSha256 !== 'string' || value.expectedSha256.length === 0
      || typeof value.oldText !== 'string' || value.oldText.length === 0 || typeof value.newText !== 'string') {
      return textEditFailure('edit_text_file requires filePath, expectedSha256 from read_file, non-empty oldText and string newText');
    }
    return prepareTextChanges(this.workspace, value.filePath, value.expectedSha256,
      [{ oldText: value.oldText, newText: value.newText }], context, result => ({ status: 'success', output: {
        filePath: result.filePath, replacements: result.changes.length, bytes: Buffer.byteLength(result.after, 'utf8'),
      } }));
  }
}
