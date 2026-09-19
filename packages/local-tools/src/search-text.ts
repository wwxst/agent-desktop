import type { ToolResult } from '@agent-desktop/model';
import type { Tool } from '@agent-desktop/tools';
import { rgPath } from '@vscode/ripgrep';
import { spawn } from 'node:child_process';
import { resolveScopedPath } from './path-scope.js';
import type { WorkspacePort } from './workspace.js';

/** 一次搜索最多返回多少条匹配。超过时明确截断并说明缩小范围的方法。 */
const DEFAULT_MAX_MATCHES = 100;
/** 单行片段的最大长度：字幕和代码行都很短，超长行只保留开头。 */
const MAX_SNIPPET_LENGTH = 200;

/** ripgrep 报出的一条匹配，字段只取当前实现真正使用的部分。 */
export interface RipgrepMatch {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly line: string;
}

export interface RipgrepOutcome {
  readonly exitCode: number;
  readonly stderr: string;
}

/**
 * 真实搜索进程边界。
 * 单独抽出来是因为「起进程、读流、取消」属于外部边界行为，解析逻辑必须能脱离真实 ripgrep 被验证；
 * 真实的进程行为由真实验收覆盖。
 * `onMatch` 返回 false 表示调用方已经够了，实现方必须结束进程，不能把整个目录扫完。
 */
export type RipgrepRunner = (
  args: readonly string[],
  signal: AbortSignal | undefined,
  onMatch: (match: RipgrepMatch) => boolean,
) => Promise<RipgrepOutcome>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResult(message: string): ToolResult {
  return { status: 'error', message };
}

/**
 * 取消信号是活值：它在等待搜索进程期间会被别的代码改变。
 * 单独包一层是为了让「这里必须重新读一次」在类型上也是真的读取，而不是被上一次判断收窄后的常量。
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** 从 ripgrep 的 --json 事件里读出当前实现需要的字段；其他事件类型一律忽略。 */
function readMatch(value: unknown): RipgrepMatch | undefined {
  if (!isRecord(value) || value.type !== 'match' || !isRecord(value.data)) return undefined;
  const { path, line_number: lineNumber, lines } = value.data as Record<string, unknown>;
  if (!isRecord(path) || typeof path.text !== 'string') return undefined;
  if (typeof lineNumber !== 'number' || !Number.isInteger(lineNumber) || lineNumber < 1) return undefined;
  if (!isRecord(lines) || typeof lines.text !== 'string') return undefined;
  // ripgrep 的 lines.text 带行尾换行，去掉后才是行内容。
  return { filePath: path.text, lineNumber, line: lines.text.replace(/\r?\n$/, '') };
}

/** 用默认的 ripgrep：起真实进程、按行读 --json 输出、取消或够了就结束进程。 */
const spawnRipgrep: RipgrepRunner = (args, signal, onMatch) => new Promise((resolve, reject) => {
  // 用随包提供的 ripgrep：不依赖运行环境 PATH 上是否装了 rg。
  const child = spawn(rgPath, [...args], { windowsHide: true });
  let stderr = '';
  let buffer = '';
  let stopped = false;

  const abort = () => { child.kill(); };
  if (signal !== undefined) {
    if (signal.aborted) child.kill();
    else signal.addEventListener('abort', abort, { once: true });
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    // 已经够了：kill 之后仍可能有已排队的分片到达，这里不能再解析、也不能再上报。
    if (stopped) return;
    buffer += chunk;
    // --json 是行分隔的 JSON：只处理完整的行，最后一段留给 close 处理。
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // 进程输出是真实外部边界：结构不符时不能猜，直接失败。
        child.kill();
        reject(new Error('ripgrep returned a line that is not JSON'));
        return;
      }
      const match = readMatch(parsed);
      if (match !== undefined && !onMatch(match)) {
        // 调用方已经够了：立刻结束进程，不等它扫完。
        stopped = true;
        child.kill();
        return;
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  child.on('error', (error: NodeJS.ErrnoException) => {
    reject(error);
  });
  child.on('close', (code) => {
    signal?.removeEventListener('abort', abort);
    // 被取消或主动结束时进程由信号结束，退出码不可靠；调用方按 signal / 上限自行判断。
    resolve({ exitCode: stopped ? 0 : code ?? 0, stderr });
  });
});

/**
 * 在当前会话工作目录范围内按字面文本搜索文件内容。
 *
 * 搜索本身交给 ripgrep（真实进程），这里只负责参数、范围、上限和取消：
 * 不自己遍历目录、不做正则、不做语义索引——只接入一条搜索实现。
 * 用字面文本而不是正则：定位台词和内容时，用户写的就是要找的字符串，
 * 让 `.` 或 `1` 意外变成正则会给出难以解释的结果。
 */
export class SearchTextTool implements Tool {
  readonly name = 'search_text';
  readonly description = '在当前会话工作目录范围内按字面文本搜索文件内容，返回匹配文件、行号和行内容；'
    + '遵循 ripgrep 的默认规则（遵守 .gitignore、跳过隐藏文件与二进制文件）';
  readonly inputSchema = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '要查找的字面文本，不是正则' },
      directory: { type: 'string', description: '相对工作目录的路径或绝对路径；省略时搜索整个工作目录' },
      extension: { type: 'string', description: '只搜索该扩展名的文件，例如 srt' },
    },
    required: ['pattern'],
    additionalProperties: false,
  };

  public constructor(
    private readonly workspace: WorkspacePort,
    private readonly runRipgrep: RipgrepRunner = spawnRipgrep,
    private readonly maxMatches: number = DEFAULT_MAX_MATCHES,
  ) {}

  async execute(input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    if (!isRecord(input)) return errorResult('search_text requires an object input');
    const { pattern, directory, extension } = input;
    if (typeof pattern !== 'string' || pattern.length === 0) {
      return errorResult('search_text requires pattern to be a non-empty string');
    }
    if (directory !== undefined && typeof directory !== 'string') {
      return errorResult('search_text requires directory to be a string');
    }
    if (extension !== undefined && typeof extension !== 'string') {
      return errorResult('search_text requires extension to be a string');
    }

    const scoped = await resolveScopedPath(this.workspace.confirmedDirectory(), directory);
    if (!scoped.ok) return errorResult(scoped.message);

    // 轮次已经取消时不起进程：起完立刻杀掉是白费，取消语义应当在边界上就结束。
    if (isAborted(signal)) throw new DOMException('The operation was aborted', 'AbortError');

    const args = [
      '--json',
      // 字面文本：用户要找的就是这个字符串本身。
      '--fixed-strings',
      ...(extension === undefined
        ? []
        : ['--glob', `*.${extension.replace(/^\./, '')}`]),
      '--',
      pattern,
      scoped.path,
    ];

    const matches: RipgrepMatch[] = [];
    let truncated = false;
    let outcome: RipgrepOutcome;
    try {
      outcome = await this.runRipgrep(args, signal, (match) => {
        // 上限必须在**调用方**也守住：进程被 kill 之后仍可能有已排队的分片到达，
        // 只靠「返回 false 让实现方停止」会让结果超过上限。
        if (matches.length >= this.maxMatches) {
          truncated = true;
          return false;
        }
        matches.push(match);
        if (matches.length >= this.maxMatches) {
          truncated = true;
          return false;
        }
        return true;
      });
    } catch (error) {
      if (isAborted(signal)) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      if (!(error instanceof Error)) throw error;
      // 真实进程边界：可执行文件缺失是最常见的一种。
      // ripgrep 由 `@vscode/ripgrep` 随包提供，因此「找不到」意味着随包资源缺失或打包出错，
      // 而不是用户需要自己去装 ripgrep —— 提示必须指向真正要排查的地方。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return errorResult(
          `找不到随包提供的 ripgrep 可执行文件（${rgPath}），这是打包或依赖安装问题，不是缺少用户配置。`
          + '请重新安装依赖（pnpm install）并确认 @vscode/ripgrep 的平台包已随应用发布。',
        );
      }
      return errorResult(`搜索进程启动失败：${error.message}`);
    }

    // 取消要终止真实操作，不能伪装成一次普通的搜索失败。
    if (isAborted(signal)) throw new DOMException('The operation was aborted', 'AbortError');

    // ripgrep 的退出码：0 有匹配，1 无匹配，2 出错。无匹配是正常结果，不是失败。
    if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
      const detail = outcome.stderr.trim().split(/\r?\n/).filter((line) => line.length > 0).slice(-4).join('\n');
      return errorResult(`搜索失败（ripgrep 退出码 ${outcome.exitCode}）：${detail || '无错误输出'}`);
    }

    return {
      status: 'success',
      output: {
        directory: scoped.path,
        pattern,
        total: matches.length,
        matches: matches.map((match) => ({
          ...match,
          line: match.line.length > MAX_SNIPPET_LENGTH
            ? `${match.line.slice(0, MAX_SNIPPET_LENGTH)}…`
            : match.line,
        })),
        ...(truncated ? {
          truncated: true,
          note: `已达到上限 ${this.maxMatches} 条匹配，可能还有更多；`
            + '请缩小 directory、用 extension 过滤，或换更具体的文本。',
        } : {}),
      },
    };
  }
}
