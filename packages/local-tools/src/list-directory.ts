import type { ToolResult } from '@agent-desktop/model';
import type { Tool } from '@agent-desktop/tools';
import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { resolveScopedPath } from './path-scope.js';
import type { WorkspacePort } from './workspace.js';

/**
 * 一次列目录最多返回多少项。
 * 超过时明确报告总数和缩小范围的方法，不能等模型上下文被目录内容撑满才处理。
 */
const DEFAULT_LIMIT = 200;

interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'directory';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResult(message: string): ToolResult {
  return { status: 'error', message };
}

/** 按名称做与区域设置无关的稳定排序，保证同一目录每次返回同样的顺序。 */
function byName(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

/**
 * 判断一个目录项的真实类型。
 *
 * 不能只看 `dirent.isDirectory()`：符号链接和 Windows 目录联接的 dirent 不是目录，
 * 于是「指向目录的联接」会被报成文件，还会被扩展名过滤顺手丢掉——模型既看不到它、
 * 也无法知道它其实可以进入。这里对链接再 stat 一次，按真实目标判断。
 */
async function entryTypeOf(directory: string, dirent: Dirent): Promise<DirectoryEntry['type']> {
  if (dirent.isDirectory()) return 'directory';
  if (!dirent.isSymbolicLink()) return 'file';
  try {
    return (await stat(join(directory, dirent.name))).isDirectory() ? 'directory' : 'file';
  } catch {
    // 断链既不是可读文件也不是可进入的目录。列目录不能因为一个坏链接整体失败，
    // 因此按「不是目录」处理，让扩展名过滤把它当成普通条目对待。
    return 'file';
  }
}

/**
 * 列出当前会话工作目录（或其子目录）中的真实条目。
 *
 * 它只读取会话已经确认的范围，不做任何越界访问，也不递归：需要往下找时由模型带着子目录名再调用一次，
 * 这样每一步读取范围都是可见的。扩展名过滤只作用于文件，目录始终保留，否则模型无法继续往下找。
 */
export class ListDirectoryTool implements Tool {
  readonly name = 'list_directory';
  readonly description = '列出当前会话工作目录或其子目录中的文件和子目录，可按扩展名过滤';
  readonly inputSchema = {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: '相对工作目录的路径或绝对路径；省略时列出工作目录本身',
      },
      extension: {
        type: 'string',
        description: '只列出该扩展名的文件，例如 mp4；目录不受过滤影响',
      },
    },
    additionalProperties: false,
  };

  public constructor(
    private readonly workspace: WorkspacePort,
    private readonly limit: number = DEFAULT_LIMIT,
  ) {}

  async execute(input: unknown): Promise<ToolResult> {
    if (!isRecord(input)) return errorResult('list_directory requires an object input');
    const { directory, extension } = input;
    if (directory !== undefined && typeof directory !== 'string') {
      return errorResult('list_directory requires directory to be a string');
    }
    if (extension !== undefined && typeof extension !== 'string') {
      return errorResult('list_directory requires extension to be a string');
    }

    const scoped = await resolveScopedPath(this.workspace.confirmedDirectory(), directory);
    if (!scoped.ok) return errorResult(scoped.message);

    let dirents;
    try {
      dirents = await readdir(scoped.path, { withFileTypes: true });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      return errorResult(`无法读取该目录（${code ?? error.message}）：${scoped.path}`);
    }

    const wanted = extension === undefined
      ? undefined
      : extension.replace(/^\./, '').toLowerCase();
    const entries = (await Promise.all(dirents.map(async (dirent): Promise<DirectoryEntry> => ({
      name: dirent.name,
      path: join(scoped.path, dirent.name),
      type: await entryTypeOf(scoped.path, dirent),
    }))))
      // 目录不参与扩展名过滤：过滤掉它们模型就无法继续往下找。
      .filter((entry) => wanted === undefined
        || entry.type === 'directory'
        || entry.name.toLowerCase().endsWith(`.${wanted}`))
      .sort(byName);

    const listed = entries.slice(0, this.limit);
    const truncated = entries.length > listed.length;
    return {
      status: 'success',
      output: {
        directory: scoped.path,
        total: entries.length,
        entries: listed,
        ...(truncated ? {
          truncated: true,
          note: `目录共 ${entries.length} 项，这里只返回前 ${this.limit} 项；请用 extension 过滤，或列出其中某个子目录。`,
        } : {}),
      },
    };
  }
}
