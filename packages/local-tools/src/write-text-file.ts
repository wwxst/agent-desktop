import type { ToolResult } from '@agent-desktop/model';
import type { Tool } from '@agent-desktop/tools';
import { stat, writeFile } from 'node:fs/promises';
import { resolveCreatablePath } from './path-scope.js';
import type { WorkspacePort } from './workspace.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResult(message: string): ToolResult {
  return { status: 'error', message };
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
 * 取消信号是活值：它在等待审批期间会被别的代码改变。
 * 单独包一层是为了让「这里必须重新读一次」在类型上也是真的读取，而不是被上一次判断收窄后的常量。
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * 经用户批准后创建一个新的文本文件。
 *
 * 三条边界：
 * - 范围：目标路径的**父目录**必须在会话已确认的工作目录内（目标还不存在，不能对它做 realpath）。
 * - 不覆盖：已有文件一律拒绝，`wx` 是真正的写入边界兜底（先 stat 只是为了让用户不必为一个注定失败的操作点批准）。
 * - 审批：写入前必须拿到用户对**这一次创建**的明确批准，拒绝和取消都不产生任何写入。
 *
 * 只有真正写入成功才报告 `artifacts`：产物事实来自成功结果，不从回复文本或磁盘扫描推断。
 */
export class WriteTextFileTool implements Tool {
  readonly name = 'write_text_file';
  readonly description = '在当前会话工作目录内创建一个新的文本文件；已有文件不会被覆盖，写入前需要用户确认';
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

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    if (!isRecord(input)) return errorResult('write_text_file requires an object input');
    const { filePath, content } = input;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return errorResult('write_text_file requires filePath to be a non-empty string');
    }
    if (typeof content !== 'string') {
      return errorResult('write_text_file requires content to be a string');
    }

    const scoped = await resolveCreatablePath(this.workspace.confirmedDirectory(), filePath);
    if (!scoped.ok) return errorResult(scoped.message);

    if (await exists(scoped.path)) {
      return errorResult(`文件已存在，不会覆盖：${scoped.path}`);
    }

    // 轮次已经取消时不再请求确认：宿主的取消信号在请求之前触发，等待就永远不会有结果。
    if (isAborted(signal)) throw new DOMException('The operation was aborted', 'AbortError');

    const approved = await this.workspace.requestApproval(
      { kind: 'create-file', path: scoped.path },
      signal,
    );
    // 等待期间用户可能已经取消：批准不能重新启动一个已经失效的操作。
    if (isAborted(signal)) throw new DOMException('The operation was aborted', 'AbortError');
    if (!approved) return errorResult(`用户拒绝创建该文件，未做任何写入：${scoped.path}`);

    try {
      // wx：目标已存在时直接失败。它和上面的存在性检查一起覆盖「检查后目标才出现」的情况。
      await writeFile(scoped.path, content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return errorResult(`文件已存在，不会覆盖：${scoped.path}`);
      return errorResult(`无法写入该文件（${code ?? error.message}）：${scoped.path}`);
    }

    return {
      status: 'success',
      output: {
        filePath: scoped.path,
        bytes: Buffer.byteLength(content, 'utf8'),
      },
      artifacts: [scoped.path],
    };
  }
}
