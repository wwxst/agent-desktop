import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ToolResult } from '@agent-desktop/model';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';
import { createCommandOutputBuffer } from './command.js';
import { resolveScopedPath } from './path-scope.js';
import type { WorkspacePort } from './workspace.js';

export type GitReadToolName = 'git_status' | 'git_diff' | 'git_log';
const DESCRIPTIONS = {
  git_status: '读取授权目录中 Git 工作区的简短状态，不修改索引或文件。',
  git_diff: '读取授权目录中 Git 工作区或暂存区的 diff；禁用外部 diff 与 textconv。',
  git_log: '读取授权目录中 Git 最近提交的摘要，最多一百项。',
};
const executeFile = promisify(execFile);

/** 只继承 Git 启动所需的系统变量，不继承模型密钥、GIT_* 注入配置或 SSH 命令。 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

/** 参数完全来自固定枚举和受限整数，模型不能注入 Git 选项、外部 diff 或 shell。 */
export class GitReadTool implements Tool {
  readonly executionBoundary = 'read-only' as const;
  readonly contract = { capability: 'code', riskLevel: 'read', parallelSafety: 'safe', workspaceScope: 'session', timeoutMs: 30_000 } as const;
  readonly description: string;
  readonly inputSchema: unknown;
  constructor(readonly name: GitReadToolName, private readonly workspace: WorkspacePort) {
    this.description = DESCRIPTIONS[name];
    this.inputSchema = { type: 'object', properties: {
      directory: { type: 'string', description: '授权的 Git 工作区目录；省略时使用当前工作目录' },
      ...(name === 'git_diff' ? { staged: { type: 'boolean', description: 'true 读取暂存区；默认读取未暂存变更' } } : {}),
      ...(name === 'git_log' ? { maxCount: { type: 'integer', minimum: 1, maximum: 100 } } : {}),
    }, additionalProperties: false };
  }

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    context.signal?.throwIfAborted();
    const fail = (message: string): ToolResult => ({ status: 'error', failureKind: 'permanent', message });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('Git 工具需要对象参数。');
    const value = input as Record<string, unknown>;
    const allowed = ['directory', ...(this.name === 'git_diff' ? ['staged'] : []), ...(this.name === 'git_log' ? ['maxCount'] : [])];
    if (Object.keys(value).some(key => !allowed.includes(key))) return fail('Git 工具不接受命令、额外参数或未声明字段。');
    if (value.directory !== undefined && typeof value.directory !== 'string') return fail('directory 必须是字符串。');
    if (value.staged !== undefined && typeof value.staged !== 'boolean') return fail('staged 必须是布尔值。');
    if (value.maxCount !== undefined && (typeof value.maxCount !== 'number' || !Number.isInteger(value.maxCount)
      || value.maxCount < 1 || value.maxCount > 100)) return fail('maxCount 必须是 1 至 100 的整数。');
    const scoped = await resolveScopedPath(this.workspace.confirmedDirectory(), value.directory as string | undefined, this.workspace.fileAccess === 'all');
    if (!scoped.ok) return fail(scoped.message);
    try { if (!(await stat(scoped.path)).isDirectory()) return fail('Git 执行目录必须是真实目录。'); }
    catch (error) { if (!(error instanceof Error)) throw error; return fail(error.message); }

    // status/diff 会为比较工作区调用 .gitattributes 的 clean/process 过滤器。
    // 只读工具先读取实际配置的过滤器名称，再逐项禁用；不能只禁用外部 diff 就宣称无执行副作用。
    const filterArguments: string[] = [];
    try {
      const configured = await executeFile('git', ['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\..*\.(clean|smudge|process|required)$'],
        { cwd: scoped.path, env: gitEnvironment(), windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024,
          ...(context.signal === undefined ? {} : { signal: context.signal }) });
      const drivers = new Set(configured.stdout.split('\0').filter(Boolean).map(key => key.slice('filter.'.length, key.lastIndexOf('.'))));
      for (const driver of drivers) for (const field of ['clean', 'smudge', 'process', 'required']) {
        filterArguments.push('-c', `filter.${driver}.${field}=${field === 'required' ? 'false' : ''}`);
      }
    } catch (error) {
      context.signal?.throwIfAborted();
      if (!(error instanceof Error)) throw error;
      // get-regexp 的 1 表示无匹配配置，其余错误不能忽略后继续执行。
      if ((error as Error & { code?: number | string }).code !== 1) return fail(`无法核对 Git 过滤器：${error.message}`);
    }
    const args = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.quotePath=false', ...filterArguments,
      ...(this.name === 'git_status' ? ['status', '--short', '--branch', '--untracked-files=normal', '--ignore-submodules=all']
        : this.name === 'git_diff' ? ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', ...(value.staged === true ? ['--cached'] : [])]
          : ['log', `--max-count=${value.maxCount as number | undefined ?? 20}`, '--format=%H%n%an%n%aI%n%s%n', '--no-decorate', '--no-show-signature']),
      // 工作目录可能只授权了仓库的一个子目录；显式 pathspec 不能读出相邻未授权源码。
      '--', '.'];
    context.signal?.throwIfAborted();
    const stdout = createCommandOutputBuffer(); const stderr = createCommandOutputBuffer();
    const child = spawn('git', args, { cwd: scoped.path, env: gitEnvironment(), windowsHide: true,
      shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout.append(chunk));
    child.stderr.on('data', (chunk: string) => stderr.append(chunk));
    const stop = () => { child.kill(); };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(); }, 30_000);
    context.signal?.addEventListener('abort', stop, { once: true });
    let exitCode: number | null; let startupError: Error | undefined;
    try {
      exitCode = await new Promise<number | null>(resolve => {
        child.once('error', error => { startupError = error; });
        // close 总在退出/启动失败后触发；收完输出和句柄后才返回结果。
        child.once('close', resolve);
      });
    } finally {
      clearTimeout(timer); context.signal?.removeEventListener('abort', stop);
    }
    context.signal?.throwIfAborted();
    const output = { directory: scoped.path, exitCode, stdout: stdout.text(), stderr: stderr.text(),
      truncated: stdout.truncated() || stderr.truncated(), droppedBytes: stdout.droppedBytes() + stderr.droppedBytes() };
    if (startupError !== undefined || timedOut || exitCode !== 0) return {
      status: 'error', failureKind: 'permanent', output,
      message: startupError?.message ?? (timedOut ? 'Git 读取超过 30 秒预算。' : `Git 读取失败，退出码 ${exitCode ?? '未知'}。`),
    };
    return { status: 'success', output };
  }
}
