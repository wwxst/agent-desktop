import type { ToolResult } from '@agent-desktop/model';
import type { Tool } from '@agent-desktop/tools';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/**
 * 宿主需要用户明确批准的一项确切操作。
 * `kind` 让宿主和界面知道这是什么操作，`path` 是工具已经解析过的真实路径。
 */
export interface ApprovalTarget {
  readonly kind: 'directory' | 'create-file';
  readonly path: string;
}

/**
 * 宿主提供的会话工作目录与操作审批能力。
 *
 * 工具只通过这个端口读写目录事实和请求审批：它不持有 Session、不选模型、不依赖 Electron 或 React，
 * 也不自己决定要不要审批——审批是宿主的职责，工具只等待宿主的答复。
 */
export interface WorkspacePort {
  /** 当前会话已经确认的工作目录；还没有基准时返回 undefined。 */
  confirmedDirectory(): string | undefined;
  /**
   * 请求宿主展示一次操作确认。
   * 取消、关闭或请求失效时必须用 AbortError 结束等待，不能把取消伪装成普通工具失败。
   */
  requestApproval(target: ApprovalTarget, signal?: AbortSignal): Promise<boolean>;
  /** 记录本次已经确认的工作目录（只对目录操作有意义），供同一 Turn 的后续工具和后续 Turn 使用。 */
  confirmDirectory(directory: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResult(message: string): ToolResult {
  return { status: 'error', message };
}

/**
 * 取消信号是活值：它在等待审批期间会被别的代码改变。
 * 单独包一层是为了让「这里必须重新读一次」在类型上也是真的读取，而不是被上一次判断收窄后的常量。
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * 把当前会话的工作目录设置为一个真实存在的目录。
 *
 * 目录是相对路径的解析基准，也是后续本地文件工具的读取范围来源，因此这里必须落在**真实路径**上：
 * 先 `realpath` 消掉 `..`、符号链接和 Windows 目录联接，再让用户确认，用户确认的就是实际会被使用的目录。
 */
export class SetWorkingDirectoryTool implements Tool {
  readonly name = 'set_working_directory';
  readonly description = '把当前会话的工作目录设置为一个已存在的目录；首次使用该目录需要用户确认';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径；相对路径以当前会话工作目录为基准' },
    },
    required: ['path'],
    additionalProperties: false,
  };

  public constructor(private readonly workspace: WorkspacePort) {}

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    if (!isRecord(input) || typeof input.path !== 'string' || input.path.length === 0) {
      return errorResult('set_working_directory requires path to be a non-empty string');
    }

    // 相对路径以会话工作目录为基准；没有基准时明确报错，不猜用户主目录或应用安装目录。
    const base = this.workspace.confirmedDirectory();
    let candidate: string;
    if (isAbsolute(input.path)) {
      candidate = input.path;
    } else if (base === undefined) {
      return errorResult('当前会话还没有工作目录，请提供绝对路径。');
    } else {
      candidate = resolve(base, input.path);
    }

    // 文件系统是真实外部边界：不存在或不可访问都如实返回，不换一个可用目录继续。
    let directory: string;
    try {
      directory = await realpath(candidate);
      if (!(await stat(directory)).isDirectory()) {
        return errorResult(`不是目录：${directory}`);
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      return errorResult(`无法使用该目录（${code ?? error.message}）：${candidate}`);
    }

    // 已经确认的同一目录不重复审批；换到新目录必须重新确认。
    if (base === directory) {
      return { status: 'success', output: { directory } };
    }

    // 轮次已经取消时不再请求确认：宿主的取消信号在请求之前触发，等待就永远不会有结果。
    if (isAborted(signal)) throw new DOMException('The operation was aborted', 'AbortError');

    const approved = await this.workspace.requestApproval({ kind: 'directory', path: directory }, signal);
    // 等待期间用户可能已经取消：批准不能重新启动一个已经失效的操作。
    if (isAborted(signal)) throw new DOMException('The operation was aborted', 'AbortError');
    if (!approved) return errorResult(`用户拒绝访问该目录，未做任何改动：${directory}`);

    this.workspace.confirmDirectory(directory);
    return { status: 'success', output: { directory } };
  }
}
