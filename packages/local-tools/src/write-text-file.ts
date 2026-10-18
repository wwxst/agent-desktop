import type { ToolResult } from '@agent-desktop/model';
import { executePreparedAction, type Tool, type ToolExecutionContext, type ToolPreparation } from '@agent-desktop/tools';
import { link, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { resolveCreatablePath } from './path-scope.js';
import type { WorkspacePort } from './workspace.js';
import { createFileArtifact } from './artifact.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResult(message: string, failureKind: 'permanent' | 'denied' | 'unknown-outcome' = 'permanent'): ToolResult {
  return { status: 'error', message, failureKind };
}

/** 目标是否已经存在；ENOENT 之外的读取失败直接暴露，不当作「可以写入」。 */
async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * 经宿主批准后创建一个新的文本文件。
 *
 * 三条边界：
 * - 范围：目标路径的**父目录**必须符合宿主文件授权（目标还不存在，不能对它做 realpath）。
 * - 不覆盖：已有文件一律拒绝，硬链接排他发布完整暂存文件（先 stat 避免为注定失败的操作请求审批）。
 * - 审批：写入前必须拿到宿主对**这一次创建**的批准，拒绝和取消都不产生任何写入。
 *
 * 只有真正写入成功才报告 `artifacts`：产物事实来自成功结果，不从回复文本或磁盘扫描推断。
 */
export class WriteTextFileTool implements Tool {
  readonly executionBoundary = 'checkpointed' as const;
  readonly contract = { capability: 'code', riskLevel: 'write', parallelSafety: 'serial', workspaceScope: 'session', approvalRequirement: 'policy' } as const;
  readonly name = 'write_text_file';
  readonly description = '在宿主授权范围内创建一个新的文本文件；已有文件不会被覆盖，写入前由宿主审批';
  readonly inputSchema = {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: '相对工作目录的路径或绝对路径；文件必须还不存在' },
      content: { type: 'string', description: '要写入的完整文本内容' },
    },
    required: ['filePath', 'content'],
    additionalProperties: false,
  };

  public constructor(private readonly workspace: WorkspacePort) {}

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    return executePreparedAction(await this.prepare(input, context), context);
  }

  async prepare(input: unknown, context: ToolExecutionContext): Promise<ToolPreparation> {
    const { signal } = context;
    if (!isRecord(input)) return errorResult('write_text_file requires an object input');
    const { filePath, content } = input;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return errorResult('write_text_file requires filePath to be a non-empty string');
    }
    if (typeof content !== 'string') {
      return errorResult('write_text_file requires content to be a string');
    }

    const scoped = await resolveCreatablePath(this.workspace.confirmedDirectory(), filePath, this.workspace.fileAccess === 'all');
    if (!scoped.ok) return errorResult(scoped.message);

    if (await exists(scoped.path)) {
      return errorResult(`文件已存在，不会覆盖：${scoped.path}`);
    }

    // 路径和内容在准备时固定，批准之后只执行这一次排他创建。
    return {
      requestApproval: () => this.workspace.requestApproval({ kind: 'create-file', path: scoped.path }, signal),
      execute: async () => {
        // 持久化失败原样传播，不能转成普通文件错误。
        context.checkpoint?.({ kind: 'text-file', path: scoped.path, beforeSha256: null,
          expectedAfterSha256: createHash('sha256').update(content, 'utf8').digest('hex'), expectedBytes: Buffer.byteLength(content, 'utf8') });
        let temporary: string | undefined;
        let committed = false;
        try {
          try {
            temporary = await mkdtemp(join(dirname(scoped.path), '.agent-create-'));
            const staged = join(temporary, 'content');
            await writeFile(staged, content, { encoding: 'utf8', flag: 'wx' });
            signal?.throwIfAborted();
            // 同文件系统硬链接一次发布完整文件；已有目标直接 EEXIST，不覆盖且不暴露部分内容。
            await link(staged, scoped.path);
            committed = true;
          } finally {
            if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
          }
        } catch (error) {
          if (!(error instanceof Error) || error.name === 'AbortError') throw error;
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') return errorResult(`文件已存在，不会覆盖：${scoped.path}`);
          return errorResult(`无法写入该文件（${code ?? error.message}）：${scoped.path}`, committed ? 'unknown-outcome' : 'permanent');
        }

        return {
          status: 'success',
          output: {
            filePath: scoped.path,
            bytes: Buffer.byteLength(content, 'utf8'),
          },
          artifacts: [await createFileArtifact(scoped.path, this.name, signal)],
        };
      },
    };
  }
}
