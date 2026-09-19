import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SetWorkingDirectoryTool, type WorkspacePort } from '../src/index.js';

/** 用真实临时目录做文件系统边界，不用 mock 伪造目录是否存在。 */
let root: string;
let tool: SetWorkingDirectoryTool;

/**
 * 工具必须落在真实路径上，而 `realpath` 会把 Windows 临时目录的 8.3 短名（`ADMINI~1`）
 * 归一化成长名。期望值因此也必须来自 `realpath`，否则断言的是路径写法而不是真实行为。
 */
function real(path: string): Promise<string> {
  return realpath(path);
}

interface PortLog {
  readonly accessRequests: string[];
  readonly confirmed: string[];
}

/** 可观察的端口替身：记录宿主真正被要求确认的目录，以及最终被确认的目录。 */
function createPort(options: {
  directory?: string;
  approve?: boolean;
} = {}): { port: WorkspacePort; log: PortLog } {
  const log: PortLog = { accessRequests: [], confirmed: [] };
  let directory = options.directory;
  return {
    log,
    port: {
      confirmedDirectory: () => directory,
      requestApproval: async (target) => {
        log.accessRequests.push(target.path);
        return options.approve ?? true;
      },
      confirmDirectory: (next) => {
        log.confirmed.push(next);
        directory = next;
      },
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-desktop-workspace-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('set_working_directory', () => {
  it('confirms a real absolute directory after one approval', async () => {
    const target = join(root, 'clips');
    await mkdir(target);
    const resolved = await real(target);
    const { port, log } = createPort();
    tool = new SetWorkingDirectoryTool(port);

    await expect(tool.execute({ path: target })).resolves.toEqual({
      status: 'success',
      output: { directory: resolved },
    });
    // 用户确认的就是最终会被使用的那个真实目录。
    expect(log.accessRequests).toEqual([resolved]);
    expect(log.confirmed).toEqual([resolved]);
  });

  it('does not ask again for the directory that is already confirmed', async () => {
    const target = join(root, 'clips');
    await mkdir(target);
    const { port, log } = createPort({ directory: await real(target) });
    tool = new SetWorkingDirectoryTool(port);

    await expect(tool.execute({ path: target })).resolves.toEqual({
      status: 'success',
      output: { directory: await real(target) },
    });
    // 已经确认的同一目录不重复审批，也不重复写入。
    expect(log.accessRequests).toEqual([]);
    expect(log.confirmed).toEqual([]);
  });

  it('asks again when the task switches to a different directory', async () => {
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    const { port, log } = createPort({ directory: await real(first) });
    tool = new SetWorkingDirectoryTool(port);

    await expect(tool.execute({ path: second })).resolves.toEqual({
      status: 'success',
      output: { directory: await real(second) },
    });
    expect(log.accessRequests).toEqual([await real(second)]);
    expect(log.confirmed).toEqual([await real(second)]);
  });

  it('fails visibly for a directory that does not exist and never asks for approval', async () => {
    const { port, log } = createPort();
    tool = new SetWorkingDirectoryTool(port);

    const result = await tool.execute({ path: join(root, 'missing') });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('ENOENT');
    expect(log.accessRequests).toEqual([]);
    expect(log.confirmed).toEqual([]);
  });

  it('rejects a path that is a file rather than a directory', async () => {
    const file = join(root, 'notes.txt');
    await writeFile(file, 'hello');
    const { port, log } = createPort();
    tool = new SetWorkingDirectoryTool(port);

    const result = await tool.execute({ path: file });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('不是目录');
    expect(log.accessRequests).toEqual([]);
  });

  it('confirms the real path so a link plus parent segments cannot widen the approved scope', async () => {
    const realDirectory = join(root, 'real');
    const nested = join(realDirectory, 'nested');
    await mkdir(nested, { recursive: true });
    const link = join(root, 'link');
    await symlink(realDirectory, link, process.platform === 'win32' ? 'junction' : 'dir');
    const { port, log } = createPort();
    tool = new SetWorkingDirectoryTool(port);

    // `link/../real/nested` 的字符串前缀指向 link，真实位置却是 real/nested。
    await expect(tool.execute({ path: join(link, '..', 'real', 'nested') })).resolves.toEqual({
      status: 'success',
      output: { directory: await real(nested) },
    });
    // 用户确认的必须是真实路径，不能是含有 link 或 `..` 的写法。
    expect(log.accessRequests).toEqual([await real(nested)]);
  });

  it('resolves a relative path against the confirmed directory', async () => {
    const base = join(root, 'project');
    const child = join(base, 'assets');
    await mkdir(child, { recursive: true });
    const { port, log } = createPort({ directory: await real(base) });
    tool = new SetWorkingDirectoryTool(port);

    await expect(tool.execute({ path: 'assets' })).resolves.toEqual({
      status: 'success',
      output: { directory: await real(child) },
    });
    expect(log.accessRequests).toEqual([await real(child)]);
  });

  it('refuses a relative path when the session has no working directory yet', async () => {
    const { port, log } = createPort();
    tool = new SetWorkingDirectoryTool(port);

    const result = await tool.execute({ path: `assets${sep}clips` });

    expect(result.status).toBe('error');
    // 不能猜用户主目录或应用安装目录，因此这里必须是明确失败。
    expect(result.status === 'error' && result.message).toContain('绝对路径');
    expect(log.accessRequests).toEqual([]);
  });

  it('returns a visible unexecuted result when the user refuses', async () => {
    const target = join(root, 'private');
    await mkdir(target);
    const { port, log } = createPort({ approve: false });
    tool = new SetWorkingDirectoryTool(port);

    const result = await tool.execute({ path: target });

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('用户拒绝');
    // 拒绝不产生任何副作用：目录没有被确认。
    expect(log.confirmed).toEqual([]);
  });

  it('ends the wait with AbortError when the turn is cancelled while waiting', async () => {
    const target = join(root, 'clips');
    await mkdir(target);
    const controller = new AbortController();
    let markWaiting: () => void = () => {};
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    const { port, log } = createPort();
    const cancelling: WorkspacePort = {
      ...port,
      // 宿主在取消时必须结束等待；这里模拟「用户还没答复，轮次就被取消」。
      requestApproval: (_target, signal) => new Promise((_resolve, reject) => {
        markWaiting();
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      }),
    };
    tool = new SetWorkingDirectoryTool(cancelling);

    const pending = tool.execute({ path: target }, controller.signal);
    await waiting;
    controller.abort();

    // 取消语义走 AbortError，不伪装成普通工具失败。
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    expect(log.confirmed).toEqual([]);
  });

  it('does not wait for approval when the turn was already cancelled', async () => {
    const target = join(root, 'clips');
    await mkdir(target);
    const controller = new AbortController();
    const { port, log } = createPort();
    tool = new SetWorkingDirectoryTool(port);
    controller.abort();

    await expect(tool.execute({ path: target }, controller.signal))
      .rejects.toHaveProperty('name', 'AbortError');
    // 从未请求确认，因此不会有一个永远等不到答复的请求。
    expect(log.accessRequests).toEqual([]);
  });

  it('does not restart an approved operation that was cancelled while waiting', async () => {
    const target = join(root, 'clips');
    await mkdir(target);
    const controller = new AbortController();
    const { port, log } = createPort();
    const approvingAfterCancel: WorkspacePort = {
      ...port,
      requestApproval: async () => {
        // 用户点下「允许」的同时轮次被取消：批准已失效，不能重新启动操作。
        controller.abort();
        return true;
      },
    };
    tool = new SetWorkingDirectoryTool(approvingAfterCancel);

    await expect(tool.execute({ path: target }, controller.signal))
      .rejects.toHaveProperty('name', 'AbortError');
    expect(log.confirmed).toEqual([]);
  });

  it('rejects malformed tool input without touching the file system', async () => {
    const { port, log } = createPort();
    tool = new SetWorkingDirectoryTool(port);

    for (const input of [{}, { path: '' }, { path: 7 }, null, 'clips']) {
      const result = await tool.execute(input);
      expect(result.status).toBe('error');
    }
    expect(log.accessRequests).toEqual([]);
  });

  it('exposes a model-visible schema for the directory argument', () => {
    tool = new SetWorkingDirectoryTool(createPort().port);

    expect(tool.name).toBe('set_working_directory');
    expect(tool.inputSchema).toEqual(expect.objectContaining({
      required: ['path'],
      additionalProperties: false,
    }));
  });
});
