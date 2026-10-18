import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import type { ToolResult } from '@agent-desktop/model';
import { resolveScopedPath, type WorkspacePort } from '@agent-desktop/local-tools';
import { projectTurnState, type Session, type SessionEvent } from '@agent-desktop/session';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function error(message: string): ToolResult {
  return { status: 'error', failureKind: 'permanent', message };
}

/**
 * 只核验文件工具在检查点声明的最终字节，不接受模型传入的“已完成”结论。
 * 外层插件/宿主副作用仍保持 unresolved；是否能解除整个调用由用户核验入口决定。
 */
export class VerifyToolOutcomeTool implements Tool {
  readonly contract = { approvalRequirement: 'none' } as const;
  readonly name = 'verify_tool_outcome';
  readonly description = '核验已有文件工具的实际文件字节；只接受 Session 事实索引，不重放原工具或修改文件。';
  readonly executionBoundary = 'read-only' as const;
  readonly inputSchema = {
    type: 'object',
    properties: { sourceEventIndex: { type: 'integer', minimum: 0, description: '原始 tool.called 事件索引' } },
    required: ['sourceEventIndex'],
    additionalProperties: false,
  };

  constructor(private readonly session: Session, private readonly workspace: WorkspacePort) {}

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    context.signal?.throwIfAborted();
    if (!isRecord(input) || typeof input.sourceEventIndex !== 'number'
      || !Number.isSafeInteger(input.sourceEventIndex) || input.sourceEventIndex < 0) {
      return error('verify_tool_outcome 需要非负整数 sourceEventIndex。');
    }
    const events = this.session.events();
    const source = events[input.sourceEventIndex];
    if (source?.type !== 'tool.called') return error('核验来源必须是已保存的 tool.called 事实。');
    const prepared = events.findLast((event): event is Extract<SessionEvent, { type: 'tool.effect.prepared' }> =>
      event.type === 'tool.effect.prepared' && event.sourceEventIndex === input.sourceEventIndex);
    if (prepared === undefined || !isRecord(prepared.data) || prepared.data.kind !== 'text-file'
      || typeof prepared.data.path !== 'string' || typeof prepared.data.expectedAfterSha256 !== 'string'
      || typeof prepared.data.expectedBytes !== 'number') {
      return error('该工具调用没有可自动核验的文本文件检查点。');
    }
    const currentTurn = [...events].reverse().find((event) => event.type === 'turn.started'
      && projectTurnState(events, event.turnId) === 'started');
    if (currentTurn?.type !== 'turn.started') return error('核验工具必须在当前活动 Turn 中执行。');

    // 既有目标按完整真实路径校验；创建目标不存在时，改用父目录授权，避免把“尚未创建”误当越界。
    const scoped = await resolveScopedPath(this.workspace.confirmedDirectory(), prepared.data.path, this.workspace.fileAccess === 'all');
    let targetPath: string;
    if (scoped.ok) targetPath = scoped.path;
    else {
      let missing = false;
      try { await lstat(prepared.data.path); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
        else throw cause;
      }
      if (!missing) return error(scoped.message);
      const parent = await resolveScopedPath(this.workspace.confirmedDirectory(), dirname(prepared.data.path), this.workspace.fileAccess === 'all');
      if (!parent.ok) return error(parent.message);
      targetPath = join(parent.path, basename(prepared.data.path));
    }

    let outcome: 'completed' | 'not-applied' | 'unresolved';
    try {
      const bytes = await readFile(targetPath);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest === prepared.data.expectedAfterSha256 && bytes.byteLength === prepared.data.expectedBytes) outcome = 'completed';
      else if (prepared.data.beforeSha256 !== null && digest === prepared.data.beforeSha256) outcome = 'not-applied';
      else outcome = 'unresolved';
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && prepared.data.beforeSha256 === null) outcome = 'not-applied';
      else throw cause;
    }
    context.signal?.throwIfAborted();
    const scope = source.boundary === 'checkpointed' ? 'entire-call' : 'file-effect';
    this.session.append({
      type: 'effect.outcome.verified',
      turnId: currentTurn.turnId,
      sourceEventIndex: input.sourceEventIndex,
      scope,
      outcome,
      evidence: { source: 'tool', reference: targetPath,
        description: outcome === 'completed' ? '文件字节与执行前检查点的预期结果一致。'
          : outcome === 'not-applied' ? '文件仍是执行前版本，或创建目标尚不存在。' : '文件既不是执行前版本，也不是预期结果，无法确认实际效果。' },
    });
    return { status: 'success', output: { sourceEventIndex: input.sourceEventIndex, scope, outcome, path: targetPath } };
  }
}
