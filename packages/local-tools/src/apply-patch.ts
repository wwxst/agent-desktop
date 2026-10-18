import type { ToolResult } from '@agent-desktop/model';
import { executePreparedAction, type Tool, type ToolExecutionContext, type ToolPreparation } from '@agent-desktop/tools';
import { prepareTextChanges, textEditFailure, type TextChange } from './edit-text-file.js';
import type { WorkspacePort } from './workspace.js';

/** 一次调用只修改一个已有文件；多个精确片段作为同一份原子补丁提交。 */
export class ApplyPatchTool implements Tool {
  readonly executionBoundary = 'checkpointed' as const;
  readonly contract = { capability: 'code', riskLevel: 'write', parallelSafety: 'serial', workspaceScope: 'session', approvalRequirement: 'policy' } as const;
  readonly name = 'apply_patch';
  readonly description = '先用 read_file 获取 SHA，再对一个已有 UTF-8 文件提交精确补丁；各 hunk 匹配原始文件且不得重叠。完整变更经宿主审批后原子提交，返回结构化 diff。创建文件使用 write_text_file。';
  readonly inputSchema = { type: 'object', properties: {
    filePath: { type: 'string' }, expectedSha256: { type: 'string' },
    hunks: { type: 'array', minItems: 1, items: { type: 'object', properties: {
      oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' },
    }, required: ['oldText', 'newText'], additionalProperties: false } },
  }, required: ['filePath', 'expectedSha256', 'hunks'], additionalProperties: false };
  constructor(private readonly workspace: WorkspacePort) {}
  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    return executePreparedAction(await this.prepare(input, context), context);
  }
  async prepare(input: unknown, context: ToolExecutionContext): Promise<ToolPreparation> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return textEditFailure('apply_patch 需要文件路径、read_file 的 SHA 和补丁片段。');
    const value = input as Record<string, unknown>;
    if (typeof value.filePath !== 'string' || !value.filePath || typeof value.expectedSha256 !== 'string' || !value.expectedSha256
      || !Array.isArray(value.hunks) || value.hunks.length === 0) return textEditFailure('apply_patch 需要非空 filePath、expectedSha256 和 hunks。');
    const changes: TextChange[] = [];
    for (const hunk of value.hunks) {
      if (typeof hunk !== 'object' || hunk === null || typeof hunk.oldText !== 'string' || !hunk.oldText
        || typeof hunk.newText !== 'string') return textEditFailure('每个补丁片段需要非空 oldText 和字符串 newText。');
      changes.push({ oldText: hunk.oldText, newText: hunk.newText });
    }
    return prepareTextChanges(this.workspace, value.filePath, value.expectedSha256, changes, context,
      result => ({ status: 'success', output: {
        filePath: result.filePath, bytes: Buffer.byteLength(result.after, 'utf8'),
        diff: { beforeSha256: result.beforeSha256, afterSha256: result.afterSha256, changes: result.changes },
      } }));
  }
}
